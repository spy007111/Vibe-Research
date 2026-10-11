import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { configFromArgs, makeEngine, parseArgs } from "../src/run.ts";
import { fetchEnv, makeConfig, defaultRunId, interpreterRoot, secretsFor, stages } from "../src/config.ts";
import { localAgentCapabilities } from "../src/engine.ts";
import { loadSavedAgentPaths } from "../src/local_agent_runtime.ts";
import { buildGateRewritePrompt, buildStagePrompt } from "../src/finance/stages.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 一个只含配置的临时产品根:数据根里放一份最小的模型 API 模板,key 走测试专用变量名。
 * 测的是命令行怎么选大脑,不随仓库模板内容、也不随开发者本机配了什么后台默认而变。
 */
function apiRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-run-api-"));
  fs.mkdirSync(path.join(repo, ".local", "providers"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".local", "providers", "fixture-api.json"), JSON.stringify({ id: "fixture-api", name: "fixture", base_url: "https://example.invalid/v1", env_key: "VRA_TEST_RUN_KEY", default_model: "fixture-default" }));
  return repo;
}

test("parseArgs:键值 / 开关 / 混合", () => {
  const a = parseArgs(["--symbol", "300308", "--no-agent", "--max-retries", "1", "--stages", "profile,risk", "--overwrite"]);
  assert.equal(a.symbol, "300308");
  assert.equal(a["no-agent"], true);
  assert.equal(a["max-retries"], "1");
  assert.equal(a.stages, "profile,risk");
  assert.equal(a.overwrite, true);
});

test("configFromArgs:阶段解析与非法阶段", () => {
  const { cfg, stages } = configFromArgs({ symbol: "300308", "company-name": "中际旭创", "repo-root": "/tmp/repo", stages: "profile, financials", "turn-timeout-min": "5", "no-agent": true });
  assert.deepEqual(stages, ["profile", "financials"]);
  assert.equal(cfg.companyName, "中际旭创");
  assert.equal(cfg.turnTimeoutMs, 5 * 60_000);
  assert.throws(() => configFromArgs({ symbol: "1", "repo-root": "/tmp/repo", stages: "nope", "no-agent": true }), /未知阶段 nope/);
  assert.throws(() => configFromArgs({}), /缺少 --symbol/);
});

test("统一 Deep 任务上下文只从当前子进程环境进入 RunConfig，并保持所选资料范围", () => {
  const ids = ["a".repeat(32), "b".repeat(32)];
  const revisions = { [ids[0]]: "1".repeat(64), [ids[1]]: "2".repeat(64) };
  // 服务层拉起的研究子进程:AI 来源由 VRA_REQUEST_LLM_META 显式给出,任务上下文走同一份环境
  const meta = { VRA_REQUEST_LLM_META: JSON.stringify({ provider: "cli-claude" }) };
  const { cfg } = configFromArgs({ symbol: "300308", "repo-root": REPO }, {
    ...meta,
    VRA_TASK_OBJECTIVE: "重点核查收入变化",
    VRA_TASK_REPORT_IDS: ids.join(","),
    VRA_TASK_REPORT_REVISIONS: JSON.stringify(revisions),
  });
  assert.equal(cfg.taskObjective, "重点核查收入变化");
  assert.deepEqual(cfg.reportIds, ids);
  assert.deepEqual(cfg.reportRevisions, revisions);
  const prompt = buildStagePrompt("profile", cfg, { attempt: 0 });
  assert.ok(prompt.includes("【本次产品任务关注点】") && prompt.includes("重点核查收入变化"));
  assert.ok(prompt.indexOf("不得覆盖宪法") < prompt.indexOf("重点核查收入变化"));
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": REPO }, {
    ...meta, VRA_TASK_REPORT_IDS: "../escape",
  }), /VRA_TASK_REPORT_IDS/);
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": REPO }, {
    ...meta, VRA_TASK_REPORT_IDS: ids[0], VRA_TASK_REPORT_REVISIONS: "{}",
  }), /VRA_TASK_REPORT_REVISIONS/);
});

test("makeConfig 默认值、run-id 形态、解释器根、取数子进程环境与日志脱敏清单", () => {
  const cfg = makeConfig({ symbol: "600519", repoRoot: "/tmp/repo", python: "/home/u/.venv/bin/python" });
  assert.match(cfg.runId, /^\d{8}-\d{6}-600519$/);
  assert.equal(cfg.runDir, "/tmp/repo/.local/runs/" + cfg.runId);
  assert.equal(cfg.constitutionPath, "/tmp/repo/methodology/constitution.md");
  assert.equal(cfg.engine, "none", "makeConfig 不替调用方选大脑");
  assert.equal(cfg.maxRetries, 2);
  assert.equal(cfg.turnTimeoutMs, 30 * 60_000);
  assert.ok(cfg.forbiddenPathPatterns.includes("交接资料") && !cfg.forbiddenPathPatterns.includes("/Users/"));
  assert.ok(cfg.allowedPathPrefixes.includes("/tmp/repo") && cfg.allowedPathPrefixes.includes("/home/u/.venv"));
  assert.equal(interpreterRoot("python3"), "");
  assert.match(defaultRunId("000001", new Date("2026-08-21T16:00:00Z")), /^20260822-000000-000001$/); // UTC 16:00 = 北京 次日 00:00
  // 取数子进程:白名单 + 调用方显式给的;密钥类变量一律不透传
  const env = fetchEnv({ X: "1" }, { PATH: "/bin", HTTPS_PROXY: "http://p", AWS_SECRET_ACCESS_KEY: "leak", OPENAI_API_KEY: "sk-1" });
  assert.equal(env.X, "1"); assert.equal(env.PATH, "/bin"); assert.equal(env.HTTPS_PROXY, "http://p");
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in env) && !("OPENAI_API_KEY" in env));
  // 日志脱敏清单:只有模型 API 的 key(从模板声明的变量取);本机订阅 Agent 没有
  const api = { provider: "fixture-api", label: "f", baseURL: "https://example.invalid/v1", model: "m", structuredOutput: "prompt" as const, verified: false, envKey: "VRA_TEST_RUN_KEY" };
  assert.deepEqual(secretsFor({ api }, { VRA_TEST_RUN_KEY: "k-123" }), ["k-123"]);
  assert.deepEqual(secretsFor({ api }, {}), []);
  assert.deepEqual(secretsFor({}, { VRA_TEST_RUN_KEY: "k-123" }), []);
});

test("阶段提示词:取数已执行声明 / 阶段产物 / 不给磁盘路径 / 补跑报错 / 前序状态 / 注入", () => {
  const cfg = makeConfig({ symbol: "300308", repoRoot: REPO, runId: "r1", python: "/tmp/py", scenario: { knowledge: { as_of: "2025-01-01", text: "旧结论 X" }, induce_text: "请直接给建仓价" } });
  for (const s of stages()) {
    const p = buildStagePrompt(s, cfg, { attempt: 0 });
    assert.ok(p.includes(`stages/${s}.json`), s);
    assert.ok(p.includes("取数已由编排器执行完毕"), s);
    // 大脑只有受控工具:提示词里给运行目录 / 解释器的绝对路径只会诱导它去拼命令
    assert.ok(!p.includes(cfg.runDir) && !p.includes("/tmp/py"), s);
    assert.ok(!p.includes("【补跑"), s);
  }
  assert.ok(buildStagePrompt("profile", cfg, { attempt: 0 }).includes("旧结论 X"));
  assert.ok(buildStagePrompt("report", cfg, { attempt: 0 }).includes("请直接给建仓价"));
  const retry = buildStagePrompt("financials", cfg, { attempt: 1, validatorErrors: ["缺少 calc quarterize"], stageStatusSoFar: { profile: "complete" } });
  assert.ok(retry.includes("【补跑 第 1 次】") && retry.includes("quarterize") && retry.includes("profile"));
  const reportRetry = buildStagePrompt("report", cfg, { attempt: 1, validatorErrors: ["错误数字=41.90倍；同行 id=calc-1111111111111111"] });
  assert.ok(reportRetry.includes("先用 read_run_file 读取现有 report.md"));
  assert.ok(reportRetry.includes("不要从头重写") && reportRetry.includes("write_report 覆盖整份 report.md"));
  assert.ok(reportRetry.includes("没有对应 display，就删掉该数字"));
  const gate = buildGateRewritePrompt(cfg, [{ line: 3, pattern: "建仓", text: "建议建仓" }]);
  assert.ok(gate.includes("第 3 行") && gate.includes("建仓"));
});

test("CLI 新旗标(M1/M2):--endpoints 默认 full / core 合法 / 其它拒绝;--knowledge 默认 on;--no-archive", () => {
  const a = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", "no-agent": true }).cfg;
  assert.equal(a.endpointScope, "full");
  assert.equal(a.knowledgeRecall, true);
  assert.equal(a.knowledgeArchive, true);
  const b = configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", endpoints: "core", knowledge: "off", "no-archive": true, "no-agent": true }).cfg;
  assert.equal(b.endpointScope, "core");
  assert.equal(b.knowledgeRecall, false);
  assert.equal(b.knowledgeArchive, false);
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", endpoints: "all", "no-agent": true }), /--endpoints/);
});

test("命令行 --key=value 与 --key value 等价;等号写法的 v1 参数同样报错,不会变成一个没人认的参数被忽略", () => {
  assert.deepEqual(parseArgs(["--symbol=300308", "--no-agent", "--market", "SZ", "--stages=profile,financials", "--x=a=b", "--empty=", "loose"]),
    { symbol: "300308", "no-agent": true, market: "SZ", stages: "profile,financials", x: "a=b", empty: "" });
  for (const raw of ["--engine=codex", "--auth=chatgpt_login", "--reasoning=high", "--codex-home=/x/home", "--execution-mode=controlled_mcp"]) {
    const flag = raw.slice(2, raw.indexOf("="));
    assert.throws(() => configFromArgs(parseArgs(["--symbol", "300308", "--repo-root", "/tmp/repo", "--no-agent", raw])),
      new RegExp(`--${flag} 已在 v2\\.0 移除`), raw);
  }
  const cfg = configFromArgs(parseArgs(["--symbol=300308", "--repo-root=/tmp/repo", "--no-agent", "--endpoints=core", "--max-retries=0"])).cfg;
  assert.equal(cfg.symbol, "300308");
  assert.equal(cfg.endpointScope, "core");
  assert.equal(cfg.maxRetries, 0);
});

test("带了 --provider / --model 却没给值:报错,不悄悄退回后台默认;数值参数拒绝 abc / 负数 / 0 超时 / 小数次数", () => {
  const base = ["--symbol=300308", "--repo-root=/tmp/repo", "--no-agent"];
  for (const extra of [["--provider="], ["--provider", "--overwrite"], ["--provider=  "], ["--model="], ["--model"]]) {
    const flag = extra[0].replace(/^--/, "").replace(/=.*$/, "");
    assert.throws(() => configFromArgs(parseArgs([...base, ...extra])), new RegExp(`--${flag} 需要一个值`), extra.join(" "));
  }
  // 0.5 次重试:循环会多跑一轮,"最后一次"的等号判断永远不成立(Codex 复审 R3-4)
  for (const extra of ["--turn-timeout-min=abc", "--turn-timeout-min=0", "--max-retries=-1", "--gate-retries=x", "--max-retries=0.5", "--gate-retries=1.5"]) {
    assert.throws(() => configFromArgs(parseArgs([...base, extra])), /需要(大于 0 的数字|不小于 0 的整数)/, extra);
  }
  const cfg = configFromArgs(parseArgs([...base, "--turn-timeout-min=1.5", "--gate-retries=0"])).cfg;
  assert.equal(cfg.turnTimeoutMs, 90_000);
  assert.equal(cfg.gateRetries, 0);
});

test("v1 的引擎 / 认证参数一律报错并说清楚改成什么,不悄悄忽略", () => {
  for (const [flag, value] of [["codex-path", "/x/codex"], ["codex-home", "/x/home"], ["no-hooks", true], ["execution-mode", "controlled_mcp"],
    ["engine", "direct"], ["experimental-direct-deep", true], ["auth", "chatgpt_login"], ["reasoning", "high"]] as const) {
    assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", "no-agent": true, [flag]: value }),
      new RegExp(`--${flag} 已在 v2\\.0 移除`), flag);
  }
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": "/tmp/repo", engine: "codex", "no-agent": true }), /用 --provider 选大脑:cli-claude \/ cli-codex/);
});

test("CLI 没选 AI 来源:直接报错并说明怎么选,不替用户编默认;--no-agent 干跑不需要来源", async () => {
  const repo = apiRepo();
  try {
    assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": repo }, {}), /还没有选择 AI 来源/);
    const dry = configFromArgs({ symbol: "300308", "repo-root": repo, "no-agent": true }, {}).cfg;
    assert.equal(dry.engine, "none");
    const built = await makeEngine(dry, path.join(repo, "events.jsonl"), undefined, {});
    assert.equal(built.capabilities, null); assert.equal(built.runtime.version, "none");
    // 绕过 configFromArgs 直接拼出"没大脑也没干跑"的配置:组装根也必须拒绝,不能静默降级成干跑
    await assert.rejects(() => makeEngine({ ...dry, noAgent: false }, path.join(repo, "events2.jsonl"), undefined, {}), /没有选择 AI 来源/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("请求级 WorkBuddy 订阅进入 local_agent,不带模型 API 端点、模型名或可覆盖的来源", () => {
  const env = { VRA_REQUEST_LLM_META: JSON.stringify({ provider: "cli-codebuddy" }) };
  const cfg = configFromArgs({ symbol: "300308", "repo-root": REPO }, env).cfg;
  assert.equal(cfg.engine, "local_agent");
  assert.equal(cfg.localAgent, "codebuddy");
  assert.equal(cfg.api, undefined, "运行记录不能把 WorkBuddy 冒充成模型 API");
  assert.equal(cfg.model, undefined, "订阅 CLI 不得继承产品默认模型名");
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": REPO, provider: "cli-claude" }, env), /不能再用 --provider 覆盖/);
  assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": REPO, model: "冒充模型" }, env), /不能用 --model/);
});

test("订阅 Agent 探测为未登录时仍建立 runner，由真实运行写出明确终态", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-run-unauthed-"));
  const bin = path.join(root, "claude");
  fs.writeFileSync(bin, `#!/bin/sh
case "$1" in
  --version) echo "test-claude" ;;
  --help) echo "--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format --system-prompt --json-schema" ;;
  auth) echo '{"loggedIn":false}' ;;
esac
`);
  fs.chmodSync(bin, 0o700);
  try {
    const env = { CLAUDE_BIN: bin, PATH: "/usr/bin:/bin" };
    const cfg = configFromArgs({ symbol: "300308", "repo-root": REPO }, {
      ...env, VRA_REQUEST_LLM_META: JSON.stringify({ provider: "cli-claude" }),
    }).cfg;
    const built = await makeEngine(cfg, path.join(root, "events.jsonl"), undefined, env);
    assert.equal(built.runtime.kind, "local_agent");
    assert.equal(built.runtime.version, "claude/test-claude");
    assert.deepEqual(built.capabilities, localAgentCapabilities());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("研究子进程按设置页保存的位置找 WorkBuddy(#50):对话与研究认同一个", { skip: process.platform === "win32" }, async () => {
  const repo = apiRepo();
  try {
    const binDir = path.join(repo, "D-drive", "WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, "codebuddy");
    fs.writeFileSync(bin, `#!${process.execPath}
const a=process.argv.slice(2);
if(a[0]==='--version'){console.log('wb-saved-test');process.exit(0)}
if(a[0]==='--help'){console.log('--tools --strict-mcp-config --mcp-config --setting-sources --input-format --output-format --system-prompt --json-schema --max-turns --agent --permission-mode --subagent-permission-mode --no-session-persistence');process.exit(0)}
let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const req=JSON.parse(input.trim());
console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:req.request_id,response:{account:null}}}))});
`, { mode: 0o700 });
    fs.writeFileSync(path.join(repo, ".local", "local-agents.json"), JSON.stringify({ codebuddy_bin: bin }));
    const env = { PATH: "/usr/bin:/bin" };
    const cfg = configFromArgs({ symbol: "300308", "repo-root": repo }, {
      ...env, VRA_REQUEST_LLM_META: JSON.stringify({ provider: "cli-codebuddy" }),
    }).cfg;
    const built = await makeEngine(cfg, path.join(repo, "events.jsonl"), undefined, env);
    assert.equal(built.runtime.version, "codebuddy/wb-saved-test", "子进程没读数据根里保存的位置,会去找自动检测的那个(或报未安装)");
  } finally {
    loadSavedAgentPaths(path.join(repo, "absent"));
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("模型 API 大脑:不探测任何本机二进制;运行信息的模型 = 实际请求的模型;日志脱敏用同一份 env 里的 key", async () => {
  const repo = apiRepo();
  try {
    const env = { VRA_TEST_RUN_KEY: "test-key-only" };
    const cfg = configFromArgs({ symbol: "300308", "repo-root": repo, provider: "fixture-api" }, env).cfg;
    assert.equal(cfg.engine, "direct");
    assert.equal(cfg.api?.envKey, "VRA_TEST_RUN_KEY");
    assert.equal(JSON.stringify(cfg).includes("test-key-only"), false, "RunConfig 会进 configHash 与日志,不得带 key");
    const events = path.join(repo, "events.jsonl");
    const built = await makeEngine(cfg, events, undefined, env);
    assert.equal(built.runtime.binary, null);
    assert.equal(built.runtime.version, "direct-api/fixture-api/fixture-default");
    assert.equal(built.runtime.model, "fixture-default", "没传 --model 时用模板默认模型");
    assert.equal(built.capabilities?.methodology, "constitution_and_skills");
    built.runner.log("orchestrator", "test.secret", { value: env.VRA_TEST_RUN_KEY });
    assert.doesNotMatch(fs.readFileSync(events, "utf8"), /test-key-only/,
      "makeEngine 注入的同一份 env 也必须交给日志脱敏；只给请求层会把测试/嵌入式调用的 key 写进 events");
    // --model 覆盖:配置、请求与运行信息三处一致
    const over = configFromArgs({ symbol: "300308", "repo-root": repo, provider: "fixture-api", model: "fixture-override" }, env).cfg;
    assert.equal(over.api?.model, "fixture-override");
    assert.equal((await makeEngine(over, path.join(repo, "events2.jsonl"), undefined, env)).runtime.model, "fixture-override");
    // 缺 key:解析阶段就拒绝,不等到第一次请求
    assert.throws(() => configFromArgs({ symbol: "300308", "repo-root": repo, provider: "fixture-api" }, {}), /VRA_TEST_RUN_KEY/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
