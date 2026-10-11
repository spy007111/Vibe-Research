/**
 * 算式自查。**用例全部来自一次真实辩论的产出** ——
 * 引用来的数字能跟资料包比对，算出来的数字比不了，于是它成了唯一一类
 * 「谁都没在看」的数字，而它就摆在核对过的数字旁边，看着一样可信。
 */
import assert from "node:assert/strict";
import test from "node:test";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { auditNumbers, checkStatedArithmetic } from "../src/arithmetic.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const one = (line: string) => {
  const r = checkStatedArithmetic(line);
  assert.equal(r.length, 1, `应当识别出恰好一条算式，实际 ${r.length} 条：${line}`);
  return r[0]!;
};

test("🔴 真实案例:同比算反了方向", () => {
  // 原文:「2026H1 扣非 444.64 亿元，同比仅增 +0.2%（2025H1 为 453.90 亿元）」
  const c = one("444.64 ÷ 453.90 − 1 = +0.2%");
  assert.equal(c.ok, false);
  assert.ok(Math.abs(c.recomputed - -2.04) < 0.01, `重算应约 −2.04%，得到 ${c.recomputed}`);
});

test("🔴 真实案例:结果与它自己给的两个数对不上", () => {
  // 原文:「2025 全年同比 +7.2%（822.93 亿 vs 747.53 亿）」—— 822.93/747.53 其实是 +10.1%
  const c = one("822.93 / 747.53 - 1 = 7.2%");
  assert.equal(c.ok, false);
  assert.ok(Math.abs(c.recomputed - 10.09) < 0.05);
});

test("算对了就不该报", () => {
  assert.equal(one("444.64 ÷ 453.90 − 1 = −2.04%").ok, true);
  assert.equal(one("922.78 亿 − 547.03 亿 = 375.75 亿元").ok, true);
  assert.equal(one("205.5 × 4 = 822.0").ok, true);
});

test("🔴 证据引用与期间标签要先剥掉 —— 这正是我们要求模型写的那种形状", () => {
  // 不剥的话这一条**一条都识别不出来**，等于这层校验对规范写法完全失效。
  const c = one("2026H1 444.64 亿 [ev-baddcc246399] ÷ 2025H1 453.90 亿 [ev-4839f9cd9cec] − 1 = −2.04%");
  assert.equal(c.ok, true);
  // 期间标签必须**整体**剥掉：只剥字母会留下 `2026` 被当成运算数
  const bad = one("2026H1 444.64 亿 [ev-a1b2c3] ÷ 2025H1 453.90 亿 [ev-d4e5f6] − 1 = +0.2%");
  assert.equal(bad.ok, false);
});

test("正号必须认 —— 真实文本写的就是 `= +0.2%`", () => {
  // 第一版不认正号，于是那句错话整条识别不出来、安然过关
  assert.equal(checkStatedArithmetic("100 − 40 = +60").length, 1);
});

test("没有算式就不该硬凑一条", () => {
  assert.equal(checkStatedArithmetic("PE_TTM 19.87 倍，PB 6.44 倍").length, 0);
  assert.equal(checkStatedArithmetic("2025 年和 2024 年的对比").length, 0);
});

/* ── 三档分类 ── */

const claims = (line: string) => [...line.matchAll(/-?\d+(?:\.\d+)?/g)]
  .map((m) => ({ n: Number(m[0]), raw: m[0]! }));
const bound = (n: number, pool: number[]) => pool.some((v) => Math.abs(v - n) < 1e-6);

test("三档必须分开报:对得上 / 算式自洽 / 没着落", () => {
  const a = auditNumbers(
    // ⚠️ 结果要带 %：不带 % 时 444.64/453.90−1 = −0.0204，写成 −2.04 本身就是错的
    //    （第一版用例就漏了这个 %，被校验器当场判错 —— 是用例写错不是校验器错）
    ["扣非 444.64 亿。", "444.64 ÷ 453.90 − 1 = -2.04%", "历史中枢在 30 倍附近。"].join("\n"),
    [444.64, 453.90], claims, bound,
  );
  assert.equal(a.bound >= 2, true, "引用来的应当算 bound");
  assert.ok(a.derived >= 1, "算式里的结果应当算 derived");
  assert.ok(a.loose.some((l) => l.value === 30), "凭空出现的 30 应当落进「没着落」");
  assert.equal(a.badMath.length, 0);
});

test("🔴 算错的必须进 badMath —— 这是唯一能断言「这里错了」的一类", () => {
  const a = auditNumbers("444.64 ÷ 453.90 − 1 = +0.2%", [444.64, 453.90], claims, bound);
  assert.equal(a.badMath.length, 1);
  assert.ok(Math.abs(a.badMath[0]!.recomputed - -2.04) < 0.01);
});

/* ── 覆盖率:用例全部抄自第二次真实辩论的产出 ────────────────────────────
 * 🔴 第一版只支持 `A ÷ B − 1 = R%` 与 `− + ×`,于是一段**写满算式**的产出只认出 1 条 ——
 *    而「识别不到」和「没有算式可查」在结果上长得一模一样,不测就发现不了。
 */

test("🔴 纯除法必须支持 —— 实测里最常见的形状", () => {
  for (const line of [
    "2025H1 扣非净利 453.90 亿元 ÷ 2025H1 营收 910.94 亿元 = 净利率 49.83%",
    "2026H1 扣非净利 444.64 亿元 ÷ 2026H1 营收 922.78 亿元 = 净利率 48.19%",
    "隐含 ROE ≈ PB ÷ PE-static = 6.43 ÷ 18.14 = 35.4%",
    "现价 1291.79 元 [ev-3798205d30c1] ÷ 2025 年度 EPS 65.66 元 [ev-1134ccc6e9e3] = 19.67 倍",
  ]) {
    const r = checkStatedArithmetic(line);
    assert.equal(r.length, 1, `没识别出算式:${line}`);
    assert.equal(r[0]!.ok, true, `重算应当通过:${line} → 得到 ${r[0]!.recomputed}`);
  }
});

test("运算符与数字之间的标签不能挡住识别", () => {
  // `÷ 营收 910.94`、`= 净利率 49.83%` —— 不留这个口子，这类写法一条都识别不出来
  assert.equal(checkStatedArithmetic("A 453.90 亿元 ÷ 营收 910.94 亿元 = 净利率 49.83%").length, 1);
});

test("🔴 没有算式的句子一条都不该报", () => {
  // ⚠️ **挡住误报的是字符类，不是间隙宽度**：实测把间隙从 8 放宽到 40 字，
  //    下面这些照样一条都不匹配 —— 因为 LABEL 排除了数字 / 运算符 / 逗号，
  //    跨不到无关的数上去。（第一版这条测试写的是「间隙不能太宽」，
  //    但把宽度改到 40 它照样全绿 —— 断言与实际承重的机制对不上。）
  for (const line of [
    "差额仅 0.53 亿元（占比 0.12%）",
    "PE_TTM 19.87 倍，PB 6.44 倍",
    "2025 年和 2024 年的对比",
    "历史 PE 中枢长期在 25–30 倍区间",
  ]) {
    assert.equal(checkStatedArithmetic(line).length, 0, `不该识别出算式:${line}`);
  }
  // 真正承重的那一条：标签里**不许含数字**。含了就会跨到无关的数上去。
  const m = /const LABEL = String\.raw`([^`]+)`/.exec(
    fs.readFileSync(path.join(SRC, "arithmetic.ts"), "utf8"),
  );
  assert.ok(m, "LABEL 不见了或写法变了");
  assert.ok(/\\d/.test(m![1]!), "LABEL 必须把数字排除在外 —— 否则它会跨到无关的数上去");
});

test("🔴 数量级参与运算:混合「亿 / 万」、结果单位写错都要抓到;说不清数量级的不认(审计 A7)", () => {
  const one = (s: string) => { const r = checkStatedArithmetic(s); assert.equal(r.length, 1, s); return r[0]!; };
  assert.equal(one("2 亿 + 3 万 = 5 亿元").ok, false, "按裸数重算 2 + 3 = 5 会判成对");
  assert.equal(one("2 亿 + 3 万 = 2.0003 亿元").ok, true);
  assert.equal(one("2 亿 + 3 亿 = 5 万").ok, false, "结果数量级写错");
  assert.equal(one("2 亿 + 3 亿 = 5").ok, true, "同一数量级、结果省略单位的写法照认");
  assert.equal(checkStatedArithmetic("2 亿 + 3 万 = 5").length, 0, "数量级不同、结果没写单位:说不清,不认(不算对也不算错)");
  assert.equal(one("100 亿元 ÷ 8000 万股 = 125 元").ok, true, "金额 ÷ 股数,两边数量级不同");
  assert.equal(one("12.5 元 × 8 亿股 = 100 亿元").ok, true);
  assert.equal(one("35% × 200 亿 = 70 亿").ok, true, "百分数当 0.01 参与运算");
  assert.equal(one("444.64 亿 ÷ 4539000 万 − 1 = −2.04%").ok, true);
  assert.equal(one("444.64 亿 ÷ 45390 万 − 1 = −2.04%").ok, false, "数量级差一百倍");
  assert.equal(one("35% − 20% = 15%").ok, true);
  assert.equal(one("35 − 20 = 15%").ok, true, "两边没单位、结果只写 % 的老写法照认");
  assert.equal(one("453.90 ÷ 910.94 = 49.83%").ok, true);
  assert.equal(checkStatedArithmetic("100 亿 ÷ 8 = 12.5").length, 0, "只有一边写了数量级、结果没写:说不清是 12.5 亿还是 12.5");
  assert.equal(one("100 亿 ÷ 8 = 12.5 亿").ok, true);
});

test("🔴 加减要同一种量:金额加 / 减百分比不认,也就不能给结果作证(审计第二轮 A7)", () => {
  for (const s of ["100 元 + 20% = 100.2 元", "100 元 − 20% = 99.8 元", "100 亿 + 5% = 100.05 亿", "35% + 20 元 = 55%", "100 元 + 20 股 = 120 元",
    "100 元 + 20 元 = 120%"]) {
    assert.equal(checkStatedArithmetic(s).length, 0, s);
  }
  const one = (s: string) => { const r = checkStatedArithmetic(s); assert.equal(r.length, 1, s); return r[0]!; };
  assert.equal(one("100 元 + 20 元 = 120 元").ok, true);
  assert.equal(one("100 元 + 20 = 120 元").ok, true, "一边没写单位名按同一种看");
  assert.equal(one("100 元 × 20% = 20 元").ok, true, "金额 × 百分比照常认");
  assert.equal(one("35% − 20% = 15%").ok, true);
  assert.equal(one("35 − 20 = 15%").ok, true, "两边都没单位的老写法照认");
});

// 下面三组用例来自 VA 短线复盘的一次实跑(2026-10-10):三条对的算式全被判成「重算应为 0.00」
test("🔴 数量级只写在结果上是省略写法:运算数按结果的数量级读;只有一边写了说不清,不认", () => {
  const one = (s: string) => { const r = checkStatedArithmetic(s); assert.equal(r.length, 1, s); return r[0]!; };
  assert.equal(one("19005.40-16821.09=2184.31 亿元").ok, true, "实跑原文");
  assert.equal(one("25741.60-26390.98=-649.38 亿元").ok, true, "实跑原文");
  assert.equal(one("19005.40-16821.09=2184.31 万元").ok, true);
  assert.equal(one("19005.40-16821.09=2000 亿元").ok, false, "省略写法照样要算对");
  assert.equal(one("100 ÷ 8 = 12.5 亿").ok, true);
  assert.equal(one("4 × 10 = 40 亿元").ok, true);
  assert.equal(one("35% × 200 = 70 亿").ok, true);
  assert.equal(one("35% × 200 = 7000 亿").ok, false);
  for (const s of ["2 亿 + 3 = 5 亿", "2 + 3 亿 = 5 亿", "35% + 20% = 55 亿"]) assert.equal(checkStatedArithmetic(s).length, 0, s);
  assert.equal(one("2 亿 + 3 万 = 5 亿元").ok, false, "两边都写了数量级的仍按各自数量级算");
  // 🔴 明确写了「元」的是元本身,不是省略写法(审计 2026-10-11 Codex 范围 4 第 3 条)
  assert.equal(one("2 元 + 3 元 = 5 亿元").ok, false);
  assert.equal(one("2 元 × 3 = 6 亿元").ok, false);
  assert.equal(one("20000 元 + 30000 元 = 5 万元").ok, true, "各按自己的单位算,再换成结果的单位");
  assert.equal(checkStatedArithmetic("2 元 + 3 = 5 亿元").length, 0, "一项写了元、一项没写:说不清,不认");
});

test("🔴 多项加减整条重算;更长算式的尾巴不单独认(只拿最后两项会把对的合计判成错)", () => {
  const one = (s: string) => { const r = checkStatedArithmetic(s); assert.equal(r.length, 1, s); return r[0]!; };
  const top10 = "成交额前十合计 210.92+160.28+149.79+146.19+128.33+108.64+107.56+94.17+86.77+84.89=1277.54 亿元";
  const r = one(top10);
  assert.equal(r.ok, true, "实跑原文:以前只认出「+86.77+84.89=1277.54」");
  assert.ok(r.raw.startsWith("210.92"), r.raw);
  assert.equal(one("210.92+160.28+149.79=500 亿元").ok, false, "合计写错要抓到");
  assert.equal(one("-174.43-261.76-392.32=-828.51 亿元").ok, true, "第一项是负数");
  assert.equal(one("2 亿 + 3 万 + 1 万 = 2.0004 亿").ok, true);
  assert.equal(one("2 亿 + 3 万 + 1 万 = 6 亿").ok, false);
  assert.equal(one("1 + 2 + 3 = 6").ok, true);
  for (const s of ["1+2×3=7", "1×2+3=5", "2 亿 + 3 + 1 = 6 亿", "1 元 + 2 股 + 3 元 = 6 元"]) assert.equal(checkStatedArithmetic(s).length, 0, s);
  // 合计里的每一项都算「有交代」,不会被当成没出处
  const a = auditNumbers(top10, [], (line) => [...line.matchAll(/\d+(?:\.\d+)?/g)].map((m) => ({ n: Number(m[0]), raw: m[0] })), (n, pool) => pool.includes(n));
  assert.equal(a.loose.length, 0, JSON.stringify(a.loose));
  assert.equal(a.badMath.length, 0);
});

test("约等号照认;中文破折号不是负号", () => {
  const one = (s: string) => { const r = checkStatedArithmetic(s); assert.equal(r.length, 1, s); return r[0]!; };
  assert.equal(one("午后首封占 40÷69≈58.0%").ok, true, "实跑原文");
  assert.equal(one("40÷69≈68.0%").ok, false);
  assert.equal(one("1+2+3≈6").ok, true);
  // 「≈」只承诺写出来的那几位:按最后一位有效数字的半格比,「=」照旧严(v2.2.0 审计 Opus 第 6 条)
  assert.equal(one("19005.40 − 16821.09 ≈ 2200 亿元").ok, true, "2184.31 按百位取整是 2200");
  assert.equal(one("19005.40 − 16821.09 = 2200 亿元").ok, false, "写「=」就要对到容差内");
  assert.equal(one("19005.40 − 16821.09 ≈ 2300 亿元").ok, false, "取整也取不到 2300");
  assert.equal(one("19005.40 − 16821.09 ≈ 2184.3 亿元").ok, true);
  assert.equal(one("19005.40 − 16821.09 ≈ 2196.3 亿元").ok, false, "写到 0.1 的不按百位放宽,只有「=」原有的容差");
  assert.equal(one("40÷69≈58%").ok, true);
  assert.equal(one("40÷69≈59%").ok, false);
  // 半格封顶到结果的 5%:结果只有一位有效数字时,末尾的 0 不当取整位(v2.1.0 合并审计 Opus 第 1 条)
  assert.equal(one("30÷49≈100%").ok, false, "实为 61.2%");
  assert.equal(one("15÷60≈20%").ok, false, "实为 25%");
  assert.equal(one("52÷4≈10倍").ok, false, "实为 13 倍");
  assert.equal(one("48.5+48.5≈100").ok, true, "97 在 5% 以内");
  assert.equal(one("100−197≈−100").ok, true);
  assert.equal(one("100−161≈−100").ok, false);
  // 封顶不低于个位的半格:个位整数的正常取整照旧算对(v2.1.0 合并审计复核第 1 条)
  assert.equal(one("10÷3≈3倍").ok, true, "3.33 取整是 3");
  assert.equal(one("1.2÷28≈4%").ok, true, "4.29 取整是 4");
  assert.equal(one("13÷4≈3倍").ok, true);
  assert.equal(one("10÷2.5≈3倍").ok, false, "实为 4");
  const d = one("结论——19005.40-16821.09=2184.31 亿元");
  assert.equal(d.ok, true, "「——19005.40」读成负数就会判错");
  assert.equal(one("19005.40 — 16821.09 = 2184.31").ok, true, "单个破折号夹在两数之间仍是减号");
});

test("🔴 只有结果写了数量级:按字面算、结果换了个单位写的(「5 × 2000 = 1 万」)也是对的(Opus 审计范围 4 待核实,实跑确认)", () => {
  for (const ok of ["5 × 2000 = 1 万", "5 × 2000 = 1 万元", "20000 ÷ 2 = 1 万", "3000 + 7000 = 1 万", "3000 + 7000 + 5000 = 1.5 万", "250000000 - 50000000 = 2 亿"]) {
    assert.equal(one(ok).ok, true, ok);
  }
  // 省略写法照旧认
  assert.equal(one("19005.40 − 16821.09 = 2184.31 亿元").ok, true);
  assert.equal(one("100 ÷ 8 = 12.5 亿").ok, true);
  // 两种读法都对不上的照旧算错,提示的重算值取数量级更近的那种
  const wrongMul = one("5 × 2000 = 2 万");
  assert.equal(wrongMul.ok, false);
  assert.equal(wrongMul.recomputed, 1, "按字面读是 1 万,比按省略写法读的 10000 万更说得通");
  const wrongSum = one("19005.40 − 16821.09 = 2000 亿元");
  assert.equal(wrongSum.ok, false);
  assert.ok(Math.abs(wrongSum.recomputed - 2184.31) < 1e-6, "省略写法的读法更近");
  assert.equal(one("3000 + 7000 + 5000 = 2 万").ok, false);
});
