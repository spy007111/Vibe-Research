/**
 * 事件回看：解析事件回看工具（backtest.event_study）的输出、生成平均路径图配置和给 AI 的页面上下文。
 *
 * 🔴 每个数都直接取自工具，这里不重算；工具说「不给平均」（次数不够）就显示不给，不在前端补算。
 * 🔴 只描述这只股票过去每次事件前后的涨跌：不预测、不给买卖提示。
 */
import type { ChartPalette } from "./backtestView.ts";
import type { MarketCode } from "./marketSymbol.ts";
import { pctSigned } from "./perfView.ts";

type Obj = Record<string, unknown>;
type Num = number | null;

export type EventKind = "earnings_forecast" | "holder_increase" | "holder_decrease" | "buyback" | "survey" | "dragon_tiger" | "lockup"
  | "earnings_release";
/** 每类事件只在有来源的市场出现，和工具的 KINDS 对齐：A 股七类，港美股只有业绩公布。dateLabel 是逐次表里那一列日期叫什么 */
export const EVENT_KINDS: { key: EventKind; label: string; markets: MarketCode[]; dateLabel: string }[] = [
  { key: "earnings_forecast", label: "业绩预告", markets: ["CN"], dateLabel: "公告日" },
  { key: "holder_increase", label: "重要股东增持", markets: ["CN"], dateLabel: "公告日" },
  { key: "holder_decrease", label: "重要股东减持", markets: ["CN"], dateLabel: "公告日" },
  { key: "buyback", label: "回购方案", markets: ["CN"], dateLabel: "首次公告日" },
  { key: "survey", label: "机构调研", markets: ["CN"], dateLabel: "公告日" },
  { key: "dragon_tiger", label: "龙虎榜", markets: ["CN"], dateLabel: "上榜日" },
  { key: "lockup", label: "限售解禁", markets: ["CN"], dateLabel: "解禁日" },
  { key: "earnings_release", label: "业绩公布", markets: ["HK", "US"], dateLabel: "发布日" },
];
export const eventKindsFor = (m: MarketCode | null) => EVENT_KINDS.filter((k) => m !== null && k.markets.includes(m));
export const eventDateLabel = (kind: string) => EVENT_KINDS.find((k) => k.key === kind)?.dateLabel ?? "日期";

/** 卡片上说相对谁比（工具结果里也会带 benchmark_label，没跑之前先用这个） */
export const EVENT_BENCHMARK: Record<MarketCode, string> = { CN: "沪深300", HK: "盈富基金（跟踪恒生指数）", US: "标普500 ETF（SPY）" };

export interface EventHorizon { key: string; from: number; to: number; label: string }
export interface EventRow {
  date: string; day0: string; label: string; detail: string;
  /** 分组用：业绩预告 up / down，龙虎榜 buy / sell，限售解禁 large / small，归不了组的 other；别的类型没有 */
  direction: string | null;
  values: Record<string, Num>;
  haltedDays: number;
  /** 第 0 天之后已经有几个交易日（最近的事件还没满窗口） */
  daysAfter: number;
  overlapsPrev: boolean;
}
export interface HorizonStats { n: number; mean: Num; median: Num; positiveShare: Num }
export interface EventGroup { key: string; label: string; events: number; horizons: Record<string, HorizonStats>; note: string | null }
export interface EventGap { date: string | null; label: string; reason: string }
export interface EventPath { offsets: number[]; n: number; mean: Num[]; median: Num[] }
/** 已经排期、还没到的事件（目前只有限售解禁）：只列出来，不算涨跌 */
export interface EventUpcoming { date: string; label: string; detail: string }
export interface EventView {
  symbol: string; market: string; kind: string; kindLabel: string; benchmarkLabel: string;
  pre: number; post: number; minEvents: number;
  horizons: EventHorizon[]; events: EventRow[]; gaps: EventGap[]; summary: EventGroup[];
  notes: string[]; sources: string[]; path: EventPath | null; upcoming: EventUpcoming[];
}
export type EventResult = { ok: true; view: EventView } | { ok: false; error: string };

const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): Num => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");

function statsOf(s: unknown): HorizonStats {
  const o = obj(s) ? s : {};
  return { n: num(o.n) ?? 0, mean: num(o.mean), median: num(o.median), positiveShare: num(o.positive_share) };
}

function pathOf(p: unknown): EventPath | null {
  if (!obj(p) || !Array.isArray(p.offsets)) return null;
  const offsets = p.offsets.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (offsets.length !== p.offsets.length || offsets.length < 2) return null;
  const line = (v: unknown) => (Array.isArray(v) && v.length === offsets.length ? v.map(num) : null);
  const mean = line(p.mean);
  const median = line(p.median);
  if (!mean || !median) return null;
  return { offsets, n: num(p.n) ?? 0, mean, median };
}

/** 工具输出 → 视图。工具说做不了就把原因原样带出来。 */
export function parseEvents(toolResult: unknown): EventResult {
  if (!obj(toolResult)) return { ok: false, error: "事件回看工具没有返回结果" };
  if (toolResult.ok !== true) return { ok: false, error: str(toolResult.error) || "事件回看工具没有说明原因" };
  const r = obj(toolResult.result) ? toolResult.result : null;
  if (!r) return { ok: false, error: "事件回看工具的结果看不懂" };
  const horizons = arr(r.horizons).filter(obj)
    .filter((h) => typeof h.key === "string")
    .map((h) => ({ key: str(h.key), from: num(h.from) ?? 0, to: num(h.to) ?? 0, label: str(h.label) }));
  const win = obj(r.window) ? r.window : {};
  return {
    ok: true,
    view: {
      symbol: str(r.symbol), market: str(r.market), kind: str(r.kind), kindLabel: str(r.kind_label), benchmarkLabel: str(r.benchmark_label),
      pre: num(win.pre) ?? 0, post: num(win.post) ?? 0, minEvents: num(r.min_events) ?? 0,
      horizons,
      events: arr(r.events).filter(obj).filter((e) => typeof e.day0 === "string").map((e) => ({
        date: str(e.date), day0: str(e.day0), label: str(e.label), detail: str(e.detail), direction: strOrNull(e.direction),
        values: Object.fromEntries(horizons.map((h) => [h.key, num(e[h.key])])),
        haltedDays: num(e.halted_days) ?? 0, daysAfter: num(e.days_after) ?? 0, overlapsPrev: e.overlaps_prev === true,
      })),
      gaps: arr(r.gaps).filter(obj).filter((g) => typeof g.reason === "string")
        .map((g) => ({ date: strOrNull(g.date), label: str(g.label), reason: str(g.reason) })),
      summary: arr(r.summary).filter(obj).filter((g) => typeof g.key === "string").map((g) => {
        const hz = obj(g.horizons) ? g.horizons : {};
        return {
          key: str(g.key), label: str(g.label), events: num(g.events) ?? 0, note: strOrNull(g.note),
          horizons: Object.fromEntries(horizons.map((h) => [h.key, statsOf(hz[h.key])])),
        };
      }),
      notes: strs(r.notes), sources: strs(r.sources),
      path: obj(r.ui_only) ? pathOf(r.ui_only.path) : null,
      upcoming: arr(r.upcoming).filter(obj).filter((u) => typeof u.date === "string" && u.date !== "")
        .map((u) => ({ date: str(u.date), label: str(u.label), detail: str(u.detail) })),
    },
  };
}

/** 汇总表的行：某一组的次数和「全部」一样（比如每次预告都是向好）时那一行和「全部」完全相同，不重复列，只说一句 */
export function summaryRows(v: EventView): { rows: EventGroup[]; sameAsAll: EventGroup[] } {
  const all = v.summary.find((g) => g.key === "all");
  const same = (g: EventGroup) => !!all && g.key !== "all" && g.events === all.events;
  return { rows: v.summary.filter((g) => !same(g)), sameAsAll: v.summary.filter(same) };
}

/** 事件这一行的提示：停牌、窗口没满、和上一次重叠。都是事实，不是判断。 */
export function eventFlags(e: EventRow, post: number): string[] {
  const out: string[] = [];
  if (e.haltedDays > 0) out.push(`窗口里有 ${e.haltedDays} 个交易日没有价格（多半停牌），不进平均`);
  if (e.daysAfter < post) out.push(`第 0 天之后只有 ${Math.max(e.daysAfter, 0)} 个交易日，还没满 ${post} 个`);
  if (e.overlapsPrev) out.push("和上一次的窗口重叠");
  return out;
}

const offsetLabel = (o: number) => (o === 0 ? "第 0 天" : o > 0 ? `后 ${o} 日` : `前 ${-o} 日`);

/** 平均 / 中位累计超额收益路径（横轴是相对公告日的交易日）。只画百分比。 */
export function eventOption(path: EventPath | null, p: ChartPalette): Obj | null {
  if (!path) return null;
  const line = (name: string, data: Num[], color: string, dashed = false) => ({
    name, type: "line", showSymbol: false, lineStyle: { width: dashed ? 1.2 : 1.8, color, type: dashed ? "dashed" : "solid" },
    itemStyle: { color }, data: data.map((x) => (x === null ? "-" : x)),
  });
  const labels = path.offsets.map(offsetLabel);
  return {
    animation: false,
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: p.text, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: {
      trigger: "axis", backgroundColor: p.tooltipBg, borderColor: p.axis, textStyle: { color: p.tooltipText, fontSize: 12 },
      valueFormatter: (x: unknown) => (typeof x === "number" ? pctSigned(x) : "—"),
    },
    // 刻度只标前 5 日、第 0 天、后 5/10/15/20 日，第 0 天一定标出来
    xAxis: { type: "category", data: labels, boundaryGap: false,
      axisLabel: { color: p.text, fontSize: 11, interval: (i: number) => (path.offsets[i] ?? 1) % 5 === 0 },
      axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { color: p.text, fontSize: 11, formatter: (x: number) => pctSigned(x, 0) },
      splitLine: { lineStyle: { color: p.grid } } },
    series: [
      {
        ...line("平均", path.mean, p.primary),
        markLine: {
          silent: true, symbol: "none", lineStyle: { color: p.axis, type: "dotted" }, label: { show: false },
          data: [{ yAxis: 0 }, ...(path.offsets.includes(0) ? [{ xAxis: offsetLabel(0) }] : [])],
        },
      },
      line("中位数", path.median, p.benchmark, true),
    ],
  };
}

const share = (v: Num) => (v === null ? "—" : `${Math.round(v * 100)}%`);

/** 给 AI 的页面上下文：各档平均 / 中位 / 上涨占比和最近几次的逐次结果。只有百分比，不加判断。 */
export function eventContextText(r: EventResult | null, max = 6): string {
  if (!r) return "";
  if (!r.ok) return `事件回看没做成:${r.error}`;
  const v = r.view;
  const head = `事件回看(${v.symbol} · ${v.kindLabel}，每次事件前 ${v.pre} 到后 ${v.post} 个交易日相对${v.benchmarkLabel}的累计超额收益；只是过去的情况，不预测):`;
  const upcoming = v.upcoming.length
    ? [`已经排期、还没到的${v.kindLabel}(只列出来，不算涨跌):`, ...v.upcoming.map((u) => `${u.date} ${u.label}(${u.detail})`)]
    : [];
  if (!v.events.length) return [head, v.notes[0] ?? "没有可算的事件", ...upcoming].join("\n");
  const { rows, sameAsAll } = summaryRows(v);
  const groups = rows.map((g) => {
    const cells = v.horizons.map((h) => {
      const s = g.horizons[h.key];
      if (!s || s.mean === null) return `${h.label} 不给平均(能算 ${s?.n ?? 0} 次)`;
      return `${h.label} 平均 ${pctSigned(s.mean)}、中位 ${pctSigned(s.median)}、上涨占比 ${share(s.positiveShare)}(${s.n} 次)`;
    });
    return `${g.label} ${g.events} 次:${cells.join(";")}${g.note ? `(${g.note})` : ""}`;
  });
  const recent = v.events.slice(0, max).map((e) => {
    const cells = v.horizons.map((h) => `${h.label} ${pctSigned(e.values[h.key] ?? null)}`).join("、");
    const flags = eventFlags(e, v.post);
    return `${e.date} ${e.label}(${e.detail}):${cells}${flags.length ? `;${flags.join(";")}` : ""}`;
  });
  const same = sameAsAll.map((g) => `这 ${g.events} 次全部是${g.label}`);
  return [head, ...groups, ...same, `最近 ${recent.length} 次:`, ...recent, ...upcoming].join("\n");
}
