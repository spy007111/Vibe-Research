/**
 * 回测图表：把回测工具的原样返回解析成图表数据，并生成 ECharts 配置。
 *
 * 🔴 图里的每个数都直接取自工具返回（`result.tables` / `result.sensitivity` /
 *    `result.ui_only.charts`），这里**不重算**收益或回撤 —— 否则同一个数会有两个版本，
 *    图和报告对不上。唯一的换算是把净值除以初始资金变成累计收益（初始资金也由工具给出）。
 * 🔴 参数敏感度网格**不排序、不标最优**：它回答「参数稍微换一下结论还在不在」，
 *    在同一段历史上挑表现最好的格子正是过拟合。
 * 🔴 红涨绿跌：正收益用红，负收益和回撤用绿。
 * ⚠️ 工具返回的形状不对时，对应那张图不画（返回 null），不拿默认值凑一张。
 */

export type Cell = number | null;
export type Matrix = Cell[][];

export interface ChartSeries {
  initial: number;
  dates: string[];
  equity: number[];
  drawdown: number[];
  benchmark: number[] | null;
}
export interface MonthlyTable { years: number[]; ret: Matrix; bench: Matrix | null }
export interface YearRow { year: number; ret: Cell; bench: Cell; excess: Cell; bars: number; partial: boolean }
export interface DrawdownRow {
  start: string; trough: string; end: string | null; depth: Cell;
  bars_to_trough: number; bars_to_recover: number | null; bars: number;
}
/** n_valid = 夏普算得出的样本数（区间和为正比例的分母）；旧结果没有这一项时是 null */
export interface BootstrapSharpe { ci_lower: Cell; ci_upper: Cell; prob_positive: Cell; confidence: Cell; n_bootstrap: Cell; n_valid: Cell }
export interface SegmentWindow { window: number; start: string; end: string; return: Cell; sharpe: Cell; max_dd: Cell; trades: Cell }
export interface Segments { n_windows: Cell; windows: SegmentWindow[]; profitable_windows: Cell; consistency_rate: Cell }
export interface Robustness {
  bootstrap: BootstrapSharpe | { error: string } | null;
  segments: Segments | { error: string } | null;
}
export type SensitivityMetric = "total_return" | "sharpe" | "max_drawdown" | "trade_count";
export interface Sensitivity {
  x: { param: string; values: number[] };
  y: { param: string; values: number[] };
  fixed: Record<string, number>;
  base: Record<string, number>;
  grids: Record<SensitivityMetric, Matrix>;
  skipped: [number, number, string][];
  complete: boolean;
  runs: number;
  invalidCells: number;
  positiveShare: Cell;
  returnMin: Cell;
  returnMax: Cell;
}
/** 扣费前后对照（backtest/cost_compare.py）：同一套信号、费用和滑点设为零再跑一遍 */
export interface CostRow { total_return: Cell; annual_return: Cell; max_drawdown: Cell; sharpe: Cell; fill_count: Cell }
export type CostCompare =
  | { error: string }
  | { actual: CostRow; free: CostRow; dragTotal: Cell; dragAnnual: Cell; fees: Cell; currency: string; note: string };
export interface BacktestView {
  benchmarkLabel: string;
  benchmarkIsSelf: boolean;
  charts: ChartSeries | null;
  monthly: MonthlyTable | null;
  yearly: YearRow[];
  drawdowns: DrawdownRow[];
  robustness: Robustness | null;
  sensitivity: Sensitivity | null;
  costs: CostCompare | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): Cell => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const finiteArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));

function matrix(v: unknown, rows: number, cols: number): Matrix | null {
  if (!Array.isArray(v) || v.length !== rows) return null;
  const out: Matrix = [];
  for (const row of v) {
    if (!Array.isArray(row) || row.length !== cols) return null;
    if (!row.every((c) => c === null || (typeof c === "number" && Number.isFinite(c)))) return null;
    out.push(row as Cell[]);
  }
  return out;
}

function parseCharts(v: unknown): ChartSeries | null {
  if (!isObj(v)) return null;
  const initial = num(v.initial);
  const { dates, equity, drawdown, benchmark } = v;
  if (initial === null || initial <= 0) return null;
  if (!Array.isArray(dates) || !dates.every((d) => typeof d === "string")) return null;
  if (!finiteArray(equity) || !finiteArray(drawdown)) return null;
  const n = dates.length;
  if (n === 0 || equity.length !== n || drawdown.length !== n) return null;
  const bench = finiteArray(benchmark) && benchmark.length === n ? benchmark : null;
  return { initial, dates: dates as string[], equity, drawdown, benchmark: bench };
}

function parseMonthly(v: unknown): MonthlyTable | null {
  if (!isObj(v) || !finiteArray(v.years) || v.years.length === 0) return null;
  const ret = matrix(v.ret, v.years.length, 12);
  if (!ret) return null;
  return { years: v.years, ret, bench: v.bench === null ? null : matrix(v.bench, v.years.length, 12) };
}

function parseYearly(v: unknown): YearRow[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).filter((r) => num(r.year) !== null).map((r) => ({
    year: num(r.year) as number, ret: num(r.ret), bench: num(r.bench), excess: num(r.excess),
    bars: num(r.bars) ?? 0, partial: r.partial === true,
  }));
}

function parseDrawdowns(v: unknown): DrawdownRow[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).filter((r) => str(r.start) && str(r.trough)).map((r) => ({
    start: str(r.start), trough: str(r.trough), end: str(r.end) || null, depth: num(r.depth),
    bars_to_trough: num(r.bars_to_trough) ?? 0, bars_to_recover: num(r.bars_to_recover), bars: num(r.bars) ?? 0,
  }));
}

function parseRobustness(v: unknown): Robustness | null {
  if (!isObj(v)) return null;
  const errorOf = (x: Obj) => (typeof x.error === "string" ? { error: x.error } : null);
  const b = isObj(v.bootstrap_sharpe) ? v.bootstrap_sharpe : null;
  const s = isObj(v.segments) ? v.segments : null;
  const bootstrap = b ? errorOf(b) ?? {
    ci_lower: num(b.ci_lower), ci_upper: num(b.ci_upper), prob_positive: num(b.prob_positive),
    confidence: num(b.confidence), n_bootstrap: num(b.n_bootstrap), n_valid: num(b.n_valid),
  } : null;
  const segments = s ? errorOf(s) ?? {
    n_windows: num(s.n_windows), profitable_windows: num(s.profitable_windows), consistency_rate: num(s.consistency_rate),
    windows: Array.isArray(s.windows) ? s.windows.filter(isObj).map((w) => ({
      window: num(w.window) ?? 0, start: str(w.start), end: str(w.end), return: num(w.return),
      sharpe: num(w.sharpe), max_dd: num(w.max_dd), trades: num(w.trades),
    })) : [],
  } : null;
  return bootstrap || segments ? { bootstrap, segments } : null;
}

const METRIC_KEYS: SensitivityMetric[] = ["total_return", "sharpe", "max_drawdown", "trade_count"];

function parseSensitivity(v: unknown): Sensitivity | null {
  if (!isObj(v) || !isObj(v.x) || !isObj(v.y)) return null;
  const xs = v.x.values, ys = v.y.values;
  if (!finiteArray(xs) || !finiteArray(ys) || !xs.length || !ys.length) return null;
  const grids = {} as Record<SensitivityMetric, Matrix>;
  for (const k of METRIC_KEYS) {
    const m = matrix(v[k], ys.length, xs.length);
    if (!m) return null;
    grids[k] = m;
  }
  const numbers = (o: unknown): Record<string, number> =>
    isObj(o) ? Object.fromEntries(Object.entries(o).filter(([, x]) => num(x) !== null)) as Record<string, number> : {};
  const skipped = Array.isArray(v.skipped)
    ? v.skipped.filter((c): c is [number, number, string] =>
      Array.isArray(c) && c.length === 3 && Number.isInteger(c[0]) && Number.isInteger(c[1]) && typeof c[2] === "string")
    : [];
  const summary = isObj(v.summary) ? v.summary : {};
  return {
    x: { param: str(v.x.param), values: xs }, y: { param: str(v.y.param), values: ys },
    fixed: numbers(v.fixed), base: numbers(v.base), grids, skipped,
    complete: v.complete === true, runs: num(v.runs) ?? 0, invalidCells: num(v.invalid_cells) ?? 0,
    positiveShare: num(summary.positive_share), returnMin: num(summary.return_min), returnMax: num(summary.return_max),
  };
}

const COST_KEYS = ["total_return", "annual_return", "max_drawdown", "sharpe", "fill_count"] as const;
const costRow = (o: Obj): CostRow => Object.fromEntries(COST_KEYS.map((k) => [k, num(o[k])])) as unknown as CostRow;

function parseCosts(v: unknown, metrics: Obj, currency: string): CostCompare | null {
  if (!isObj(v)) return null;
  if (typeof v.error === "string") return { error: v.error };
  if (!isObj(v.cost_free) || !isObj(v.drag)) return null;
  return {
    actual: costRow(metrics), free: costRow(v.cost_free), dragTotal: num(v.drag.total_return), dragAnnual: num(v.drag.annual_return),
    fees: num(metrics.execution_fees), currency, note: str(v.note),
  };
}

/** 解析 `guidedTool` 返回的 `tool_result`。没有任何能画的内容时返回 null。 */
export function parseBacktestView(toolResult: unknown): BacktestView | null {
  if (!isObj(toolResult) || toolResult.ok !== true || !isObj(toolResult.result)) return null;
  const r = toolResult.result;
  const tables = isObj(r.tables) ? r.tables : {};
  const uiOnly = isObj(r.ui_only) ? r.ui_only : {};
  const bench = isObj(r.benchmark) ? r.benchmark : {};
  const metrics = isObj(r.metrics) ? r.metrics : {};
  const benchmarkIsSelf = r.benchmark_is_self === true;
  const view: BacktestView = {
    benchmarkLabel: benchmarkIsSelf ? "标的等权买入持有" : (str(bench.label) || str(metrics.benchmark_label) || "基准"),
    benchmarkIsSelf,
    charts: parseCharts(uiOnly.charts),
    monthly: parseMonthly(tables.monthly),
    yearly: parseYearly(tables.yearly),
    drawdowns: parseDrawdowns(tables.drawdowns),
    robustness: parseRobustness(r.robustness),
    sensitivity: parseSensitivity(r.sensitivity),
    costs: parseCosts(r.cost_compare, metrics, isObj(r.plan) ? str(r.plan.currency) : ""),
  };
  const empty = !view.charts && !view.monthly && !view.yearly.length && !view.drawdowns.length
    && !view.robustness && !view.sensitivity && !view.costs;
  return empty ? null : view;
}

// ---------------------------------------------------------------- 格式化

export const pct = (v: Cell | undefined, digits = 1): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(digits)}%`;
/** 占比（0~1）：不是全部就不显示 100%，不是没有就不显示 0%（99.5% 四舍五入成 100% 会被读成「每次都为正」）。 */
export const sharePct = (v: Cell | undefined): string => {
  if (v === null || v === undefined) return "—";
  const s = (v * 100).toFixed(1);
  if (v < 1 && s === "100.0") return ">99.9%";
  if (v > 0 && s === "0.0") return "<0.1%";
  return `${s.replace(/\.0$/, "")}%`;
};
/** 为正比例的分母怎么说：有样本夏普算不出（收益没有波动）时，说清楚是其中几次 */
export function bootstrapBase(b: BootstrapSharpe): string {
  const n = b.n_bootstrap, k = b.n_valid;
  if (n !== null && k !== null && k < n) return `重抽样 ${n} 次，其中 ${k} 次夏普算得出（其余样本收益没有波动），这 ${k} 次`;
  return `重抽样 ${n ?? "—"} 次`;
}
export const fixed = (v: Cell | undefined, digits = 2): string =>
  v === null || v === undefined ? "—" : v.toFixed(digits);
/** 收益差（小数）写成百分点；不是 0 却小到四舍五入成 0.0 的，写「不到 0.1」 */
export const points = (v: Cell | undefined): string => {
  if (v === null || v === undefined) return "—";
  if (v !== 0 && Math.abs(v) < 0.0005) return "不到 0.1 个百分点";
  return `${(v * 100).toFixed(1)} 个百分点`;
};
const CURRENCY_LABEL: Record<string, string> = { CNY: "元", HKD: "港元", USD: "美元" };

export const COST_ROWS: { key: keyof CostRow; label: string; fmt: (v: Cell) => string }[] = [
  { key: "total_return", label: "总收益", fmt: (v) => pct(v) },
  { key: "annual_return", label: "年化收益", fmt: (v) => pct(v) },
  { key: "max_drawdown", label: "最大回撤", fmt: (v) => pct(v) },
  { key: "sharpe", label: "夏普", fmt: (v) => fixed(v) },
  { key: "fill_count", label: "成交笔数", fmt: (v) => (v === null ? "—" : String(Math.round(v))) },
];

/** 扣费前后对照的一句话：成本吃掉多少，实际扣了多少费用（滑点不在费用里） */
export function costSummary(c: Exclude<CostCompare, { error: string }>): string {
  const d = c.dragTotal;
  const head = d === null ? "成本吃掉多少没有算出来"
    : d < 0 ? (d > -0.005
      ? `不计成本那次反而少 ${points(-d)}：整手取整让两次持仓略有不同，差得很小，可以当作成本几乎没有影响`
      : `不计成本那次反而少 ${points(-d)}：整手取整让两次持仓差得较多，这次对照量不出成本吃掉多少`)
    : `交易成本（费用 + 滑点）吃掉总收益 ${points(d)}，年化 ${points(c.dragAnnual)}`;
  const fees = c.fees === null ? "" : `；成交记录里实际扣的费用合计 ${c.fees.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${CURRENCY_LABEL[c.currency] ?? c.currency}，滑点不在其中（体现在成交价里）`;
  return `${head}${fees}。`;
}

// 回测选项表（backtest/cli.py 的 strategies）里每个参数都要有中文名；Python 测试会核对两边对得上
const PARAM_LABEL: Record<string, string> = {
  fast: "快线天数", slow: "慢线天数", buy_below: "RSI 低于此值买入", sell_above: "RSI 高于此值卖出", window: "RSI 天数",
  n: "RSRS 回归天数", m: "RSRS 标准化窗口", threshold: "RSRS 阈值",
};
export const paramLabel = (p: string): string => PARAM_LABEL[p] ?? p;

export const SENSITIVITY_METRICS: { key: SensitivityMetric; label: string }[] = [
  { key: "total_return", label: "总收益" },
  { key: "sharpe", label: "夏普" },
  { key: "max_drawdown", label: "最大回撤" },
  { key: "trade_count", label: "平仓次数" },
];

const formatMetric = (k: SensitivityMetric, v: Cell): string =>
  k === "total_return" || k === "max_drawdown" ? pct(v) : k === "sharpe" ? fixed(v) : v === null ? "—" : String(Math.round(v));

const SKIP_LABEL: Record<string, string> = { invalid: "不成立", timeout: "未跑完", error: "出错" };

/** 年度表、回撤段写成 Markdown，跟报告一起归档（图表只在当次会话显示，归档里保留这些原数）。 */
export function appendixMarkdown(v: BacktestView): string {
  const out: string[] = [];
  if (v.yearly.length) {
    out.push("### 年度收益", "", `| 年份 | 策略 | ${v.benchmarkLabel} | 差值 |`, "|---|---:|---:|---:|");
    for (const r of v.yearly) out.push(`| ${r.year}${r.partial ? "（不完整）" : ""} | ${pct(r.ret, 2)} | ${pct(r.bench, 2)} | ${pct(r.excess, 2)} |`);
    out.push("");
  }
  const c = v.costs;
  if (c && !("error" in c)) {
    out.push("### 扣费前后对照", "", "| 指标 | 实际（扣费和滑点） | 不计成本 |", "|---|---:|---:|");
    for (const r of COST_ROWS) out.push(`| ${r.label} | ${r.fmt(c.actual[r.key])} | ${r.fmt(c.free[r.key])} |`);
    out.push("", costSummary(c), ...(c.note ? ["", c.note] : []), "");
  }
  if (v.drawdowns.length) {
    out.push("### 最深的几段回撤", "", "| 开始 | 谷底 | 恢复 | 深度 | 持续（交易日） |", "|---|---|---|---:|---:|");
    for (const d of v.drawdowns) out.push(`| ${d.start} | ${d.trough} | ${d.end ?? "未恢复"} | ${pct(d.depth, 2)} | ${d.bars} |`);
    out.push("");
  }
  return out.length ? ["## 附表（回测工具原样输出）", "", ...out].join("\n").trimEnd() : "";
}

// ---------------------------------------------------------------- 配色与 ECharts 配置

export interface ChartPalette {
  text: string; grid: string; axis: string; strong: string;
  primary: string; benchmark: string; rise: string; fall: string; neutral: string;
  tooltipBg: string; tooltipText: string;
}

const axisBase = (p: ChartPalette) => ({
  axisLabel: { color: p.text, fontSize: 11 },
  axisLine: { lineStyle: { color: p.axis } },
  axisTick: { show: false },
  splitLine: { lineStyle: { color: p.grid } },
});
const tooltip = (p: ChartPalette, extra: Obj = {}) => ({
  backgroundColor: p.tooltipBg, borderColor: p.axis, textStyle: { color: p.tooltipText, fontSize: 12 }, ...extra,
});
const legend = (p: ChartPalette) => ({ top: 0, right: 8, textStyle: { color: p.text, fontSize: 12 }, itemWidth: 14, itemHeight: 8 });

/** 净值对基准：两条累计收益曲线（净值 ÷ 初始资金 − 1）。 */
export function equityOption(v: BacktestView, p: ChartPalette): Obj | null {
  const c = v.charts;
  if (!c) return null;
  const toRet = (xs: number[]) => xs.map((x) => +(x / c.initial - 1).toFixed(6));
  const series: Obj[] = [{
    name: "策略", type: "line", data: toRet(c.equity), showSymbol: false, lineStyle: { width: 2, color: p.primary },
    itemStyle: { color: p.primary },
  }];
  if (c.benchmark) series.push({
    name: v.benchmarkLabel, type: "line", data: toRet(c.benchmark), showSymbol: false,
    lineStyle: { width: 1.5, color: p.benchmark, type: "dashed" }, itemStyle: { color: p.benchmark },
  });
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 32, bottom: 56 },
    legend: legend(p),
    tooltip: tooltip(p, { trigger: "axis", valueFormatter: (x: number) => pct(x, 2) }),
    xAxis: { type: "category", data: c.dates, boundaryGap: false, ...axisBase(p), splitLine: { show: false } },
    yAxis: { type: "value", scale: true, ...axisBase(p), axisLabel: { color: p.text, fontSize: 11, formatter: (x: number) => pct(x, 0) } },
    dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8, borderColor: p.axis, textStyle: { color: p.text } }],
    series,
  };
}

/** 水下回撤：直接画工具写出的回撤列（与报告里的最大回撤同口径）。 */
export function underwaterOption(v: BacktestView, p: ChartPalette): Obj | null {
  const c = v.charts;
  if (!c) return null;
  return {
    animation: false,
    grid: { left: 56, right: 16, top: 12, bottom: 28 },
    tooltip: tooltip(p, { trigger: "axis", valueFormatter: (x: number) => pct(x, 2) }),
    xAxis: { type: "category", data: c.dates, boundaryGap: false, ...axisBase(p), splitLine: { show: false } },
    yAxis: { type: "value", max: 0, ...axisBase(p), axisLabel: { color: p.text, fontSize: 11, formatter: (x: number) => pct(x, 0) } },
    series: [{
      name: "回撤", type: "line", data: c.drawdown, showSymbol: false,
      lineStyle: { width: 1, color: p.fall }, itemStyle: { color: p.fall }, areaStyle: { color: p.fall, opacity: 0.25 },
    }],
  };
}

/**
 * 对称色阶的上限：默认取绝对值最大的格子，至少 ``floor``（全是零时色阶也不塌成一个点）。
 * ``quantile`` < 1 时改取绝对值的该分位：二十年的月度表里一个 +50% 的月份会把其余格子全压成浅色，
 * 超出上限的格子按最深色画，格子里的数字和提示框仍是原值。
 */
export function symmetricMax(values: Cell[], floor = 0.01, quantile = 1): number {
  const abs = values.filter((x): x is number => x !== null).map(Math.abs).sort((a, b) => a - b);
  const pick = abs.length ? abs[Math.floor(quantile * (abs.length - 1))] ?? 0 : 0;
  return +Math.max(floor, pick).toFixed(6);
}

/** 月度热力图：行 = 年，列 = 月。 */
export function monthlyOption(v: BacktestView, p: ChartPalette, which: "ret" | "bench" = "ret"): Obj | null {
  const m = v.monthly;
  const grid = m ? (which === "bench" ? m.bench : m.ret) : null;
  if (!m || !grid) return null;
  const data: [number, number, number][] = [];
  grid.forEach((row, yi) => row.forEach((val, mi) => { if (val !== null) data.push([mi, yi, val]); }));
  const max = symmetricMax(data.map((d) => d[2]), 0.01, 0.95);
  return {
    animation: false,
    grid: { left: 52, right: 12, top: 8, bottom: 52 },
    tooltip: tooltip(p, {
      formatter: (x: { value: [number, number, number] }) => `${m.years[x.value[1]]} 年 ${x.value[0] + 1} 月：${pct(x.value[2], 2)}`,
    }),
    xAxis: { type: "category", data: Array.from({ length: 12 }, (_, i) => `${i + 1}月`), ...axisBase(p), splitLine: { show: false } },
    yAxis: { type: "category", data: m.years.map(String), inverse: true, ...axisBase(p), splitLine: { show: false } },
    visualMap: {
      type: "continuous", min: -max, max, calculable: false, orient: "horizontal", left: "center", bottom: 4,
      itemHeight: 140, itemWidth: 10, text: [`≥ ${pct(max, 0)}`, `≤ ${pct(-max, 0)}`], textStyle: { color: p.text, fontSize: 11 },
      inRange: { color: [p.fall, p.neutral, p.rise] },
    },
    series: [{
      type: "heatmap", data, itemStyle: { borderColor: p.grid, borderWidth: 1 },
      label: { show: true, fontSize: 10, color: p.strong, formatter: (x: { value: [number, number, number] }) => (x.value[2] * 100).toFixed(1) },
    }],
  };
}

/** 年度柱：策略与基准并排；不完整的年份在横轴标「*」。 */
export function yearlyOption(v: BacktestView, p: ChartPalette): Obj | null {
  if (!v.yearly.length) return null;
  const labels = v.yearly.map((r) => `${r.year}${r.partial ? "*" : ""}`);
  const bar = (name: string, vals: Cell[], color: string) => ({
    name, type: "bar", barMaxWidth: 22, itemStyle: { color, borderRadius: [3, 3, 0, 0] }, data: vals.map((x) => (x === null ? "-" : x)),
  });
  const series = [bar("策略", v.yearly.map((r) => r.ret), p.primary)];
  if (v.yearly.some((r) => r.bench !== null)) series.push(bar(v.benchmarkLabel, v.yearly.map((r) => r.bench), p.benchmark));
  return {
    animation: false,
    grid: { left: 52, right: 12, top: 32, bottom: labels.length > 10 ? 48 : 28 },
    legend: legend(p),
    tooltip: tooltip(p, { trigger: "axis", valueFormatter: (x: unknown) => (typeof x === "number" ? pct(x, 2) : "—") }),
    // 年份多时也每年都标（斜着放），免得隔年跳着标让人对不上柱子
    xAxis: {
      type: "category", data: labels, ...axisBase(p), splitLine: { show: false },
      axisLabel: { color: p.text, fontSize: 11, interval: 0, rotate: labels.length > 10 ? 45 : 0 },
    },
    yAxis: { type: "value", ...axisBase(p), axisLabel: { color: p.text, fontSize: 11, formatter: (x: number) => pct(x, 0) } },
    series,
  };
}

/** 参数敏感度热力图。当前参数那一格加框标「当前」；不成立 / 没跑的格子单独一层灰色，不参与色阶。 */
export function sensitivityOption(s: Sensitivity, metric: SensitivityMetric, p: ChartPalette): Obj {
  const grid = s.grids[metric];
  const bx = s.x.values.indexOf(s.base[s.x.param] ?? Number.NaN);
  const by = s.y.values.indexOf(s.base[s.y.param] ?? Number.NaN);
  const data: { value: [number, number, number]; itemStyle?: Obj }[] = [];
  grid.forEach((row, yi) => row.forEach((val, xi) => {
    if (val === null) return;
    const isBase = xi === bx && yi === by;
    data.push({
      value: [xi, yi, val],
      ...(isBase ? { itemStyle: { borderColor: p.strong, borderWidth: 2 } } : {}),
    });
  }));
  // 当前参数那格放到最后画，它的框才不会被右边、下边的格子压住
  data.sort((a, b) => Number(Boolean(a.itemStyle)) - Number(Boolean(b.itemStyle)));
  const vals = data.map((d) => d.value[2]);
  let visualMap: { min: number; max: number; inRange: Obj };
  if (metric === "total_return" || metric === "sharpe") {
    const max = symmetricMax(vals, metric === "sharpe" ? 0.1 : 0.01);
    visualMap = { min: -max, max, inRange: { color: [p.fall, p.neutral, p.rise] } };
  } else if (metric === "max_drawdown") {
    visualMap = { min: Math.min(-0.01, ...vals), max: 0, inRange: { color: [p.fall, p.neutral] } };
  } else {
    visualMap = { min: Math.min(0, ...vals), max: Math.max(1, ...vals), inRange: { color: [p.neutral, p.primary] } };
  }
  const skipped = s.skipped.filter(([yi, xi]) => yi < s.y.values.length && xi < s.x.values.length)
    .map(([yi, xi, why]) => ({ value: [xi, yi, 0], why }));
  return {
    animation: false,
    grid: { left: 64, right: 12, top: 8, bottom: 72 },
    tooltip: tooltip(p, {
      formatter: (x: { seriesIndex: number; value: [number, number, number]; data: { why?: string } }) => {
        const head = `${paramLabel(s.x.param)} ${s.x.values[x.value[0]]} · ${paramLabel(s.y.param)} ${s.y.values[x.value[1]]}`;
        return x.seriesIndex === 1 ? `${head}<br/>${SKIP_LABEL[x.data.why ?? ""] ?? "没有结果"}`
          : `${head}<br/>${SENSITIVITY_METRICS.find((m) => m.key === metric)?.label}：${formatMetric(metric, x.value[2])}`;
      },
    }),
    xAxis: {
      type: "category", data: s.x.values.map(String), name: paramLabel(s.x.param), nameLocation: "middle", nameGap: 26,
      nameTextStyle: { color: p.text }, ...axisBase(p), splitLine: { show: false },
    },
    yAxis: {
      type: "category", data: s.y.values.map(String), name: paramLabel(s.y.param), nameLocation: "middle", nameGap: 44,
      nameTextStyle: { color: p.text }, ...axisBase(p), splitLine: { show: false },
    },
    // ECharts 的直角坐标热力图每个系列都必须挂一个 visualMap；灰色那层挂一个不显示的单色色阶
    visualMap: [{
      type: "continuous", seriesIndex: 0, calculable: false, orient: "horizontal", left: "center", bottom: 4,
      itemHeight: 140, itemWidth: 10, textStyle: { color: p.text, fontSize: 11 },
      text: [formatMetric(metric, visualMap.max), formatMetric(metric, visualMap.min)], ...visualMap,
    }, { type: "continuous", seriesIndex: 1, show: false, min: 0, max: 1, inRange: { color: [p.grid, p.grid] } }],
    series: [
      {
        type: "heatmap", data, itemStyle: { borderColor: p.grid, borderWidth: 1 },
        label: {
          show: true, fontSize: 11, color: p.strong,
          formatter: (x: { value: [number, number, number] }) => {
            const t = formatMetric(metric, x.value[2]);
            return x.value[0] === bx && x.value[1] === by ? `当前\n${t}` : t;
          },
        },
      },
      {
        type: "heatmap", data: skipped, itemStyle: { color: p.grid, borderColor: p.grid, borderWidth: 1 },
        label: { show: true, fontSize: 10, color: p.text, formatter: (x: { data: { why: string } }) => SKIP_LABEL[x.data.why] ?? "—" },
      },
    ],
  };
}
