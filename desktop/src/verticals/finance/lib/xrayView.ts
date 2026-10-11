/**
 * 持仓体检：解析体检工具（backtest.portfolio_xray）的输出、按用户自己设的提醒线找出超线项、生成图表配置。
 *
 * 🔴 图和横幅里的每个数都直接取自工具，这里不重算风险指标。
 * 🔴 不出综合分、不评好坏：横幅只说「哪一项超过了你设的线」，线由用户自己设，设成空就不提醒。
 * 🔴 不同币种分别体检，结果按组展示，组与组之间不相加。
 */
import type { ChartPalette } from "./backtestView.ts";

type Obj = Record<string, unknown>;
type Num = number | null;

export interface XrayPosition {
  symbol: string; name: string; value: Num; weight: Num; riskShare: Num; vol: Num; industry: string | null;
  /** 港美股才有：东财给的细分行业名（一级行业按它对回来） */
  industryDetail: string | null;
}
export interface XrayGap { symbol: string; name: string; reason: string }
export interface XrayMetrics {
  window: { first: string; last: string; days: number } | null;
  top1: { symbol: string; name: string; weight: Num } | null;
  top3Weight: Num; effectiveN: Num;
  annualizedVol: Num; downsideVol: Num;
  maxDrawdown: Num; maxDrawdownStart: string | null; maxDrawdownTrough: string | null;
  var95: Num; es95: Num; diversificationRatio: Num; avgAbsCorr: Num;
  maxCorrPair: { symbols: [string, string]; corr: Num } | null;
}
export interface XrayMatrix { symbols: string[]; values: Num[][] }
export interface XrayGroup {
  market: string; currency: string; label: string;
  totalValue: Num; included: number; input: number;
  positions: XrayPosition[];
  metrics: XrayMetrics | null;
  industry: { classification: string; buckets: { name: string; weight: Num; symbols: string[] }[] } | null;
  gaps: XrayGap[]; notes: string[]; sources: string[];
  matrix: XrayMatrix | null;
}
export interface XrayView { groups: XrayGroup[]; gaps: XrayGap[]; windowDays: number | null }
export type XrayResult = { ok: true; view: XrayView } | { ok: false; error: string };

/** 不归入单一行业的几个桶：不参与「单一行业超线」的判断 */
export const NON_INDUSTRY_BUCKETS = ["ETF / 基金（不归入单一行业）", "行业未取到", "没有行业资料（ETF、基金多是这样）"];

const obj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): Num => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const gap = (g: unknown): XrayGap | null =>
  obj(g) && typeof g.symbol === "string" && typeof g.reason === "string" ? { symbol: g.symbol, name: str(g.name), reason: g.reason } : null;

function matrixOf(v: unknown): XrayMatrix | null {
  if (!obj(v) || !Array.isArray(v.symbols) || !Array.isArray(v.values)) return null;
  const symbols = v.symbols.filter((s): s is string => typeof s === "string");
  const n = symbols.length;
  if (!n || n !== v.symbols.length || v.values.length !== n) return null;
  const values = v.values.map((row) => (Array.isArray(row) && row.length === n ? row.map(num) : null));
  return values.every((r) => r !== null) ? { symbols, values: values as Num[][] } : null;
}

function metricsOf(m: unknown): XrayMetrics | null {
  if (!obj(m)) return null;
  const w = obj(m.window) ? m.window : null;
  const t = obj(m.top1) ? m.top1 : null;
  const pair = obj(m.max_corr_pair) && Array.isArray(m.max_corr_pair.symbols) && m.max_corr_pair.symbols.length === 2
    ? { symbols: m.max_corr_pair.symbols.map(String) as [string, string], corr: num(m.max_corr_pair.corr) } : null;
  return {
    window: w ? { first: str(w.first_date), last: str(w.last_date), days: num(w.days) ?? 0 } : null,
    top1: t ? { symbol: str(t.symbol), name: str(t.name), weight: num(t.weight) } : null,
    top3Weight: num(m.top3_weight), effectiveN: num(m.effective_n),
    annualizedVol: num(m.annualized_vol), downsideVol: num(m.downside_vol),
    maxDrawdown: num(m.max_drawdown), maxDrawdownStart: strOrNull(m.max_drawdown_start), maxDrawdownTrough: strOrNull(m.max_drawdown_trough),
    var95: num(m.var_95), es95: num(m.es_95), diversificationRatio: num(m.diversification_ratio), avgAbsCorr: num(m.avg_abs_corr),
    maxCorrPair: pair,
  };
}

/** 工具输出 → 视图。工具说做不了就把原因原样带出来。 */
export function parseXray(toolResult: unknown): XrayResult {
  if (!obj(toolResult)) return { ok: false, error: "体检工具没有返回结果" };
  if (toolResult.ok !== true) return { ok: false, error: str(toolResult.error) || "体检工具没有说明原因" };
  const r = toolResult.result;
  if (!obj(r) || !Array.isArray(r.groups)) return { ok: false, error: "体检工具的返回里没有分组结果" };
  const matrices = obj(r.ui_only) && obj(r.ui_only.correlation) ? r.ui_only.correlation : {};
  const groups: XrayGroup[] = r.groups.filter(obj).map((g) => {
    const ind = obj(g.industry) && Array.isArray(g.industry.buckets) ? g.industry : null;
    return {
      market: str(g.market), currency: str(g.currency), label: str(g.label),
      totalValue: num(g.total_value), included: num(g.positions_included) ?? 0, input: num(g.positions_input) ?? 0,
      positions: arr(g.positions).filter(obj).map((p) => ({
        symbol: str(p.symbol), name: str(p.name), value: num(p.value), weight: num(p.weight),
        riskShare: num(p.risk_share), vol: num(p.vol_annualized), industry: strOrNull(p.industry), industryDetail: strOrNull(p.industry_detail),
      })),
      metrics: metricsOf(g.metrics),
      industry: ind ? {
        classification: str(ind.classification),
        buckets: arr(ind.buckets).filter(obj).map((b) => ({
          name: str(b.name), weight: num(b.weight), symbols: arr(b.symbols).filter((s): s is string => typeof s === "string"),
        })),
      } : null,
      gaps: arr(g.gaps).map(gap).filter((x): x is XrayGap => x !== null),
      notes: arr(g.notes).filter((x): x is string => typeof x === "string"),
      sources: arr(g.sources).filter((x): x is string => typeof x === "string"),
      matrix: matrixOf((matrices as Obj)[str(g.currency)]),
    };
  });
  return {
    ok: true,
    view: { groups, gaps: arr(r.gaps).map(gap).filter((x): x is XrayGap => x !== null), windowDays: num(r.window_days) },
  };
}

// ── 提醒线 ──

/** 用户自己设的提醒线。null = 这一项不提醒。占比类是小数（0.3 = 30%）。 */
export interface XrayThresholds { single: Num; top3: Num; industry: Num; corr: Num }

/** 第一次打开时的起点，页面上标明「可以改」；不是我们替用户下的判断。 */
export const DEFAULT_THRESHOLDS: XrayThresholds = { single: 0.3, top3: 0.6, industry: 0.4, corr: 0.8 };
export const THRESHOLDS_KEY = "vr.portfolio.xray.thresholds";

const inUnit = (x: unknown): Num => (typeof x === "number" && Number.isFinite(x) && x > 0 && x <= 1 ? x : null);

/** 读存下来的提醒线；坏数据退回起点值，单项显式存了 null 就保持不提醒。 */
export function parseThresholds(raw: string | null): XrayThresholds {
  if (!raw) return { ...DEFAULT_THRESHOLDS };
  try {
    const v: unknown = JSON.parse(raw);
    if (!obj(v)) return { ...DEFAULT_THRESHOLDS };
    const pick = (k: keyof XrayThresholds) => (v[k] === null ? null : k in v ? inUnit(v[k]) ?? DEFAULT_THRESHOLDS[k] : DEFAULT_THRESHOLDS[k]);
    return { single: pick("single"), top3: pick("top3"), industry: pick("industry"), corr: pick("corr") };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

export interface XrayBreach { group: string; kind: keyof XrayThresholds; text: string }

export const pct = (x: Num, digits = 1) => (x === null ? "—" : `${(x * 100).toFixed(digits)}%`);
const who = (name: string, symbol: string) => (name ? `${name}（${symbol}）` : symbol);

/** 按用户的提醒线逐项比，超过的列出来。只比数字，不给建议。 */
export function findBreaches(v: XrayView, th: XrayThresholds): XrayBreach[] {
  const out: XrayBreach[] = [];
  for (const g of v.groups) {
    if (!g.metrics) continue;
    const names = new Map(g.positions.map((p) => [p.symbol, p.name]));
    // 这一组只有一只时它必然占 100%，和前三合计一样没有信息量，不比
    if (th.single !== null && g.positions.length > 1) {
      for (const p of g.positions) {
        if (p.weight !== null && p.weight > th.single) {
          out.push({ group: g.label, kind: "single", text: `${who(p.name, p.symbol)} 占 ${pct(p.weight)}，超过你设的单只 ${pct(th.single, 0)}` });
        }
      }
    }
    // 三只及以下时前三合计必然是 100%，比了也没有信息量
    if (th.top3 !== null && g.positions.length > 3 && g.metrics.top3Weight !== null && g.metrics.top3Weight > th.top3) {
      out.push({ group: g.label, kind: "top3", text: `前三只合计 ${pct(g.metrics.top3Weight)}，超过你设的 ${pct(th.top3, 0)}` });
    }
    if (th.industry !== null && g.industry) {
      for (const b of g.industry.buckets) {
        if (!NON_INDUSTRY_BUCKETS.includes(b.name) && b.weight !== null && b.weight > th.industry) {
          out.push({ group: g.label, kind: "industry", text: `${b.name}行业占 ${pct(b.weight)}，超过你设的单一行业 ${pct(th.industry, 0)}` });
        }
      }
    }
    if (th.corr !== null) {
      const pairs: { a: string; b: string; c: number }[] = [];
      if (g.matrix) {
        const s = g.matrix.symbols;
        for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
          const c = g.matrix.values[i]![j];
          if (c !== null && c !== undefined && c > th.corr) pairs.push({ a: s[i]!, b: s[j]!, c });
        }
      } else if (g.metrics.maxCorrPair?.corr != null && g.metrics.maxCorrPair.corr > th.corr) {
        pairs.push({ a: g.metrics.maxCorrPair.symbols[0], b: g.metrics.maxCorrPair.symbols[1], c: g.metrics.maxCorrPair.corr });
      }
      for (const x of pairs.sort((p, q) => q.c - p.c)) {
        out.push({ group: g.label, kind: "corr", text: `${who(names.get(x.a) ?? "", x.a)} 和 ${who(names.get(x.b) ?? "", x.b)} 相关系数 ${x.c.toFixed(2)}，超过你设的 ${th.corr.toFixed(2)}` });
      }
    }
  }
  return out;
}

/** 给页面 AI 的体检摘要：只转述工具算出的数和用户自己设的线，AI 回答「结构上有什么风险」时有据可依。 */
export function xrayContextText(v: XrayView, breaches: XrayBreach[]): string {
  const lines = ["持仓体检（工具按最近一年日线算，按币种分组，组与组不相加）："];
  for (const g of v.groups) {
    const m = g.metrics;
    if (!m) { lines.push(`${g.label}：没算成（${g.gaps.map((x) => `${x.symbol} ${x.reason}`).join("；") || "没有可用持仓"}）`); continue; }
    const parts = [
      `纳入 ${g.included}/${g.input} 只`,
      m.top1 ? `最大一只 ${who(m.top1.name, m.top1.symbol)} ${pct(m.top1.weight)}` : "",
      `前三合计 ${pct(m.top3Weight)}`,
      m.effectiveN === null ? "" : `等效持股数 ${m.effectiveN.toFixed(1)}`,
      `年化波动 ${pct(m.annualizedVol)}`,
      `最大回撤 ${pct(m.maxDrawdown)}`,
      `单日95%VaR（亏损幅度）${pct(m.var95, 2)}`,
      m.avgAbsCorr === null ? "" : `平均相关性 ${m.avgAbsCorr.toFixed(2)}`,
    ].filter(Boolean);
    lines.push(`${g.label}：${parts.join("，")}`);
    const risk = g.positions.filter((p) => p.riskShare !== null).map((p) => `${p.name || p.symbol} 资金${pct(p.weight)}/风险${pct(p.riskShare)}`);
    if (risk.length) lines.push(`  风险贡献：${risk.join("；")}`);
    if (g.industry) lines.push(`  行业（${g.industry.classification}）：${g.industry.buckets.map((b) => `${b.name} ${pct(b.weight)}（${bucketMembers(g, b.symbols)}）`).join("；")}`);
    if (g.gaps.length) lines.push(`  未纳入：${g.gaps.map((x) => `${x.symbol} ${x.reason}`).join("；")}`);
  }
  if (v.gaps.length) lines.push(`未纳入体检：${v.gaps.map((x) => `${x.symbol} ${x.reason}`).join("；")}`);
  lines.push(breaches.length ? `超过用户自设提醒线：${breaches.map((b) => `${b.group} ${b.text}`).join("；")}` : "没有超过用户自设的提醒线。");
  return lines.join("\n");
}

/** 行业桶里有哪几只：名字，港美股另带东财的细分行业。
 *  细分行业名自己可能带顿号（「电脑硬件、储存设备及电脑周边」），带细分时各只之间改用逗号 */
export function bucketMembers(g: XrayGroup, symbols: string[]): string {
  let detailed = false;
  const parts = symbols.map((s) => {
    const p = g.positions.find((x) => x.symbol === s);
    const nm = p ? p.name || p.symbol : s;
    if (!p?.industryDetail) return nm;
    detailed = true;
    return `${nm}·${p.industryDetail}`;
  });
  return parts.join(detailed ? "，" : "、");
}

// ── 图 ──

const label = (p: XrayPosition) => p.name || p.symbol;

/** 资金占比 vs 风险贡献：同一只两根横条并排；风险贡献明显高于资金占比的，就是组合波动的主要来源。 */
export function riskShareOption(g: XrayGroup, p: ChartPalette): Obj | null {
  // 只有一只时资金占比和风险贡献都是 100%，画出来没有信息
  if (g.positions.length < 2) return null;
  const rows = [...g.positions].reverse();   // 横向条形图从下往上画，倒过来让占比最大的在最上面
  const bar = (name: string, vals: Num[], color: string) => ({
    name, type: "bar", barMaxWidth: 12, itemStyle: { color, borderRadius: [0, 3, 3, 0] }, data: vals.map((x) => x ?? "-"),
  });
  return {
    animation: false,
    grid: { left: 8, right: 24, top: 28, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, itemWidth: 12, itemHeight: 8, textStyle: { color: p.text, fontSize: 11 } },
    tooltip: {
      trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: p.tooltipBg, borderColor: p.axis,
      textStyle: { color: p.tooltipText, fontSize: 12 }, valueFormatter: (x: unknown) => (typeof x === "number" ? pct(x) : "—"),
    },
    xAxis: { type: "value", axisLabel: { color: p.text, fontSize: 11, formatter: (x: number) => pct(x, 0) },
      splitLine: { lineStyle: { color: p.grid } } },
    yAxis: { type: "category", data: rows.map(label), axisLabel: { color: p.text, fontSize: 11 }, axisTick: { show: false },
      axisLine: { lineStyle: { color: p.axis } } },
    series: [bar("资金占比", rows.map((r) => r.weight), p.benchmark), bar("风险贡献", rows.map((r) => r.riskShare), p.primary)],
  };
}

/** 两两相关系数热力图。颜色不用红绿（那是涨跌的颜色）：负相关偏蓝、正相关偏主色。 */
export function correlationOption(g: XrayGroup, p: ChartPalette): Obj | null {
  const m = g.matrix;
  if (!m || m.symbols.length < 2) return null;
  const names = m.symbols.map((s) => g.positions.find((x) => x.symbol === s)?.name || s);
  const data: [number, number, number | string][] = [];
  m.values.forEach((row, i) => row.forEach((c, j) => data.push([j, i, c ?? "-"])));
  const n = names.length;
  // 轴上名字太长会挤成一团：超过 6 个字截断，悬停框里仍是全名
  const short = (s: string) => (s.length > 6 ? `${s.slice(0, 6)}…` : s);
  // 悬停框按 HTML 渲染，持仓名是用户自己填的，要先转义（Codex 审计 2026-10-09 C1）
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return {
    animation: false,
    grid: { left: 8, right: 12, top: 8, bottom: 44, containLabel: true },
    tooltip: {
      backgroundColor: p.tooltipBg, borderColor: p.axis, textStyle: { color: p.tooltipText, fontSize: 12 },
      formatter: (x: { value: [number, number, number | string] }) =>
        `${esc(names[x.value[1]] ?? "")} × ${esc(names[x.value[0]] ?? "")}：${typeof x.value[2] === "number" ? x.value[2].toFixed(2) : "—"}`,
    },
    xAxis: { type: "category", data: names, axisLabel: { color: p.text, fontSize: 11, interval: 0, rotate: n > 3 ? 35 : 0, formatter: short },
      axisTick: { show: false }, axisLine: { lineStyle: { color: p.axis } } },
    yAxis: { type: "category", data: names, inverse: true, axisLabel: { color: p.text, fontSize: 11, formatter: short }, axisTick: { show: false },
      axisLine: { lineStyle: { color: p.axis } } },
    visualMap: {
      type: "continuous", min: -1, max: 1, calculable: false, orient: "horizontal", left: "center", bottom: 0,
      itemHeight: 140, itemWidth: 10, text: ["1", "-1"], textStyle: { color: p.text, fontSize: 11 },
      inRange: { color: ["#3b82f6", p.neutral, p.primary] },
    },
    series: [{
      type: "heatmap", data, itemStyle: { borderColor: p.grid, borderWidth: 1 },
      label: { show: n <= 12, fontSize: 10, color: p.strong, formatter: (x: { value: [number, number, number | string] }) =>
        (typeof x.value[2] === "number" ? x.value[2].toFixed(2) : "") },
    }],
  };
}
