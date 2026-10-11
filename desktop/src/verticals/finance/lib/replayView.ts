/**
 * 历史情景回放：解析回放工具（backtest.scenario_replay）的输出、生成走势图配置和给 AI 的页面上下文。
 *
 * 🔴 每个数都直接取自工具，这里不重算。
 * 🔴 不同币种分别回放，组与组之间不相加。
 * 🔴 只是「按现在的比例回看那段行情」：不预测、不给买卖提示。
 */
import type { ChartPalette } from "./backtestView.ts";
import { pctSigned } from "./perfView.ts";

type Obj = Record<string, unknown>;
type Num = number | null;

export interface ReplayGap { symbol: string; name: string; reason: string }
export interface ReplayHolding {
  symbol: string; name: string; weight: Num; ret: Num; contribution: Num;
  firstDate: string; lastDate: string; haltedDays: number;
}
export interface ReplayStats { ret: Num; maxDrawdown: Num; mddPeak: string | null; mddTrough: string | null; worstDay: Num; worstDayDate: string | null }
export interface ReplayPortfolio extends ReplayStats { valueChange: Num; includedValue: Num; days: number | null }
export interface ReplayPath { dates: string[]; portfolio: Num[] | null; benchmark: Num[] | null }
export interface ReplayScenario {
  id: string; label: string; start: string; end: string;
  unavailable: string | null;
  benchmark: ReplayStats | null; benchmarkError: string | null;
  portfolio: ReplayPortfolio | null; portfolioNote: string | null;
  coverage: Num; included: number;
  holdings: ReplayHolding[]; gaps: ReplayGap[];
  path: ReplayPath | null;
}
export interface ReplayGroup {
  market: string; currency: string; label: string; benchmarkLabel: string;
  totalValue: Num; input: number;
  scenarios: ReplayScenario[]; notes: string[]; sources: string[];
}
export interface ReplayView { groups: ReplayGroup[]; gaps: ReplayGap[] }
export type ReplayResult = { ok: true; view: ReplayView } | { ok: false; error: string };

const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): Num => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const gapOf = (g: unknown): ReplayGap | null =>
  obj(g) && typeof g.symbol === "string" && typeof g.reason === "string" ? { symbol: g.symbol, name: str(g.name), reason: g.reason } : null;

function statsOf(s: unknown): ReplayStats | null {
  if (!obj(s)) return null;
  return {
    ret: num(s.return), maxDrawdown: num(s.max_drawdown),
    mddPeak: strOrNull(s.max_drawdown_peak), mddTrough: strOrNull(s.max_drawdown_trough),
    worstDay: num(s.worst_day), worstDayDate: strOrNull(s.worst_day_date),
  };
}

function pathOf(p: unknown): ReplayPath | null {
  if (!obj(p) || !Array.isArray(p.dates)) return null;
  const dates = p.dates.filter((d): d is string => typeof d === "string");
  if (dates.length !== p.dates.length || dates.length < 2) return null;
  const line = (v: unknown) => (Array.isArray(v) && v.length === dates.length ? v.map(num) : null);
  return { dates, portfolio: line(p.portfolio), benchmark: line(p.benchmark) };
}

function scenarioOf(s: unknown, paths: Obj): ReplayScenario | null {
  if (!obj(s) || typeof s.id !== "string" || typeof s.label !== "string") return null;
  const p = obj(s.portfolio) ? s.portfolio : null;
  const base = statsOf(p);
  return {
    id: s.id, label: s.label, start: str(s.start), end: str(s.end),
    unavailable: strOrNull(s.unavailable),
    benchmark: statsOf(s.benchmark), benchmarkError: strOrNull(s.benchmark_error),
    portfolio: p && base ? { ...base, valueChange: num(p.value_change), includedValue: num(p.included_value), days: num(p.days) } : null,
    portfolioNote: strOrNull(s.portfolio_note),
    coverage: num(s.coverage), included: num(s.positions_included) ?? 0,
    holdings: arr(s.holdings).filter(obj).map((h) => ({
      symbol: str(h.symbol), name: str(h.name), weight: num(h.weight), ret: num(h.return), contribution: num(h.contribution),
      firstDate: str(h.first_date), lastDate: str(h.last_date), haltedDays: num(h.halted_days) ?? 0,
    })),
    gaps: arr(s.gaps).map(gapOf).filter((g): g is ReplayGap => g !== null),
    path: pathOf(paths[s.id]),
  };
}

/** 工具输出 → 视图。工具说做不了就把原因原样带出来。 */
export function parseReplay(toolResult: unknown): ReplayResult {
  if (!obj(toolResult)) return { ok: false, error: "回放工具没有返回结果" };
  if (toolResult.ok !== true) return { ok: false, error: str(toolResult.error) || "回放工具没有说明原因" };
  const r = obj(toolResult.result) ? toolResult.result : null;
  if (!r) return { ok: false, error: "回放工具的结果看不懂" };
  const allPaths = obj(r.ui_only) && obj(r.ui_only.paths) ? r.ui_only.paths : {};
  const groups = arr(r.groups).filter(obj).map((g): ReplayGroup => {
    const paths = obj(allPaths[str(g.currency)]) ? (allPaths[str(g.currency)] as Obj) : {};
    return {
      market: str(g.market), currency: str(g.currency), label: str(g.label), benchmarkLabel: str(g.benchmark_label),
      totalValue: num(g.total_value), input: num(g.positions_input) ?? 0,
      scenarios: arr(g.scenarios).map((s) => scenarioOf(s, paths)).filter((s): s is ReplayScenario => s !== null),
      notes: arr(g.notes).filter((n): n is string => typeof n === "string"),
      sources: arr(g.sources).filter((n): n is string => typeof n === "string"),
    };
  });
  return { ok: true, view: { groups, gaps: arr(r.gaps).map(gapOf).filter((g): g is ReplayGap => g !== null) } };
}

/** 一段时期的组合与对照走势（都从 0% 起步）。只画百分比，不画金额。 */
export function replayOption(s: ReplayScenario, benchmarkLabel: string, p: ChartPalette): Obj | null {
  const path = s.path;
  if (!path || (!path.portfolio && !path.benchmark)) return null;
  const line = (name: string, data: Num[], color: string, dashed = false) => ({
    name, type: "line", showSymbol: false, lineStyle: { width: dashed ? 1.2 : 1.8, color, type: dashed ? "dashed" : "solid" },
    itemStyle: { color }, data: data.map((x) => (x === null ? "-" : x - 1)),
  });
  const series = [
    ...(path.portfolio ? [line("按现在比例的组合", path.portfolio, p.primary)] : []),
    ...(path.benchmark ? [line(benchmarkLabel || "对照指数", path.benchmark, p.benchmark, true)] : []),
  ];
  return {
    animation: false,
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: p.text, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    tooltip: {
      trigger: "axis", backgroundColor: p.tooltipBg, borderColor: p.axis, textStyle: { color: p.tooltipText, fontSize: 12 },
      valueFormatter: (x: unknown) => (typeof x === "number" ? pctSigned(x) : "—"),
    },
    xAxis: { type: "category", data: path.dates, boundaryGap: false, axisLabel: { color: p.text, fontSize: 11 },
      axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { color: p.text, fontSize: 11, formatter: (x: number) => pctSigned(x, 0) },
      splitLine: { lineStyle: { color: p.grid } } },
    series: series.map((x, i) => (i === 0
      ? { ...x, markLine: { silent: true, symbol: "none", lineStyle: { color: p.axis, type: "dotted" }, label: { show: false }, data: [{ yAxis: 0 }] } }
      : x)),
  };
}

/** 给 AI 的页面上下文：每段时期的组合与对照涨跌、覆盖情况；不放金额以外的推断 */
export function replayContextText(r: ReplayResult | null): string {
  if (!r) return "";
  if (!r.ok) return `历史情景回放没做成:${r.error}`;
  const lines = r.view.groups.flatMap((g) => g.scenarios.map((s) => {
    if (s.unavailable) return `${g.label} · ${s.label}:${s.unavailable}`;
    const port = s.portfolio
      ? `组合 ${pctSigned(s.portfolio.ret)}、期间最大回撤 ${pctSigned(s.portfolio.maxDrawdown)}、最差单日 ${pctSigned(s.portfolio.worstDay)}`
      : `组合数字没给(${s.portfolioNote ?? "没有可用价格"})`;
    const bench = s.benchmark ? `${g.benchmarkLabel} ${pctSigned(s.benchmark.ret)}` : `对照没取到`;
    const cov = s.coverage === null ? "" : `;有价格的持仓占这一组市值 ${Math.round(s.coverage * 100)}%`;
    return `${g.label} · ${s.label}(${s.start} 至 ${s.end}):${port};${bench}${cov}`;
  }));
  return lines.length ? `历史情景回放(按现在的持仓比例回看历史大跌期，不是当时的真实持仓，不预测):\n${lines.join("\n")}` : "";
}
