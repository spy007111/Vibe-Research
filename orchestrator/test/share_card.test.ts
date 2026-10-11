import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { complianceGate } from "../src/gate.ts";
import { ServiceError, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { GAP_ORDER, mergeGaps, pickFacts, shareCard, shortTitle } from "../src/finance/share_card.ts";
import { GAP_KIND_LABEL, STATEMENT, shareSummary } from "../../desktop/src/verticals/finance/lib/shareCard.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type Row = Record<string, unknown>;
const ev = (id: string, field: string, value: unknown, unit: string, period: string, source: string): Row => ({ id, field, value, unit, period, source });

/** 一次「报告已通过最终校验」的研究;改 manifest / 文件用 patch */
const MANIFEST = {
  run_id: "r1", symbol: "300308", market: "SZ", status: "complete", exit_code: 0, gate: { ok: true }, final_errors: [],
  started_at: "2026-10-08T08:27:18+08:00", finished_at: "2026-10-08T08:52:58+08:00", evidence_count: 1014, calculation_count: 30,
  stages: [{ stage: "profile", status: "complete" }, { stage: "financials", status: "complete" }, { stage: "risk", status: "incomplete" }],
};
const EVIDENCE: unknown[] = [
  ev("ev-p1", "price", 800, "元", "2026-09-29", "tencent"),
  ev("ev-p2", "price", 808.44, "元", "2026-09-30", "tencent"),
  ev("ev-p3", "price", 808.44, "元", "2026-09-30", "eastmoney"),
  ev("ev-p4", "price", 810, "元", "2026-09-30", "eastmoney"),
  ev("ev-c1", "total_market_cap", 9522.69, "亿元", "2026-10-08", "tencent"),
  ev("ev-c2", "total_market_cap", 952269000000, "元", "2026-10-08", "eastmoney"),
  ev("ev-pe", "pe_ttm", 46.56, "倍", "2026-09-30", "tencent"),
  ev("ev-pe2", "pe_ttm", 99, "倍", "TTM", "tencent"),
  ev("ev-r1", "revenue_cum", 3e10, "元", "2025-12-31", "sina_abstract"),
  ev("ev-r2", "revenue_cum", 41777861795.03, "元", "2026-06-30", "sina_abstract"),
  ev("ev-r3", "revenue_cum", "NaN", "元", "2026-09-30", "sina_abstract"),
  ...[1, 2, 3, 4, 5].map((i) => ev(`ev-n${i}`, "net_profit_parent_cum", i * 1e9, "元", "2026-06-30", `src${i}`)),
  ev("ev-e6", "eps_consensus_mean", 28.81, "元/股", "FY2026", "ths"),
  ev("ev-e7", "eps_consensus_mean", 36.2, "元/股", "FY2027", "ths"),
  ev("ev-a6", "eps_analyst_count", 29, "家", "FY2026", "ths"),
  ev("ev-a7x", "eps_analyst_count", 8, "家", "FY2026", "other"),
  { id: "ev-s", field: "security_name", value: "中际旭创", source: "baostock", period: "2026-10-08" },
  "not an object",
];
const STAGES: Record<string, unknown> = {
  profile: { gaps: [
    { operation: "em_stock_info", reason_code: "source_failed", detail: "东财push2/stock/get连接中断，无证据" },
    { operation: "sw_industry", reason_code: "optional_skipped", detail: "主信封ok，但证书校验失败" },
    { operation: "industry-chain", reason_code: "optional_skipped", detail: "Phase 0 无产能 / 客户认证周期" },
  ] },
  financials: { gaps: [
    { operation: "quarterize", reason_code: "insufficient_periods", detail: "缺2023-06-30累计值 ev-0123456789ab" },
    { operation: "sw_industry", reason_code: "source_failed", detail: "申万站点证书校验失败" },
    { operation: "macro_probability", reason_code: "made_up_code", detail: "x" },
  ] },
  risk: { gaps: [
    { operation: "控股股东质押比例无法量化", reason_code: "upstream_missing", detail: "x" },
    { operation: "constructor", reason_code: "source_partial", detail: "x" },
    { operation: "   ", reason_code: "source_failed", detail: "x" },
    "bad",
  ] },
};

function fakeRun(patch: { manifest?: Row; evidence?: unknown; stages?: Record<string, unknown>; conflicts?: unknown; profile?: unknown; report?: string | null; titles?: Record<string, string> } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-share-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, "datasources", "registry.json"), "utf8")) as { endpoints: { id: string; title?: string }[] };
  for (const e of reg.endpoints) if (patch.titles?.[e.id]) e.title = patch.titles[e.id];
  fs.writeFileSync(path.join(repo, "datasources", "registry.json"), JSON.stringify(reg));
  const dataRoot = path.join(repo, ".local");
  const dir = path.join(dataRoot, "runs", "r1");
  fs.mkdirSync(path.join(dir, "stages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "fetch"));
  const w = (rel: string, v: unknown) => fs.writeFileSync(path.join(dir, rel), typeof v === "string" ? v : JSON.stringify(v));
  w("manifest.json", { ...MANIFEST, ...patch.manifest });
  if (patch.report !== null) w("report.md", patch.report ?? "# 报告\n\n## 事实\n");
  w("evidence.json", patch.evidence ?? EVIDENCE);
  for (const [k, v] of Object.entries(patch.stages ?? STAGES)) w(`stages/${k}.json`, v);
  w("conflicts.json", patch.conflicts ?? { id_conflicts: [{}], source_conflicts: [{}, {}] });
  w("fetch/fetch_profile.json", patch.profile ?? { evidence: [{ field: "security_name", value: "中际旭创" }] });
  const ctx: ServiceContext = { repoRoot: repo, dataRoot, python: "python3", node: process.execPath };
  return { ctx, dir, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { assert.ok(e instanceof ServiceError, String(e)); return e.code; }
}

test("注册成视图 share_card「研究分享卡」;前后端的缺口类型一一对应", () => {
  assert.ok(listViews().some((v) => v.id === "share_card" && v.label === "研究分享卡"));
  assert.deepEqual(Object.keys(GAP_KIND_LABEL).sort(), [...GAP_ORDER].sort());
});

test("事实:取最新一期;同期的值去重后并列(最多 3 个),同一个值的各个来源都留;报告期不是日期的、值不是数的不算;没有的进「没取到」", async () => {
  const r = fakeRun();
  try {
    const out = await shareCard(r.ctx, { run_id: "r1" });
    const f = Object.fromEntries(out.facts.map((x) => [x.field, x]));
    assert.equal(f.price!.period, "2026-09-30");
    assert.deepEqual(f.price!.values.map((v) => [v.value, v.source, v.id]), [[808.44, "eastmoney", "ev-p3"], [808.44, "tencent", "ev-p2"], [810, "eastmoney", "ev-p4"]],
      "同值的腾讯那条留着(互相印证),按来源名排");
    assert.deepEqual(f.total_market_cap!.values.map((v) => [v.value, v.unit]), [[952269000000, "元"], [9522.69, "亿元"]], "单位不同不在后端合并,交给界面换算后再合");
    assert.equal(f.pe_ttm!.period, "2026-09-30", "TTM 这种不是日期的报告期不参与");
    assert.equal(f.revenue_cum!.period, "2026-06-30", "值是字符串的那期不算最新");
    assert.equal(f.revenue_cum!.values[0]!.value, 41777861795.03);
    assert.equal(f.net_profit_parent_cum!.values.length, 3);
    assert.equal(f.eps_consensus_mean!.period, "FY2026", "研究在北京时间 2026 年做的 → FY2026");
    assert.equal(f.eps_consensus_mean!.analysts, 29, "机构数要同一年、同一来源");
    assert.deepEqual(out.missing_facts, ["市净率"]);
    assert.equal(out.name, "中际旭创");
    assert.deepEqual([out.symbol, out.market, out.status, out.test_scenario], ["300308", "SZ", "complete", false]);
  } finally { r.done(); }
});

test("一致预期按北京时间定年份:UTC 还是 12-31、北京已是新年 → 取 FY2027;那一年没有机构数就写 null", async () => {
  const r = fakeRun({ manifest: { finished_at: "2026-12-31T16:30:00Z" } });
  try {
    const f = (await shareCard(r.ctx, { run_id: "r1" })).facts.find((x) => x.field === "eps_consensus_mean")!;
    assert.deepEqual([f.period, f.values[0]!.value, f.analysts], ["FY2027", 36.2, null]);
  } finally { r.done(); }
  const r2 = fakeRun({ manifest: { finished_at: "2028-03-01T00:00:00Z" } });
  try {
    const out = await shareCard(r2.ctx, { run_id: "r1" });
    assert.ok(!out.facts.some((x) => x.field === "eps_consensus_mean"), "没有当年的一致预期不拿别的年份顶");
    assert.ok(out.missing_facts.includes("一致预期每股收益"));
  } finally { r2.done(); }
});

test("数量:证据数用运行记录的;没有就数证据行;来源去重;计算 / 冲突取不到是 null 不是 0;阶段按运行记录数", async () => {
  const r = fakeRun();
  try {
    // 来源 11 个:tencent / eastmoney / sina_abstract / src1–5 / ths / other / baostock(security_name 那行不是数,来源照样算)
    assert.deepEqual((await shareCard(r.ctx, { run_id: "r1" })).counts,
      { evidence: 1014, sources: 11, calculations: 30, stages_done: 2, stages_total: 3, conflicts: 3 });
  } finally { r.done(); }
  const r2 = fakeRun({ manifest: { evidence_count: undefined, calculation_count: "30" }, conflicts: { id_conflicts: [] } });
  try {
    const c = (await shareCard(r2.ctx, { run_id: "r1" })).counts;
    assert.deepEqual([c.evidence, c.calculations, c.conflicts], [EVIDENCE.length, null, null]);
  } finally { r2.done(); }
});

test("缺口:同一项只留更要紧的那类;名字用注册表中文名 / 内置名,查不到写代号,不像代号的归「其他」;模型写的原因句一个字都不上卡", async () => {
  const r = fakeRun();
  try {
    const out = await shareCard(r.ctx, { run_id: "r1" });
    assert.deepEqual(out.gaps.map((g) => [g.operation, g.kind, g.label]), [
      ["em_stock_info", "source_failed", "东财个股基本面"],
      ["sw_industry", "source_failed", "申万行业分类"],
      ["constructor", "source_partial", "constructor"],
      ["控股股东质押比例无法量化", "upstream_missing", "其他"],
      ["quarterize", "insufficient_periods", "单季拆分"],
      ["macro_probability", "other", "宏观概率"],
      ["industry-chain", "optional_skipped", "产业链核对"],
    ]);
    const text = JSON.stringify(out);
    for (const d of ["连接中断", "主信封", "Phase 0", "ev-0123456789ab", "证书"]) assert.doesNotMatch(text, new RegExp(d), d);
  } finally { r.done(); }
  assert.equal(shortTitle("东财个股基本面(股本 / 市值 / 行业 / 上市日)"), "东财个股基本面");
  assert.equal(shortTitle("管制与准入 · 美方名单状态(1260H)"), "管制与准入");
  assert.equal(shortTitle("新浪财报三表 — 利润表(近 8 期)"), "新浪财报三表 — 利润表");
  assert.deepEqual(mergeGaps([{ gaps: [{ operation: "x".repeat(49), reason_code: "other" }] }, null, { gaps: "no" }]).map((g) => g.label), ["其他"], "超长的不当代号");
  // 按显示名合成一行、数清几处:同一项两种写法算一处;上不了卡的几句合成「其他 N 处」(审查 R3-4)
  assert.deepEqual(mergeGaps([{ gaps: [
    { operation: "控股股东质押比例无法量化", reason_code: "upstream_missing" },
    { operation: "海外收入占比没有披露", reason_code: "source_failed" },
    { operation: "industry-chain", reason_code: "optional_skipped" },
    { operation: "industry_chain", reason_code: "optional_skipped" },
  ] }]).map((g) => [g.operation, g.kind, g.label, g.count]), [
    ["海外收入占比没有披露", "source_failed", "其他 2 处", 2],
    ["industry-chain", "optional_skipped", "产业链核对", 1],
  ]);
});

test("卡片会被转发:名称、缺口名过不了产出红线就不放;阶段名不合规的不去读", async () => {
  const r = fakeRun({ profile: { evidence: [{ field: "security_name", value: "目标价 120 元" }] }, titles: { em_stock_info: "建议买入(测)" },
    manifest: { stages: [{ stage: "../evil", status: "complete" }, { stage: "profile", status: "complete" }] } });
  try {
    // 阶段名「../evil」会读到 runs/r1/evil.json:不合规的名字根本不该去读
    fs.writeFileSync(path.join(r.dir, "evil.json"), JSON.stringify({ gaps: [{ operation: "evil", reason_code: "source_failed" }] }));
    const out = await shareCard(r.ctx, { run_id: "r1" });
    assert.equal(out.name, null);
    assert.deepEqual([out.counts.stages_done, out.counts.stages_total], [2, 2]);
    assert.deepEqual(out.gaps.map((g) => [g.operation, g.label]), [["em_stock_info", "其他"], ["sw_industry", "申万行业分类"], ["industry-chain", "产业链核对"]], "只读了 profile 阶段");
  } finally { r.done(); }
});

test("研究没做完、测试场景照实标出来", async () => {
  const r = fakeRun({ manifest: { status: "incomplete", exit_code: 2, test_scenario: true } });
  try {
    const out = await shareCard(r.ctx, { run_id: "r1" });
    assert.deepEqual([out.status, out.test_scenario], ["incomplete", true]);
  } finally { r.done(); }
  const loose = fakeRun({ manifest: { test_scenario: "yes" } });
  try { assert.equal((await shareCard(loose.ctx, { run_id: "r1" })).test_scenario, false, "只认 true"); } finally { loose.done(); }
});

test("拒绝:编号不合法、没有这次研究、报告没通过最终校验 / 没有报告、文件是符号链接;证据文件坏了就当没有", async () => {
  const r = fakeRun();
  try {
    for (const id of ["", "../r1", "r1/x", undefined]) assert.equal(await code(shareCard(r.ctx, { run_id: id as string })), "bad_run_id", String(id));
    assert.equal(await code(shareCard(r.ctx, { run_id: "nope" })), "not_found");
  } finally { r.done(); }
  for (const manifest of [{ gate: { ok: false } }, { exit_code: 1 }, { final_errors: ["x"] }, { finished_at: null }, { status: "failed" }]) {
    const x = fakeRun({ manifest });
    try { assert.equal(await code(shareCard(x.ctx, { run_id: "r1" })), "report_not_ready", JSON.stringify(manifest)); } finally { x.done(); }
  }
  const noReport = fakeRun({ report: null });
  try { assert.equal(await code(shareCard(noReport.ctx, { run_id: "r1" })), "report_not_ready"); } finally { noReport.done(); }
  const linked = fakeRun();
  try {
    const outside = path.join(linked.ctx.repoRoot, "outside.json");
    fs.writeFileSync(outside, JSON.stringify(EVIDENCE));
    fs.rmSync(path.join(linked.dir, "evidence.json"));
    fs.symlinkSync(outside, path.join(linked.dir, "evidence.json"));
    assert.equal(await code(shareCard(linked.ctx, { run_id: "r1" })), "path_symlink");
  } finally { linked.done(); }
  const broken = fakeRun({ evidence: "{not json", conflicts: "[" });
  try {
    const out = await shareCard(broken.ctx, { run_id: "r1" });
    assert.deepEqual([out.facts.length, out.missing_facts.length, out.counts.sources, out.counts.conflicts], [0, 7, 0, null]);
  } finally { broken.done(); }
});

test("pickFacts 单独:机构数只认展示出来的那几个来源", () => {
  const { facts } = pickFacts([
    { id: "a", field: "eps_consensus_mean", value: 1, unit: "元/股", period: "FY2026", source: "ths" },
    { id: "b", field: "eps_analyst_count", value: 5, unit: "家", period: "FY2026", source: "other" },
  ], "FY2026");
  assert.equal(facts[0]!.analysts, null);
  const [price] = pickFacts([
    { id: "a", field: "price", value: 100, unit: "元", period: "2026-09-30", source: "x" },
    { id: "b", field: "price", value: 100, unit: "USD", period: "2026-09-30", source: "y" },
  ], "FY2026").facts;
  assert.deepEqual(price!.values.map((v) => v.unit), ["元", "USD"], "数一样单位不一样不算重复");
});

test("界面上复制出去的文字版(含声明)过得了产出红线,也不含目标价 / 买卖 / 评级 / 胜率", async () => {
  const r = fakeRun({ manifest: { status: "incomplete", exit_code: 2, test_scenario: true } });
  try {
    const text = shareSummary(await shareCard(r.ctx, { run_id: "r1" })).join("\n");
    assert.ok(complianceGate(text).ok, JSON.stringify(complianceGate(text)));
    assert.ok(text.includes(STATEMENT));
    assert.doesNotMatch(text, /目标价|买入|卖出|评级|胜率/);
  } finally { r.done(); }
});

test("港美股:累计值的期间是「起..止」,按截止日取最新;一致预期取当前财年(两年里较早的),不按自然年;计算缺口有中文名", async () => {
  const evidence = [
    ev("ev-u1", "price", 337.73, "美元", "2026-10-08", "tencent"),
    ev("ev-u2", "revenue_cum", 416.2e9, "美元", "2024-09-29..2025-09-27", "sec"),
    ev("ev-u3", "revenue_cum", 124.3e9, "美元", "2025-09-28..2025-12-27", "sec"),
    ev("ev-u4", "revenue_cum", 95.4e9, "美元", "2024-09-29..2024-12-28", "sec"),
    ev("ev-u7", "revenue_cum", 60.1e9, "美元", "2025-10-15..2025-11-30", "sec"),   // 起始更晚、截止更早(财年变更的过渡期这类):按字面会误选它
    ev("ev-u5", "eps_consensus_mean", 9.57, "美元/股", "FY2027", "yahoo"),
    ev("ev-u6", "eps_consensus_mean", 8.82, "美元/股", "FY2028", "yahoo"),
  ];
  const stages = { financials: { gaps: [{ operation: "ttm_from_ytd", reason_code: "insufficient_periods", detail: "x" }, { operation: "identity_check", reason_code: "source_failed", detail: "x" }] } };
  const r = fakeRun({ manifest: { symbol: "AAPL", market: "US", finished_at: "2026-10-08T08:00:00+08:00" }, evidence, stages });
  try {
    const out = await shareCard(r.ctx, { run_id: "r1" });
    const f = Object.fromEntries(out.facts.map((x) => [x.field, x]));
    assert.equal(f.revenue_cum!.period, "2025-09-28..2025-12-27", "按截止日比新旧,不按起始日的字面");
    assert.equal(f.eps_consensus_mean!.period, "FY2027", "苹果 2026-10 已进入 FY2027,不能按自然年取 FY2026");
    assert.deepEqual(out.gaps.map((g) => g.label).sort(), ["公司身份核对", "累计值推近四季"]);
  } finally { r.done(); }
  const cn = fakeRun({ evidence: [ev("ev-c1", "revenue_cum", 1e9, "元", "2025-01-01..2025-06-30", "x")] });
  try { assert.ok((await shareCard(cn.ctx, { run_id: "r1" })).facts.some((x) => x.field === "revenue_cum")); } finally { cn.done(); }
});
