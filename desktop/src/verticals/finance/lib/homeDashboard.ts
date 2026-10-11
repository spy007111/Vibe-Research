/**
 * 首页「我的持仓」的纯计算：持有数量和成本来自交易流水重放（后端 /view/holdings），现价来自实时行情。
 *
 * 🔴 和持仓页同一口径：拿不到现价时市值、盈亏一律 null（显示「—」），不填 0、不拿成本冒充现价；
 *    合计按币种分开，不经汇率换算绝不相加。
 * 🔴 当日盈亏 =（现价 − 昨收）× 股数。「当日」是这份行情所属的交易日：先看行情自带的成交日期
 *    （节假日里停在节前最后一个交易日），再和按周末、开盘时间推出的那天比，取更早的。
 *    这只在那一天有买入、卖出或送转时，这个算法不成立（新买的那部分不是从昨收算起），显示「—」。
 *    期初持仓不算：它记的是开始记账前就有的仓位（旧持仓自动迁移时日期就是迁移那天），不是当天买的。
 */
import type { Quote } from "./api.ts";
import type { HoldingsView } from "./holdings.ts";
import { currencyLabel, currencyOfSymbol, marketOfSymbol, normalizeMarketSymbol, type CurrencyCode, type MarketCode } from "./marketSymbol.ts";

export interface HomeHolding {
  code: string; name: string; market: MarketCode; currency: CurrencyCode;
  shares: number; cost_total: number;
  price: number | null; change_pct: number | null;
  market_value: number | null; pnl: number | null; pnl_pct: number | null;
  /** 当日盈亏；null 时 day_note 写为什么没有 */
  day_pnl: number | null; day_note: string | null;
}

export interface HomeTotal {
  currency: CurrencyCode; label: string;
  /** 只算拿到现价的那些；一只都没拿到（含行情还没回来）时 null，不显示成 0 */
  market_value: number | null; cost: number | null; pnl: number | null; pnl_pct: number | null;
  /** 有当日盈亏的那些加起来；一只都没有时 null */
  day_pnl: number | null; day_pnl_pct: number | null;
  /** 有现价但当日盈亏算不了的只数（当日合计没含它们） */
  day_missing: number;
  /** 没拿到现价的只数（市值、盈亏合计都没含它们） */
  unquoted: number;
}

const ZONE: Record<MarketCode, string> = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
const OPEN_MINUTES = 9 * 60 + 30;   // 三地常规开盘都是当地 9:30
const SHARE_CHANGING = new Set(["buy", "sell", "split"]);
const round2 = (v: number) => Math.round(v * 100) / 100;

function zoned(at: Date, zone: string): { day: string; weekday: number; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const shiftDay = (day: string, delta: number) => {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + delta);
  return t.toISOString().slice(0, 10);
};

/**
 * 按日历推行情上的「当日」是哪一天（当地日期）：周末和开盘前看到的还是上一个工作日的价。
 * 节假日不认（没有三地节假日日历）；节假日由行情自带的成交日期兜住，见 quoteDay。
 */
export function sessionDay(market: MarketCode, at = new Date()): string {
  const { day, weekday, minutes } = zoned(at, ZONE[market]);
  if (weekday === 6) return shiftDay(day, -1);
  if (weekday === 0) return shiftDay(day, -2);
  if (minutes < OPEN_MINUTES) return shiftDay(day, weekday === 1 ? -3 : -1);
  return day;
}

/**
 * 行情自带的成交时间（交易所当地时间）→ 当地日期。腾讯三种写法：A 股 20261009110653、
 * 港股 2026/10/09 10:51:51、美股 2026-10-08 16:00:01。认不出给 null，调用方退回按日历推。
 */
export function quoteDay(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "").slice(0, 8);
  if (d.length < 8) return null;
  const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const t = new Date(`${day}T00:00:00Z`);
  // 2 月 31 日这类：有的引擎顺延成 3 月，有的给无效日期，转回来对不上就不认
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === day ? day : null;
}

export function homeHoldings(view: Pick<HoldingsView, "holdings" | "trades">, quotes: Record<string, Quote>, at = new Date()): HomeHolding[] {
  const touched = new Map<string, string>();   // 代码 → 最近一笔改变持股的流水日期
  for (const t of view.trades) {
    const code = normalizeMarketSymbol(t.symbol);
    if (!code || !SHARE_CHANGING.has(t.type)) continue;
    if ((touched.get(code) ?? "") < t.date) touched.set(code, t.date);
  }
  return view.holdings.flatMap((h) => {
    const code = normalizeMarketSymbol(h.symbol);
    const market = code ? marketOfSymbol(code) : null;
    const currency = code ? currencyOfSymbol(code) : null;
    if (!code || !market || !currency || !(h.shares > 0)) return [];
    const q = quotes[code];
    const price = q?.price != null && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
    const last = q?.last_close != null && Number.isFinite(q.last_close) && q.last_close > 0 ? q.last_close : null;
    const mv = price === null ? null : price * h.shares;
    const pnl = mv === null ? null : mv - h.cost_total;
    let dayPnl: number | null = null;
    let dayNote: string | null = null;
    // 「当日」：行情自己的成交日期和按日历推的取更早那天。节假日里行情停在节前（日历会多推到假期里）；
    // 开盘前有的行情日期已经换成今天、价格还是上一个交易日的（这时日历推的更早）。往早取只会多挡、不会漏挡。
    const cal = sessionDay(market, at);
    const qd = quoteDay(q?.quote_time);
    const day = qd !== null && qd < cal ? qd : cal;
    if (price === null) dayNote = "没取到现价";
    else if (last === null) dayNote = "没取到昨收";
    else if ((touched.get(code) ?? "") >= day) dayNote = "这个交易日有买卖或送转";
    else dayPnl = (price - last) * h.shares;
    return [{
      code, name: h.name || q?.name || code, market, currency, shares: h.shares, cost_total: h.cost_total,
      price, change_pct: price === null ? null : q?.change_pct ?? null,
      market_value: mv === null ? null : round2(mv), pnl: pnl === null ? null : round2(pnl),
      pnl_pct: pnl !== null && h.cost_total > 0 ? round2((pnl / h.cost_total) * 100) : null,
      day_pnl: dayPnl === null ? null : round2(dayPnl), day_note: dayNote,
    }];
  });
}

export function homeTotals(rows: HomeHolding[]): HomeTotal[] {
  const by = new Map<CurrencyCode, HomeHolding[]>();
  for (const r of rows) by.set(r.currency, [...(by.get(r.currency) ?? []), r]);
  return [...by.entries()].map(([currency, items]) => {
    const quoted = items.filter((r) => r.market_value !== null);
    const mv = quoted.reduce((a, r) => a + (r.market_value ?? 0), 0);
    const cost = quoted.reduce((a, r) => a + r.cost_total, 0);
    const withDay = quoted.filter((r) => r.day_pnl !== null);
    const day = withDay.reduce((a, r) => a + (r.day_pnl ?? 0), 0);
    // 当日涨跌幅的分母是这些持仓昨收时的市值（今天市值 − 今天赚的）
    const dayBase = withDay.reduce((a, r) => a + (r.market_value ?? 0) - (r.day_pnl ?? 0), 0);
    const any = quoted.length > 0;
    return {
      currency, label: currencyLabel(currency),
      market_value: any ? round2(mv) : null, cost: any ? round2(cost) : null, pnl: any ? round2(mv - cost) : null,
      pnl_pct: any && cost > 0 ? round2(((mv - cost) / cost) * 100) : null,
      day_pnl: withDay.length ? round2(day) : null,
      day_pnl_pct: withDay.length && dayBase > 0 ? round2((day / dayBase) * 100) : null,
      day_missing: quoted.length - withDay.length,
      unquoted: items.length - quoted.length,
    };
  });
}
