/**
 * 免安装包冒烟：解压后的包，在「没有系统 Node / Python」的环境里能不能起来。
 *
 * - PATH 只留系统目录，最前面再放一组假的 node / python / python3：哪一步没用包里的运行时、去找系统的，就当场失败。
 * - 先占住默认页面端口 5930（模拟别的程序占着），启动脚本要自动换到后面的空闲端口。
 * - 用包里的启动脚本起服务（不开浏览器），经页面代理查 /api/health，版本要和包信息一致；后端用的 Python 和数据目录都要是包里的；
 *   首页和一个深链接都要由打包好的页面提供（不是开发服务器）。
 * - 再用包里的 Node 跑一次体检：Node、Python 与取数依赖、calc 自检、注册表都要通过（不联网）。
 * - 最后停掉，确认实际用的页面端口和 8765 都放开了（没留下孤儿进程）。
 *
 * 用法：node scripts/portable/smoke.mts <解压后的包目录>   退出码 0 = 通过
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isMain, layoutOf, type Target } from "./build.mts";

const DEFAULT_UI_PORT = 5930;
const API_PORT = 8765;
/** 体检里必须通过的几项（AI 登录、联网这类与包无关的不算） */
export const REQUIRED_CHECKS = ["node", "config", "python", "calc", "registry", "constitution", "skills", "data_root"];

/** 只留系统目录的 PATH，最前面是放假命令的目录 */
export function cleanPath(platform: string, shimDir: string, systemRoot = "C:\\Windows"): string {
  const sys = platform === "win32"
    ? [path.win32.join(systemRoot, "System32"), systemRoot, path.win32.join(systemRoot, "System32", "Wbem"), path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [shimDir, ...sys].join(platform === "win32" ? ";" : ":");
}

/** 假的 node / python / python3：一被调用就报出是哪个、退出码 97 */
export function writeShims(dir: string, platform: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["node", "python", "python3", "npm"]) {
    if (platform === "win32") {
      fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\necho [smoke] 用到了系统的 ${name}，包里的运行时没接上 1>&2\r\nexit /b 97\r\n`);
    } else {
      const f = path.join(dir, name);
      fs.writeFileSync(f, `#!/bin/sh\necho "[smoke] 用到了系统的 ${name}，包里的运行时没接上" >&2\nexit 97\n`);
      fs.chmodSync(f, 0o755);
    }
  }
}

/** 体检结果里缺哪几项、哪几项没过 */
export function failedChecks(report: { checks?: { id: string; status: string; detail?: string }[] }): string[] {
  const byId = new Map((report.checks ?? []).map((c) => [c.id, c]));
  return REQUIRED_CHECKS.flatMap((id) => {
    const c = byId.get(id);
    if (!c) return [`${id}：体检里没有这一项`];
    return c.status === "ok" ? [] : [`${id}：${c.status} ${c.detail ?? ""}`.trim()];
  });
}

/** 页面不对就说哪里不对：要 200、要有根节点、不能是开发服务器（开发服务器会注入 /@vite/client） */
export function pageProblem(p: string, status: number, text: string): string | null {
  if (status !== 200 || !text.includes('<div id="root">')) return `打开 ${p} 不对（HTTP ${status}）`;
  if (text.includes("/@vite/client")) return `${p} 是开发服务器给的页面，不是打包好的那份`;
  return null;
}

/** 两个路径解开符号链接后是不是同一个文件 */
export function samePath(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, text: await res.text() };
}

function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

export async function smoke(pkgDir: string): Promise<void> {
  const info = JSON.parse(fs.readFileSync(path.join(pkgDir, "package-info.json"), "utf8")) as { version: string; target: Target };
  const L = layoutOf(info.target);
  for (const p of [DEFAULT_UI_PORT, API_PORT]) if (await portOpen(p)) throw new Error(`端口 ${p} 已被占用，先关掉占用它的程序再测`);
  // 模拟「默认端口被别的程序占着」：一个只回 404 的服务占住 5930，启动脚本应当换到后面第一个空闲端口
  const blocker = http.createServer((_req, res) => { res.statusCode = 404; res.end("not vibe research"); });
  await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(DEFAULT_UI_PORT, "127.0.0.1", resolve); });
  // 启动脚本会换到后面 20 个里第一个能用的；「能不能连上」和「能不能占用」不完全一回事，所以不猜具体是哪个，起来后挨个问
  const candidates: number[] = [];
  for (let p = DEFAULT_UI_PORT + 1; p <= DEFAULT_UI_PORT + 20; p++) if (p !== API_PORT && !(await portOpen(p))) candidates.push(p);
  if (!candidates.length) { blocker.close(); throw new Error(`${DEFAULT_UI_PORT + 1}–${DEFAULT_UI_PORT + 20} 都被占用，没法测自动换端口`); }
  let uiPort = 0;
  let UI = "";
  let PORTS = [API_PORT];

  const shims = fs.mkdtempSync(path.join(os.tmpdir(), "vr-smoke-shims-"));
  writeShims(shims, process.platform);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Windows 的环境变量名不分大小写,拷出来可能同时有 Path 和 PATH:先全删再写一个
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  env[process.platform === "win32" ? "Path" : "PATH"] = cleanPath(process.platform, shims, process.env.SystemRoot);
  for (const k of ["VRA_DATA_ROOT", "VRA_PYTHON", "VRA_REMOTE", "VRA_LAN", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONNOUSERSITE", "VIRTUAL_ENV"]) delete env[k];

  const child = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(pkgDir, "scripts", "portable", "start-portable.ps1"), "-NoOpen"], { cwd: pkgDir, env, stdio: "inherit" })
    : spawn("/bin/sh", [path.join(pkgDir, "scripts", "portable", "start-portable.sh"), "--no-open"], { cwd: pkgDir, env, stdio: "inherit" });
  let exited: number | null = null;
  child.on("exit", (code) => { exited = code ?? -1; });

  try {
    // 1. 起来：经页面代理查后端（首次启动要初始化数据目录，给足时间）
    const deadline = Date.now() + 180_000;
    let health: { ok?: boolean; version?: string } | null = null;
    while (Date.now() < deadline && !health) {
      if (exited !== null) throw new Error(`启动脚本提前退出（退出码 ${exited}），见上面的输出`);
      for (const p of candidates) {
        try {
          const r = await get(`http://127.0.0.1:${p}/api/health`);
          if (r.status === 200) { health = JSON.parse(r.text); uiPort = p; break; }
        } catch { /* 还没起来，或不是这个端口 */ }
      }
      if (!health) await sleep(1000);
    }
    if (uiPort) { UI = `http://127.0.0.1:${uiPort}`; PORTS = [uiPort, API_PORT]; }
    if (!health?.ok) throw new Error(`180 秒内没在 ${candidates[0]}–${candidates[candidates.length - 1]} 里等到 /api/health 返回正常（5930 被占时应自动换到后面的端口）`);
    if (health.version !== info.version) throw new Error(`后端报的版本是 ${health.version}，包信息是 ${info.version}`);
    console.log(`[smoke] 5930 被占时自动换到了 ${uiPort}；后端正常，版本 ${health.version}`);
    const product = await get(`${UI}/api/product`);
    let paths: { python?: string; data_root?: string } | undefined;
    try { paths = (JSON.parse(product.text) as { paths?: typeof paths }).paths; } catch { /* 下面报 */ }
    if (!samePath(paths?.python, path.join(pkgDir, L.python))) throw new Error(`后端用的 Python 是 ${paths?.python ?? "（没报）"}，不是包里的 ${L.python}`);
    if (!samePath(paths?.data_root, path.join(pkgDir, ".local"))) throw new Error(`后端的数据目录是 ${paths?.data_root ?? "（没报）"}，不是包里的 .local`);
    console.log("[smoke] 后端用的是包里的 Python 和 .local");

    // 2. 页面：首页和深链接都由打包好的页面提供
    for (const p of ["/", "/portfolio"]) {
      const r = await get(`${UI}${p}`);
      const problem = pageProblem(p, r.status, r.text);
      if (problem) throw new Error(problem);
    }
    console.log("[smoke] 首页和深链接都能打开，是打包好的页面");

    // 3. 体检：用包里的 Node 和 Python
    const doc = spawnSync(path.join(pkgDir, L.node), [path.join(pkgDir, "orchestrator", "src", "doctor.ts"), "--json", "--python", path.join(pkgDir, L.python)],
      { cwd: pkgDir, env: { ...env, PYTHONNOUSERSITE: "1" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
    let report: { checks?: { id: string; status: string; detail?: string }[] };
    try { report = JSON.parse(doc.stdout); } catch { throw new Error(`体检没有给出结果（退出码 ${doc.status}）：${doc.stderr.slice(0, 2000)}`); }
    const bad = failedChecks(report);
    if (bad.length) throw new Error(`体检没过：\n  ${bad.join("\n  ")}`);
    console.log(`[smoke] 体检通过：${REQUIRED_CHECKS.join("、")}`);
  } finally {
    stop(child);
    const until = Date.now() + 20_000;
    while (exited === null && Date.now() < until) await sleep(250);
    fs.rmSync(shims, { recursive: true, force: true });
    blocker.closeAllConnections();
    await new Promise((resolve) => blocker.close(resolve));
  }

  // 4. 停干净：两个端口都要放开
  const until = Date.now() + 15_000;
  let open: number[] = PORTS;
  while (Date.now() < until) {
    open = [];
    for (const p of PORTS) if (await portOpen(p)) open.push(p);
    if (!open.length) break;
    await sleep(500);
  }
  if (open.length) throw new Error(`停掉以后端口 ${open.join("、")} 还开着（有进程没退出）`);
  console.log("[smoke] 已停止，端口都已放开");
}

if (isMain(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error("用法：node scripts/portable/smoke.mts <解压后的包目录>"); process.exit(2); }
  smoke(path.resolve(dir)).then(() => console.log("[smoke] 通过"), (e: unknown) => {
    console.error(`[smoke] 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
