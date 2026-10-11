/**
 * 持仓页(交易流水)的界面数据与纯函数。重放在后端(orchestrator/src/finance/holdings.ts),
 * 迁移旧持有记录在 holdings_view.ts;这里只管表单、行情拼接与按币种汇总。
 *
 * 🔴 三币种分开汇总;人民币合计只在**每个用到的币种都有汇率**时给,并写明汇率日期 —— 缺一个就不给合计。
 */
import { normalizeMarketSymbol, type CurrencyCode } from "./marketSymbol.ts";
import type { Envelope } from "./backend.ts";

export type CostMethod = "fifo" | "average";
export const COST_METHOD_KEY = "vr.portfolio.cost_method";
/** 持仓页选的成本法（首页的持仓卡跟着它）；存储不可用时用移动加权平均 */
export const readCostMethod = (): CostMethod => {
  try { return localStorage.getItem(COST_METHOD_KEY) === "fifo" ? "fifo" : "average"; } catch { return "average"; }
};
export type TradeType = "opening" | "buy" | "sell" | "dividend" | "split";
export const TRADE_TYPES: TradeType[] = ["buy", "sell", "dividend", "split", "opening"];
export const TRADE_TYPE_LABELS: Record<TradeType, string> = {
  buy: "买入", sell: "卖出", dividend: "现金分红", split: "送转 / 拆股", opening: "期初持仓",
};

export interface Trade {
  id: string; symbol: string; name: string; account: string; type: string; date: string;
  shares: number | null; price: number | null; fee: number | null; amount: number | null; ratio: number | null;
  note: string; migrated_from: string; created_at: string;
}
export interface TradeIssue { id: string; symbol: string; date: string; type: string; why: string }
export interface Lot { trade_id: string; date: string; shares: number; unit_cost: number }
export interface HoldingRow {
  symbol: string; name: string; shares: number; unit_cost: number; cost_total: number; opened_at: string;
  lots: Lot[]; realized_pnl: number; dividends: number; fees: number; trade_count: number;
}
export interface ClosedRow { symbol: string; name: string; realized_pnl: number; dividends: number; fees: number; last_date: string }
export interface LegacyPosition {
  id: string; symbol: string; name: string; shares: number | null; cost: number | null; opened_at: string;
  state: "pending" | "stale" | "conflict" | "skipped"; why: string;
  /** 已经按它转过的那笔期初持仓(之后旧记录又改了):确认转换会替换这笔,不是再补一笔 */
  migrated_trade: string | null;
}
export interface MigrationResult {
  backup: string | null;
  migrated: { position_id: string; trade_id: string; symbol: string }[];
  removed_stale: string[];
  failed: { position_id: string; symbol: string; why: string }[];
}
/** 导入预览的一行(后端 holdings_view.previewImport) */
export interface ImportPreviewRow {
  problem: string | null;
  duplicate: "existing" | "table" | null;
  duplicate_of: number | null;
  skip_reason: string | null;
}
export interface HoldingsView {
  method: CostMethod; method_label: string; methods: { id: CostMethod; label: string }[];
  holdings: HoldingRow[]; closed: ClosedRow[];
  realized: { trade_id: string; symbol: string; date: string; shares: number; proceeds: number; cost: number; pnl: number }[];
  dividends: { trade_id: string; symbol: string; date: string; amount: number }[];
  issues: TradeIssue[]; trades: Trade[]; legacy: LegacyPosition[]; migration_pending: number; today: string;
}

/** 每一类流水要填哪些格(其余不显示、不提交) */
export const FIELDS_OF: Record<TradeType, readonly ("shares" | "price" | "fee" | "amount" | "ratio")[]> = {
  buy: ["shares", "price", "fee"],
  sell: ["shares", "price", "fee"],
  dividend: ["amount"],
  split: ["ratio"],
  opening: ["shares", "price"],
};

export interface TradeForm {
  type: TradeType; symbol: string; name: string; date: string;
  shares: string; price: string; fee: string; amount: string; ratio: string; note: string;
}
export const emptyTradeForm = (type: TradeType = "buy"): TradeForm =>
  ({ type, symbol: "", name: "", date: "", shares: "", price: "", fee: "", amount: "", ratio: "", note: "" });

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isRealDay = (s: string) => {
  if (!DAY.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};
/** 空串 = 没填(null);填了但不是数 = NaN(报错),不当 0 */
const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s.trim()));

/** 表单 → 台账记录。只放这一类要的字段;不对返回原因(与后端重放的检查同口径,后端照样再查) */
export function tradeRecord(f: TradeForm): { record: Record<string, unknown> } | { error: string } {
  const symbol = normalizeMarketSymbol(f.symbol);
  if (!symbol) return { error: "请输入 A 股、港股或美股代码" };
  // 与后端重放同一句话：B 股按美元、港元计价，当人民币算会混进合计（第四轮审计 C1）
  if (/^(?:900|200)\d{3}$/.test(symbol)) return { error: "B 股(900、200 开头)暂不支持:按美元、港元计价,并进人民币合计会算错" };
  if (!isRealDay(f.date)) return { error: "请填写有效日期,格式 YYYY-MM-DD,或用旁边的日历选择" };
  const v = { shares: numOrNull(f.shares), price: numOrNull(f.price), fee: numOrNull(f.fee), amount: numOrNull(f.amount), ratio: numOrNull(f.ratio) };
  const label = TRADE_TYPE_LABELS[f.type];
  const pos = (x: number | null) => x !== null && Number.isFinite(x) && x > 0;
  switch (f.type) {
    case "buy":
    case "sell":
      if (!pos(v.shares)) return { error: `${label}数量要大于 0` };
      if (!pos(v.price)) return { error: `${label}成交价要大于 0` };
      if (v.fee !== null && !(Number.isFinite(v.fee) && v.fee >= 0)) return { error: "费用不能是负数(没有就留空)" };
      break;
    case "opening":
      if (!pos(v.shares)) return { error: "期初持仓数量要大于 0" };
      if (v.price === null || !Number.isFinite(v.price)) return { error: "期初持仓要写每股成本(可以是负数)" };
      break;
    case "dividend":
      if (!pos(v.amount)) return { error: "现金分红要写大于 0 的到账金额" };
      break;
    case "split":
      if (!pos(v.ratio)) return { error: "送转拆股要写大于 0 的比例:每 1 股变成几股,如 10 转 5 写 1.5" };
      break;
  }
  const record: Record<string, unknown> = { symbol, type: f.type, date: f.date };
  for (const k of FIELDS_OF[f.type]) if (v[k] !== null) record[k] = v[k];
  if (f.name.trim()) record.name = f.name.trim().slice(0, 40);
  if (f.note.trim()) record.note = f.note.trim().slice(0, 1000);
  return { record };
}

/** 流水一行的数字说明(列表用) */
export function tradeDetail(t: Trade): string {
  switch (t.type) {
    case "buy": case "sell": return `${t.shares ?? "?"} 股 × ${t.price ?? "?"}${t.fee ? `,费用 ${t.fee}` : ""}`;
    case "opening": return `${t.shares ?? "?"} 股,每股成本 ${t.price ?? "?"}`;
    case "dividend": return `到账 ${t.amount ?? "?"}`;
    case "split": return `每 1 股变 ${t.ratio ?? "?"} 股`;
    default: return "";
  }
}

export interface FxRates { USD: number | null; HKD: number | null; date: string | null; fetched_at: string | null }

/** 从 fx_rates 信封取「1 美元 / 1 港元 = 多少人民币」 */
export function fxFromEnvelope(e: Envelope | null, fetchedAt: string | null = null): FxRates {
  const ev = (e?.evidence ?? []) as { field?: string; value?: unknown; period?: string }[];
  const pick = (field: string) => {
    const hit = ev.find((x) => x.field === field);
    return hit && typeof hit.value === "number" && Number.isFinite(hit.value) && hit.value > 0 ? hit : null;
  };
  const usd = pick("fx_usd_cny"), hkd = pick("fx_hkd_cny");
  return { USD: usd ? (usd.value as number) : null, HKD: hkd ? (hkd.value as number) : null, date: usd?.period ?? hkd?.period ?? null, fetched_at: fetchedAt };
}

export interface CnyTotal { market_value: number; cost: number; pnl: number; pnl_pct: number | null }

/** 人民币合计:每个币种都有汇率才给;缺哪个就返回缺哪个 */
export function cnyTotal(totals: readonly { currency: CurrencyCode; market_value: number; cost: number }[], fx: FxRates): CnyTotal | { missing: CurrencyCode[] } {
  const rate = (c: CurrencyCode) => (c === "CNY" ? 1 : c === "USD" ? fx.USD : c === "HKD" ? fx.HKD : null);
  const missing = totals.map((t) => t.currency).filter((c) => rate(c) === null);
  if (missing.length) return { missing: [...new Set(missing)] };
  const mv = totals.reduce((a, t) => a + t.market_value * rate(t.currency)!, 0);
  const cost = totals.reduce((a, t) => a + t.cost * rate(t.currency)!, 0);
  return { market_value: mv, cost, pnl: mv - cost, pnl_pct: cost > 0 ? ((mv - cost) / cost) * 100 : null };
}
