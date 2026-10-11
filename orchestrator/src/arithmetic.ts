/**
 * **算式自查** —— 文本里自己写出来的算式，重算一遍看对不对。
 *
 * 🔴 为什么需要这一层：引用来的数字可以跟已知值比对，**算出来的数字比不了** ——
 *    它不等于任何一个已知值。于是它成了唯一一类「谁都没在看」的数字，
 *    而它就摆在核对过的数字旁边，看着一样可信。
 *    真实案例：一段文字写「444.64 对 453.90，同比仅增 +0.2%」——
 *    实际是 −2.04%，**方向都反了**；同一段文字在别处又写了 −2.04%，自相矛盾。
 *
 * ⇒ 做法：只要文本把算式写出来了（`A ÷ B − 1 = R%`、`A − B = R` 之类），
 *    就地重算，对不上就点名。**写不出算式的数字另有一条规则**（见 `auditNumbers`）。
 *
 * ⚠️ 这里**只查它自己写下的算式**，不判断算式选得对不对
 *    （拿错了年份的两个数相除，算式本身可以是自洽的）。能查的和不能查的要分清楚，
 *    别让「算式对」被读成「结论对」。
 */

/** 千分位、全角减号、各种除号都归一 */
function toNum(raw: string): number | null {
  const s = raw.replace(/,/g, "").replace(/[−—–]/g, "-").replace(/^\+/, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// ⚠️ 正号要允许:真实文本里写的是 `= +0.2%`,不认正号就**整条算式识别不出来**,
//    于是那句错话安然过关(第一版就是这么漏掉真案例的)。
const NUM = String.raw`[+\-−—–]?\d[\d,]*(?:\.\d+)?`;
// ⚠️ 数字与运算符之间常夹着单位:`444.64 亿 ÷ 453.90 亿 − 1`。
//    不留这个口子,带单位的算式一条都识别不出来 —— 而真实文本里几乎都带单位。
//    只放行**紧跟数字**的少量单位字,不吃普通文字。
// 🔴 单位要**参与运算**,不能只吃掉(Codex 审计 2026-10-09 A7):「2 亿 + 3 万 = 5 亿元」按裸数重算是 2 + 3 = 5,判成对的。
//    数量级(万亿 / 亿 / 万)与 % 各捕获一组,重算前归一;元 / 股 / 倍 只是单位名,不改数值。
const UNIT = String.raw`\s*(万亿|亿|万)?(%|[元股倍]{0,2})`;
/** 结果后面的单位:数量级 + 单位名(写了「元」「倍」也算明确给了单位) */
const RESULT_UNIT = String.raw`\s*(万亿|亿|万)?\s*(%|[元股倍])?`;
const MAG: Record<string, number> = { 万亿: 1e12, 亿: 1e8, 万: 1e4 };

/**
 * 一个带单位的数:v 写出来的数,k 归一系数(亿 = 1e8、% = 0.01),scaled 有没有写数量级或 %,
 * dim 量纲(`%` / `元` / `股` / `倍`,没写单位名是空串)。
 */
interface Term { v: number; k: number; scaled: boolean; dim: string }
function term(raw: string | undefined, mag: string | undefined, suffix: string | undefined): Term | null {
  const v = toNum(raw ?? "");
  if (v === null) return null;
  const dim = suffix === "%" ? "%" : (suffix ?? "").slice(0, 1);
  return { v, k: (mag ? MAG[mag]! : 1) * (suffix === "%" ? 0.01 : 1), scaled: !!mag || suffix === "%", dim };
}

/**
 * 加减两边是不是同一种量。没写单位名的一边按同一种看(「100 元 + 20 = 120 元」);
 * 但 % 必须两边都写:「100 元 + 20% = 100.2 元」把金额和比例相加,不能判成对、更不能让 100.2 拿到出处(审计第二轮 A7)。
 */
const sameDim = (x: string, y: string) => x === y || (x !== "%" && y !== "%" && (!x || !y));

/**
 * 两数运算后的结果,换算回**结果写出来的单位**;单位对不上又判断不了时返回 null(不认这条算式,既不算对也不算错)。
 * - 结果没写单位:加减要求两边同一数量级(「2 亿 + 3 亿 = 5」是省略写法);乘法要求两边都没数量级;
 *   除法要求两边都写或都没写数量级(都写 = 两个金额之比)。否则说不清结果是哪个数量级 → null。
 * - 两边都没单位、结果只写了 %(「35 − 20 = 15%」「0.35 × 100 = 35%」)按老写法直接比。
 */
function binaryResult(op: string, a: Term, b: Term, r: Term & { explicit: boolean; pct: boolean; mag: boolean }): number | null {
  // ⚠️ 乘除不查量纲:「金额 × 百分比」「金额 ÷ 金额 = %」「金额 ÷ 股数 = 元」都是正常写法
  const plusMinus = (x: number, y: number) => (/^\+$/.test(op) ? x + y : x - y);
  if (new RegExp(DIV).test(op)) {
    if (b.v === 0) return null;
    if (!r.explicit) return a.scaled === b.scaled ? (a.v * a.k) / (b.v * b.k) : null;
    return (a.v * a.k) / (b.v * b.k) / r.k;
  }
  const legacyPct = r.pct && !r.mag && a.k === 1 && b.k === 1 && !a.dim && !b.dim;
  if (new RegExp(MUL).test(op)) {
    if (!r.explicit) return a.k === 1 && b.k === 1 ? a.v * b.v : null;
    if (legacyPct) return a.v * b.v;
    return (a.v * a.k * b.v * b.k) / r.k;
  }
  // 加减:量纲不同不认(既不算对也不算错);结果写的量纲和运算数不同也不认
  if (!sameDim(a.dim, b.dim)) return null;
  if (!r.explicit) return a.k === b.k ? plusMinus(a.v, b.v) : null;
  if (legacyPct) return plusMinus(a.v, b.v);
  const opDim = a.dim || b.dim;
  if (r.dim && opDim && !sameDim(opDim, r.dim)) return null;
  return plusMinus(a.v * a.k, b.v * b.k) / r.k;
}
// ⚠️ 运算符与数字之间常夹着一小段**标签**：`÷ 甲项 910.94 亿元`、`= 占比 49.83%`。
//    不留口子的话，这类（实测里最常见的）写法一条都识别不出来 ——
//    而识别不到和「没有算式可查」在结果上长得一模一样。
//    上限 8 个字符，且**不含数字 / 运算符 / 等号**，避免跨到无关的数上去。
const LABEL = String.raw`(?:\s*[^\d=＝+\-−—–*×/÷()（）,，;；]{0,8})?`;
const DIV = String.raw`[/÷]`;
const MINUS = String.raw`[-−—–]`;
const MUL = String.raw`[*×]`;

/** 一条被重算过的算式 */
export interface StatedCalc {
  /** 原文片段 */
  raw: string;
  /** 文本自己给出的结果 */
  stated: number;
  /** 我们重算出来的结果 */
  recomputed: number;
  /** 结果是不是按百分数写的 */
  percent: boolean;
  ok: boolean;
}

/**
 * 允许的误差。写作时会四舍五入（`−2.04%` 其实是 −2.0402…），
 * 所以按**结果量级**给一个宽度，而不是要求逐位相等。
 * ⚠️ 宽度只到能容下四舍五入 —— 再宽就会把「+0.2% vs −2.04%」这种真错也放过去。
 */
function closeEnough(stated: number, recomputed: number): boolean {
  const tol = Math.max(Math.abs(recomputed) * 5e-3, 0.011);
  return Math.abs(stated - recomputed) <= tol;
}

/**
 * 找出一行里**写出来的算式**并重算。
 * 支持四种形状（覆盖「两数相除减一」「差」「和」「倍」）：
 *   `A ÷ B − 1 = R%` · `A − B = R` · `A + B = R` · `A × B = R`
 */
export function checkStatedArithmetic(rawLine: string): StatedCalc[] {
  const out: StatedCalc[] = [];
  // 🔴 先把**标注**剥掉再匹配。算式里常夹着两类东西,它们是注解不是运算数:
  //    ① 证据引用 `[ev-xxxx]` ② 期间标签 `2026H1` / `2025Q3` / `2024FY`。
  //    不剥的话 `2026H1 444.64 亿 ÷ 2025H1 453.90 亿 − 1 = −2.04%` **一条都识别不出来** ——
  //    而这正是我们要求模型写出来的那种形状,识别不出等于这层校验对它完全失效。
  //    ⚠️ 期间标签必须整体剥掉(不能只剥字母):留下 `2026` 会被当成一个运算数。
  const line = rawLine
    .replace(/\[(?:ev|calc)-[0-9a-zA-Z]+(?:\s*[,;]\s*(?:ev|calc)-[0-9a-zA-Z]+)*\]/g, " ")
    .replace(/\b\d{4}\s*(?:[HhQq][1-4]|FY|fy)\b/g, " ")
    .replace(/\b\d{4}\s*年度?/g, " ");
  const push = (raw: string, stated: string, recomputed: number, percent: boolean) => {
    const st = toNum(stated);
    if (st === null || !Number.isFinite(recomputed)) return;
    out.push({ raw: raw.trim(), stated: st, recomputed, percent, ok: closeEnough(st, recomputed) });
  };

  // A ÷ B − 1 = R（R 可带 %；带 % 时重算值要 ×100）。两数各按自己的数量级归一后再相除
  const ratio = new RegExp(
    String.raw`(${NUM})${UNIT}\s*${DIV}${LABEL}\s*(${NUM})${UNIT}\s*${MINUS}\s*1\s*[=＝]${LABEL}\s*(${NUM})${RESULT_UNIT}`, "g");
  for (const m of line.matchAll(ratio)) {
    const a = term(m[1], m[2], m[3]), b = term(m[4], m[5], m[6]), r = term(m[7], m[8], m[9]);
    if (!a || !b || !r || b.v === 0) continue;
    push(m[0]!, m[7]!, ((a.v * a.k) / (b.v * b.k) - 1) / r.k, m[9] === "%");
  }

  // A − B = R / A + B = R / A × B = R / A ÷ B = R（结果可带 %）
  // ⚠️ **纯除法必须支持**：实测里模型写的大多是这种形状
  //    （`453.90 ÷ 910.94 = 49.83%`、`6.43 ÷ 18.14 = 35.4%` —— 两个数相除得一个占比）。
  //    第一版漏了它，于是一段写满算式的产出只认出 1 条 —— 校验覆盖不到的地方，
  //    看起来和"没有算式可查"一模一样。
  const binary = new RegExp(
    String.raw`(${NUM})${UNIT}\s*(${MINUS}|\+|${MUL}|${DIV})${LABEL}\s*(${NUM})${UNIT}\s*[=＝]${LABEL}\s*(${NUM})${RESULT_UNIT}`, "g");
  for (const m of line.matchAll(binary)) {
    const a = term(m[1], m[2], m[3]), b = term(m[5], m[6], m[7]), stated = term(m[8], m[9], m[10]);
    if (!a || !b || !stated) continue;
    const op = m[4]!;
    // ⚠️ `A ÷ B − 1 = R` 已被上一条吃掉；这里再匹到的 `− 1 =` 会重复报，跳过
    if (/^[-−—–]$/.test(op) && b.v === 1 && new RegExp(DIV).test(line)) continue;
    const pct = m[10] === "%";
    // 带 % 的除法是占比：r.k = 0.01，相当于 ×100
    const r = binaryResult(op, a, b, { ...stated, explicit: !!(m[9] || m[10]), pct, mag: !!m[9] });
    if (r === null) continue;
    push(m[0]!, m[8]!, r, pct);
  }
  return out;
}

/** 一个没有着落的数字 */
export interface LooseNumber {
  /** 它出现在哪一行（截断后的） */
  line: string;
  value: number;
  raw: string;
}

export interface NumberAudit {
  /** 需要有着落的数字总数 */
  total: number;
  /** 对得上已知值的 */
  bound: number;
  /** 出现在**自洽算式**里的（算式重算通过） */
  derived: number;
  /** 既对不上已知值、也没写算式的 */
  loose: LooseNumber[];
  /** 写了算式但**重算对不上**的 —— 最要紧的一类 */
  badMath: StatedCalc[];
}

/**
 * 审一段文本里的数字。
 *
 * 三档，**必须分开报**：
 * - `bound`  ——  与已知值对得上（可溯源）
 * - `derived` —— 没有对应的已知值，但文本把算式写出来了且重算通过
 * - `loose`  ——  两样都不是。**不等于错**，但它是「没人在看」的那一档，要让人知道有多少
 *
 * `badMath` 是唯一可以断言「这里错了」的一类：算式是它自己写的，结果对不上。
 */
export function auditNumbers(
  text: string,
  known: number[],
  claims: (line: string) => { n: number; raw: string }[],
  bound: (n: number, pool: number[]) => boolean,
): NumberAudit {
  const res: NumberAudit = { total: 0, bound: 0, derived: 0, loose: [], badMath: [] };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const calcs = checkStatedArithmetic(line);
    res.badMath.push(...calcs.filter((c) => !c.ok));
    // 算式里出现过的数（含结果）都算「有交代」
    const inCalc = new Set<number>();
    for (const c of calcs) {
      if (!c.ok) continue;
      inCalc.add(c.stated);
      for (const m of c.raw.matchAll(new RegExp(NUM, "g"))) {
        const v = toNum(m[0]!);
        if (v !== null) inCalc.add(v);
      }
    }
    for (const t of claims(line)) {
      res.total++;
      if (bound(t.n, known)) res.bound++;
      else if (inCalc.has(t.n)) res.derived++;
      else res.loose.push({ line: line.trim().slice(0, 160), value: t.n, raw: t.raw });
    }
  }
  return res;
}
