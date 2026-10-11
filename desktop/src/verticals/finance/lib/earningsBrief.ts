/**
 * 财报前瞻与复盘的界面数据(后端见 orchestrator/src/finance/earnings_brief.ts)。
 * 数字都是 calc 算好的:界面只照抄 display,另外只给正数补一个「+」;金额只做元 → 亿元的换算显示。
 * 只描述过去,不预测下一次;不出目标价。
 */
export type Timing = "before_open" | "during" | "after_close";
export type Market = "CN" | "US" | "HK";
export interface Num { status: string; value: number | null; display: string | null; reason: string }

export interface PastReport {
  id: string;
  period: string;
  published: string;
  timing: Timing | null;
  reaction_day: string | null;
  merged: string[];
  move: Num | null;
  pending: boolean;
  surprise: null | (Num & { basis: "consensus" | "forecast"; actual: number; estimate: number; low: number | null; high: number | null; position_label: string | null; unit: string });
}

export interface EarningsBriefResult {
  symbol: string;
  market: Market;
  upcoming: null | { period: string | null; label: string; date: string; days: number | null; note: string };
  consensus: null | { label: string; unit: string; mean: number; low: number | null; high: number | null; count: number | null; dispersion: Num | null; revenue_mean: number | null };
  forecast: null | { period: string; notice_date: string; type: string; lower: number | null; upper: number | null; change_lower: number | null; change_upper: number | null };
  history: PastReport[];
  reaction: null | { mean_abs: Num; prior_n: number; lookback: number; latest_vs_mean: Num; latest_id: string };
  intraday: boolean;
  fetched_at: string | null;
  cached: boolean;
  generated_at: string;
  gaps: string[];
  sources: string[];
}

/** 和后端同名同义(后端测试逐项核对) */
export const TIMING_LABEL: Record<Timing, string> = { before_open: "开盘前发布", during: "盘中发布", after_close: "收盘后发布" };
export const MOVE_RULE = "涨跌 = 财报后第一个交易日收盘 ÷ 前一交易日收盘 − 1,用复权价,含当天大盘涨跌";
export const PAST_ONLY = "只描述过去几次财报后的表现,不预测下一次,不构成投资建议";

/** calc 的 display 照抄;算出来的正数补「+」;没算出来返回 null(界面写「—」,不写 0) */
export function signed(n: Num | null | undefined): string | null {
  if (!n || n.status !== "ok" || !n.display) return null;
  return n.value !== null && n.value > 0 && !n.display.startsWith("+") ? `+${n.display}` : n.display;
}

export const daysText = (days: number | null) =>
  days === null ? "" : days > 0 ? `还有 ${days} 天` : days === 0 ? "就是今天" : `已过 ${-days} 天`;

/** 金额:元 → 亿元 / 万元、外币上亿的写「亿 USD」(只是换算显示,不是计算);每股收益这类小数原样带单位 */
export function amountText(v: number | null, unit: string): string {
  if (v === null) return "—";
  if (/^[A-Z]{3}$/.test(unit) && Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)} 亿 ${unit}`;
  if (unit !== "元") return `${v}${unit ? ` ${unit}` : ""}`;
  const a = Math.abs(v);
  return a >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿元` : a >= 1e4 ? `${(v / 1e4).toFixed(2)} 万元` : `${v} 元`;
}

const pctRaw = (p: number | null) => (p === null ? "—" : `${p > 0 ? "+" : ""}${p}%`);

export function moveText(h: PastReport): string {
  if (h.pending) return "反应待定";
  return signed(h.move) ?? "—";
}

/** A 股只有正式披露日(东财预约表),没有发布时刻:后端按「当天开盘前已可见」算反应日,这里不把这个假设写成「开盘前发布」 */
export const publishedText = (h: PastReport, market: Market) =>
  `${h.published}${market === "CN" && h.timing ? " 正式披露" : h.timing ? ` ${TIMING_LABEL[h.timing]}` : "(发布时刻不明)"}`;

export function surpriseText(s: NonNullable<PastReport["surprise"]>): string {
  const dev = signed(s);
  if (s.basis === "forecast") {
    return `实际归母净利 ${amountText(s.actual, s.unit)},业绩预告 ${amountText(s.low, s.unit)} ~ ${amountText(s.high, s.unit)}`
      + `${s.position_label ? `,${s.position_label}` : ""}${dev ? `(比预告中点 ${dev})` : s.reason ? `(${s.reason})` : ""}`;
  }
  return `实际每股收益 ${amountText(s.actual, s.unit)},预期 ${amountText(s.estimate, s.unit)}${dev ? `,偏差 ${dev}` : s.reason ? `(${s.reason})` : ""}`;
}

export function forecastText(f: NonNullable<EarningsBriefResult["forecast"]>): string {
  const change = f.change_lower === null && f.change_upper === null ? "" : `,同比 ${pctRaw(f.change_lower)} ~ ${pctRaw(f.change_upper)}`;
  return `${f.type ? `${f.type} · ` : ""}归母净利 ${amountText(f.lower, "元")} ~ ${amountText(f.upper, "元")}${change}(${f.notice_date} 公告)`;
}

export function consensusRange(c: NonNullable<EarningsBriefResult["consensus"]>): string {
  const u = c.unit ? ` ${c.unit}` : "";
  return `${c.low === null ? "—" : c.low} ~ ${c.high === null ? "—" : c.high}${u}${c.count === null ? "" : ` · ${c.count} 家`}`;
}

/** 最近一次和此前平均的对照句;算不出来时写原因 */
export function reactionLine(r: NonNullable<EarningsBriefResult["reaction"]>): string {
  const mean = signed(r.mean_abs);
  if (!mean) return r.mean_abs.reason || "此前的次数不够,没算平均";
  const ratio = r.latest_vs_mean.status === "ok" && r.latest_vs_mean.display ? r.latest_vs_mean.display : null;
  return `此前 ${r.prior_n} 次财报后当天涨跌的绝对值平均 ${mean.replace(/^\+/, "")}`
    + (ratio ? `;最近一次(${r.latest_id})是平均的 ${ratio}` : r.latest_vs_mean.reason ? `;最近一次(${r.latest_id})没比:${r.latest_vs_mean.reason}` : "");
}

/** 喂给「问 Agent」的几行;没取到的写缺口,不写空栏 */
export function earningsSummary(res: EarningsBriefResult | null): string[] {
  if (!res) return [];
  const lines: string[] = [];
  if (res.upcoming) lines.push(`【财报前瞻】下一份:${res.upcoming.label} ${res.upcoming.date}(${daysText(res.upcoming.days)});${res.upcoming.note}`);
  if (res.consensus) {
    const c = res.consensus;
    lines.push(`【一致预期】${c.label}:均值 ${c.mean}${c.unit ? ` ${c.unit}` : ""},区间 ${consensusRange(c)}`
      + (c.dispersion?.status === "ok" && c.dispersion.display ? `,最高 ÷ 最低 ${c.dispersion.display}` : "")
      + (c.revenue_mean !== null ? `;营收预期均值 ${amountText(c.revenue_mean, c.unit)}` : ""));
  }
  if (res.forecast) lines.push(`【业绩预告·下一期】${forecastText(res.forecast)}`);
  if (res.history.length) {
    lines.push(`【财报复盘】${MOVE_RULE};${PAST_ONLY}:`);
    for (const h of res.history) {
      lines.push(`  ${h.id}(${publishedText(h, res.market)})`
        + (h.reaction_day ? ` → ${h.reaction_day} ${moveText(h)}` : h.pending ? " → 反应待定" : "")
        + (h.merged.length ? `(和 ${h.merged.join("、")} 同一个反应日)` : "")
        + (h.surprise ? `;${surpriseText(h.surprise)}` : ""));
    }
    if (res.reaction) lines.push(`  ${reactionLine(res.reaction)}`);
    if (res.intraday) lines.push("  最近一次的反应日就是今天、还没收盘:涨跌按最新价,收盘后会变");
  }
  for (const g of res.gaps) lines.push(`【缺口·财报】${g}`);
  return lines;
}
