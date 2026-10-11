/**
 * 判据到期回看的界面数据(后端见 orchestrator/src/finance/verdicts.ts)。
 * 只记用户写下的判据兑现没有,不算涨跌、不算胜率。
 */
import type { LedgerRecord } from "./backend.ts";

export type CriterionType = "decision_point" | "falsifier";
export type CriterionStatus = "pending" | "met" | "broken" | "dropped";
export type Verdict = Exclude<CriterionStatus, "pending">;

export interface VerdictItem {
  id: string;
  symbol: string | null;
  name: string;
  type: CriterionType;
  statement: string;
  due: string;
  since: string;
  overdue_days: number;
  thesis: string;
  facts: { date: string; title: string }[];
  /** 这段时间看到的公告总数(界面只列最近 15 条) */
  facts_total: number;
  facts_source: string;
  /** 公告是什么时候取的;没取到 / 没查 = null */
  facts_fetched_at: string | null;
  facts_note: string;
  record: LedgerRecord;
}

export interface CalibrationRow {
  type: CriterionType;
  label: string;
  met_label: string;
  broken_label: string;
  met: number;
  broken: number;
  dropped: number;
  due_unjudged: number;
  upcoming: number;
  no_due: number;
}

export interface JudgedItem {
  id: string;
  symbol: string | null;
  name: string;
  type: CriterionType;
  statement: string;
  due: string;
  status: Verdict;
  judged_at: string;
  verdict_note: string;
  record: LedgerRecord;
}

export interface VerdictResult {
  today: string;
  generated_at: string;
  due: VerdictItem[];
  calibration: CalibrationRow[];
  judged: JudgedItem[];
  gaps: string[];
}

/** 同一个状态值,按类型读法不同:证伪条件「broken」是触发了 */
export const TYPE_LABEL: Record<CriterionType, { label: string; met: string; broken: string }> = {
  decision_point: { label: "裁决点", met: "兑现", broken: "没兑现" },
  falsifier: { label: "证伪条件", met: "到期没触发", broken: "触发了" },
};

export function verdictLabel(type: unknown, status: unknown): string {
  const t: CriterionType = type === "falsifier" ? "falsifier" : "decision_point";
  if (status === "met") return TYPE_LABEL[t].met;
  if (status === "broken") return TYPE_LABEL[t].broken;
  if (status === "dropped") return "不再跟踪";
  return "待判";
}

export const THESIS_STATUS_LABEL: Record<string, string> = { active: "进行中", paused: "暂停", closed: "已结束" };

/** 判定后要存回台账的整条记录(台账更新是整条替换,所以从原记录拷一份再改) */
export function judgedRecord(record: LedgerRecord, status: Verdict, note: string, today: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...record, status, judged_at: today };
  const n = note.trim();
  if (n) next.verdict_note = n; else delete next.verdict_note;
  return next;
}

/** 改回待判:清掉判定日和判定说明 */
export function reopenedRecord(record: LedgerRecord): Record<string, unknown> {
  const next: Record<string, unknown> = { ...record, status: "pending" };
  delete next.judged_at;
  delete next.verdict_note;
  return next;
}
