/**
 * 个股 K 线：解析 K 线工具（backtest.kline）的输出，生成 ECharts 配置。
 *
 * 🔴 图里的每个数都直接取自工具：均线、涨跌幅、成交量单位换算都在工具里算好，这里不重算。
 * 🔴 红涨绿跌；只画 K 线、均线、成交量，不画买卖点或任何信号标记。
 */
import type { ChartPalette } from "./backtestView.ts";

type Obj = Record<string, unknown>;
type Num = number | null;

export interface KlineSeries {
  dates: string[];
  open: Num[]; high: Num[]; low: Num[]; close: Num[];
  volume: Num[];
  change: Num[];
  ma: Record<string, Num[]>;
}

export interface KlineView {
  symbol: string;
  market: string;
  marketLabel: string;
  period: string;
  periodLabel: string;
  adjust: string;
  adjustLabel: string;
  source: string;
  fetchedAt: string | null;
  volumeUnit: string | null;
  bars: number;
  first: string;
  last: string;
  notes: string[];
  series: KlineSeries;
}

export type KlineResult = { ok: true; view: KlineView } | { ok: false; error: string };

const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numArr = (v: unknown, n: number): Num[] | null =>
  Array.isArray(v) && v.length === n && v.every((x) => x === null || (typeof x === "number" && Number.isFinite(x)))
    ? (v as Num[]) : null;

/** 工具输出 → 视图。工具说画不了就把原因原样带出来；形状不对也说清楚，不画一张残图。 */
export function parseKline(toolResult: unknown): KlineResult {
  if (!obj(toolResult)) return { ok: false, error: "K 线工具没有返回结果" };
  if (toolResult.ok !== true) return { ok: false, error: str(toolResult.error) ?? "K 线工具没有说明原因" };
  const r = toolResult.result;
  const s = obj(r) && obj(r.ui_only) ? r.ui_only.series : null;
  if (!obj(r) || !obj(s) || !Array.isArray(s.dates)) return { ok: false, error: "K 线工具的返回里没有序列" };
  const n = s.dates.length;
  if (!n || !s.dates.every((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    return { ok: false, error: "K 线日期格式不对" };
  }
  const cols = (["open", "high", "low", "close", "volume", "change"] as const).map((k) => [k, numArr(s[k], n)] as const);
  const bad = cols.filter(([, v]) => v === null).map(([k]) => k);
  if (bad.length) return { ok: false, error: `K 线序列长度或数值不对：${bad.join("、")}` };
  const col = Object.fromEntries(cols) as Record<(typeof cols)[number][0], Num[]>;
  const ma: Record<string, Num[]> = {};
  if (obj(s.ma)) for (const [k, v] of Object.entries(s.ma)) { const a = numArr(v, n); if (a && /^\d+$/.test(k)) ma[k] = a; }
  return {
    ok: true,
    view: {
      symbol: str(r.symbol) ?? "",
      market: str(r.market) ?? "",
      marketLabel: str(r.market_label) ?? "",
      period: str(r.period) ?? "day",
      periodLabel: str(r.period_label) ?? "",
      adjust: str(r.adjust) ?? "",
      adjustLabel: str(r.adjust_label) ?? "",
      source: str(r.source) ?? "",
      fetchedAt: str(r.fetched_at),
      volumeUnit: str(r.volume_unit),
      bars: n,
      first: s.dates[0] as string,
      last: s.dates[n - 1] as string,
      notes: Array.isArray(r.notes) ? r.notes.filter((x): x is string => typeof x === "string") : [],
      series: { dates: s.dates as string[], ...col, ma },
    },
  };
}

/** 价格：10 元以下（ETF、低价股）保留三位，其余两位。 */
export function fmtPrice(x: Num): string {
  if (x === null) return "—";
  return Math.abs(x) < 10 ? x.toFixed(3) : x.toFixed(2);
}

/** 成交量（股）：上亿写「亿」，上万写「万」。 */
export function fmtVolume(x: Num): string {
  if (x === null) return "—";
  const a = Math.abs(x);
  if (a >= 1e8) return `${(x / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${(x / 1e4).toFixed(a >= 1e6 ? 0 : 1)}万`;
  return String(Math.round(x));
}

export function fmtChange(x: Num): string {
  if (x === null) return "—";
  return `${x > 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
}

/** 涨跌颜色的判据与 K 线柱一致：收盘高于开盘为涨；平开平收时看相对上一根收盘。 */
export function barRises(s: KlineSeries, i: number): boolean {
  const o = s.open[i] ?? null, c = s.close[i] ?? null;
  if (o === null || c === null) return (s.change[i] ?? 0) >= 0;
  return c === o ? (s.change[i] ?? 0) >= 0 : c > o;
}

/** 默认显示最近多少根：日线约半年、周线两年、月线十年；其余用缩放条拖出来。 */
export const VISIBLE_BARS: Record<string, number> = { day: 120, week: 104, month: 120 };

/** 均线颜色：避开红绿（那是涨跌的颜色），亮暗两种底色上都看得清。 */
const MA_COLORS = ["#8b8f98", "#d4a017", "#a855f7", "#3b82f6"];

const escape = (x: string) => x.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function klineOption(v: KlineView, p: ChartPalette): Obj {
  const s = v.series;
  const n = s.dates.length;
  const visible = VISIBLE_BARS[v.period] ?? 120;
  const startValue = Math.max(0, n - visible);
  const axisLabel = { color: p.text, fontSize: 11 };
  const maKeys = Object.keys(s.ma).sort((a, b) => Number(a) - Number(b));
  const hasVolume = v.volumeUnit !== null && s.volume.some((x) => x !== null);
  const candles = s.dates.map((_, i) => [s.open[i], s.close[i], s.low[i], s.high[i]].map((x) => x ?? "-"));
  const series: Obj[] = [
    {
      name: "K 线", type: "candlestick", data: candles, barMaxWidth: 14,
      itemStyle: { color: p.rise, color0: p.fall, borderColor: p.rise, borderColor0: p.fall },
    },
    ...maKeys.map((k, i) => ({
      name: `MA${k}`, type: "line", data: s.ma[k]!.map((x) => x ?? "-"), showSymbol: false, smooth: false,
      lineStyle: { width: 1, color: MA_COLORS[i % MA_COLORS.length] }, itemStyle: { color: MA_COLORS[i % MA_COLORS.length] },
    })),
  ];
  if (hasVolume) series.push({
    name: "成交量", type: "bar", xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 14,
    data: s.volume.map((x, i) => ({ value: x ?? "-", itemStyle: { color: barRises(s, i) ? p.rise : p.fall, opacity: 0.7 } })),
  });

  const tooltipFormatter = (params: unknown) => {
    const first = Array.isArray(params) ? params[0] : params;
    const i = obj(first) && typeof first.dataIndex === "number" ? first.dataIndex : -1;
    if (i < 0 || i >= n) return "";
    const tone = (s.change[i] ?? 0) > 0 ? p.rise : (s.change[i] ?? 0) < 0 ? p.fall : p.tooltipText;
    const row = (k: string, val: string, color?: string) =>
      `<div style="display:flex;justify-content:space-between;gap:16px"><span style="opacity:.7">${k}</span><span style="font-variant-numeric:tabular-nums${color ? `;color:${color}` : ""}">${val}</span></div>`;
    return [
      `<div style="font-weight:600;margin-bottom:4px">${escape(s.dates[i]!)}</div>`,
      row("开盘", fmtPrice(s.open[i] ?? null)), row("最高", fmtPrice(s.high[i] ?? null)),
      row("最低", fmtPrice(s.low[i] ?? null)), row("收盘", fmtPrice(s.close[i] ?? null), tone),
      row("涨跌幅", fmtChange(s.change[i] ?? null), tone),
      ...(hasVolume ? [row("成交量", `${fmtVolume(s.volume[i] ?? null)} ${escape(v.volumeUnit ?? "")}`)] : []),
      ...maKeys.map((k) => row(`MA${k}`, fmtPrice(s.ma[k]![i] ?? null))),
    ].join("");
  };

  return {
    animation: false,
    legend: { top: 0, left: 0, itemWidth: 14, itemHeight: 2, textStyle: { color: p.text, fontSize: 11 }, data: maKeys.map((k) => `MA${k}`) },
    axisPointer: { link: [{ xAxisIndex: "all" }], label: { backgroundColor: p.tooltipBg, color: p.tooltipText } },
    tooltip: {
      trigger: "axis", axisPointer: { type: "cross" }, formatter: tooltipFormatter,
      backgroundColor: p.tooltipBg, borderColor: p.axis, textStyle: { color: p.tooltipText, fontSize: 12 },
    },
    grid: hasVolume
      ? [{ left: 60, right: 16, top: 28, height: "56%" }, { left: 60, right: 16, top: "72%", height: "14%" }]
      : [{ left: 60, right: 16, top: 28, bottom: 64 }],
    xAxis: [
      { type: "category", data: s.dates, boundaryGap: true, axisLine: { lineStyle: { color: p.axis } }, axisTick: { show: false },
        axisLabel: hasVolume ? { show: false } : axisLabel, splitLine: { show: false } },
      ...(hasVolume ? [{ type: "category", gridIndex: 1, data: s.dates, boundaryGap: true, axisLine: { lineStyle: { color: p.axis } },
        axisTick: { show: false }, axisLabel, splitLine: { show: false } }] : []),
    ],
    yAxis: [
      { type: "value", scale: true, axisLabel: { ...axisLabel, formatter: (x: number) => fmtPrice(x) },
        axisLine: { show: false }, splitLine: { lineStyle: { color: p.grid } } },
      ...(hasVolume ? [{ type: "value", gridIndex: 1, splitNumber: 2, axisLabel: { ...axisLabel, formatter: (x: number) => fmtVolume(x) },
        axisLine: { show: false }, splitLine: { lineStyle: { color: p.grid } } }] : []),
    ],
    // 图在页面中间：普通滚轮留给页面滚动，按住 Ctrl 滚轮（触控板双指捏合也是）才缩放，拖动平移。
    dataZoom: [
      { type: "inside", xAxisIndex: hasVolume ? [0, 1] : [0], startValue, endValue: n - 1, zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false },
      { type: "slider", xAxisIndex: hasVolume ? [0, 1] : [0], startValue, endValue: n - 1, height: 18, bottom: 8,
        borderColor: p.axis, textStyle: { color: p.text } },
    ],
    series,
  };
}
