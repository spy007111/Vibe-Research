/**
 * 研究分享卡的界面数据和画法(后端见 orchestrator/src/finance/share_card.ts)。
 * 卡片会离开本机被转发:只放事实原值(带日期和来源)、数量、缺口和合规声明;不放报告里的结论、评分、目标价。
 * 画在 canvas 上导出 PNG:竖版 1080×1920(手机)、横版 1920×1080。所有文字先量宽度再画,放不下就截断或少放几行,不会出界、不会叠在一起。
 * 颜色只用墨色 + 一个蓝色强调:红涨绿跌,卡片上不用红绿。
 */
import { sourceName } from "./chatSources.ts";

export type GapKind = "source_failed" | "source_partial" | "upstream_missing" | "insufficient_periods"
  | "not_supported_market" | "upstream_not_meaningful" | "other" | "optional_skipped";
export interface ShareValue { value: number; unit: string; source: string; id: string }
export interface ShareFact { field: string; label: string; kind: "snapshot" | "cum" | "fy"; period: string; values: ShareValue[]; analysts: number | null }
/** count:这一行合并了几处缺口(老接口没有这个字段,按 1 处算) */
export interface ShareGap { operation: string; kind: GapKind; label: string; count?: number }
const gapCount = (gs: ShareGap[]) => gs.reduce((n, g) => n + (g.count ?? 1), 0);
export interface ShareCardResult {
  run_id: string;
  symbol: string;
  market: string;
  name: string | null;
  status: "complete" | "incomplete";
  finished_at: string;
  test_scenario: boolean;
  facts: ShareFact[];
  missing_facts: string[];
  counts: { evidence: number; sources: number; calculations: number | null; stages_done: number; stages_total: number; conflicts: number | null };
  gaps: ShareGap[];
}

export const STATEMENT = "只汇总这次研究取到的公开数据和数量,不含报告里的判断,不评分,不构成投资建议;数据以交易所和公司公告为准。";
export const REPO_LINE = "由 Vibe-Research 生成 · github.com/simonlin1212/Vibe-Research";
export const GAP_POINTER = "原因见报告「数据缺口」一节";
export const GAP_KIND_LABEL: Record<GapKind, string> = {
  source_failed: "没取到", source_partial: "只取到一部分", upstream_missing: "缺上游数据没算", insufficient_periods: "期数不够没算",
  not_supported_market: "这个市场不支持", upstream_not_meaningful: "上游数据不适用", other: "其他", optional_skipped: "这次没做",
};
const MARKET_LABEL: Record<string, string> = { SH: "沪市", SZ: "深市", BJ: "北交所", HK: "港股", US: "美股" };

/** 数字:整数原样;绝对值 ≥ 1 保留两位;更小的留 4 位有效数字 */
export function num(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 1 ? v.toFixed(2) : String(Number(v.toPrecision(4)));
}

/** 金额只换算显示(不是计算):元 → 亿元 / 万元,外币上亿写「亿 USD」;别的单位原样带上 */
export function amount(v: number, unit: string): string {
  const a = Math.abs(v);
  if (unit === "元" && a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿元`;
  if (unit === "元" && a >= 1e4) return `${(v / 1e4).toFixed(2)} 万元`;
  if (/^[A-Z]{3}$/.test(unit) && a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿 ${unit}`;
  if ((unit === "美元" || unit === "港元") && a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿${unit}`;
  return `${num(v)}${unit ? ` ${unit}` : ""}`;
}

/** 同一期各来源的值:换算后显示一样的合成一条(来源并列),不一样的分开列,不替用户挑一个 */
export function factValues(f: ShareFact): { text: string; sources: string }[] {
  const by = new Map<string, string[]>();
  for (const v of f.values) {
    const text = amount(v.value, v.unit);
    const src = v.source ? sourceName(v.source) : "来源未注明";
    const list = by.get(text) ?? [];
    if (!list.includes(src)) list.push(src);
    by.set(text, list);
  }
  return [...by].map(([text, s]) => ({ text, sources: s.join("、") }));
}

export function factMeta(f: ShareFact): string {
  if (f.kind === "cum") return `报告期 ${f.period.replace("..", " 至 ")} · 累计`;
  if (f.kind === "fy") return `${f.period} 全年${f.analysts !== null ? ` · ${f.analysts} 家机构` : ""}`;
  return f.period;
}

/** 北京时间到分钟,带年份:2026-10-08 08:52 */
export function beijingTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export const cardTitle = (r: ShareCardResult) => r.name || r.symbol;
/** 没有名称时标题就是代码,副标题不再重复代码 */
export const cardSubtitle = (r: ShareCardResult) =>
  [r.name ? r.symbol : "", MARKET_LABEL[r.market] ?? r.market, `研究完成于 ${beijingTime(r.finished_at)}(北京时间)`].filter(Boolean).join(" · ");

/** 要醒目标出来的两种情况:测试数据、研究没做完 */
export function cardFlags(r: ShareCardResult): string[] {
  const out: string[] = [];
  if (r.test_scenario) out.push("测试场景:用的是测试数据,不是真实行情");
  if (r.status === "incomplete") out.push(`研究没全部做完:${r.counts.stages_done}/${r.counts.stages_total} 个阶段完成,数据可能不全`);
  return out;
}

/** 数量:取不到写「—」,不写 0 */
export function cardCounts(r: ShareCardResult): { n: string; label: string }[] {
  const c = r.counts;
  const s = (v: number | null) => (v === null ? "—" : String(v));
  return [
    { n: String(c.evidence), label: "条证据" }, { n: String(c.sources), label: "个来源" }, { n: s(c.calculations), label: "项计算" },
    { n: `${c.stages_done}/${c.stages_total}`, label: "个阶段完成" }, { n: s(c.conflicts), label: "处来源冲突" },
  ];
}

export const gapHeading = (r: ShareCardResult) => (r.gaps.length ? `数据缺口 ${gapCount(r.gaps)} 处` : "数据缺口:这次没有记下缺口");

/** 复制用的文字版:和卡片同样的内容,另外把同一期所有来源的值都列全 */
export function shareSummary(r: ShareCardResult): string[] {
  const lines = [`【研究分享卡】${cardTitle(r)}(${cardSubtitle(r)})`];
  for (const f of cardFlags(r)) lines.push(`⚠ ${f}`);
  lines.push("【关键数据】证据原值:");
  for (const f of r.facts) lines.push(`  ${f.label}:${factValues(f).map((v) => `${v.text}(${v.sources})`).join(" / ")} · ${factMeta(f)}`);
  if (r.missing_facts.length) lines.push(`  没取到:${r.missing_facts.join("、")}`);
  lines.push(`【这次研究用了】${cardCounts(r).map((c) => `${c.n} ${c.label}`).join(" · ")}`);
  lines.push(`【${gapHeading(r)}】`);
  for (const g of r.gaps) lines.push(`  ${GAP_KIND_LABEL[g.kind]} · ${g.label}`);
  if (r.gaps.length) lines.push(`  ${GAP_POINTER}`);
  lines.push(STATEMENT, REPO_LINE);
  return lines;
}

// ───────────────────────── 画卡片 ─────────────────────────

export type ShareCtx = Pick<CanvasRenderingContext2D, "font" | "fillStyle" | "strokeStyle" | "lineWidth" | "textAlign" | "textBaseline"
  | "fillText" | "measureText" | "fillRect">;
export const CARD_SIZE = { portrait: { w: 1080, h: 1920 }, landscape: { w: 1920, h: 1080 } } as const;
export type CardLayout = keyof typeof CARD_SIZE;

const PAL = { bg: "#FAFAF7", ink: "#1A1A1A", muted: "#6B6B6B", accent: "#2F5BEA", line: "#E2E0DA", flag: "#EAEFFC" };
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif';

interface Style { size: number; weight?: number; color?: string }
function setStyle(ctx: ShareCtx, s: Style): void {
  ctx.font = `${s.weight ?? 400} ${s.size}px ${FONT}`;
  ctx.fillStyle = s.color ?? PAL.ink;
}
const width = (ctx: ShareCtx, t: string) => ctx.measureText(t).width;

/** 放得下原样;放不下从尾部去字补「…」;一个字都放不下返回空串 */
export function fitText(ctx: ShareCtx, text: string, maxW: number): string {
  if (width(ctx, text) <= maxW) return text;
  const chars = [...text];
  while (chars.length && width(ctx, `${chars.join("")}…`) > maxW) chars.pop();
  return chars.length ? `${chars.join("")}…` : "";
}

/** 按字折行(中文没有空格可断);超过 maxLines 行时最后一行截断 */
export function wrapText(ctx: ShareCtx, text: string, maxW: number, maxLines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const ch of [...text]) {
    if (line && width(ctx, line + ch) > maxW) { out.push(line); line = ch; } else line += ch;
  }
  if (line) out.push(line);
  if (out.length <= maxLines) return out;
  const keep = out.slice(0, maxLines);
  keep[maxLines - 1] = fitText(ctx, out.slice(maxLines - 1).join(""), maxW);
  return keep;
}

/** 画一行字(顶端对齐),先截断到 maxW;返回实际画出的宽度 */
function put(ctx: ShareCtx, text: string, x: number, y: number, maxW: number, s: Style, align: "left" | "right" = "left"): number {
  setStyle(ctx, s);
  const t = fitText(ctx, text, maxW);
  if (!t) return 0;
  ctx.textAlign = align;
  ctx.fillText(t, x, y);
  return width(ctx, t);
}

function hairline(ctx: ShareCtx, x: number, y: number, w: number): void {
  ctx.fillStyle = PAL.line;
  ctx.fillRect(x, y, w, 2);
}

/** 一项事实的版式:名称 + 日期一行(放不下日期挪到下一行) → 每个值一行(值 + 来源,来源放不下挪到下一行) */
interface FactBox { label: string; meta: string; metaOwn: boolean; values: { text: string; sources: string; own: boolean }[]; more: number }
const FACT = { label: 26, meta: 22, value: 40, source: 22, gap: 14 };

function factBox(ctx: ShareCtx, f: ShareFact, w: number, compact: boolean): FactBox {
  const all = factValues(f);
  const shown = all.slice(0, compact ? 1 : 2);
  setStyle(ctx, { size: FACT.label, weight: 600 });
  const lw = width(ctx, f.label);
  setStyle(ctx, { size: FACT.meta });
  const meta = factMeta(f);
  const metaOwn = lw + 16 + width(ctx, meta) > w;
  const values = shown.map((v) => {
    setStyle(ctx, { size: FACT.value, weight: 700 });
    const vw = width(ctx, v.text);
    setStyle(ctx, { size: FACT.source });
    return { ...v, own: vw + 14 + width(ctx, v.sources) > w };
  });
  return { label: f.label, meta, metaOwn, values, more: all.length - shown.length };
}

function factHeight(b: FactBox): number {
  let h = FACT.label + 10 + (b.metaOwn ? FACT.meta + 8 : 0);
  for (const v of b.values) h += FACT.value + 12 + (v.own ? FACT.source + 8 : 0);
  if (b.more) h += FACT.source + 8;
  return h;
}

function drawFact(ctx: ShareCtx, b: FactBox, x: number, y: number, w: number): void {
  const lw = put(ctx, b.label, x, y, w, { size: FACT.label, weight: 600, color: PAL.muted });
  let cy = y + FACT.label + 10;
  if (b.metaOwn) {
    put(ctx, b.meta, x, cy - 4, w, { size: FACT.meta, color: PAL.muted });
    cy += FACT.meta + 8;
  } else {
    put(ctx, b.meta, x + w, y + (FACT.label - FACT.meta), w - lw - 16, { size: FACT.meta, color: PAL.muted }, "right");
  }
  for (const v of b.values) {
    const vw = put(ctx, v.text, x, cy, w, { size: FACT.value, weight: 700 });
    if (v.own) {
      put(ctx, v.sources, x, cy + FACT.value + 4, w, { size: FACT.source, color: PAL.muted });
      cy += FACT.value + 12 + FACT.source + 8;
    } else {
      put(ctx, v.sources, x + vw + 14, cy + (FACT.value - FACT.source) - 4, w - vw - 14, { size: FACT.source, color: PAL.muted });
      cy += FACT.value + 12;
    }
  }
  if (b.more) put(ctx, `另有 ${b.more} 个来源数值不同,见文字版`, x, cy, w, { size: FACT.source, color: PAL.accent });
}

/** 事实排成 cols 列;总高超过 maxH 就改紧凑版(每项只放一个值并注明另有几个);还放不下就少放几行,返回放掉了几项 */
function layoutFacts(ctx: ShareCtx, facts: ShareFact[], cols: number, colW: number, gapX: number, maxH: number) {
  const rowsOf = (compact: boolean) => {
    const boxes = facts.map((f) => factBox(ctx, f, colW, compact));
    const rows: { boxes: FactBox[]; h: number }[] = [];
    for (let i = 0; i < boxes.length; i += cols) {
      const row = boxes.slice(i, i + cols);
      rows.push({ boxes: row, h: Math.max(...row.map(factHeight)) + FACT.gap * 2 });
    }
    return rows;
  };
  const total = (rows: { h: number }[]) => rows.reduce((s, r) => s + r.h, 0);
  let rows = rowsOf(false);
  if (total(rows) > maxH) rows = rowsOf(true);
  const kept: typeof rows = [];
  let used = 0;
  for (const r of rows) {
    if (used + r.h > maxH) break;
    kept.push(r);
    used += r.h;
  }
  return {
    height: used,
    dropped: rows.slice(kept.length).reduce((s, r) => s + r.boxes.length, 0),
    draw: (x: number, y: number) => {
      let cy = y;
      for (const r of kept) {
        r.boxes.forEach((b, i) => drawFact(ctx, b, x + i * (colW + gapX), cy, colW));
        cy += r.h;
      }
    },
  };
}

/** 只量不画:试排一遍用。字体设在真的 ctx 上(量宽度要用),画的动作全部丢掉 */
function dryRun(ctx: ShareCtx): ShareCtx {
  return {
    get font() { return ctx.font; },
    set font(v: string) { ctx.font = v; },
    fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "left", textBaseline: "top",
    fillText: () => undefined, fillRect: () => undefined, measureText: (t: string) => ctx.measureText(t),
  } as ShareCtx;
}

/**
 * 画整张卡。版式:页眉(名称、代码、完成时间、醒目标记) → 关键数据 → 数量 → 缺口 → 页脚(声明 + 出处)。
 * 竖版从上往下排;横版左边放关键数据,右边放数量和缺口。缺口放在最后,剩多少地方放多少条,其余写「还有 N 处」。
 * 竖版内容少时下面会空一大块:先试排一遍,把剩下的高度分到三处段落间距里(每处最多 120)。
 */
export function drawShareCard(ctx: ShareCtx, r: ShareCardResult, layout: CardLayout): void {
  let spread = 0;
  if (layout === "portrait") {
    const dry = paint(dryRun(ctx), r, layout, 0);
    spread = Math.min(120, Math.floor((Math.max(0, dry.limit - dry.end - 44) * 0.9) / 3));
  }
  paint(ctx, r, layout, spread);
}

/** 返回内容画到的最低处和不许越过的线,给试排算剩余高度 */
function paint(ctx: ShareCtx, r: ShareCardResult, layout: CardLayout, spread: number): { end: number; limit: number } {
  const { w: W, h: H } = CARD_SIZE[layout];
  const land = layout === "landscape";
  const P = land ? 80 : 88;
  const inner = W - 2 * P;
  ctx.textBaseline = "top";
  ctx.fillStyle = PAL.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = PAL.accent;
  ctx.fillRect(0, 0, W, 12);

  // 页脚先量:声明折行后的高度定下页脚顶端,其余内容不许越过它
  setStyle(ctx, { size: 24 });
  const stmt = wrapText(ctx, STATEMENT, inner, 3);
  const footTop = H - P - stmt.length * 36 - 40;
  hairline(ctx, P, footTop - 24, inner);
  stmt.forEach((l, i) => put(ctx, l, P, footTop + i * 36, inner, { size: 24, color: PAL.muted }));
  put(ctx, REPO_LINE, P, footTop + stmt.length * 36 + 8, inner, { size: 22, color: PAL.muted });
  const limit = footTop - 48;

  // 页眉:左边品牌,右边研究编号(和报告对得上);醒目标记竖版排在副标题下面,横版放右上角
  let y = land ? 64 : 96;
  const kw = put(ctx, "VIBE RESEARCH · 研究分享卡", P, y, inner * 0.6, { size: land ? 24 : 28, weight: 600, color: PAL.accent });
  put(ctx, `研究编号 ${r.run_id}`, W - P, y + 4, inner - kw - 32, { size: 22, color: PAL.muted }, "right");
  y += land ? 48 : 60;
  const flags = cardFlags(r);
  const flagW = land ? 760 : inner;
  const titleW = land && flags.length ? inner - flagW - 40 : inner;
  let fy = y;
  put(ctx, cardTitle(r), P, y, titleW, { size: land ? 64 : 80, weight: 700 });
  y += land ? 84 : 104;
  put(ctx, cardSubtitle(r), P, y, titleW, { size: land ? 26 : 30, color: PAL.muted });
  y += land ? 48 : 56;
  if (!land) fy = y;
  for (const f of flags) {
    const fx = land ? W - P - flagW : P;
    ctx.fillStyle = PAL.flag;
    ctx.fillRect(fx, fy, flagW, 56);
    ctx.fillStyle = PAL.accent;
    ctx.fillRect(fx, fy, 6, 56);
    put(ctx, f, fx + 24, fy + 14, flagW - 44, { size: 26, weight: 600, color: PAL.accent });
    fy += 68;
  }
  y = Math.max(y, fy) + 12;
  hairline(ctx, P, y, inner);
  y += 34 + spread;

  // 关键数据:竖版两列占满宽;横版三列占左边约 62%
  const leftW = land ? Math.round(inner * 0.62) : inner;
  const cols = land ? 3 : 2;
  const colGap = 40;
  const colW = (leftW - colGap * (cols - 1)) / cols;
  const hw = put(ctx, "关键数据", P, y, leftW, { size: 32, weight: 700 });
  put(ctx, "证据里的原值,带日期和来源;同一期几个来源的值都列出", P + hw + 20, y + 8, leftW - hw - 20, { size: 22, color: PAL.muted });
  const sectionTop = y;
  y += 56;
  // 竖版:关键数据下面还要留出数量块、缺口标题和一行提示(共约 352);横版这几块在右栏。另留两行给「没取到」。
  // 按没加段落间距时的位置算,和试排一模一样:间距是从试排剩下的空白里分出来的,不能反过来挤得关键数据改紧凑版
  const below = land ? 0 : 352;
  const facts = layoutFacts(ctx, r.facts, cols, colW, colGap, Math.max(0, limit - below - (y - spread) - 76));
  facts.draw(P, y);
  y += facts.height;
  const miss: string[] = [];
  if (r.missing_facts.length) miss.push(`没取到:${r.missing_facts.join("、")}`);
  if (facts.dropped) miss.push(`另有 ${facts.dropped} 项放不下,见文字摘要`);
  if (!r.facts.length && !r.missing_facts.length) miss.push("这次研究没有可上卡的数据");
  if (miss.length) {
    setStyle(ctx, { size: 24 });
    for (const l of wrapText(ctx, miss.join(";"), leftW, 2)) { put(ctx, l, P, y, leftW, { size: 24, color: PAL.muted }); y += 36; }
    y += 4;
  }

  // 数量 + 缺口:竖版接着往下;横版放右栏,和「关键数据」标题齐平
  const rx = land ? P + leftW + 72 : P;
  const rw = land ? W - P - rx : inner;
  let ry = sectionTop;
  if (!land) { ry = y + 16 + spread; hairline(ctx, P, ry, inner); ry += 30; }
  put(ctx, "这次研究用了", rx, ry, rw, { size: 32, weight: 700 });
  ry += 56;
  const counts = cardCounts(r);
  const perRow = land ? 3 : 5;
  const cellW = rw / perRow;
  counts.forEach((c, i) => {
    const cx = rx + (i % perRow) * cellW;
    const cy = ry + Math.floor(i / perRow) * 104;
    put(ctx, c.n, cx, cy, cellW - 16, { size: 52, weight: 700, color: PAL.accent });
    put(ctx, c.label, cx, cy + 62, cellW - 16, { size: 22, color: PAL.muted });
  });
  ry += Math.ceil(counts.length / perRow) * 104 + 16 + (land ? 0 : spread);
  hairline(ctx, rx, ry, rw);
  ry += 30;

  put(ctx, gapHeading(r), rx, ry, rw, { size: 32, weight: 700 });
  ry += 56;
  if (!r.gaps.length) return { end: ry, limit };
  const lineH = 44;
  const room = Math.max(1, Math.floor((limit - ry) / lineH));
  const n = r.gaps.length + 1 <= room ? r.gaps.length : room - 1;
  for (const g of r.gaps.slice(0, n)) {
    const kw = put(ctx, GAP_KIND_LABEL[g.kind], rx, ry, rw * 0.45, { size: 26, weight: 600, color: PAL.muted });
    put(ctx, g.label, rx + kw + 16, ry, rw - kw - 16, { size: 26 });
    ry += lineH;
  }
  const rest = gapCount(r.gaps.slice(n));
  put(ctx, rest ? `还有 ${rest} 处;${GAP_POINTER}` : GAP_POINTER, rx, ry, rw, { size: 22, color: PAL.accent });
  return { end: ry + 22, limit };
}
