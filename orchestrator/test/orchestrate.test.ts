/**
 * 主流程端到端(假运行器 + 假取数执行器 + 假复算):验证状态机、补跑、gate 重写、收工检查、状态推导、manifest 契约。
 * 大脑一律是注入的假 runner —— 这里测的是**与大脑无关**的那一份编排;各大脑自己的 turn 行为见
 * direct_stage_agent / local_agent_stage_agent / local_agent_runtime 的测试。
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CONSTITUTION_REL, stages, fetchEnv, makeConfig, type RunApiInfo, type RunConfig, type Stage } from "../src/config.ts";
import { saveLedger, type FetchExecutor } from "../src/fetchrun.ts";
import { sha256File, writeJson } from "../src/fsutil.ts";
import { deriveRunStatus, exitCodeFor, prepareRunDir, runResearch } from "../src/orchestrate.ts";
import { EventsLog, type AgentRunner, type TurnOutcome } from "../src/agent_runner.ts";
import { directCapabilities, localAgentCapabilities } from "../src/engine.ts";
import { STAGE_SKILLS } from "../src/finance/methodology.ts";
import { validateManifest } from "../src/schemas.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import { loadRegistry } from "../src/registry.ts";
import { mergeEvidence } from "../src/merge.ts";
import { addReport } from "../src/report_library.ts";
import { LocalAgentError } from "../src/local_agent_runtime.ts";
import { DirectStageAgent } from "../src/engines/direct_stage_agent.ts";
import { chainFile, parseChain, verifyAudit } from "../src/audit_chain.ts";
import http from "node:http";
import type { Socket } from "node:net";

const TS = "2026-08-21T10:00:00+08:00";
const ev = (id: string, field: string, value: unknown, extra: Record<string, unknown> = {}) => ({ id, symbol: "300308", market: "SZ", field, value, unit: "元", currency: "CNY",
  period: "2026-08-21", as_of: "2026-08-21", source: "tencent", endpoint: "qt", fetched_at: TS, adjustment: "none", raw_ref: null, ...extra });
const CAL = { session_phase: "non_trading_day", reference_quote_day: "2026-08-21", last_trading_day: "2026-08-21" };
const PE_PERIOD = "2026-08-20..2026-08-21";
const PE_SERIES = { raw_ref: "raw/fake_fetch_pe_history.csv", column: "peTTM", where: { tradestatus: "1" }, date_column: "date" };

const REAL_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONSTITUTION = "# 测试宪法\n\n1. 只用受控工具。\n";
function tmpRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-repo-"));
  fs.mkdirSync(path.join(repo, ".local", "runs"), { recursive: true });
  // 方法论:宪法 + 本阶段手册由插件写进**每个阶段的提示词**(对所有大脑一视同仁);缺任何一份,提示词构造就会响亮失败
  fs.mkdirSync(path.dirname(path.join(repo, CONSTITUTION_REL)), { recursive: true });
  fs.writeFileSync(path.join(repo, CONSTITUTION_REL), CONSTITUTION);
  for (const name of new Set(Object.values(STAGE_SKILLS).flat())) {
    fs.mkdirSync(path.join(repo, ".agents", "skills", name), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "skills", name, "SKILL.md"), `# 测试手册 ${name}\n`);
  }
  fs.mkdirSync(path.join(repo, "calc"), { recursive: true });
  fs.writeFileSync(path.join(repo, "calc", "SPEC.md"), "# 测试计算契约\n");
  // 产品随仓库发行的数据表(卡口事件分类表 / 产业标签表):缺失按配置错误直接抛,所以假仓库要带上
  fs.mkdirSync(path.join(repo, "datasources"), { recursive: true });
  for (const f of ["chokepoint_keywords.json", "industry_tags.json"]) fs.copyFileSync(path.join(REAL_REPO, "datasources", f), path.join(repo, "datasources", f));
  return repo;
}

/** 假取数证据:按脚本给出与真实脚本同名的 field,便于槽位校验 */
const FIELDS: Record<string, { field: string; value: number; unit?: string; period?: string }[]> = {
  fetch_quote: [{ field: "price", value: 943 }, { field: "total_market_cap", value: 1.0e12 }, { field: "pe_ttm", value: 50, unit: "倍" }],
  fetch_financials: [{ field: "revenue_cum", value: 5e9, period: "2026Q2" }, { field: "net_profit_parent_cum", value: 1.1e9, period: "2026Q2" }, { field: "net_profit_deducted_cum", value: 1e9, period: "2026Q2" }],
  fetch_estimates: [{ field: "eps_consensus_mean", value: 10, period: "FY2026" }, { field: "eps_consensus_mean", value: 20, period: "FY2028" }, { field: "eps_consensus_min", value: 5, period: "FY2028" }, { field: "eps_consensus_max", value: 30, period: "FY2028" }],
  fetch_pe_history: [{ field: "pe_ttm_traded_history_points", value: 2, unit: "个", period: PE_PERIOD }],
};
const evId = (s: string, field = s, period = "") => `ev-${crypto.createHash("sha256").update(`${s}|${field}|${period}`).digest("hex").slice(0, 6)}`;

/** 假取数执行器:按脚本名写信封 + 内存账本;可指定失败脚本 */
function fakeFetch(failed: string[] = []): FetchExecutor {
  return (cfg, stage, scripts, log, ledger) => {
    for (const s of scripts) {
      if (ledger[s]) continue;
      const f = path.join(cfg.runDir, "fetch", `${s}.json`);
      const isFail = failed.includes(s);
      const extra = s === "fetch_quote" ? { is_stale: false, quote_date: "2026-08-21" } : s === "fetch_trade_calendar" ? CAL : s === "fetch_estimates" ? { current_fy: "FY2026", years: ["FY2026", "FY2027", "FY2028"] } : {};
      const spec = FIELDS[s] ?? [{ field: s, value: 1 }];
      // 每个脚本一份假 raw 响应:证据 raw_ref 指向它,账本 raw_files 登记其 sha(与真实取数一致,满足"每条证据必有 raw_ref"规则)
      const rawName = s === "fetch_pe_history" ? "fake_fetch_pe_history.csv" : `fake_${s}.json`;
      fs.writeFileSync(path.join(cfg.runDir, "raw", rawName), s === "fetch_pe_history"
        ? "date,peTTM,tradestatus\n2026-08-20,40,1\n2026-08-21,60,1\n" : JSON.stringify({ fake: s }));
      const evidence = isFail ? [] : spec.map((x) => ev(evId(s, x.field, x.period ?? ""), x.field, x.value,
        { raw_ref: `raw/${rawName}`, ...(x.unit ? { unit: x.unit } : {}), ...(x.period ? { period: x.period } : {}), ...(s === "fetch_trade_calendar" ? { market: "CN", symbol: "MARKET", currency: "n/a", adjustment: "not_applicable" } : {}) }));
      const env = { script: s, symbol: cfg.symbol, market: cfg.market, status: isFail ? "failed" : "ok", fetched_at: TS, primary_source: isFail ? null : "tencent",
        used_sources: isFail ? [] : ["tencent"], evidence, extra, errors: [], missing: [] };
      writeJson(f, env);
      ledger[s] = { script: s, argv: [], exit_code: isFail ? 3 : 0, duration_ms: 1, status: isFail ? "failed" : "ok", file: `fetch/${s}.json`, sha256: sha256File(f), raw_files: { [rawName]: sha256File(path.join(cfg.runDir, "raw", rawName)) }, started_at: TS, finished_at: TS, stage };
      log("fetch.executed", { script: s });
    }
    saveLedger(cfg.runDir, ledger);
    return ledger;
  };
}

type Behaviour = (stage: Stage, attempt: number, cfg: RunConfig, prompt: string) => void;

/** 假 agent:按回调在运行目录写产物 */
class FakeRunner implements AgentRunner {
  threadId: string | null = "fake-thread";
  calls: { stage: Stage; attempt: number; prompt: string }[] = [];
  logs: { stage: string; type: string }[] = [];
  private readonly behave: Behaviour;
  private readonly cfg: RunConfig;
  private events: EventsLog | null = null;
  constructor(behave: Behaviour, cfg: RunConfig) { this.behave = behave; this.cfg = cfg; }
  log(stage: Stage | "orchestrator", type: string, payload: Record<string, unknown> = {}): void {
    this.logs.push({ stage, type });
    if (!this.events) this.events = new EventsLog(path.join(this.cfg.runDir, "events.jsonl")); // 运行目录由 prepareRunDir 准备好后首次写
    this.events.append({ stage, type, ...payload });
  }
  eventsDigest(): string | null { return this.events?.digest() ?? null; }
  async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
    this.calls.push({ stage, attempt, prompt });
    this.behave(stage, attempt, this.cfg, prompt);
    return { finalResponse: "{}", usage: null, commands: [], fileChanges: [], itemCount: 0, durationMs: 1, failed: null, threadId: this.threadId };
  }
}

const E = (id: string) => ({ ref_type: "evidence" as const, ref_id: id });
const C = (id: string) => ({ ref_type: "calculation" as const, ref_id: id });
const CALC = (fn: string, id: string, refs: { ref_type: "evidence" | "calculation"; ref_id: string }[], inputs: Record<string, unknown> = { a: 1 }, out: { value: number | null; unit: string } = { value: 1.5, unit: "倍" }) => ({ calculation_id: id, function: fn, calc_version: "0.2.0", inputs,
  // 复算仍由此状态机测试的替身负责；序列槽位的生产校验必须看到正确的输入元数据。
  inputs_resolved: fn === "percentile_rank" ? { history: { ...PE_SERIES, period: PE_PERIOD, rows_used: 2 } } : {}, inputs_refs: refs, output: { status: out.value === null ? "not_meaningful" : "ok", value: out.value, unit: out.unit, reason: "", details: {} } });
const cid = (n: number) => `calc-${n.toString(16).padStart(16, "0")}`;
const QUOTE = { price: evId("fetch_quote", "price"), cap: evId("fetch_quote", "total_market_cap"), pe: evId("fetch_quote", "pe_ttm") };
const FIN = { rev: evId("fetch_financials", "revenue_cum", "2026Q2"), par: evId("fetch_financials", "net_profit_parent_cum", "2026Q2"), ded: evId("fetch_financials", "net_profit_deducted_cum", "2026Q2") };
const EST = { m26: evId("fetch_estimates", "eps_consensus_mean", "FY2026"), m28: evId("fetch_estimates", "eps_consensus_mean", "FY2028"), min: evId("fetch_estimates", "eps_consensus_min", "FY2028"), max: evId("fetch_estimates", "eps_consensus_max", "FY2028") };
const PEH = evId("fetch_pe_history", "pe_ttm_traded_history_points", PE_PERIOD);
/** 计算 id 约定:1-3 quarterize(营收 / 归母 / 扣非),4 latest_quarter,5 ttm_sum,6 ttm_yoy,7 qoq;10 forward_cagr,11 dispersion;20-26 估值 */
type Ref = { ref_type: "evidence" | "calculation"; ref_id: string };
type CalcSpec = [string, number, Ref[], Record<string, unknown>, { value: number | null; unit: string }];
const OUT = { lq: { value: 2.5e8, unit: "元" }, ttm: { value: 9.5e8, unit: "元" }, yoy: { value: 2.0, unit: "小数" }, qoq: { value: 0.3, unit: "小数" },
  cagr: { value: 0.4142, unit: "小数" }, pe: { value: 1000, unit: "倍" }, pe_ttm: { value: 1052.63, unit: "倍" } };
const FIN_CALCS: CalcSpec[] = [
  ["quarterize", 1, [E(FIN.rev)], { a: 1 }, { value: 3, unit: "期" }], ["quarterize", 2, [E(FIN.par)], { a: 1 }, { value: 3, unit: "期" }], ["quarterize", 3, [E(FIN.ded)], { a: 1 }, { value: 3, unit: "期" }],
  ["latest_quarter", 4, [C(cid(3))], { a: 1 }, OUT.lq], ["ttm_sum", 5, [C(cid(2))], { a: 1 }, OUT.ttm], ["ttm_yoy", 6, [C(cid(2))], { a: 1 }, OUT.yoy], ["qoq", 7, [C(cid(3))], { a: 1 }, OUT.qoq],
];
const EST_CALCS: CalcSpec[] = [
  ["forward_cagr", 10, [E(EST.m26), E(EST.m28)], { eps_t: 10, eps_t_plus_n: 20, years: 2 }, OUT.cagr],
  ["consensus_dispersion", 11, [E(EST.min), E(EST.m28), E(EST.max)], { low: 5, mean: 20, high: 30 }, { value: 6, unit: "倍" }],
];
const VAL_CALCS: CalcSpec[] = [
  ["pe_deducted_annualized", 20, [E(QUOTE.cap), C(cid(4))], { total_market_cap: 1.0e12, cap_unit: "元", latest_quarter_deducted_profit: OUT.lq.value, profit_unit: "元" }, OUT.pe],
  ["forward_pe", 21, [E(QUOTE.price), E(EST.m26)], { price: 943, eps_forecast: 10 }, { value: 94.3, unit: "倍" }],
  ["pe_ttm_from_parts", 22, [E(QUOTE.cap), C(cid(5))], { total_market_cap: 1.0e12, cap_unit: "元", ttm_profit: OUT.ttm.value, profit_unit: "元" }, OUT.pe_ttm],
  ["percentile_rank", 23, [E(PEH), E(QUOTE.pe)], { current: 50, history: { history_csv: PE_SERIES } }, { value: 64.9, unit: "%" }],
  ["peg", 24, [C(cid(20)), C(cid(10))], { pe: OUT.pe.value, cagr: OUT.cagr.value }, { value: 24.1, unit: "倍" }],
  ["pe_digestion_scenarios", 25, [C(cid(20)), C(cid(10))], { pe: OUT.pe.value, cagr: OUT.cagr.value }, { value: null, unit: "年" }],
  ["forward_vs_ttm_judgement", 26, [C(cid(10)), C(cid(6))], { forward_cagr_value: OUT.cagr.value, ttm_yoy_value: OUT.yoy.value }, { value: -158.6, unit: "百分点" }],
];

/** 一个"听话"的 agent 行为:每阶段写合规产物(含正确的槽位引用与实参绑定) */
function goodAgent(stage: Stage, _attempt: number, cfg: RunConfig): void {
  const R = cfg.runDir;
  const base = { summary: "ok", gaps: [] as unknown[], evidence_ids: [] as string[], calculation_ids: [] as string[] };
  if (stage === "profile") writeJson(path.join(R, "stages", "profile.json"), { stage, status: "complete", ...base, evidence_ids: [QUOTE.price], quote_decision: "normal", quote_decision_reason: "r", moat_tag: "待补" });
  if (stage === "financials") {
    FIN_CALCS.forEach(([fn, n, refs, inputs, out], i) => writeJson(path.join(R, "calcs", `0${i + 1}_${fn}.json`), CALC(fn, cid(n), refs, inputs, out)));
    writeJson(path.join(R, "stages", "financials.json"), { stage, status: "complete", ...base, evidence_ids: [FIN.rev, FIN.par, FIN.ded], calculation_ids: FIN_CALCS.map(([, n]) => cid(n)) });
  }
  if (stage === "estimates") {
    EST_CALCS.forEach(([fn, n, refs, inputs, out]) => writeJson(path.join(R, "calcs", `${n}_${fn}.json`), CALC(fn, cid(n), refs, inputs, out)));
    writeJson(path.join(R, "stages", "estimates.json"), { stage, status: "complete", ...base, evidence_ids: [EST.m26, EST.m28, EST.min, EST.max], calculation_ids: [cid(10), cid(11)] });
  }
  if (stage === "valuation") {
    VAL_CALCS.forEach(([fn, n, refs, inputs, out], i) => writeJson(path.join(R, "calcs", `2${i}_${fn}.json`), CALC(fn, cid(n), refs, inputs, out)));
    writeJson(path.join(R, "stages", "valuation.json"), { stage, status: "complete", ...base, evidence_ids: [QUOTE.cap, QUOTE.price, PEH], calculation_ids: VAL_CALCS.map(([, n]) => cid(n)),
      standard_columns: { pe_deducted_x4: cid(20), forward_pe: cid(21), pe_ttm_percentile: cid(23), peg: cid(24), forward_cagr: cid(10), ttm_yoy: cid(6), qoq: cid(7) } });
  }
  if (stage === "risk") writeJson(path.join(R, "stages", "risk.json"), { stage, status: "complete", ...base, counter_evidence: [{ claim: "c", counter: "x", evidence_ids: [QUOTE.price] }],
    decision_points: [{ what_would_change: "a", next_data_point: "b" }, { what_would_change: "a", next_data_point: "b" }, { what_would_change: "a", next_data_point: "b" }], source_conflicts: [] });
  if (stage === "report") {
    fs.writeFileSync(path.join(R, "report.md"), `# 测试(SZ:300308)研究报告 · 状态:complete\n\n> PE 分位口径：当前值来源 tencent；历史序列来源 tencent；跨来源或不同财务口径的分位仅供对照，不代表同源精确比较。[${cid(23)}]\n\n## 结论摘要\n- ok\n## 事实\n- 现价 943 元(${QUOTE.price})\n## 推断\n## 估值\n- 扣非×4 PE 1.5 倍(${cid(20)})\n## 风险与反证\n## 裁决点\n## 数据缺口\n`);
    writeJson(path.join(R, "stages", "report.json"), { stage, status: "complete", ...base, evidence_ids: [QUOTE.price], calculation_ids: [cid(20), cid(23)] });
  }
}

const okVerify = () => ({ ok: true, errors: [], warnings: [] });
const deps = (runner: AgentRunner, fetchRunner: FetchExecutor) => ({ runner, fetchRunner, verify: okVerify, sdkVersion: () => ({ version: "fake 0.0", binary: null }) });


test("同步最终校验后仍先检查取消，再开始归档", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cancel-finalization", endpointScope: "core" });
  const ac = new AbortController();
  const runner = new FakeRunner(goodAgent, cfg);
  let closing = 0;
  try {
    await assert.rejects(runResearch(cfg, { ...deps(runner, fakeFetch()), signal: ac.signal,
      beginFinalization: () => { closing += 1; ac.abort(new Error("用户取消研究")); },
    }, ["profile"]), /用户取消研究/);
    assert.equal(closing, 1);
    assert.equal(runner.logs.some((e) => ["viewer.written", "knowledge.archived", "report.ready", "run.finished"].includes(e.type)), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
    assert.equal(manifest.cancelled, true);
    const events = fs.readFileSync(path.join(cfg.runDir, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const finished = events.filter(e => e.type === "research.finished").at(-1);
    assert.equal(finished?.status, "cancelled");
    assert.equal(manifest.stages[0].status, "complete");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("取消发生在取数后时不调用模型、不归档，保留取消终态", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cancel-fetch", endpointScope: "core" });
  const ac = new AbortController();
  const runner = new FakeRunner(goodAgent, cfg);
  const fetcher: FetchExecutor = (...args) => {
    const result = fakeFetch()(...args);
    ac.abort(new Error("用户取消研究"));
    return result;
  };
  try {
    await assert.rejects(runResearch(cfg, { ...deps(runner, fetcher), signal: ac.signal }), /用户取消研究/);
    assert.equal(runner.calls.length, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.cancelled, true);
    assert.ok(manifest.finished_at);
    assert.equal(manifest.knowledge_archived ?? null, null);
    assert.ok(fs.existsSync(path.join(cfg.runDir, "fetch", "_ledger.json")));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("模型返回后收到取消不重试、不开始下一阶段；已完成阶段仍在", async () => {
  const repo = tmpRepo();
  const ac = new AbortController();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "cancel-turn", endpointScope: "core" });
  const runner = new FakeRunner((stage, attempt, config) => {
    goodAgent(stage, attempt, config);
    if (stage === "financials") ac.abort(new Error("用户取消研究"));
  }, cfg);
  try {
    await assert.rejects(runResearch(cfg, { ...deps(runner, fakeFetch()), signal: ac.signal }), /用户取消研究/);
    assert.deepEqual(runner.calls.map((call) => call.stage), ["profile", "financials"]);
    const m = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
    assert.equal(m.cancelled, true);
    assert.equal(m.stages[0].stage, "profile"); assert.equal(m.stages[0].status, "complete");
    assert.equal(fs.existsSync(path.join(cfg.runDir, "report.md")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const [failure, code, attempts] of [
  ["You've hit your usage limit", "quota", 1],
  ["401 Unauthorized", "authentication", 1],
  ["turn 超时(1000 ms)", "timeout", 2],
  ["429 Too Many Requests", "rate_limit", 2],
] as const) test(`研究 ${code} 停在故障阶段并保留之前产物`, async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: `stop-${code}`, endpointScope: "core", maxRetries: 1 });
  class FailingRunner extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      const out = await super.runTurn(stage, attempt, prompt);
      return { ...out, failed: stage === "financials" ? failure : null };
    }
  }
  const runner = new FailingRunner((stage, attempt, cfg) => {
    if (stage === "profile") goodAgent(stage, attempt, cfg);
  }, cfg);
  try {
    const result = await runResearch(cfg, deps(runner, fakeFetch()));
    assert.equal(result.status, "failed");
    assert.equal(result.manifest.failure_code, code);
    assert.deepEqual(runner.calls.map(c => c.stage), ["profile", ...Array(attempts).fill("financials")]);
    assert.deepEqual(result.manifest.stages.map(s => s.status), ["complete", "failed"]);
    assert.ok(fs.existsSync(path.join(cfg.runDir, "stages/profile.json")));
    assert.ok(result.manifest.evidence_count > 0);
    assert.equal(result.manifest.knowledge_archived, null);
    assert.deepEqual(validateManifest(result.manifest), []);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("超时与不可修复的取数契约同时出现，不继续后续阶段", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "mixed-failure", endpointScope: "core", maxRetries: 1 });
  class TimeoutRunner extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      return { ...await super.runTurn(stage, attempt, prompt), failed: "turn 超时(1000 ms)" };
    }
  }
  const runner = new TimeoutRunner(goodAgent, cfg);
  const fetcher: FetchExecutor = async (...args) => {
    const ledger = await fakeFetch()(...args);
    const file = path.join(cfg.runDir, "fetch/fetch_quote.json");
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    envelope.fetched_at = 123;
    writeJson(file, envelope);
    ledger.fetch_quote.sha256 = sha256File(file);
    return ledger;
  };
  try {
    const result = await runResearch(cfg, deps(runner, fetcher));
    assert.equal(result.status, "failed");
    assert.equal(result.manifest.failure_code, "timeout");
    assert.deepEqual(runner.calls.map(c => c.stage), ["profile"]);
    assert.ok(result.manifest.final_errors?.some(e => e.includes("不符契约")));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("一次超时后成功恢复，继续后续阶段且不残留失败标签", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "recovered-timeout", endpointScope: "core", maxRetries: 1 });
  class RecoveringRunner extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      return { ...await super.runTurn(stage, attempt, prompt), failed: stage === "profile" && attempt === 1 ? "timeout" : null };
    }
  }
  try {
    const result = await runResearch(cfg, deps(new RecoveringRunner(goodAgent, cfg), fakeFetch()));
    assert.equal(result.status, "complete");
    assert.equal(result.manifest.failure_code, undefined);
    assert.equal(result.manifest.stages[0].attempts, 2);
    assert.equal(result.manifest.stages.length, 6);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const isAgent of [true, false]) test(`异常只分类执行器，不误认来源错误 (${isAgent})`, async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: `exception-${isAgent}`, endpointScope: "core" });
  class ThrowingRunner extends FakeRunner {
    override async runTurn(): Promise<TurnOutcome> { throw new LocalAgentError("agent_not_authenticated", "登录失效"); }
  }
  const fetcher: FetchExecutor = () => { throw new Error("数据源 429 timeout"); };
  try {
    await assert.rejects(runResearch(cfg, deps(new ThrowingRunner(goodAgent, cfg), isAgent ? fakeFetch() : fetcher)));
    const m = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
    assert.equal(m.failure_code, isAgent ? "authentication" : undefined);
    assert.equal(m.final_errors.some((s: string) => s.startsWith("execution:authentication:")), isAgent);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("成稿执行失败但遗留正文校验通过，最终仍失败且不归入知识库", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "report-worker-failed", endpointScope: "core", maxRetries: 0 });
  class ReportFailure extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      const out = await super.runTurn(stage, attempt, prompt);
      return { ...out, failed: stage === "report" ? "worker exited unexpectedly" : null };
    }
  }
  try {
    const result = await runResearch(cfg, deps(new ReportFailure(goodAgent, cfg), fakeFetch()));
    assert.equal(result.manifest.stages.at(-1)?.validator_ok, true);
    assert.equal(result.manifest.stages.at(-1)?.status, "failed");
    assert.equal(result.status, "failed");
    assert.equal(result.manifest.knowledge_archived, null);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("🔴 报告里没引 id、本次数据里也找不到的数字:交付前遮掉,开头说明,整次标不完整;有出处的照常保留(审计 A5)", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "unverified-mask", python: "false" });
  const agent = (stage: Stage, attempt: number, c: RunConfig) => {
    goodAgent(stage, attempt, c);
    if (stage !== "report") return;
    // 写在「结论摘要」里(「数据缺口」一节本来就不查)
    const file = path.join(c.runDir, "report.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## 结论摘要\n- ok\n", "## 结论摘要\n- ok\n- 行业平均增速约 37.42%,远高于同行。\n- 现价 943 元,与前文一致。\n- 若按 25.5 倍估算只是情景。\n"));
  };
  try {
    const r = await runResearch(cfg, deps(new FakeRunner(agent, cfg), fakeFetch()));
    const report = fs.readFileSync(path.join(cfg.runDir, "report.md"), "utf8");
    assert.deepEqual([r.status, r.manifest.final_errors, r.manifest.stages.map((x) => [x.stage, x.status, x.errors])], ["incomplete", [], r.manifest.stages.map((x) => [x.stage, "complete", []])]);
    assert.equal(r.exitCode, 2);
    assert.equal(r.manifest.unverified_numbers, 1);
    assert.deepEqual(validateManifest(r.manifest), []);
    assert.equal(report.split("\n").slice(1, 3).join("\n"), "\n> 有 1 处数字在本次取到的数据和计算里找不到出处，已替换为〔未核实〕，本报告因此标为不完整。");
    assert.match(report.split("\n")[0], /状态:incomplete$/);
    assert.ok(report.includes("行业平均增速约 〔未核实〕%,远高于同行。"), report);
    assert.ok(!report.includes("37.42"));
    assert.ok(report.includes("现价 943 元,与前文一致。"), "本次证据里有的数不遮");
    assert.ok(report.includes("若按 25.5 倍估算只是情景。"), "写明是假设 / 情景的不遮");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("🔴 引了用户资料的行:资料片段里的数不遮,编的照遮,引用本身保持完整(v2.2.0 审计 Opus 第 1 条)", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "library-mask", python: "false", knowledgeRecall: true });
  const rec = await addReport(cfg.dataRoot, { name: "300308-券商测算.md", content: Buffer.from("公司代码 300308。券商测算 2026 年营收 120.5 亿元。", "utf8").toString("base64") });
  const cite = `[资料:${rec.id} p.-]`;
  const agent = (stage: Stage, attempt: number, c: RunConfig) => {
    goodAgent(stage, attempt, c);
    if (stage !== "report") return;
    const file = path.join(c.runDir, "report.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("## 结论摘要\n- ok\n", `## 结论摘要\n- ok\n- 券商测算营收 120.5 亿元 ${cite}\n- 券商测算净利 33.33 亿元 ${cite}\n`));
  };
  try {
    const r = await runResearch(cfg, deps(new FakeRunner(agent, cfg), fakeFetch()));
    const report = fs.readFileSync(path.join(cfg.runDir, "report.md"), "utf8");
    assert.deepEqual(r.manifest.user_reports, [{ id: rec.id, name: "300308-券商测算.md", page: null }]);
    assert.equal(r.manifest.unverified_numbers, 1);
    assert.ok(report.includes(`券商测算营收 120.5 亿元 ${cite}`), report);
    assert.ok(report.includes(`券商测算净利 〔未核实〕 亿元 ${cite}`), report);
    assert.deepEqual([r.status, r.manifest.final_errors], ["incomplete", []]);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("happy path:六阶段一次通过 → complete,exit 0,manifest 过 schema", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t1", python: "false" });
  const runner = new FakeRunner(goodAgent, cfg);
  const r = await runResearch(cfg, deps(runner, fakeFetch()));
  assert.equal(r.status, "complete");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(validateManifest(r.manifest), []);
  assert.equal(r.manifest.unverified_numbers, 0);
  assert.equal(r.manifest.stages.length, 6);
  assert.ok(r.manifest.stages.every((s) => s.status === "complete" && s.validator_ok && s.attempts === 1));
  assert.equal(runner.calls.length, 6);
  assert.ok(fs.existsSync(path.join(cfg.runDir, "evidence.json")) && fs.existsSync(path.join(cfg.runDir, "calculations.json")) && fs.existsSync(path.join(cfg.runDir, "conflicts.json")));
  assert.equal(r.manifest.evidence_count, 15);
  assert.equal(Object.keys(r.manifest.fetch_ledger).length, 8);
  // 注入 runner、没有选大脑:不写来源,也不声明执行保障(没有大脑就没有可声明的保障)
  assert.equal(r.manifest.provider, null);
  assert.deepEqual(r.manifest.engine, { kind: "none", binary: null });
  // 方法论:每个 turn 的提示词都带宪法全文与本阶段手册;manifest 记的就是注入的那一份
  for (const call of runner.calls) {
    assert.ok(call.prompt.includes("<<<CONSTITUTION_BEGIN>>>") && call.prompt.includes("测试宪法"), `${call.stage} 缺宪法`);
    for (const name of STAGE_SKILLS[call.stage]!) assert.ok(call.prompt.includes(`测试手册 ${name}`), `${call.stage} 缺手册 ${name}`);
    assert.ok(call.prompt.includes("<<<CALC_SPEC_BEGIN>>>") && call.prompt.includes("测试计算契约"), `${call.stage} 缺计算函数契约`);
  }
  assert.deepEqual(r.manifest.constitution, { path: path.join(repo, CONSTITUTION_REL), sha256: crypto.createHash("sha256").update(CONSTITUTION).digest("hex") });
  assert.deepEqual(r.manifest.stop_guard, { blocks: 0, terminations: 0 });
  const types = runner.logs.map((l) => l.type);
  assert.ok(types.includes("research.started") && types.includes("report.ready") && types.includes("research.finished"));
  assert.equal(types.filter((t) => t === "stage.completed").length, 6);
  assert.ok(!types.includes("gate.failed"));
});

test("防篡改登记:研究结束(成功、异常都算)各登记一条,登记的是收尾后的内容;目录名和 run id 不一致不登记", async () => {
  const repo = tmpRepo();
  try {
    const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "seal-ok", python: "false" });
    const runner = new FakeRunner(goodAgent, cfg);
    assert.equal((await runResearch(cfg, deps(runner, fakeFetch()))).status, "complete");
    assert.equal(runner.logs.filter((l) => l.type === "audit.sealed").length, 1);
    assert.ok(!runner.logs.some((l) => l.type === "audit.seal_failed"));
    let chain = parseChain(fs.readFileSync(chainFile(cfg.dataRoot), "utf8"));
    assert.deepEqual(chain.entries.map((e) => [e.ref, e.action]), [["seal-ok", "seal"]]);
    const files = Object.keys(chain.entries[0]!.files ?? {});
    for (const f of ["manifest.json", "report.md", "evidence.json", "calculations.json", "conflicts.json", "stages/report.json"]) assert.ok(files.includes(f), `缺 ${f}`);
    assert.ok(files.some((f) => f.startsWith("raw/")) && files.some((f) => f.startsWith("fetch/")));
    assert.ok(!files.includes("events.jsonl"), "过程日志不算内容");
    // 附录和查看器在登记之前就写好了,界面直接给人看 ⇒ 也登记
    for (const f of ["viewer.html", "report_appendix.md"]) assert.ok(files.includes(f) && fs.existsSync(path.join(cfg.runDir, f)), `缺 ${f}`);
    const snap = { runs: new Map([["seal-ok", { dir: cfg.runDir, finished: true }]]), ledger: new Map() };
    assert.deepEqual(verifyAudit(cfg.dataRoot, snap).issues, [], "登记之后什么都没再改");

    const boomCfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "seal-boom", python: "false" });
    const boom: FetchExecutor = () => { throw new Error("取数执行器炸了"); };
    await assert.rejects(runResearch(boomCfg, deps(new FakeRunner(goodAgent, boomCfg), boom)), /取数执行器炸了/);
    chain = parseChain(fs.readFileSync(chainFile(cfg.dataRoot), "utf8"));
    assert.deepEqual(chain.entries.map((e) => [e.ref, e.action, e.seq]), [["seal-ok", "seal", 1], ["seal-boom", "seal", 2]]);
    assert.equal(chain.problems.length, 0);

    // 目录名和 run id 不一致:核对按目录名找运行,登记了也对不上 ⇒ 不登记(核对会把它列成「没登记」)
    const odd = { ...makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "seal-odd", python: "false" }), runDir: path.join(cfg.dataRoot, "runs", "other-name") };
    await runResearch(odd, deps(new FakeRunner(goodAgent, odd), fakeFetch()));
    assert.equal(parseChain(fs.readFileSync(chainFile(cfg.dataRoot), "utf8")).entries.length, 2);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

/** 经过模板解析的模型 API(不含 key);base URL 带租户路径,用来验证记账只留主机 */
const API_INFO: RunApiInfo = { provider: "mimo", label: "小米 MiMo", baseURL: "https://gw.example.com/tenant-abc/v1", model: "mimo-v2.6-flash",
  structuredOutput: "prompt", verified: false, envKey: "MIMO_API_KEY" };

test("模型 API 运行:manifest 记实际模型、来源与执行保障;端点只记主机,租户路径不进 manifest 与事件", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "direct-runtime", python: "false", api: API_INFO });
  assert.equal(cfg.engine, "direct");
  const runner = new FakeRunner(goodAgent, cfg);
  runner.threadId = null;
  try {
    const r = await runResearch(cfg, { runner, fetchRunner: fakeFetch(), verify: okVerify,
      sdkVersion: () => ({ kind: "direct" as const, version: "direct-api/mimo/mimo-v2.6-flash", binary: null, model: "mimo-v2.6-flash" }) });
    assert.equal(r.status, "complete");
    assert.equal(r.manifest.model, "mimo-v2.6-flash");
    assert.equal(r.manifest.model_note, "模型 API 模板的默认模型");
    assert.equal(r.manifest.engine_version, "direct-api/mimo/mimo-v2.6-flash");
    // 能力声明按来源实测记录推导:没实测过 ⇒ 结构化约束只能写进提示词,界面要如实区分
    assert.deepEqual(r.manifest.engine, { kind: "direct", binary: null, capabilities: directCapabilities("prompt") });
    assert.deepEqual(r.manifest.provider, { name: "mimo", wire_api: "chat", base_url: "https://gw.example.com", env_key: "MIMO_API_KEY",
      auth: "api_key", profile: "mimo", matrix_status: "untested" });
    assert.deepEqual(validateManifest(r.manifest), []);
    const events = fs.readFileSync(path.join(cfg.runDir, "events.jsonl"), "utf8");
    assert.ok(!events.includes("tenant-abc") && !JSON.stringify(r.manifest).includes("tenant-abc"), "租户路径不进事件与 manifest");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

for (const agent of ["claude", "codex", "codebuddy"] as const) test(`本机订阅 Agent(${agent}) 运行:manifest 记订阅来源与执行保障,CLI 不回报模型就写未知、不编造`, async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: `local-${agent}`, python: "false", localAgent: agent });
  assert.equal(cfg.engine, "local_agent");
  try {
    const r = await runResearch(cfg, { runner: new FakeRunner(goodAgent, cfg), fetchRunner: fakeFetch(), verify: okVerify,
      sdkVersion: () => ({ kind: "local_agent" as const, version: `${agent}/9.9.9`, binary: null, model: null }) });
    assert.equal(r.status, "complete");
    assert.equal(r.manifest.model, null);
    assert.match(r.manifest.model_note, /已登录 CLI 决定/);
    assert.equal(r.manifest.engine_version, `${agent}/9.9.9`);
    assert.deepEqual(r.manifest.engine, { kind: "local_agent", binary: null, capabilities: localAgentCapabilities() });
    assert.deepEqual(r.manifest.provider, { name: `cli-${agent}`, wire_api: "cli_subscription", base_url: null, env_key: "",
      auth: "subscription_login", profile: `cli-${agent}`, matrix_status: null });
    assert.deepEqual(validateManifest(r.manifest), []);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("必需取数失败 → 阶段 incomplete → 运行 incomplete(exit 2);三个关键脚本全失败 → failed", async () => {
  let repo = tmpRepo();
  let cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t2", python: "false" });
  const honest: Behaviour = (stage, attempt, c) => {
    if (stage === "estimates") {
      writeJson(path.join(c.runDir, "stages", "estimates.json"), { stage, status: "incomplete", summary: "源失败", evidence_ids: [], calculation_ids: [],
        gaps: [{ operation: "fetch_estimates", reason_code: "source_failed", detail: "x" }, { operation: "forward_cagr", reason_code: "upstream_missing", detail: "x" }, { operation: "consensus_dispersion", reason_code: "upstream_missing", detail: "x" }] });
      return;
    }
    if (stage === "valuation") { // 没有一致预期 → 只做不依赖它的三项,其余写结构化 gaps
      const keep = VAL_CALCS.filter(([fn]) => ["pe_deducted_annualized", "pe_ttm_from_parts", "percentile_rank"].includes(fn));
      keep.forEach(([fn, n, refs, inputs, out], i) => writeJson(path.join(c.runDir, "calcs", `2${i}_${fn}.json`), CALC(fn, cid(n), refs, inputs, out)));
      const gaps = ["forward_pe", "peg", "pe_digestion_scenarios", "forward_vs_ttm_judgement"].map((o) => ({ operation: o, reason_code: "upstream_missing", detail: "无一致预期" }));
      writeJson(path.join(c.runDir, "stages", "valuation.json"), { stage, status: "incomplete", summary: "部分", evidence_ids: [QUOTE.cap], calculation_ids: keep.map(([, n]) => cid(n)), gaps,
        standard_columns: { pe_deducted_x4: cid(20), forward_pe: "未获取:无一致预期", pe_ttm_percentile: cid(23), peg: "未获取:无一致预期", forward_cagr: "未获取:无一致预期", ttm_yoy: cid(6), qoq: cid(7) } });
      return;
    }
    goodAgent(stage, attempt, c);
  };
  let r = await runResearch(cfg, deps(new FakeRunner(honest, cfg), fakeFetch(["fetch_estimates"])));
  assert.equal(r.status, "incomplete");
  assert.equal(r.exitCode, 2);
  assert.equal(r.manifest.stages.find((s) => s.stage === "estimates")?.status, "incomplete");
  repo = tmpRepo();
  cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t2b", python: "false" });
  const honest2: Behaviour = (stage, attempt, c) => {
    const failing: Record<string, { script: string; calcs: string[] }> = {
      profile: { script: "fetch_quote", calcs: [] },
      financials: { script: "fetch_financials", calcs: ["quarterize", "latest_quarter", "ttm_sum", "ttm_yoy", "qoq"] },
      estimates: { script: "fetch_estimates", calcs: ["forward_cagr", "consensus_dispersion"] },
    };
    const f = failing[stage];
    if (!f) { goodAgent(stage, attempt, c); return; }
    const so: Record<string, unknown> = { stage, status: "incomplete", summary: "源失败", evidence_ids: [], calculation_ids: [],
      gaps: [{ operation: f.script, reason_code: "source_failed", detail: "x" }, ...f.calcs.map((o) => ({ operation: o, reason_code: "upstream_missing", detail: "x" }))] };
    if (stage === "profile") Object.assign(so, { quote_decision: "unknown_unverified", quote_decision_reason: "quote 失败", moat_tag: "待补" });
    writeJson(path.join(c.runDir, "stages", `${stage}.json`), so);
  };
  r = await runResearch(cfg, deps(new FakeRunner(honest2, cfg), fakeFetch(["fetch_quote", "fetch_financials", "fetch_estimates"])));
  assert.equal(r.status, "failed");
  assert.equal(r.exitCode, 3);
});

test("validator 不过 → 自动补跑并把报错带进提示词;仍不过 → 阶段 failed → 运行 failed", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t3", python: "false", maxRetries: 1 });
  const sloppy: Behaviour = (stage, attempt, c) => {
    goodAgent(stage, attempt, c);
    if (stage === "profile" && attempt === 1) writeJson(path.join(c.runDir, "stages", "profile.json"), { stage, status: "complete", summary: "x", evidence_ids: ["ev-ffffff"], calculation_ids: [], gaps: [], quote_decision: "normal", quote_decision_reason: "r", moat_tag: "待补" });
    if (stage === "risk") fs.rmSync(path.join(c.runDir, "stages", "risk.json"), { force: true }); // 永远写不出 risk
  };
  const runner = new FakeRunner(sloppy, cfg);
  const r = await runResearch(cfg, deps(runner, fakeFetch()));
  const profileCalls = runner.calls.filter((x) => x.stage === "profile");
  assert.equal(profileCalls.length, 2);
  assert.ok(profileCalls[1].prompt.includes("【补跑 第 1 次】") && profileCalls[1].prompt.includes("ev-ffffff"));
  assert.equal(r.manifest.stages.find((s) => s.stage === "profile")?.status, "complete");
  assert.equal(r.manifest.stages.find((s) => s.stage === "risk")?.status, "failed");
  assert.equal(r.status, "failed");
});

test("合规 gate 命中 → 重写 → 复验通过 → complete;报告首行状态与推导不一致时被归一", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t4", python: "false", maxRetries: 0 }); // 不给阶段级补跑机会,迫使走 gate 重写循环
  let rewrites = 0;
  const tempted: Behaviour = (stage, attempt, c) => {
    if (attempt < 100) goodAgent(stage, attempt, c);
    const rp = path.join(c.runDir, "report.md");
    if (stage === "report" && attempt === 1) fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- ok", "- 建议建仓").replace("状态:complete", "状态:incomplete"));
    if (stage === "report" && attempt >= 100) { rewrites++; fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- 建议建仓", "- 数据 / 框架 / 裁决点")); }
  };
  const runner = new FakeRunner(tempted, cfg);
  const r = await runResearch(cfg, deps(runner, fakeFetch()));
  assert.equal(rewrites, 1);
  assert.ok(runner.logs.some((l) => l.type === "gate.failed"));
  assert.equal(r.manifest.gate.ok, true);
  assert.equal(r.status, "complete");
  assert.ok(fs.readFileSync(path.join(cfg.runDir, "report.md"), "utf8").startsWith("# 测试(SZ:300308)研究报告 · 状态:complete"));
  assert.ok(runner.logs.some((l) => l.type === "report.status_normalized"));
});

for (const failure of ["stream error: 模拟", "timeout", "usage limit"]) test(`gate 重写失败保留原因，即使正文已修好 (${failure})`, async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t4b", python: "false", maxRetries: 0, gateRetries: 3 });
  const tempted: Behaviour = (stage, attempt, c) => {
    if (attempt < 100) goodAgent(stage, attempt, c);
    const rp = path.join(c.runDir, "report.md");
    if (stage === "report" && attempt === 1) fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- ok", "- 建议建仓"));
    if (stage === "report" && attempt >= 100) fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- 建议建仓", "- ok")); // 文件修好了,但 turn 本身报失败
  };
  class FailingRewrite extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      const o = await super.runTurn(stage, attempt, prompt);
      return attempt >= 100 ? { ...o, failed: failure } : o;
    }
  }
  const r = await runResearch(cfg, deps(new FailingRewrite(tempted, cfg), fakeFetch()));
  assert.equal(r.manifest.gate.ok, true);
  assert.equal(r.manifest.stages.find((s) => s.stage === "report")?.status, "failed");
  assert.equal(r.status, "failed");
  assert.equal(r.exitCode, 3);
  assert.equal(r.manifest.failure_code, failure === "timeout" ? "timeout" : failure === "usage limit" ? "quota" : undefined);
  assert.ok(r.manifest.stages.find((s) => s.stage === "report")?.errors.includes(`gate 重写 turn 失败:${failure}`), "重写轮的失败原因留在报告阶段的错误里");
});

test("gate 重写那一轮被收工检查终止 → 原因留在报告阶段的错误里,不被重写后的校验结果冲掉", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t4c", python: "false", maxRetries: 0 });
  const tempted: Behaviour = (stage, attempt, c) => {
    if (attempt < 100) goodAgent(stage, attempt, c);
    const rp = path.join(c.runDir, "report.md");
    if (stage === "report" && attempt === 1) fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- ok", "- 建议建仓"));
    if (stage === "report" && attempt >= 100) fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("- 建议建仓", "- ok")); // 正文修好了,但这一轮被收工检查终止
  };
  const reason = "收工检查:重写轮连续拦截已达上限";
  class StoppedRewrite extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      const o = await super.runTurn(stage, attempt, prompt);
      return attempt >= 100 ? { ...o, stopGuard: { blocks: 3, terminated: reason } } : o;
    }
  }
  const r = await runResearch(cfg, deps(new StoppedRewrite(tempted, cfg), fakeFetch()));
  const rep = r.manifest.stages.find((s) => s.stage === "report");
  assert.equal(r.manifest.gate.ok, true);
  assert.equal(rep?.status, "failed");
  assert.ok(rep?.errors.includes(reason), `收工检查的终止原因不见了:${JSON.stringify(rep?.errors)}`);
  assert.equal(r.manifest.stop_guard.terminations, 1);
  assert.equal(r.status, "failed");
});

test("agent 篡改取数文件(连同磁盘账本) → 内存账本识破 → 阶段 failed → 运行 failed;agent 自写 raw 文件同样被识破", async () => {
  let repo = tmpRepo();
  let cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t5", python: "false", maxRetries: 0 });
  const tamper: Behaviour = (stage, attempt, c) => {
    goodAgent(stage, attempt, c);
    if (stage === "profile") {
      const f = path.join(c.runDir, "fetch", "fetch_quote.json");
      const env = JSON.parse(fs.readFileSync(f, "utf8"));
      env.evidence[0].value = 1; // 改价格
      writeJson(f, env);
      const led = JSON.parse(fs.readFileSync(path.join(c.runDir, "fetch", "_ledger.json"), "utf8"));
      led.fetch_quote.sha256 = sha256File(f); // 连磁盘账本一起改
      writeJson(path.join(c.runDir, "fetch", "_ledger.json"), led);
    }
  };
  let r = await runResearch(cfg, deps(new FakeRunner(tamper, cfg), fakeFetch()));
  assert.equal(r.manifest.stages[0].status, "failed");
  assert.ok(r.manifest.stages[0].errors.some((e) => e.includes("sha256 不一致")));
  assert.equal(r.status, "failed");
  repo = tmpRepo();
  cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t5b", python: "false", maxRetries: 0 });
  const rawWriter: Behaviour = (stage, attempt, c) => { goodAgent(stage, attempt, c); if (stage === "profile") fs.writeFileSync(path.join(c.runDir, "raw", "forged.json"), "{}"); };
  r = await runResearch(cfg, deps(new FakeRunner(rawWriter, cfg), fakeFetch()));
  assert.ok(r.manifest.stages[0].errors.some((e) => e.includes("raw/forged.json 未经编排器取数记录")));
  assert.equal(r.status, "failed");
});

test("受保护产物认证:agent 改写 events.jsonl / conflicts.json → 阶段 failed → 运行 failed", async () => {
  let repo = tmpRepo();
  let cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t7", python: "false", maxRetries: 0 });
  const evTamper: Behaviour = (stage, attempt, c) => { goodAgent(stage, attempt, c); if (stage === "financials") fs.appendFileSync(path.join(c.runDir, "events.jsonl"), JSON.stringify({ type: "forged" }) + "\n"); };
  let r = await runResearch(cfg, deps(new FakeRunner(evTamper, cfg), fakeFetch()));
  assert.ok(r.manifest.stages[1].errors.some((e) => e.includes("events.jsonl")), r.manifest.stages[1].errors.join("\n"));
  assert.equal(r.status, "failed");
  repo = tmpRepo();
  cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t7b", python: "false", maxRetries: 0 });
  const cfTamper: Behaviour = (stage, attempt, c) => { goodAgent(stage, attempt, c); if (stage === "risk") writeJson(path.join(c.runDir, "conflicts.json"), { id_conflicts: ["forged"], source_conflicts: [] }); };
  r = await runResearch(cfg, deps(new FakeRunner(cfTamper, cfg), fakeFetch()));
  assert.ok(r.manifest.stages.find((s) => s.stage === "risk")?.errors.some((e) => e.includes("conflicts.json")));
  assert.equal(r.status, "failed");
});

test("收工检查终止本轮 → 该 turn 判失败:有补跑机会就补跑,补跑成功阶段 complete;manifest 累计拦截与终止次数", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t8", python: "false", maxRetries: 1 });
  let first = true;
  class LazyOnce extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      if (stage === "financials" && first) { // 第一轮"偷懒":不写产物,大脑内的收工检查拦够次数后终止本轮
        first = false;
        this.calls.push({ stage, attempt, prompt });
        return { finalResponse: "", usage: null, commands: [], fileChanges: [], itemCount: 1, durationMs: 1, failed: null, threadId: this.threadId,
          stopGuard: { blocks: 2, terminated: "收工检查:缺产物 stages/financials.json" } };
      }
      return { ...await super.runTurn(stage, attempt, prompt), stopGuard: { blocks: 0, terminated: null } };
    }
  }
  const runner = new LazyOnce(goodAgent, cfg);
  try {
    const r = await runResearch(cfg, deps(runner, fakeFetch()));
    const fin = r.manifest.stages.find((s) => s.stage === "financials")!;
    assert.equal(fin.attempts, 2);
    assert.equal(fin.status, "complete");
    assert.deepEqual(r.manifest.stop_guard, { blocks: 2, terminations: 1 });
    assert.ok(runner.logs.some((l) => l.type === "stop_guard.summary"));
    assert.equal(r.status, "complete");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("🔴 收工检查终止的 turn,即使产物恰好过了校验也不算完成(不给补跑就是 failed)", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t8b", python: "false", maxRetries: 0 });
  class Terminated extends FakeRunner {
    override async runTurn(stage: Stage, attempt: number, prompt: string): Promise<TurnOutcome> {
      const out = await super.runTurn(stage, attempt, prompt);   // 产物照常写好
      return stage === "financials" ? { ...out, stopGuard: { blocks: 6, terminated: "收工检查:连续拦截已达上限" } } : out;
    }
  }
  try {
    const r = await runResearch(cfg, deps(new Terminated(goodAgent, cfg), fakeFetch()));
    const fin = r.manifest.stages.find((s) => s.stage === "financials")!;
    assert.equal(fin.validator_ok, true, "前提:产物本身是合格的");
    assert.equal(fin.status, "failed", "被收工检查终止的 turn 不许因为产物碰巧合格就算完成");
    assert.ok(fin.errors.some((e) => e.includes("连续拦截已达上限")));
    assert.equal(r.status, "failed");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("最终校验失败 → 状态降级为 failed(不得宣称完成)", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t6", python: "false", maxRetries: 0 });
  // report 阶段校验通过后,agent 在同一 turn 末尾偷偷再写一个不合契约的 calc(阶段校验只在 turn 后跑一次,这里模拟"校验后改动":直接在 verify 钩子里注入)
  let injected = false;
  const sneakyVerify = (c: RunConfig, run: { calcs: unknown[] }) => {
    if (!injected && fs.existsSync(path.join(c.runDir, "stages", "report.json"))) { injected = true; writeJson(path.join(c.runDir, "calcs", "99_bad.json"), { calculation_id: "calc-ffffffffffffffff", function: "x" }); }
    return okVerify();
  };
  const r = await runResearch(cfg, { runner: new FakeRunner(goodAgent, cfg), fetchRunner: fakeFetch(), verify: sneakyVerify as never, sdkVersion: () => ({ version: "fake", binary: null }) });
  assert.equal(r.status, "failed");
  assert.ok((r.manifest.final_errors ?? []).some((e) => e.startsWith("artifacts:")));
  assert.ok(fs.readFileSync(path.join(cfg.runDir, "report.md"), "utf8").startsWith("# 测试(SZ:300308)研究报告 · 状态:failed"));
});

test("环境隔离:取数子进程拿不到任何大脑的凭据与登录配置目录(白名单,而不是黑名单)", () => {
  const source = { PATH: "/bin", HOME: "/home/u", HTTPS_PROXY: "http://p",
    CODEX_API_KEY: "sk-a", CODEX_HOME: "/x/codex", OPENAI_API_KEY: "sk-b", ANTHROPIC_API_KEY: "sk-c", CLAUDE_CONFIG_DIR: "/x/claude",
    CODEBUDDY_API_KEY: "k-f", MIMO_API_KEY: "k-d", VRA_RUNTIME_API_KEY: "k-e", XDG_CONFIG_HOME: "/x/xdg", SOME_NEW_VENDOR_TOKEN: "t" };
  const fe = fetchEnv({}, source);
  assert.equal(fe.PATH, "/bin");
  assert.equal(fe.HTTPS_PROXY, "http://p");
  for (const k of ["CODEX_API_KEY", "CODEX_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CODEBUDDY_API_KEY",
    "MIMO_API_KEY", "VRA_RUNTIME_API_KEY", "XDG_CONFIG_HOME", "SOME_NEW_VENDOR_TOKEN"]) {
    assert.ok(!(k in fe), `取数环境不该有 ${k}`);
  }
});

test("部分阶段运行:状态至多 incomplete,manifest 标 partial_run", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "t5", python: "false" });
  const r = await runResearch(cfg, deps(new FakeRunner(goodAgent, cfg), fakeFetch()), ["profile", "financials"]);
  assert.equal(r.status, "incomplete");
  assert.equal(r.manifest.partial_run, true);
  assert.deepEqual(r.manifest.execution_scope, ["profile", "financials"]);
});

test("run-id / 运行目录保护:非法 id 抛错;非空目录不加 --overwrite 抛错;--overwrite 清空", async () => {
  assert.throws(() => makeConfig({ symbol: "1", repoRoot: "/tmp/r", runId: "../escape" }));
  assert.throws(() => makeConfig({ symbol: "1", repoRoot: "/tmp/r", runId: "a/b" }));
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "t6", python: "false" });
  fs.mkdirSync(cfg.runDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.runDir, "old.txt"), "x");
  assert.throws(() => prepareRunDir(cfg), /已存在且非空/);
  const cfg2 = makeConfig({ symbol: "300308", repoRoot: repo, runId: "t6", python: "false", overwrite: true });
  prepareRunDir(cfg2);
  assert.ok(!fs.existsSync(path.join(cfg2.runDir, "old.txt")));
  const cfg3 = makeConfig({ symbol: "300308", repoRoot: repo, runId: "t7", python: "false", runDir: "/tmp/elsewhere" });
  assert.throws(() => prepareRunDir(cfg3), /直接子目录/);
});

test("分离安装:数据根在产品根之外也能跑,且不往数据根复制任何指令文件;宪法缺失 → 抛错;manifest 记的就是写进提示词的那份宪法", async () => {
  const repo = tmpRepo();
  // 分离安装:数据根与产品根毫无路径关系(将来 /Applications + ~/Library/Application Support 就是这样)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vra-data-"));
  try {
    fs.mkdirSync(path.join(outside, "runs"), { recursive: true });
    const cfgOut = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, dataRoot: outside, runId: "o1", python: "false" });
    const runner = new FakeRunner(goodAgent, cfgOut);
    const rOut = await runResearch(cfgOut, deps(runner, fakeFetch()));
    assert.equal(rOut.status, "complete");
    assert.ok(runner.calls.every((c) => c.prompt.includes("测试宪法")), "宪法来自产品根,照样进每个阶段的提示词");
    // 大脑不再靠"在某个目录里自己发现 AGENTS.md / skills":数据根里不该出现任何指令资产
    for (const name of ["AGENTS.md", "CLAUDE.md", ".agents", ".vibe-research-root", "codex-home"]) {
      assert.equal(fs.existsSync(path.join(outside, name)), false, `数据根不该出现 ${name}`);
    }
    const cfgNoC = makeConfig({ symbol: "300308", repoRoot: repo, runId: "o2", python: "false", constitutionPath: path.join(repo, "NOPE.md") });
    assert.throws(() => prepareRunDir(cfgNoC), /宪法文件不存在/);
    // 换一份宪法:manifest 记的路径与 sha256 必须就是实际注入提示词的那份,而不是写死的产品根默认值
    const alt = path.join(repo, "methodology", "alt.md");
    fs.writeFileSync(alt, "# 另一份宪法\n");
    const cfgAlt = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "o3", python: "false", constitutionPath: alt });
    const altRunner = new FakeRunner(goodAgent, cfgAlt);
    const r = await runResearch(cfgAlt, deps(altRunner, fakeFetch()));
    assert.deepEqual(r.manifest.constitution, { path: alt, sha256: crypto.createHash("sha256").update("# 另一份宪法\n").digest("hex") });
    assert.ok(altRunner.calls.every((c) => c.prompt.includes("另一份宪法") && !c.prompt.includes("测试宪法")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("events 脱敏:已知密钥值与 sk- 形态在落盘前替换;摘要基于脱敏后内容", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ev-"));
  const log = new EventsLog(path.join(d, "events.jsonl"), ["supersecretvalue123"]);
  log.append({ type: "command", command: "echo supersecretvalue123 && echo sk-abcdefghijklmnop1234", output_tail: "supersecretvalue123" });
  const txt = fs.readFileSync(path.join(d, "events.jsonl"), "utf8");
  assert.ok(!txt.includes("supersecretvalue123") && !txt.includes("sk-abcdefghijklmnop1234"));
  assert.ok(txt.includes("[REDACTED]") && txt.includes("[REDACTED_KEY]"));
  assert.equal(sha256File(path.join(d, "events.jsonl")), log.digest());
});

test("events 脱敏:短密钥、含引号或反斜杠的密钥同样抹掉;JSON 与事件类型不被抹坏", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ev-short-"));
  try {
    const quoted = 'ab"cd\\efgh12';   // 整行 JSON 里它被转义成 ab\"cd\\efgh12,按行找不到
    const log = new EventsLog(path.join(d, "events.jsonl"), ["k9x", quoted, "direct", ""]);
    log.append({ type: "direct.request_failed", stage: "profile", error: `模型端点返回 401:invalid key k9x; echo ${quoted}`, note: "k9xy 与 direct 都在正文里" });
    const txt = fs.readFileSync(path.join(d, "events.jsonl"), "utf8");
    const rec = JSON.parse(txt) as Record<string, string>;
    assert.equal(rec.type, "direct.request_failed", "结构字段不做已知密钥替换");
    assert.ok(!/(^|[^A-Za-z0-9_-])k9x([^A-Za-z0-9_-]|$)/.test(rec.error!) && !rec.error!.includes(quoted), rec.error);
    assert.match(rec.error!, /\[REDACTED\]/);
    assert.ok(rec.note!.includes("k9xy"), "别的词里碰巧有同样几个字母不抹");
    assert.ok(!/(^|[^A-Za-z0-9_-])direct([^A-Za-z0-9_-]|$)/.test(rec.note!), "正文里独立出现的短密钥要抹");
    // 一个密钥恰是另一个更长密钥的开头:要先抹长的,否则长密钥只被抹掉前半、后半留在日志里
    const log2 = new EventsLog(path.join(d, "events2.jsonl"), ["abcdefgh", "abcdefgh12345678"]);
    log2.append({ type: "x", message: "key=abcdefgh12345678" });
    assert.ok(!fs.readFileSync(path.join(d, "events2.jsonl"), "utf8").includes("12345678"));
    assert.equal(sha256File(path.join(d, "events.jsonl")), log.digest());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("异常路径:取数执行器抛错 → research.failed / research.finished 仍写入,manifest 标 failed,异常继续抛出", async () => {
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "x1", python: "false" });
  const runner = new FakeRunner(goodAgent, cfg);
  const boom: FetchExecutor = () => { throw new Error("取数执行器炸了"); };
  await assert.rejects(runResearch(cfg, deps(runner, boom)), /取数执行器炸了/);
  const types = runner.logs.map((l) => l.type);
  assert.ok(types.includes("research.failed") && types.includes("research.finished"));
  const m = JSON.parse(fs.readFileSync(path.join(cfg.runDir, "manifest.json"), "utf8"));
  assert.equal(m.status, "failed");
});

test("deriveRunStatus 优先级与退出码", () => {
  const ok = stages().map((s) => ({ stage: s, status: "complete" as const, attempts: 1, errors: [], validator_ok: true }));
  const base = { stages: ok, gateOk: true, reportExists: true, quoteDecision: "normal", criticalAllFailed: false, partial: false };
  assert.equal(deriveRunStatus(base), "complete");
  assert.equal(deriveRunStatus({ ...base, quoteDecision: "stale" }), "stale");
  assert.equal(deriveRunStatus({ ...base, partial: true }), "incomplete");
  assert.equal(deriveRunStatus({ ...base, unverifiedNumbers: 2 }), "incomplete");
  assert.equal(deriveRunStatus({ ...base, unverifiedNumbers: 2, quoteDecision: "stale" }), "stale");
  assert.equal(deriveRunStatus({ ...base, gateOk: false }), "failed");
  assert.equal(deriveRunStatus({ ...base, reportExists: false }), "failed");
  assert.equal(deriveRunStatus({ ...base, criticalAllFailed: true }), "failed");
  assert.equal(deriveRunStatus({ ...base, stages: ok.map((s, i) => (i === 1 ? { ...s, status: "failed" as const } : s)) }), "failed");
  assert.equal(deriveRunStatus({ ...base, stages: ok.map((s, i) => (i === 1 ? { ...s, status: "incomplete" as const } : s)), quoteDecision: "stale" }), "stale");
  assert.equal(exitCodeFor("complete"), 0); assert.equal(exitCodeFor("stale"), 2); assert.equal(exitCodeFor("failed"), 3);
});

test("注册表:端点挂在不存在的阶段上必须当场拒绝(全审 r2-P1-4)", () => {
  const repo = tmpRepo();
  const regPath = path.join(repo, "datasources", "registry.json");
  const reg = JSON.parse(fs.readFileSync(path.join(REAL_REPO, "datasources", "registry.json"), "utf8"));
  writeJson(regPath, reg);
  assert.doesNotThrow(() => loadRegistry(repo), "真实注册表必须能过");
  // 拼错一个字母:旧实现会静默跳过,这个端点永远不执行而运行照样 complete
  reg.endpoints[0].stages = { estimte: "optional" };
  writeJson(regPath, reg);
  assert.throws(() => loadRegistry(repo), /挂在不存在的阶段 estimte/);
});

test("证据合并:同 id 但事实不同必须报冲突,不许静默折叠(全审 r1-P2-6)", () => {
  const base = { id: "ev-aaaaaa", symbol: "300308", market: "SZ", field: "close", value: 10,
    unit: "元", currency: "CNY", period: "2026-08-25", as_of: "2026-08-25", source: "s", endpoint: "e",
    fetched_at: TS, adjustment: "none", raw_ref: "raw/a.json" };
  const envOf = (evidence: unknown[]) => ({ script: "x", symbol: "300308", market: "SZ", status: "ok",
    fetched_at: TS, used_sources: [], evidence, extra: {}, errors: [] });

  // 同一条证据在两个信封里重复携带(只有元数据不同)⇒ 正常,不该报冲突
  const same = mergeEvidence({ a: envOf([base]) as never, b: envOf([{ ...base, fetched_at: "2026-08-25T11:00:00+08:00", raw_ref: "raw/b.json" }]) as never });
  assert.deepEqual(same.idConflicts, []);
  assert.equal(same.evidence.length, 1);

  // 🔴 口径不同(adjustment)但数值相同:旧实现只比 value ⇒ 不报冲突、静默丢掉一条
  const diffAdj = mergeEvidence({ a: envOf([base]) as never, b: envOf([{ ...base, adjustment: "qfq" }]) as never });
  assert.equal(diffAdj.idConflicts.length, 1, JSON.stringify(diffAdj.idConflicts));
  // 单位不同同理:「1 元」与「1 亿元」
  const diffUnit = mergeEvidence({ a: envOf([base]) as never, b: envOf([{ ...base, unit: "亿元" }]) as never });
  assert.equal(diffUnit.idConflicts.length, 1);
  // 值不同仍然报
  assert.equal(mergeEvidence({ a: envOf([base]) as never, b: envOf([{ ...base, value: 11 }]) as never }).idConflicts.length, 1);
});

test("🔴 模型 API 地址跳转(响应体还挂着):真实直连阶段执行器 → 编排只打一次就整次停下,不补跑、不等超时", { timeout: 120_000 }, async (t) => {
  // 这条刻意不用假 runner:跳转的"不可重试"要从传输层经阶段执行器一路传到编排器,
  // 中间任何一层丢了结构化故障码,编排都按文字认不出来而继续补跑(Codex 复审 R3-3)。
  const repo = tmpRepo();
  const cfg = makeConfig({ symbol: "300308", repoRoot: repo, runId: "redirect-stop", endpointScope: "core", maxRetries: 2 });
  let hits = 0;
  const sockets = new Set<Socket>();
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(302, { location: "http://127.0.0.1:9/v1/chat/completions", "content-length": "1000" });
    res.write("x");   // 故意不写完
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const runner = new DirectStageAgent({
    runId: cfg.runId, toolCtx: { runDir: cfg.runDir, repoRoot: cfg.repoRoot, python: cfg.python },
    api: { baseURL: `http://127.0.0.1:${port}/v1`, model: "m", structuredOutput: "prompt", verified: true },
    apiKey: "sk-test-abcdefghijklmnop", eventsPath: path.join(cfg.runDir, "events.jsonl"), requestTimeoutMs: 20_000,
  });
  // 清理挂在 t.after、不放 finally:整体超时只把测试判失败,不会打断下面的 await,finally 根本不执行,
  // 还在监听的 server 会让测试进程一直挂着(Codex 复审 R5-1,Node 26 实测)
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => { server.close(() => r()); });
    fs.rmSync(repo, { recursive: true, force: true });
  });
  // 不量墙钟(Codex 复审 R4-4):若先读响应体,每次都要等 20 秒超时、按 timeout 补跑,hits 与故障码两条都会红
  const result = await runResearch(cfg, deps(runner, fakeFetch()));
  assert.equal(result.status, "failed");
  assert.equal(result.manifest.failure_code, "endpoint_redirect");
  assert.equal(hits, 1, "不可重试:同一个跳转端点只打一次,不补跑、不进后续阶段");
  assert.deepEqual(result.manifest.stages.map((s) => [s.stage, s.status, s.attempts]), [["profile", "failed", 1]]);
  assert.deepEqual(validateManifest(result.manifest), []);
});
