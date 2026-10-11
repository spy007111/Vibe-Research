/**
 * 持仓收益率：解析收益率工具（backtest.portfolio_perf，经 `/view/holdings_perf`）的输出、生成走势图配置。
 *
 * 🔴 每个数都直接取自工具，这里不重算收益率。
 * 🔴 不同币种分开算、分开展示，组与组之间不相加（没有汇率换算就不能合成一个收益率）。
 * 🔴 不满一年工具不给年化数（null），界面显示区间收益，不拿区间数冒充年化。
 */
import type { ChartPalette } from "./backtestView.ts";

type Obj = Record<string, unknown>;
type Num = number | null;

export interface PerfGap { symbol: string; name: string; reason: string }
export interface PerfSeries { dates: string[]; twrIndex: Num[] }
export interface PerfGroup {
  market: string; currency: string; label: string;
  ok: boolean; reason: string;
  start: string; end: string; spanDays: number | null;
  symbols: { symbol: string; name: string }[]; excluded: PerfGap[];
  twr: Num; twrAnnualized: Num; xirr: Num; mwrPeriod: Num;
  invested: Num; proceeds: Num; dividends: Num; fees: Num; endValue: Num; gain: Num;
  notes: string[]; warnings: string[];
  series: PerfSeries | null;
}
export interface PerfView {
  asOf: string; groups: PerfGroup[];
  skipped: { id: string; symbol: string; why: string }[];
  gaps: { symbol: string; reason: string }[];
  sources: string[];
  /** 各组共用的口径说明 */
  notes: string[];
}
export type PerfResult = { ok: true; view: PerfView } | { ok: false; error: string };

const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): Num => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");

function seriesOf(g: Obj): PerfSeries | null {
  const s = obj(g.ui_only) && obj(g.ui_only.series) ? g.ui_only.series : null;
  if (!s || !Array.isArray(s.dates) || !Array.isArray(s.twr_index) || s.dates.length !== s.twr_index.length) return null;
  return { dates: strs(s.dates), twrIndex: s.twr_index.map(num) };
}

/** 工具输出 → 视图。工具说做不了就把原因原样带出来。 */
export function parsePerf(toolResult: unknown): PerfResult {
  if (!obj(toolResult)) return { ok: false, error: "收益率工具没有返回结果" };
  if (toolResult.ok !== true) return { ok: false, error: str(toolResult.error) || "收益率工具没有说明原因" };
  const r = toolResult.result;
  if (!obj(r) || !Array.isArray(r.groups)) return { ok: false, error: "收益率工具的返回里没有分组结果" };
  const groups: PerfGroup[] = r.groups.filter(obj).map((g) => ({
    market: str(g.market), currency: str(g.currency), label: str(g.label),
    ok: g.ok === true, reason: str(g.reason),
    start: str(g.start), end: str(g.end), spanDays: num(g.span_days),
    symbols: arr(g.symbols).filter(obj).map((s) => ({ symbol: str(s.symbol), name: str(s.name) })),
    excluded: arr(g.excluded).filter(obj).map((x) => ({ symbol: str(x.symbol), name: str(x.name), reason: str(x.reason) })),
    twr: num(g.twr), twrAnnualized: num(g.twr_annualized), xirr: num(g.xirr), mwrPeriod: num(g.mwr_period),
    invested: num(g.invested), proceeds: num(g.proceeds), dividends: num(g.dividends), fees: num(g.fees),
    endValue: num(g.end_value), gain: num(g.gain),
    notes: strs(g.notes), warnings: strs(g.warnings),
    series: seriesOf(g),
  }));
  return {
    ok: true,
    view: {
      asOf: str(r.as_of), groups,
      skipped: arr(r.skipped).filter(obj).map((s) => ({ id: str(s.id), symbol: str(s.symbol), why: str(s.why) })),
      gaps: arr(r.gaps).filter(obj).map((x) => ({ symbol: str(x.symbol), reason: str(x.reason) })),
      sources: strs(r.sources),
      notes: strs(r.notes),
    },
  };
}

/** 收益率百分比：带正负号；没有数显示「—」 */
export const pctSigned = (v: Num, digits = 2) =>
  v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;

/** 时间加权累计收益走势（收益指数 − 1）。只画百分比，不画金额（金额在隐私模式下要遮）。 */
export function perfOption(g: PerfGroup, p: ChartPalette): Obj | null {
  const s = g.series;
  if (!s || s.dates.length < 2) return null;
  return {
    animation: false,
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis", backgroundColor: p.tooltipBg, borderColor: p.axis, textStyle: { color: p.tooltipText, fontSize: 12 },
      valueFormatter: (x: unknown) => (typeof x === "number" ? pctSigned(x) : "—"),
    },
    xAxis: { type: "category", data: s.dates, boundaryGap: false, axisLabel: { color: p.text, fontSize: 11 },
      axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { color: p.text, fontSize: 11, formatter: (x: number) => pctSigned(x, 0) },
      splitLine: { lineStyle: { color: p.grid } } },
    series: [{
      name: "时间加权累计收益", type: "line", showSymbol: false, lineStyle: { width: 1.6, color: p.primary }, itemStyle: { color: p.primary },
      data: s.twrIndex.map((x) => (x === null ? "-" : x - 1)),
      markLine: { silent: true, symbol: "none", lineStyle: { color: p.axis, type: "dashed" }, label: { show: false }, data: [{ yAxis: 0 }] },
    }],
  };
}

/** 给 AI 的页面上下文：只放数字和口径，不评好坏。金额照给（隐私模式只遮屏幕显示） */
export function perfContextText(r: PerfResult | null): string {
  if (!r) return "";
  if (!r.ok) return `收益率没算成:${r.error}`;
  const lines = r.view.groups.map((g) => {
    if (!g.ok) return `${g.label}:没算成(${g.reason})`;
    const parts = [
      `${g.start} 至 ${g.end}(${g.spanDays ?? "?"} 天)`,
      `时间加权 ${pctSigned(g.twr)}${g.twrAnnualized === null ? "" : `(年化 ${pctSigned(g.twrAnnualized)})`}`,
      `资金加权 ${pctSigned(g.mwrPeriod)}${g.xirr === null ? "" : `(年化 ${pctSigned(g.xirr)})`}`,
      `投入 ${g.invested ?? "—"}、卖出所得 ${g.proceeds ?? "—"}、分红 ${g.dividends ?? "—"}、期末市值 ${g.endValue ?? "—"}、盈亏 ${g.gain ?? "—"}`,
    ];
    if (g.excluded.length) parts.push(`没算进来:${g.excluded.map((x) => x.name || x.symbol).join("、")}`);
    if (g.warnings.length) parts.push(`提醒:${g.warnings.join(";")}`);
    return `${g.label}:${parts.join(";")}`;
  });
  return lines.length ? `收益率(按交易流水,${r.view.asOf}):\n${lines.join("\n")}` : "";
}
