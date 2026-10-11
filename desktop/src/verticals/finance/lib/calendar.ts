/**
 * 事件日历的界面数据(后端见 orchestrator/src/finance/events.ts)。
 * 只列来源给的日期和事实;取不到的在 gaps 里,不当成"没有事件"。
 */
export type EventKind = "disclosure" | "lockup" | "dividend" | "earnings" | "macro" | "criterion" | "review" | "action";

export interface CalendarEvent {
  date: string;
  kind: EventKind;
  symbol: string | null;
  name: string;
  title: string;
  detail: string[];
  source: string;
  fetched_at: string | null;
  estimated?: boolean;
  ref?: string;
}

export interface CalendarResult {
  window: { from: string; to: string; days: number };
  generated_at: string;
  symbols: { symbol: string; name: string; origin: ("自选" | "持有")[] }[];
  events: CalendarEvent[];
  overdue: CalendarEvent[];
  gaps: string[];
}

export type EventGroup = "company" | "ledger" | "macro";

export const KIND_META: Record<EventKind, { label: string; group: EventGroup; tone: string }> = {
  disclosure: { label: "定期报告", group: "company", tone: "border-sky-500/40 text-sky-600 dark:text-sky-300" },
  earnings: { label: "财报日", group: "company", tone: "border-sky-500/40 text-sky-600 dark:text-sky-300" },
  dividend: { label: "除权除息", group: "company", tone: "border-violet-500/40 text-violet-600 dark:text-violet-300" },
  lockup: { label: "解禁", group: "company", tone: "border-amber-500/50 text-amber-700 dark:text-amber-300" },
  criterion: { label: "我的判据", group: "ledger", tone: "border-primary/50 text-primary" },
  review: { label: "我的论点", group: "ledger", tone: "border-primary/50 text-primary" },
  action: { label: "我的待办", group: "ledger", tone: "border-primary/50 text-primary" },
  macro: { label: "宏观", group: "macro", tone: "border-border text-muted-foreground" },
};

export const GROUP_LABEL: Record<EventGroup, string> = { company: "公司事件", ledger: "我的台账", macro: "宏观" };

/** 按日期分组,保持后端排好的顺序 */
export function groupByDate(events: CalendarEvent[]): { date: string; items: CalendarEvent[] }[] {
  const out: { date: string; items: CalendarEvent[] }[] = [];
  for (const e of events) {
    const last = out.at(-1);
    if (last && last.date === e.date) last.items.push(e);
    else out.push({ date: e.date, items: [e] });
  }
  return out;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「10月12日 周一 · 4 天后」。today 是后端给的窗口起点(北京时间日期),不拿浏览器时区猜 */
export function dayLabel(date: string, today: string): { main: string; rel: string } {
  const d = new Date(`${date}T00:00:00Z`);
  const t = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(t.getTime())) return { main: date, rel: "" };
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  const rel = diff === 0 ? "今天" : diff === 1 ? "明天" : diff > 1 ? `${diff} 天后` : `${-diff} 天前`;
  return { main: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]}`, rel };
}
