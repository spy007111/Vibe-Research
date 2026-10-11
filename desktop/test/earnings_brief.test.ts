import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import {
  amountText, daysText, earningsSummary, forecastText, moveText, publishedText, reactionLine, signed, surpriseText,
  type EarningsBriefResult, type Num, type PastReport,
} from "../src/verticals/finance/lib/earningsBrief.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const ok = (value: number, display: string): Num => ({ status: "ok", value, display, reason: "" });
const nm = (reason: string): Num => ({ status: "not_meaningful", value: null, display: null, reason });
const past = (id: string, extra: Partial<PastReport> = {}): PastReport => ({
  id, period: "", published: "2026-08-15", timing: "before_open", reaction_day: "2026-08-17", merged: [], move: ok(-0.0364, "-3.64%"), pending: false, surprise: null, ...extra,
});

test("数字照抄 calc 的 display:正数补「+」,负数不动,没算出来是 null(界面写「—」,不写 0)", () => {
  assert.equal(signed(ok(0.0512, "5.12%")), "+5.12%");
  assert.equal(signed(ok(-0.02, "-2.00%")), "-2.00%");
  assert.equal(signed(ok(0, "0.00%")), "0.00%");
  assert.equal(signed(nm("x")), null);
  assert.equal(signed({ status: "not_meaningful", value: 0.1, display: "10.00%", reason: "x" }), null, "状态不是 ok 就不显示");
  assert.equal(signed({ status: "ok", value: 1, display: null, reason: "" }), null);
  assert.equal(signed(null), null);
  assert.deepEqual([moveText(past("a")), moveText(past("b", { pending: true, move: nm("反应日还没到") })), moveText(past("c", { move: null }))], ["-3.64%", "反应待定", "—"]);
  assert.deepEqual([daysText(16), daysText(0), daysText(-2), daysText(null)], ["还有 16 天", "就是今天", "已过 2 天", ""]);
});

test("金额只换算显示:元 → 亿元 / 万元;外币上亿写「亿 USD」;每股收益原样带单位;缺值写「—」", () => {
  assert.deepEqual([amountText(1.3e10, "元"), amountText(-1.96e7, "元"), amountText(5000, "元"), amountText(null, "元"), amountText(1e8, "元"), amountText(5e8, "元")], ["130.00 亿元", "-1960.00 万元", "5000 元", "—", "1.00 亿元", "5.00 亿元"]);
  assert.deepEqual([amountText(1.136e11, "USD"), amountText(2.02, "USD"), amountText(67.16, "元/股"), amountText(1, "")], ["1136.00 亿 USD", "2.02 USD", "67.16 元/股", "1"]);
});

test("实际 vs 预期:业绩预告写区间和落点、比中点的偏差;一致预期写偏差;偏差算不出写原因", () => {
  const f = { ...ok(0.1818, "18.18%"), basis: "forecast" as const, actual: 1.3e10, estimate: 1.1e10, low: 1e10, high: 1.2e10, position_label: "高于区间上限", unit: "元" };
  assert.equal(surpriseText(f), "实际归母净利 130.00 亿元,业绩预告 100.00 亿元 ~ 120.00 亿元,高于区间上限(比预告中点 +18.18%)");
  const c = { ...ok(-0.0674, "-6.74%"), basis: "consensus" as const, actual: 1.89, estimate: 2.02, low: null, high: null, position_label: null, unit: "USD" };
  assert.equal(surpriseText(c), "实际每股收益 1.89 USD,预期 2.02 USD,偏差 -6.74%");
  assert.equal(surpriseText({ ...c, ...nm("预期为 0,偏差比例无意义") }), "实际每股收益 1.89 USD,预期 2.02 USD(预期为 0,偏差比例无意义)");
  assert.equal(forecastText({ period: "2026-09-30", notice_date: "2026-10-05", type: "略增", lower: 1.5e10, upper: 1.6e10, change_lower: 5, change_upper: 12 }),
    "略增 · 归母净利 150.00 亿元 ~ 160.00 亿元,同比 +5% ~ +12%(2026-10-05 公告)");
  assert.equal(forecastText({ period: "x", notice_date: "2026-10-05", type: "", lower: null, upper: -2e7, change_lower: null, change_upper: null }),
    "归母净利 — ~ -2000.00 万元(2026-10-05 公告)");
});

test("对照句:平均算不出写原因;最近一次没算出来写原因", () => {
  assert.equal(reactionLine({ mean_abs: ok(0.04, "4.00%"), prior_n: 3, lookback: 4, latest_vs_mean: ok(1.25, "1.25 倍"), latest_id: "2026年半年报" }),
    "此前 3 次财报后当天涨跌的绝对值平均 4.00%;最近一次(2026年半年报)是平均的 1.25 倍");
  assert.equal(reactionLine({ mean_abs: ok(0.0425, "4.25%"), prior_n: 4, lookback: 4, latest_vs_mean: nm("最近一次没有算出涨跌"), latest_id: "2026年三季报" }),
    "此前 4 次财报后当天涨跌的绝对值平均 4.25%;最近一次(2026年三季报)没比:最近一次没有算出涨跌");
  assert.equal(reactionLine({ mean_abs: nm("此前算得出的只有 1 次,少于 2 次不算平均"), prior_n: 1, lookback: 4, latest_vs_mean: nm("x"), latest_id: "a" }), "此前算得出的只有 1 次,少于 2 次不算平均");
});

const RES: EarningsBriefResult = {
  symbol: "600519", market: "CN",
  upcoming: { period: "2026-09-30", label: "2026年三季报", date: "2026-10-31", days: 23, note: "东财预约披露日,公司可以改期,以交易所公告为准" },
  consensus: { label: "FY2026 全年每股收益一致预期(全年的,不是这一季的)", unit: "元/股", mean: 67.16, low: 64.7, high: 70.97, count: 46, dispersion: ok(1.0969, "1.10 倍"), revenue_mean: null },
  forecast: null,
  history: [
    past("2026年半年报"),
    past("2026年一季报", { published: "2026-04-25", reaction_day: "2026-04-27", merged: ["2025年年报"], move: ok(0.06, "6.00%") }),
    past("2025年年报", { published: "2026-04-17", reaction_day: "2026-04-17", move: ok(-0.0388, "-3.88%"),
      surprise: { ...ok(-0.0003, "-0.02542%"), basis: "forecast", actual: 1.0797e10, estimate: 1.08e10, low: 9.8e9, high: 1.18e10, position_label: "落在区间内", unit: "元" } }),
  ],
  reaction: { mean_abs: ok(0.0234, "2.34%"), prior_n: 4, lookback: 4, latest_vs_mean: ok(1.56, "1.56 倍"), latest_id: "2026年半年报" },
  intraday: false, fetched_at: "2026-10-08T08:00:00Z", cached: false, generated_at: "", gaps: ["同花顺没有 FY2026 的一致预期"], sources: ["东财预约披露表"],
};

test("给「问 Agent」的几行:前瞻、预期、每次财报的反应日涨跌和偏差、对照句、口径和不预测声明、缺口", () => {
  assert.deepEqual(earningsSummary(null), []);
  assert.deepEqual(earningsSummary(RES), [
    "【财报前瞻】下一份:2026年三季报 2026-10-31(还有 23 天);东财预约披露日,公司可以改期,以交易所公告为准",
    "【一致预期】FY2026 全年每股收益一致预期(全年的,不是这一季的):均值 67.16 元/股,区间 64.7 ~ 70.97 元/股 · 46 家,最高 ÷ 最低 1.10 倍",
    "【财报复盘】涨跌 = 财报后第一个交易日收盘 ÷ 前一交易日收盘 − 1,用复权价,含当天大盘涨跌;只描述过去几次财报后的表现,不预测下一次,不构成投资建议:",
    "  2026年半年报(2026-08-15 正式披露) → 2026-08-17 -3.64%",
    "  2026年一季报(2026-04-25 正式披露) → 2026-04-27 +6.00%(和 2025年年报 同一个反应日)",
    "  2025年年报(2026-04-17 正式披露) → 2026-04-17 -3.88%;实际归母净利 107.97 亿元,业绩预告 98.00 亿元 ~ 118.00 亿元,落在区间内(比预告中点 -0.02542%)",
    "  此前 4 次财报后当天涨跌的绝对值平均 2.34%;最近一次(2026年半年报)是平均的 1.56 倍",
    "【缺口·财报】同花顺没有 FY2026 的一致预期",
  ]);
  const lines = earningsSummary({ ...RES, intraday: true, upcoming: null, consensus: null, history: [past("2Q2026", { published: "2026-07-30 00:00", timing: null, reaction_day: null, move: null }), past("x", { pending: true, reaction_day: null, move: nm("反应日还没到") })], reaction: null, gaps: [] });
  assert.deepEqual(lines.slice(1), ["  2Q2026(2026-07-30 00:00(发布时刻不明))", "  x(2026-08-15 正式披露) → 反应待定", "  最近一次的反应日就是今天、还没收盘:涨跌按最新价,收盘后会变"]);
  assert.doesNotMatch(earningsSummary(RES).join("\n"), /目标价|买入|卖出|评级|胜率/);
  // A 股没有发布时刻,不写成「开盘前发布」;美股 / 港股有时刻才写时段(审查 R3-6)
  assert.equal(publishedText(past("a"), "CN"), "2026-08-15 正式披露");
  assert.equal(publishedText(past("u", { published: "2026-07-30 16:30", timing: "after_close" }), "US"), "2026-07-30 16:30 收盘后发布");
});

test("前端调用:GET /view/earnings_brief?symbol=…(编码),重新取带 refresh=1", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => { urls.push(String(input)); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try { await backend.earningsBrief({ symbol: "600519" }); await backend.earningsBrief({ symbol: "BRK.B", refresh: true }); } finally { globalThis.fetch = prev; }
  assert.deepEqual(urls, ["/api/view/earnings_brief?symbol=600519", "/api/view/earnings_brief?symbol=BRK.B&refresh=1"]);
});

test("个股研究页:看走势的那只下面放财报卡(A 股 / 港股 / 美股);只把这只的结果拼进上下文;卡片不用红绿、写明不预测", () => {
  const page = read("pages/Research.tsx");
  // 个股页概览：选了股票就直接显示 K 线、财报卡、事件回看（不用再点「看走势」）
  assert.match(page, /\{chartSymbol \? <>\s*<KlineCard symbol=\{chartSymbol\} \/>[\s\S]{0,200}<EarningsBriefCard symbol=\{chartSymbol\} onData=\{setEarn\} \/>[\s\S]{0,200}<EventStudyCard symbol=\{chartSymbol\} onData=\{setEvents\} \/>/);
  assert.match(page, /<div hidden=\{tab !== "overview"\}>/, "切走只藏起来,结果不丢");
  assert.match(page, /earn && earn\.symbol === chartSymbol\.toUpperCase\(\) \? `\\n\\n个股财报\(\$\{earn\.symbol\}\):\\n\$\{earningsSummary\(earn\)/, "别的票的结果不进上下文");
  const card = read("components/EarningsBriefCard.tsx");
  assert.match(card, /backend\.earningsBrief\(\{ symbol, refresh \}\)/);
  assert.match(card, /if \(my !== seq\.current\) return;/, "慢请求回来时已经换了票就丢掉");
  assert.match(card, /if \(!refresh\) \{ setData\(null\); onData\(null\); \}/, "换票先清掉上一只的");
  assert.doesNotMatch(card, /text-danger|text-success|text-red|text-green|bg-red|bg-green/);
  assert.match(card, /PAST_ONLY/);
  assert.match(card, /以公司公告为准/);
  assert.match(card, /没取到的/);
});
