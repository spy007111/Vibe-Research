/**
 * 每日复盘的解析:取数层信封 → 页面和提示词要的数。全程假数据。
 * 🔴 重点测「取不到就是 null / 不算」:合计里有一项缺就不合计、池子不全就不算晋级、失败块的证据不用。
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PageBlock, PageResult } from "../src/verticals/finance/lib/backend.ts";
import {
  breadthLabel, parseBoardFlow, parseBreadth, parseDragon, parseMargin, parseReview, parseShortTerm, parseTrend,
  parseTurnover, parseValuation, reviewLines, speculationLabel, staleNote,
} from "../src/verticals/finance/lib/marketReview.ts";

type Ev = { field: string; value: number | string | null; record_key?: string; period?: string; note?: string; unit?: string };
const env = (evidence: Ev[], extra: Record<string, unknown> = {}, missing: unknown[] = []) =>
  ({ status: "ok", evidence: evidence.map((e) => ({ period: "2026-10-08", unit: "", ...e })), extra, missing }) as never;
const block = (id: string, envelope: unknown, status: PageBlock["status"] = "ok"): PageBlock =>
  ({ id, title: id, note: null, status, fetched_at: "2026-10-09T10:00:00+08:00", envelope }) as PageBlock;
const page = (blocks: PageBlock[], ctx: Partial<PageResult["context"]> = {}): PageResult => ({
  query: "review", title: "每日复盘", intent: "", blocks, oldest_fetched_at: null, mixed_ages: false,
  context: { last_trading_day: "2026-10-09", previous_trading_day: "2026-10-08", is_today_trading_day: true, session_phase: "trading", review_date: "2026-10-08", realtime_matches_review_day: false, ...ctx },
});

test("涨跌分布:上涨 / 下跌 / 平盘按档位合计;涨 5% 以上 = 5~6% 那档起到涨停;三所成交额缺一所就不合计", () => {
  const dist = (k: number, n: number, label: string) => ({ field: "market_dist_count", value: n, record_key: `dist|${k}`, note: label, period: "2026-10-09" });
  const ex = (m: string, up: number | null, amount: number | null) => [
    ...(up === null ? [] : [{ field: "market_up_count", value: up, record_key: `exchange|${m}` }]),
    { field: "market_down_count", value: 100, record_key: `exchange|${m}` },
    ...(amount === null ? [] : [{ field: "market_turnover_amount", value: amount, record_key: `exchange|${m}` }]),
  ];
  const b = parseBreadth(env([
    dist(11, 40, "涨停"), dist(6, 30, "涨 5~6%"), dist(5, 50, "涨 4~5%"), dist(1, 900, "涨 0~1%"), dist(0, 100, "平盘"),
    dist(-1, 800, "跌 0~1%"), dist(-6, 20, "跌 5~6%"), dist(-11, 5, "跌停"),
    ...ex("SH", 1000, 6e11), ...ex("SZ", 1200, 7e11), ...ex("BJ", null, 1e10),
  ], { date: "2026-10-09" }))!;
  assert.deepEqual(b.buckets.map((x) => x.key), [11, 6, 5, 1, 0, -1, -6, -11], "从涨停排到跌停");
  assert.equal(b.up, 40 + 30 + 50 + 900);
  assert.equal(b.down, 800 + 20 + 5);
  assert.equal(b.flat, 100);
  assert.equal(b.up5, 70);
  assert.equal(b.down5, 25);
  assert.equal(b.limitUp, 40);
  assert.equal(b.limitDown, 5);
  assert.equal(b.date, "2026-10-09");
  assert.equal(b.amount, 6e11 + 7e11 + 1e10);
  assert.equal(b.exchanges.find((x) => x.market === "BJ")!.up, null, "北交所上涨家数没给就是 null,不是 0");
  assert.equal(b.label, breadthLabel(1020, 825));
  const noBj = parseBreadth(env([dist(1, 5, "x"), ...ex("SH", 1, 6e11), ...ex("SZ", 1, 7e11), ...ex("BJ", 1, null)]))!;
  assert.equal(noBj.amount, null, "缺一所的成交额,合计就不算 —— 少算一所比空着更误导");
  const none = parseBreadth(env([...ex("SH", 1, 6e11)]))!;
  assert.equal(none.up, null, "分布没取到时涨跌家数是 null(三所家数口径不同,不拿来顶)");
});

test("派生标签按写死的阈值", () => {
  assert.equal(breadthLabel(29, 71), "冰点");
  assert.equal(breadthLabel(30, 70), "偏弱");
  assert.equal(breadthLabel(50, 50), "中性");
  assert.equal(breadthLabel(69, 31), "偏强");
  assert.equal(breadthLabel(70, 30), "普涨");
  assert.equal(breadthLabel(null, 10), "");
  assert.equal(speculationLabel(19, 9), "冰点");
  assert.equal(speculationLabel(30, 4), "普通");
  assert.equal(speculationLabel(30, 5), "活跃");
  assert.equal(speculationLabel(70, 1), "亢奋");
  assert.equal(speculationLabel(null, 5), "");
  // 第四轮审计 C6:最高连板没取到 / 只取到一部分,分不出普通还是活跃
  assert.equal(speculationLabel(30, null), "", "涨停梯队没取到:不能按 0 板当「普通」");
  assert.equal(speculationLabel(30, 4, false), "", "梯队只有一部分有连板数:已知最大值不等于全池最大值");
  assert.equal(speculationLabel(30, 6, false), "活跃", "已知就有 ≥5 板的,部分数据也够判活跃");
  assert.equal(speculationLabel(45, null), "活跃", "40 家以上不看连板");
});

const zt = (code: string, boards: number, seal: string, extra: Partial<Record<string, number>> = {}) => [
  { field: "pool_limit_days", value: boards, record_key: code, note: `${code} 股${code} 出版 ${boards}天${boards}板 首封 ${seal}` },
  { field: "pool_change_pct", value: 10, record_key: code, note: `${code} 股${code} 出版 ${boards}天${boards}板 首封 ${seal}` },
  ...Object.entries(extra).map(([f, v]) => ({ field: f, value: v!, record_key: code, note: `${code} 股${code} 出版 ${boards}天${boards}板 首封 ${seal}` })),
];
const yz = (code: string, yDays: number | null, pct: number) => [
  ...(yDays === null ? [] : [{ field: "pool_y_limit_days", value: yDays, record_key: code, note: `${code} 股${code} 出版` }]),
  { field: "pool_change_pct", value: pct, record_key: code, note: `${code} 股${code} 出版` },
];
const SENT = env([{ field: "limit_up_count", value: 4 }, { field: "break_board_count", value: 4 }, { field: "limit_down_count", value: 2 }]);
const ZT = env([{ field: "limit_up_pool_count", value: 4 }, ...zt("600001", 1, "10:00:00"), ...zt("600002", 2, "09:25:00", { pool_price: 11.39, pool_amount: 6.4e7 }),
  ...zt("600003", 2, "09:30:00"), ...zt("600004", 5, "13:00:00")]);
const YZT = env([{ field: "yesterday_limit_up_pool_count", value: 6 },
  ...yz("600002", 1, 10), ...yz("600003", 1, 10), ...yz("600009", 1, -6), ...yz("600010", 1, -9.5), ...yz("600004", 4, 10), ...yz("600011", null, 2)]);
const REASON = env([{ field: "strong_stock_reason", value: "固态电池+铝塑膜", record_key: "600004" }]);

test("短线:计数、封板率、连板分层;个股按连板数 → 首封早的排;价格成交额用池子当天的;题材原文挂上", () => {
  const s = parseShortTerm(page([block("sentiment", SENT), block("zt_pool", ZT), block("yzt", YZT), block("reason", REASON)]))!;
  assert.deepEqual([s.zt, s.zb, s.dt], [4, 4, 2]);
  assert.equal(s.sealRate, 0.5);
  assert.equal(s.maxBoards, 5);
  assert.equal(s.lianban, 3);
  assert.deepEqual(s.ladder, [{ boards: 4, count: 1, plus: true }, { boards: 2, count: 2, plus: false }, { boards: 1, count: 1, plus: false }]);
  assert.deepEqual(s.stocks.map((x) => x.code), ["600004", "600002", "600003", "600001"], "2 板里 09:25 封的排在 09:30 前");
  assert.equal(s.stocks[1]!.price, 11.39);
  assert.equal(s.stocks[1]!.amount, 6.4e7);
  assert.equal(s.stocks[2]!.price, null, "池子没给价就是 null,不另拉实时行情补(看上一个交易日时那是今天的价)");
  assert.equal(s.stocks[0]!.reason, "固态电池+铝塑膜");
  assert.equal(s.stocks[0]!.firstSeal, "13:00");
});

test("赚钱效应:昨天涨停的今天平均 / 中位数 / 红盘比例 / 大跌只数,逐只算", () => {
  const y = parseShortTerm(page([block("sentiment", SENT), block("zt_pool", ZT), block("yzt", YZT)]))!.yesterday!;
  assert.equal(y.count, 6);
  assert.equal(y.n, 6);
  assert.equal(y.avg, Math.round(((10 + 10 - 6 - 9.5 + 10 + 2) / 6) * 100) / 100);
  assert.equal(y.median, 6, "中位数 = (2 + 10) / 2");
  assert.deepEqual([y.up, y.down, y.loss5, y.loss9], [4, 2, 2, 1]);
});

test("晋级:昨天 k 板 ∩ 今天涨停;连板数没给的只进总数;两个池有一个不全就不算", () => {
  const s = parseShortTerm(page([block("zt_pool", ZT), block("yzt", YZT)]))!;
  assert.deepEqual(s.promotion!.map((t) => [t.from, t.promoted, t.base]), [[1, 2, 4], [4, 1, 1]]);
  assert.deepEqual(s.promotionAll, { base: 6, promoted: 3, rate: 0.5 });
  assert.equal(s.zt, 4, "没有情绪块时涨停数取池子自己的计数");
  assert.equal(s.zb, null);
  assert.equal(s.sealRate, null, "炸板数取不到,封板率就不算");
  const partial = parseShortTerm(page([block("zt_pool", ZT, "partial"), block("yzt", YZT)]))!;
  assert.equal(partial.promotion, null);
  assert.match(partial.promotionGap, /只取到一部分/);
  const noY = parseShortTerm(page([block("zt_pool", ZT), block("yzt", { status: "failed", evidence: [] }, "failed")]))!;
  assert.equal(noY.promotion, null);
  assert.equal(noY.yesterday, null, "失败块的证据一条不用");
  assert.match(noY.promotionGap, /昨天的涨停池没取到/);
  const emptyY = parseShortTerm(page([block("zt_pool", ZT), block("yzt", env([{ field: "yesterday_limit_up_pool_count", value: 0 }]), "partial")]))!;
  assert.equal(emptyY.yesterday, null, "昨日涨停池是空的：赚钱 / 亏钱效应是不知道，不写 0 涨 0 跌");
});

test("中长线:指数各窗口、均线、一年高点日期;成交额按日期排、和均值比", () => {
  const n = "上证指数(000001);按收盘价(腾讯日线);最新一根=2026-10-08";
  const ix = (field: string, value: number, extra = "") => ({ field, value, record_key: "index|000001", note: n + extra });
  const t = parseTrend(env([
    ix("index_close", 3800), ix("index_change_pct", -0.33), ix("index_return_20d", -3.6), ix("index_ma20", 3900), ix("index_ma60", 3700),
    ix("index_high_250d", 4242.57, ";250 日最高收盘,日期=2026-05-13"), ix("index_off_high_250d_pct", -10.45),
    { field: "market_amount_total", value: 1.6e12, record_key: "amount|2026-10-08", period: "2026-10-08" },
    { field: "market_amount_total", value: 1.4e12, record_key: "amount|2026-09-30", period: "2026-09-30" },
    { field: "market_amount_ma20", value: 1.8e12, record_key: "amount|avg" },
    { field: "market_amount_ma60", value: 1.6e12, record_key: "amount|avg" },
  ], {}, [{ field: "index_close", reason: "北证50(899050) 没取到" }]))!;
  const sh = t.indices[0]!;
  assert.equal(sh.name, "上证指数");
  assert.equal(sh.high250Date, "2026-05-13");
  assert.equal(sh.r60, null);
  assert.deepEqual(t.amounts.map((a) => a.date), ["2026-09-30", "2026-10-08"]);
  assert.equal(t.amountDate, "2026-10-08");
  assert.equal(t.vsMa20, -11.11);
  assert.equal(t.vsMa60, 0);
  assert.deepEqual(t.missing, ["北证50(899050) 没取到"]);
  assert.equal(t.partial, false);
});

test("🔴 盘中成交额:最新一根是今天就当没收完 —— 不和整天均值比,均值用不含它的那组", () => {
  const days = Array.from({ length: 22 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const amt = days.map((d, i) => ({ field: "market_amount_total", value: i === 21 ? 6e11 : 2e12, record_key: `amount|${d}`, period: d }));
  const avg = (prior: boolean) => [
    { field: "market_amount_ma20", value: (19 * 2e12 + 6e11) / 20, record_key: "amount|avg" },
    ...(prior ? [{ field: "market_amount_ma20_prior", value: 2e12, record_key: "amount|avg" }] : []),
  ];
  const t = parseTrend(env([...amt, ...avg(true)]), "2026-09-22")!;
  assert.equal(t.partial, true);
  assert.equal(t.ma20, 2e12, "用取数层给的不含今天的均值");
  assert.equal(t.vsMa20, null, "半天的量不和整天比");
  assert.deepEqual([t.prevAmountDate, t.prevAmount], ["2026-09-21", 2e12]);
  assert.equal(t.ma60, null, "收完的日子不够 60 天,就是 null,不拿含今天的那组顶上");
  // 取数层没给 prior:用已收完的日子自己算
  assert.equal(parseTrend(env([...amt, ...avg(false)]), "2026-09-22")!.ma20, 2e12);
  // 不是盘中(或最新一根不是今天):照常比
  const c = parseTrend(env([...amt, ...avg(true)]), null)!;
  assert.equal(c.partial, false);
  assert.ok(c.vsMa20 !== null && c.vsMa20 < 0);
  // 提示词:盘中累计要写明没收完、不比均值
  const pg = page([block("trend", env([...amt, ...avg(true)]))], { review_date: "2026-09-22", live: true, realtime_matches_review_day: true });
  const line = reviewLines(pg, parseReview(pg)).find((l) => l.startsWith("【两市成交额"))!;
  assert.match(line, /盘中累计,还没收完/);
  assert.doesNotMatch(line, /%\)/, "不写和均值比的百分比");
});

test("两融:逐日余额与 5 / 20 日变化;近 5 日净买入有一天缺就不合计", () => {
  const day = (i: number, bal: number, nb: number | null) => [
    { field: "market_margin_balance", value: bal, record_key: `margin|2026-09-${String(i).padStart(2, "0")}`, period: `2026-09-${String(i).padStart(2, "0")}` },
    ...(nb === null ? [] : [{ field: "market_financing_net_buy", value: nb, record_key: `margin|2026-09-${String(i).padStart(2, "0")}` }]),
  ];
  const m = parseMargin(env([...day(1, 100, 1), ...day(2, 101, 1), ...day(3, 102, 1), ...day(4, 103, 1), ...day(5, 104, 1), ...day(8, 110, 2),
    { field: "market_financing_float_pct", value: 2.65, record_key: "margin|latest" }]))!;
  assert.equal(m.date, "2026-09-08");
  assert.equal(m.balance, 110);
  assert.equal(m.chg5, 10);
  assert.equal(m.chg20, null, "没有 20 天前那一天,不拿最早一天顶");
  assert.equal(m.netBuy5, 6);
  assert.equal(m.floatPct, 2.65);
  const gap = parseMargin(env([...day(1, 100, 1), ...day(2, 101, null), ...day(3, 102, 1), ...day(4, 103, 1), ...day(5, 104, 1)]))!;
  assert.equal(gap.netBuy5, null);
});

test("估值与国债:取最新一行;盈利收益率 = 1 ÷ 市盈率;两个差值只在两边都有时算", () => {
  const v = parseValuation(env([
    { field: "index_pe_total", value: 14.0, record_key: "000300:2026-10-07" },
    { field: "index_pe_total", value: 14.28, record_key: "000300:2026-10-08" },
    { field: "index_dividend_yield_total", value: 2.76, record_key: "000300:2026-10-08" },
  ]), env([{ field: "yield_10y", value: 1.6899, record_key: "chinabond:中债国债收益率曲线" }]))!;
  assert.equal(v.date, "2026-10-08");
  assert.equal(v.pe, 14.28);
  assert.equal(v.ey, 7);
  assert.equal(v.dySpread, 1.07);
  assert.equal(v.eySpread, 5.31);
  const noBond = parseValuation(env([{ field: "index_pe_total", value: 14.28, record_key: "000300:2026-10-08" }]), undefined)!;
  assert.equal(noBond.y10, null);
  assert.equal(noBond.eySpread, null);
});

test("板块资金:东财 / 新浪两种口径都认,按净额排;新浪带领涨股", () => {
  const em = parseBoardFlow(env([
    { field: "board_main_net_today", value: -5e8, record_key: "BK1", note: "银行 排名 2" },
    { field: "board_main_net_today", value: 9e8, record_key: "BK2", note: "半导体 排名 1" },
    { field: "board_change_pct_today", value: 1.2, record_key: "BK2", note: "半导体 排名 1" },
  ]))!;
  assert.equal(em.source, "东财");
  assert.deepEqual(em.rows.map((r) => [r.name, r.net]), [["半导体", 9e8], ["银行", -5e8]]);
  const sina = parseBoardFlow(env([
    { field: "board_net_sina", value: 3.7e9, record_key: "industry|new_swzz", note: "生物制药 排名 1;领涨 华北制药 10.0365%;新浪口径" },
    { field: "board_change_pct_sina", value: 1.07, record_key: "industry|new_swzz", note: "生物制药 排名 1;领涨 华北制药 10.0365%;新浪口径" },
  ]))!;
  assert.equal(sina.source, "新浪");
  assert.equal(sina.rows[0]!.leader, "华北制药 10.04%");
  assert.equal(sina.rows[0]!.pct, 1.07);
});

test("成交额榜:东财带行业、新浪不带也认;按名次排", () => {
  const t = parseTurnover(env([
    { field: "turnover_rank", value: 2, record_key: "stock|600519", note: "贵州茅台(600519);成交额榜第 2 名(新浪沪深京 A 股,共 5572 只)" },
    { field: "turnover_amount", value: 1e10, record_key: "stock|600519", note: "贵州茅台(600519);成交额榜第 2 名" },
    { field: "turnover_rank", value: 1, record_key: "stock|300308", note: "中际旭创(300308)·通信设备;成交额榜第 1 名(全市场 5904 只)" },
    { field: "market_cap", value: 9e11, record_key: "stock|300308", note: "中际旭创(300308)·通信设备;成交额榜第 1 名(全市场 5904 只)" },
  ]))!;
  assert.deepEqual(t.rows.map((r) => [r.code, r.name, r.industry]), [["300308", "中际旭创", "通信设备"], ["600519", "贵州茅台", ""]]);
  assert.equal(t.rows[0]!.mcap, 9e11);
  assert.equal(t.rows[1]!.mcap, null);
});

test("龙虎榜:同一只多条理由不相加,买 / 卖榜每只留一条;万元换成元", () => {
  const d = parseDragon(env([
    { field: "dragon_tiger_market_net_buy", value: 37046.9, record_key: "002384|日跌幅偏离", note: "002384 东山精密:日跌幅偏离值达到7%的前5只证券" },
    { field: "dragon_tiger_market_net_buy", value: 100, record_key: "002384|三日累计", note: "002384 东山精密:连续三个交易日累计" },
    { field: "dragon_tiger_market_net_buy", value: -500, record_key: "600001|振幅", note: "600001 某股:日振幅值达到15%" },
    { field: "dragon_tiger_market_net_buy", value: null, record_key: "600002|振幅", note: "600002 另一只:x" },
  ]))!;
  assert.equal(d.stocks, 3);
  assert.deepEqual(d.buy.map((x) => [x.code, x.net]), [["002384", 37046.9 * 1e4]]);
  assert.equal(d.buy[0]!.reason, "日跌幅偏离值达到7%的前5只证券");
  assert.deepEqual(d.sell.map((x) => [x.name, x.net]), [["某股", -5e6]]);
});

test("快照标注:只给当天的块在盘中看上一个交易日时标「此刻快照」;别的块数据日不同时写数据日", () => {
  const p = page([]);
  assert.match(staleNote(p, "breadth", "2026-10-09"), /^此刻快照\(2026-10-09\)/);
  assert.equal(staleNote(page([], { realtime_matches_review_day: true, review_date: "2026-10-09" }), "breadth", "2026-10-09"), "");
  assert.equal(staleNote(p, "margin", "2026-10-08"), "");
  assert.equal(staleNote(page([], { review_date: "2026-10-09", realtime_matches_review_day: true }), "margin", "2026-10-08"), "数据日 2026-10-08(业务日 2026-10-09)");
  assert.equal(staleNote(null, "breadth", "2026-10-09"), "");
});

test("提示词:块没取到写【缺口】;派生标签带规则;此刻快照写进标签;晋级不全时写原因", () => {
  const p = page([block("sentiment", SENT), block("zt_pool", ZT, "partial"), block("yzt", YZT),
    block("breadth", env([{ field: "market_dist_count", value: 10, record_key: "dist|1", period: "2026-10-09" }], { date: "2026-10-09" })),
    block("trend", { status: "failed", evidence: [] }, "failed")]);
  const lines = reviewLines(p, parseReview(p));
  const text = lines.join("\n");
  assert.match(text, /【涨跌面·此刻快照\(2026-10-09\)/);
  assert.match(text, /规则:上涨家数 ÷/);
  assert.match(text, /【缺口】主要指数中长线这次没取到/);
  assert.match(text, /【缺口】两融余额这次没取到/);
  assert.match(text, /【缺口·晋级】涨停池只取到一部分/);
  assert.doesNotMatch(text, /NaN|undefined/);
});

test("短线三张卡片各标各的数据日:昨日涨停池停在上一天时,不被情绪那份的今天盖住", () => {
  const sent = env([{ field: "limit_up_count", value: 4 }], { date: "2026-10-09" });
  const zp = env([{ field: "limit_up_pool_count", value: 1 }, ...zt("600001", 1, "10:00:00")], { date: "2026-10-09" });
  const yp = env([{ field: "yesterday_limit_up_pool_count", value: 1 }, ...yz("600002", 1, 3)], { date: "2026-10-08" });
  const s = parseShortTerm(page([block("sentiment", sent), block("zt_pool", zp), block("yzt", yp)]))!;
  assert.equal(s.date, "2026-10-09");
  assert.deepEqual(s.dates, { sentiment: "2026-10-09", zt: "2026-10-09", yzt: "2026-10-08" });
  const noSent = parseShortTerm(page([block("zt_pool", zp), block("yzt", yp)]))!;
  assert.equal(noSent.dates.sentiment, null, "没取到的那份没有日期,不借别的");
});
