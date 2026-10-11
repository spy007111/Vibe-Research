/**
 * 涨停分档的界面数据(后端见 orchestrator/src/finance/review_tiers.ts)。
 * 复盘那天的涨停股按东财行业归类、和前两个交易日比,按只数分四档。档位是固定规则,不判断能不能持续。
 */
export type TierId = "mainline" | "today" | "scattered" | "single";

export interface TierStock {
  symbol: string; name: string; industry: string; boards: number | null; tags: string[];
  /** 首次封板时间 HH:MM:SS;后端按 连板数 → 首封早 → 代码 排好,每组第一只就是这组的最高板 */
  first_seal?: string | null;
}
export interface TierGroup {
  industry: string;
  tier: TierId;
  today: number;
  prev: [number | null, number | null];
  stocks: TierStock[];
  tags: { tag: string; count: number }[];
  note: string;
}
export interface ReviewTiersResult {
  date: string;
  prev_dates: [string | null, string | null];
  total: number | null;
  groups: TierGroup[];
  tiers: { id: TierId; label: string; rule: string; industries: number; stocks: number }[];
  fetched_at: string | null;
  cached: boolean;
  generated_at: string;
  gaps: string[];
  source: string;
}

/** 和后端 TIERS 同序同名同规则(后端测试逐项核对) */
export const TIERS: { id: TierId; label: string; rule: string }[] = [
  { id: "mainline", label: "连续集中", rule: "今天同一行业 ≥ 3 只涨停,前两个交易日每天也 ≥ 2 只" },
  { id: "today", label: "今天集中", rule: "今天同一行业 ≥ 3 只涨停,前两个交易日不是每天都 ≥ 2 只" },
  { id: "scattered", label: "零散", rule: "今天同一行业 2 只涨停" },
  { id: "single", label: "单只", rule: "今天这个行业只有 1 只涨停" },
];

export const prevText = (g: TierGroup) => g.prev.map((p) => (p === null ? "—" : String(p))).join(" / ");

/**
 * 这一组的梯队:按连板数数只数,高的在前(「4 板 1 · 2 板 1 · 首板 3」)。连板数没取到的不进梯队、单列「板数不明」。
 * 看的是这个行业有没有一层层跟着的,还是只有一只孤零零的高标 —— 是计数,不是判断。
 */
export function ladderOf(g: TierGroup): { boards: number; count: number }[] {
  const m = new Map<number, number>();
  for (const s of g.stocks) if (s.boards !== null && s.boards >= 1) m.set(s.boards, (m.get(s.boards) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[0] - a[0]).map(([boards, count]) => ({ boards, count }));
}
export function ladderText(g: TierGroup): string {
  const parts = ladderOf(g).map((x) => `${x.boards === 1 ? "首板" : `${x.boards} 板`} ${x.count}`);
  const unknown = g.stocks.filter((s) => s.boards === null || s.boards < 1).length;
  if (unknown) parts.push(`板数不明 ${unknown}`);
  return parts.join(" · ");
}
/** 这一组的最高板(连板数最多、同样多时首封最早的那只);连板数都没取到时没有 */
export function topOf(g: TierGroup): TierStock | null {
  const s = g.stocks[0];
  return s && s.boards !== null ? s : null;
}
export const topText = (s: TierStock) => `${s.name || s.symbol}(${s.boards === 1 ? "首板" : `${s.boards} 连板`}${s.first_seal ? `,${s.first_seal.slice(0, 5)} 首封` : ""})`;
export const stockText = (s: TierStock) => `${s.name || s.symbol}${s.boards && s.boards > 1 ? `(${s.boards} 连板)` : ""}`;

/**
 * 喂给复盘提示词的几行:按档写,单只的只列行业名。
 * 没算出来(没有分组)时只写缺口,不写空的四档 —— 空档会被读成「今天没有集中的行业」。
 */
export function tiersSummary(res: ReviewTiersResult | null): string[] {
  if (!res) return [];
  const lines: string[] = [];
  if (res.groups.length) {
    lines.push(`【涨停分档·${res.date}】${res.total ?? 0} 只涨停按东财行业归类(行业名是东财截短的,最长 4 个字),和前两个交易日(${res.prev_dates.map((d) => d ?? "没找到").join("、")})比;档位按只数的固定规则分,不代表能否持续:`);
    for (const t of TIERS) {
      const g = res.groups.filter((x) => x.tier === t.id);
      if (!g.length) continue;
      if (t.id === "single") { lines.push(`${t.label}(${t.rule}):${g.map((x) => x.industry).join("、")}`); continue; }
      lines.push(`${t.label}(${t.rule}):`);
      for (const x of g) {
        const prev = x.prev.map((p) => (p === null ? "没取到" : String(p))).join(" / ");
        const top = topOf(x);
        lines.push(`  ${x.industry} ${x.today} 只(前两个交易日 ${prev}):${x.stocks.map(stockText).join("、")}`
          + (top ? `;最高板 ${topText(top)};梯队 ${ladderText(x)}` : "")
          + (x.tags.length ? `;同花顺题材标签 ${x.tags.map((y) => `${y.tag}×${y.count}`).join("、")}` : "")
          + (x.note ? `;${x.note}` : ""));
      }
    }
  }
  for (const g of res.gaps) lines.push(`【缺口·涨停分档】${g}`);
  return lines;
}

/** 复盘提示词里关于分档和写法的要求(页面测试核对) */
export const TIER_PROMPT_RULES =
  "④ 板块与题材部分按【涨停分档】的顺序写:连续集中 → 今天集中 → 零散 → 单只;零散和单只一句带过,分档没取到就不分档、照实说;" +
  "⑤ 每个小标题不超过 25 个字;术语第一次出现写全(例如「连板」写成「连续涨停」);" +
  "不用「共振」「狂飙」「史诗级」「炸裂」「起飞」「疯涨」「暴涨」这类渲染词。";
