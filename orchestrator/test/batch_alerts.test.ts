import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { batchExitCode, batchSummaryMarkdown, collectRun, runBatch } from "../src/batch.ts";
import { alertsMarkdown, diffEvidence, pickRuns, runAlerts } from "../src/alerts.ts";
import { evidenceAlerts, ServiceError } from "../src/service.ts";

test("观测日行情跨日对齐，财务资料期和不同来源仍严格分开", () => {
  const quote = (period: string, value: number, source = "tencent") => ({ id: `ev-${period}-${source}`, field: "price", period, value, source, unit: "元" });
  const diffs = diffEvidence([quote("2026-09-03", 10)], [quote("2026-09-04", 11)]);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, "changed");
  assert.equal(diffs[0].base?.period, "2026-09-03");
  assert.equal(diffs[0].next?.period, "2026-09-04");
  assert.match(alertsMarkdown("X", "a", "b", diffs), /2026-09-03 → 2026-09-04/);
  assert.deepEqual(diffEvidence([quote("2026-09-03", 10)], [quote("2026-09-04", 10)]), []);
  assert.deepEqual(diffEvidence([quote("2026-09-03", 10)], [quote("2026-09-04", 11, "eastmoney")]).map(d=>d.kind).sort(), ["added", "removed"]);
  const fin = (period: string) => ({ ...quote(period, 10), field: "revenue_cum" });
  assert.deepEqual(diffEvidence([fin("2025-12-31")], [fin("2026-06-30")]).map(d=>d.kind).sort(), ["added", "removed"]);
});

test("🔴 同一来源两次给了不同币种:是一个消失、一个新增,不是数值变化(审计 A8)", () => {
  const fin = (value: number, currency: string) => ({ id: `ev-${currency}`, field: "revenue_cum", period: "2025-12-31", value, source: "eastmoney", unit: "元", currency });
  const diffs = diffEvidence([fin(100, "CNY")], [fin(109, "HKD")], ["revenue_cum"]);
  assert.deepEqual(diffs.map((d) => d.kind).sort(), ["added", "removed"]);
  assert.match(alertsMarkdown("X", "a", "b", diffs), /元\(HKD\)/);
  assert.equal(diffEvidence([fin(100, "HKD")], [fin(109, "HKD")], ["revenue_cum"])[0]?.kind, "changed");
});

test("观测序列只比较各次最新值，但旧日矛盾或不同口径不能被隐藏", () => {
  const e = (period: string, value: number) => ({ id: `ev-${period}-${value}`, field: "price", period, value, source: "tencent", unit: "元" });
  const diff = diffEvidence([e("2026-09-03", 10), e("2026-09-02", 8)], [e("2026-09-04", 11), e("2026-09-03", 10)]);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].base?.value, 10);
  assert.equal(diff[0].next?.value, 11);
  assert.throws(() => diffEvidence([e("2026-09-03", 10), e("2026-09-02", 8), e("2026-09-02", 9)], []), /同源同键/);
  assert.equal(diffEvidence([e("2026-09-03", 10)], [{ ...e("2026-09-04", 11), adjustment: "qfq" }]).length, 2);
  assert.equal(diffEvidence([e("2026-02-30", 10)], [e("2026-03-01", 11)]).length, 2, "不猜畸形日期");
});
import { writeJson } from "../src/fsutil.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
function repoWithRuns(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ba-"));
  const runs = path.join(repo, ".local", "runs");
  const mk = (id: string, symbol: string, finished: string, price: number, extra: Record<string, unknown>[] = []) => {
    fs.mkdirSync(path.join(runs, id, "stages"), { recursive: true });
    writeJson(path.join(runs, id, "manifest.json"), { run_id: id, symbol, market: "SZ", status: "complete", exit_code: 0, evidence_count: 2, calculation_count: 1, evidence_conflicts: [], finished_at: finished, started_at: finished });
    writeJson(path.join(runs, id, "evidence.json"), [{ id: `ev-${id}1`.padEnd(9, "0"), field: "price", value: price, unit: "元", period: "2026-08-21", adjustment: "none", source: "tencent" }, { id: `ev-${id}2`.padEnd(9, "0"), field: "pe_ttm", value: 50, unit: "倍", period: "2026-08-21", adjustment: "none", source: "tencent" }, ...extra]);
    writeJson(path.join(runs, id, "stages", "valuation.json"), { stage: "valuation", standard_columns: { pe_deducted_x4: "calc-1111111111111111", forward_pe: "未获取:x" } });
    fs.writeFileSync(path.join(runs, id, "report.md"), "# r\n");
  };
  mk("a1", "300308", "2026-08-20T10:00:00+08:00", 900);
  mk("a2", "300308", "2026-08-21T10:00:00+08:00", 943, [{ id: "ev-new0001", field: "announcement_title", value: "半年报", unit: "text", period: "2026-08-21", adjustment: "not_applicable", record_key: "k1", source: "szse" }]);
  mk("b1", "002463", "2026-08-21T11:00:00+08:00", 30);
  return repo;
}

test("batch:--provider / --model 覆盖后台默认,批次开始前解析一次、每个子进程拿同一份来源描述;没配来源当场报错;v1 参数报错", () => {
  const repo = repoWithRuns();
  const envs: NodeJS.ProcessEnv[] = [];
  const runner = (argv: string[], env: NodeJS.ProcessEnv) => { envs.push(env); return { status: 0 }; };
  try {
    runBatch({ symbols: ["300308", "002463"], batchId: "bt-provider", repoRoot: repo, python: "python3", provider: "cli-codex", runner });
    assert.equal(envs.length, 2);
    for (const env of envs) assert.deepEqual(JSON.parse(String(env.VRA_REQUEST_LLM_META)), { provider: "cli-codex" });
    // 没配后台默认、也没给 --provider:一个都不跑就报错
    assert.throws(() => runBatch({ symbols: ["300308"], batchId: "bt-none", repoRoot: repo, runner }),
      (e: unknown) => e instanceof ServiceError && e.code === "ai_source_not_configured");
    assert.throws(() => runBatch({ symbols: ["300308"], batchId: "bt-model", repoRoot: repo, provider: "cli-codex", model: "gpt-x", runner }),
      (e: unknown) => e instanceof ServiceError && e.code === "model_not_supported", "订阅 Agent 的模型不能用 --model 覆盖");
    assert.equal(envs.length, 2, "解析失败时一个子进程都不拉起");
    // 模型 API 模板:--model 跟着来源描述走,key 放进模板声明的变量
    fs.mkdirSync(path.join(repo, ".local", "providers"), { recursive: true });
    writeJson(path.join(repo, ".local", "providers", "fixture-api.json"),
      { id: "fixture-api", name: "Fixture", base_url: "https://api.fixture.invalid/v1", env_key: "FIXTURE_BATCH_KEY", default_model: "fixture-default" });
    process.env.FIXTURE_BATCH_KEY = "fixture-batch-key";
    try {
      runBatch({ symbols: ["300308"], batchId: "bt-api", repoRoot: repo, provider: "fixture-api", model: "fixture-m", runner });
    } finally { delete process.env.FIXTURE_BATCH_KEY; }
    const api = envs.at(-1)!;
    assert.equal(api.FIXTURE_BATCH_KEY, "fixture-batch-key");
    const meta = JSON.parse(String(api.VRA_REQUEST_LLM_META)) as { provider: string; model?: string };
    assert.deepEqual([meta.provider, meta.model], ["fixture-api", "fixture-m"]);
    assert.doesNotMatch(String(api.VRA_REQUEST_LLM_META), /fixture-batch-key/, "来源描述里不带 key");
    // --no-agent 不解析来源
    runBatch({ symbols: ["300308"], batchId: "bt-dry", repoRoot: repo, noAgent: true, runner });
    assert.equal(envs.at(-1)!.VRA_REQUEST_LLM_META, undefined);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  // 命令行入口:v1 参数(含等号写法)报错并指路,不悄悄用后台默认跑
  const batchCli = fileURLToPath(new URL("../src/batch.ts", import.meta.url));
  for (const flag of ["--engine=codex", "--auth", "--codex-home=/x"]) {
    const r = spawnSync(process.execPath, [batchCli, "--symbols", "300308", flag], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 30_000 });
    assert.equal(r.status, 1, `${flag}: ${r.stderr}`);
    assert.match(r.stderr, /已在 v2\.0 移除/, flag);
  }
  // --provider 真的传进了批量(独立空数据根:来源解析失败就停,不会真跑研究)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vra-batch-cli-"));
  try {
    // 空值 / 裸参数不能被当成「没传」而落回后台默认
    for (const flag of [["--provider="], ["--provider"], ["--model="]]) {
      const r = spawnSync(process.execPath, [batchCli, "--symbols", "300308", ...flag],
        { encoding: "utf8", env: { PATH: process.env.PATH, VRA_DATA_ROOT: empty }, timeout: 30_000 });
      assert.equal(r.status, 1, `${flag}: ${r.stderr}`);
      assert.match(r.stderr, /需要一个值/, flag.join(" "));
    }
    const r = spawnSync(process.execPath, [batchCli, "--symbols", "300308", "--provider=nosuch-provider-xyz"],
      { encoding: "utf8", env: { PATH: process.env.PATH, VRA_DATA_ROOT: empty }, timeout: 30_000 });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /nosuch-provider-xyz/, "报错说的是命令行指定的来源,不是「没配后台默认」");
    assert.deepEqual(fs.readdirSync(empty).filter((f) => f === "runs" || f === "batches"), [], "解析失败不留运行");
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});

test("batch:汇总只转录各运行产物;runner 注入不真跑;非法代码记错", () => {
  const repo = repoWithRuns();
  const calls: string[][] = [];
  const r = runBatch({ symbols: ["300308", "../x"], market: "SZ", endpoints: "core", knowledge: "off", batchId: "bt1", repoRoot: repo, python: "python3", noAgent: true,
    runner: (argv) => { calls.push(argv); const id = argv[argv.indexOf("--run-id") + 1]; fs.mkdirSync(path.join(repo, ".local", "runs", id), { recursive: true }); writeJson(path.join(repo, ".local", "runs", id, "manifest.json"), { status: "complete", evidence_count: 3, calculation_count: 1, evidence_conflicts: [] }); return { status: 0 }; } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("--endpoints") && calls[0].includes("core") && calls[0].includes("--knowledge") && calls[0].includes("off") && calls[0].includes("--market"));
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].status, "complete");
  assert.equal(r.items[1].error, "非法代码");
  assert.throws(() => runBatch({ symbols: ["300308"], market: "XX", repoRoot: repo, runner: () => ({ status: 0 }) }), /非法市场/);
  assert.throws(() => runBatch({ symbols: ["300308"], endpoints: "all" as never, repoRoot: repo, runner: () => ({ status: 0 }) }), /endpoints/);
  const md = fs.readFileSync(path.join(r.dir, "summary.md"), "utf8");
  assert.ok(md.includes("bt1-300308") && md.includes("非法代码") && !md.includes("建仓"));
  const it = collectRun(path.join(repo, ".local", "runs", "a2"), "300308", "a2", 0, 1000);
  assert.equal(it.standard_columns?.pe_deducted_x4, "calc-1111111111111111");
  assert.ok(batchSummaryMarkdown("x", [it]).includes("calc-1111111111111111"));
});

test("HTTP 变化提醒沿用当前数据根且只读，不读取或覆盖默认用户档案", (t) => {
  const repo = repoWithRuns();
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "vra-alert-isolated-"));
  t.after(() => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(isolated, { recursive: true, force: true }); });
  const ctx = { repoRoot: repo, dataRoot: isolated, python: "python3", node: process.execPath };
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), e => e instanceof ServiceError && e.code === "need_two_runs");
  assert.ok(!fs.existsSync(path.join(repo, ".local", "alerts")));
  fs.cpSync(path.join(repo, ".local", "runs"), path.join(isolated, "runs"), { recursive: true });
  const evidence = [{ id: "ev-isolated", field: "price", value: "ISOLATED_CANARY", unit: "元", period: "p", source: "test" }];
  writeJson(path.join(isolated, "runs", "a2", "evidence.json"), evidence);
  const result = evidenceAlerts(ctx, { symbol: "300308", market: "SZ" });
  assert.ok(JSON.stringify(result).includes("ISOLATED_CANARY"));
  assert.ok(!fs.existsSync(path.join(repo, ".local", "alerts")));
  assert.ok(!fs.existsSync(path.join(isolated, "alerts")), "GET 不应写入比较归档");
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308", base: "../outside", next: "a2" }), /非法 run-id/);
  // 🔴 证据文件坏了 / 没了 / 结构不对:明确报错,不当空集(否则前一次的事实全成「消失」,两份都坏就成「无变化」)
  const ev2 = path.join(isolated, "runs", "a2", "evidence.json");
  const alertsFailed = (re: RegExp) => (e: unknown) => e instanceof ServiceError && e.code === "alerts_failed" && re.test(e.message);
  fs.writeFileSync(ev2, '[{"id":"ev-x","field":"price","val');
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), alertsFailed(/a2 的 evidence\.json 读不出来/));
  fs.writeFileSync(path.join(isolated, "runs", "a1", "evidence.json"), "{");
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), alertsFailed(/读不出来/), "两份都坏也不能说「无变化」");
  fs.copyFileSync(path.join(repo, ".local", "runs", "a1", "evidence.json"), path.join(isolated, "runs", "a1", "evidence.json"));
  const ok = { id: "ev-x", field: "price", value: 1, unit: "元", period: "2026-10-09", source: "eastmoney" };
  const drop = (k: string) => [Object.fromEntries(Object.entries(ok).filter(([key]) => key !== k))];
  // 有 field、缺比较要用的键:两份都这样时原来显示「无变化」(v2.2.0 审计 Codex 第 6 条)
  for (const bad of [{ items: [] }, { evidence: "x" }, [{ value: 1 }], [null], "[]", [{ field: "price" }], ...["id", "value", "unit", "period", "source"].map(drop), [{ ...ok, unit: 3 }]]) {
    writeJson(ev2, bad);
    assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), alertsFailed(/a2 的 evidence\.json 结构不对/), JSON.stringify(bad));
  }
  fs.unlinkSync(ev2);
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), alertsFailed(/a2 的 evidence\.json 不存在/));
  // 合法的空数组 = 这次确实没有事实:照常比较,前一次的事实列为消失
  writeJson(ev2, []);
  assert.ok(evidenceAlerts(ctx, { symbol: "300308" }).diffs.every((d) => d.kind === "removed"));
  writeJson(ev2, { evidence: [] });
  assert.ok(evidenceAlerts(ctx, { symbol: "300308" }).diffs.length > 0);
  fs.unlinkSync(ev2);
  fs.symlinkSync(path.join(repo, ".local", "runs", "a2", "evidence.json"), path.join(isolated, "runs", "a2", "evidence.json"));
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), /符号链接/);
  fs.unlinkSync(path.join(isolated, "runs", "a2", "manifest.json"));
  fs.symlinkSync(path.join(repo, ".local", "runs", "a2", "manifest.json"), path.join(isolated, "runs", "a2", "manifest.json"));
  assert.throws(() => evidenceAlerts(ctx, { symbol: "300308" }), /符号链接/);
});

test("alerts:按事实键对齐两次运行;只列两值;默认取同标的最近两次;输出落 .local/alerts", () => {
  const repo = repoWithRuns();
  const runs = path.join(repo, ".local", "runs");
  assert.deepEqual(pickRuns(runs, "300308"), ["a1", "a2"]);
  const base = JSON.parse(fs.readFileSync(path.join(runs, "a1", "evidence.json"), "utf8"));
  const next = JSON.parse(fs.readFileSync(path.join(runs, "a2", "evidence.json"), "utf8"));
  const d = diffEvidence(base, next);
  assert.deepEqual(d.map((x) => [x.kind, x.field]), [["added", "announcement_title"], ["changed", "price"]]);
  const md = alertsMarkdown("300308", "a1", "a2", d);
  assert.ok(md.includes("900") && md.includes("943") && !/变化率|涨幅|%/.test(md.split("\n").slice(6).join("\n")), "只并列两值,不算变化率");
  const r = runAlerts({ symbol: "300308", market: "SZ", repoRoot: repo });
  assert.equal(r.base, "a1"); assert.equal(r.next, "a2"); assert.equal(r.diffs.length, 2);
  assert.ok(fs.existsSync(r.file) && r.file.includes(path.join(".local", "alerts", "SZ_300308")));
  assert.throws(() => runAlerts({ symbol: "002463", repoRoot: repo }), /不足两个/);
  // 显式指定跨标的 / 跨市场 / 同一运行 → 拒绝
  assert.throws(() => runAlerts({ symbol: "300308", repoRoot: repo, base: "a1", next: "b1" }), /主体是 002463/);
  assert.throws(() => runAlerts({ symbol: "300308", market: "SH", repoRoot: repo, base: "a1", next: "a2" }), /市场是 SZ/);
  assert.throws(() => runAlerts({ symbol: "300308", repoRoot: repo, base: "a2", next: "a2" }), /同一运行/);
  assert.throws(() => runAlerts({ symbol: "../x", repoRoot: repo }), /非法代码/);
  // 省略 market:同代码不同市场的运行不得互比(以 base 运行市场为准)
  fs.mkdirSync(path.join(runs, "c1"), { recursive: true });
  writeJson(path.join(runs, "c1", "manifest.json"), { run_id: "c1", symbol: "300308", market: "SH", status: "complete", finished_at: "2026-08-22T10:00:00+08:00", started_at: "x" });
  writeJson(path.join(runs, "c1", "evidence.json"), []);
  assert.throws(() => runAlerts({ symbol: "300308", repoRoot: repo, base: "a2", next: "c1" }), /市场是 SH/);
  assert.throws(() => runAlerts({ symbol: "300308", repoRoot: repo }), /市场是/);  // 默认挑最近两次 a2(SZ) 与 c1(SH) → 市场不同拒绝
  assert.equal(runAlerts({ symbol: "300308", market: "SZ", repoRoot: repo }).next, "a2");  // 指定市场则只在 SZ 内挑
  // 同字段多源:按来源各自对齐,不静默取舍;同源同键重复 → 拒绝
  const multi = diffEvidence([{ id: "ev-1", field: "pe_ttm", value: 50, unit: "倍", period: "2026-08-21", source: "tencent" }, { id: "ev-2", field: "pe_ttm", value: 52, unit: "倍", period: "2026-08-21", source: "baostock" }],
    [{ id: "ev-3", field: "pe_ttm", value: 51, unit: "倍", period: "2026-08-21", source: "tencent" }, { id: "ev-4", field: "pe_ttm", value: 52, unit: "倍", period: "2026-08-21", source: "baostock" }]);
  assert.deepEqual(multi.map((d) => [d.kind, d.base?.source]), [["changed", "tencent"]]);
  assert.throws(() => diffEvidence([{ id: "ev-1", field: "pe_ttm", value: 50, unit: "倍", period: "p", source: "s" }, { id: "ev-2", field: "pe_ttm", value: 51, unit: "倍", period: "p", source: "s" }], []), /同源同键但值不同/);
  // 同源同键同值(两个端点报同一事实)→ 去重不报错
  const same = diffEvidence([{ id: "ev-1", field: "pe_ttm", value: 50, unit: "倍", period: "p", source: "s" }, { id: "ev-2", field: "pe_ttm", value: 50, unit: "倍", period: "p", source: "s" }], [{ id: "ev-3", field: "pe_ttm", value: 52, unit: "倍", period: "p", source: "s" }]);
  assert.deepEqual(same.map((d) => [d.kind, d.base?.id]), [["changed", "ev-1"]]);
});

test("🔴 同一 batch-id 重跑被拒(退出码 3)时,目录里旧的 complete 清单和报告不算本次结果,批次退出码非 0(审计 A12)", () => {
  const repo = repoWithRuns();
  const old = (id: string) => {
    const d = path.join(repo, ".local", "runs", id);
    fs.mkdirSync(d, { recursive: true });
    writeJson(path.join(d, "manifest.json"), { status: "complete", evidence_count: 9, calculation_count: 2, evidence_conflicts: [] });
    fs.writeFileSync(path.join(d, "report.md"), "旧报告");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(d, "manifest.json"), past, past);
  };
  old("bt-re-300308"); old("bt-re-002463");
  // 300308:子进程直接拒绝(不写清单);002463:子进程中途被杀(status null)
  const r = runBatch({ symbols: ["300308", "002463"], batchId: "bt-re", repoRoot: repo, noAgent: true,
    runner: (argv) => ({ status: argv.includes("300308") ? 3 : null }) });
  for (const it of r.items) {
    assert.equal(it.status, "failed", it.symbol);
    assert.equal(it.report, null, `${it.symbol}:旧报告不能挂到本次`);
    assert.equal(it.evidence_count, null);
    assert.match(it.error ?? "", /没有找到本次运行写出的清单/);
  }
  assert.equal(batchExitCode(r.items), 2);
  assert.ok(!fs.readFileSync(path.join(r.dir, "summary.md"), "utf8").includes("旧报告"));

  // 本次写了清单但子进程异常退出(退出码 1):不算完成
  const r2 = runBatch({ symbols: ["300308"], batchId: "bt-crash", repoRoot: repo, noAgent: true,
    runner: (argv) => { const id = argv[argv.indexOf("--run-id") + 1]; const d = path.join(repo, ".local", "runs", id); fs.mkdirSync(d, { recursive: true });
      writeJson(path.join(d, "manifest.json"), { status: "complete", evidence_count: 3, calculation_count: 1, evidence_conflicts: [] }); return { status: 1 }; } });
  assert.equal(r2.items[0].status, "failed");
  assert.match(r2.items[0].error ?? "", /退出码 1/);
  assert.equal(batchExitCode(r2.items), 2);

  // 本次真跑失败(写了 failed 清单、退出码 3):照常转录本次产物
  const r3 = runBatch({ symbols: ["300308"], batchId: "bt-fail", repoRoot: repo, noAgent: true,
    runner: (argv) => { const id = argv[argv.indexOf("--run-id") + 1]; const d = path.join(repo, ".local", "runs", id); fs.mkdirSync(d, { recursive: true });
      writeJson(path.join(d, "manifest.json"), { status: "failed", evidence_count: 2, calculation_count: 0, evidence_conflicts: [] }); return { status: 3 }; } });
  assert.equal(r3.items[0].status, "failed");
  assert.equal(r3.items[0].evidence_count, 2);
  assert.equal(r3.items[0].error, undefined);
  // 状态拿不到也算失败
  assert.equal(batchExitCode([{ ...r3.items[0], status: null }]), 2);
  assert.equal(batchExitCode([{ ...r3.items[0], status: "incomplete" }]), 0);
});
