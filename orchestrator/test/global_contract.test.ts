import assert from "node:assert/strict";
import { test } from "node:test";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import { regionOfRun, stageCalcs, stageSlots } from "../src/config.ts";
import { currentPlugin, registerPlugin, resetPlugin, type Plugin } from "../src/plugin.ts";
import { FINANCE_PLUGIN } from "../src/finance/plugin.ts";
import { financeQuoteDecision } from "../src/finance/quote_freshness.ts";
import { identityCheck } from "../src/finance/identity.ts";
import { FINANCE_STAGE_VALIDATORS } from "../src/finance/stage_validators.ts";
import { reportPreludeLines } from "../src/finance/report_prelude.ts";
import { claimNumbers } from "../src/number_fidelity.ts";
import { fiscalT, roleOf, validateCalcSlots, type RunView, type StageOutput } from "../src/validator.ts";
import type { StageValidationContext } from "../src/plugin.ts";

/**
 * 港股 / 美股契约(D2.3):按区域选必需计算与语义槽位、累计值逐项绑定到按公告日筛过的证据、
 * 汇率只能照抄证据、T / T+1 财年、报价时效与身份核对。
 * 🔴 这一组断言守的是"港美股研究也是硬校验":任何一条失效,agent 抄错一期、
 *    自己编一个汇率、拿研究日之后公告的数,都能照样判 complete。
 */

const TS = "2026-10-08T10:00:00+08:00";
type Ev = Record<string, unknown> & { id: string; field: string };
function ev(id: string, field: string, value: unknown, unit: string, period: string, extra: Record<string, unknown> = {}): Ev {
  return { id, symbol: "BABA", market: "US", field, value, unit, currency: "USD", period, as_of: "2026-10-08", source: "t", endpoint: "t",
    fetched_at: TS, adjustment: "not_applicable", raw_ref: "raw/fake.json", ...extra };
}
type Rec = { calculation_id: string; function: string; inputs: Record<string, unknown>; inputs_refs: { ref_type: "evidence" | "calculation"; ref_id: string }[]; output: Record<string, unknown> };
function calc(id: string, fn: string, inputs: Record<string, unknown>, evIds: string[], calcIds: string[] = [], value: unknown = 1.5, unit = "倍"): Rec {
  return { calculation_id: id, function: fn, inputs,
    inputs_refs: [...evIds.map((ref_id) => ({ ref_type: "evidence" as const, ref_id })), ...calcIds.map((ref_id) => ({ ref_type: "calculation" as const, ref_id }))],
    output: { status: "ok", value, unit, reason: "", details: {} } };
}
function view(evs: Ev[], calcs: Rec[], fetch: Record<string, unknown> = {}, region: string | undefined = "US"): RunView {
  const evidence = new Map(evs.map((e) => [e.id, e] as const));
  const calcById = new Map(calcs.map((c) => [c.calculation_id, c] as const));
  return { runDir: "/nonexistent", fetch, ledger: {}, calcs: [], evidence, evidenceIds: new Set(evidence.keys()), calcById, calcIds: new Set(calcById.keys()),
    conflicts: [], stage: () => null, report: null, reportSources: [], plan: {}, critical: [], endpoints: {}, region } as unknown as RunView;
}
const so = (stage: string, calcIds: string[], gaps: { operation: string }[] = []) =>
  ({ stage, status: "complete", summary: "x", evidence_ids: [], calculation_ids: calcIds, gaps: gaps.map((g) => ({ ...g, reason_code: "source_failed", detail: "x" })) }) as unknown as StageOutput;

// 苹果式非自然年财年:FY 截止 9 月最后一个周六;当期 = 新财年第一季累计
const P = { fy24: "2023-10-01..2024-09-28", q1fy25: "2024-09-29..2024-12-28", fy25: "2024-09-29..2025-09-27", q1fy26: "2025-09-28..2025-12-27" };
const NP = [ev("ev-np0001", "net_profit_parent_cum", 93.7e9, "美元", P.fy24), ev("ev-np0002", "net_profit_parent_cum", 36.3e9, "美元", P.q1fy25),
  ev("ev-np0003", "net_profit_parent_cum", 112.0e9, "美元", P.fy25), ev("ev-np0004", "net_profit_parent_cum", 42.1e9, "美元", P.q1fy26)];
const list = (evs: Ev[]) => evs.map((e) => ({ period: e.period, value: e.value }));
const ttm = (over: Record<string, unknown> = {}, evs = NP, id = "calc-ttm0000000000001") =>
  calc(id, "ttm_from_ytd", { cumulative: list(evs), end_period: P.q1fy26, unit: "美元", money: true, ...over }, evs.map((e) => e.id), [], 117.8e9, "美元");

test("区域契约:港美股取覆盖表,A 股与未覆盖阶段沿用默认;未知市场按默认契约", () => {
  assert.deepEqual([...stageCalcs("financials", "US")], ["ttm_from_ytd", "ttm_yoy_from_ytd"]);
  assert.deepEqual([...stageCalcs("financials", "HK")], ["ttm_from_ytd", "ttm_yoy_from_ytd"]);
  assert.ok(stageCalcs("financials", "CN").includes("quarterize"));
  assert.deepEqual([...stageCalcs("financials")], [...stageCalcs("financials", "CN")]);
  assert.ok(!stageCalcs("valuation", "US").includes("pe_deducted_annualized"), "港美股不披露扣非,不能把扣非年化列为必需");
  assert.ok(stageCalcs("valuation", "CN").includes("pe_deducted_annualized"));
  assert.deepEqual([...stageCalcs("profile", "US")], [...stageCalcs("profile")], "没覆盖的阶段沿用默认");
  assert.equal((stageSlots("estimates", "US")[0] as { constArgs: { years: number } }).constArgs.years, 1, "港美股一致预期只到 T+1");
  assert.equal((stageSlots("estimates", "CN")[0] as { constArgs: { years: number } }).constArgs.years, 2);
  assert.equal(regionOfRun("us"), "US");
  assert.equal(regionOfRun(""), "CN");
  assert.equal(regionOfRun("XX"), undefined);
});

test("🔴 累计值逐项绑定:照抄证据才算;改一期的数 / 用旧一期作截止 / 单位写错都要报", () => {
  const rev = NP.map((e, i) => ({ ...e, id: `ev-rv000${i}`, field: "revenue_cum", value: (e.value as number) * 4 }));
  const revCalc = calc("calc-ttm0000000000002", "ttm_from_ytd", { cumulative: list(rev), end_period: P.q1fy26, unit: "美元", money: true }, rev.map((e) => e.id), [], 1, "美元");
  const okRun = view([...NP, ...rev], [ttm(), revCalc]);
  assert.deepEqual(validateCalcSlots("financials", okRun, so("financials", ["calc-ttm0000000000001", "calc-ttm0000000000002"])).errors, []);

  // 缺营收那一组 → 要么补算要么写缺口
  const one = view(NP, [ttm()]);
  assert.match(validateCalcSlots("financials", one, so("financials", ["calc-ttm0000000000001"])).errors.join("\n"), /缺少对 revenue_cum 的 ttm_from_ytd/);
  assert.deepEqual(validateCalcSlots("financials", one, so("financials", ["calc-ttm0000000000001"], [{ operation: "ttm_from_ytd:revenue_cum" }])).errors, []);

  const gapOk = [{ operation: "ttm_from_ytd:revenue_cum" }];
  const tampered = list(NP); tampered[1] = { ...tampered[1], value: 30e9 };
  const e1 = validateCalcSlots("financials", view(NP, [ttm({ cumulative: tampered })]), so("financials", ["calc-ttm0000000000001"], gapOk)).errors.join("\n");
  assert.match(e1, /2024-09-29\.\.2024-12-28.*找不到同期同值/);

  const e2 = validateCalcSlots("financials", view(NP, [ttm({ end_period: P.fy25 })]), so("financials", ["calc-ttm0000000000001"], gapOk)).errors.join("\n");
  assert.match(e2, /不是本次已取到的最新一期 2025-09-28\.\.2025-12-27/);

  const e3 = validateCalcSlots("financials", view(NP, [ttm({ unit: "元" })]), so("financials", ["calc-ttm0000000000001"], gapOk)).errors.join("\n");
  assert.match(e3, /单位参数 unit=元 与证据/);

  // 列表里出现一个**没有被引用**的期间(比如研究日之后才公告、被筛掉的那一期)
  const extra = [...list(NP), { period: "2025-09-28..2026-03-28", value: 70e9 }];
  const e4 = validateCalcSlots("financials", view(NP, [ttm({ cumulative: extra })]), so("financials", ["calc-ttm0000000000001"], gapOk)).errors.join("\n");
  assert.match(e4, /2025-09-28\.\.2026-03-28.*找不到同期同值/);

  // "最新一期"按本次运行**全部**同字段证据算,不只按引用的那几条 —— 只引旧的几期躲不过去
  const later = ev("ev-np0005", "net_profit_parent_cum", 70e9, "美元", "2025-09-28..2026-03-28");
  const e5 = validateCalcSlots("financials", view([...NP, later], [ttm()]), so("financials", ["calc-ttm0000000000001"], gapOk)).errors.join("\n");
  assert.match(e5, /不是本次已取到的最新一期 2025-09-28\.\.2026-03-28/);

  const e6 = validateCalcSlots("financials", view(NP, [ttm({ cumulative: [] })]), so("financials", ["calc-ttm0000000000001"], gapOk)).errors.join("\n");
  assert.match(e6, /cumulative 必须是非空列表/);
});

/** 给运行补上其它阶段的产出(只填 calculation_ids) */
const withStages = (run: RunView, ids: Record<string, string[]>): RunView => ({ ...run, stage: (s: string) => (ids[s] ? so(s, ids[s]) : null) }) as unknown as RunView;

test("🔴 下游只能引用在所属阶段登记过的上游计算:另造一条没过绑定的近四季合计,估值也要报(阶段 D 审查 P0)", () => {
  // 伪造:只引一条证据(拿到口径),累计值自己编、截止期用旧一期;不登记在 financials,financials 的槽位检查就不会看它
  const rogue = calc("calc-ttmrogue0000001", "ttm_from_ytd", { cumulative: [{ period: P.fy25, value: 50e9 }], end_period: P.fy25, unit: "美元", money: true }, ["ev-np0003"], [], 50e9, "美元");
  const cap = ev("ev-cap0001", "total_market_cap", 40000, "亿美元", "2026-10-08");
  const pe = (up: string) => calc("calc-pettm000000001", "pe_ttm_from_parts", { total_market_cap: 40000, cap_unit: "亿美元", ttm_profit: up === "calc-ttmrogue0000001" ? 50e9 : 117.8e9, profit_unit: "美元" }, ["ev-cap0001"], [up], 80, "倍");
  const errs = (up: string, stageIds: Record<string, string[]>, own: string[] = ["calc-pettm000000001"]) =>
    validateCalcSlots("valuation", withStages(view([...NP, cap], [ttm(), rogue, pe(up)]), stageIds), so("valuation", own)).errors.filter((e) => e.includes("没有登记"));
  assert.equal(errs("calc-ttmrogue0000001", { financials: ["calc-ttm0000000000001"] }).length, 1);
  assert.match(errs("calc-ttmrogue0000001", { financials: ["calc-ttm0000000000001"] })[0], /calc-ttmrogue0000001.*financials/);
  // 列在估值自己的 calculation_ids 里也不算:估值阶段不检查近四季合计的槽位
  assert.equal(errs("calc-ttmrogue0000001", { financials: ["calc-ttm0000000000001"] }, ["calc-pettm000000001", "calc-ttmrogue0000001"]).length, 1);
  // financials 阶段产出缺失 → 同样报
  assert.equal(errs("calc-ttm0000000000001", {}).length, 1);
  // 正常:引用 financials 里登记的那条
  assert.deepEqual(errs("calc-ttm0000000000001", { financials: ["calc-ttm0000000000001"] }), []);
  // 判断题引的近四季同比同样要登记
  const yoy = calc("calc-yoy0000000000001", "ttm_yoy_from_ytd", { cumulative: list(NP), end_period: P.q1fy26, unit: "美元", money: true }, NP.map((e) => e.id), [], 0.1, "小数");
  const cagr = calc("calc-cagr000000000001", "forward_cagr", {}, [], [], 0.1, "小数");
  const judge = calc("calc-judge00000000001", "forward_vs_ttm_judgement", { forward_cagr_value: 0.1, ttm_yoy_value: 0.1 }, [], ["calc-cagr000000000001", "calc-yoy0000000000001"]);
  const jr = (fin: string[]) => validateCalcSlots("valuation", withStages(view(NP, [yoy, cagr, judge]), { financials: fin, estimates: ["calc-cagr000000000001"] }), so("valuation", ["calc-judge00000000001"])).errors.filter((e) => e.includes("没有登记"));
  assert.equal(jr([]).length, 1);
  assert.deepEqual(jr(["calc-yoy0000000000001"]), []);
  // 不带口径的上游(前瞻增速)不要求登记:真实运行会用最低 / 最高预测另算情景版 PEG,登记在估值 / 风险阶段
  const low = calc("calc-cagrlow00000001", "forward_cagr", { eps_t: 6.1, eps_t_plus_n: 6.5, years: 1 }, [], [], 0.066, "小数");
  const peg = calc("calc-peg00000000001", "peg", { pe: 80, cagr: 0.066 }, [], ["calc-pettm000000001", "calc-cagrlow00000001"]);
  const run = withStages(view([...NP, cap], [ttm(), pe("calc-ttm0000000000001"), peg, low]), { financials: ["calc-ttm0000000000001"], estimates: ["calc-cagr000000000001"] });
  assert.deepEqual(validateCalcSlots("valuation", run, so("valuation", ["calc-peg00000000001", "calc-pettm000000001", "calc-cagrlow00000001"])).errors.filter((e) => e.includes("没有登记")), []);
});

test("口径角色:累计值函数的角色直接读证据字段;下游按上游角色解析", () => {
  const yoy = calc("calc-yoy0000000000001", "ttm_yoy_from_ytd", { cumulative: list(NP), end_period: P.q1fy26, unit: "美元", money: true }, NP.map((e) => e.id), [], 0.1, "小数");
  const cagr = calc("calc-cagr000000000001", "forward_cagr", {}, []);
  const judge = calc("calc-judge00000000001", "forward_vs_ttm_judgement", { forward_cagr_value: 1.5, ttm_yoy_value: 0.1 }, [], ["calc-cagr000000000001", "calc-yoy0000000000001"]);
  const run = withStages(view(NP, [ttm(), yoy, cagr, judge]), { financials: ["calc-yoy0000000000001"], estimates: ["calc-cagr000000000001"] });
  assert.equal(roleOf(ttm() as never, run), "net_profit_parent_cum");
  assert.equal(roleOf(yoy as never, run), "net_profit_parent_cum");
  assert.deepEqual(currentPlugin().roleSourceFns, ["quarterize", "ttm_from_ytd", "ttm_yoy_from_ytd"]);
  const errs = validateCalcSlots("valuation", run, so("valuation", ["calc-judge00000000001"])).errors;
  assert.deepEqual(errs.filter((e) => e.includes("forward_vs_ttm_judgement")), []);
  // 混了两个字段的累计值 → 角色解析不出
  const mixed = calc("calc-ttm0000000000009", "ttm_from_ytd", {}, ["ev-np0001", "ev-rv0000"]);
  const run2 = view([...NP, ev("ev-rv0000", "revenue_cum", 1, "美元", P.fy24)], [mixed]);
  assert.equal(roleOf(mixed as never, run2), null);
});

test("🔴 汇率是可选实参:币种一致不传;传了就必须引用汇率证据并照抄值和单位", () => {
  const fx = ev("ev-fx00001", "fx_usd_cny", 7.12, "CNY/USD", "2026-10-08");
  const price = ev("ev-px00001", "price", 120.5, "美元", "2026-10-08");
  const eps = ev("ev-eps0001", "eps_consensus_mean", 60.2, "元/股", "FY2027", { currency: "CNY" });
  const fetch = { yahoo_consensus: { extra: { current_fy: "FY2027" } } };
  const fpe = (inputs: Record<string, unknown>, evIds: string[]) => calc("calc-fpe0000000000001", "forward_pe", inputs, evIds);
  const base = { price: 120.5, eps_forecast: 60.2, price_unit: "美元", eps_unit: "元/股" };
  const errs = (inputs: Record<string, unknown>, evIds: string[]) =>
    validateCalcSlots("valuation", view([fx, price, eps], [fpe(inputs, evIds)], fetch), so("valuation", ["calc-fpe0000000000001"])).errors
      .filter((e) => e.startsWith("forward_pe")).join("\n");

  assert.equal(errs({ ...base, fx_rate: 7.12, fx_unit: "CNY/USD" }, ["ev-px00001", "ev-eps0001", "ev-fx00001"]), "");
  assert.equal(errs(base, ["ev-px00001", "ev-eps0001"]), "", "不传汇率时槽位不管(币种不同由计算本身报错)");
  assert.match(errs({ ...base, fx_rate: 7.12, fx_unit: "CNY/USD" }, ["ev-px00001", "ev-eps0001"]), /传了实参 fx_rate,就必须引用 fx_usd_cny \/ fx_hkd_cny \/ fx_usd_hkd 证据/);
  assert.match(errs({ ...base, fx_rate: 7.0, fx_unit: "CNY/USD" }, ["ev-px00001", "ev-eps0001", "ev-fx00001"]), /fx_rate=7 与所引用/);
  assert.match(errs({ ...base, fx_rate: 7.12, fx_unit: "USD/CNY" }, ["ev-px00001", "ev-eps0001", "ev-fx00001"]), /单位参数 fx_unit=USD\/CNY 与证据单位 CNY\/USD 不一致/);
  // 币种单位是必填:不写单位就核不了币种
  assert.match(errs({ price: 120.5, eps_forecast: 60.2 }, ["ev-px00001", "ev-eps0001"]), /单位参数 price_unit=undefined 与证据单位 美元 不一致/);
  // 预测 EPS 必须是当前财年 T(FY2027)
  const epsNext = { ...eps, id: "ev-eps0002", period: "FY2028" };
  const e2 = validateCalcSlots("valuation", view([price, epsNext], [fpe(base, ["ev-px00001", "ev-eps0002"])], fetch), so("valuation", ["calc-fpe0000000000001"])).errors.join("\n");
  assert.match(e2, /必须引用 FY2027 的 eps_consensus_mean 证据/);
});

test("一致预期:分歧度看 T+1;前瞻增速固定 1 年(T → T+1)", () => {
  const fetch = { yahoo_consensus: { extra: { current_fy: "FY2026" } } };
  const mk = (period: string, sfx: string) => [ev(`ev-lo${sfx}`, "eps_consensus_min", 6, "美元/股", period), ev(`ev-mn${sfx}`, "eps_consensus_mean", 7, "美元/股", period), ev(`ev-hi${sfx}`, "eps_consensus_max", 8, "美元/股", period)];
  const disp = (sfx: string) => calc("calc-disp000000000001", "consensus_dispersion", { low: 6, mean: 7, high: 8 }, [`ev-lo${sfx}`, `ev-mn${sfx}`, `ev-hi${sfx}`]);
  const okErrs = validateCalcSlots("estimates", view(mk("FY2027", "01"), [disp("01")], fetch), so("estimates", ["calc-disp000000000001"])).errors;
  assert.deepEqual(okErrs, []);
  const bad = validateCalcSlots("estimates", view(mk("FY2026", "02"), [disp("02")], fetch), so("estimates", ["calc-disp000000000001"])).errors.join("\n");
  assert.match(bad, /FY2027/);
  // A 股运行同一份记录按默认契约看 T+2
  const cn = validateCalcSlots("estimates", view(mk("FY2027", "01"), [disp("01")], { fetch_estimates: { extra: { current_fy: "FY2026" } } }, "CN"), so("estimates", ["calc-disp000000000001"])).errors.join("\n");
  assert.match(cn, /FY2028/);
  const cagr = calc("calc-cagr000000000001", "forward_cagr", { eps_t: 7, eps_t_plus_n: 8, years: 2 }, ["ev-mn01"]);
  assert.match(validateCalcSlots("estimates", view(mk("FY2027", "01"), [cagr], fetch), so("estimates", ["calc-cagr000000000001"])).errors.join("\n"), /years 必须为 1/);
});

test("基准财年 T:港美股读 yahoo_consensus 的当前财年;缺了宁可判不出,也不拿 T+1 顶替", () => {
  const evs = [ev("ev-e00001", "eps_consensus_mean", 7, "美元/股", "FY2027"), ev("ev-e00002", "eps_consensus_mean", 8, "美元/股", "FY2028")];
  assert.equal(fiscalT(view(evs, [], { yahoo_consensus: { extra: { current_fy: "FY2027" } } })), 2027);
  assert.equal(fiscalT(view(evs.slice(1), [], { yahoo_consensus: { extra: {} } })), null);
  assert.equal(fiscalT(view(evs, [], {}, "CN")), 2027, "A 股缺当前财年时仍按最早一年(原行为)");
  assert.equal(fiscalT(view(evs, [], { fetch_estimates: { extra: { current_fy: "FY2026" } }, yahoo_consensus: { extra: { current_fy: "FY2030" } } }, "CN")), 2026);
});

test("报价时效:港美股的报价日与参考交易日都取 global_quote_ref;A 股照旧", () => {
  const q = (extra: Record<string, unknown>, status = "ok") => ({ global_quote_ref: { status, evidence: [], extra } });
  const base = { quote_date: "2026-10-07", reference_quote_day: "2026-10-07", last_trading_day: "2026-10-07", session_phase: "post_close", is_stale: false };
  assert.equal(financeQuoteDecision(view([], [], q(base))).decision, "normal");
  assert.equal(financeQuoteDecision(view([], [], q({ ...base, quote_date: "2026-10-06" }))).decision, "stale");
  assert.equal(financeQuoteDecision(view([], [], q({ ...base, session_phase: "pre_open", is_stale: true }))).decision, "pre_open");
  assert.equal(financeQuoteDecision(view([], [], q({ ...base, is_stale: true }))).decision, "stale");
  const miss = financeQuoteDecision(view([], [], q(base, "failed")));
  assert.equal(miss.decision, "missing");
  assert.match(miss.reason, /global_quote_ref/);
  assert.match(financeQuoteDecision(view([], [], q(base), "CN")).reason, /fetch_quote/, "A 股运行不读港美股报价");
});

/** 两个来源的名称(2026-10-08 实测:腾讯行情 / 东财 F10) */
const names = (quote: [string, string] | null, profile: [string, string, string] | null) => ({
  ...(quote ? { global_quote_ref: { status: "ok", extra: {}, evidence: [ev("ev-q1", "security_name", quote[0], "text", "d"), ev("ev-q2", "security_name_en", quote[1], "text", "d")] } } : {}),
  ...(profile ? { em_global_profile: { status: "ok", extra: {}, evidence: [ev("ev-p1", "company_short_name", profile[0], "text", "d"), ev("ev-p2", "company_name", profile[1], "text", "d"), ev("ev-p3", "company_name_en", profile[2], "text", "d")] } } : {}),
});

test("身份核对:两个来源名称一致才算核实;对不上 / 缺一边 → profile 必须写 identity_check 缺口", () => {
  const real: [[string, string], [string, string, string]][] = [
    [["苹果", "Apple Inc."], ["苹果", "苹果公司", "Apple Inc."]],
    [["腾讯控股", "TENCENT"], ["腾讯控股", "腾讯控股有限公司", "Tencent Holdings Limited"]],
    [["阿里巴巴-W", "BABA-W"], ["阿里巴巴-W", "阿里巴巴集团控股有限公司", "Alibaba Group Holding Limited"]],
    [["小米集团-W", "XIAOMI-W"], ["小米集团-W", "小米集团", "XIAOMI CORPORATION"]],
    [["台积电", "Taiwan Semiconductor Manufacturing"], ["台积电", "台湾积体电路制造股份有限公司", "Taiwan Semiconductor Manufacturing Co., Ltd."]],
    [["汇丰控股", "HSBC HOLDINGS"], ["汇丰控股", "汇丰控股有限公司", "HSBC Holdings Plc"]],
  ];
  for (const [q, p] of real) assert.equal(identityCheck(view([], [], names(q, p))).ok, true, `${q[0]} 应核实通过`);
  // 中文对不上但英文一致也算(行情源中文名缺失时)
  assert.equal(identityCheck(view([], [], names(["", "Nvidia Corporation"], ["", "", "NVIDIA Corporation"]))).ok, true);
  const wrong = identityCheck(view([], [], names(["苹果", "Apple Inc."], ["英伟达", "英伟达公司", "NVIDIA Corporation"])));
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /对不上/);
  assert.match(identityCheck(view([], [], names(["伯克希尔B", "Berkshire Hathaway Inc. New"], null))).reason, /资料源/);
  assert.match(identityCheck(view([], [], names(null, ["苹果", "苹果公司", "Apple Inc."]))).reason, /行情源/);

  const quote = { quote_date: "2026-10-07", reference_quote_day: "2026-10-07", last_trading_day: "2026-10-07", session_phase: "post_close", is_stale: false };
  const fetchWrong = { ...names(["苹果", "Apple Inc."], ["英伟达", "英伟达公司", "NVIDIA Corporation"]) } as Record<string, { status: string; extra: Record<string, unknown>; evidence: unknown[] }>;
  fetchWrong.global_quote_ref.extra = quote;
  const ctx = (gaps: { operation: string }[], region: string | undefined = "US") =>
    ({ stage: "profile", run: view([], [], fetchWrong, region), output: { quote_decision: "normal", gaps } }) as unknown as StageValidationContext;
  assert.match(FINANCE_STAGE_VALIDATORS.profile(ctx([])).join("\n"), /operation=identity_check/);
  assert.deepEqual(FINANCE_STAGE_VALIDATORS.profile(ctx([{ operation: "identity_check" }])), []);
});

test("插件契约:区域覆盖表的阶段名必须存在、拒原型键;注册后冻结、改原对象改不动", () => {
  const rejects = (p: Plugin, re: RegExp) => { resetPlugin(); assert.throws(() => registerPlugin(p), re); };
  try {
    rejects({ ...FINANCE_PLUGIN, regionContracts: { US: { stageCalcs: { finance: ["x"] } } } }, /regionContracts\.US\.stageCalcs 出现了不存在的阶段 finance/);
    rejects({ ...FINANCE_PLUGIN, regionContracts: { US: { semanticSlots: { valuations: [] } } } }, /regionContracts\.US\.semanticSlots 出现了不存在的阶段 valuations/);
    rejects({ ...FINANCE_PLUGIN, regionContracts: JSON.parse('{"__proto__": {"stageCalcs": {}}}') }, /不许用 __proto__ 作键/);
    rejects({ ...FINANCE_PLUGIN, regionContracts: JSON.parse('{"US": {"stageCalcs": {"__proto__": ["x"]}}}') }, /不存在的阶段 __proto__/);
    rejects({ ...FINANCE_PLUGIN, regionContracts: { US: { stageCalc: {} } } as never }, /不符契约|stageCalc/);
    rejects({ ...FINANCE_PLUGIN, roleSourceFns: ["quarterize", "quarterize"] }, /不符契约|roleSourceFns/);

    const own = { US: { stageCalcs: { financials: ["ttm_from_ytd"] } } };
    const fns = ["quarterize"];
    resetPlugin(); registerPlugin({ ...FINANCE_PLUGIN, regionContracts: own, roleSourceFns: fns });
    own.US.stageCalcs.financials.push("tampered"); fns.push("tampered");
    assert.deepEqual([...stageCalcs("financials", "US")], ["ttm_from_ytd"]);
    assert.deepEqual([...currentPlugin().roleSourceFns!], ["quarterize"]);
    assert.ok(Object.isFrozen(currentPlugin().regionContracts!.US.stageCalcs!.financials));
    // 不声明 = 没有区域覆盖、没有角色来源函数:按默认契约走,quarterize 也不再被特殊对待
    const { regionContracts: _r, roleSourceFns: _f, ...bare } = FINANCE_PLUGIN;
    resetPlugin(); registerPlugin(bare as Plugin);
    assert.ok(stageCalcs("financials", "US").includes("quarterize"));
    assert.equal(roleOf(ttm() as never, view(NP, [ttm()])), null);
  } finally {
    resetPlugin(); registerPlugin(FINANCE_PLUGIN);
  }
});

test("报告开头披露:港股 PE 分位认百度序列;带汇率换算的计算不误报币种混用,没换算的照样报", () => {
  const hk = (id: string, field: string, value: unknown, unit: string, currency: string, extra: Record<string, unknown> = {}) =>
    ev(id, field, value, unit, "2026-10-08", { symbol: "00700", market: "HK", currency, source: "baidu_gushitong", ...extra });
  const evs = [hk("ev-pel00001", "pe_ttm_latest", 13.8, "倍", "n/a", { raw_ref: "raw/pe.csv" }),
    hk("ev-pep00001", "pe_ttm_points", 784, "条", "n/a", { raw_ref: "raw/pe.csv", period: "2023-10-09..2026-10-08" }),
    hk("ev-px000001", "price", 411.4, "港元", "HKD", { source: "tencent" }), hk("ev-eps00001", "eps_consensus_mean", 28.98, "元/股", "CNY", { source: "yahoo" }),
    hk("ev-fx000001", "fx_hkd_cny", 0.8538, "CNY/HKD", "n/a", { source: "fx" })];
  const pr = calc("calc-a00000000000000a", "percentile_rank",
    { history: { history_csv: { raw_ref: "raw/pe.csv", column: "pe_ttm", where: {}, date_column: "date" } }, current: 13.8 }, ["ev-pep00001", "ev-pel00001"], [], 0.42, "分位");
  const fwd = calc("calc-b00000000000000b", "forward_pe", { price: 411.4, price_unit: "港元", eps_forecast: 28.98, eps_unit: "元/股", fx_rate: 0.8538, fx_unit: "CNY/HKD" },
    ["ev-px000001", "ev-eps00001", "ev-fx000001"]);
  const lines = reportPreludeLines(evs as never, [pr, fwd] as never);
  const pe = lines.find((l) => l.includes("PE 分位口径"));
  assert.ok(pe && pe.includes("历史序列来源 baidu_gushitong") && !pe.includes("未核实"), `港股分位的历史序列来源要认出百度:${pe}`);
  assert.ok(!lines.some((l) => l.includes("混用")), `已带汇率换算的前瞻 PE 不该报币种混用:${lines.join("\n")}`);
  const raw = calc("calc-b00000000000000c", "forward_pe", { price: 411.4, eps_forecast: 28.98 }, ["ev-px000001", "ev-eps00001"]);
  assert.ok(reportPreludeLines(evs as never, [raw] as never).some((l) => l.includes("混用了 CNY / HKD")), "没带汇率的仍要提示");
  const ttmA = ttm({}, NP, "calc-d00000000000000d"), ttmB = ttm({ end_period: P.q1fy25 }, NP.slice(0, 2), "calc-e00000000000000e");
  assert.ok(reportPreludeLines([] as never, [ttmA, ttmB] as never).some((l) => l.includes("期末不一致")), "累计推 TTM 的几项期末不同要提示");
});

test("港股代码不是数字主张:HK:00700 / 港股 0700 / (00700) / 00700.HK 都剥掉;同行的真数字与普通 5 位数照样核对", () => {
  const nums = (line: string) => claimNumbers(line, "00700");
  assert.deepEqual(nums("身份:腾讯控股(Tencent Holdings,HK:00700),报价币种 HKD"), []);
  assert.deepEqual(nums("港股 0700 与 港股：09988 的对照"), []);
  assert.deepEqual(nums("# 腾讯控股(00700)研究报告"), []);
  assert.deepEqual(nums("腾讯控股 00700.HK 现价 411.40 港元"), [411.4]);
  assert.deepEqual(nums("HK:00700 总市值 37406.98 亿港元"), [37406.98]);
  assert.deepEqual(nums("销量 12345 辆(12345)"), [12345, 12345], "不是港股语境的 5 位数仍是主张");
  // 港股语境后面紧跟金额 / 数量单位的是主张,不是代码(A 股报告里写南向资金也走这条)
  assert.deepEqual(nums("南向资金年内净买入港股 8000 亿港元"), [8000]);
  assert.deepEqual(nums("港股 12345 手"), [12345]);
  assert.deepEqual(nums("港股:1500 亿港元"), [1500]);
  assert.deepEqual(nums("HK 2350 亿港元"), [2350]);
  assert.deepEqual(nums("港股 2350 家公司"), [2350]);
  assert.deepEqual(nums("营收(01234 万元)"), [1234]);
  assert.deepEqual(nums("港股 8000 HKD"), [8000]);
  assert.deepEqual(nums("港股 3800 港元一手"), [3800]);
  assert.deepEqual(nums("同业(00700、腾讯音乐)"), [], "括号里代码后接分隔符");
  assert.deepEqual(nums("HK:00700 Tencent"), [], "代码后接公司英文名不当单位");
});
