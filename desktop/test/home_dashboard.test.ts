import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import type { Quote } from "../src/verticals/finance/lib/api.ts";
import type { HoldingRow, Trade } from "../src/verticals/finance/lib/holdings.ts";
import { homeHoldings, homeTotals, quoteDay, sessionDay } from "../src/verticals/finance/lib/homeDashboard.ts";
import { textOf, withRenderer } from "./helpers/render.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const at = (iso: string) => new Date(iso);

test("行情上的「当日」：周末和开盘前算上一个工作日，按各市场当地时间（含美东夏令时切换）", () => {
  // 2026-10-09 是周五
  assert.equal(sessionDay("CN", at("2026-10-09T02:00:00Z")), "2026-10-09", "上海 10:00 开盘后");
  assert.equal(sessionDay("CN", at("2026-10-09T01:00:00Z")), "2026-10-08", "上海 9:00 开盘前");
  assert.equal(sessionDay("CN", at("2026-10-09T01:30:00Z")), "2026-10-09", "上海 9:30 整点算开盘");
  assert.equal(sessionDay("CN", at("2026-10-10T04:00:00Z")), "2026-10-09", "周六");
  assert.equal(sessionDay("HK", at("2026-10-11T04:00:00Z")), "2026-10-09", "周日");
  assert.equal(sessionDay("CN", at("2026-10-12T00:30:00Z")), "2026-10-09", "周一开盘前 = 上周五");
  assert.equal(sessionDay("CN", at("2026-11-02T00:00:00Z")), "2026-10-30", "跨月");
  // 纽约：周五 22:00 时上海已是周六，美股的「当日」仍是周五
  assert.equal(sessionDay("US", at("2026-10-10T02:00:00Z")), "2026-10-09");
  assert.equal(sessionDay("US", at("2026-10-09T13:00:00Z")), "2026-10-08", "夏令时 9:00 开盘前");
  assert.equal(sessionDay("US", at("2026-10-09T14:00:00Z")), "2026-10-09", "夏令时 10:00");
  // 11-01 起冬令时（UTC-5）：14:00Z 是 9:00，还没开盘；写死 UTC-4 会算成 10:00 已开盘
  assert.equal(sessionDay("US", at("2026-11-02T14:00:00Z")), "2026-10-30", "冬令时 9:00 开盘前 = 上周五");
  assert.equal(sessionDay("US", at("2026-11-02T14:40:00Z")), "2026-11-02", "冬令时 9:40");
});

const row = (symbol: string, shares: number, cost_total: number, name = ""): HoldingRow => ({
  symbol, name, shares, cost_total, unit_cost: shares ? cost_total / shares : 0, opened_at: "2026-01-05",
  lots: [], realized_pnl: 0, dividends: 0, fees: 0, trade_count: 1,
});
const trade = (symbol: string, type: string, date: string): Trade => ({
  id: `${symbol}-${type}-${date}`, symbol, name: "", account: "", type, date, shares: 100, price: 1, fee: 0, amount: null, ratio: null,
  note: "", migrated_from: "", created_at: `${date}T08:00:00Z`,
});
const quote = (name: string, price: number | null, last_close: number | null, change_pct: number | null = null, quote_time?: string) =>
  ({ name, price, last_close, change_pct, quote_time } as Quote);

// 周五上海 10:00、纽约前一天夜里：CN/HK 的当日 = 10-09，US 的当日 = 10-08
const NOW = at("2026-10-09T02:00:00Z");
const view = {
  holdings: [
    row("600519", 100, 150000, "贵州茅台"),
    row("00700.HK", 200, 60000),
    row("AAPL", 10, 2000),
    row("000001", 1000, 10000),
    row("300750", 100, 20000),
    row("sh601318", 100, 5000),
    row("002594", 0, 0),          // 已清仓
    row("???", 100, 100),         // 认不出的代码
  ],
  trades: [
    trade("600519", "opening", "2026-10-09"),   // 迁移来的期初持仓日期就是今天：不能当成今天买的
    trade("300750", "buy", "2026-10-09"),       // 今天真买了：当日盈亏不能只按昨收算
    trade("sh601318", "split", "2026-10-09"),   // 代码写法不同也要认出是同一只
    trade("00700.HK", "buy", "2026-10-08"),     // 昨天买的不影响今天
    trade("000001", "dividend", "2026-10-09"),  // 分红不改股数
  ],
};
const quotes: Record<string, Quote> = {
  "600519": quote("贵州茅台", 1500, 1480, 1.35),
  "00700.HK": quote("腾讯控股", 400, 410, -2.44),
  "000001": quote("平安银行", 11, null, 0.5),
  "300750": quote("宁德时代", 210, 200, 5),
  "601318": quote("中国平安", 0, 50, null),     // 现价 0 = 没取到，不是跌到 0
};

test("首页持仓：市值、持仓盈亏、当日盈亏；取不到的给 null 并说明原因，不填 0", () => {
  const rows = homeHoldings(view, quotes, NOW);
  assert.deepEqual(rows.map((r) => r.code), ["600519", "00700.HK", "AAPL", "000001", "300750", "601318"], "清仓的、认不出的不列");
  const by = Object.fromEntries(rows.map((r) => [r.code, r]));
  assert.deepEqual(
    { mv: by["600519"].market_value, pnl: by["600519"].pnl, pct: by["600519"].pnl_pct, day: by["600519"].day_pnl, note: by["600519"].day_note },
    { mv: 150000, pnl: 0, pct: 0, day: 2000, note: null }, "期初持仓不挡当日盈亏");
  assert.equal(by["600519"].name, "贵州茅台");
  assert.deepEqual([by["00700.HK"].market_value, by["00700.HK"].pnl, by["00700.HK"].pnl_pct, by["00700.HK"].day_pnl], [80000, 20000, 33.33, -2000]);
  assert.equal(by["00700.HK"].name, "腾讯控股", "持仓里没名字时用行情里的");
  assert.equal(by["00700.HK"].currency, "HKD");
  assert.deepEqual([by.AAPL.price, by.AAPL.market_value, by.AAPL.pnl, by.AAPL.pnl_pct, by.AAPL.day_pnl, by.AAPL.change_pct], [null, null, null, null, null, null]);
  assert.equal(by.AAPL.day_note, "没取到现价");
  assert.equal(by.AAPL.name, "AAPL");
  assert.equal(by["000001"].market_value, 11000);
  assert.equal(by["000001"].day_pnl, null);
  assert.equal(by["000001"].day_note, "没取到昨收");
  assert.equal(by["300750"].market_value, 21000);
  assert.equal(by["300750"].day_pnl, null);
  assert.match(by["300750"].day_note ?? "", /有买卖或送转/);
  assert.equal(by["601318"].price, null, "现价 0 当没取到");
  assert.equal(by["601318"].market_value, null);
  assert.equal(by["601318"].day_note, "没取到现价");
});

test("当日盈亏只看这只最近一个交易日有没有改变股数：买入日早于当日就照常算", () => {
  const v = { holdings: [row("300750", 100, 20000)], trades: [trade("300750", "buy", "2026-10-09")] };
  const q = { "300750": quote("宁德时代", 210, 200) };
  assert.equal(homeHoldings(v, q, NOW)[0].day_pnl, null, "当日买的");
  // 周一开盘前看：行情还是周五的，周五那笔买入照样挡住
  assert.equal(homeHoldings(v, q, at("2026-10-12T00:30:00Z"))[0].day_pnl, null);
  // 周一开盘后：周五的买入已经过去了
  assert.equal(homeHoldings(v, q, at("2026-10-12T02:00:00Z"))[0].day_pnl, 1000);
  const sold = { holdings: [row("300750", 100, 20000)], trades: [trade("300750", "sell", "2026-10-09")] };
  assert.equal(homeHoldings(sold, q, NOW)[0].day_pnl, null, "当日卖出一部分");
});

test("行情自带的成交时间：三地写法都认成当地日期，认不出给 null", () => {
  assert.equal(quoteDay("20261009110653"), "2026-10-09", "A 股");
  assert.equal(quoteDay("2026/10/09 10:51:51"), "2026-10-09", "港股");
  assert.equal(quoteDay("2026-10-08 16:00:01"), "2026-10-08", "美股");
  for (const bad of [undefined, null, "", "16:00:01", "20261332", "20260231", "abc"]) assert.equal(quoteDay(bad), null, String(bad));
});

test("节假日：节前买的，假期里行情还停在节前那天，当日盈亏照样挡住；开盘前行情日期先换了也不漏挡", () => {
  const v = { holdings: [row("300750", 100, 20000)], trades: [trade("300750", "buy", "2026-09-30")] };
  const q = (quote_time?: string) => ({ "300750": quote("宁德时代", 210, 200, null, quote_time) });
  const holiday = at("2026-10-05T03:00:00Z");   // 周一上海 11:00，国庆休市；按日历推「当日」是 10-05
  assert.equal(homeHoldings(v, q("20260930150003"), holiday)[0].day_pnl, null);
  assert.match(homeHoldings(v, q("20260930150003"), holiday)[0].day_note ?? "", /有买卖或送转/);
  // 没有成交时间时退回按日历推
  assert.equal(homeHoldings(v, q(undefined), holiday)[0].day_pnl, 1000);
  // 节后第一天开盘后：行情日期变成 10-08，节前那笔不再挡
  assert.equal(homeHoldings(v, q("20261008100000"), at("2026-10-08T02:00:00Z"))[0].day_pnl, 1000);
  // 周一 9:00 开盘前，行情日期已经是今天、价格还是上周五的：取更早的日历日（上周五），周五的买入照样挡住
  const fri = { holdings: [row("300750", 100, 20000)], trades: [trade("300750", "buy", "2026-10-09")] };
  assert.equal(homeHoldings(fri, q("20261012090000"), at("2026-10-12T01:00:00Z"))[0].day_pnl, null);
  // 港股、美股的写法同样生效
  const hk = { holdings: [row("00700.HK", 100, 40000)], trades: [trade("00700.HK", "buy", "2026-09-30")] };
  const hq = { "00700.HK": quote("腾讯控股", 410, 400, null, "2026/09/30 16:08:24") };
  assert.equal(homeHoldings(hk, hq, at("2026-10-01T03:00:00Z"))[0].day_pnl, null, "港股国庆休市");
});

test("首页合计按币种分开、不换汇相加；只算拿到现价的，一只都没拿到时给 null 不给 0", () => {
  const totals = homeTotals(homeHoldings(view, quotes, NOW));
  assert.deepEqual(totals.map((t) => t.currency), ["CNY", "HKD", "USD"]);
  const [cny, hkd, usd] = totals;
  // 人民币：茅台 150000 + 平安银行 11000 + 宁德 21000；中国平安没现价不算
  assert.deepEqual({ ...cny }, {
    currency: "CNY", label: "人民币", market_value: 182000, cost: 180000, pnl: 2000, pnl_pct: 1.11,
    day_pnl: 2000, day_pnl_pct: 1.35,  // 2000 /（150000 − 2000）
    day_missing: 2, unquoted: 1,
  });
  assert.deepEqual({ ...hkd }, {
    currency: "HKD", label: "港元", market_value: 80000, cost: 60000, pnl: 20000, pnl_pct: 33.33,
    day_pnl: -2000, day_pnl_pct: -2.44,  // −2000 /（80000 + 2000）
    day_missing: 0, unquoted: 0,
  });
  assert.deepEqual({ ...usd }, {
    currency: "USD", label: "美元", market_value: null, cost: null, pnl: null, pnl_pct: null,
    day_pnl: null, day_pnl_pct: null, day_missing: 0, unquoted: 1,
  });
  // 行情还没回来：整组都是 null，页面显示「—」和「正在取现价」，不是 0
  const loading = homeTotals(homeHoldings(view, {}, NOW));
  for (const t of loading) assert.deepEqual([t.market_value, t.pnl, t.day_pnl], [null, null, null], t.currency);
  assert.deepEqual(homeTotals([]), []);
});

test("首页：指数在上、自选与持仓、再是对话；行情只在开盘时段快刷，隐私模式遮金额", () => {
  const home = read("pages/Home.tsx");
  assert.ok(home.indexOf("<HomeDashboard />") < home.indexOf("<FinanceHomeAgent />"), "先看自己的股票，再问问题");
  assert.ok(home.indexOf("<FinanceHomeAgent />") < home.indexOf("data-feature-grid"));
  const dash = read("components/HomeDashboard.tsx");
  assert.ok(dash.indexOf("<MarketStrip") < dash.indexOf("<WatchCard") && dash.indexOf("<WatchCard") < dash.indexOf("<HoldingsCard"));
  assert.match(dash, /useLiveQuotes\(codes, true\)/);
  assert.match(dash, /const codes = useMemo\(\(\) => \(key \? key\.split\(","\) : \[\]\), \[key\]\);/, "名单按内容记，别每次渲染都当成换了名单");
  assert.match(dash, /const on = MARKETS\.some\(\(m\) => isMarketTrading\(m\)\) && !document\.hidden;/, "指数条：三地任一开盘且页面在前台才快刷");
  assert.match(dash, /on \? STRIP_MS : STRIP_IDLE_MS/);
  assert.match(dash, /if \(cancelled \|\| inFlight\) return;/, "上一次没回来不再叠一次");
  assert.match(dash, /document\.addEventListener\("visibilitychange", onVisible\)/);
  // 「还在取」按这份名单有没有完整取过一次判断：持仓读出来后名单变了，新加的那几只先算「正在取」
  assert.match(dash, /const pending = useCallback\(\(code: string\) => live\.settled !== key && !\(code in live\.quotes\)/);
  assert.match(dash, /const quoting = rows\.some\(\(r\) => pending\(r\.code\)\);/);
  assert.match(dash, /\{pending\(r\.code\) \? "正在取现价" : r\.day_note\}/, "「—」下面直接写原因，不只放在悬停里");
  assert.match(dash, /view\.issues\.length > 0/, "流水有错时和持仓页一样提示，不悄悄算少");
  const hook = read("hooks/useLiveQuotes.ts");
  assert.match(hook, /if \(!onlyCodes\) setSettled\(requested\);/, "完整取过一次（成功失败都算）才记下这份名单");
  assert.match(dash, /hideIf\(hide, text\)/);
  assert.match(dash, /<SortTh label="市值" k="market_value"[^>]*className="hidden sm:table-cell"/, "手机宽度藏市值列，两种盈亏不用横着拖");
  assert.match(dash, /<td className="hidden whitespace-nowrap text-right font-mono tabular-nums sm:table-cell">\{p\(money\(r\.market_value\)\)\}/);
  // 首页上没有「问 Agent」浮窗（首页自己就是对话），不登记一份没人读的页面上下文
  assert.doesNotMatch(dash, /useAiPage/);
});

test("首页合计不提示「几只当日盈亏没算进来」：那几只照样不算进当日合计，原因只写在各自那一行", async () => {
  const rows = homeHoldings(view, quotes, NOW);
  const full = { ...view, issues: [], migration_pending: 0 };
  const live = { quotes, polling: false, updatedAt: null, error: null };
  await withRenderer(async (r) => {
    const { HoldingsCard } = await r.load("/src/verticals/finance/components/HomeDashboard.tsx");
    const { MemoryRouter } = await r.load("react-router-dom");
    const page = () => createElement(MemoryRouter, null, createElement(HoldingsCard, { view: full, err: null, rows, live, pending: () => false }));
    const text = textOf(r.html(page, {}));
    assert.doesNotMatch(text, /当日盈亏没算进来/, "小概率的情况，合计下面提示反而让人困惑");
    assert.match(text, /1 只没取到现价，没算进合计/, "没取到现价的提示照旧");
    assert.match(text, /有买卖或送转/, "当日有买卖的那一行照样写原因");
  });
  assert.equal(homeTotals(rows)[0]!.day_missing, 2, "计算不变：当日买入和送转的两只仍不算进当日合计");
});
