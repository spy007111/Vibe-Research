import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildTests, currencyOfUnit, judgeGlobal, repoRootFromHere } from "../src/finance/hardtest.ts";
import { thermoRepoRoot } from "../src/finance/thermo_history.ts";
import { writeJson } from "../src/fsutil.ts";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册

type Ev = Record<string, unknown>;
type Calc = { calculation_id: string; function: string; inputs: Record<string, unknown>; inputs_refs: { ref_type: string; ref_id: string }[]; output: Record<string, unknown> };
const ev = (id: string, field: string, value: unknown, unit: string, extra: Ev = {}): Ev => ({ id, symbol: "00700", market: "HK", field, value, unit, currency: "HKD", period: "2026-10-08", as_of: "2026-10-08", source: "x", endpoint: "x", fetched_at: "2026-10-08T16:00:00+08:00", adjustment: "not_applicable", raw_ref: null, ...extra });

/** 一次合格的港股运行(腾讯):港元报价、人民币列报,估值换汇照抄汇率证据 */
function hkRun() {
  const quote = [ev("ev-0a0001", "security_name", "腾讯控股", "text"), ev("ev-0a0002", "security_name_en", "TENCENT", "text"),
    ev("ev-0a0003", "price", 411.4, "港元"), ev("ev-0a0004", "total_market_cap", 37406.9794, "亿港元")];
  const prof = [ev("ev-0b0001", "company_short_name", "腾讯控股", "text"), ev("ev-0b0002", "company_name_en", "Tencent Holdings Ltd.", "text")];
  const cum = (id: string, field: string, value: number, period: string, asOf: string) => ev(id, field, value, "元", { currency: "CNY", period, as_of: asOf });
  const pit = [cum("ev-0c0001", "revenue_cum", 401243000000, "2026-01-01..2026-06-30", "2026-08-25"), cum("ev-0c0002", "revenue_cum", 751766000000, "2025-01-01..2025-12-31", "2026-03-18"),
    cum("ev-0c0003", "revenue_cum", 364526000000, "2025-01-01..2025-06-30", "2026-08-25"),
    cum("ev-0c0004", "net_profit_parent_cum", 120000000000, "2026-01-01..2026-06-30", "2026-08-25"), cum("ev-0c0005", "net_profit_parent_cum", 224000000000, "2025-01-01..2025-12-31", "2026-03-18"),
    cum("ev-0c0006", "net_profit_parent_cum", 105000000000, "2025-01-01..2025-06-30", "2026-08-25")];
  const other = [ev("ev-0d0001", "fx_hkd_cny", 0.8538, "CNY/HKD", { currency: "n/a" }), ev("ev-0d0002", "eps_consensus_mean", 28.98, "元/股", { currency: "CNY", period: "FY2026" }),
    ev("ev-0e0001", "revenue", 751766000000, "人民币", { currency: "CNY", period: "2025-12-31" })];
  const refs = (...ids: string[]) => ids.map((ref_id) => ({ ref_type: ref_id.startsWith("ev-") ? "evidence" : "calculation", ref_id }));
  const ytdIn = (evs: Ev[]) => ({ cumulative: evs.map((e) => ({ period: e.period, value: e.value })), end_period: "2026-01-01..2026-06-30", unit: "元", money: true });
  const calcs: Calc[] = [
    { calculation_id: "calc-1000000000000001", function: "ttm_from_ytd", inputs: ytdIn(pit.slice(0, 3)), inputs_refs: refs("ev-0c0001", "ev-0c0002", "ev-0c0003"), output: { status: "ok", value: 788483000000, unit: "元", details: {} } },
    { calculation_id: "calc-1000000000000002", function: "ttm_from_ytd", inputs: ytdIn(pit.slice(3)), inputs_refs: refs("ev-0c0004", "ev-0c0005", "ev-0c0006"), output: { status: "ok", value: 239000000000, unit: "元", details: {} } },
    { calculation_id: "calc-1000000000000003", function: "ttm_yoy_from_ytd", inputs: ytdIn(pit.slice(3)), inputs_refs: refs("ev-0c0004", "ev-0c0005", "ev-0c0006"), output: { status: "ok", value: 0.1, unit: "小数", details: {} } },
    { calculation_id: "calc-1000000000000004", function: "forward_pe", inputs: { price: 411.4, price_unit: "港元", eps_forecast: 28.98, eps_unit: "元/股", fx_rate: 0.8538, fx_unit: "CNY/HKD" }, inputs_refs: refs("ev-0a0003", "ev-0d0002", "ev-0d0001"), output: { status: "ok", value: 12.12, unit: "倍", details: {} } },
    { calculation_id: "calc-1000000000000005", function: "pe_ttm_from_parts", inputs: { total_market_cap: 37406.9794, cap_unit: "亿港元", ttm_profit: 239000000000, profit_unit: "元", fx_rate: 0.8538, fx_unit: "CNY/HKD" }, inputs_refs: refs("ev-0a0004", "ev-0d0001", "calc-1000000000000002"), output: { status: "ok", value: 13.36, unit: "倍", details: {} } },
  ];
  return {
    manifest: { symbol: "00700", market: "HK", status: "complete", exit_code: 0, started_at: "2026-10-08T08:00:00Z", finished_at: "2026-10-08T09:00:00Z", stages: [{ stage: "report", status: "complete", attempts: 1, errors: [] }] } as Record<string, unknown>,
    quote: { status: "ok", evidence: quote, extra: { benchmark: { key: "hkHSI", name: "恒生指数" } } } as Record<string, unknown>,
    prof: { status: "ok", evidence: prof } as Record<string, unknown>,
    pit: { status: "ok", evidence: pit, extra: { as_of: "2026-10-08" } } as Record<string, unknown> & { evidence: Ev[] },
    other, calcs,
    profile: { quote_decision: "normal", gaps: [] as Ev[] },
    financials: { calculation_ids: ["calc-1000000000000001", "calc-1000000000000002", "calc-1000000000000003"], gaps: [] } as Record<string, unknown> & { calculation_ids: string[] },
    valuation: { standard_columns: { pe_deducted_x4: "未获取:港美股不披露扣非", qoq: "未获取:港美股本版不算单季环比", forward_pe: "calc-1000000000000004", ttm_yoy: "calc-1000000000000003" }, gaps: [] } as Record<string, unknown>,
    report: "# 腾讯控股(HK:00700)研究报告 · 状态:complete\n## 结论摘要\n- 身份:腾讯控股(TENCENT,HK:00700),报价币种 HKD,报告币种 CNY(ev-0a0001、ev-0b0001)\n- 前瞻 PE 12.12 倍(calc-1000000000000004)\n## 事实\n- 现价 411.4 港元(ev-0a0003)\n- 总市值 37406.9794 亿港元(ev-0a0004)\n## 推断\n## 估值\n- 汇率 0.8538 CNY/HKD(ev-0d0001)\n- 扣非 PE:未获取:港美股不披露扣非\n## 风险与反证\n## 裁决点\n## 数据缺口\n",
  };
}
type Run = ReturnType<typeof hkRun>;
function write(r: Run): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-htg-"));
  for (const sub of ["stages", "fetch"]) fs.mkdirSync(path.join(d, sub));
  const all = [...(r.quote.evidence as Ev[]), ...(r.prof.evidence as Ev[]), ...r.pit.evidence, ...r.other];
  writeJson(path.join(d, "evidence.json"), all);
  writeJson(path.join(d, "calculations.json"), r.calcs);
  writeJson(path.join(d, "manifest.json"), r.manifest);
  writeJson(path.join(d, "fetch", "global_quote_ref.json"), r.quote);
  writeJson(path.join(d, "fetch", "em_global_profile.json"), r.prof);
  writeJson(path.join(d, "fetch", "global_financials_pit.json"), r.pit);
  writeJson(path.join(d, "stages", "profile.json"), r.profile);
  writeJson(path.join(d, "stages", "financials.json"), r.financials);
  writeJson(path.join(d, "stages", "valuation.json"), r.valuation);
  fs.writeFileSync(path.join(d, "report.md"), r.report);
  return d;
}
const HK = { symbol: "00700", market: "HK" as const };
const failed = (r: Run, want: { symbol: string; market: "US" | "HK" } = HK) => judgeGlobal(write(r), want).checks.filter((c) => !c.pass).map((c) => c.name);

test("judgeGlobal:合格的港股运行全部通过(身份、公告日过滤、换汇照抄、扣非未获取、数字绑定)", () => {
  const j = judgeGlobal(write(hkRun()), HK);
  assert.ok(j.pass, JSON.stringify(j.checks.filter((c) => !c.pass)));
  assert.equal(j.checks.length, 10);
});

test("judgeGlobal:每一项都能单独判失败", () => {
  let r = hkRun(); r.manifest.market = "US";
  assert.deepEqual(failed(r), ["标的与市场"]);
  r = hkRun(); r.manifest.status = "incomplete"; r.manifest.exit_code = 2;
  assert.deepEqual(failed(r), ["运行完成"]);
  r = hkRun(); r.quote.extra = { benchmark: { key: "usINX" } };
  assert.deepEqual(failed(r), ["报价参考基准按市场选"]);
  // 公告日晚于研究日 / 研究日晚于运行日 / 期末晚于研究日
  r = hkRun(); r.pit.evidence[0].as_of = "2026-10-09";
  assert.deepEqual(failed(r), ["财务按公告日过滤:研究日 ≤ 运行日,每条公告日与期末 ≤ 研究日"]);
  r = hkRun(); r.pit.extra = { as_of: "2026-10-09" };
  assert.deepEqual(failed(r), ["财务按公告日过滤:研究日 ≤ 运行日,每条公告日与期末 ≤ 研究日"]);
  r = hkRun(); r.pit.evidence[0].period = "2026-01-01..2026-12-31";   // 计算照抄同一条,只剩期末越界这一处错
  (r.calcs[0].inputs.cumulative as { period: string }[])[0].period = "2026-01-01..2026-12-31"; r.calcs[0].inputs.end_period = "2026-01-01..2026-12-31";
  assert.deepEqual(failed(r), ["财务按公告日过滤:研究日 ≤ 运行日,每条公告日与期末 ≤ 研究日"]);
  // 近四季计算引了没按公告日筛的东财三表证据;或少做了营收那一个
  r = hkRun(); r.calcs[0].inputs_refs.push({ ref_type: "evidence", ref_id: "ev-0e0001" });
  assert.deepEqual(failed(r), ["近四季合计 / 同比:累计值照抄按公告日筛过的证据、截止取最新、登记在财务阶段(营收、归母都做了)"]);
  r = hkRun(); r.calcs.splice(0, 1);
  assert.deepEqual(failed(r), ["近四季合计 / 同比:累计值照抄按公告日筛过的证据、截止取最新、登记在财务阶段(营收、归母都做了)"]);
  // 累计值改了一期的数 / 截止期用旧一期 / 估值引用的那条没登记在 financials(阶段 D 审查 P0)
  r = hkRun(); (r.calcs[1].inputs.cumulative as { value: number }[])[0].value = 130000000000;
  assert.deepEqual(failed(r), ["近四季合计 / 同比:累计值照抄按公告日筛过的证据、截止取最新、登记在财务阶段(营收、归母都做了)"]);
  r = hkRun(); r.calcs[2].inputs.end_period = "2025-01-01..2025-12-31";
  assert.deepEqual(failed(r), ["近四季合计 / 同比:累计值照抄按公告日筛过的证据、截止取最新、登记在财务阶段(营收、归母都做了)"]);
  r = hkRun(); r.financials.calculation_ids = ["calc-1000000000000001", "calc-1000000000000003"];
  assert.deepEqual(failed(r), ["近四季合计 / 同比:累计值照抄按公告日筛过的证据、截止取最新、登记在财务阶段(营收、归母都做了)"]);
  // 一条计算混引营收和归母两个字段
  r = hkRun(); r.calcs[1].inputs_refs.push({ ref_type: "evidence", ref_id: "ev-0c0001" });
  assert.deepEqual(failed(r), ["近四季合计 / 同比:累计值照抄按公告日筛过的证据、截止取最新、登记在财务阶段(营收、归母都做了)"]);
  // 没登记的草稿(重试留下的)不影响;被估值以外的计算引用也不算「按口径引用」
  r = hkRun(); r.calcs.push({ ...r.calcs[1], calculation_id: "calc-1000000000000008", inputs: { ...r.calcs[1].inputs, cumulative: [{ period: "2025-01-01..2025-12-31", value: 1 }] } });
  r.calcs.push({ calculation_id: "calc-1000000000000007", function: "ratio", inputs: {}, inputs_refs: [{ ref_type: "calculation", ref_id: "calc-1000000000000008" }], output: { status: "ok", value: 1, unit: "倍", details: {} } });
  assert.deepEqual(failed(r), []);
  // 混进 A 股口径
  r = hkRun(); r.calcs.push({ calculation_id: "calc-1000000000000009", function: "quarterize", inputs: {}, inputs_refs: [], output: { status: "ok", value: null, unit: "元", details: {} } });
  assert.deepEqual(failed(r), ["不走 A 股单季拆分 / 扣非年化口径"]);
  // 汇率:没照抄 / 没传 / 单位方向对不上币种
  r = hkRun(); r.calcs[3].inputs.fx_rate = 0.85;
  assert.deepEqual(failed(r), ["币种:不同则照抄汇率证据换算,相同则不传汇率"]);
  r = hkRun(); delete r.calcs[4].inputs.fx_rate; delete r.calcs[4].inputs.fx_unit;
  assert.deepEqual(failed(r), ["币种:不同则照抄汇率证据换算,相同则不传汇率"]);
  r = hkRun(); r.calcs[3].inputs.fx_unit = "HKD/CNY";   // 值照抄了,方向写反
  assert.deepEqual(failed(r), ["币种:不同则照抄汇率证据换算,相同则不传汇率"]);
  r = hkRun(); r.other[0] = { ...r.other[0], field: "fx_usd_cny", unit: "CNY/USD" }; r.calcs[3].inputs.fx_unit = "CNY/USD"; r.calcs[4].inputs.fx_unit = "CNY/USD";
  assert.ok(failed(r).includes("币种:不同则照抄汇率证据换算,相同则不传汇率"));
  // 扣非一格写成了计算
  r = hkRun(); (r.valuation.standard_columns as Record<string, string>).pe_deducted_x4 = "calc-1000000000000005";
  assert.deepEqual(failed(r), ["扣非 PE 与单季环比两格写未获取"]);
  // 报告里有没绑定的数字
  r = hkRun(); r.report = r.report.replace("## 推断\n", "## 推断\n- 毛利率约 56.3%\n");
  assert.deepEqual(failed(r), ["报告数字 100% 绑定证据 / 计算"]);
});

test("judgeGlobal:身份两条路 —— 对得上要写身份句;对不上要有缺口并写明没核实", () => {
  let r = hkRun(); r.report = r.report.replace("- 身份:腾讯控股(TENCENT,HK:00700),报价币种 HKD,报告币种 CNY(ev-0a0001、ev-0b0001)\n", "");
  assert.deepEqual(failed(r), ["身份已核实 → 结论摘要第一句写身份并带 ev id"]);
  r = hkRun(); r.report = r.report.replace("(ev-0a0001、ev-0b0001)", "");   // 身份句没带 ev id
  assert.deepEqual(failed(r), ["身份已核实 → 结论摘要第一句写身份并带 ev id"]);
  r = hkRun(); r.report = r.report.replace("TENCENT,HK:00700", "TENCENT");   // 身份句没写代码
  assert.deepEqual(failed(r), ["身份已核实 → 结论摘要第一句写身份并带 ev id"]);
  r = hkRun(); (r.prof.evidence as Ev[])[0].value = "阿里巴巴"; (r.prof.evidence as Ev[])[1].value = "Alibaba Group Holding Ltd.";
  assert.deepEqual(failed(r), ["身份没核实 → profile 有 identity_check 缺口且摘要写明"]);
  r.profile.gaps = [{ operation: "identity_check", reason_code: "source_partial" }];
  r.report = r.report.replace("- 身份:腾讯控股", "- 身份没核实:行情源叫腾讯控股");
  assert.deepEqual(failed(r), []);
});

test("judgeGlobal:美股币种一致不该传汇率", () => {
  const r = hkRun();
  r.manifest.symbol = "AAPL"; r.manifest.market = "US"; r.quote.extra = { benchmark: { key: "usINX" } };
  for (const e of [...(r.quote.evidence as Ev[]), ...(r.prof.evidence as Ev[])]) if (typeof e.value === "string") e.value = String(e.value).replace("腾讯控股", "苹果").replace(/Tencent Holdings Ltd\.|TENCENT/, "Apple Inc.");
  r.report = r.report.replaceAll("腾讯控股", "苹果").replace("TENCENT", "Apple Inc.").replaceAll("HK:00700", "US:AAPL");
  r.calcs[3].inputs = { price: 337.73, price_unit: "美元", eps_forecast: 8.5, eps_unit: "美元/股", fx_rate: 1, fx_unit: "USD/USD" };
  r.calcs[4].inputs = { total_market_cap: 49289.05, cap_unit: "亿美元", ttm_profit: 1e11, profit_unit: "美元" };
  assert.deepEqual(failed(r, { symbol: "AAPL", market: "US" }), ["币种:不同则照抄汇率证据换算,相同则不传汇率"]);
  delete r.calcs[3].inputs.fx_rate; delete r.calcs[3].inputs.fx_unit;
  assert.deepEqual(failed(r, { symbol: "AAPL", market: "US" }), []);
});

test("currencyOfUnit 与测试清单:港美股组自带标的", () => {
  assert.deepEqual(["港元", "亿港元", "美元/股", "亿美元", "元", "元/股", "亿元", "倍", undefined].map(currencyOfUnit), ["HKD", "HKD", "USD", "USD", "CNY", "CNY", "CNY", null, null]);
  const g = buildTests("python3", "/repo").filter((t) => t.group === "G 港美股研究");
  assert.deepEqual(g.map((t) => [t.id, t.symbol, t.market, t.stages]), [["global_us", "AAPL", "US", undefined], ["global_hk", "00700", "HK", undefined]]);
  assert.ok(buildTests("python3", "/repo").filter((t) => t.group !== "G 港美股研究").every((t) => t.symbol === undefined && t.market === undefined));
});

test("硬测试与温度计回填不传 --repo-root 时找得到仓库根（之前少上一层，落到 orchestrator/）", () => {
  for (const root of [repoRootFromHere(), thermoRepoRoot()]) {
    assert.ok(fs.existsSync(path.join(root, "orchestrator", "src", "run.ts")), root);
    assert.ok(fs.existsSync(path.join(root, "vibe-research.config.json")), root);
  }
});

test("硬测试与温度计回填的命令行入口自己注册金融插件（之前漏了：判分报「未注入 Lexicon」，回填一跑就抛「未注入插件」）", async () => {
  const { spawnSync } = await import("node:child_process");
  const src = (f: string) => fs.readFileSync(path.join(repoRootFromHere(), "orchestrator", "src", "finance", f), "utf8");
  // 只在命令行直接运行时注册(静态 import 会和 finance/plugin.ts 循环引用)
  for (const f of ["hardtest.ts", "thermo_history.ts"]) {
    assert.match(src(f), /^if \(isMain\) import\("\.\/register\.ts"\)\.then\(/m, f);
    assert.doesNotMatch(src(f), /^import "\.\/register\.ts";$/m, f);
  }
  // 真从命令行跑一次回填(空的运行目录):注册不上会直接抛错退出
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thermo-cli-"));
  fs.mkdirSync(path.join(dataRoot, "runs"));
  const r = spawnSync(process.execPath, [path.join(repoRootFromHere(), "orchestrator", "src", "finance", "thermo_history.ts"), "backfill", "--data-root", dataRoot], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /回填完成/);
  assert.doesNotMatch(r.stderr, /未注入/);
});
