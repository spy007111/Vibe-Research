/**
 * 找标的：解析「找标的」工具（backtest.symbol_search）的输出，以及批量粘贴时哪些词要去搜、哪些直接当代码。
 *
 * 🔴 代码规范形与 lib/marketSymbol.ts 一致：600519 / 00700.HK / AAPL。
 * 🔴 纯字母既可能是美股代码也可能是拼音（gzmt），一律先搜，搜到代码一致的才当美股代码。
 * 🔴 北交所老代码（43/83/87 开头）已经停用但行情源不报错（会返回僵尸报价），也要先搜，让它换成 920 号段。
 */
import { classDot, normalizeMarketSymbol, type MarketCode } from "./marketSymbol.ts";

type Obj = Record<string, unknown>;

export interface SymbolMatch {
  symbol: string; name: string; market: MarketCode; kind: string; board: string; pinyin: string;
}
export interface BatchItem {
  query: string; code: string | null; matches: SymbolMatch[]; pick: SymbolMatch | null; reason: string;
}

const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const MARKETS: MarketCode[] = ["CN", "HK", "US"];

function matchOf(v: unknown): SymbolMatch | null {
  if (!obj(v)) return null;
  const symbol = normalizeMarketSymbol(v.symbol);
  const market = MARKETS.find((m) => m === v.market);
  // 工具给的代码必须本来就是规范形，否则宁可不显示，免得点了之后存进台账的是另一种写法
  if (!symbol || symbol !== v.symbol || !market) return null;
  return { symbol, name: str(v.name), market, kind: str(v.kind), board: str(v.board), pinyin: str(v.pinyin) };
}
const matchesOf = (v: unknown) => (Array.isArray(v) ? v.map(matchOf).filter((m): m is SymbolMatch => m !== null) : []);

export type SearchReply = { ok: true; matches: SymbolMatch[] } | { ok: false; error: string };

/** 一组候选连同它是哪个词搜出来的 */
export interface SearchResult { query: string; matches: SymbolMatch[] }
export const searchKey = (text: string) => text.trim().toLowerCase();
/**
 * 只认当前输入搜出来的候选。输入一变，上一个词的候选立刻作废 ——
 * 否则在防抖和请求返回之前按回车，会选中（自选页还会直接存进）上一个词的结果。
 */
export const liveMatches = (r: SearchResult | null, text: string): SymbolMatch[] =>
  r && r.query === searchKey(text) ? r.matches : [];
export type BatchReply = { ok: true; items: BatchItem[] } | { ok: false; error: string };

export function parseSearch(toolResult: unknown): SearchReply {
  if (!obj(toolResult)) return { ok: false, error: "搜索没有返回结果" };
  if (toolResult.ok !== true) return { ok: false, error: str(toolResult.error) || "搜索没有说明原因" };
  const r = toolResult.result;
  if (!obj(r) || !Array.isArray(r.matches)) return { ok: false, error: "搜索的返回里没有候选" };
  return { ok: true, matches: matchesOf(r.matches) };
}

export function parseBatch(toolResult: unknown): BatchReply {
  if (!obj(toolResult)) return { ok: false, error: "搜索没有返回结果" };
  if (toolResult.ok !== true) return { ok: false, error: str(toolResult.error) || "搜索没有说明原因" };
  const r = toolResult.result;
  if (!obj(r) || !Array.isArray(r.items)) return { ok: false, error: "搜索的返回里没有结果" };
  return {
    ok: true,
    items: r.items.filter(obj).map((it) => ({
      query: str(it.query),
      code: typeof it.code === "string" ? it.code : null,
      matches: matchesOf(it.matches),
      pick: matchOf(it.pick),
      reason: str(it.reason),
    })),
  };
}

/** 批量粘贴的分隔符和 parseMarketSymbols 一致：逗号 / 空格 / 换行 / 顿号 / 分号。 */
export function splitTokens(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(/[\s,，、;；]+/)) if (t && !out.includes(t)) out.push(t);
  return out;
}

/**
 * 一个词能不能不搜、直接当代码：数字代码、带交易所前后缀的写法、带股份类别的美股代码（BRK.B）。
 * 纯字母（可能是拼音）、中文名、北交所老代码要先搜。
 * 小写 us 接大写代码（usAAPL）是行情源的前缀写法，不会是拼音，直接认。
 */
export function directCode(token: string): string | null {
  const t = token.trim();
  if (/^(?:bj)?[48]\d{5}$/i.test(t) || /^[48]\d{5}\.bj$/i.test(t)) return null;
  const looksLikeCode = /\d/.test(t) || /^us[:.]/i.test(t) || /^us[A-Z]/.test(t) || /^[a-z]+[.-][a-z0-9]{1,4}$/i.test(t);
  return looksLikeCode ? classDot(normalizeMarketSymbol(t)) : null;
}

export const MARKET_TAG: Record<MarketCode, string> = { CN: "A 股", HK: "港股", US: "美股" };

/** 候选右侧的小标签：A 股写板块（沪A / 科创板…），场内基金单列，港美股写市场。 */
export const matchTag = (m: SymbolMatch) => (m.board === "基金" ? "场内基金" : m.market === "CN" ? m.board : MARKET_TAG[m.market]);

/** 与 backtest.symbol_search 的 MAX_BATCH / MAX_QUERY_LEN 一致 */
export const BATCH_SEARCH_MAX = 30;
export const QUERY_MAX_LEN = 30;

/**
 * 批量粘贴分几路：能直接当代码的本地加（direct），其余去搜（search，最多 30 个），
 * 超出的退回输入框（rest），太长的不像代码也不像名称、直接跳过（skipped）。
 */
export function planBatch(raw: string): { direct: string[]; search: string[]; rest: string[]; skipped: string[] } {
  const direct: string[] = [], search: string[] = [], rest: string[] = [], skipped: string[] = [];
  for (const t of splitTokens(raw)) {
    const c = directCode(t);
    if (c) { if (!direct.includes(c)) direct.push(c); }
    else if (t.length > QUERY_MAX_LEN) skipped.push(t);
    else if (search.length < BATCH_SEARCH_MAX) search.push(t);
    else rest.push(t);
  }
  return { direct, search, rest, skipped };
}

/** 搜索不通时的退路：每个词都交给用户确认，长得像代码的给一个「按代码加」。 */
export function offlineItems(tokens: string[], reason: string): BatchItem[] {
  return tokens.map((q) => ({ query: q, code: normalizeMarketSymbol(q), matches: [], pick: null, reason }));
}

/**
 * 什么时候给「按代码 X 加」：只在一个候选都没搜到时。
 * 搜到了候选却没有代码一致的，说明这串字母多半是拼音（ndsd），再给「按美股代码 NDSD」只会误导。
 */
export const codeFallback = (it: BatchItem) => (it.matches.length === 0 && it.code ? it.code : null);

const ROUTINE = new Set(["代码一致", "名称一致", "拼音一致", "只有一个候选"]);

/** 汇总一次批量：要加的代码、给用户看的识别结果、还要用户点选的条目。 */
export function collectPicks(direct: string[], items: BatchItem[]): { picks: string[]; notes: string[]; pending: BatchItem[] } {
  const picks = [...direct];
  const notes: string[] = [];
  const pending: BatchItem[] = [];
  for (const it of items) {
    if (!it.pick) { pending.push(it); continue; }
    if (!picks.includes(it.pick.symbol)) picks.push(it.pick.symbol);
    if (it.query === it.pick.symbol) continue;
    const why = ROUTINE.has(it.reason) ? "" : `（${it.reason.startsWith("代码已变更") ? "代码已变更" : it.reason}）`;
    notes.push(`${it.query} → ${it.pick.name ? `${it.pick.name} ` : ""}${it.pick.symbol}${why}`);
  }
  return { picks, notes, pending };
}
