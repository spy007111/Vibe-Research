/**
 * 异动接近度的界面数据(后端见 orchestrator/src/finance/abnormal.ts)。
 * 自选里的 A 股离交易所「异常波动 / 严重异常波动」标准还有多远 —— 按公开规则推算,不判断方向、不预测。
 */
export type Board = "sh_main" | "star" | "sz_main" | "chinext" | "bse";
export type Dir = "up" | "down";

export interface Crit {
  days: number;
  /** 所有可算区间里最大的向上 / 最大的向下累计偏离(%);没有就是 null */
  up: number | null;
  down: number | null;
  /** [向上标准, 向下标准] */
  limit: [number, number];
  reached: Dir | null;
}

export interface Trigger { date: string; kind: "abnormal" | "severe"; dir: Dir; why: string }

export interface Proximity {
  as_of: string;
  since: string;
  abnormal: Crit;
  severe10: Crit;
  severe30: Crit;
  same_dir: { up: number; down: number; need: number };
  recent: Trigger[];
  level: number;
  notes: string[];
}

export interface AbnormalRow {
  symbol: string;
  name: string;
  board: Board;
  board_label: string;
  index_label: string;
  result: Proximity | null;
  skipped: string | null;
}

export interface AbnormalRule { board: Board; label: string; index: string; abn: number; count: number; sev10: [number, number]; sev30: [number, number] }

export interface AbnormalResult {
  rows: AbnormalRow[];
  rules: AbnormalRule[];
  as_of: string | null;
  intraday: boolean;
  fetched_at: string | null;
  cached: boolean;
  generated_at: string;
  gaps: string[];
  source: string;
}

/** 达到七成算「较近」(和收盘后提醒里附的那段同一条线) */
export const NEAR = 0.7;
/** 不到一半的默认收起 */
export const FOLD_BELOW = 0.5;

const num = (v: number) => `${v > 0 ? "+" : ""}${Number(v.toFixed(2))}%`;

/** 「+12.3% / -2.1%」;两边都没有(区间里每天都和指数一样)写 0% */
export const showPair = (c: Crit) => [c.up !== null ? num(c.up) : "", c.down !== null ? num(c.down) : ""].filter(Boolean).join(" / ") || "0%";

export const limitText = (c: Crit) => (c.limit[0] === -c.limit[1] ? `±${c.limit[0]}%` : `${num(c.limit[0])} / ${c.limit[1]}%`);

/** 0–1+:累计偏离 ÷ 标准,向上向下取更近的那边 */
export const critRatio = (c: Crit) => Math.max(c.up !== null ? c.up / c.limit[0] : 0, c.down !== null ? c.down / c.limit[1] : 0);

/** 「已达到」前面写哪天:只有盘中、且是最新那天才说「今天」;停牌的写它自己的最后一个交易日 */
export const reachedWhen = (p: Proximity, res: Pick<AbnormalResult, "as_of" | "intraday">) => (p.as_of === res.as_of && res.intraday ? "今天" : p.as_of);
export const levelText = (level: number) => (level >= 1 ? "已达到" : `${Math.floor(level * 100)}%`);

/** 不用红绿(A 股红涨绿跌,红绿会被读成涨跌):达到 / 较近用提示色,其余灰 */
export const levelTone = (level: number) =>
  level >= 1 ? "border-warning/60 bg-warning/10 text-warning" : level >= NEAR ? "border-warning/40 text-warning" : "border-border text-muted-foreground";

export const TRIGGER_LABEL: Record<Trigger["kind"], string> = { abnormal: "异常波动", severe: "严重异常波动" };
export const DIR_LABEL: Record<Dir, string> = { up: "向上", down: "向下" };

/** 算出来的按接近度从高到低;不到一半的另放(默认收起);没算出来的单列 */
export function splitRows(rows: AbnormalRow[]): { shown: AbnormalRow[]; folded: AbnormalRow[]; skipped: AbnormalRow[] } {
  const done = rows.filter((r) => r.result).sort((a, b) => b.result!.level - a.result!.level);
  return {
    shown: done.filter((r) => r.result!.level >= FOLD_BELOW),
    folded: done.filter((r) => r.result!.level < FOLD_BELOW),
    skipped: rows.filter((r) => !r.result),
  };
}

export function ruleLine(r: AbnormalRule): string {
  return `${r.label}(基准 ${r.index}):3 日 ±${r.abn}%;10 日内第 ${r.count} 次同向异常波动、10 日 ${num(r.sev10[0])} / ${r.sev10[1]}%、30 日 ${num(r.sev30[0])} / ${r.sev30[1]}% 为严重异常波动`;
}

const label = (r: AbnormalRow) => (r.name ? `${r.name} ${r.symbol}` : r.symbol);

/** 给页面上的「问 Agent」:每只的三条标准、推算达到过的、没算的,原样交代口径 */
export function abnormalContext(res: AbnormalResult | null): string {
  if (!res) return "";
  if (!res.rows.length && !res.gaps.length) return "";
  const lines = [
    `异动接近度(离交易所异常波动标准多远;按 ${res.source} 推算,以交易所公告为准,不判断方向)${res.as_of ? `,截至 ${res.as_of}${res.intraday ? " 盘中按最新价估算" : " 收盘"}` : ""}:`,
  ];
  for (const r of res.rows) {
    const p = r.result;
    if (!p) { lines.push(`${label(r)}:没算(${r.skipped ?? "原因不明"})`); continue; }
    const when = reachedWhen(p, res);
    const crit = (c: Crit) => `${c.days} 日 ${showPair(c)}(标准 ${limitText(c)}${c.reached ? `,${when === "今天" ? when : `${when} `}已达到` : ""})`;
    lines.push(`${label(r)}(${r.board_label},基准 ${r.index_label}):${crit(p.abnormal)};${crit(p.severe10)};${crit(p.severe30)};10 日内同向异常波动 向上 ${p.same_dir.up} 次 / 向下 ${p.same_dir.down} 次(第 ${p.same_dir.need} 次构成严重异常波动)`);
    for (const t of p.recent) lines.push(`  ${t.date} 按规则推算达到${TRIGGER_LABEL[t.kind]}(${DIR_LABEL[t.dir]}):${t.why}`);
    for (const n of p.notes) lines.push(`  注:${n}`);
  }
  if (res.gaps.length) lines.push(`没算的:${res.gaps.join(";")}`);
  return lines.join("\n");
}
