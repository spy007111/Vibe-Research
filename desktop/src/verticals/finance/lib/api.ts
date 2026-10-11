/**
 * 上游 UI 的数据接口 —— **类型原样保留,实现全部改接我们的底座**。
 *
 * 上游打的是开源版 Python 后端(`/api/valuation` 这种语义接口);我们的底座只有一个
 * 通用取数入口 `/fetch`(端点 id + 证据信封)。差异收在这一个文件里,
 * **12 个页面一行不用改**。
 *
 * 🔴 三条纪律:
 *  ① 接不上的一律 `notWired()` **抛错**,不返回空数组 ——
 *     返回空会让页面显示"这里没有数据",而真相是"这条链路还没做"。
 *  ② 取不到的数给 `null` 不给 `0`；接口类型必须如实允许 null。
 *  ③ 鉴权与密钥都不在浏览器:Bearer 由 Vite 代理注入(见 vite.config.ts)。
 */
import { saveBlob } from "./download.ts";
import {
  ApiError, backend, noteKV, num, round2, rows, scalar, str,
  type Envelope, type Evidence,
} from "./backend.ts";
import {
  currencyLabel, currencyOfSymbol, marketOfSymbol, normalizeMarketSymbol, quoteQueryOfSymbol, symbolFromQuoteKey,
  type CurrencyCode, type MarketCode,
} from "./marketSymbol.ts";
import {
  cnyTotal, fxFromEnvelope, tradeRecord,
  type CnyTotal, type CostMethod, type FxRates, type HoldingsView, type LegacyPosition, type MigrationResult, type Trade, type TradeForm, type TradeIssue,
} from "./holdings.ts";

export { ApiError };

export interface MyReport {
  id: string; name: string; size: number; ext: string; ts: number; uploaded_at: string;
  chars: number; pages: number | null; truncated: boolean; symbols: string[];
}

/**
 * 上游用它存"后端访问密钥"到 localStorage。我们**不需要**:
 * 鉴权由 Vite 代理注入,浏览器侧不持有任何凭据。保留空实现只为让上游页面编译通过。
 */
export const loadAccessKey = (): string => "";
export const saveAccessKey = (_key: string): void => undefined;
export const authHeaders = (): Record<string, string> => ({});

export async function downloadReport(id: string, name: string): Promise<void> {
  let res: Response;
  try { res = await fetch(`/api/reports/${encodeURIComponent(id)}/download`); }
  catch (e) { throw new ApiError(`连接不到编排器 API:${e instanceof Error ? e.message : String(e)}`, 0, "network"); }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let code = String(res.status);
    try { const body = await res.json() as { error?: string; message?: string }; message = body.message ?? body.error ?? message; code = body.error ?? code; } catch { /* 下载错误不是 JSON 时保留状态码 */ }
    throw new ApiError(message, res.status, code);
  }
  saveBlob(await res.blob(), name);
}

export interface Quote {
  /** 源证据取数时刻，不是浏览器收到回包的时间，也不是逐笔成交时间。 */
  fetched_at?: string | null;
  /**
   * 🔴 **全部可为 null**。原来这些走 `n0` 兜成 0,于是"端点没给这一项"在界面上
   *    变成「0.00 元 / 0.00 倍 / 0.00%」—— 与真实的 0 分不开,而且看着完全正常。
   *    上方那条规则本来就写着"取不到的数给 null 不给 0",只是当时只在新加的两个字段上执行了。
   *    改成可空之后,类型系统会**逼着每一处调用点表态**(实测 12 处)。
   */
  name: string; price: number | null; last_close: number | null; change_pct: number | null;
  market: MarketCode; currency: CurrencyCode;
  pe_ttm: number | null; pb: number | null; mcap_yi: number | null; turnover_pct: number | null;
  limit_up: number | null; limit_down: number | null;
  /**
   * 🔴 **单位写进字段名**。行情端点给的是「亿元 / 万元」，而页面的 `yi()` 吃的是「元」——
   *    两边都叫 `amount` 的话，少乘一次 1e4 就会把 186 亿显示成 0.02 亿，而且不会报错。
   */
  /**
   * 🔴 **可为 null**，不能用 `n0` 兜成 0。`n0` 把"端点没给这一项"变成数字 0，
   *    页面照样渲染成「0.00 亿」—— 那是**把没取到显示成一个具体的数**，比空着更糟。
   */
  float_mcap_yi: number | null;   // 流通市值，亿元
  amount_yuan: number | null;     // 成交额，元（端点给万元，这里已 ×1e4）
  /**
   * 腾讯给的成交时间，**交易所当地时间、原样**（A 股 20261009110653 / 港股 2026/10/09 10:51:51 /
   * 美股 2026-10-08 16:00:01）。节假日里停在节前最后一个交易日；首页当日盈亏用它判断「当日」是哪天。
   */
  quote_time?: string | null;
}

export interface Valuation {
  name: string; code: string; price: number | null; mcap_yi: number | null;
  pe_ttm: number | null; pb: number | null;
  eps_26e: number | null; eps_27e: number | null; pe_26e: number | null;
  /** 一致预期的**基年**(FY(T))。🔴 界面标签必须由它拼,不许写死 "26E" ——
   *  基年跟着上游走(跨年 / 上游少给一年都会变),写死的标签会出现
   *  「数字是真的、年份是错的」,而这种错没人看得出来。 */
  base_year: number | null;
  /** 行情信封的取数时刻(ISO)。派生数(前向PE / PEG / 消化年数)都以它为准。 */
  quote_at: string | null;
  /**
   * 派生数的**两个输入各自的证据 id**。
   * 🔴 前向PE / PEG / 消化年数都不是取来的、是算出来的 —— 它们自己没有证据 id,
   *    但它们的输入有。不把这两个带出来,界面上就出现"追不回来源的数字"。
   */
  price_evidence_id: string | null;
  eps_evidence_id: string | null;
  cagr_pct: number | null; peg: number | null; digest_years: number | null;
  analyst_count: number | null; forecast_note?: string;
}

export interface Announcement {
  date: string; title: string; type: string; url: string;
}

export interface NewsItem {
  新闻标题?: string; 发布时间?: string; 文章来源?: string; 新闻链接?: string;
}

export interface IndexQuote {
  name: string; price: number | null; change_pct: number | null; change_amt: number | null;
}

export interface RadarItem {
  title: string; url: string; time: string; source: string; summary?: string; zh?: string;
}
export interface Industry {
  key: string; name: string; accent: string; total: number; items: RadarItem[];
  /** 这个赛道这次没取到的原因。有它时 items 为空不代表「没有更新」 */
  error?: string;
  /** 这个赛道有几个来源这次没取到（其余来源取到了）。下面的条目不含它们 */
  failedSources?: number;
}
export interface RadarData {
  generated_at: string | null; recent_days: number; industries: Industry[];
  stats: { industries: number; total_sources: number; failed_sources?: number; failed_industries?: number };
}

// 产业信号 · GPU 租金
export interface GpuSpot {
  gpu: string; median?: number; asof_ts?: number;
  available_gpus?: number | null; total_gpus?: number | null;
  unavailable?: boolean; note?: string; err?: string;
  stale?: boolean; fetch_error?: string; observed_at?: string | null;
}
export interface GpuHistSeries {
  gpu: string; n_points?: number; points?: [number, number][]; latest?: number;
  unavailable?: boolean; note?: string; err?: string;
  stale?: boolean; fetch_error?: string; observed_at?: string | null;
}
export interface ForwardRung { strike: number; p_above: number; open_interest: number | null }
export interface DistBin { label: string; lo: number | null; hi: number | null; p: number }
export interface ImpliedMedian { value: number; bound: "exact" | "above" | "below" }
export interface ForwardMonth {
  month: string; close_date: string; rungs: ForwardRung[];
  lowest_strike: number; p_below_lowest: number;
  implied_median: ImpliedMedian | null;
  distribution: DistBin[]; most_likely: DistBin;
}
export interface SettledMonth { month: string; lo: number | null; hi: number | null }
export interface GpuForward {
  months?: ForwardMonth[]; n_contracts?: number; n_months?: number;
  settled?: SettledMonth[]; settled_error?: string | null;
  unavailable?: boolean; note?: string; err?: string;
  stale?: boolean; fetch_error?: string; observed_at?: string | null;
  /** 取数层现行的读数：最近一个有报价的合约月、最低档（美元/卡时）、P(月均 < 最低档) */
  lowest?: { month: string; strike_usd: number; p_below: number };
}
export interface GpuRentData {
  generated_at: string | null;
  how_to_read: string[];
  spot_source: string; history_source: string; forward_source: string;
  spot: { gpus: GpuSpot[] };
  history: { gpus: GpuHistSeries[]; days: number };
  forward: GpuForward | null;
  errors: string[] | null;
}

// 事件概率（全球宏观预期概率 · 预测市场公开定价）
export interface MacroProbItem {
  topic: string;      // 话题（货币政策 / 通胀 …）
  source: string;     // polymarket / kalshi
  title: string;      // 合约问的是什么
  leg: string;        // 结果腿（Yes / No / 某个区间）
  prob: number | null;
  settle: string;     // 结算日
  volume: number | null;
}
export interface MacroProbability {
  items: MacroProbItem[];
  /** 🔴 取数层给的读法护栏，原样带出来与数字同屏显示 */
  how_to_read: string[];
  updated: string;
  partial: boolean;
}

export interface Holding {
  /** cost = 每股成本(按所选成本法);cost_total = 持有部分的总成本 */
  code: string; name: string; shares: number; cost: number; cost_total: number;
  market: MarketCode; currency: CurrencyCode;
  opened_at: string; realized_pnl: number; dividends: number;
  /** 🔴 行情派生的四项**可为 null**:拉不到行情时显示「—」,不是 0。
   *  写死成 number 的话,一只取不到行情的持仓会整行显示「现价 0.00 / 市值 0.00 / 浮盈 0.00」,
   *  排版完全正常,看不出是没取到。 */
  price: number | null; market_value: number | null;
  pnl: number | null; pnl_pct: number | null;
}
export interface ClosedPosition {
  id: string; currency: CurrencyCode;
  note: string;
  code: string; name: string; date: string; price: number; shares: number; cost: number;
  pnl: number; pnl_pct: number | null;
}
/** 卖光了、但有过已实现盈亏或分红的代码(由流水算出) */
export interface ClosedHolding {
  code: string; name: string; currency: CurrencyCode; realized_pnl: number; dividends: number; fees: number; last_date: string;
}
export interface PortfolioData {
  method: CostMethod; method_label: string; methods: { id: CostMethod; label: string }[];
  holdings: Holding[];
  /** 三币种分开汇总：不做汇率换算就绝不可以直接相加。市值 / 成本只算拿到行情的;已实现 / 分红算全部流水 */
  totals: {
    market: MarketCode; currency: CurrencyCode; label: string;
    market_value: number; cost: number; pnl: number; pnl_pct: number | null;
  }[];
  /** 已实现盈亏 / 现金分红按币种(含已卖光的) */
  realized_totals: { currency: CurrencyCode; pnl: number; dividends: number }[];
  /** 人民币合计:每个币种都有汇率才有;缺汇率时 missing 写缺哪个 */
  cny: (CnyTotal & { fx: FxRates }) | { missing: CurrencyCode[] } | null;
  trades: Trade[];
  issues: TradeIssue[];
  closed: ClosedHolding[];
  /** 还没迁移的旧持有记录(冲突 / 没法迁的,要用户处理) */
  legacy: LegacyPosition[];
  /** 这次打开时自动迁移的结果(没迁就是 null) */
  migration: MigrationResult | null;
  /** 自动迁移没成的原因(原文件没动,下次打开再试);null = 没出错 */
  migration_error: string | null;
  /** 各币种持有中、但没取到行情的只数:它们不在市值 / 成本合计里 */
  unquoted: { currency: CurrencyCode; count: number }[];
  /** 旧版「清仓记录」(流水之前手记的),只读 + 可删 */
  legacy_closed: ClosedPosition[];
  legacy_closed_invalid: number;
  legacy_realized_totals: { currency: CurrencyCode; pnl: number }[];
  updated: string; last_refresh: string | null;
}

export interface Board { name: string; code: string; change_pct: number | string; lead_stock: string }
// 全球市场：指数复用已注册的腾讯批量快照，不把抓取时间冒充成交时间。
export interface GlobalIndex {
  key: string; name: string; region: string;
  price: number | null; change_pct: number | null;
  fetched_at?: string | null; evidence_id?: string | null; note?: string;
}
/* ==================== 映射:上游语义接口 → 我们的取数端点 ==================== */

const env = async (endpoint: string, opts: { symbol?: string; args?: Record<string, unknown>; refresh?: boolean } = {}): Promise<Envelope> =>
  (await backend.fetch(endpoint, opts)).envelope;

/** 换算单位。**null 进 null 出** —— 直接写 `x * k` 会把"没有"变成 0，页面就显示成「0.00 亿」 */
const mul = (v: number | null, k: number): number | null => (v === null ? null : v * k);
const subtract = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);
/* ---------- 行情 / 估值 ---------- */

async function quoteMap(codes: string[], refresh = false): Promise<Record<string, Quote>> {
  const canonical = [...new Set(codes.map(normalizeMarketSymbol).filter((c): c is string => c !== null))];
  const queries = canonical.map(quoteQueryOfSymbol).filter((c): c is string => c !== null);
  if (!queries.length) return {};
  const e = await env("tx_quotes_batch", { args: { codes: queries }, refresh });
  const out: Record<string, Quote> = {};
  for (const r of rows(e)) {
    const symbol = symbolFromQuoteKey(r.key);
    const market = symbol ? marketOfSymbol(symbol) : null;
    const currency = symbol ? currencyOfSymbol(symbol) : null;
    if (!symbol || !market || !currency) continue;
    out[symbol] = {
      fetched_at: r.fields.price?.fetched_at ?? null,
      name: str(r.fields.security_name),
      market,
      currency,
      price: num(r.fields.price),
      last_close: num(r.fields.last_close),
      change_pct: num(r.fields.change_pct),
      pe_ttm: num(r.fields.pe_ttm),
      pb: num(r.fields.pb),
      mcap_yi: num(r.fields.market_cap),
      turnover_pct: num(r.fields.turnover_rate),
      limit_up: num(r.fields.limit_up_price),
      limit_down: num(r.fields.limit_down_price),
      float_mcap_yi: num(r.fields.float_market_cap),                        // 端点单位：亿元
      // 这个旧字段只有 A 股页面在用。美 / 港成交额是各自币种，不冒充人民币。
      amount_yuan: market === "CN" ? mul(num(r.fields.turnover_amount), 1e4) : null,
      quote_time: str(r.fields.quote_time) || null,
    };
  }
  return out;
}

/* ---------- 财务 / 公告 / 研报 / 新闻 ---------- */

async function announcementsOf(code: string, refresh = false): Promise<Announcement[]> {
  const e = await env("cninfo_announcements", { symbol: code, refresh });
  return rows(e).map((r) => {
    const kv = noteKV(r.note);
    return {
      date: r.fields.announcement_title?.period ?? "",
      title: str(r.fields.announcement_title),
      type: kv.type ?? "",
      url: kv.url ?? kv.link ?? "",
    };
  });
}

async function newsOf(code: string, refresh = false): Promise<NewsItem[]> {
  const e = await env("em_stock_news", { symbol: code, refresh });
  return rows(e).map((r) => {
    const kv = noteKV(r.note);
    const ev = r.fields.news_title;
    return {
      新闻标题: str(ev),
      发布时间: ev?.period ?? "",
      文章来源: kv.source ?? "",
      新闻链接: kv.url ?? kv.link ?? "",
    };
  });
}

/* ---------- 资讯雷达 / 产业信号 ---------- */

const RADAR_ACCENTS = ["#f97316", "#38bdf8", "#a78bfa", "#34d399", "#f472b6", "#facc15", "#60a5fa", "#fb7185"];

/**
 * 资讯雷达。取数层是**按行业一次一个**,页面要的是全部行业 ⇒ 并发取。
 *
 * 🔴 行业清单**由取数层随信封下发**(`extra.industries`),前端不写死一份 ——
 *    写死的那份迟早跟真实源对不上,而对不上的表现是"选了没反应",看不出是配置漂移。
 * ⚠️ 默认读快照(打开页面不重跑上游);点刷新才真去抓。
 */
async function radarOf(refresh = false): Promise<RadarData> {
  const first = (await backend.fetch("rss_news", { args: { industry: "ai", per_source: 6 }, refresh })).envelope;
  const list = ((first.extra?.industries as { key: string; name: string }[] | undefined) ?? [
    { key: "ai", name: "AI / 大模型" },
  ]);

  const build = (e: Envelope, key: string, name: string, i: number): Industry => {
    const items: RadarItem[] = rows(e).map((r) => {
      const kv = noteKV(r.note);
      const t = r.fields.news_title;
      return {
        title: str(t),
        url: kv.link ?? kv.url ?? r.key,
        time: t?.period ?? t?.as_of ?? "",
        source: kv.source ?? "",
        ...(str(r.fields.news_summary) ? { summary: str(r.fields.news_summary) } : {}),
      };
    });
    // 🔴 来源超时 / 报错时取数层**照样返回信封**(HTTP 200),故障在 extra.failures 里;只认请求异常的话,
    //    全部来源都挂了也显示成「暂无更新」(审计第二轮 C8)
    const failures = Array.isArray(e.extra?.failures) ? (e.extra!.failures as { error?: unknown }[]) : [];
    const ok = num(scalar(e, "rss_sources_ok"));
    const why = failures[0]?.error;
    const status = !failures.length ? {}
      : !items.length && !ok ? { error: `${failures.length} 个来源都没取到（${typeof why === "string" && why ? why.slice(0, 120) : "没给原因"}）` }
      : { failedSources: failures.length };
    return { key, name, accent: RADAR_ACCENTS[i % RADAR_ACCENTS.length]!, total: items.length, items, ...status };
  };

  const rest = await Promise.all(
    list.slice(1).map((ind) =>
      backend
        .fetch("rss_news", { args: { industry: ind.key, per_source: 6 }, refresh })
        .then((r) => r.envelope)
        // 🔴 单个行业挂掉不废整页,但**它的条数会是 0** —— 页面上要看得出是"这个源没抓到"(带上原因,见 Industry.error)
        .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
    ),
  );

  const industries: Industry[] = [
    build(first, list[0]!.key, list[0]!.name, 0),
    ...rest.map((e, i) => {
      const ind = list[i + 1]!;
      return "error" in e
        ? { key: ind.key, name: ind.name, accent: RADAR_ACCENTS[(i + 1) % RADAR_ACCENTS.length]!, total: 0, items: [], error: e.error }
        : build(e, ind.key, ind.name, i + 1);
    }),
  ];

  // 🔴 "源数"是源数,不是条数 —— 各行业的 rss_sources_ok 相加。
  //    (拿条数填这一格,界面会写出"462 个公开源"这种一眼假的数。)
  const envs = [first, ...rest.filter((e): e is Envelope => !("error" in e))];
  const sources = envs.reduce((a, e) => a + (num(scalar(e, "rss_sources_ok")) ?? 0), 0);
  const failed = envs.reduce((a, e) => a + ((e.extra?.failures as unknown[] | undefined)?.length ?? 0), 0);
  return {
    generated_at: first.fetched_at,
    recent_days: 3,
    industries,
    stats: { industries: industries.length, total_sources: sources, failed_sources: failed, failed_industries: rest.length - (envs.length - 1) },
  };
}

/**
 * 远期：取数层现在只给**最近一个有报价的合约月**的最低档和 P(月均 < 最低档)（`gpu_forward_*`），
 * 没有逐档阶梯和分布。以前这里固定返回 null，取到了也不显示（审计第三轮 C8）。
 * 没报价（`gpu_forward_status`）、取失败（errors 里的 `forward:`）分别说明；只按取到的原值显示，不补中位数和分布。
 */
export function gpuForwardOf(e: { evidence: Evidence[]; errors: unknown[] }): GpuForward | null {
  const p = e.evidence.find((x) => x.field === "gpu_forward_p_below_lowest_strike");
  const k = e.evidence.find((x) => x.field === "gpu_forward_lowest_strike_usd" && x.record_key === p?.record_key);
  const pv = typeof p?.value === "number" ? p.value : Number(p?.value);
  const kv = typeof k?.value === "number" ? k.value : Number(k?.value);
  const month = /^KXB200MS:(\d{4}-\d{2})$/.exec(String(p?.record_key ?? ""))?.[1];
  if (p && k && month && Number.isFinite(pv) && pv >= 0 && pv <= 1 && Number.isFinite(kv) && kv > 0) {
    return { lowest: { month, strike_usd: kv, p_below: pv } };
  }
  if (e.evidence.some((x) => x.field === "gpu_forward_status" && x.value === "unavailable")) {
    return { unavailable: true, note: "Kalshi 阶梯市场这次没有有效报价（未开盘或无成交）" };
  }
  const err = e.errors.map(String).find((x) => x.startsWith("forward:"));
  if (err) return { err: err.slice("forward:".length).trim() || "取数失败" };
  if (p || k) return { err: "远期数据不完整（最低档或概率缺一项，或数值不对），不显示" };
  return null;
}

async function gpuRentOf(refresh = false): Promise<GpuRentData> {
  const e = (await backend.fetch("gpu_rent_thermometer", { refresh })).envelope;
  /**
   * 现货卡 = 曲线的最后一个点（取数层派生，见 industry._spot_from_history）⇒
   * 卡片上的数字与曲线末端**严格一致**。
   * 🔴 **不能只留有中位价的那些行**：某张卡暂时没有序列时它只有 `gpu_available_count`，
   *    过滤掉的话那张卡的卡片会整个消失 —— 用户看到的是"少了一张卡"，而不是"这张卡暂时没数据"。
   */
  const numOrNull = (v: string | undefined) => {
    const n = Number(v);
    return v === undefined || v === "" || v === "None" || !Number.isFinite(n) ? null : n;
  };
  const spot = rows(e)
    // 🔴 三种情况都要出卡片：有中位价 / 只有挂单卡数 / **未覆盖**（status 型证据）。
    //    漏掉最后一种的话，取不到序列的那张卡会**整张消失** —— 用户看到的是"只有两张卡"，
    //    而不是"第三张没覆盖到"，与"把没取到渲染成正常结果"是同一个坑的另一面。
    .filter((r) => r.fields.gpu_spot_median_usd_per_gpu_hr || r.fields.gpu_available_count
                || r.fields.gpu_spot_status)
    .map((r) => {
      const kv = noteKV(r.note);
      const median = num(r.fields.gpu_spot_median_usd_per_gpu_hr);
      return {
        gpu: r.key,
        ...(median === null ? { unavailable: true } : { median }),
        available_gpus: numOrNull(kv.available_gpus),
        total_gpus: numOrNull(kv.total_gpus),
        asof_ts: numOrNull(kv.asof_ts) ?? undefined,
        note: r.note,
      } as GpuSpot;
    });
  /**
   * 近一年逐日曲线 —— **取数层直接给**（500.farm 对 Vast 可租挂单的逐日中位统计，
   * 与开源版同一个源、同一条查询）。
   *
   * 🔴 以前这里画的是**本机温度计历史序列**：那条序列只在完整研究运行时才追加，
   *    新装的机器上就是几个点、跨度不到一天 —— 顶着"近一年走势"的标题画出来，
   *    是让标题替数据打包票。现在曲线有自己的真实来源，序列继续留着做跨运行对账，
   *    但不再拿它冒充一年。
   * ⚠️ 三张卡各自成败：某一张拿不到就只少一条线，并把它自己的原因带出来。
   */
  const rawHist = (e.extra?.history ?? {}) as {
    gpus?: GpuHistSeries[]; days?: number; source?: string; errors?: string[];
  };
  const histGpus = Array.isArray(rawHist.gpus) ? rawHist.gpus : [];
  const usable = histGpus.filter((g) => (g.points?.length ?? 0) > 0);
  const history = usable.length
    ? { gpus: histGpus, days: rawHist.days ?? 0 }
    : {
        // 一条线都没有：**说清楚为什么**，不给一条空曲线冒充"没有波动"
        gpus: [{
          gpu: "B200",
          unavailable: true,
          note: rawHist.errors?.length ? rawHist.errors.join("；") : "统计站这次没有返回可用序列",
        } as GpuHistSeries],
        days: 0,
      };
  const spanDays = Math.max(
    0,
    ...usable.map((g) => {
      const pts = g.points ?? [];
      return pts.length > 1 ? Math.round((pts[pts.length - 1]![0] - pts[0]![0]) / 86400) : 0;
    }),
  );
  const spanNote = usable.length ? `${usable.length} 张卡 · 覆盖 ${spanDays} 天` : "";

  return {
    generated_at: e.fetched_at,
    // 🔴 读法直接照抄取数层的护栏句 —— 不改写、不省略
    how_to_read: [...new Set(e.evidence.map((x) => (x.note ?? "").split("读法:")[1]).filter(Boolean) as string[])],
    spot_source: (e.extra?.spot_source as string | undefined) ?? "现货 = 走势曲线的最新采样点",
    history_source: `${rawHist.source ?? "统计站逐日中位"}${spanNote ? ` · ${spanNote}` : ""}`,
    forward_source: "Kalshi 远期合约",
    spot: { gpus: spot },
    history,
    forward: gpuForwardOf(e),
    errors: e.errors.length ? e.errors.map((x) => String(x)) : null,
  };
}

/* ---------- 事件概率 ---------- */

/**
 * 全球宏观预期概率 —— 预测市场（Polymarket / Kalshi）的公开定价。
 *
 * 🔴 这是**市场当前定价**，不是预测、更不是我们的判断。取数层的「读法」护栏原样带出，
 *    界面必须与数字同屏显示 —— 只给一个百分比而不给读法，等于替上游打包票。
 */
async function macroProbabilityOf(refresh = false): Promise<MacroProbability> {
  const e = await env("macro_probability", { refresh });
  // note: `[话题] 来源 合约「标题」(腿)的市场定价概率(口径:…);结算日 YYYY-MM-DD(…);24h 成交量 N;读法:…`
  const NOTE = /^\[([^\]]+)\]\s*(\S+)\s*合约「([^」]*)」\(([^)]*)\)/;
  const VOL = /24h\s*成交量\s*([\d.]+)/;
  const items: MacroProbItem[] = rows(e).map((r) => {
    const m = NOTE.exec(r.note);
    const ev = r.fields.macro_probability;
    const [topic = "", source = ""] = r.key.split(":");
    return {
      topic: m?.[1] ?? topic,
      source: m?.[2] ?? source,
      title: m?.[3] ?? "",
      leg: m?.[4] ?? "",
      prob: num(ev),
      settle: ev?.period ?? "",
      volume: VOL.exec(r.note) ? Number(VOL.exec(r.note)![1]) : null,
    };
  });
  return {
    items: items.sort((a, b) => (b.prob ?? -1) - (a.prob ?? -1)),
    how_to_read: [...new Set(e.evidence.map((x) => (x.note ?? "").split("读法:")[1]).filter(Boolean) as string[])],
    updated: e.fetched_at,
    // partial = 有的源没取到。🔴 要说出来 —— 否则用户会以为"就这么几条"
    partial: e.status !== "ok",
  };
}

/* ---------- 持仓:走**用户自有台账**,不另起一套存储 ---------- */

/**
 * 持仓 = 台账里的**交易流水**按成本法重放(后端 `/view/holdings`)+ 现拉行情算市值盈亏。
 * 持有多少、成本多少都是重放算出来的,不另存;旧的「一只一条」持有记录打开时自动迁成期初流水(后端先备份)。
 *
 * 旧版清仓记录(closed_position)只读 + 可删,单独汇总,不和流水的已实现盈亏相加(两边可能记的是同一笔卖出)。
 */
async function portfolioOf(method: CostMethod = "average", refresh = false): Promise<PortfolioData> {
  let view = await backend.holdings(method);
  let migration: MigrationResult | null = null;
  let migrationError: string | null = null;
  if (view.migration_pending > 0) {
    // 迁移没成不让整页空白:照常显示已有的流水,并说明旧记录这次没转成
    try {
      const r = await backend.holdingsAct({ action: "migrate", method });
      view = r.view; migration = r.result;
    } catch (e) {
      migrationError = e instanceof Error && e.message ? e.message : "自动迁移失败";
    }
  }
  return assemble(view, migration, refresh, migrationError);
}

async function assemble(view: HoldingsView, migration: MigrationResult | null, refresh: boolean, migrationError: string | null = null): Promise<PortfolioData> {
  const codes = view.holdings.map((h) => h.symbol);
  const [quotes, fxRes, led] = await Promise.all([
    codes.length ? quoteMap(codes, refresh).catch(() => ({}) as Record<string, Quote>) : Promise.resolve({} as Record<string, Quote>),
    view.holdings.some((h) => currencyOfSymbol(h.symbol) !== "CNY") ? backend.fetch("fx_rates", { refresh }).catch(() => null) : Promise.resolve(null),
    backend.ledger(),
  ]);

  const holdings: Holding[] = view.holdings.flatMap((h) => {
    const code = normalizeMarketSymbol(h.symbol);
    const market = code ? marketOfSymbol(code) : null;
    const currency = code ? currencyOfSymbol(code) : null;
    if (!code || !market || !currency) return [];
    const q = quotes[code];
    // 🔴 拉不到行情(整只票缺席,或缺了 price 这一项)时一律 null —— 不拿成本冒充现价,
    //    也不填 0:那会把浮盈显示成"正好不赚不亏",而它其实是没取到。
    const price = q?.price != null && Number.isFinite(q.price) && q.price > 0 ? q.price : null;
    const mv = price === null ? null : price * h.shares;
    const pnl = mv === null ? null : mv - h.cost_total;
    return [{
      code, name: h.name || q?.name || "", market, currency, price,
      shares: h.shares, cost: Math.round(h.unit_cost * 1e4) / 1e4, cost_total: h.cost_total,
      opened_at: h.opened_at, realized_pnl: h.realized_pnl, dividends: h.dividends,
      market_value: round2(mv), pnl: round2(pnl),
      pnl_pct: pnl !== null && h.cost_total > 0 ? round2((pnl / h.cost_total) * 100) : null,
    }];
  });

  // 合计只累加**拿到行情的那些**，并且必须按币种分组。
  // 人民币 10 万 + 美元 2 万 + 港元 3 万没有一个不经换算就成立的「总数」。
  const totalMap = new Map<CurrencyCode, Holding[]>();
  for (const h of holdings) {
    if (h.market_value === null) continue;
    totalMap.set(h.currency, [...(totalMap.get(h.currency) ?? []), h]);
  }
  const unquoted = new Map<CurrencyCode, number>();
  for (const h of holdings) if (h.market_value === null) unquoted.set(h.currency, (unquoted.get(h.currency) ?? 0) + 1);
  const totals = [...totalMap.entries()].map(([currency, items]) => {
    const mv = items.reduce((a, h) => a + (h.market_value ?? 0), 0);
    const costSum = items.reduce((a, h) => a + h.cost_total, 0);
    return {
      market: items[0]!.market, currency, label: currencyLabel(currency),
      market_value: round2(mv)!, cost: round2(costSum)!, pnl: round2(mv - costSum)!,
      pnl_pct: costSum > 0 ? round2(((mv - costSum) / costSum) * 100)! : null,
    };
  });
  const fx = fxRes ? fxFromEnvelope(fxRes.envelope, fxRes.fetched_at) : { USD: null, HKD: null, date: null, fetched_at: null };
  const cnyRaw = totals.length > 1 || totals.some((t) => t.currency !== "CNY") ? cnyTotal(totals, fx) : null;
  const cny = cnyRaw === null ? null : "missing" in cnyRaw ? cnyRaw
    : { market_value: round2(cnyRaw.market_value)!, cost: round2(cnyRaw.cost)!, pnl: round2(cnyRaw.pnl)!, pnl_pct: round2(cnyRaw.pnl_pct), fx };

  const closed: ClosedHolding[] = view.closed.flatMap((c) => {
    const code = normalizeMarketSymbol(c.symbol);
    const currency = code ? currencyOfSymbol(code) : null;
    return code && currency ? [{ code, name: c.name || code, currency, realized_pnl: round2(c.realized_pnl)!, dividends: round2(c.dividends)!, fees: round2(c.fees)!, last_date: c.last_date }] : [];
  });
  const realized = new Map<CurrencyCode, { pnl: number; dividends: number }>();
  for (const r of [...holdings.map((h) => ({ currency: h.currency, pnl: h.realized_pnl, dividends: h.dividends })), ...closed.map((c) => ({ currency: c.currency, pnl: c.realized_pnl, dividends: c.dividends }))]) {
    const cur = realized.get(r.currency) ?? { pnl: 0, dividends: 0 };
    realized.set(r.currency, { pnl: cur.pnl + r.pnl, dividends: cur.dividends + r.dividends });
  }

  const closedRecords = led.records.closed_position ?? [];
  const legacyClosed: ClosedPosition[] = closedRecords.flatMap(r => {
    const code = normalizeMarketSymbol(r.symbol);
    const price = Number(r.price), shares = Number(r.shares), cost = Number(r.cost);
    const day = typeof r.closed_at === "string" ? Date.parse(r.closed_at) : NaN;
    if (!code || ![r.price, r.shares, r.cost].every(v => typeof v === "number" && Number.isFinite(v))
        || price <= 0 || shares <= 0 || !Number.isFinite((price - cost) * shares)
        || typeof r.closed_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.closed_at)
        || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== r.closed_at) return [];
    return [{ id: r.id, code, name: String(r.name || code), note: typeof r.note === "string" ? r.note : "", currency: currencyOfSymbol(code)!,
      date: String(r.closed_at), price, shares, cost, pnl: round2((price - cost) * shares)!,
      pnl_pct: cost > 0 ? round2((price - cost) / cost * 100) : null }];
  });
  const legacyRealized = new Map<CurrencyCode, number>();
  for (const r of legacyClosed) legacyRealized.set(r.currency, (legacyRealized.get(r.currency) ?? 0) + r.pnl);

  return {
    method: view.method, method_label: view.method_label, methods: view.methods,
    holdings,
    totals,
    realized_totals: [...realized].map(([currency, v]) => ({ currency, pnl: round2(v.pnl)!, dividends: round2(v.dividends)! })),
    cny,
    trades: view.trades,
    issues: view.issues,
    closed,
    legacy: view.legacy,
    migration,
    migration_error: migrationError,
    unquoted: [...unquoted].map(([currency, count]) => ({ currency, count })),
    legacy_closed: legacyClosed,
    legacy_closed_invalid: closedRecords.length - legacyClosed.length,
    legacy_realized_totals: [...legacyRealized].map(([currency, pnl]) => ({ currency, pnl: round2(pnl)! })),
    updated: new Date().toISOString(),
    last_refresh: refresh ? new Date().toISOString() : null,
  };
}

/**
 * 写台账成功、之后重读持仓失败时抛的错误码。调用方要按「已经写了」处理：清表单、不让原样重试，
 * 只提示刷新。否则记一笔买入后刷新失败，用户再点一次就记成两笔（Codex 审计 2026-10-09 C4）。
 */
export const SAVED_REFRESH_FAILED = "saved_refresh_failed";

async function reloadAfterWrite(method: CostMethod, done: string): Promise<PortfolioData> {
  try {
    return await portfolioOf(method);
  } catch (e) {
    throw new ApiError(`${done}，但重新读取持仓失败（${e instanceof Error ? e.message : String(e)}）。点「刷新」再读一次就行，不用重做`,
      e instanceof ApiError ? e.status : 0, SAVED_REFRESH_FAILED);
  }
}

/** 记一笔流水。表单检查与后端重放同口径;写进去以后持仓由重放重新算 */
async function addTradeTo(form: TradeForm, method: CostMethod): Promise<PortfolioData> {
  const r = tradeRecord(form);
  if ("error" in r) throw new ApiError(r.error, 400, "bad_input");
  await backend.ledgerSave("trade", r.record);
  return reloadAfterWrite(method, "这笔已经记下");
}

async function removeTradeFrom(id: string, method: CostMethod): Promise<PortfolioData> {
  await backend.ledgerDelete("trade", id);
  return reloadAfterWrite(method, "这笔流水已经删掉");
}

/** 冲突的旧持有记录:adopt = 按它补一笔期初持仓,discard = 删掉(后端都先备份) */
async function resolveLegacyPosition(action: "adopt" | "discard", id: string, method: CostMethod): Promise<PortfolioData> {
  const r = await backend.holdingsAct({ action, id, method });
  return assemble(r.view, r.result, false);
}

/** 从表格导入:后端一次写进去(要么全写、要么全不写,先备份),回新的持仓数据和这次导入了几笔、备份在哪 */
async function importTradesTo(rows: Record<string, unknown>[], method: CostMethod): Promise<{ data: PortfolioData; imported: { backup: string; imported: number } }> {
  const r = await backend.holdingsImport(rows, method);
  const imported = { backup: r.imported.backup, imported: r.imported.imported };
  try {
    return { data: await assemble(r.view, null, false), imported };
  } catch (e) {
    // 已经写进台账：和「记一笔」一样报 SAVED_REFRESH_FAILED，调用方清掉这份表格，别让人再导一次记成两笔（审计第三轮 C1）
    throw new ApiError(`已经导入 ${imported.imported} 笔（导入前的备份在数据目录的 ${imported.backup}），但重新读取持仓失败（${e instanceof Error ? e.message : String(e)}）。点「刷新」再读一次就行，不要再导入一次`,
      e instanceof ApiError ? e.status : 0, SAVED_REFRESH_FAILED);
  }
}

/* ---------- 指数（每日复盘、首页顶上那一条共用） ---------- */
const CN_INDEX_SPECS = [["sh000001", "上证指数"], ["sh000300", "沪深300"], ["sz399001", "深证成指"], ["sz399006", "创业板指"]] as const;
const CN_INDEX_CODES: string[] = CN_INDEX_SPECS.map(([code]) => code);
const GLOBAL_INDEX_SPECS = [
  ["usDJI", "道琼斯", "美股"], ["usIXIC", "纳斯达克综合", "美股"],
  ["hkHSI", "恒生指数", "港股"], ["hkHSTECH", "恒生科技", "港股"],
] as const;

/** 首页那一条用：四个 A 股指数固定占位，哪个没取到就显示「—」并写明，不悄悄少一格 */
function cnIndexTiles(e: Envelope): (IndexQuote & { note?: string })[] {
  const byKey = new Map(rows(e).map((r) => [r.key, r]));
  return CN_INDEX_SPECS.map(([code, fallback]) => {
    const row = byKey.get(code);
    const value = num(row?.fields.price);
    const price = value !== null && value > 0 ? value : null;
    return {
      name: str(row?.fields.security_name) || fallback,
      price,
      change_pct: price === null ? null : num(row?.fields.change_pct),
      change_amt: price === null ? null : subtract(price, num(row?.fields.last_close)),
      ...(price === null ? { note: "本次未取得该指数报价" } : {}),
    };
  });
}

function globalIndexRows(e: Envelope): GlobalIndex[] {
  const byKey = new Map(rows(e).map((r) => [r.key, r]));
  return GLOBAL_INDEX_SPECS.map(([key, name, region]): GlobalIndex => {
    const row = byKey.get(key);
    const value = num(row?.fields.price);
    const price = value !== null && value > 0 ? value : null;
    return {
      key, name, region, price,
      change_pct: price === null ? null : num(row?.fields.change_pct),
      fetched_at: price === null ? null : row?.fields.price?.fetched_at ?? null,
      evidence_id: price === null ? null : row?.fields.price?.id ?? null,
      note: price === null ? "本次未取得该指数报价" :
        [typeof e.extra?.degraded === "string" ? e.extra.degraded : "", row?.note.includes("僵尸报价") ? "非交易时段或报价陈旧" : ""].filter(Boolean).join("；"),
    };
  });
}

export const api = {
  quote: (codes: string, refresh = false) => quoteMap(codes.split(",").map((c) => c.trim()).filter(Boolean), refresh),
  announcements: announcementsOf,
  news: newsOf,

  /** 首页顶上那一条：A 股四大指数 + 全球四个指数，**一次请求**取齐（首页要反复刷新，别拆成两次） */
  marketStrip: async (refresh = false): Promise<{ cn: (IndexQuote & { note?: string })[]; global: GlobalIndex[] }> => {
    const e = await env("tx_quotes_batch", { args: { codes: [...CN_INDEX_CODES, ...GLOBAL_INDEX_SPECS.map(([key]) => key)] }, refresh });
    const cn = cnIndexTiles(e);
    const global = globalIndexRows(e);
    // 八个一个都没取到：报错让页面说「没取到」，而不是八格「—」看着像正常
    if (![...cn, ...global].some((x) => x.price !== null)) throw new Error("指数未取得可用数据，请稍后刷新；不代表市场没有变化。");
    return { cn, global };
  },

  macroProbability: macroProbabilityOf,
  globalIndices: async (refresh = false): Promise<GlobalIndex[]> => {
    const result = globalIndexRows(await env("tx_quotes_batch", { args: { codes: GLOBAL_INDEX_SPECS.map(([key]) => key) }, refresh }));
    if (!result.some((r) => r.price !== null)) throw new Error("全球指数未取得可用数据，请稍后刷新；不代表市场没有变化。");
    return result;
  },
  radar: () => radarOf(false),
  radarRefresh: () => radarOf(true),
  gpuRent: () => gpuRentOf(false),
  gpuRentRefresh: () => gpuRentOf(true),
  portfolio: (method: CostMethod = "average") => portfolioOf(method),
  refreshPortfolio: (method: CostMethod = "average") => portfolioOf(method, true),
  addTrade: addTradeTo,
  removeTrade: removeTradeFrom,
  resolveLegacy: resolveLegacyPosition,
  importTrades: importTradesTo,
  /** 删旧版清仓记录(流水之前手记的) */
  removeClosed: async (id: string, method: CostMethod = "average"): Promise<PortfolioData> => {
    await backend.ledgerDelete("closed_position", id);
    return reloadAfterWrite(method, "这条清仓记录已经删掉");
  },
  myReports: (): Promise<MyReport[]> => backend.reports(),
  uploadReport: (name: string, content: string): Promise<MyReport> => backend.reportUpload(name, content),
  deleteReport: async (id: string): Promise<{ ok: boolean }> => ({ ok: (await backend.reportDelete(id)).removed }),
};
