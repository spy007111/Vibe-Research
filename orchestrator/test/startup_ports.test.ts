import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  chooseStartupPorts, fallbackPorts, isDirectRun, parsePortValue, portRequestFrom, probePort, takePortArgs, type PortState,
} from "../src/startup_ports.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const local = { ui: null, api: null, uiHost: "127.0.0.1", strictUi: false };
const SWITCH_HINT = "注意：接入 AI 里的模型 API 设置和对话记录存在浏览器里、按地址分开，在新地址要重新设置；5930 空出来后重启，就回到原来的地址和设置。";
const states = (map: Record<number, PortState>) => async (port: number) => map[port] ?? "free";
const notRunning = async () => null;

async function listen(server: net.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}
const close = (server: net.Server) => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));

test("端口值:1–65535 的整数;空 = 没指定;其它报清楚是哪个参数", () => {
  assert.equal(parsePortValue(undefined, "--port"), null);
  assert.equal(parsePortValue("  ", "--port"), null);
  assert.equal(parsePortValue(" 6930 ", "--port"), 6930);
  assert.equal(parsePortValue("65535", "--port"), 65535);
  for (const bad of ["0", "65536", "-1", "6930.5", "1e3", "0x10", "abc", "123456"]) {
    assert.throws(() => parsePortValue(bad, "VRA_UI_PORT"), /VRA_UI_PORT 要填 1–65535/, bad);
  }
});

test("命令行 --port / --api-port 取出来当场校验,其它参数原样留下;命令行优先于环境变量", () => {
  assert.deepEqual(takePortArgs(["--no-open", "--port", "6000", "--api-port=6001"]), { ui: 6000, api: 6001, rest: ["--no-open"] });
  assert.deepEqual(takePortArgs(["--portable", "--api-portx"]), { ui: null, api: null, rest: ["--portable", "--api-portx"] }, "前缀相同的别的参数不算");
  assert.throws(() => takePortArgs(["--api-port"]), /--api-port 后面要跟端口号/);
  const req = portRequestFrom({ ui: null, api: 7001 }, { VRA_UI_PORT: "7000", VRA_API_PORT: "9999" }, { remote: false, rotateAccess: false });
  assert.deepEqual(req, { ui: 7000, api: 7001, uiHost: "127.0.0.1", strictUi: false, strictApi: false });
  assert.throws(() => portRequestFrom({ ui: null, api: null }, { VRA_API_PORT: "x" }, { remote: false, rotateAccess: false }), /VRA_API_PORT/);
  assert.deepEqual(portRequestFrom({ ui: null, api: null }, { VRA_LAN: "1" }, { remote: false, rotateAccess: false }),
    { ui: null, api: null, uiHost: "0.0.0.0", strictUi: false, strictApi: false }, "局域网模式页面听所有网卡,探测也要按它");
  assert.deepEqual(portRequestFrom({ ui: null, api: null }, {}, { remote: true, rotateAccess: false }),
    { ui: null, api: null, uiHost: "0.0.0.0", strictUi: true, strictApi: false });
  assert.deepEqual(portRequestFrom({ ui: null, api: null }, {}, { remote: true, rotateAccess: true }),
    { ui: null, api: null, uiHost: "0.0.0.0", strictUi: true, strictApi: true }, "换访问链接时两个端口都不许换");
});

test("默认端口能用就用默认,不多说话", async () => {
  assert.deepEqual(await chooseStartupPorts(local, { probe: states({}), alreadyRunning: notRunning }), { ui: 5930, api: 8765, notes: [] });
});

test("默认端口被占用或被系统保留(Windows 常见):往后找空闲的,并说清楚换成了哪个", async () => {
  const r = await chooseStartupPorts(local, {
    probe: states({ 5930: "reserved", 5931: "busy", 8765: "busy" }), alreadyRunning: notRunning,
  });
  assert.equal(r.ui, 5932);
  assert.equal(r.api, 8766);
  assert.deepEqual(r.notes, [
    "本机 API 默认端口 8765 已被占用，这次改用 8766。",
    `页面默认端口 5930 被系统保留、不能使用，这次改用 5932。${SWITCH_HINT}`,
  ], "页面换了地址要提醒:浏览器里存的模型 API 设置和对话记录按地址分开");
});

test("备选端口顺序固定:紧挨着的 20 个,再是 +1 万 / +2 万…各 20 个,不进 49152 以上", () => {
  const ui = fallbackPorts(5930);
  assert.deepEqual(ui.slice(0, 20), Array.from({ length: 20 }, (_, i) => 5931 + i));
  assert.deepEqual([ui[20], ui[39], ui[40], ui[60], ui[80], ui.at(-1)], [15930, 15949, 25930, 35930, 45930, 45949]);
  assert.equal(ui.length, 100);
  assert.ok(fallbackPorts(30000).every((p) => p <= 49151), "系统临时端口段不用");
  assert.equal(fallbackPorts(30000).at(-1), 40019);
});

test("紧挨着的 20 个都不能用(Hyper-V 整段保留):换到远处固定的那段,每次启动是同一个地址", async () => {
  const blocked: Record<number, PortState> = {};
  for (let p = 5930; p <= 5950; p++) blocked[p] = "reserved";
  let assigned = 0;
  const assign = async () => { assigned += 1; return 41000; };
  const first = await chooseStartupPorts(local, { probe: states(blocked), assign, alreadyRunning: notRunning });
  const second = await chooseStartupPorts(local, { probe: states(blocked), assign, alreadyRunning: notRunning });
  assert.deepEqual([first.ui, second.ui], [15930, 15930]);
  assert.equal(assigned, 0, "固定的备选端口能用就不让系统随机分配");
  assert.equal(first.notes.at(-1), `页面默认端口 5930 被系统保留、不能使用，这次改用 15930。${SWITCH_HINT}`);
});

test("固定的备选端口全不行才让系统分配;分到的和另一个端口撞了就再要一个,并说明每次可能不同", async () => {
  const busy: Record<number, PortState> = { 5930: "reserved" };
  for (const p of fallbackPorts(5930)) busy[p] = "reserved";
  const assigned = [8765, 41000];
  const r = await chooseStartupPorts(local, { probe: states(busy), assign: async () => assigned.shift()!, alreadyRunning: notRunning });
  assert.equal(r.ui, 41000, "8765 已经给了 API,不能再给页面");
  assert.match(r.notes.join(""), /常用的备选端口也都不能用，这次改用 41000（每次启动可能不同）/);
});

test("页面听所有网卡(局域网模式)时回环地址也要空着:别的程序只占着 127.0.0.1 也算被占", async () => {
  const seen: string[] = [];
  const probe = async (port: number, host: string): Promise<PortState> => {
    seen.push(`${host}:${port}`);
    return port === 5930 && host === "127.0.0.1" ? "busy" : "free";
  };
  const r = await chooseStartupPorts({ ...local, uiHost: "0.0.0.0" }, { probe, alreadyRunning: notRunning });
  assert.equal(r.ui, 5931);
  assert.deepEqual(seen.filter((x) => x.endsWith(":5930")), ["0.0.0.0:5930", "127.0.0.1:5930"]);
  assert.ok(seen.includes("127.0.0.1:5931"), "换到的端口回环也要查");
  // 指定端口同样两边都查
  await assert.rejects(chooseStartupPorts({ ...local, uiHost: "0.0.0.0", ui: 5930 }, { probe, alreadyRunning: notRunning }), /你指定的页面端口 5930 已被占用/);
  // 本机模式只查 127.0.0.1
  seen.length = 0;
  await chooseStartupPorts(local, { probe: async (port, host) => { seen.push(`${host}:${port}`); return "free"; }, alreadyRunning: notRunning });
  assert.ok(seen.every((x) => x.startsWith("127.0.0.1:")));
});

test("用户自己指定的端口不能用:直接报错,不擅自换", async () => {
  await assert.rejects(chooseStartupPorts({ ...local, ui: 6000 }, { probe: states({ 6000: "busy" }), alreadyRunning: notRunning }),
    /你指定的页面端口 6000 已被占用/);
  await assert.rejects(chooseStartupPorts({ ...local, api: 9000 }, { probe: states({ 9000: "reserved" }), alreadyRunning: notRunning }),
    /你指定的本机 API 端口 9000 被系统保留/);
  await assert.rejects(chooseStartupPorts({ ...local, ui: 7000, api: 7000 }, { probe: states({}) }), /不能相同/);
  // 只指定了页面端口、恰好是 API 的默认端口:API 让开,说明里讲清楚是给页面用了(不是「被占用」)
  const r = await chooseStartupPorts({ ...local, ui: 8765 }, { probe: states({}), alreadyRunning: notRunning });
  assert.deepEqual([r.ui, r.api], [8765, 8766]);
  assert.deepEqual(r.notes, ["本机 API 默认端口 8765 已经给页面用了，这次改用 8766。"]);
});

test("换访问链接(strictApi):API 端口被占也直接报错,不换——旧服务还在跑", async () => {
  await assert.rejects(chooseStartupPorts({ ...local, strictUi: true, strictApi: true }, { probe: states({ 8765: "busy" }), alreadyRunning: notRunning }),
    /本机 API 端口 8765 已被占用/);
  const r = await chooseStartupPorts({ ...local, strictApi: false }, { probe: states({ 8765: "busy" }), alreadyRunning: notRunning });
  assert.equal(r.api, 8766);
});

test("默认页面端口上已经开着一个本产品:提示直接打开它,不起第二个;远程模式不探(要口令)", async () => {
  let asked = 0;
  const running = async (port: number) => { asked += 1; return `http://127.0.0.1:${port} 上已经有一个 Vibe Research 在运行`; };
  await assert.rejects(chooseStartupPorts(local, { probe: states({ 5930: "busy", 8765: "busy" }), alreadyRunning: running }),
    /5930 上已经有一个 Vibe Research 在运行/);
  assert.equal(asked, 1);
  // 被系统保留不可能是本产品,不用探
  await chooseStartupPorts(local, { probe: states({ 5930: "reserved" }), alreadyRunning: running });
  assert.equal(asked, 1);
  await assert.rejects(chooseStartupPorts({ ...local, strictUi: true, uiHost: "0.0.0.0" }, { probe: states({ 5930: "busy" }), alreadyRunning: running }),
    /远程访问模式不自动换端口/);
  assert.equal(asked, 1);
});

test("上次换过端口的本产品还开着(在紧挨着的那段上):同样认出来,不起第二个;远处的段不探", async () => {
  const asked: number[] = [];
  const at5932 = async (port: number) => { asked.push(port); return port === 5932 ? `http://127.0.0.1:${port} 上已经有一个 Vibe Research 在运行` : null; };
  await assert.rejects(chooseStartupPorts(local, { probe: states({ 5930: "busy", 5931: "busy", 5932: "busy" }), alreadyRunning: at5932 }),
    /5932 上已经有一个 Vibe Research 在运行/);
  assert.deepEqual(asked, [5930, 5931, 5932]);
  // 远处那段被占的端口不当成本产品去探(太多、也不会是上次换到的近处端口)
  asked.length = 0;
  const blocked: Record<number, PortState> = { 15930: "busy" };
  for (let p = 5930; p <= 5950; p++) blocked[p] = "reserved";
  const r = await chooseStartupPorts(local, { probe: states(blocked), alreadyRunning: at5932 });
  assert.equal(r.ui, 15931);
  assert.deepEqual(asked, []);
});

test("真实端口探测:空闲 / 被占用分得清", async () => {
  const server = net.createServer();
  const port = await listen(server);
  try {
    assert.equal(await probePort(port, "127.0.0.1"), "busy");
  } finally { await close(server); }
  assert.equal(await probePort(port, "127.0.0.1"), "free");
});

test("真实场景:默认端口被别的程序占着,换一个;是本产品在跑就提示直接打开", async () => {
  // 默认值是常量,不去抢真实的 5930:把「5930」的探测转到一个真被占着的端口上
  const other = net.createServer();
  const port = await listen(other);
  try {
    const r = await chooseStartupPorts(local, {
      probe: async (p, host) => p === 5930 ? await probePort(port, host) : "free", alreadyRunning: notRunning,
    });
    assert.equal(r.ui, 5931, "端口被不认识的程序占着就换");
  } finally { await close(other); }
  // 一个长得像本产品的页面:首页有 root、/api/health 报版本
  const fake = http.createServer((req, res) => {
    if (req.url === "/api/health") { res.setHeader("content-type", "application/json"); res.end('{"ok":true,"version":"9.9.9"}'); return; }
    res.setHeader("content-type", "text/html"); res.end('<div id="root"></div>');
  });
  const fakePort = await listen(fake);
  try {
    const { productAlreadyRunning } = await import("../src/startup_ports.ts");
    assert.match(String(await productAlreadyRunning(fakePort)), new RegExp(`http://127\\.0\\.0\\.1:${fakePort} 上已经有一个 Vibe Research 在运行`));
    const plain = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
    const plainPort = await listen(plain);
    try { assert.equal(await productAlreadyRunning(plainPort), null, "别的程序不算"); } finally {
      plain.closeAllConnections();
      await close(plain);
    }
  } finally {
    fake.closeAllConnections();
    await close(fake);
  }
});

test("命令行入口(Windows 启动器用):全写 stdout,最后一行是 JSON;参数不对退出码 2、只有 [start] 说明行", () => {
  const cli = path.join(REPO, "orchestrator", "src", "startup_ports.ts");
  const env = { ...process.env };
  delete env.VRA_UI_PORT; delete env.VRA_API_PORT; delete env.VRA_LAN;
  // Windows PowerShell 5.1 会把子程序 stderr 当错误(配合 $ErrorActionPreference=Stop 直接中断),所以说明也写 stdout
  const bad = spawnSync(process.execPath, [cli, "--port", "abc"], { encoding: "utf8", env });
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /^\[start\] --port 要填 1–65535/m);
  assert.ok(bad.stdout.trim().split(/\r?\n/).every((line) => line.startsWith("[start] ")), "失败时没有 JSON 行");
  assert.doesNotMatch(bad.stderr, /要填/);
  const unknown = spawnSync(process.execPath, [cli, "--no-open"], { encoding: "utf8", env });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stdout, /\[start\] 未知参数/);
  // 拿一个系统分配的空闲端口来指定,结果必须原样返回
  const reserve = spawnSync(process.execPath, ["-e", "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: "utf8" });
  const free = Number(reserve.stdout.trim());
  const ok = spawnSync(process.execPath, [cli, "--port", String(free), "--api-port", String(free === 65535 ? free - 1 : free + 1)], { encoding: "utf8", env });
  if (ok.status === 0) {
    const last = ok.stdout.trim().split(/\r?\n/).at(-1)!;
    assert.equal(JSON.parse(last).ui, free);
  } else {
    // 极少数情况下端口刚好被别的进程抢走:那也必须是「你指定的端口已被占用」,不能是别的错
    assert.match(ok.stdout, /你指定的/);
  }
});

test("命令行入口按真实路径认:经符号链接 / 目录联接运行也要输出结果(否则启动器拿不到端口)", () => {
  const here = fileURLToPath(import.meta.url);
  assert.equal(isDirectRun(undefined, import.meta.url), false);
  assert.equal(isDirectRun(here, import.meta.url), true);
  assert.equal(isDirectRun(path.join(path.dirname(here), "..", "test", path.basename(here)), import.meta.url), true, "写法不同、文件相同");
  assert.equal(isDirectRun(path.join(REPO, "orchestrator", "src", "startup_ports.ts"), import.meta.url), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-ports-link-"));
  try {
    const link = path.join(dir, "src");
    fs.symlinkSync(path.join(REPO, "orchestrator", "src"), link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(isDirectRun(path.join(link, "startup_ports.ts"), pathToFileURL(path.join(REPO, "orchestrator", "src", "startup_ports.ts")).href), true);
    const env = { ...process.env };
    delete env.VRA_UI_PORT; delete env.VRA_API_PORT; delete env.VRA_LAN;
    const run = spawnSync(process.execPath, [path.join(link, "startup_ports.ts"), "--port", "abc"], { encoding: "utf8", env });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stdout, /\[start\] --port 要填/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Windows 启动器:先选端口再起两个进程,API、页面、就绪检查、打开的地址都用选好的端口", () => {
  const ps = fs.readFileSync(path.join(REPO, "scripts", "start.ps1"), "utf8");
  const choose = ps.indexOf('& node (Join-Path $root "orchestrator\\src\\startup_ports.ts") @portArgs');
  assert.ok(choose > 0 && choose < ps.indexOf("$api = Start-Process"), "先选端口");
  // 说明行照打;退出码非 0 就停;最后一行不是 JSON(没输出)要报清楚,不能拿空值当端口
  assert.match(ps, /\$chosen = @\(& node \(Join-Path \$root "orchestrator\\src\\startup_ports\.ts"\) @portArgs\)\n\$portCode = \$LASTEXITCODE\n\$chosen \| Where-Object \{ "\$_"\.StartsWith\("\[start\]"\) \} \| ForEach-Object \{ Write-Host \$_ \}\nif \(\$portCode -ne 0\) \{ exit \$portCode \}/);
  assert.match(ps, /if \(-not \$last\.StartsWith\("\{"\)\) \{ throw "没拿到端口选择结果/);
  assert.match(ps, /\$ports = \$last \| ConvertFrom-Json/);
  assert.match(ps, /\$env:VRA_UI_PORT = "\$uiPortChosen"/);
  assert.match(ps, /\$env:VRA_API_PORT = "\$apiPortChosen"/);
  // 退出时还原:在自己的 PowerShell 窗口里直接跑,不能把这次的端口留下(下次会被当成「指定了端口」,不能用就报错)
  const fin = ps.slice(ps.lastIndexOf("} finally {"));
  assert.ok(ps.indexOf("$prevUiPort = $env:VRA_UI_PORT") < ps.indexOf('$env:VRA_UI_PORT = "$uiPortChosen"'), "先记下原值");
  assert.match(fin, /if \(\$null -eq \$prevUiPort\) \{ Remove-Item Env:VRA_UI_PORT -ErrorAction SilentlyContinue \} else \{ \$env:VRA_UI_PORT = \$prevUiPort \}/);
  assert.match(fin, /if \(\$null -eq \$prevApiPort\) \{ Remove-Item Env:VRA_API_PORT -ErrorAction SilentlyContinue \} else \{ \$env:VRA_API_PORT = \$prevApiPort \}/);
  assert.match(ps, /"orchestrator\\src\\api\.ts", "--port", "\$apiPortChosen", "--host", "127\.0\.0\.1"/);
  assert.match(ps, /if \(-not \$NoOpen\) \{ Start-Process \$uiUrl \}/);
  assert.doesNotMatch(ps.slice(ps.indexOf("try {")), /5930|8765/, "启动流程里不再写死端口");
  const portable = fs.readFileSync(path.join(REPO, "scripts", "portable", "start-portable.ps1"), "utf8");
  assert.match(portable, /start\.ps1"\) -Prebuilt -NoOpen:\$NoOpen -Port \$Port -ApiPort \$ApiPort/);
});
