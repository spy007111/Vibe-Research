/**
 * 候选池的界面数据(后端见 orchestrator/src/finance/candidates.ts)。
 * 只排除、不排名:每只、每个条件写明满足 / 不满足 / 缺数据,结果按代码排。
 */
export type CheckState = "met" | "unmet" | "missing";

export interface CandidateCheck { id: string; state: CheckState; value: number | null; shown: string }
export interface CandidateRow { symbol: string; name: string; verdict: CheckState; checks: CandidateCheck[] }
export interface CandidateCondition { id: string; label: string; source: string }
export interface CandidateResult {
  universe: { id: string; label: string; size: number; as_of: string | null; source: string };
  quotes: { source: string; fetched_at: string | null; cached: boolean };
  conditions: CandidateCondition[];
  rows: CandidateRow[];
  counts: Record<CheckState, number>;
  generated_at: string;
  gaps: string[];
}

/** 和后端 UNIVERSES 同序同名(后端测试逐项核对) */
export const UNIVERSES = [
  { id: "watch", label: "我的自选" },
  { id: "position", label: "我的持仓" },
  { id: "hs300", label: "沪深300" },
  { id: "a500", label: "中证A500" },
  { id: "zz500", label: "中证500" },
  { id: "zz1000", label: "中证1000" },
  { id: "zz2000", label: "中证2000" },
  { id: "sz50", label: "上证50" },
  { id: "kc50", label: "科创50" },
  { id: "cyb", label: "创业板指" },
] as const;
export type UniverseId = (typeof UNIVERSES)[number]["id"];

/** 和后端 METRICS 同序同名同单位(后端测试逐项核对) */
export const METRICS = [
  { id: "pe_ttm", label: "市盈率(TTM)", unit: "倍", hint: "亏损的市盈率是负数" },
  { id: "pb", label: "市净率", unit: "倍", hint: "" },
  { id: "market_cap", label: "总市值", unit: "亿元", hint: "" },
  { id: "amount", label: "成交额", unit: "亿元", hint: "当天的,盘中会变" },
  { id: "turnover", label: "换手率", unit: "%", hint: "当天的,盘中会变" },
] as const;
export type MetricId = (typeof METRICS)[number]["id"];

export interface CandidateForm {
  universe: UniverseId;
  ranges: Record<MetricId, { min: string; max: string }>;
  excludeSt: boolean;
  excludeHalted: boolean;
}

const emptyRanges = (): CandidateForm["ranges"] =>
  Object.fromEntries(METRICS.map((m) => [m.id, { min: "", max: "" }])) as CandidateForm["ranges"];

export const defaultForm = (): CandidateForm => ({ universe: "watch", ranges: emptyRanges(), excludeSt: true, excludeHalted: false });

/** 本机记住的条件:读不出、字段不对都退回默认,不让坏数据把页面弄崩 */
export function parseStoredForm(raw: string | null): CandidateForm {
  const out = defaultForm();
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Partial<{ universe: unknown; ranges: Record<string, { min?: unknown; max?: unknown }>; excludeSt: unknown; excludeHalted: unknown }>;
    if (UNIVERSES.some((u) => u.id === v.universe)) out.universe = v.universe as UniverseId;
    for (const m of METRICS) {
      const r = v.ranges?.[m.id];
      if (r && typeof r === "object") out.ranges[m.id] = { min: typeof r.min === "string" ? r.min.slice(0, 20) : "", max: typeof r.max === "string" ? r.max.slice(0, 20) : "" };
    }
    if (typeof v.excludeSt === "boolean") out.excludeSt = v.excludeSt;
    if (typeof v.excludeHalted === "boolean") out.excludeHalted = v.excludeHalted;
  } catch { /* 坏的就用默认 */ }
  return out;
}

const LIMIT = 1e9;

/** 提交前核一遍(后端也会核);返回空串表示可以提交 */
export function formError(f: CandidateForm): string {
  let any = f.excludeSt || f.excludeHalted;
  for (const m of METRICS) {
    const r = f.ranges[m.id];
    const nums: (number | null)[] = [];
    for (const [raw, what] of [[r.min, "下限"], [r.max, "上限"]] as const) {
      if (raw.trim() === "") { nums.push(null); continue; }
      const v = Number(raw.trim());
      if (!Number.isFinite(v) || Math.abs(v) > LIMIT) return `${m.label}${what}不是合法数字`;
      nums.push(v);
    }
    const [min, max] = nums;
    if (min !== null && max !== null && min! > max!) return `${m.label}的下限大于上限`;
    if (min !== null || max !== null) any = true;
  }
  return any ? "" : "至少设一个条件";
}

/** 表单 → 查询串(空的不带) */
export function candidateQuery(f: CandidateForm, refresh = false): string {
  const q = new URLSearchParams();
  q.set("universe", f.universe);
  for (const m of METRICS) {
    const r = f.ranges[m.id];
    if (r.min.trim()) q.set(`${m.id}_min`, r.min.trim());
    if (r.max.trim()) q.set(`${m.id}_max`, r.max.trim());
  }
  if (f.excludeSt) q.set("exclude_st", "1");
  if (f.excludeHalted) q.set("exclude_halted", "1");
  if (refresh) q.set("refresh", "1");
  return q.toString();
}

/** 三组的顺序:先看过了全部条件的,再看缺数据的,不满足的放最后 */
export const VERDICT_TABS: { key: CheckState; label: string }[] = [
  { key: "met", label: "全部满足" },
  { key: "missing", label: "有缺数据" },
  { key: "unmet", label: "有不满足" },
];

/** 状态的样式。不用红绿:红绿在这里表示涨跌,条件满足与否不带涨跌含义 */
export const STATE_META: Record<CheckState, { label: string; tone: string }> = {
  met: { label: "满足", tone: "border-primary/40 text-primary" },
  unmet: { label: "不满足", tone: "border-border text-muted-foreground" },
  missing: { label: "缺数据", tone: "border-warning/50 text-warning" },
};

export const rowsOfTab = (rows: CandidateRow[], tab: CheckState) => rows.filter((r) => r.verdict === tab);

export const PAGE_SIZE = 200;
