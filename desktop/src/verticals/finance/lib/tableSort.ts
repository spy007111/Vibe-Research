/**
 * 表格排序（自选、持仓共用）：点表头排序，持仓另可自己排先后。都只记在本机浏览器里。
 *
 * 🔴 取不到的值（null、NaN、空串）不论升序降序都排最后：排在最前会把「没取到」看成最大或最小。
 * 🔴 稳定排序：值一样的按原来的先后，不来回跳。
 * 🔴 金额、价格这类带币种的列不跨币种比大小（100 美元和 100 元不是一回事）：传 group，先按币种分块，块内再排。
 */
import { storageGet, storageSet } from "./storage.ts";

export type SortDir = "asc" | "desc";
export interface SortState { key: string; dir: SortDir }
export type SortValue = number | string | null | undefined;

/** 点表头：第一下按 firstDir（数字列默认从大到小，文字列从小到大）→ 第二下反过来 → 第三下恢复原来的顺序 */
export function nextSort(cur: SortState | null, key: string, firstDir: SortDir = "desc"): SortState | null {
  if (!cur || cur.key !== key) return { key, dir: firstDir };
  if (cur.dir === firstDir) return { key, dir: firstDir === "desc" ? "asc" : "desc" };
  return null;
}

const missing = (v: SortValue) => v == null || v === "" || (typeof v === "number" && !Number.isFinite(v));

/** group：这一列要先分块时返回块的先后（如币种），不用分块的列返回 null */
export function sortRows<T>(
  rows: readonly T[], sort: SortState | null, value: (row: T, key: string) => SortValue,
  group?: (row: T, key: string) => number | null,
): T[] {
  if (!sort) return [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: value(row, sort.key), g: group?.(row, sort.key) ?? null }))
    .sort((a, b) => {
      if (a.g !== null && b.g !== null && a.g !== b.g) return a.g - b.g;
      const am = missing(a.v), bm = missing(b.v);
      if (am || bm) return am && bm ? a.i - b.i : am ? 1 : -1;
      const c = typeof a.v === "number" && typeof b.v === "number"
        ? a.v - b.v
        : String(a.v).localeCompare(String(b.v), "zh-CN");
      return c ? c * sign : a.i - b.i;
    })
    .map((x) => x.row);
}

/**
 * 隐私模式下被遮住的列不按它排：金额是 ••••，行的先后却能看出哪只仓位最重、亏得最多。
 * 记着的排序先不用、不删，关掉隐私模式又回来。
 */
export function visibleSort(sort: SortState | null, hidden: boolean, masked: (key: string) => boolean): SortState | null {
  return hidden && sort && masked(sort.key) ? null : sort;
}

/** 币种分块的先后：人民币、港元、美元，别的排后面 */
export const currencyRank = (currency: string | null | undefined): number => {
  const i = ["CNY", "HKD", "USD"].indexOf(currency ?? "");
  return i < 0 ? 3 : i;
};

/** 读回上次的排序；存的列现在没有了（改过表头）或格式不对，就当没排 */
export function loadSort(storageKey: string, keys: readonly string[]): SortState | null {
  try {
    const v = JSON.parse(storageGet(storageKey) ?? "null") as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const { key, dir } = v as Record<string, unknown>;
      if (typeof key === "string" && keys.includes(key) && (dir === "asc" || dir === "desc")) return { key, dir };
    }
  } catch { /* 坏数据当没排 */ }
  return null;
}

export function saveSort(storageKey: string, sort: SortState | null): void {
  storageSet(storageKey, JSON.stringify(sort));
}

/** 自己排的先后：按 order 排；order 里没有的（新买的、新加的）按原来的先后跟在最后 */
export function applyOrder<T>(rows: readonly T[], order: readonly string[], id: (row: T) => string): T[] {
  const rank = new Map(order.map((c, i) => [c, i]));
  return rows
    .map((row, i) => ({ row, i, r: rank.get(id(row)) }))
    .sort((a, b) => (a.r ?? Infinity) - (b.r ?? Infinity) || a.i - b.i)
    .map((x) => x.row);
}

/** 把 code 在当前显示的先后里往前（-1）或往后（+1）挪一位，返回新的先后；到头了不动 */
export function moveInOrder(current: readonly string[], code: string, delta: -1 | 1): string[] {
  const i = current.indexOf(code);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= current.length) return [...current];
  const next = [...current];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function loadOrder(storageKey: string): string[] {
  try {
    const v = JSON.parse(storageGet(storageKey) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveOrder(storageKey: string, order: readonly string[]): void {
  storageSet(storageKey, JSON.stringify(order));
}

/**
 * 按金额这类被遮的列排完再点「调整顺序」，记下的先后就是金额高低（fromMasked）。
 * 隐私模式下这份先后先不用、不删，关掉隐私模式又回来；masked = 当前显示的先后是否还带着它，
 * 在这个基础上再挪、再转存，记下的先后照样算「从被遮的列来」（第四轮审计 C4）。
 */
const NO_ORDER: string[] = [];
export function visibleOrder(order: string[], fromMasked: boolean, hidden: boolean): { order: string[]; masked: boolean } {
  return hidden && fromMasked ? { order: NO_ORDER, masked: false } : { order, masked: fromMasked };
}
