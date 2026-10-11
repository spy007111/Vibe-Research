/**
 * 每日复盘这一屏的解析:Core 页面查询 `/page/review` 一次取回的各块信封 → 页面和复盘提示词要的数。
 *
 * 🔴 只做取数与固定公式的换算(合计、比例、均值、中位数、交集、差值),**不下判断**:
 *    不说强弱、不说该不该。两个派生标签(涨跌面、题材热度)按写死的阈值算,阈值就写在这里,可复算、可争论。
 * 🔴 取不到就是 null,不拿 0 冒充;块没取到(failed / missing)时它的信封一条都不用。
 * 🔴 各块的「数据日」各自算、各自显示:涨跌分布 / 板块资金 / 成交额榜三个源只给当天,
 *    盘中看上一个交易日时它们是今天此刻的快照 —— 和业务日不是同一天,页面要标出来。
 */
import { num, rows, scalar, str, type Envelope, type PageBlock, type PageResult, type Row } from "./backend.ts";

export type ReviewBlockId =
  | "sentiment" | "zt_pool" | "yzt" | "reason" | "dragon"
  | "breadth" | "board_flow" | "turnover"
  | "trend" | "margin" | "valuation" | "bond";

/** 只给当天、不认日期的块 */
export const REALTIME_BLOCKS: readonly ReviewBlockId[] = ["breadth", "board_flow", "turnover"];

const DAY = /^\d{4}-\d{2}-\d{2}/;

export function blockOf(page: PageResult | null, id: ReviewBlockId): PageBlock | undefined {
  return page?.blocks.find((b) => b.id === id);
}

/** 块的信封;块没取到(failed / missing)或信封不成形时给 undefined —— 失败信封里的证据不拿来用 */
export function blockEnv(page: PageResult | null, id: ReviewBlockId): Envelope | undefined {
  const b = blockOf(page, id);
  if (!b || b.status === "failed" || b.status === "missing") return undefined;
  const env = b.envelope as unknown as Envelope;
  return Array.isArray(env?.evidence) ? env : undefined;
}

/** 这块数据是哪一天的:信封 extra.date 优先,否则取证据里最新的日期 */
export function dataDay(env: Envelope | undefined): string | null {
  if (!env) return null;
  const d = env.extra?.date;
  if (typeof d === "string" && DAY.test(d)) return d.slice(0, 10);
  let best: string | null = null;
  for (const e of env.evidence) {
    const p = String(e.period ?? "").slice(0, 10);
    if (DAY.test(p) && (!best || p > best)) best = p;
  }
  return best;
}

/** 信封里写明缺了什么(missing 的 reason),给页面和提示词照抄 */
export function missingReasons(env: Envelope | undefined): string[] {
  return (env?.missing ?? [])
    .map((m) => (m && typeof m === "object" ? String((m as { reason?: unknown }).reason ?? "") : String(m ?? "")))
    .filter(Boolean);
}

const sum = (xs: (number | null)[]): number | null => (xs.length && xs.every((x) => x !== null) ? (xs as number[]).reduce((a, b) => a + b, 0) : null);
const r2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const ratio = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : a / b);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const code6 = (s: string) => (/^\d{6}$/.test(s) ? s : "");

/* ---------- 涨跌面 ---------- */

/**
 * 涨跌面标签:上涨家数 ÷(上涨 + 下跌)。<30% 冰点 · <45% 偏弱 · <55% 中性 · <70% 偏强 · 其余 普涨。
 * 是我们按公开家数算的派生标签,不是取数层给的;换阈值就是换定义,不要在别处另写一套。
 */
export const BREADTH_RULE = "上涨家数 ÷(上涨 + 下跌):低于 30% 冰点 · 30–45% 偏弱 · 45–55% 中性 · 55–70% 偏强 · 70% 以上普涨";
export function breadthLabel(up: number | null, down: number | null): string {
  if (up === null || down === null || up + down === 0) return "";
  const r = up / (up + down);
  return r < 0.3 ? "冰点" : r < 0.45 ? "偏弱" : r < 0.55 ? "中性" : r < 0.7 ? "偏强" : "普涨";
}

export interface BreadthBucket { key: number; label: string; count: number }
export interface ExchangeBreadth { market: "SH" | "SZ" | "BJ"; name: string; up: number | null; down: number | null; flat: number | null; amount: number | null }
export interface Breadth {
  date: string | null;
  /** 涨停 → 跌停,23 档 */
  buckets: BreadthBucket[];
  up: number | null; down: number | null; flat: number | null;
  limitUp: number | null; limitDown: number | null;
  /** 涨 5% 以上(含涨停)/ 跌 5% 以上(含跌停)的家数 */
  up5: number | null; down5: number | null;
  /** 上涨 ÷(上涨 + 下跌),0–1 */
  upShare: number | null;
  label: string;
  exchanges: ExchangeBreadth[];
  /** 沪深京三所成交额合计(元);任一所没取到就不合计 */
  amount: number | null;
}
const EX_NAME = { SH: "沪市", SZ: "深市", BJ: "北交所" } as const;

export function parseBreadth(env: Envelope | undefined): Breadth | null {
  if (!env) return null;
  const all = rows(env);
  const buckets: BreadthBucket[] = all
    .filter((r) => r.key.startsWith("dist|"))
    .map((r) => ({ key: Number(r.key.slice(5)), label: r.note || r.key.slice(5), count: num(r.fields.market_dist_count) }))
    .filter((b): b is BreadthBucket => Number.isInteger(b.key) && b.count !== null)
    .sort((a, b) => b.key - a.key);
  const pick = (f: (k: number) => boolean) => (buckets.length ? buckets.filter((b) => f(b.key)).reduce((n, b) => n + b.count, 0) : null);
  const up = pick((k) => k >= 1);
  const down = pick((k) => k <= -1);
  const exchanges: ExchangeBreadth[] = (["SH", "SZ", "BJ"] as const).map((m) => {
    const r = all.find((x) => x.key === `exchange|${m}`);
    return {
      market: m, name: EX_NAME[m],
      up: num(r?.fields.market_up_count), down: num(r?.fields.market_down_count),
      flat: num(r?.fields.market_flat_count), amount: num(r?.fields.market_turnover_amount),
    };
  });
  const upShare = ratio(up, up === null || down === null ? null : up + down);
  return {
    date: dataDay(env),
    buckets,
    up, down,
    flat: pick((k) => k === 0),
    limitUp: buckets.find((b) => b.key === 11)?.count ?? null,
    limitDown: buckets.find((b) => b.key === -11)?.count ?? null,
    up5: pick((k) => k >= 6),
    down5: pick((k) => k <= -6),
    upShare,
    label: breadthLabel(up, down),
    exchanges,
    amount: sum(exchanges.map((x) => x.amount)),
  };
}

/* ---------- 短线情绪 ---------- */

/**
 * 题材热度标签:按涨停家数与最高连板。<20 冰点;20–39 普通(最高连板 ≥5 算活跃);40–69 活跃;≥70 亢奋。
 * 同样是派生标签、阈值写死。
 */
export const SPECULATION_RULE = "涨停家数:少于 20 冰点 · 20–39 普通(最高连板 ≥ 5 时算活跃)· 40–69 活跃 · 70 及以上亢奋";
export function speculationLabel(zt: number | null, maxBoards: number | null, boardsComplete = true): string {
  if (zt === null) return "";
  if (zt < 20) return "冰点";
  if (zt < 40) {
    if (maxBoards !== null && maxBoards >= 5) return "活跃";
    // 最高连板没取到、或涨停池只有一部分有连板数:分不出「普通」还是「活跃」,不给标签(第四轮审计 C6)
    return maxBoards === null || !boardsComplete ? "" : "普通";
  }
  return zt < 70 ? "活跃" : "亢奋";
}

export interface PoolStock {
  code: string; name: string; industry: string;
  boards: number | null; pct: number | null; price: number | null;
  amount: number | null; floatCap: number | null; turnover: number | null;
  sealFund: number | null; breakTimes: number | null;
  firstSeal: string | null;
  /** 同花顺题材归因原文(市场叙事,不是核验过的因果);没有是空串 */
  reason: string;
}
export interface PromotionTier { from: number; label: string; base: number; promoted: number; rate: number | null }
export interface ShortTerm {
  date: string | null;
  /** 三份取数各自的数据日：卡片标题按各自的标，一份过时了不被另一份的日期盖住 */
  dates: { sentiment: string | null; zt: string | null; yzt: string | null };
  zt: number | null; zb: number | null; dt: number | null;
  /** 封板率 = 涨停 ÷(涨停 + 炸板),0–1 */
  sealRate: number | null;
  maxBoards: number | null;
  lianban: number | null;
  /** 今天的涨停按连板数分层:首板 / 2 板 / 3 板 / 4 板及以上 */
  ladder: { boards: number; count: number; plus: boolean }[];
  /** 今天涨停池全部个股,连板数 → 首封早的在前 */
  stocks: PoolStock[];
  label: string;
  /** 昨天涨停的那批今天的表现(赚钱效应);池没取到是 null */
  yesterday: {
    count: number | null; n: number;
    avg: number | null; median: number | null;
    up: number; down: number; upShare: number | null;
    /** 今天跌 5% 以上 / 跌 9% 以上的只数 */
    loss5: number; loss9: number;
  } | null;
  /** 晋级:昨天 k 板的,今天又涨停的比例。两个池有一个没取全就不算(交集会少算) */
  promotion: PromotionTier[] | null;
  promotionAll: { base: number; promoted: number; rate: number | null } | null;
  promotionGap: string;
}

const POOL_NOTE = /^(\d{6})\s+(\S+)\s+(\S+)/;
const SEAL = /首封\s+(\d{2}:\d{2})(?::\d{2})?/;

export function parseReasons(env: Envelope | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows(env)) {
    const t = str(r.fields.strong_stock_reason).trim();
    if (code6(r.key) && t && !m.has(r.key)) m.set(r.key, t);
  }
  return m;
}

export function parseShortTerm(page: PageResult | null, reasons = parseReasons(blockEnv(page, "reason"))): ShortTerm | null {
  const sent = blockEnv(page, "sentiment");
  const zt = blockEnv(page, "zt_pool");
  const yzt = blockEnv(page, "yzt");
  if (!sent && !zt && !yzt) return null;

  const stocks: PoolStock[] = rows(zt)
    .filter((r) => code6(r.key))
    .map((r) => {
      const m = POOL_NOTE.exec(r.note.trim());
      return {
        code: r.key, name: m?.[2] ?? "", industry: m?.[3] ?? "",
        boards: num(r.fields.pool_limit_days), pct: num(r.fields.pool_change_pct), price: num(r.fields.pool_price),
        amount: num(r.fields.pool_amount), floatCap: num(r.fields.pool_float_cap), turnover: num(r.fields.pool_turnover),
        sealFund: num(r.fields.pool_seal_fund), breakTimes: num(r.fields.pool_break_times),
        firstSeal: SEAL.exec(r.note)?.[1] ?? null,
        reason: reasons.get(r.key) ?? "",
      };
    })
    .sort((a, b) => (b.boards ?? 0) - (a.boards ?? 0) || (a.firstSeal ?? "99").localeCompare(b.firstSeal ?? "99") || a.code.localeCompare(b.code));

  const ztN = num(scalar(sent, "limit_up_count")) ?? num(scalar(zt, "limit_up_pool_count"));
  const zbN = num(scalar(sent, "break_board_count"));
  const dtN = num(scalar(sent, "limit_down_count"));
  const known = stocks.filter((s) => s.boards !== null);
  const maxBoards = zt ? (known.length ? Math.max(...known.map((s) => s.boards!)) : null) : null;

  const tier = new Map<number, number>();
  for (const s of known) tier.set(Math.min(s.boards!, 4), (tier.get(Math.min(s.boards!, 4)) ?? 0) + 1);
  const ladder = [...tier.entries()].sort((a, b) => b[0] - a[0]).map(([boards, count]) => ({ boards, count, plus: boards === 4 }));

  let yesterday: ShortTerm["yesterday"] = null;
  const yRows = rows(yzt).filter((r) => code6(r.key));
  const pcts = yRows.map((r) => num(r.fields.pool_change_pct)).filter((x): x is number => x !== null);
  // 池子取到了但一只今天的涨跌都没有（空表 / 只取到一部分）：是不知道，不是「0 涨 0 跌」
  if (yzt && pcts.length) {
    const up = pcts.filter((x) => x > 0).length;
    const down = pcts.filter((x) => x < 0).length;
    yesterday = {
      count: num(scalar(yzt, "yesterday_limit_up_pool_count")),
      n: pcts.length,
      avg: pcts.length ? r2(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
      median: r2(median(pcts)),
      up, down,
      upShare: pcts.length ? up / pcts.length : null,
      loss5: pcts.filter((x) => x <= -5).length,
      loss9: pcts.filter((x) => x <= -9).length,
    };
  }

  // 晋级:昨天的连板数 pool_y_limit_days 分层,和今天涨停池的代码求交集
  let promotion: PromotionTier[] | null = null;
  let promotionAll: ShortTerm["promotionAll"] = null;
  let promotionGap = "";
  const ztBlock = blockOf(page, "zt_pool");
  const yBlock = blockOf(page, "yzt");
  if (!zt || !yzt) promotionGap = `${!zt ? "今天的涨停池" : "昨天的涨停池"}没取到,算不了晋级`;
  else if (ztBlock?.status !== "ok" || yBlock?.status !== "ok") promotionGap = "涨停池只取到一部分,交集会少算,这次不算晋级";
  else {
    const today = new Set(stocks.map((s) => s.code));
    const by = new Map<number, { base: number; promoted: number }>();
    let base = 0, promoted = 0;
    for (const r of yRows) {
      const hit = today.has(r.key);
      base++;
      if (hit) promoted++;
      const k = num(r.fields.pool_y_limit_days);
      if (k === null || k < 1) continue;
      const t = Math.min(Math.round(k), 4);
      const cur = by.get(t) ?? { base: 0, promoted: 0 };
      by.set(t, { base: cur.base + 1, promoted: cur.promoted + (hit ? 1 : 0) });
    }
    const LABEL: Record<number, string> = { 1: "首板 → 2 板", 2: "2 板 → 3 板", 3: "3 板 → 4 板", 4: "4 板及以上 → 再涨停" };
    promotion = [1, 2, 3, 4].filter((k) => by.has(k)).map((k) => {
      const t = by.get(k)!;
      return { from: k, label: LABEL[k]!, base: t.base, promoted: t.promoted, rate: ratio(t.promoted, t.base) };
    });
    promotionAll = { base, promoted, rate: ratio(promoted, base) };
  }

  return {
    date: dataDay(sent) ?? dataDay(zt) ?? dataDay(yzt),
    dates: { sentiment: dataDay(sent), zt: dataDay(zt), yzt: dataDay(yzt) },
    zt: ztN, zb: zbN, dt: dtN,
    sealRate: ratio(ztN, ztN === null || zbN === null ? null : ztN + zbN),
    maxBoards,
    lianban: zt ? known.filter((s) => s.boards! >= 2).length : null,
    ladder,
    stocks,
    label: speculationLabel(ztN, maxBoards, blockOf(page, "zt_pool")?.status === "ok" && known.length === stocks.length),
    yesterday,
    promotion,
    promotionAll,
    promotionGap,
  };
}

/* ---------- 中长线:指数趋势 / 量能 ---------- */

export interface IndexTrend {
  code: string; name: string; date: string | null;
  close: number | null; chg: number | null;
  r5: number | null; r20: number | null; r60: number | null; r250: number | null; ytd: number | null;
  ma20: number | null; ma60: number | null; ma250: number | null;
  high250: number | null; high250Date: string | null; low250: number | null; low250Date: string | null;
  offHigh: number | null;
}
export interface Trend {
  date: string | null;
  indices: IndexTrend[];
  /** 沪深两市成交额,旧 → 新(元) */
  amounts: { date: string; total: number }[];
  amountDate: string | null;
  lastAmount: number | null;
  ma20: number | null; ma60: number | null;
  /** 最新一天成交额比 20 / 60 日均值高(+)低(−)多少 %;最新一根是盘中没收完的时为 null(半天的量不和整天比) */
  vsMa20: number | null; vsMa60: number | null;
  /** 最新一根是今天盘中、还没收完 —— 这时 ma20 / ma60 是截至上一个交易日、不含它的 */
  partial: boolean;
  /** 盘中时的上一个交易日成交额(收完的那天) */
  prevAmount: number | null; prevAmountDate: string | null;
  missing: string[];
}
const IDX_NOTE = /^(.+?)\((\d{6})\)/;
const AT_DATE = /日期=(\d{4}-\d{2}-\d{2})/;

/** `partialDay`:盘中看今天时传今天的日期 —— 最新一根是那天就当没收完 */
export function parseTrend(env: Envelope | undefined, partialDay: string | null = null): Trend | null {
  if (!env) return null;
  const all = rows(env);
  const indices: IndexTrend[] = all.filter((r) => r.key.startsWith("index|")).map((r) => {
    const f = r.fields;
    const m = IDX_NOTE.exec(r.note);
    return {
      code: r.key.slice(6), name: m?.[1] ?? r.key.slice(6), date: f.index_close?.period?.slice(0, 10) ?? null,
      close: num(f.index_close), chg: num(f.index_change_pct),
      r5: num(f.index_return_5d), r20: num(f.index_return_20d), r60: num(f.index_return_60d), r250: num(f.index_return_250d), ytd: num(f.index_return_ytd),
      ma20: num(f.index_ma20), ma60: num(f.index_ma60), ma250: num(f.index_ma250),
      high250: num(f.index_high_250d), high250Date: AT_DATE.exec(f.index_high_250d?.note ?? "")?.[1] ?? null,
      low250: num(f.index_low_250d), low250Date: AT_DATE.exec(f.index_low_250d?.note ?? "")?.[1] ?? null,
      offHigh: num(f.index_off_high_250d_pct),
    };
  });
  const amounts = all
    .filter((r) => DAY.test(r.key.slice(7)) && r.key.startsWith("amount|"))
    .map((r) => ({ date: r.key.slice(7, 17), total: num(r.fields.market_amount_total) }))
    .filter((x): x is { date: string; total: number } => x.total !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  const avg = all.find((r) => r.key === "amount|avg");
  const last = amounts.at(-1) ?? null;
  const partial = !!partialDay && last?.date === partialDay;
  // 盘中:均值用不含今天的那组(取数层给的 _prior;没给就用已收完的日子自己算,不够天数就是 null)
  const prior = (n: 20 | 60) => num(avg?.fields[`market_amount_ma${n}_prior`])
    ?? (amounts.length - 1 >= n ? amounts.slice(-n - 1, -1).reduce((s, x) => s + x.total, 0) / n : null);
  const ma20 = partial ? prior(20) : num(avg?.fields.market_amount_ma20);
  const ma60 = partial ? prior(60) : num(avg?.fields.market_amount_ma60);
  const pctVs = (ma: number | null) => (!partial && last && ma ? r2((last.total / ma - 1) * 100) : null);
  const prev = partial ? amounts.at(-2) ?? null : null;
  return {
    date: indices.map((x) => x.date).filter(Boolean).sort().at(-1) ?? null,
    indices, amounts,
    amountDate: last?.date ?? null, lastAmount: last?.total ?? null,
    ma20, ma60, vsMa20: pctVs(ma20), vsMa60: pctVs(ma60),
    partial, prevAmount: prev?.total ?? null, prevAmountDate: prev?.date ?? null,
    missing: missingReasons(env),
  };
}

/** 收盘在均线上方 / 下方;缺数据是 null。只是位置关系,不是判断 */
export const aboveMa = (close: number | null, ma: number | null): boolean | null => (close === null || ma === null ? null : close >= ma);

/* ---------- 两融 ---------- */

export interface Margin {
  date: string | null;
  balance: number | null; financing: number | null; short: number | null;
  floatPct: number | null; netBuy: number | null; financingBuy: number | null;
  /** 旧 → 新 */
  series: { date: string; balance: number | null; netBuy: number | null }[];
  /** 两融余额比 5 / 20 个交易日前多(+)少(−)多少元;那一天没有就 null */
  chg5: number | null; chg20: number | null;
  /** 最近 5 个交易日融资净买入合计;有一天没取到就不合计 */
  netBuy5: number | null;
}
export function parseMargin(env: Envelope | undefined): Margin | null {
  if (!env) return null;
  const all = rows(env);
  const series = all
    .filter((r) => DAY.test(r.key.slice(7)) && r.key.startsWith("margin|"))
    .map((r) => ({ date: r.key.slice(7, 17), balance: num(r.fields.market_margin_balance), netBuy: num(r.fields.market_financing_net_buy) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const lt = all.find((r) => r.key === "margin|latest")?.fields ?? {};
  const last = series.at(-1);
  const back = (n: number) => {
    const a = series.at(-1)?.balance ?? null;
    const b = series.length > n ? series[series.length - 1 - n]!.balance : null;
    return a === null || b === null ? null : a - b;
  };
  return {
    date: last?.date ?? lt.market_financing_balance?.period?.slice(0, 10) ?? null,
    balance: last?.balance ?? null,
    financing: num(lt.market_financing_balance), short: num(lt.market_short_balance),
    floatPct: num(lt.market_financing_float_pct), financingBuy: num(lt.market_financing_buy),
    netBuy: last?.netBuy ?? null,
    series,
    chg5: back(5), chg20: back(20),
    netBuy5: series.length >= 5 ? sum(series.slice(-5).map((x) => x.netBuy)) : null,
  };
}

/* ---------- 估值与国债 ---------- */

export interface Valuation {
  date: string | null;
  /** 沪深300 市盈率 / 股息率(中证官网,总股本口径);计算用股本口径另列 */
  pe: number | null; dy: number | null; peCalc: number | null; dyCalc: number | null;
  y10: number | null; y10Date: string | null;
  /** 盈利收益率 = 1 ÷ 市盈率(%) */
  ey: number | null;
  /** 股息率 − 10 年国债(百分点) */
  dySpread: number | null;
  /** 盈利收益率 − 10 年国债(百分点) */
  eySpread: number | null;
}
export function parseValuation(val: Envelope | undefined, bond: Envelope | undefined): Valuation | null {
  if (!val && !bond) return null;
  // 指标文件按日期分行(record_key = 000300:日期),取最新那一行
  const vr = rows(val).filter((r) => DAY.test(r.key.split(":")[1] ?? "")).sort((a, b) => a.key.localeCompare(b.key)).at(-1);
  const br = rows(bond).find((r) => r.fields.yield_10y);
  const pe = num(vr?.fields.index_pe_total);
  const dy = num(vr?.fields.index_dividend_yield_total);
  const y10 = num(br?.fields.yield_10y);
  const ey = pe && pe > 0 ? r2(100 / pe) : null;
  return {
    date: vr?.key.split(":")[1]?.slice(0, 10) ?? null,
    pe, dy, peCalc: num(vr?.fields.index_pe_calculation), dyCalc: num(vr?.fields.index_dividend_yield_calculation),
    y10, y10Date: br?.fields.yield_10y?.period?.slice(0, 10) ?? null,
    ey,
    dySpread: dy === null || y10 === null ? null : r2(dy - y10),
    eySpread: ey === null || y10 === null ? null : r2(ey - y10),
  };
}

/* ---------- 资金:板块资金 / 成交额榜 / 龙虎榜 ---------- */

export interface BoardFlowRow { name: string; pct: number | null; net: number | null; leader: string }
export interface BoardFlow { source: "东财" | "新浪"; date: string | null; rows: BoardFlowRow[] }
const SINA_LEADER = /领涨\s+(\S+)\s+(-?[\d.]+)%/;

/** 东财主力净额 / 新浪「流入 − 流出」两种口径都认;按净额从大到小 */
export function parseBoardFlow(env: Envelope | undefined): BoardFlow | null {
  if (!env) return null;
  const all = rows(env);
  const sina = all.some((r) => r.fields.board_net_sina);
  const out = all.map((r) => {
    const name = r.note.split(/\s+排名/)[0]!.trim() || r.key;
    if (sina) {
      const m = SINA_LEADER.exec(r.note);
      return { name, pct: num(r.fields.board_change_pct_sina), net: num(r.fields.board_net_sina), leader: m ? `${m[1]} ${r2(Number(m[2]))}%` : "" };
    }
    return { name, pct: num(r.fields.board_change_pct_today), net: num(r.fields.board_main_net_today), leader: "" };
  }).filter((x) => x.net !== null || x.pct !== null);
  out.sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
  return { source: sina ? "新浪" : "东财", date: dataDay(env), rows: out };
}

export interface TurnoverRow { code: string; name: string; industry: string; price: number | null; pct: number | null; amount: number | null; mcap: number | null }
/** 东财:`中际旭创(300308)·通信设备;…`;新浪没有行业:`中际旭创(300308);…` */
const TURN_NOTE = /^(.+?)\((\d{6})\)(?:·([^;]*))?/;
export function parseTurnover(env: Envelope | undefined): { date: string | null; rows: TurnoverRow[] } | null {
  if (!env) return null;
  const out = rows(env)
    .map((r) => {
      const m = TURN_NOTE.exec(r.note);
      return {
        rank: num(r.fields.turnover_rank) ?? 9999,
        code: m?.[2] ?? r.key.replace(/^stock\|/, ""), name: m?.[1] ?? "", industry: m?.[3] ?? "",
        price: num(r.fields.last_price), pct: num(r.fields.change_pct), amount: num(r.fields.turnover_amount),
        mcap: num(r.fields.market_cap),
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _r, ...x }) => x);
  return { date: dataDay(env), rows: out };
}

export interface DragonRow { code: string; name: string; reason: string; net: number | null; pct: number | null }
export interface Dragon { date: string | null; stocks: number; buy: DragonRow[]; sell: DragonRow[] }
const DRAGON_NOTE = /^(\d{6})\s+([^:]+):(.*)$/;
/**
 * 龙虎榜日榜:同一只可能因几条上榜理由各出现一次(每条的统计区间不同,净额不能相加)⇒ 不合计,
 * 净买入榜 / 净卖出榜里每只只留净额最大 / 最小的那一条。净买额上游是万元,这里换成元。
 * 上榜只数用取数层按全量去重的 `dragon_tiger_market_stocks`:记录多时逐条只列净买额两头,从逐条数会少算。
 */
export function parseDragon(env: Envelope | undefined, top = 8): Dragon | null {
  if (!env) return null;
  const all: DragonRow[] = rows(env).map((r: Row) => {
    const m = DRAGON_NOTE.exec(r.note);
    const net = num(r.fields.dragon_tiger_market_net_buy);
    return { code: m?.[1] ?? r.key.split("|")[0]!, name: m?.[2]?.trim() ?? "", reason: m?.[3]?.trim() ?? r.key.split("|")[1] ?? "", net: net === null ? null : net * 1e4, pct: num(r.fields.dragon_tiger_market_change_pct) };
  });
  const firstPer = (xs: DragonRow[]) => {
    const seen = new Set<string>();
    return xs.filter((x) => (seen.has(x.code) ? false : (seen.add(x.code), true)));
  };
  const known = all.filter((x) => x.net !== null);
  return {
    date: dataDay(env),
    stocks: num(scalar(env, "dragon_tiger_market_stocks")) ?? new Set(all.map((x) => x.code)).size,
    buy: firstPer([...known].sort((a, b) => b.net! - a.net!)).filter((x) => x.net! > 0).slice(0, top),
    sell: firstPer([...known].sort((a, b) => a.net! - b.net!)).filter((x) => x.net! < 0).slice(0, top),
  };
}

/* ---------- 整屏 ---------- */

export interface MarketReview {
  breadth: Breadth | null;
  short: ShortTerm | null;
  trend: Trend | null;
  margin: Margin | null;
  valuation: Valuation | null;
  flow: BoardFlow | null;
  turnover: { date: string | null; rows: TurnoverRow[] } | null;
  dragon: Dragon | null;
}
export function parseReview(page: PageResult | null): MarketReview {
  const reasons = parseReasons(blockEnv(page, "reason"));
  return {
    breadth: parseBreadth(blockEnv(page, "breadth")),
    short: parseShortTerm(page, reasons),
    trend: parseTrend(blockEnv(page, "trend"), page?.context.live ? page.context.review_date ?? null : null),
    margin: parseMargin(blockEnv(page, "margin")),
    valuation: parseValuation(blockEnv(page, "valuation"), blockEnv(page, "bond")),
    flow: parseBoardFlow(blockEnv(page, "board_flow")),
    turnover: parseTurnover(blockEnv(page, "turnover")),
    dragon: parseDragon(blockEnv(page, "dragon")),
  };
}

/**
 * 这块数据和业务日是不是同一天。只给当天的那三块,盘中看上一个交易日时是今天此刻的快照 ——
 * 返回要写在块标题旁的那句话;同一天(或判断不了)返回空串。
 */
export function staleNote(page: PageResult | null, id: ReviewBlockId, date: string | null): string {
  const biz = page?.context.review_date ?? null;
  if (!biz) return "";
  if (REALTIME_BLOCKS.includes(id) && page?.context.realtime_matches_review_day === false) {
    return `此刻快照${date ? `(${date})` : ""}:这个源只给当天,和业务日 ${biz} 不是同一天`;
  }
  if (date && date !== biz) return `数据日 ${date}(业务日 ${biz})`;
  return "";
}

/* ---------- 喂给复盘提示词的几行 ---------- */

const pct = (v: number | null, digits = 2) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`);
const share = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
export const yiText = (v: number | null) => (v === null ? "—" : `${(v / 1e8).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 亿`);

/**
 * 每块一行或几行,带数据日;块没取到写【缺口】—— 空着会被模型读成「今天没有」。
 * 派生标签写上规则,让模型引用时带着口径。
 */
export function reviewLines(page: PageResult | null, r: MarketReview): string[] {
  const L: string[] = [];
  const gap = (id: ReviewBlockId, what: string) => { if (page && !blockEnv(page, id)) L.push(`【缺口】${what}这次没取到,不要就它下结论`); };
  const tag = (id: ReviewBlockId, date: string | null) => {
    const s = staleNote(page, id, date);
    return s ? `·${s}` : date ? `·${date}` : "";
  };

  const b = r.breadth;
  if (b) {
    L.push(`【涨跌面${tag("breadth", b.date)}】上涨 ${b.up ?? "—"} / 下跌 ${b.down ?? "—"} / 平盘 ${b.flat ?? "—"} 家;涨停 ${b.limitUp ?? "—"} / 跌停 ${b.limitDown ?? "—"};涨 5% 以上 ${b.up5 ?? "—"} / 跌 5% 以上 ${b.down5 ?? "—"};`
      + `上涨占比 ${share(b.upShare)}${b.label ? `(派生标签「${b.label}」,规则:${BREADTH_RULE})` : ""};沪深京成交额 ${yiText(b.amount)}`);
  } else gap("breadth", "涨跌分布");

  const s = r.short;
  if (s) {
    L.push(`【短线情绪${s.date ? `·${s.date}` : ""}】涨停 ${s.zt ?? "—"} / 炸板 ${s.zb ?? "—"} / 跌停 ${s.dt ?? "—"};封板率 ${share(s.sealRate)}(涨停 ÷(涨停 + 炸板));`
      + `最高连板 ${s.maxBoards ?? "—"};2 板及以上 ${s.lianban ?? "—"} 只;分层 ${s.ladder.map((x) => `${x.boards === 1 ? "首板" : `${x.boards} 板${x.plus ? "及以上" : ""}`} ${x.count}`).join(" · ") || "—"}`
      + (s.label ? `;派生标签「${s.label}」(规则:${SPECULATION_RULE})` : ""));
    const y = s.yesterday;
    if (y) L.push(`【昨日涨停今日表现】${y.n} 只有涨跌幅(昨日涨停 ${y.count ?? "—"} 只):平均 ${pct(y.avg)} · 中位数 ${pct(y.median)} · 上涨 ${y.up} / 下跌 ${y.down}(上涨占比 ${share(y.upShare)});跌 5% 以上 ${y.loss5} 只、跌 9% 以上 ${y.loss9} 只`);
    else L.push("【缺口】昨日涨停今日表现没取到,不要就它下结论");
    if (s.promotion && s.promotionAll) {
      L.push(`【晋级】昨日涨停今天又涨停 ${s.promotionAll.promoted}/${s.promotionAll.base}(${share(s.promotionAll.rate)});`
        + s.promotion.map((t) => `${t.label} ${t.promoted}/${t.base}`).join(" · "));
    } else if (s.promotionGap) L.push(`【缺口·晋级】${s.promotionGap}`);
    const top = s.stocks.filter((x) => (x.boards ?? 0) >= 2).slice(0, 12);
    if (top.length) L.push(`【连板股】${top.map((x) => `${x.name || x.code} ${x.boards} 板${x.firstSeal ? ` ${x.firstSeal} 首封` : ""}${x.reason ? `(同花顺题材:${x.reason})` : ""}`).join(";")}`);
  } else gap("sentiment", "短线情绪");

  const t = r.trend;
  if (t) {
    for (const i of t.indices) {
      const pos = [["20", i.ma20], ["60", i.ma60], ["250", i.ma250]].map(([n, ma]) => {
        const a = aboveMa(i.close, ma as number | null);
        return a === null ? null : `${a ? "在" : "低于"} ${n} 日线`;
      }).filter(Boolean).join("、");
      L.push(`【指数·${i.name}·截至 ${i.date ?? "—"}】${i.close ?? "—"} 点,当日 ${pct(i.chg)};5 日 ${pct(i.r5)} · 20 日 ${pct(i.r20)} · 60 日 ${pct(i.r60)} · 250 日 ${pct(i.r250)} · 年初至今 ${pct(i.ytd)};`
        + `离一年最高收盘 ${pct(i.offHigh)}${i.high250Date ? `(高点 ${i.high250Date})` : ""}${pos ? `;${pos}` : ""}`);
    }
    if (t.lastAmount !== null && t.partial) L.push(`【两市成交额·${t.amountDate}·盘中累计,还没收完】${yiText(t.lastAmount)};半天的量不和整天的均值比。`
      + `上一个交易日(${t.prevAmountDate ?? "—"})${yiText(t.prevAmount)};截至上一个交易日的 20 日均值 ${yiText(t.ma20)} · 60 日均值 ${yiText(t.ma60)}`);
    else if (t.lastAmount !== null) L.push(`【两市成交额·${t.amountDate}】${yiText(t.lastAmount)};20 日均值 ${yiText(t.ma20)}(${pct(t.vsMa20, 1)})· 60 日均值 ${yiText(t.ma60)}(${pct(t.vsMa60, 1)})`);
    for (const m of t.missing) L.push(`【缺口·中长线】${m}`);
  } else gap("trend", "主要指数中长线");

  const m = r.margin;
  if (m) L.push(`【两融·${m.date ?? "—"}(T 日数据 T+1 发布)】两融余额 ${yiText(m.balance)};比 5 个交易日前 ${m.chg5 === null ? "—" : `${m.chg5 > 0 ? "+" : ""}${yiText(m.chg5)}`}、比 20 个交易日前 ${m.chg20 === null ? "—" : `${m.chg20 > 0 ? "+" : ""}${yiText(m.chg20)}`};`
    + `最近一天融资净买入 ${yiText(m.netBuy)},近 5 日合计 ${yiText(m.netBuy5)};融资余额占流通市值 ${m.floatPct === null ? "—" : `${m.floatPct.toFixed(2)}%`}`);
  else gap("margin", "两融余额");

  const v = r.valuation;
  if (v) L.push(`【沪深300 估值与国债·${v.date ?? "—"}】市盈率 ${v.pe ?? "—"} 倍(盈利收益率 1÷市盈率 = ${v.ey === null ? "—" : `${v.ey}%`})· 股息率 ${v.dy === null ? "—" : `${v.dy}%`}(中证官网,总股本口径);`
    + `10 年国债 ${v.y10 === null ? "—" : `${v.y10}%`}(${v.y10Date ?? "—"});股息率 − 国债 ${v.dySpread === null ? "—" : `${v.dySpread} 个百分点`}、盈利收益率 − 国债 ${v.eySpread === null ? "—" : `${v.eySpread} 个百分点`}。只是两组收益率的差,不是估值判断`);
  else gap("valuation", "沪深300 估值");

  const f = r.flow;
  if (f && f.rows.length) {
    const inn = f.rows.filter((x) => (x.net ?? 0) > 0).slice(0, 6);
    const out = f.rows.filter((x) => (x.net ?? 0) < 0).sort((a, b) => a.net! - b.net!).slice(0, 6);
    L.push(`【行业资金${tag("board_flow", f.date)}·${f.source}口径】净流入居前:${inn.map((x) => `${x.name} ${yiText(x.net)}`).join("、") || "无"};净流出居前:${out.map((x) => `${x.name} ${yiText(x.net)}`).join("、") || "无"}`);
  } else gap("board_flow", "行业资金");

  const tv = r.turnover;
  if (tv && tv.rows.length) L.push(`【成交额居前${tag("turnover", tv.date)}】${tv.rows.slice(0, 10).map((x) => `${x.name || x.code} ${yiText(x.amount)}(${pct(x.pct)})`).join("、")}`);
  else gap("turnover", "成交额榜");

  const d = r.dragon;
  if (d && (d.buy.length || d.sell.length)) L.push(`【龙虎榜${d.date ? `·${d.date}` : ""}】${d.stocks} 只上榜;净买入居前:${d.buy.slice(0, 5).map((x) => `${x.name || x.code} ${yiText(x.net)}`).join("、") || "无"};净卖出居前:${d.sell.slice(0, 5).map((x) => `${x.name || x.code} ${yiText(x.net)}`).join("、") || "无"}`);
  else gap("dragon", "龙虎榜");
  return L;
}

