import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { accessTokenPath, ensureAccessToken, isPlainRemoteHttp, normalizePublicUrl } from "../src/access_token.ts";
import {
  assertPortAvailable, assertStartupPorts, createShutdownMonitor, parseStartupArgs, remoteLinkLines, startupChildEnvs, startupMissingFiles, waitUntilReady,
} from "../src/startup.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("#34 两种启动器不覆盖 Vite 的 LAN 开关，API 继续只绑定回环", () => {
  const posix = fs.readFileSync(path.join(REPO, "orchestrator/src/startup.ts"), "utf8");
  const windows = fs.readFileSync(path.join(REPO, "scripts/start.ps1"), "utf8");
  for (const source of [posix, windows]) {
    const uis = source.split("\n").filter((line) => /(?:const ui =|\$ui = Start-Process)/.test(line));
    assert.ok(uis.length >= 1);
    for (const ui of uis) assert.doesNotMatch(ui, /--host/);
    const api = source.split("\n").find((line) => /(?:const api =|\$api = Start-Process)/.test(line));
    assert.ok(api);
    assert.match(api, /"--host", "127\.0\.0\.1"/);
  }
});

test("POSIX 安装入口在包目录内执行 npm ci，避免首次安装的绝对 prefix 兼容问题", () => {
  const source = fs.readFileSync(path.join(REPO, "scripts", "setup"), "utf8");
  assert.match(source, /cd "\$ROOT\/orchestrator" && npm ci --no-audit --no-fund/);
  assert.match(source, /cd "\$ROOT\/desktop" && npm ci --no-audit --no-fund/);
  assert.doesNotMatch(source, /npm ci --prefix/);
});

test("各平台安装入口不把 npm 审计网络当成首次启动阻塞", () => {
  const posix = fs.readFileSync(path.join(REPO, "scripts", "setup"), "utf8");
  const windows = fs.readFileSync(path.join(REPO, "scripts", "setup-windows.ps1"), "utf8");
  for (const source of [posix, windows]) {
    assert.equal((source.match(/npm ci/g) ?? []).length, 2);
    assert.equal((source.match(/--no-audit --no-fund/g) ?? []).length, 2);
  }
});

test("启动参数：帮助、禁止自动打开浏览器、远程访问三件套，其余一律拒绝", () => {
  const local = { remote: false, publicUrl: null, rotateAccess: false, prebuilt: false };
  assert.deepEqual(parseStartupArgs([]), { openBrowser: true, help: false, ...local });
  assert.deepEqual(parseStartupArgs(["--prebuilt", "--no-open"]), { openBrowser: false, help: false, ...local, prebuilt: true });
  assert.equal(parseStartupArgs(["--remote", "--prebuilt"]).prebuilt, true, "远程模式也可以用打包好的页面");
  assert.deepEqual(parseStartupArgs(["--no-open"]), { openBrowser: false, help: false, ...local });
  assert.deepEqual(parseStartupArgs(["-h"]), { openBrowser: true, help: true, ...local });
  assert.throws(() => parseStartupArgs(["--port", "9000"]), /未知参数/);

  assert.deepEqual(parseStartupArgs(["--remote", "--no-open", "--public-url", "https://Abc.Example.app/"]),
    { openBrowser: false, help: false, remote: true, publicUrl: "https://abc.example.app", rotateAccess: false, prebuilt: false });
  assert.deepEqual(parseStartupArgs(["--remote", "--public-url=https://abc.example.app:8443", "--rotate-access"]),
    { openBrowser: true, help: false, remote: true, publicUrl: "https://abc.example.app:8443", rotateAccess: true, prebuilt: false });
  // 只在远程模式下有意义的参数，单独给就报错，不静默忽略
  assert.throws(() => parseStartupArgs(["--public-url", "https://abc.example.app"]), /只能和 --remote 一起用/);
  assert.throws(() => parseStartupArgs(["--rotate-access"]), /只能和 --remote 一起用/);
  assert.throws(() => parseStartupArgs(["--remote", "--public-url"]), /后面要跟地址/);
  assert.throws(() => parseStartupArgs(["--remote", "--public-url", "--no-open"]), /后面要跟地址/);
});

test("远程访问的公网地址只收 http(s) 根地址：子路径、凭据、查询参数当场拒绝", () => {
  assert.equal(normalizePublicUrl("https://abc.example.app"), "https://abc.example.app");
  assert.equal(normalizePublicUrl("http://203.0.113.5:5930/"), "http://203.0.113.5:5930");
  for (const bad of ["ftp://abc.example.app", "abc.example.app", "https://u:p@abc.example.app",
    "https://abc.example.app/proxy/5930/", "https://abc.example.app/?x=1", "https://abc.example.app/#a"]) {
    assert.throws(() => normalizePublicUrl(bad), /--public-url/, bad);
  }
  assert.equal(isPlainRemoteHttp("http://203.0.113.5:5930"), true, "明文公网地址要提醒 key 会明文过网");
  assert.equal(isPlainRemoteHttp("https://abc.example.app"), false);
  assert.equal(isPlainRemoteHttp("http://localhost:5930"), false);
  assert.equal(isPlainRemoteHttp("http://[::1]:5930"), false);
});

test("远程访问口令：首次生成 0600 文件并沿用，换链接才变；环境变量优先且必须合格", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-access-"));
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(dataRoot);
  fs.writeFileSync(path.join(root, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: ".local" } }));
  const env = { VRA_DATA_ROOT: dataRoot };
  try {
    const file = accessTokenPath(root, env);
    assert.equal(file, path.join(dataRoot, "access.token"));
    const first = ensureAccessToken(root, env);
    assert.equal(first.source, "new");
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(fs.readFileSync(file, "utf8").trim(), first.token);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    fs.chmodSync(file, 0o644);
    const again = ensureAccessToken(root, env);
    assert.deepEqual(again, { token: first.token, source: "file" }, "机器重启链接不变");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "权限被放宽过也要收回");

    const rotated = ensureAccessToken(root, env, true);
    assert.equal(rotated.source, "new");
    assert.notEqual(rotated.token, first.token);
    assert.equal(fs.readFileSync(file, "utf8").trim(), rotated.token);

    fs.writeFileSync(file, "short\n");
    const repaired = ensureAccessToken(root, env);
    assert.equal(repaired.source, "new", "坏掉的口令文件不能当口令用");
    assert.notEqual(repaired.token, "short");
    assert.deepEqual(fs.readdirSync(dataRoot).filter((f) => f.endsWith(".tmp")), [], "临时文件不残留");

    const fromEnv = "e".repeat(40);
    assert.deepEqual(ensureAccessToken(root, { ...env, VRA_ACCESS_TOKEN: fromEnv }), { token: fromEnv, source: "env" });
    assert.throws(() => ensureAccessToken(root, { ...env, VRA_ACCESS_TOKEN: fromEnv }, true), /换这个变量的值/);
    for (const bad of ["", "too-short", "x".repeat(31), `${"a".repeat(40)};Path=/`, `${"a".repeat(40)} `]) {
      assert.throws(() => ensureAccessToken(root, { ...env, VRA_ACCESS_TOKEN: bad }), /VRA_ACCESS_TOKEN 不合格/, JSON.stringify(bad));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("远程模式只把口令交给页面服务器：API 进程的环境里没有它（平台放在环境变量里的也剥掉），但知道自己在远程模式；页面先打包再由 preview 提供", () => {
  const token = "k".repeat(40);
  const parent = { PATH: "/usr/bin", VRA_ACCESS_TOKEN: token, VRA_DATA_ROOT: "/data" };
  const remote = startupChildEnvs(parent, { token }, "https://abc.platform.example");
  assert.equal(remote.uiEnv.VRA_REMOTE, "1");
  assert.equal(remote.uiEnv.VRA_ACCESS_TOKEN, token);
  assert.equal(remote.uiEnv.VRA_PUBLIC_URL, "https://abc.platform.example");
  assert.equal(remote.apiEnv.VRA_REMOTE, "1", "API 要据此拒绝页面改程序位置、填内网模型地址");
  assert.equal(remote.apiEnv.VRA_ACCESS_TOKEN, undefined, "API 拿不到访问口令");
  assert.equal(remote.apiEnv.VRA_PUBLIC_URL, undefined);
  assert.equal(remote.apiEnv.VRA_PUSH_LINK_BASE, "https://abc.platform.example", "推送里的链接用对外地址");
  assert.equal(startupChildEnvs({ VRA_PUSH_LINK_BASE: "https://stale.example", VRA_PUBLIC_URL: "https://stale.example" }, { token }, null).apiEnv.VRA_PUSH_LINK_BASE, undefined,
    "没给 --public-url 就不沿用残留的链接地址");
  assert.equal(startupChildEnvs({ VRA_PUSH_LINK_BASE: "https://stale.example" }, null, null).apiEnv.VRA_PUSH_LINK_BASE, undefined, "本机模式也不沿用");
  assert.equal(remote.apiEnv.VRA_DATA_ROOT, "/data");
  assert.equal(parent.VRA_ACCESS_TOKEN, token, "不改调用方的环境");
  assert.equal(startupChildEnvs({ VRA_PUBLIC_URL: "https://stale.example" }, { token }, null).uiEnv.VRA_PUBLIC_URL, undefined,
    "没给 --public-url 就不能沿用环境里残留的旧地址");
  assert.equal(startupChildEnvs({ VRA_PUBLIC_URL: "https://stale.example" }, { token }, null).apiEnv.VRA_PUBLIC_URL, undefined, "API 只拿推送链接用的那个变量");
  // 本机模式:环境里残留的远程开关不能让页面对外开放,也不能让 API 误开远程限制
  const local = startupChildEnvs({ PATH: "/usr/bin", VRA_REMOTE: "1", VRA_PUBLIC_URL: "https://x.example" }, null, null);
  for (const env of [local.apiEnv, local.uiEnv]) {
    assert.equal(env.VRA_REMOTE, undefined);
    assert.equal(env.VRA_PUBLIC_URL, undefined);
    assert.equal(env.PATH, "/usr/bin");
  }
  const source = fs.readFileSync(path.join(REPO, "orchestrator/src/startup.ts"), "utf8");
  assert.match(source, /const \{ apiEnv, uiEnv \} = startupChildEnvs\(env, access, args\.publicUrl\)/);
  assert.match(source, /const api = spawn\([^)]*\{\s*cwd: repoRoot, env: apiEnv, detached/, "API 用剥掉口令的 apiEnv");
  assert.match(source, /\[viteBin, "preview"\], \{ cwd: desktopDir, env: uiEnv/);
  assert.match(source, /"npm", \["run", "dev", "--prefix", "desktop"\], \{ cwd: repoRoot, env: uiEnv/);
  assert.match(source, /\[viteBin, "build"\][\s\S]*\[viteBin, "preview"\]/, "远程模式必须先 build 再 preview，不暴露开发服务器");
  assert.match(source, /if \(access && !args\.prebuilt\) \{\s*console\.log\("\[start\] 远程访问模式：先打包页面/, "打包好的页面不再重新打包");
  assert.match(source, /const ui = access \|\| args\.prebuilt\s*\? spawn\(process\.execPath, \[viteBin, "preview"\]/, "打包好的页面本机模式也走 preview");
});

test("打包好的页面（免安装包）：Windows 启动器先查 desktop\\dist 再起 vite preview，工作目录是 desktop；不带 -Prebuilt 照旧走开发服务器", () => {
  const ps = fs.readFileSync(path.join(REPO, "scripts/start.ps1"), "utf8");
  assert.match(ps, /^\ufeff(?:#[^\n]*\n)*param\(\[switch\]\$Prebuilt, \[switch\]\$NoOpen\)\n/, "param 必须是第一条语句(前面只能有注释)");
  const check = ps.indexOf('Test-Path (Join-Path $root "desktop\\dist\\index.html")');
  const preview = ps.indexOf('$ui = Start-Process -FilePath node -ArgumentList @("node_modules\\vite\\bin\\vite.js", "preview") -WorkingDirectory (Join-Path $root "desktop")');
  const dev = ps.indexOf('$ui = Start-Process -FilePath npm.cmd -ArgumentList @("run", "dev", "--prefix", "desktop")');
  assert.ok(check > 0 && preview > check && dev > preview, `${check} ${preview} ${dev}`);
  assert.ok(check < ps.indexOf("$api = Start-Process"), "缺页面时连 API 都不起");
});

test("换访问链接时旧服务还在跑:说清楚要先 Ctrl+C 停掉它,否则旧链接根本没失效", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const busy = (server.address() as net.AddressInfo).port;
  try {
    await assert.rejects(assertStartupPorts({ remote: true, rotateAccess: true }, { api: busy, ui: 0 }),
      (e: unknown) => e instanceof Error && /已被占用/.test(e.message) && /Ctrl\+C/.test(e.message) && /--rotate-access/.test(e.message));
    await assert.rejects(assertStartupPorts({ remote: true, rotateAccess: false }, { api: busy, ui: 0 }),
      (e: unknown) => e instanceof Error && /已被占用/.test(e.message) && !/rotate-access/.test(e.message));
    await assertStartupPorts({ remote: true, rotateAccess: true }, { api: 0, ui: 0 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("启动预检同时覆盖两端依赖与实际数据根", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-startup-"));
  const dataRoot = path.join(root, "private-data");
  fs.writeFileSync(path.join(root, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: ".local" } }));
  assert.deepEqual(startupMissingFiles(root, { VRA_DATA_ROOT: dataRoot }), [
    "orchestrator 依赖", "界面依赖", "产品初始化配置",
  ]);

  for (const file of [
    path.join(root, "orchestrator/node_modules/@modelcontextprotocol/sdk/package.json"),
    path.join(root, "desktop/node_modules/vite/package.json"),
    path.join(dataRoot, "config.json"),
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
  }
  assert.deepEqual(startupMissingFiles(root, { VRA_DATA_ROOT: dataRoot }), []);
  assert.deepEqual(startupMissingFiles(root, { VRA_DATA_ROOT: dataRoot }, true), ["打包好的页面（desktop/dist）"], "用打包好的页面时还要有 dist");
  fs.mkdirSync(path.join(root, "desktop/dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "desktop/dist/index.html"), "<div id=root></div>");
  assert.deepEqual(startupMissingFiles(root, { VRA_DATA_ROOT: dataRoot }, true), []);
});

test("端口预检会拒绝已经被占用的固定端口", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(assertPortAvailable(address.port), /已被占用/);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("就绪检查会重试暂时失败的探针", async () => {
  let attempts = 0;
  let clock = 0;
  await waitUntilReady({
    probe: async () => ++attempts === 3,
    timeoutMs: 100,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(attempts, 3);
});

test("就绪检查会在子进程提前失败或超时时停止", async () => {
  await assert.rejects(waitUntilReady({ probe: async () => false, failure: () => "界面已退出" }), /界面已退出/);

  let clock = 0;
  await assert.rejects(waitUntilReady({
    probe: async () => false,
    timeoutMs: 20,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  }), /超过 1 秒/);
});

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    pid: 12345,
  }) as unknown as ChildProcess;
}

test("远程模式启动提示:链接拼对;首次 / 沿用 / 换新 / 环境变量四种说法各不相同,首次不谎称「旧链接已失效」", () => {
  const token = "t".repeat(43);
  const text = (source: "env" | "file" | "new", publicUrl: string | null, rotated: boolean) =>
    remoteLinkLines({ token, source }, publicUrl, rotated).join("\n");

  const first = text("new", "https://abc.example.app", false);
  assert.match(first, new RegExp(`本机打开：http://127\\.0\\.0\\.1:5930/\\?access=${token}`));
  assert.match(first, new RegExp(`发给使用者的链接：https://abc\\.example\\.app/\\?access=${token}`));
  assert.match(first, /新生成的访问链接，之后重启沿用同一条/);
  assert.doesNotMatch(first, /旧链接已经失效|明文/);
  assert.match(text("new", null, true), /已换成新的访问链接；之前发出去的旧链接已经失效/);
  assert.match(text("file", null, false), /沿用上次的访问链接/);
  assert.match(text("env", null, false), /来自环境变量 VRA_ACCESS_TOKEN/);
  // 没给公网地址:告诉部署者怎么拼,且只认 https 那个
  assert.match(text("file", null, false), new RegExp(`公网地址（只用 https 的那个）接上 /\\?access=${token}`));
  // 明文 http 公网地址要警告;本机地址不警告
  assert.match(text("file", "http://1.2.3.4:5930", false), /明文 http/);
  assert.doesNotMatch(text("file", "http://127.0.0.1:5930", false), /明文 http/);
  // 换链接要先停服务;没给 --public-url 时建议补上(cookie 的 Secure 才判断得准)
  assert.match(text("file", null, false), /先在这里按 Ctrl\+C 停掉服务，再运行 scripts\/start --remote --rotate-access/);
  assert.match(text("file", null, false), /--public-url/);
  assert.doesNotMatch(text("file", "https://abc.example.app", false), /提示：启动时加 --public-url/);
});

test("启动健康检查前即可响应 Ctrl+C、终止与关闭终端信号", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const api = fakeChild();
    const ui = fakeChild();
    const signals = new EventEmitter();
    const monitor = createShutdownMonitor(api, ui, signals as unknown as NodeJS.Process);

    assert.equal(signals.listenerCount(signal), 1);
    signals.emit(signal);
    assert.deepEqual(await monitor.wait, { kind: "signal", signal });
    monitor.dispose();
    assert.equal(signals.listenerCount(signal), 0);
    assert.equal(api.listenerCount("exit"), 0);
    assert.equal(ui.listenerCount("exit"), 0);
  }
});

test("任一子进程退出会要求同步关闭另一进程", async () => {
  const api = fakeChild();
  const ui = fakeChild();
  const signals = new EventEmitter();
  const monitor = createShutdownMonitor(api, ui, signals as unknown as NodeJS.Process);

  api.emit("exit", 7, null);
  assert.deepEqual(await monitor.wait, {
    kind: "child_exit",
    message: "本机 API已停止（退出码 7），另一进程将同步关闭。",
  });
  monitor.dispose();
});
