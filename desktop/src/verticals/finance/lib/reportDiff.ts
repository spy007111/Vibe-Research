/**
 * 同一家公司两次研究报告的对比:按「## 章节」对齐,逐行比。
 * 证据编号(ev-…)和计算编号(calc-…)每次运行都会重新生成,比较前先去掉 —— 不去的话每一行都算「改了」。
 * 只并列两次写了什么,不解读、不判断好坏。
 */

export interface Section { title: string; lines: string[] }
export interface LineOp { op: "add" | "del"; text: string }
export interface SectionDiff {
  title: string;
  status: "same" | "changed" | "added" | "removed";
  added: number;
  removed: number;
  /** 只列增删的行(按新版顺序穿插),没变的行不列 */
  ops: LineOp[];
}

const ID_ONE = String.raw`(?:\[(?:ev|calc)-[0-9a-f]{6,}\]|\b(?:ev|calc)-[0-9a-f]{6,}\b)`;
/** 连着写的几个编号(「[calc-a] / [calc-b]」「[ev-a]、[ev-b]」)当一个整体去掉,不留下孤零零的「/」 */
const ID_MARK = new RegExp(`${ID_ONE}(?:\\s*[/、,，]\\s*${ID_ONE})*`, "gi");
const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

/** 去掉编号,再收拾编号留下的空括号和标点前的空格(「倍 [calc-…],」→「倍,」、「(如 [ev-…] / [ev-…])」→ 删掉) */
export function stripIds(s: string): string {
  return s.replace(ID_MARK, "")
    .replace(/[(（]\s*(?:如|见|另见)?[\s/、,，;；]*[)）]/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ([,，。;；:：、)）])/g, "$1")
    .trim();
}

/** 第一个「## 」之前是标题和运行信息,每次都不同,不参与比较 */
export function splitSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h && !raw.startsWith("###")) { cur = { title: h[1]!.trim(), lines: [] }; out.push(cur); continue; }
    if (cur && raw.trim()) cur.lines.push(raw.trimEnd());
  }
  return out;
}

/** 比较用的键:去掉编号、压空白;表格分隔行和空行不算内容 */
export function lineKey(s: string): string {
  if (TABLE_RULE.test(s.trim())) return "";
  return stripIds(s).replace(/\s*\|\s*/g, "|");
}

/** 给人看的样子:表格行拆成「格 · 格」,去掉编号和加粗记号 */
export function displayLine(s: string): string {
  const t = stripIds(s.replace(/\*\*/g, ""));
  if (t.startsWith("|")) return t.split("|").map((c) => c.trim()).filter((c) => c && !/^[/、,，\s]+$/.test(c)).join(" · ");
  return t.replace(/^#{3,}\s*/, "");
}

/** 最长公共子序列逐行对齐;太大时退回按集合比(只会多报,不会漏报) */
export function diffLines(a: string[], b: string[]): LineOp[] {
  const A = a.map((l) => ({ l, k: lineKey(l) })).filter((x) => x.k);
  const B = b.map((l) => ({ l, k: lineKey(l) })).filter((x) => x.k);
  if (A.length * B.length > 250_000) {
    const ka = new Set(A.map((x) => x.k)), kb = new Set(B.map((x) => x.k));
    return [...A.filter((x) => !kb.has(x.k)).map((x) => ({ op: "del" as const, text: displayLine(x.l) })),
      ...B.filter((x) => !ka.has(x.k)).map((x) => ({ op: "add" as const, text: displayLine(x.l) }))];
  }
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i]![j] = A[i]!.k === B[j]!.k ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const ops: LineOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i]!.k === B[j]!.k) { i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ op: "del", text: displayLine(A[i++]!.l) });
    else ops.push({ op: "add", text: displayLine(B[j++]!.l) });
  }
  while (i < n) ops.push({ op: "del", text: displayLine(A[i++]!.l) });
  while (j < m) ops.push({ op: "add", text: displayLine(B[j++]!.l) });
  return ops;
}

/** 两份报告逐节对比:新版的章节按新版顺序,旧版有、新版没有的放最后 */
export function diffReports(base: string, next: string): SectionDiff[] {
  // 同名章节按出现次序配对(极少见,但别把第二个「事实」和第一个比)
  const keyed = (secs: Section[]) => {
    const seen = new Map<string, number>();
    return secs.map((s) => { const k = lineKey(s.title); const n = seen.get(k) ?? 0; seen.set(k, n + 1); return { key: `${k}#${n}`, s }; });
  };
  const B = keyed(splitSections(base)), N = keyed(splitSections(next));
  const baseBy = new Map(B.map((x) => [x.key, x.s]));
  const nextKeys = new Set(N.map((x) => x.key));
  const out: SectionDiff[] = [];
  for (const { key, s } of N) {
    const old = baseBy.get(key);
    const ops = diffLines(old?.lines ?? [], s.lines);
    const added = ops.filter((o) => o.op === "add").length, removed = ops.length - added;
    out.push({ title: s.title, status: !old ? "added" : ops.length ? "changed" : "same", added, removed, ops });
  }
  for (const { key, s } of B) {
    if (nextKeys.has(key)) continue;
    const ops = diffLines(s.lines, []);
    out.push({ title: s.title, status: "removed", added: 0, removed: ops.length, ops });
  }
  return out;
}

// ---------------------------------------------------------------- 选哪一次来比

/** 「关键数据」里盯的字段的中文名;没列到的照原样显示 */
const FIELD_CN: Record<string, string> = {
  price: "股价", total_market_cap: "总市值", pe_ttm: "市盈率(TTM)", pe_ttm_latest: "最新市盈率(TTM)", pb: "市净率",
  eps_consensus_mean: "一致预期每股收益", eps_analyst_count: "预测机构数", revenue_cum: "营业收入(累计)",
  net_profit_parent_cum: "归母净利润(累计)", net_profit_deducted_cum: "扣非净利润(累计)", margin_financing_balance_latest: "融资余额",
  shareholder_count: "股东户数", lockup_upcoming_count: "待解禁批次", dragon_tiger_count: "龙虎榜次数", block_trade_count: "大宗交易笔数",
  research_report_count_1y: "近一年研报数", announcement_title: "公告",
};
export const fieldLabel = (f: string) => FIELD_CN[f] ?? f;

/** 一侧的值:上亿写「亿」、上十万写「万」,单位跟在每一侧后面(两侧量级可能不同)。不是数字就原样显示 */
export function showValue(v: unknown, unit: string): string {
  if (v === null || v === undefined || v === "") return "—";
  const u = unit && unit !== "text" ? unit : "";
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return u ? `${String(v)} ${u}` : String(v);
  const a = Math.abs(n);
  // 单位里已经带「万 / 亿」(如 亿元)就不再换算,否则会写出「万万元」
  const mag = /[万亿]/.test(u) ? "" : a >= 1e8 ? "亿" : a >= 1e5 ? "万" : "";
  const num = String(mag === "亿" ? +(n / 1e8).toFixed(2) : mag === "万" ? +(n / 1e4).toFixed(2) : n);
  if (!mag && u === "%") return `${num}%`;
  return [num, mag + u].filter(Boolean).join(" ");
}

export interface RunLite { run_id: string; status: string | null; symbol: string | null; market: string | null; started_at: string | null; finished_at: string | null; test_scenario: boolean }
const when = (r: RunLite) => r.finished_at ?? r.started_at ?? "";

/** 能拿来比的其他运行:同一代码、同一市场、同为测试或非测试、跑完且没失败;新的在前 */
export function comparableRuns<T extends RunLite>(cur: T, runs: T[]): T[] {
  return runs.filter((r) => r.run_id !== cur.run_id && !!r.symbol && r.symbol === cur.symbol && (r.market ?? "") === (cur.market ?? "")
    && r.test_scenario === cur.test_scenario && r.status !== "failed" && !!r.finished_at)
    .sort((a, b) => when(b).localeCompare(when(a)));
}

/** 默认和「这次之前最近的一次」比;这次已经是最早的,就和最新的一次比 */
export function defaultPeer(cur: RunLite, peers: RunLite[]): string | null {
  return (peers.find((p) => when(p) < when(cur)) ?? peers[0])?.run_id ?? null;
}

/** 两次按时间排好:旧的在前 */
export const ordered = <T extends RunLite>(a: T, b: T): [T, T] => (when(a) <= when(b) ? [a, b] : [b, a]);
