import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { preview, resolveConfig } from "vite";

import { createAccessGate, createRemoteOriginGuard, requestIsHttps, type Middleware } from "../remote-access.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TOKEN = "remote-access-test-token-0123456789abcdef";

interface RawReply { status: number; headers: http.IncomingHttpHeaders; body: string }

/** 用原始 http 发请求:fetch 不让改 Host,也会先把路径规范化,测不到代理与跳转的真实情形 */
function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 不起服务器,直接把一个假请求过一道中间件:记下状态码、响应头,以及是否放行到下一步 */
function pass(mw: Middleware, req: { method?: string; url?: string; headers?: Record<string, string> }) {
  const out = { status: 0, headers: {} as Record<string, unknown>, passed: false };
  const res = { writeHead(status: number, headers: Record<string, unknown>) { out.status = status; out.headers = headers; return res; }, end() {} };
  mw({ method: "GET", url: "/", ...req, headers: req.headers ?? {} } as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse, () => { out.passed = true; });
  return out;
}

const fakeReq = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;

function withEnv(vars: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  return () => { for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
}

test("访问 cookie 的 Secure:部署者给了 https 公网地址、代理标了 https、或浏览器带 Fetch Metadata 访问非本机地址才加", () => {
  const yes: [Record<string, string>, string | null][] = [
    [{}, "https://abc.platform.example"],
    [{ "x-forwarded-proto": "https" }, null],
    [{ "x-forwarded-proto": "https, http" }, null],
    [{ forwarded: "for=203.0.113.9;proto=https;host=abc.platform.example" }, null],
    [{ forwarded: 'for="[2001:db8::1]";proto="https"' }, null],
    [{ "x-forwarded-ssl": "on" }, null],
    // 浏览器只对 https 与本机地址发 Sec-Fetch-*:带了、又不是本机 ⇒ 用户走的是 https
    [{ "sec-fetch-site": "none", host: "abc.platform.example" }, null],
    [{ "sec-fetch-mode": "navigate", host: "abc.platform.example:443" }, null],
    // 代理把 Host 改成了内部地址,但 X-Forwarded-Host 是浏览器看到的那个
    [{ "sec-fetch-site": "cross-site", host: "127.0.0.1:5930", "x-forwarded-host": "abc.platform.example" }, null],
  ];
  for (const [headers, publicUrl] of yes) assert.equal(requestIsHttps(fakeReq(headers), publicUrl), true, JSON.stringify({ headers, publicUrl }));
  const no: [Record<string, string>, string | null][] = [
    [{ host: "1.2.3.4:5930" }, null],                                   // 明文 http 直连:浏览器不发 Sec-Fetch-*
    [{ host: "1.2.3.4:5930" }, "http://1.2.3.4:5930"],
    [{ "x-forwarded-proto": "http" }, null],
    [{ forwarded: "for=203.0.113.9;proto=http" }, null],
    [{ forwarded: "for=203.0.113.9;host=proto-https.example" }, null],
    [{ forwarded: "for=203.0.113.9;xproto=https" }, null],              // 只认名字正好是 proto 的那一项
    [{ "x-forwarded-ssl": "off" }, null],
    // 本机打开(SSH 隧道、本机浏览器):浏览器照样带 Sec-Fetch-*,但这是明文 http
    [{ "sec-fetch-site": "none", host: "127.0.0.1:5930" }, null],
    [{ "sec-fetch-site": "none", host: "localhost:5930" }, null],
    [{ "sec-fetch-site": "none", host: "LOCALHOST" }, null],
    [{ "sec-fetch-site": "none", host: "vr.localhost:5930" }, null],
    [{ "sec-fetch-site": "none", host: "[::1]:5930" }, null],
    [{ "sec-fetch-site": "none" }, null],
  ];
  for (const [headers, publicUrl] of no) assert.equal(requestIsHttps(fakeReq(headers), publicUrl), false, JSON.stringify({ headers, publicUrl }));

  // 门本身:分享链接换 cookie 时按上面的判断加 Secure
  const token = "unit-gate-token-0123456789abcdef0123";
  const setCookie = (opts: Parameters<typeof createAccessGate>[1], headers: Record<string, string> = {}) =>
    String(pass(createAccessGate(token, opts), { url: `/?access=${token}`, headers }).headers["Set-Cookie"]);
  assert.match(setCookie({ publicUrl: "https://abc.platform.example" }), /; Secure$/);
  assert.doesNotMatch(setCookie({ publicUrl: "http://1.2.3.4:5930" }), /Secure/);
  assert.doesNotMatch(setCookie({}), /Secure/);
  assert.match(setCookie({}, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", host: "abc.platform.example" }), /; Secure$/);
  assert.match(setCookie({ maxAgeSec: 60 }), /Max-Age=60/);
});

test("来源校验:从聊天 / 邮件点开链接(跨站整页打开)能进页面;跨站的接口、写请求、iframe、脚本照样拒", () => {
  const guard = createRemoteOriginGuard();
  const nav = (site: string, extra: Record<string, string> = {}) =>
    ({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", ...extra });
  const allowed: Parameters<typeof pass>[1][] = [
    { url: "/", headers: nav("cross-site") },
    { url: "/research/abc?x=1", headers: nav("cross-site") },
    { method: "HEAD", url: "/", headers: nav("cross-site") },
    { url: "/", headers: nav("same-site") },
    { url: "/", headers: nav("none") },
    { url: "/assets/app.js", headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" } },
  ];
  for (const req of allowed) assert.equal(pass(guard, req).passed, true, JSON.stringify(req));
  const denied: Parameters<typeof pass>[1][] = [
    { url: "/api/health", headers: nav("cross-site") },               // 接口不因为「整页打开」就放行
    { url: "/apix", headers: nav("cross-site") },                     // 与代理同口径:/api 开头的都会转给后端
    { method: "POST", url: "/", headers: nav("cross-site") },         // 跨站表单提交
    { url: "/", headers: nav("cross-site", { "sec-fetch-dest": "iframe" }) },   // 嵌进别人的页面(点击劫持)
    { url: "/", headers: nav("cross-site", { "sec-fetch-mode": "no-cors" }) },
    { url: "/assets/app.js", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" } },
    { method: "POST", url: "/api/probe", headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } },
  ];
  for (const req of denied) {
    const out = pass(guard, req);
    assert.equal(out.passed, false, JSON.stringify(req));
    assert.equal(out.status, 403, JSON.stringify(req));
  }
});

test("远程访问配置:只有带合格口令时才对外,放行任意 Host;本机模式的 preview 仍只听回环", async () => {
  let restore = withEnv({ VRA_REMOTE: "1", VRA_ACCESS_TOKEN: TOKEN });
  try {
    const remote = await resolveConfig({ root: ROOT, logLevel: "silent" }, "serve", "production", "production", true);
    assert.equal(remote.preview.host, "0.0.0.0");
    assert.equal(remote.preview.allowedHosts, true);
    assert.equal(remote.preview.port, 5930);
    assert.equal(remote.preview.strictPort, true);
  } finally { restore(); }

  for (const bad of [undefined, "short", `${"a".repeat(40)};Path=/`]) {
    restore = withEnv({ VRA_REMOTE: "1", VRA_ACCESS_TOKEN: bad });
    try {
      await assert.rejects(resolveConfig({ root: ROOT, logLevel: "silent" }, "serve", "production", "production", true),
        /缺少有效的访问口令/, `口令 ${JSON.stringify(bad)} 不能起一个没门的公网页面`);
    } finally { restore(); }
  }

  restore = withEnv({ VRA_REMOTE: undefined, VRA_ACCESS_TOKEN: undefined });
  try {
    const local = await resolveConfig({ root: ROOT, logLevel: "silent" }, "serve", "production", "production", true);
    assert.equal(local.preview.host, "127.0.0.1");
    assert.notEqual(local.preview.allowedHosts, true);
  } finally { restore(); }
});

test("远程访问:启动器给的公网地址(VRA_PUBLIC_URL)是 https 时,哪怕代理什么都不标,访问 cookie 也带 Secure", async () => {
  const restore = withEnv({ VRA_REMOTE: "1", VRA_ACCESS_TOKEN: TOKEN, VRA_PUBLIC_URL: "https://abc.platform.example", VRA_LAN: undefined });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-remote-dist-"));
  fs.writeFileSync(path.join(outDir, "index.html"), "<!doctype html><title>vr</title>");
  const server = await preview({ root: ROOT, logLevel: "silent", build: { outDir }, preview: { host: "127.0.0.1", port: 0, strictPort: false } });
  try {
    const port = (server.httpServer.address() as { port: number }).port;
    const link = await raw(port, { path: `/?access=${TOKEN}`, headers: { Host: "10.0.0.7:5930" } });
    assert.equal(link.status, 303);
    assert.match(String(link.headers["set-cookie"]), /; Secure/);
  } finally {
    await new Promise<void>((resolve, reject) => server.httpServer.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(outDir, { recursive: true, force: true });
    restore();
  }
});

test("远程访问:没口令什么都拿不到;分享链接换 HttpOnly cookie 后跳回;伪造来源到不了后端;访问 cookie 不往后端带", async () => {
  const restore = withEnv({ VRA_REMOTE: "1", VRA_ACCESS_TOKEN: TOKEN, VRA_API_TOKEN: "synthetic-remote-proxy-test-token", VRA_LAN: undefined, VRA_PUBLIC_URL: undefined });
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-remote-dist-"));
  fs.writeFileSync(path.join(outDir, "index.html"), "<!doctype html><title>vr</title><div id=root>remote-ok</div>");
  let seen = 0;
  let last: http.IncomingHttpHeaders = {};
  const target = http.createServer((req, res) => {
    seen += 1;
    last = req.headers;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  const targetPort = (target.address() as { port: number }).port;
  // 测试只听回环、端口随机;口令门与代理用的都是 vite.config.ts 里那一份
  const server = await preview({ root: ROOT, logLevel: "silent", build: { outDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: false, proxy: { "/api": { target: `http://127.0.0.1:${targetPort}` } } } });
  try {
    const port = (server.httpServer.address() as { port: number }).port;
    const cookie = `vra_access=${TOKEN}`;

    // ① 没口令:页面、静态资源、接口一律 401,接口请求根本到不了后端
    const page = await raw(port, { path: "/" });
    assert.equal(page.status, 401);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(page.body, /需要访问链接/);
    assert.doesNotMatch(page.body, /remote-ok/);
    assert.equal((await raw(port, { path: "/index.html" })).status, 401);
    const api = await raw(port, { path: "/api/health" });
    assert.equal(api.status, 401);
    assert.equal(JSON.parse(api.body).error, "access_required");
    assert.equal(seen, 0);
    assert.equal((await raw(port, { path: "/", headers: { Cookie: "vra_access=wrong-token-wrong-token-wrong-token-00" } })).status, 401);
    assert.equal((await raw(port, { path: "/?access=wrong-token-wrong-token-wrong-token-00" })).status, 401);

    // ② 分享链接:换成 cookie,303 跳回去掉口令的同一地址;口令不进 Location
    const link = await raw(port, { path: `/research/abc?x=1&access=${TOKEN}` });
    assert.equal(link.status, 303);
    assert.equal(link.headers.location, "/research/abc?x=1");
    const setCookie = String(link.headers["set-cookie"]);
    assert.match(setCookie, new RegExp(`^vra_access=${TOKEN};`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Max-Age=2592000/);
    assert.equal(link.headers["cache-control"], "no-store", "带 Set-Cookie 的跳转不能被缓存");
    assert.doesNotMatch(setCookie, /Secure/, "明文 http 访问时带 Secure 会让浏览器把 cookie 丢掉");
    assert.match(String((await raw(port, { path: `/?access=${TOKEN}`, headers: { "X-Forwarded-Proto": "https" } })).headers["set-cookie"]), /; Secure/);
    // 路径里藏「//别的网站」也只能跳回本站
    const sneaky = await raw(port, { path: `/a/..//evil.example/x?access=${TOKEN}` });
    assert.equal(sneaky.status, 303);
    assert.ok(String(sneaky.headers.location).startsWith("/") && !String(sneaky.headers.location).startsWith("//"),
      `不能跳去别的网站:${sneaky.headers.location}`);

    // ③ 带 cookie:页面与前端路由正常;云平台的公网域名(任意 Host)也放行
    const ok = await raw(port, { path: "/", headers: { Cookie: cookie } });
    assert.equal(ok.status, 200);
    assert.match(ok.body, /remote-ok/);
    assert.equal((await raw(port, { path: "/settings", headers: { Cookie: cookie, Host: "abc.platform.example" } })).status, 200);

    // ④ 云平台 HTTPS 代理的三种真实形态:都能写,后端看到的是本机 Origin + Bearer,看不到访问 cookie
    const post = (headers: Record<string, string>) => raw(port, { method: "POST", path: "/api/probe",
      headers: { Cookie: cookie, "Content-Type": "application/json", ...headers }, body: "{}" });
    for (const headers of [
      { Host: "abc.platform.example", Origin: "https://abc.platform.example", "X-Forwarded-Proto": "https" },
      { Host: `127.0.0.1:${port}`, Origin: "https://abc.platform.example", "X-Forwarded-Host": "abc.platform.example" },
      { Host: `127.0.0.1:${port}`, Origin: "https://abc.platform.example", "Sec-Fetch-Site": "same-origin" },
    ]) {
      const before = seen;
      const reply = await post(headers);
      assert.equal(reply.status, 200, JSON.stringify(headers));
      assert.equal(seen, before + 1);
      assert.equal(last.origin, "http://127.0.0.1:5930");
      assert.equal(last.authorization, "Bearer synthetic-remote-proxy-test-token");
      assert.equal(last.cookie, undefined, "访问口令只给页面服务器,不往后端带");
    }

    // ⑤ 跨站 / 同站兄弟域名 / 伪造 Origin:在页面服务器就拒掉,不先打到后端
    for (const headers of [
      { Host: "abc.platform.example", Origin: "https://abc.platform.example", "Sec-Fetch-Site": "cross-site" },
      { Host: "abc.platform.example", Origin: "https://evil.platform.example", "Sec-Fetch-Site": "same-site" },
      { Host: "abc.platform.example", Origin: "https://evil.example" },
      { Host: "abc.platform.example", Origin: "null" },
      { Host: "abc.platform.example", Origin: "https://abc.platform.example/path" },
    ]) {
      const before = seen;
      const reply = await post(headers);
      assert.equal(reply.status, 403, JSON.stringify(headers));
      assert.equal(JSON.parse(reply.body).error, "forbidden_origin");
      assert.equal(seen, before, `不允许先把请求发到后端再拒绝:${JSON.stringify(headers)}`);
    }

    // ⑥ 从网页聊天 / 邮件点开分享链接:跨站整页打开,换 cookie(经 https 访问公网域名 ⇒ Secure)后跳回能进页面
    const crossNav = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", Host: "abc.platform.example" };
    const shared = await raw(port, { path: `/?access=${TOKEN}`, headers: crossNav });
    assert.equal(shared.status, 303);
    assert.match(String(shared.headers["set-cookie"]), /; Secure/);
    const landed = await raw(port, { path: "/", headers: { ...crossNav, Cookie: cookie } });
    assert.equal(landed.status, 200, "跟着跳转打开的页面同样是跨站整页打开,不能拒");
    assert.match(landed.body, /remote-ok/);
    // 本机打开(Host 是回环)即使带了 Sec-Fetch-* 也是明文 http,不加 Secure
    assert.doesNotMatch(String((await raw(port, { path: `/?access=${TOKEN}`, headers: { ...crossNav, Host: `127.0.0.1:${port}` } })).headers["set-cookie"]), /Secure/);
    for (const headers of [
      { ...crossNav, Cookie: cookie },                                        // 跨站整页打开接口地址
      { ...crossNav, Cookie: cookie, "Sec-Fetch-Dest": "iframe" },
    ]) {
      const before = seen;
      const reply = await raw(port, { path: headers["Sec-Fetch-Dest"] === "iframe" ? "/" : "/api/health", headers });
      assert.equal(reply.status, 403, JSON.stringify(headers));
      assert.equal(seen, before, "跨站来的接口请求不能打到后端");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.httpServer.close((err) => err ? reject(err) : resolve()));
    target.closeAllConnections();
    await new Promise<void>((resolve, reject) => target.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(outDir, { recursive: true, force: true });
    restore();
  }
});

test("端口:启动器选好的端口经 VRA_UI_PORT / VRA_API_PORT 传进来,开发服务器、preview、/api 转发都跟着用;没给是 5930 / 8765;乱填直接报错", async () => {
  let restore = withEnv({ VRA_REMOTE: undefined, VRA_ACCESS_TOKEN: undefined, VRA_LAN: undefined, VRA_UI_PORT: "5931", VRA_API_PORT: "8766" });
  try {
    for (const command of ["serve", "build"] as const) {
      const config = await resolveConfig({ root: ROOT, logLevel: "silent" }, command, "development", "development", command === "build");
      assert.equal(config.server.port, 5931);
      assert.equal(config.preview.port, 5931);
      assert.equal(config.server.strictPort, true, "启动器打开的就是这个端口:被抢了要明确失败,不能静默漂走");
      const proxy = config.server.proxy?.["/api"];
      assert.ok(proxy && typeof proxy === "object");
      assert.equal(proxy.target, "http://127.0.0.1:8766");
    }
  } finally { restore(); }
  restore = withEnv({ VRA_REMOTE: undefined, VRA_ACCESS_TOKEN: undefined, VRA_UI_PORT: undefined, VRA_API_PORT: undefined });
  try {
    const config = await resolveConfig({ root: ROOT, logLevel: "silent" }, "serve", "development", "development", false);
    assert.equal(config.server.port, 5930);
    const proxy = config.server.proxy?.["/api"];
    assert.ok(proxy && typeof proxy === "object");
    assert.equal(proxy.target, "http://127.0.0.1:8765");
  } finally { restore(); }
  for (const bad of ["0", "70000", "59x"]) {
    restore = withEnv({ VRA_REMOTE: undefined, VRA_ACCESS_TOKEN: undefined, VRA_UI_PORT: bad, VRA_API_PORT: undefined });
    try {
      await assert.rejects(resolveConfig({ root: ROOT, logLevel: "silent" }, "serve", "development", "development", false),
        /VRA_UI_PORT 要填 1–65535/, bad);
    } finally { restore(); }
  }
});
