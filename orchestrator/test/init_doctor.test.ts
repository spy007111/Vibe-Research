import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONSTITUTION_REL } from "../src/config.ts";
import { cmpVersion, minimalEnv, runDoctor, scanSecrets, type Exec } from "../src/doctor.ts";
import { assertDataRootInside, detectPython, gitignoreCovers, initOptionsFromArgs, runInit } from "../src/init.ts";
import { parseArgs } from "../src/run.ts";
import { startupMissingFiles } from "../src/startup.ts";
import { executableCandidates, loadSavedAgentPaths, type LocalAgentStatus } from "../src/local_agent_runtime.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 子进程环境里的 HOME 用空的假目录:测试不依赖开发者机器上的任何用户级配置 */
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vra-fake-home-"));

function tmpRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-init-"));
  fs.mkdirSync(path.join(repo, "methodology"), { recursive: true });
  fs.writeFileSync(path.join(repo, CONSTITUTION_REL), "# c\n");
  fs.writeFileSync(path.join(repo, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: ".local" } }));
  return repo;
}

function tmpDoctorRepo(): string {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, ".vibe-research-root"), "");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".local/\n");
  fs.mkdirSync(path.join(repo, "datasources"), { recursive: true });
  for (const file of ["registry.json", "CATALOG.md"]) {
    fs.copyFileSync(path.join(REPO, "datasources", file), path.join(repo, "datasources", file));
  }
  // 自带一份最小的模型 API 模板:体检测的是"后台默认来源"的判定,不随仓库模板内容变化
  fs.mkdirSync(path.join(repo, "providers"), { recursive: true });
  fs.writeFileSync(path.join(repo, "providers", "fixture-api.json"), JSON.stringify({ id: "fixture-api", name: "fixture", base_url: "https://example.invalid/v1", env_key: "VRA_TEST_DOCTOR_KEY", default_model: "fixture" }));
  for (const skill of ["data-access", "company-research"]) {
    const target = path.join(repo, ".agents", "skills", skill);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(REPO, ".agents", "skills", skill, "SKILL.md"), path.join(target, "SKILL.md"));
  }
  return repo;
}

const AGENT_NAMES = { "cli-claude": "Claude Code", "cli-codex": "Codex", "cli-codebuddy": "WorkBuddy / CodeBuddy" } as const;
function agent(provider: LocalAgentStatus["provider"], status: LocalAgentStatus["status"]): LocalAgentStatus {
  const ready = status === "ready";
  return { provider, name: AGENT_NAMES[provider], installed: status !== "not_installed", authenticated: ready, available: ready,
    version: ready ? "9.9.9" : null, status, detail: ready ? "已登录" : status === "not_installed" ? `本机未检测到 ${AGENT_NAMES[provider]}` : "未登录" };
}
/** 假的本机订阅 Agent 探测:测的是体检怎么判,不去问开发者机器上真装了哪些 CLI */
const probes = (claude: LocalAgentStatus["status"], codex: LocalAgentStatus["status"] = "not_installed", codebuddy: LocalAgentStatus["status"] = "not_installed") =>
  async () => [agent("cli-claude", claude), agent("cli-codex", codex), agent("cli-codebuddy", codebuddy)];

test("init:幂等建 .local 目录 + 配置骨架 + .gitignore;已有配置不改;--force 先备份;不替用户选默认 AI 来源;不碰产品根之外", async () => {
  const repo = tmpRepo();
  const r1 = runInit({ repoRoot: repo });
  assert.equal(r1.dataRoot, path.join(repo, ".local"));
  for (const sub of ["runs", "knowledge", "providers", "mcp"]) assert.ok(fs.existsSync(path.join(repo, ".local", sub)), sub);
  assert.ok(!fs.existsSync(path.join(repo, ".local", "codex-home")), "v2 不再建产品专用的 Codex 登录目录");
  assert.ok(r1.steps.filter((s) => s.id.startsWith("dir:")).every((s) => s.action === "created"));
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8"));
  assert.equal(cfg.python, null);
  assert.deepEqual(cfg.provider, { profile: null }, "没给 --provider 就不替用户挑大脑:研究 / 对话会明确报「还没选 AI 来源」");
  assert.deepEqual(cfg.defaults, { model: null });
  assert.ok(fs.readFileSync(path.join(repo, ".gitignore"), "utf8").split("\n").includes(".local/"));
  assert.ok(r1.next.some((n) => n.includes("scripts/start")) && r1.next.some((n) => n.includes("接入 AI")));
  assert.ok(r1.next.every((n) => !n.includes("codex login") && !n.includes("~/.codex")));
  // 第二次:全部 exists / kept,文件不变
  const before = fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8");
  const r2 = runInit({ repoRoot: repo });
  assert.ok(r2.steps.filter((s) => s.id.startsWith("dir:")).every((s) => s.action === "exists"));
  assert.equal(r2.steps.find((s) => s.id === "config")?.action, "kept");
  assert.equal(r2.steps.find((s) => s.id === "gitignore")?.action, "exists");
  assert.equal(fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8"), before);
  assert.doesNotMatch(r2.steps.find((s) => s.id === "config")?.detail ?? "", /未生效/, "没给 --provider 就不提");
  // 已有配置时 --provider 不生效,要明说(不然部署的 Agent 会以为后台默认已经改好了)
  const kept = runInit({ repoRoot: repo, provider: "deepseek" }).steps.find((s) => s.id === "config");
  assert.equal(kept?.action, "kept");
  assert.match(kept?.detail ?? "", /--provider deepseek 未生效/);
  assert.equal(fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8"), before);
  // --force:备份后重写;provider=deepseek → api_key;python 显式
  const r3 = runInit({ repoRoot: repo, force: true, provider: "deepseek", python: "/x/python" });
  assert.equal(r3.steps.find((s) => s.id === "config:backup")?.action, "backed_up");
  assert.ok(fs.readdirSync(path.join(repo, ".local")).some((f) => f.startsWith("config.json.bak-")));
  const cfg3 = JSON.parse(fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8"));
  assert.equal(cfg3.python, "/x/python"); assert.deepEqual(cfg3.provider, { profile: "deepseek" });
  assert.throws(() => runInit({ repoRoot: repo, provider: "../evil" }), /非法 provider id/);
  assert.throws(() => runInit({ repoRoot: repo, provider: "openai" }), /cli-codex[\s\S]*openai-api/, "v1 的默认值 openai 已停用,不能再写进骨架");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, ".local", "config.json"), "utf8")).provider, { profile: "deepseek" }, "报错前不碰已有配置");
  // python 自动探测 .venv
  const pyRel = process.platform === "win32" ? path.join(".venv", "Scripts", "python.exe") : path.join(".venv", "bin", "python");
  fs.mkdirSync(path.dirname(path.join(repo, pyRel)), { recursive: true }); fs.writeFileSync(path.join(repo, pyRel), "");
  assert.equal(detectPython(repo), path.join(repo, pyRel));
  assert.equal(detectPython(repo, "/explicit"), "/explicit");
  // 数据根逃出产品根 → 拒绝(词法 / 符号链接 / realpath 三种)
  const repo2 = tmpRepo(); fs.writeFileSync(path.join(repo2, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: "../outside" } }));
  assert.throws(() => runInit({ repoRoot: repo2 }), /不在产品根/);
  const repo3 = tmpRepo(); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-out-")); fs.symlinkSync(outside, path.join(repo3, ".local"));
  assert.throws(() => runInit({ repoRoot: repo3 }), /符号链接|产品根之外/);
  assert.ok(!fs.existsSync(path.join(outside, "config.json")), "不得写到符号链接指向的仓库外目录");
  const repo4 = tmpRepo(); fs.mkdirSync(path.join(repo4, "data")); fs.symlinkSync(outside, path.join(repo4, "data", "link"));
  fs.writeFileSync(path.join(repo4, "vibe-research.config.json"), JSON.stringify({ paths: { data_root: "data/link/.local" } }));
  assert.throws(() => assertDataRootInside(repo4, path.join(repo4, "data", "link", ".local")), /产品根之外/, "祖先是符号链接也拒绝");
  // 悬空符号链接:.gitignore → 拒绝且不在仓库外创建文件;.local → 拒绝;子目录是(悬空)符号链接 → 拒绝
  const repo6 = tmpRepo(); const dangling = path.join(os.tmpdir(), `vra-dangling-${process.pid}`, "nope");
  fs.symlinkSync(dangling, path.join(repo6, ".gitignore"));
  assert.throws(() => runInit({ repoRoot: repo6 }), /符号链接/); assert.ok(!fs.existsSync(dangling));
  const repo7 = tmpRepo(); fs.symlinkSync(dangling, path.join(repo7, ".local"));
  assert.throws(() => runInit({ repoRoot: repo7 }), /符号链接/); assert.ok(!fs.existsSync(dangling));
  const repo8 = tmpRepo(); fs.mkdirSync(path.join(repo8, ".local")); fs.symlinkSync(dangling, path.join(repo8, ".local", "runs"));
  assert.throws(() => runInit({ repoRoot: repo8 }), /不是目录/); assert.ok(!fs.existsSync(dangling));
  // --force 同秒两次:备份不覆盖
  const repo5 = tmpRepo(); runInit({ repoRoot: repo5 }); runInit({ repoRoot: repo5, force: true }); runInit({ repoRoot: repo5, force: true });
  assert.equal(fs.readdirSync(path.join(repo5, ".local")).filter((f) => f.startsWith("config.json.bak-")).length, 2);
  // .gitignore 等价规则识别
  for (const t of [".local/", "/.local/", ".local", "/.local", ".local/**", "# x\r\n/.local/**\r\n"]) assert.ok(gitignoreCovers(t, ".local/"), t);
  assert.ok(!gitignoreCovers(".local2/\n.locale/", ".local/"));
});

test("init 认 VRA_DATA_ROOT,和启动器找配置的地方是同一个(第四轮审计 A4)", () => {
  const repo = tmpRepo();
  const env = { VRA_DATA_ROOT: "user-data" };
  const r = runInit({ repoRoot: repo, env });
  assert.equal(r.dataRoot, path.join(repo, "user-data"));
  assert.ok(fs.existsSync(path.join(repo, "user-data", "config.json")));
  assert.ok(!fs.existsSync(path.join(repo, ".local")), "不该再写进默认的 .local");
  assert.ok(!startupMissingFiles(repo, env).some((m) => m.includes("产品初始化配置")), "启动器应能找到 init 写的配置");
  assert.match(fs.readFileSync(path.join(repo, ".gitignore"), "utf8"), /^user-data\/$/m);
  // 仓库外的数据根仍按原规则拒绝(init 只管仓库内布局)
  assert.throws(() => runInit({ repoRoot: tmpRepo(), env: { VRA_DATA_ROOT: path.join(os.tmpdir(), "elsewhere") } }), /不在产品根/);
});

test("doctor:版本比较;密钥扫描命中 sk-… / Bearer / 环境密钥值,跳过 .local 与测试目录", async () => {
  assert.equal(cmpVersion([0, 149, 0], [0, 149, 0]), 0); assert.equal(cmpVersion([0, 150, 0], [0, 149, 9]), 1); assert.equal(cmpVersion([22, 18], [22, 18, 0]), 0); assert.equal(cmpVersion([22, 6], [22, 18]), -1);
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, "src")); fs.mkdirSync(path.join(repo, "test")); fs.mkdirSync(path.join(repo, ".local"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), 'const k = "sk-" + "ABCDEFGHIJKLMNOPQRSTUVWX0123";\nconst h = "Bearer abcdefghijklmnopqrstuvwxyz";\nconst v = "SUPERSECRETVALUE1234567890";\n');
  fs.writeFileSync(path.join(repo, "test", "t.ts"), '"sk-ABCDEFGHIJKLMNOPQRSTUVWX0123"');
  fs.writeFileSync(path.join(repo, ".local", "x.json"), '"sk-ABCDEFGHIJKLMNOPQRSTUVWX0123"');
  // 第一行被 "sk-" + 拼接打散,不应命中;第二行 Bearer 命中;第三行经环境变量值命中;测试目录里的 sk- 与 .local 不命中
  const r1 = scanSecrets(repo, { MY_API_KEY: "SUPERSECRETVALUE1234567890", SHORT_KEY: "abc" });
  assert.deepEqual(r1.hits.map((h) => `${h.file}:${h.line}:${h.what}`).sort(), ["src/a.ts:2:Bearer token", "src/a.ts:3:环境变量 MY_API_KEY 的值"]);
  assert.equal(r1.truncated, false); assert.ok(r1.scanned >= 3);
  fs.writeFileSync(path.join(repo, "src", "b.md"), "token sk-ABCDEFGHIJKLMNOPQRSTUVWX0123 here\n");
  assert.ok(scanSecrets(repo, {}).hits.some((h) => h.file === "src/b.md" && h.what.startsWith("sk-")));
  // 高置信形态在测试目录也命中:PEM / AWS / GitHub / JWT;字面赋值形态在源码命中
  // 夹具用拼接构造,避免本测试源码自己被扫描命中
  fs.writeFileSync(path.join(repo, "test", "pem.txt"), "-----BEGIN RSA " + "PRIVATE KEY-----\n" + "AKIA" + "ABCDEFGHIJKLMNOP" + "\nghp_" + "a".repeat(36) + "\n");
  fs.writeFileSync(path.join(repo, "src", "c.py"), 'api_key = "' + "abcdefghij" + "0123456789" + 'xyz"\n');
  fs.writeFileSync(path.join(repo, "test", "more.txt"), "ASIA" + "ABCDEFGHIJKLMNOP" + "\ngithub_pat_" + "A1".repeat(12) + "\nxapp-" + "1-A2B3C4D5E6" + "\nxoxe-" + "1234567890-abc" + "\n");
  const r2 = scanSecrets(repo, {});
  const whats = new Set(r2.hits.filter((h) => h.file === "test/pem.txt").map((h) => h.what));
  assert.ok(whats.has("PEM 私钥") && whats.has("AWS access key") && whats.has("GitHub token"), [...whats].join(","));
  const more = r2.hits.filter((h) => h.file === "test/more.txt").map((h) => h.what);
  assert.deepEqual(more, ["AWS access key", "GitHub token", "Slack token", "Slack token"], more.join(","));
  assert.ok(r2.hits.some((h) => h.file === "src/c.py" && /字面赋值/.test(h.what)));
  // 免安装包根下的 runtime/(自带的 Node / Python)不扫;别处叫 runtime 的目录照扫
  fs.mkdirSync(path.join(repo, "runtime", "python"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "runtime"));
  fs.writeFileSync(path.join(repo, "runtime", "python", "k.pem"), "-----BEGIN RSA " + "PRIVATE KEY-----\n");
  fs.writeFileSync(path.join(repo, "src", "runtime", "k.pem"), "-----BEGIN RSA " + "PRIVATE KEY-----\n");
  const r3 = scanSecrets(repo, {}).hits.filter((h) => h.file.endsWith("k.pem")).map((h) => h.file.split(path.sep).join("/"));
  assert.deepEqual(r3, ["src/runtime/k.pem"]);
});

test("doctor:体检认设置页保存的 WorkBuddy 位置(#50),不只看自动检测", async (t) => {
  const doctorRepo = tmpDoctorRepo();
  const saved = path.join(doctorRepo, "D-drive", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
  t.after(() => { loadSavedAgentPaths(path.join(doctorRepo, "absent")); fs.rmSync(doctorRepo, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(doctorRepo, ".local"), { recursive: true });
  fs.writeFileSync(path.join(doctorRepo, ".local", "local-agents.json"), JSON.stringify({ codebuddy_bin: saved }));
  let first: string | undefined;
  const ok: Exec = (_cmd, args) => args[0] === "-c" ? { status: 0, stdout: "3.12.4\n", stderr: "" } : { status: 1, stdout: "", stderr: "" };
  await runDoctor({ repoRoot: doctorRepo, env: { PATH: "/usr/bin", HOME: FAKE_HOME }, exec: ok, python: "/fake/python", writeReport: false,
    probeAgents: async (e) => { first = executableCandidates("codebuddy", e)[0]; return []; } });
  assert.equal(first, saved);
});

test("doctor:假 exec + 假 Agent 探测 → 全绿;没有可用大脑 → warn;默认来源不可用 / Python 导入失败 → fail 与修复提示;退出码 0 / 2 / 3", async (t) => {
  const calcOut = JSON.stringify({ calc_version: "0.3.2", output: { status: "ok", value: 20, display: "20.00 倍" } });
  const good: Exec = (cmd, args) => {
    if (args[0] === "-c") return { status: 0, stdout: "3.12.4\n", stderr: "" };
    if (String(args[0]).endsWith("cli.py")) return { status: 0, stdout: calcOut, stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
  };
  const doctorRepo = tmpDoctorRepo();
  t.after(() => fs.rmSync(doctorRepo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(doctorRepo, ".local"), { recursive: true });
  const base = { PATH: "/usr/bin", HOME: FAKE_HOME };
  const doctor = (env: Record<string, string>, extra: Partial<Parameters<typeof runDoctor>[0]> = {}) =>
    runDoctor({ repoRoot: doctorRepo, env, exec: good, python: "/fake/python", writeReport: false, probeAgents: probes("ready"), ...extra });
  const byId = (r: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

  // ① 后台默认 = 本机 Claude 订阅且已登录 → 全绿
  const claudeEnv = { ...base, VRA_PROVIDER: "cli-claude" };
  const r = await doctor(claudeEnv);
  const by = byId(r);
  for (const id of ["node", "config", "ai_default", "local_agents", "constitution", "skills", "python", "calc", "registry", "data_root", "gitignore", "secrets", "net_proxy"]) assert.equal(by[id]?.status, "ok", `${id}: ${by[id]?.detail}`);
  assert.equal(by.net.status, "skip"); assert.ok(by.api_token.status === "skip" || by.api_token.status === "ok");
  assert.equal(by.legacy_config, undefined);
  assert.equal(r.exit_code, 0); assert.equal(r.report, null);
  assert.match(by.ai_default.detail, /cli-claude\(Claude Code 9\.9\.9\)/);
  assert.match(by.constitution.detail, new RegExp(CONSTITUTION_REL.replace(/[.]/g, "\\.")));
  assert.deepEqual(r.checks.filter((c) => /^(engine|codex_cli|auth|skills_isolation|provider_key)$/.test(c.id)).map((c) => c.id), [], "v1 的引擎 / 产品专用登录 / skills 隔离检查不该再出现");

  // ② 什么大脑都没有:不是故障但要提醒(warn,退出码 2),修复提示指向登录 CLI 或在页面填 key
  const none = await doctor(base, { probeAgents: probes("not_installed") });
  const nb = byId(none);
  assert.equal(nb.ai_default.status, "skip"); assert.equal(nb.local_agents.status, "warn");
  assert.match(nb.local_agents.fix ?? "", /接入 AI/); assert.equal(none.exit_code, 2);

  // ③ 后台默认选了 Claude 但没登录 → fail,修复提示是在终端里自己登录(产品不经手)
  const noLogin = await doctor(claudeEnv, { probeAgents: probes("not_authenticated", "ready") });
  const lb = byId(noLogin);
  assert.equal(lb.ai_default.status, "fail"); assert.match(lb.ai_default.fix ?? "", /claude.*\/login/);
  assert.equal(lb.local_agents.status, "ok", "别的 Agent(这里是 Codex)已就绪,机器上有大脑可用");
  assert.equal(noLogin.exit_code, 3);

  // ④ 探测本身出错 → 如实报"检测失败",不当成"没装"
  const broken = await doctor(claudeEnv, { probeAgents: async () => { throw new Error("spawn EACCES"); } });
  const bb = byId(broken);
  assert.equal(bb.local_agents.status, "warn"); assert.match(bb.local_agents.detail, /检测失败.*EACCES/);
  assert.equal(bb.ai_default.status, "fail"); assert.match(bb.ai_default.detail, /登录状态检测失败/);

  // ⑤ Python 导入失败 → fail + pip 提示;calc skip;退出码 3
  const badPy: Exec = (cmd, args) => args[0] === "-c" ? { status: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'akshare'" } : good(cmd, args);
  const f = await doctor(claudeEnv, { exec: badPy });
  const fb = byId(f);
  assert.equal(fb.python.status, "fail"); assert.match(fb.python.fix ?? "", /pip install -r/); assert.equal(fb.calc.status, "skip"); assert.equal(f.exit_code, 3);
  // 安装清单与体检都必须覆盖已注册的 mootdx 源，不能“初始化正常、五个端点全缺包”。
  const requirements = fs.readFileSync(path.join(REPO, ".agents/skills/data-access/scripts/requirements.txt"), "utf8");
  assert.match(requirements, /^mootdx==0\.11\.7$/m);
  const noMootdx: Exec = (cmd, args) => args[0] === "-c" && String(args[1]).includes("mootdx")
    ? { status: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'mootdx'" } : good(cmd, args);
  assert.equal((await doctor(claudeEnv, { exec: noMootdx })).checks.find(c => c.id === "python")?.status, "fail");
  // 产品声明 Python ≥ 3.11:3.10 即使取数依赖都能导入,也不能标成可用
  const oldPy: Exec = (cmd, args) => args[0] === "-c" ? { status: 0, stdout: "3.10.14\n", stderr: "" } : good(cmd, args);
  const old = await doctor(claudeEnv, { exec: oldPy });
  const oldBy = byId(old);
  assert.equal(oldBy.python.status, "fail"); assert.match(oldBy.python.detail, /3\.11/);
  assert.equal(oldBy.calc.status, "skip"); assert.equal(old.exit_code, 3);

  // ⑥ 后台默认 = 模型 API 模板:缺密钥 → 只有 ai_default 报 fail,不相干的检查不受牵连
  //    (v1 的教训:缺 key 曾让体检说"未找到 Python",而 Python 明明配着 —— 第一次配国产模型时的常态)
  const keyEnv = { ...base, VRA_PROVIDER: "fixture-api" };
  const k1 = await doctor(keyEnv, { probeAgents: probes("not_installed") });
  const k1b = byId(k1);
  assert.equal(k1b.config.status, "ok", "配置本身是好的,缺的只是密钥");
  assert.equal(k1b.ai_default.status, "fail"); assert.match(k1b.ai_default.detail, /VRA_TEST_DOCTOR_KEY/);
  assert.match(k1b.ai_default.fix ?? "", /export/);
  assert.equal(k1b.python.status, "ok", "缺模型密钥不该让 Python 检查跟着倒"); assert.equal(k1b.calc.status, "ok");
  assert.equal(k1.exit_code, 3);
  // 有密钥:只有 API、没有任何本机 CLI,也是一台完整可用的机器;报告里只有变量名,没有值
  const secret = "k".repeat(24);
  const k2 = await doctor({ ...keyEnv, VRA_TEST_DOCTOR_KEY: secret }, { probeAgents: probes("not_installed") });
  const k2b = byId(k2);
  assert.equal(k2b.ai_default.status, "ok"); assert.match(k2b.ai_default.detail, /VRA_TEST_DOCTOR_KEY 已设置/);
  assert.equal(k2b.local_agents.status, "ok"); assert.equal(k2.exit_code, 0);
  assert.equal(JSON.stringify(k2).includes(secret), false, "体检结果里不得出现密钥值");

  // ⑦ v1 旧配置:读得懂但不再生效 → warn,并告诉用户 Codex 订阅现在怎么接
  const legacy = await doctor({ ...claudeEnv, VRA_PROVIDER_AUTH: "chatgpt_login", VRA_CODEX_HOME: "/x" });
  const lg = byId(legacy).legacy_config;
  assert.equal(lg?.status, "warn"); assert.match(lg?.detail ?? "", /VRA_PROVIDER_AUTH/); assert.match(lg?.detail ?? "", /VRA_CODEX_HOME/);
  assert.match(lg?.fix ?? "", /cli-codex/); assert.equal(legacy.exit_code, 2);
  // ⑦b v1 骨架的 provider.profile=openai(产品内置 Codex 的订阅登录):设了 OPENAI_API_KEY 也不能被判成可用的按量 API
  const renamed = await doctor({ ...base, VRA_PROVIDER: "openai", OPENAI_API_KEY: "k".repeat(24) }, { probeAgents: probes("not_installed") });
  const rn = byId(renamed).ai_default;
  assert.equal(rn?.status, "fail"); assert.match(rn?.detail ?? "", /openai-api/); assert.match(rn?.fix ?? "", /cli-codex/);
  assert.equal(renamed.exit_code, 3);

  // ⑧ 报告落盘:路径相对化为 <repo>、子进程输出经 redact
  const repoR = tmpRepo(); fs.mkdirSync(path.join(repoR, ".local"), { recursive: true });
  const leaky: Exec = (cmd, args) => args[0] === "-c" ? { status: 1, stdout: "", stderr: "Error: token=abcdefghijklmnop1234 rejected" } : good(cmd, args);
  const rr = await runDoctor({ repoRoot: repoR, env: base, exec: leaky, python: "/fake/python", writeReport: true, probeAgents: probes("not_installed") });
  assert.ok(rr.report && fs.existsSync(rr.report));
  const rep = fs.readFileSync(rr.report!, "utf8");
  assert.ok(!rep.includes(repoR), "报告里不出现绝对产品根"); assert.ok(rep.includes("<repo>"));
  assert.ok(!rep.includes("abcdefghijklmnop1234"), "子进程输出里的 token 必须脱敏");
  // 数据根是符号链接 → data_root_boundary fail,且不写报告 / 探针
  const repoS = tmpRepo(); const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "vra-out2-")); fs.symlinkSync(out2, path.join(repoS, ".local"));
  const rs = await runDoctor({ repoRoot: repoS, env: base, exec: good, python: "/fake/python", writeReport: true, probeAgents: probes("not_installed") });
  const rsb = byId(rs);
  assert.equal(rsb.data_root_boundary.status, "fail"); assert.equal(rsb.data_root.status, "skip"); assert.equal(rs.report, null); assert.equal(rs.exit_code, 3);
  assert.deepEqual(fs.readdirSync(out2), [], "符号链接指向的目录里不得有任何写入");
  // 数据根本身正常,但 .local/doctor 是指向仓库外的符号链接 → 报告不写(warn),探针叶子是符号链接 → data_root fail;仓库外仍空
  const repoD = tmpRepo(); const out3 = fs.mkdtempSync(path.join(os.tmpdir(), "vra-out3-")); fs.mkdirSync(path.join(repoD, ".local"));
  fs.symlinkSync(out3, path.join(repoD, ".local", "doctor"));
  fs.symlinkSync(path.join(out3, "probe-target"), path.join(repoD, ".local", `.doctor-write-${process.pid}`));
  const rd = await runDoctor({ repoRoot: repoD, env: base, exec: good, python: "/fake/python", writeReport: true, probeAgents: probes("not_installed") });
  const rdb = byId(rd);
  assert.equal(rd.report, null); assert.equal(rdb.report?.status, "warn"); assert.equal(rdb.data_root.status, "fail");
  assert.deepEqual(fs.readdirSync(out3), [], "doctor/ 或探针是符号链接时仓库外不得有任何写入");
  assert.ok(rd.tally.warn >= 1 && rd.exit_code === 3, "报告落盘 warn 计入 tally");

  // ⑨ 子进程不拿密钥:体检起的子进程(Python / calc)要么不传 env(defaultExec 用 minimalEnv 白名单),要么只传白名单
  const seen: (Record<string, string> | undefined)[] = [];
  const spy: Exec = (cmd, args, opts) => { seen.push(opts?.env); return good(cmd, args); };
  await doctor({ ...keyEnv, VRA_TEST_DOCTOR_KEY: secret, OPENAI_API_KEY: "y".repeat(24) }, { exec: spy });
  assert.ok(seen.length >= 2, "Python 与 calc 自检都应该跑过");
  assert.ok(seen.every((e) => !e || !Object.keys(e).some((k) => /KEY|TOKEN|SECRET/i.test(k))), "子进程环境里出现了密钥类变量");
  assert.deepEqual(Object.keys(minimalEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "x", VRA_TEST_DOCTOR_KEY: "y", HTTPS_PROXY: "http://p" })).sort(), ["HTTPS_PROXY", "PATH"]);
});

test("init 命令行:带了 --provider / --python 却没给值直接报错(任何写入之前),不当成没传", () => {
  // 裸 --provider 被当成没传:已有配置时命令照样成功、旧来源原样保留;首次初始化写进空来源(Codex 复审 R3-2)
  for (const argv of [["--provider"], ["--provider", "--force"], ["--provider="], ["--python"]]) {
    const flag = argv[0]!.replace(/^--/, "").replace(/=.*$/, "");
    assert.throws(() => initOptionsFromArgs(parseArgs(argv)), new RegExp(`--${flag} 需要一个值`), argv.join(" "));
  }
  assert.deepEqual(initOptionsFromArgs(parseArgs(["--provider", "deepseek", "--force"])), { python: undefined, provider: "deepseek", force: true });
  assert.deepEqual(initOptionsFromArgs(parseArgs([])), { python: undefined, provider: undefined, force: false });
});
