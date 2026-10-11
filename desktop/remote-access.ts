import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { isValidAccessToken } from "../orchestrator/src/access_token.ts";

/**
 * 远程访问模式(`scripts/start --remote`)的两道门,只装在对外的页面服务器上;本机模式与 VRA_LAN 不受影响。
 *
 * 1. 访问口令门:**每个请求**(页面、脚本、`/api`)都要带有效的访问 cookie。
 *    分享链接 `/?access=<口令>` 换成 HttpOnly cookie 后 303 跳回去掉口令的同一地址。
 *    SameSite=Lax:从聊天软件点开链接(跨站顶层跳转)能带上,别的网站发起的 POST / fetch 带不上。
 * 2. 来源校验:浏览器给了 Sec-Fetch-Site 就按它判(只认 same-origin / none;
 *    例外:从网页聊天 / 邮件点开链接是跨站的**整页打开**,GET/HEAD 且不是 /api 的放行);
 *    没给(明文 http 的老路径)才比 Origin 与 Host / X-Forwarded-Host 的**主机名**。
 *    🔴 不比 http/https:云平台的 HTTPS 在它自己的代理处就解开了,浏览器带的 Origin 是 https,
 *       这里看到的连接是 http;按协议比会把所有写请求拒成 403。不少代理还会把 Host 改成内部地址,
 *       所以有 Sec-Fetch-Site 时不再比主机名。
 */

type Next = (error?: unknown) => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

export const ACCESS_COOKIE = "vra_access";
export const ACCESS_PARAM = "access";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function firstValue(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return (raw.split(",")[0] ?? "").trim();
}

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

const DENY_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>需要访问链接</title>'
  + '<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#1f2328;line-height:1.7}</style>'
  + "</head><body><h1>需要访问链接</h1>"
  + "<p>这个 Vibe Research 页面只对拿到访问链接的人开放。请用部署者发给你的<strong>完整链接</strong>打开(链接里带 <code>access=…</code>)。</p>"
  + "<p>以前能打开、现在打不开:多半是部署者换了新链接,请向对方要新的。</p></body></html>";

function deny(req: IncomingMessage, res: ServerResponse): void {
  if (String(req.url ?? "").startsWith("/api/")) {
    res.writeHead(401, { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "access_required", message: "访问链接无效或已失效:请用部署者发给你的完整链接重新打开页面。" }));
    return;
  }
  res.writeHead(401, { ...NO_STORE, "Content-Type": "text/html; charset=utf-8" });
  res.end(DENY_HTML);
}

export interface AccessGateOptions {
  /** 部署者给的公网根地址(`--public-url`,经 VRA_PUBLIC_URL 传进来):是 https 就一律给 cookie 加 Secure */
  publicUrl?: string | null;
  maxAgeSec?: number;
}

const LOOPBACK_HOST = /^(?:(?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/**
 * 浏览器这次是不是经 https 打开的 —— 任一证据成立就给访问 cookie 加 Secure:
 * - 部署者给的公网地址是 https;
 * - 代理标了 https(X-Forwarded-Proto / Forwarded 的 proto= / X-Forwarded-Ssl: on);
 * - 带了 Fetch Metadata(Sec-Fetch-*)且浏览器看到的主机不是本机:浏览器只对 https 与本机地址发这组头。
 * 都没有(代理把 Host 改成内部地址、也不标协议,又没给 --public-url)就判断不了,按明文处理 ——
 * 启动器因此提示部署者加 --public-url。
 */
export function requestIsHttps(req: IncomingMessage, publicUrl?: string | null): boolean {
  if (publicUrl && /^https:\/\//i.test(publicUrl)) return true;
  if (firstValue(req.headers["x-forwarded-proto"]).toLowerCase() === "https") return true;
  if (/(?:^|[;,\s])proto="?https"?(?:[;,\s]|$)/i.test(String(req.headers.forwarded ?? ""))) return true;
  if (firstValue(req.headers["x-forwarded-ssl"]).toLowerCase() === "on") return true;
  const fetchMetadata = req.headers["sec-fetch-site"] !== undefined || req.headers["sec-fetch-mode"] !== undefined;
  const host = firstValue(req.headers["x-forwarded-host"]) || firstValue(req.headers.host);
  return fetchMetadata && host !== "" && !LOOPBACK_HOST.test(host);
}

export function createAccessGate(token: string, opts: AccessGateOptions = {}): Middleware {
  if (!isValidAccessToken(token)) throw new Error("远程访问口令不合格:至少 32 位,只能用字母、数字、- 和 _");
  const maxAgeSec = opts.maxAgeSec ?? 30 * 24 * 3600;
  const expected = digest(token);
  const matches = (value: string | null) => value !== null && timingSafeEqual(digest(value), expected);
  return (req, res, next) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://gate.invalid"); }
    catch { deny(req, res); return; }
    if (url.searchParams.has(ACCESS_PARAM)) {
      if (!matches(url.searchParams.get(ACCESS_PARAM))) { deny(req, res); return; }
      url.searchParams.delete(ACCESS_PARAM);
      const secure = requestIsHttps(req, opts.publicUrl);
      // 开头多个斜杠会被浏览器当成「换一个网站」(//evil.example):收成一个,只跳本站
      const location = `/${url.pathname.replace(/^\/+/, "")}${url.search}`;
      res.writeHead(303, {
        ...NO_STORE,
        "Set-Cookie": `${ACCESS_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`,
        Location: location,
      });
      res.end();
      return;
    }
    if (matches(cookieValue(req, ACCESS_COOKIE))) { next(); return; }
    deny(req, res);
  };
}

function originHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Origin 只该是「协议 + 主机」,带路径 / 尾斜杠的一律当伪造
    return origin === `${url.protocol}//${url.host}` ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * 从网页聊天、邮件里点开链接 = 跨站的**整页打开**(Sec-Fetch-Mode: navigate + Dest: document)。
 * 它已经过了口令门、只读不写,放行;接口(/api)、写请求、嵌进别人页面的 iframe 仍按来源拒。
 */
function isTopLevelPageOpen(req: IncomingMessage): boolean {
  const method = String(req.method ?? "GET").toUpperCase();
  return (method === "GET" || method === "HEAD")
    && req.headers["sec-fetch-mode"] === "navigate"
    && req.headers["sec-fetch-dest"] === "document"
    && !String(req.url ?? "").startsWith("/api");  // 与代理同口径:/api 开头的都转给后端
}

export function createRemoteOriginGuard(): Middleware {
  return (req, res, next) => {
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    let ok = true;
    if (site !== undefined) ok = site === "same-origin" || site === "none" || isTopLevelPageOpen(req);
    else if (origin !== undefined) {
      const host = originHost(origin);
      const own = [firstValue(req.headers.host), firstValue(req.headers["x-forwarded-host"])].filter(Boolean).map((h) => h.toLowerCase());
      ok = host !== null && own.includes(host);
    }
    if (!ok) {
      res.writeHead(403, { ...NO_STORE, "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "forbidden_origin", message: "请从工作台自身页面发起请求。" }));
      return;
    }
    next();
  };
}

/** 远程模式要装的中间件(按顺序:先口令、再来源);口令不合格当场失败,不留一个没门的公网页面 */
export function remoteAccessMiddlewares(token: string | undefined, opts: { publicUrl?: string | null } = {}): Middleware[] {
  if (!isValidAccessToken(token)) {
    throw new Error("远程访问模式缺少有效的访问口令:请用 scripts/start --remote 启动(或设 VRA_ACCESS_TOKEN,至少 32 位,只能用字母、数字、- 和 _)");
  }
  return [createAccessGate(token, { publicUrl: opts.publicUrl }), createRemoteOriginGuard()];
}
