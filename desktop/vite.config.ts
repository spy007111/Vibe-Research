import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { apiTokenPath } from "./vite-token";
import { remoteAccessMiddlewares } from "./remote-access";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
// 上游 #34：仅用户显式开启时监听所有网卡；这不是多用户登录或公网部署方案。
const lan = process.env.VRA_LAN === "1";
// 远程访问模式(scripts/start --remote，给云端 Agent 部署后发链接给使用者)：先打包，再由 vite preview 对外，
// 每个请求都要过访问口令(见 remote-access.ts)。不把开发服务器直接暴露到公网。
const remote = process.env.VRA_REMOTE === "1";
const remoteGate = remote ? remoteAccessMiddlewares(process.env.VRA_ACCESS_TOKEN, { publicUrl: process.env.VRA_PUBLIC_URL || null }) : [];

/** 启动器选好的端口经环境变量传进来（见 orchestrator/src/startup_ports.ts）；没给就用默认 5930 / 8765 */
function envPort(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || n < 1 || n > 65535) throw new Error(`${name} 要填 1–65535 之间的整数，现在是「${raw}」`);
  return n;
}
const uiPort = envPort("VRA_UI_PORT", 5930);
const apiPort = envPort("VRA_API_PORT", 8765);

/**
 * 开发期鉴权:**Bearer token 只留在 Vite 进程里,不进浏览器**。
 * 前端一律打 `/api/*`(同源、无凭据),由这里补 Authorization 头转发到本机编排器 API。
 * 🔴 每次请求都重读 token 文件 —— API 重启会换 token(api.ts:resolveToken),
 *    缓存住就会在"看着还开着"的情况下整站 401,而且要重启前端才好,极难排查。
 *    文件是本机几十字节,重读的代价可以忽略。
 */
function apiToken(): string {
  const fromEnv = process.env.VRA_API_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const file = apiTokenPath(repoRoot);
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 16) return t;
  } catch {
    /* 缺失时不补头,后端会以 401 明确拒绝,好过在这里静默放行 */
  }
  return "";
}

const apiProxy: Record<string, ProxyOptions> = {
  "/api": {
    target: `http://127.0.0.1:${apiPort}`,
    changeOrigin: false,
    rewrite: (p) => p.replace(/^\/api/, ""),
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => {
        // LAN / 远程请求已经通过前置同源检查，此处才归一化为后端认可的回环 Origin。
        if (lan || remote) proxyReq.setHeader("origin", `http://127.0.0.1:${uiPort}`);
        // 访问 cookie 只给页面服务器看，不往后端带。
        if (remote) proxyReq.removeHeader("cookie");
        const token = apiToken();
        if (token) proxyReq.setHeader("Authorization", `Bearer ${token}`);
        // 后端 crossSiteReject 只接受本机 Origin;浏览器带的是 127.0.0.1:<页面端口>,本机、放行。
      });
      proxy.on("error", (err, _req, res) => {
        // 默认错误页是一段 HTML,前端 res.json() 会炸在"Unexpected token <",把真正原因埋掉
        const msg = /ECONNREFUSED/.test(String(err))
          ? "本机服务没有启动或已经关闭。请按页面提示重新启动。"
          : `代理失败:${err.message}`;
        if ("writeHead" in res && !res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "api_unreachable", message: msg }));
        }
      });
    },
  },
};

export default defineConfig({
  plugins: [react(), {
    name: "vra-remote-access",
    // 直接在钩子里 use 的中间件排在 Vite 自己的静态文件与代理之前：没过口令什么都拿不到。
    configurePreviewServer(server) { for (const m of remoteGate) server.middlewares.use(m); },
    configureServer(server) { for (const m of remoteGate) server.middlewares.use(m); },
  }, {
    name: "vra-lan-origin-guard",
    configureServer(server) {
      if (!lan) return;
      // 在 Vite 代理（自动附加后端 token）之前拒绝跨站浏览器请求。
      // 不能无条件改 Origin：非安全 HTTP 上浏览器可能不发送 Sec-Fetch-Site。
      server.middlewares.use((req, res, next) => {
        const origin = req.headers.origin;
        const site = req.headers["sec-fetch-site"];
        const sameOrigin = `${server.config.server.https ? "https" : "http"}://${req.headers.host}`;
        if ((origin !== undefined && origin !== sameOrigin)
          || (site !== undefined && site !== "same-origin" && site !== "none")) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "forbidden_origin", message: "请从工作台自身页面发起请求。" }));
          return;
        }
        next();
      });
    },
  }],
  // 🔴 `@` 指向**垂类包**而不是 src:上游 UI 里写的是 `@/components`、`@/lib`、`@/data`,
  //    我们把它整套放进 verticals/finance/,别名这么指,上游代码一行都不用改。
  resolve: { alias: { "@": path.resolve(here, "src/verticals/finance") } },
  server: {
    // 🔴 必须写死 IPv4:默认 localhost 在本机解析成 [::1],而后端绑的是 127.0.0.1,对不上会 502
    host: lan ? "0.0.0.0" : "127.0.0.1",
    port: uiPort,
    // 端口由启动器先选好（默认 5930，被占时它换好再传进来），打开的就是这个地址；
    // 这里被占用时必须明确失败，不能静默漂到下一个端口让用户看到旧页面。
    strictPort: true,
    proxy: apiProxy,
  },
  // 远程访问模式(startup.ts 先 vite build 再 vite preview)和打包好的页面(--prebuilt / 免安装包)用。
  preview: {
    host: remote ? "0.0.0.0" : "127.0.0.1",
    port: uiPort,
    strictPort: true,
    // 云平台分配的公网域名事先不知道；放行任意 Host，靠上面的访问口令把门(没口令连页面都拿不到)。
    allowedHosts: remote ? true : [],
    proxy: apiProxy,
  },
});
