import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/finance/register.ts";   // Core 不内置词表:未注册就抛错(这正是设计)
import { UNVERIFIED_MARK, checkNumberFidelity, claimNumbers, maskUncited, quotedHistory, summarizeFidelityViolations } from "../src/number_fidelity.ts";
import { currentPlugin } from "../src/plugin.ts";

const CALC = "calc-" + "a".repeat(16);
const EV = "ev-bbbbbb";
// ⚠️ resultProjection 只认**同时带 status/value/unit** 的结果对象 —— 缺任一个,display 就取不到,
// 数字会退而去绑输出原始值(那正是本检查要禁止的),测试就会"因为错误的理由通过"。
const calcs = new Map([[CALC, { output: { status: "ok", value: 34.07, unit: "倍", display: "34.07 倍", details: null }, inputs: { price: 943.0, eps: 27.68 } }]]);
const evs = new Map([[EV, { value: 200.42 }]]);
const n = (report: string, quoted: string[] = []) => checkNumberFidelity(report, evs as never, calcs as never, "300308", quoted).violations;

test("数字检查无内置中文章节豁免；调用方显式传契约", () => {
  const report = `## 数据缺口\n结果为 99.99 倍 [${CALC}]。`;
  assert.equal(n(report).length, 1);
  const p = currentPlugin();
  assert.deepEqual(checkNumberFidelity(report, evs as never, calcs as never, undefined, [], p.lexicon, p.fidelityExcludedSections).violations, []);
  assert.deepEqual(checkNumberFidelity(report.replace("数据缺口", "Missing inputs"), evs as never, calcs as never, undefined, [], p.lexicon, ["Missing inputs"]).violations, []);
});

test("该抓的要抓到:引了真 id 却写别的数", () => {
  // 这正是架构审计点名的缺口 —— 在此之前 validateReport 只查 id 存不存在
  assert.equal(n(`## 估值\n前瞻 PE 为 41.90 倍 [${CALC}]。`).length, 1);
  assert.equal(n(`## 估值\n前瞻 PE 为 3407.00 倍 [${CALC}]。`).length, 1, "小数不许靠量纲缩放蒙混");
  assert.equal(n(`## 事实\nTTM 同比 250.42% [${EV}] [${CALC}]。`).length, 1, "证据原值被改也要抓");
});

test("该放的要放行:display 照抄 / calc 输入 / 证据原值", () => {
  assert.deepEqual(n(`## 估值\n前瞻 PE 为 34.07 倍 [${CALC}]。`), []);
  // 表格常见写法:结果与它的两个输入同行并列,读者点开该 calc 就能核对
  assert.deepEqual(n(`## 估值\n前瞻 PE 34.07 倍 [${CALC}],昨收 943.0 元 / EPS 27.68 元。`), []);
  assert.deepEqual(n(`## 事实\nTTM 同比 200.42% [${EV}] [${CALC}]。`), []);
});

test("没有引用 id 的行不算「引错」,另记进 uncited(交付前遮掉)", () => {
  assert.deepEqual(n("## 估值\n前瞻 PE 大约 99.99 倍。"), []);
  const r = checkNumberFidelity("## 估值\n前瞻 PE 大约 99.99 倍。", evs as never, calcs as never, "300308");
  assert.deepEqual(r.uncited.map((u) => u.num), ["99.99"]);
});

test("🔴 没引 id 的数字:本次证据 / 计算 / 档案里按写出的位数对得上就放过,对不上的记下(审计 A5)", () => {
  const ev = new Map<string, unknown>([["ev-cccccc", { value: 3742000000, unit: "元" }], ["ev-dddddd", { value: 0.1234, unit: "小数" }],
    ["ev-eeeeee", { value: "标题:公司订单增长 18.6% 创新高", unit: "text" }], ["ev-ffffff", { value: 12.345, unit: "元" }],
    ["ev-a1a1a1", { value: 56.78, unit: "亿元" }], ["ev-b2b2b2", { value: 1.2345, unit: "万元" }], ["ev-c3c3c3", { value: 2.5, unit: "万股" }]]);
  const un = (line: string, quoted: string[] = [], section = "事实") =>
    checkNumberFidelity(`# t\n## ${section}\n${line}\n`, ev as never, calcs as never, "300308", quoted, currentPlugin().lexicon, currentPlugin().fidelityExcludedSections).uncited.map((u) => u.num);
  // 有出处的:证据按写的量级、四舍五入到写的位数;证据文本里逐字出现;计算 display / 输入;档案里的旧值
  assert.deepEqual(un("营收 37.42 亿元。"), []);
  assert.deepEqual(un("营收 37.4 亿元。"), [], "少写一位、四舍五入后相等:有出处");
  assert.deepEqual(un("占比 12.34%。"), []);
  assert.deepEqual(un("订单增长 18.6%。"), []);
  assert.deepEqual(un("单价 12.35 元。"), []);
  assert.deepEqual(un("前瞻 PE 34.07 倍,昨收 943.0 元。"), []);
  assert.deepEqual(un("上次档案写的是 59.09%。", ["旧前瞻 CAGR 59.09%"]), []);
  // 对不上的:差一位、量级写错、凭空出现
  assert.deepEqual(un("营收 37.43 亿元。"), ["37.43"]);
  assert.deepEqual(un("营收 37.42 万元。"), ["37.42"], "写了万就只按万换算");
  // 🔴 数值和证据相等、单位差一万倍:不能因为「这个数在证据里」就放过(v2.2.0 审计 Codex 第 2 条)
  assert.deepEqual(un("营收 56.78 万元。"), ["56.78"]);
  assert.deepEqual(un("营收 56.78 亿元。"), []);
  assert.deepEqual(un("营收 56.78。"), [], "没写单位的只比原值");
  // 明写「元 / 股」的按证据单位换算:证据 1.2345 万元写成 12345 元是对的,写成 1.2345 元是错的(v2.2.0 审计 Codex 第 4 条)
  assert.deepEqual(un("金额为 12345 元。"), []);
  assert.deepEqual(un("金额为 1.2345 元。"), ["1.2345"]);
  assert.deepEqual(un("增持 25000 股。"), []);
  assert.deepEqual(un("营收 5678000000 元。"), [], "亿元证据写成元");
  assert.deepEqual(un("单价 12.36 元。"), ["12.36"]);
  assert.deepEqual(un("行业平均增速约 21.7%,竞争对手 -3.5%。"), ["21.7", "-3.5"]);
  // 不算主张的:日期、代码、计数、叙述、假设 / 情景、不查的章节
  assert.deepEqual(un("2026-09-30 公告,代码 300308,共 3 家,近 5 年。"), []);
  assert.deepEqual(un("假设增速 15.5%,情景下 PE 22.5 倍。"), []);
  assert.deepEqual(un("缺 37.43 亿元那一项。", [], "数据缺口"), []);
});

test("🔴 没引 id 的数字:区间号、点分日期、带序号的数据缺口、情景表格不误遮(v2.2.0 审计 Opus 第 2、3 条)", () => {
  const ev = new Map<string, unknown>([["ev-d4d4d4", { value: 31.2, unit: "%" }], ["ev-e5e5e5", { value: 35.8, unit: "%" }],
    ["ev-f6f6f6", { value: 1200, unit: "亿元" }], ["ev-a7a7a7", { value: 1500, unit: "亿元" }],
    ["ev-b8b8b8", { value: 3130000000, unit: "元" }], ["ev-c9c9c9", { value: 3580000000, unit: "元" }]]);
  const un = (body: string) =>
    checkNumberFidelity(`# t\n${body}\n`, ev as never, calcs as never, "300308", [], currentPlugin().lexicon, currentPlugin().fidelityExcludedSections).uncited.map((u) => u.num);
  // 「-」前面紧挨着数 / % / 单位是区间号:后一个数按正数核对,遮挡也只换数字、不吞掉区间号
  assert.deepEqual(un("## 事实\n近三年毛利率在 31.2%-35.8% 之间。"), []);
  assert.deepEqual(un("## 事实\n近三年毛利率在 31.2% - 35.8% 之间。"), []);
  assert.deepEqual(un("## 事实\n规模 1,200-1,500 亿元。"), []);
  assert.deepEqual(un("## 事实\n近三年毛利率在 31.2%-36.8% 之间。"), ["36.8"], "区间里编的数照样遮");
  // 左端没写单位、和右端共用「亿元」:按亿元和元级证据换算(v2.1.0 合并审计 Codex 第 2 条)
  assert.deepEqual(un("## 事实\n营收区间 31.3-35.8 亿元。"), []);
  assert.deepEqual(un("## 事实\n营收区间 31.3 - 35.8 亿元。"), []);
  assert.deepEqual(un("## 事实\n营收区间 33.2-35.8 亿元。"), ["33.2"], "左端编的数照样遮");
  assert.deepEqual(un("## 事实\n毛利率 -35.8%。"), ["-35.8"], "真负号照旧按负数核对");
  // 整数左端借到右端的单位就要查;没有量级的「30-60 天」照旧当计数(v2.1.0 合并审计复核第 3 条)
  assert.deepEqual(un("## 事实\n规模 999-1,500 亿元。"), ["999"]);
  assert.deepEqual(un("## 事实\n近 30-60 天。"), []);
  // 「~」「至」「－」分隔的区间同样按右端单位查;单位写错两端都遮(复核第 4 条)
  assert.deepEqual(un("## 事实\n营收区间 31.3~35.8 亿元。"), []);
  assert.deepEqual(un("## 事实\n营收区间 31.3 至 35.8 亿元。"), []);
  assert.deepEqual(un("## 事实\n营收区间 31.3－35.8 亿元。"), []);
  assert.deepEqual(un("## 事实\n营收区间 31.3~35.8 万元。"), ["31.3", "35.8"]);
  // 点分日期不是数
  assert.deepEqual(un("## 事实\n2026.10.11 发布。"), []);
  // 标题带序号 / 后缀的数据缺口一样不查
  assert.deepEqual(un("## 七、数据缺口\n缺 37.43 亿元那一项,超时(30000ms)。"), []);
  assert.deepEqual(un("## 数据缺口与局限\n缺 37.43 亿元那一项。"), []);
  // 表头写了「情景」的表格:数据行是设定;表格结束后恢复核对,别的表格照查
  assert.deepEqual(un("## 估值\n| 情景 | PE | 目标价 |\n| --- | --- | --- |\n| 乐观 | 35.2 倍 | 120.5 元 |\n| 悲观 | 18.4 倍 | 66.3 元 |\n\n营收 99.99 亿元。"), ["99.99"]);
  assert.deepEqual(un("## 事实\n| 年份 | 营收 |\n| --- | --- |\n| 2025 | 99.99 亿元 |"), ["99.99"]);
});

test("🔴 引了用户资料的行:资料片段里的数算有出处;资料编号里的数字不当数字(v2.2.0 审计 Opus 第 1 条)", () => {
  const id = "5f3a9e1c2b7d48610f2e3a4b5c6d7e8f", other = "0".repeat(31) + "1";
  const library = { ids: new Set([id]), text: "券商测算 2026 年营收 120.5 亿元,毛利率 33.6%,净利同比 -3.2%。" };
  const un = (line: string, lib: typeof library | undefined = library) =>
    checkNumberFidelity(`# t\n## 事实\n${line}\n`, new Map() as never, new Map() as never, "300308", [], currentPlugin().lexicon, currentPlugin().fidelityExcludedSections, lib).uncited.map((u) => u.num);
  assert.deepEqual(un(`券商测算 2026 年营收 120.5 亿元,毛利率 33.6% [资料:${id} p.3]`), []);
  assert.deepEqual(un(`券商测算营收 130.5 亿元 [资料:${id} p.-]`), ["130.5"], "资料里没有的数照样遮");
  assert.deepEqual(un(`券商测算营收 120.5 亿元 [资料:${other} p.3]`), ["120.5"], "引的不是本次注入的资料:不算出处");
  assert.deepEqual(un(`券商测算营收 120.5 亿元`), ["120.5"], "同行没引资料:不拿资料当出处");
  assert.deepEqual(un(`见 [资料:${id} p.3]`, undefined), [], "编号里的 48610 / 7e8 不是数字主张");
  // 🔴 按写的位数和单位对,不比裸数字(v2.1.0 合并审计 Codex 第 1 条)
  assert.deepEqual(un(`券商测算营收 120.5 万元 [资料:${id} p.-]`), ["120.5"], "资料写亿元、报告写万元:差一万倍");
  assert.deepEqual(un(`券商测算营收 1205000 万元 [资料:${id} p.-]`), [], "换算成万元写也对得上");
  assert.deepEqual(un(`净利同比 3.2% [资料:${id} p.3]`), ["3.2"], "资料是 -3.2%,写成正数方向反了");
  assert.deepEqual(un(`净利同比 -3.2% [资料:${id} p.3]`), []);
  // 资料原文里的区间号不是负号;压平表格里带空格的「 -3.4%」照旧是负数(复核第 2 条)
  const ranges = { ids: new Set([id]), text: "毛利率 31.2%-35.8%,规模 1,200亿-1,500亿元;营收 31.3 - 35.8 亿元;增速 15.2% -3.4%" };
  assert.deepEqual(un(`毛利率 31.2%-35.8%,规模 1,200亿-1,500亿元 [资料:${id} p.2]`, ranges), []);
  assert.deepEqual(un(`营收 31.3 - 35.8 亿元 [资料:${id} p.2]`, ranges), []);
  assert.deepEqual(un(`增速 3.4% [资料:${id} p.2]`, ranges), ["3.4"]);
  assert.deepEqual(un(`增速 -3.4% [资料:${id} p.2]`, ranges), []);
  // 「百万港元」「billion」「个百分点」按写的量级读(复核第 5 条)
  const mags = { ids: new Set([id]), text: "收入 1,205.3 百万港元;capex $120.5 billion;毛利率提升 3.2 个百分点。" };
  assert.deepEqual(un(`收入 12.053 亿港元 [资料:${id} p.1]`, mags), []);
  assert.deepEqual(un(`收入 1205.3 万港元 [资料:${id} p.1]`, mags), ["1205.3"], "百万写成万:差一百倍");
  assert.deepEqual(un(`capex 1205 亿美元 [资料:${id} p.1]`, mags), []);
  assert.deepEqual(un(`capex 120.5 亿美元 [资料:${id} p.1]`, mags), ["120.5"], "billion 写成亿:差十倍");
  assert.deepEqual(un(`毛利率提升 3.2 个百分点 [资料:${id} p.1]`, mags), []);
  assert.deepEqual(un(`利润 3.2 万元 [资料:${id} p.1]`, mags), ["3.2"], "百分点不能给金额当出处");
  // 档案引文同一口径
  const arch = (line: string) =>
    checkNumberFidelity(`# t\n## 事实\n${line}\n`, new Map() as never, new Map() as never, "300308", ["上次档案:营收 120.5 亿元"], currentPlugin().lexicon, currentPlugin().fidelityExcludedSections).uncited.map((u) => u.num);
  assert.deepEqual(arch("上次营收 120.5 亿元。"), []);
  assert.deepEqual(arch("上次营收 120.5 万元。"), ["120.5"]);
  // 遮完以后引用还完整
  const line = `券商测算营收 130.5 亿元 [资料:${id} p.3]`;
  const report = `# t\n## 事实\n${line}\n`;
  const r = checkNumberFidelity(report, new Map() as never, new Map() as never, "300308", [], currentPlugin().lexicon, currentPlugin().fidelityExcludedSections, library);
  assert.ok(maskUncited(report, r.uncited).text.includes(`[资料:${id} p.3]`));
});

test("遮挡:只换数字本身,单位和上下文留着;首行之后加说明;没有要遮的原样返回", () => {
  const report = "# t · 状态:complete\n## 事实\n- 增速 21.7%,对手 -3.5%。\n- 增速 21.7%,对手 -3.5%。\n- 正常一行。";
  const uncited = [{ section: "事实", line: "- 增速 21.7%,对手 -3.5%。", index: 5, num: "21.7" }, { section: "事实", line: "- 增速 21.7%,对手 -3.5%。", index: 14, num: "-3.5" }];
  const m = maskUncited(report, [...uncited, ...uncited]);
  assert.equal(m.count, 4, "同一行出现两次都要换");
  assert.equal(m.text, `# t · 状态:complete\n\n> 有 4 处数字在本次取到的数据和计算里找不到出处，已替换为${UNVERIFIED_MARK}，本报告因此标为不完整。\n## 事实\n- 增速 ${UNVERIFIED_MARK}%,对手 ${UNVERIFIED_MARK}%。\n- 增速 ${UNVERIFIED_MARK}%,对手 ${UNVERIFIED_MARK}%。\n- 正常一行。`);
  assert.deepEqual(maskUncited(report, []), { text: report, count: 0 });
  // 位置对不上(行被改过)不乱换
  assert.deepEqual(maskUncited(report, [{ section: "事实", line: "- 增速 21.7%,对手 -3.5%。", index: 3, num: "21.7" }]), { text: report, count: 0 });
  // 按「章节 + 行」定位:数据缺口里一字不差的同一行不跟着遮(v2.2.0 审计 Opus 第 3 条)
  const two = "# t\n## 事实\n- 增速 21.7%。\n## 数据缺口\n- 增速 21.7%。";
  assert.equal(maskUncited(two, [{ section: "事实", line: "- 增速 21.7%。", index: 5, num: "21.7" }]).text.split("\n").at(-1), "- 增速 21.7%。");
});

test("🔴 引用知识档案里的旧值不算违规 —— 如实标注新旧差异是**正确行为**", () => {
  const line = `## 风险与反证\n旧前瞻 CAGR 59.09% 不再适用,本次为 34.07 倍 [${CALC}]。`;
  assert.equal(n(line).length, 1, "没有档案文本时,59.09 确实无出处");
  assert.deepEqual(n(line, ["前瞻 CAGR 为 0.5909334882897681(小数),即 59.09%"]), [],
    "档案里有这个值 → 可追溯,不该判违规");
});

test("quotedHistory:从各阶段 knowledge_conflicts 收集 claim / refuted_by", () => {
  const stage = (s: string) => (s === "risk"
    ? { knowledge_conflicts: [{ claim: "旧 CAGR 59.09%", refuted_by: "本次 58.85%" }, { claim: 123 }] }
    : null);
  assert.deepEqual(quotedHistory(stage as never), ["旧 CAGR 59.09%", "本次 58.85%"]);
  assert.deepEqual(quotedHistory(() => null), []);
  assert.deepEqual(quotedHistory(() => ({ knowledge_conflicts: "不是数组" })), []);
});

test("applicable:没有带 display 的 calc 时不适用(旧运行不该被判失败)", () => {
  const old = new Map([[CALC, { output: { status: "ok", value: 1, unit: "倍", details: null }, inputs: {} }]]);   // 无 display = 旧运行
  assert.equal(checkNumberFidelity(`## 估值\nx 9.99 倍 [${CALC}]`, evs as never, old as never).applicable, false);
});

/* ---------- Codex fidelity-r1 的回归 ---------- */

const evMap = (rows: [string, unknown, string?][]) =>
  new Map(rows.map(([id, value, unit]) => [id, { id, value, unit } as never]));
const calcMap = (rows: { id: string; output: unknown; inputs?: unknown; ver?: string }[]) =>
  new Map(rows.map((r) => [r.id, { calculation_id: r.id, output: r.output, inputs: r.inputs ?? {},
                                   calc_version: r.ver ?? "0.3.2" } as never]));
const CID = "calc-1111111111111111";
const rep = (body: string) => `## 估值\n${body}\n`;

test("display 必须逐字照抄:少写一位有效数字不算照抄", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 37.4, unit: "倍", display: "37.40 倍" } }]);
  // 🔴 原来用 startsWith,于是 "37.4" 命中 "37.40 倍" —— 而"少写一位"正是这个判定要抓的
  const bad = checkNumberFidelity(rep(`| 扣非×4 PE | 37.4 倍 | ${CID} |`), evMap([]), calcs);
  assert.equal(bad.violations.length, 1);
  const good = checkNumberFidelity(rep(`| 扣非×4 PE | 37.40 倍 | ${CID} |`), evMap([]), calcs);
  assert.deepEqual(good.violations, []);
  // 只截掉**单位后缀**仍算照抄(204.53亿 ← "204.53 亿元")
  const c2 = calcMap([{ id: CID, output: { status: "ok", value: 2.045e10, unit: "亿元", display: "204.53 亿元" } }]);
  assert.deepEqual(checkNumberFidelity(rep(`| 净利 | 204.53亿 | ${CID} |`), evMap([]), c2).violations, []);
});

test("失败 / 非有限结果的 display 不是合法靶子", () => {
  const calcs = calcMap([{ id: CID, output: { status: "error", value: null, unit: "倍", display: "37.40 倍" } }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 37.40 倍 | ${CID} |`), evMap([]), calcs).violations.length, 1);
});

test("引用旧值:左边界防冒名,但允许截位", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  const quoted = ["旧前瞻 CAGR 59.09%;旧 PEG 0.6328580294544913 倍"];
  // 截位引用是正常写法
  assert.deepEqual(checkNumberFidelity(rep(`旧 PEG 0.632858 倍不再适用 [${CID}]`), evMap([]), calcs, undefined, quoted).violations, []);
  // 但"59.09%"里藏不下一个编造的"9.09%"
  assert.equal(checkNumberFidelity(rep(`旧 CAGR 9.09% 不再适用 [${CID}]`), evMap([]), calcs, undefined, quoted).violations.length, 1);
});

test("🔴 引了编号的行:写了量级的数按位数和单位对档案(v2.1.0 合并审计复核第 6 条)", () => {
  const ev = evMap([["ev-bbbbbbbbbbbb", 200.42, "亿元"]]);
  const viol = (line: string) => checkNumberFidelity(`## 事实\n${line}\n`, ev, calcMap([]), undefined, ["上次营收 120.5 亿元"]).evidenceViolations ?? [];
  assert.equal(viol("营收 120.5 万元 [ev-bbbbbbbbbbbb]").length, 1, "档案写亿元、报告写万元");
  assert.deepEqual(viol("上次营收 120.5 亿元,本次 200.42 亿元 [ev-bbbbbbbbbbbb]"), []);
});

test("方向词承载正负号:证据 -1.92,报告写「下降 1.92」是对的", () => {
  const ev = evMap([["ev-aaaaaaaaaaaa", -1.92, "美元/卡时"]]);
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  assert.deepEqual(checkNumberFidelity(rep(`中位较上次观测下降 1.92 美元/卡时 [ev-aaaaaaaaaaaa] [${CID}]`), ev, calcs).violations, []);
  // 没有方向词时不放宽
  assert.equal(checkNumberFidelity(rep(`中位为 1.92 美元/卡时 [ev-aaaaaaaaaaaa] [${CID}]`), ev, calcs).violations.length, 1);
  // 🔴 正向词配负值证据 = 方向写反,不放宽(审计 2026-10-11 Codex 范围 4 第 4 条)
  assert.equal(checkNumberFidelity(rep(`中位较上次观测上升 1.92 美元/卡时 [ev-aaaaaaaaaaaa] [${CID}]`), ev, calcs).violations.length, 1);
  assert.equal(checkNumberFidelity(rep(`中位较上次观测增加 1.92 美元/卡时 [ev-aaaaaaaaaaaa] [${CID}]`), ev, calcs).violations.length, 1);
  // 名词把方向反过来的照旧放宽:亏损增加、跌幅扩大
  assert.deepEqual(checkNumberFidelity(rep(`单季亏损增加 1.92 美元/卡时 [ev-aaaaaaaaaaaa] [${CID}]`), ev, calcs).violations, []);
  assert.deepEqual(checkNumberFidelity(rep(`跌幅扩大 1.92 美元/卡时 [ev-aaaaaaaaaaaa] [${CID}]`), ev, calcs).violations, []);
});

test("纯 evidence 行也查:引了真实 id 却写了别的数要被抓出来", () => {
  // 实测依据:48 个真实运行里,事实表把证据 id 整体错位了一行,原实现完全查不到
  const ev = evMap([["ev-bbbbbbbbbbbb", 39.03, "元/股"]]);
  const bad = checkNumberFidelity("## 事实\n| EPS均值 | 70.96 | 元/股 | ev-bbbbbbbbbbbb |\n", ev, calcMap([]));
  // 归入 evidenceViolations:它与 display 无关,**不受 applicable 门控**(旧运行同样该报)
  assert.equal(bad.evidenceViolations?.length, 1);
  assert.deepEqual(bad.violations, []);
  const good = checkNumberFidelity("## 事实\n| EPS最小值 | 39.03 | 元/股 | ev-bbbbbbbbbbbb |\n", ev, calcMap([]));
  assert.deepEqual(good.evidenceViolations, []);
});

test("证据文本匹配要忽略空白:「12.34 亿元」与「12.34亿」是同一个数", () => {
  const ev = evMap([["ev-cccccccccccc", "公告(合同金额 12.34 亿元)"]]);
  assert.deepEqual(checkNumberFidelity("## 卡口事件\n- 合同金额 12.34亿 [ev-cccccccccccc]\n", ev, calcMap([])).violations, []);
});

test("🔴 写了万 / 亿 / % 就按写的量级对证据:12.34 亿元写成 12.34 万元要抓(第四轮审计 A2)", () => {
  const ev = evMap([["ev-aaaaaaaaaaaa", 1234000000, "元"], ["ev-dddddddddddd", 0.1234, "小数"], ["ev-eeeeeeeeeeee", 56780, "万股"]]);
  const viol = (line: string) => checkNumberFidelity(`## 事实\n${line}\n`, ev, calcMap([])).evidenceViolations ?? [];
  for (const bad of ["营收 12.34 万元 [ev-aaaaaaaaaaaa]", "营收 1234 亿元 [ev-aaaaaaaaaaaa]", "毛利率 0.1234% [ev-dddddddddddd]", "总股本 5.678 万股 [ev-eeeeeeeeeeee]"]) {
    assert.equal(viol(bad).length, 1, bad);
  }
  for (const good of ["营收 12.34 亿元 [ev-aaaaaaaaaaaa]", "营收 123400 万元 [ev-aaaaaaaaaaaa]", "营收 12.34亿 [ev-aaaaaaaaaaaa]", "毛利率 12.34% [ev-dddddddddddd]",
    "总股本 5.678 亿股 [ev-eeeeeeeeeeee]", "总股本 56780 万股 [ev-eeeeeeeeeeee]", "营收 1234000000 元 [ev-aaaaaaaaaaaa]"]) {
    assert.deepEqual(viol(good), [], good);
  }
  // 证据没写单位:仍只认 元 / 万 / 亿 三档,差一万倍的写法照样抓
  const bare = evMap([["ev-ffffffffffff", 1234000000]]);
  assert.equal((checkNumberFidelity("## 事实\n营收 12.34 万 [ev-ffffffffffff]\n", bare, calcMap([])).evidenceViolations ?? []).length, 1);
  assert.deepEqual(checkNumberFidelity("## 事实\n营收 12.34 亿 [ev-ffffffffffff]\n", bare, calcMap([])).evidenceViolations, []);
});

test("token 原始位置不被同行 ev-id 的数字带偏:公告标题里的 1% 不误判成负数", () => {
  const id = "ev-316d2facb875";
  const ev = evMap([[id, "关于控股股东及其一致行动人持股比例变动超过1%整数倍的公告"]]);
  const got = checkNumberFidelity(`## 推断\n先引另一条线索(ev-1f0fedccd8ee),再写持股比例变动超 1% 整数倍(${id})。`, ev, calcMap([]));
  assert.deepEqual(got.evidenceViolations, []);
  assert.equal(got.exact, 1);
});

test("补跑诊断按原句聚合全部错误数字，并保留同行 id", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 37.4, unit: "倍", display: "37.40 倍" } }]);
  const got = checkNumberFidelity(rep(`PE 41.90 倍、PEG 0.88 倍 [${CID}]`), evMap([]), calcs);
  assert.equal(got.violationDetails.length, 2);
  const summary = summarizeFidelityViolations(got.violationDetails);
  assert.match(summary, /错误数字=41\.90倍,0\.88倍/);
  assert.match(summary, new RegExp(CID));
  assert.equal((summary.match(/原句=/g) ?? []).length, 1, "同一长行只展开一次，避免补跑提示重复刷屏");
});

test("补跑诊断默认不隐藏第 13 行以后的错误，避免两次重试仍拿不到完整清单", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({
    section: "估值", token: `${100 + i}.00倍`, line: `第 ${i + 1} 个错误 ${100 + i}.00 倍`, citedIds: [CID],
  }));
  const summary = summarizeFidelityViolations(items);
  assert.equal((summary.match(/原句=/g) ?? []).length, 25);
  assert.match(summary, /第 25 个错误 124\.00 倍/);
  assert.doesNotMatch(summary, /行未展开/);
});

test("missingDisplay 按每条 calc 自己的版本判,不误杀真旧运行", () => {
  const old = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍" }, ver: "0.3.1" }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 1 倍 | ${CID} |`), evMap([]), old).missingDisplay, false);
  const cur = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍" }, ver: "0.3.2" }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 1 倍 | ${CID} |`), evMap([]), cur).missingDisplay, true);
});


test("整数 calc 输出也不能绕过 display,但 details 里的中间量仍可绑", () => {
  // output.value=37 / display="37.00 倍" → 写 "37 倍" 必须违规(否则小数被管、整数放行,规则自相矛盾)
  const c1 = calcMap([{ id: CID, output: { status: "ok", value: 37, unit: "倍", display: "37.00 倍" } }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 37 倍 | ${CID} |`), evMap([]), c1).violations.length, 1);
  // 但 details 里的锚点(inputs 为空)是正当中间量,不能误拦
  const c2 = calcMap([{ id: CID, output: { status: "ok", value: null, unit: "年", display: null,
                                           details: { anchors: { a: 30 } } } }]);
  assert.deepEqual(checkNumberFidelity(rep(`景气延续 30 倍锚 [${CID}]`), evMap([]), c2).violations, []);
});

test("details 中嵌套的计算结果仍必须遵循 display，不能冒充中间量", () => {
  for (const status of ["ok", "error"]) {
    const calcs = calcMap([{ id: CID, output: { status: "ok", value: null, unit: "倍", display: "情景比较",
      details: { scenarios: { base: { status, value: 37.397700293773134, unit: "倍", display: "37.40 倍", details: { anchor: 27.30 } } } } } }]);
    assert.equal(checkNumberFidelity(rep(`情景估值 37.397700293773134 倍 [${CID}]`), evMap([]), calcs).violations.length, 1);
    if (status === "ok") {
      assert.deepEqual(checkNumberFidelity(rep(`情景估值 37.40 倍 [${CID}]`), evMap([]), calcs).violations, []);
      assert.deepEqual(checkNumberFidelity(rep(`参考锚 27.30 倍 [${CID}]`), evMap([]), calcs).violations, []);
    }
  }
});

test("小数用紧容差(上游 review 反例):details 里是 27.30,报告写 27.35 = 改了数字,必须拦", () => {
  // 真实 percentile_rank 形状:value=分位(10.66)、details.min=最低 PE(27.30)。
  // 2e-3 相对容差(整数档)套小数会让 numberBound(27.35,[27.30])→true 放过改写;
  // 小数档 1e-6 下 0.05 的差远大于容差,必须判违规。
  const c = calcMap([{ id: CID, output: { status: "ok", value: 10.66, unit: "%", display: "10.66%",
                                           details: { min: 27.30, median: 28.96, max: 54.97 } } }]);
  assert.equal(checkNumberFidelity(rep(`| 近五年最低 | 27.35 倍 | ${CID} |`), evMap([]), c).violations.length, 1);
  // 照抄 details 里的 27.30(两位)是正当引用,放行
  assert.deepEqual(checkNumberFidelity(rep(`| 近五年最低 | 27.30 倍 | ${CID} |`), evMap([]), c).violations, []);
});

test("三类可溯源合法写法在 1e-6 紧容差下仍放行(details 副统计量 / 元→亿 / 小数→%)", () => {
  const c = calcMap([{ id: CID, output: { status: "ok", value: 10.66, unit: "%", display: "10.66%",
                                           details: { min: 17.661621 } } }]);
  // ① details 副统计量:17.66 vs 17.661621(四舍五入到两位命中)
  assert.deepEqual(checkNumberFidelity(rep(`近五年最低 17.66 倍 [${CID}]`), evMap([]), c).violations, []);
  // ② 量纲换算:272.40 亿 vs inputs 27239985194.41 元(×1e-8 后取两位)
  const c2 = calcMap([{ id: CID, output: { status: "ok", value: 11, unit: "期", display: "11 期" },
                        inputs: { cumulative: [{ value: 27239985194.41 }] } }]);
  assert.deepEqual(checkNumberFidelity(rep(`单季扣非 272.40 亿元 [${CID}]`), evMap([]), c2).violations, []);
  // ③ 小数→百分比:19.52% vs details.range_over_mean 0.1952(×100 后取两位)
  const c3 = calcMap([{ id: CID, output: { status: "ok", value: 1.21, unit: "倍", display: "1.21 倍",
                                           details: { range_over_mean: 0.19524189261031363 } } }]);
  assert.deepEqual(checkNumberFidelity(rep(`一致预期分歧 19.52% [${CID}]`), evMap([]), c3).violations, []);
});
test("无符号 token 不许绑到带负号的文本:方向不能反", () => {
  const ev = evMap([["ev-dddddddddddd", "同比 -1.92%"]]);
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  // 没有方向词时,"1.92%" 不能靠子串命中 "-1.92%"
  assert.equal(checkNumberFidelity(rep(`同比为 1.92% [ev-dddddddddddd] [${CID}]`), ev, calcs).violations.length, 1);
  // 有方向词时走 `-token` 这条路,允许
  assert.deepEqual(checkNumberFidelity(rep(`同比下降 1.92% [ev-dddddddddddd] [${CID}]`), ev, calcs).violations, []);
  // 正向词不走:文本证据是 -1.92%,写「上升 1.92%」是方向写反
  assert.equal(checkNumberFidelity(rep(`同比上升 1.92% [ev-dddddddddddd] [${CID}]`), ev, calcs).violations.length, 1);
});

test("只有失败结果残留 display 时不算适用", () => {
  const calcs = calcMap([{ id: CID, output: { status: "error", value: null, unit: "倍", display: "37.40 倍" } }]);
  assert.equal(checkNumberFidelity(rep(`| PE | 99.99 倍 | ${CID} |`), evMap([]), calcs).applicable, false);
});

test("符号边界要能识别带空格的负号与 Unicode 负号", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  for (const hist of ["同比 - 1.92%", "同比 −1.92%", "同比 -1.92%"]) {
    // 无方向词:正数不许绑到负值
    assert.equal(checkNumberFidelity(rep(`同比为 1.92% [${CID}]`), evMap([]), calcs, undefined, [hist]).violations.length, 1, hist);
    // 有方向词:引用历史负值是正当写法(r3 的符号边界一度把它也拦了)
    assert.deepEqual(checkNumberFidelity(rep(`同比下降 1.92% [${CID}]`), evMap([]), calcs, undefined, [hist]).violations, [], hist);
  }
});

test("行内显式负号要按负值绑定;markdown 列表标记与破折号不是负号", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  const pos = evMap([["ev-eeeeeeeeeeee", 1.92, "%"]]);
  // 证据是 +1.92,报告写 −1.92%(Unicode 负号)→ 方向反了,必须违规
  assert.equal(checkNumberFidelity(rep(`同比为 −1.92% [ev-eeeeeeeeeeee] [${CID}]`), pos, calcs).violations.length, 1);
  assert.equal(checkNumberFidelity(rep(`同比为 - 1.92% [ev-eeeeeeeeeeee] [${CID}]`), pos, calcs).violations.length, 1);
  const neg = evMap([["ev-ffffffffffff", -1.92, "%"]]);
  assert.deepEqual(checkNumberFidelity(rep(`同比为 −1.92% [ev-ffffffffffff] [${CID}]`), neg, calcs).violations, []);
  // 行首列表标记不是负号
  assert.deepEqual(checkNumberFidelity(`## 估值\n- 1.92% 为同比 [ev-eeeeeeeeeeee] [${CID}]\n`, pos, calcs).violations, []);
  // 破折号也不是负号
  assert.deepEqual(checkNumberFidelity(rep(`毛利率—1.92% [ev-eeeeeeeeeeee] [${CID}]`), pos, calcs).violations, []);
});

test("行首的 Unicode 负号是负号,不是列表标记", () => {
  const calcs = calcMap([{ id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } }]);
  const pos = evMap([["ev-999999999999", 1.92, "%"]]);
  // markdown 列表标记只会是 ASCII `-`;行首 `−` 就是负数
  assert.equal(checkNumberFidelity(`## 估值\n−1.92% 为同比 [ev-999999999999] [${CID}]\n`, pos, calcs).violations.length, 1);
  const neg = evMap([["ev-888888888888", -1.92, "%"]]);
  assert.deepEqual(checkNumberFidelity(`## 估值\n−1.92% 为同比 [ev-888888888888] [${CID}]\n`, neg, calcs).violations, []);
  // ASCII 行首仍按列表标记处理
  assert.deepEqual(checkNumberFidelity(`## 估值\n- 1.92% 为同比 [ev-999999999999] [${CID}]\n`, pos, calcs).violations, []);
});

test("词表注册的护栏:按用途校验正则标志,且不许两个插件并存", async () => {
  const { setLexicon, resetLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  // ⚠️ 身份检查在最前面 ⇒ 已注册状态下,任何**另一份**词表都会先被"多垂类并存"拦下,
  //    根本走不到标志校验。要测标志校验必须先 reset(这个顺序本身就是设计)。
  resetLexicon();
  const bad = { ...FINANCE_LEXICON, moneyBefore: /x/g };          // .test() 用的不许带 g
  assert.throws(() => setLexicon(bad as never), /不许带 g\/y/);
  const bad2 = { ...FINANCE_LEXICON, subjectCodePatterns: [/\d{6}/] };  // .replace() 用的必须带 g
  assert.throws(() => setLexicon(bad2 as never), /必须带 g/);
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, labelPatterns: [/2\s*倍/] } as never), /labelPatterns\[0\].*必须带 g/);
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, labelPatterns: /2/g } as never), /labelPatterns 必须是 RegExp 数组/);
  setLexicon(FINANCE_LEXICON);
  // 进程级单例:换一份就当场失败,而不是静默串包
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON } as never), /不支持多垂类并存/);
  setLexicon(FINANCE_LEXICON);                              // 同一份幂等,不抛
  resetLexicon();
  setLexicon(FINANCE_LEXICON);                              // 复原,不影响同文件其它用例
});

test("非正则值不能混过注册(否则要等到 .test() 时才崩)", async () => {
  const { setLexicon, resetLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, moneyBefore: "美元" } as never), /必须是 RegExp/);
  setLexicon(FINANCE_LEXICON);
});

test("注册后的词表不能被原地改;.replace() 字段不许带 y", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const lex = { ...FINANCE_LEXICON, subjectCodePatterns: [...FINANCE_LEXICON.subjectCodePatterns] };
  setLexicon(lex as never);
  // 原地改外部对象不该影响已注册的快照
  (lex as { moneyBefore: RegExp }).moneyBefore = /恶意/g;
  lex.subjectCodePatterns.push(/恶意/g);
  assert.notEqual(currentLexicon().moneyBefore.source, "恶意");
  assert.equal(currentLexicon().subjectCodePatterns.length, FINANCE_LEXICON.subjectCodePatterns.length);
  // sticky 正则会让 replace 常常一次都匹配不到
  resetLexicon();
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, windowLabelPattern: /\d+日/gy } as never), /不许带 y/);
  setLexicon(FINANCE_LEXICON);
});

test("同一份词表重复注册必须是真幂等:改完再注册不能替换活动快照", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const lex = { ...FINANCE_LEXICON, subjectCodePatterns: [...FINANCE_LEXICON.subjectCodePatterns] };
  setLexicon(lex as never);
  // 改完原对象再注册一次:必须**安静返回**(不重做快照,也不因校验抛错)
  (lex as { moneyBefore: RegExp }).moneyBefore = /完全不同的规则/g;   // 连非法标志一起改
  setLexicon(lex as never);
  assert.notEqual(currentLexicon().moneyBefore.source, "完全不同的规则");
  resetLexicon();
  setLexicon(FINANCE_LEXICON);
});

test("两个 .replace() 字段的形状不同,不能一把抓;失败也不许留下半注册状态", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  // subjectCodePatterns 必须是数组;windowLabelPattern 必须是单个正则
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, subjectCodePatterns: /代码/g } as never), /必须是 RegExp 数组/);
  assert.throws(() => setLexicon({ ...FINANCE_LEXICON, windowLabelPattern: [/窗口/g] } as never), /必须是 RegExp/);
  // 🔴 失败之后必须还能正常注册 —— 半注册状态会让进程永久卡在"未注入"
  setLexicon(FINANCE_LEXICON);
  assert.ok(currentLexicon().moneyBefore instanceof RegExp);
});

test("快照必须克隆正则:RegExp.compile() 能原地改 source/flags,共享对象就不叫快照", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const re = /ABC/g;
  setLexicon({ ...FINANCE_LEXICON, subjectCodePatterns: [re] } as never);
  (re as unknown as { compile: (s: string, f: string) => void }).compile("XYZ", "gy");
  assert.equal(currentLexicon().subjectCodePatterns[0].source, "ABC");   // 快照不受影响
  assert.ok(!currentLexicon().subjectCodePatterns[0].flags.includes("y"));
  resetLexicon();
  setLexicon(FINANCE_LEXICON);
});

test("注册只读词表自己的六个字段:无关的 getter 抛错不该让注册失败", async () => {
  const { setLexicon, resetLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const lex: Record<string, unknown> = { ...FINANCE_LEXICON };
  Object.defineProperty(lex, "unrelated", { enumerable: true, get() { throw new Error("boom"); } });
  setLexicon(lex as never);                       // 不该炸
  resetLexicon();
  // 每个字段只读一次:第二次读会返回非法值的 getter 不该被读到
  let n = 0;
  const tricky: Record<string, unknown> = { ...FINANCE_LEXICON };
  Object.defineProperty(tricky, "subjectCodePatterns", {
    enumerable: true, get() { return ++n === 1 ? [/safe/g] : "changed"; },
  });
  setLexicon(tricky as never);
  assert.equal(n, 1);
  resetLexicon();
  setLexicon(FINANCE_LEXICON);
});

test("注册不支持重入:带行为的正则不能在校验途中偷偷注册另一份", async () => {
  const { setLexicon, resetLexicon, currentLexicon } = await import("../src/number_fidelity.ts");
  const { FINANCE_LEXICON } = await import("../src/finance/lexicon.ts");
  resetLexicon();
  const hostile = /x/;
  let reentryError: unknown = null;
  Object.defineProperty(hostile, "flags", {
    get() {
      try { setLexicon({ ...FINANCE_LEXICON } as never); } catch (e) { reentryError = e; }
      return "";
    },
  });
  // 外层注册本来就该成功(它是合法的第一份);被拦的是**内层重入** ——
  // 攻击路径是"内层先注册另一份、外层再覆盖",守卫在第一步就断掉了
  setLexicon({ ...FINANCE_LEXICON, moneyBefore: hostile } as never);
  assert.match(String(reentryError), /不支持重入/);
  assert.equal(currentLexicon().moneyBefore.source, "x");    // 生效的是外层那份,没被内层换掉
  resetLexicon();
  setLexicon(FINANCE_LEXICON);
  assert.ok(currentLexicon().moneyBefore instanceof RegExp);
});

test("🔴 ≥1 万的整数（股数 / 成交量）引错 id 也要报，并指出这个数实际在哪条证据（2026-10-09 港股真跑）", () => {
  const ev = new Map([
    ["ev-397e27e2e0aa", { value: 445411635174 }],   // 10-08 南向持股市值
    ["ev-0eaa4fffa780", { value: 1079451366 }],     // 09-30 南向持股股数
    ["ev-c3bfb85df797", { value: 0 }],
  ]);
  const check = (line: string) => checkNumberFidelity(`## 资金与市场行为\n${line}`, ev as never, new Map() as never, "00700.HK").evidenceViolationDetails;
  const bad = check("2026-09-30 持股 1079451366 股 [ev-397e27e2e0aa],较上一日变动 0 股 [ev-c3bfb85df797]");
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0]!.foundIn, ["ev-0eaa4fffa780"]);
  assert.match(summarizeFidelityViolations(bad), /这个数在 ev-0eaa4fffa780（同行没引它，或引错了 id）/);
  assert.deepEqual(check("2026-09-30 持股 1079451366 股 [ev-0eaa4fffa780]"), [], "引对了就放行");
  assert.deepEqual(check("近 5 年里有 3 家机构 [ev-c3bfb85df797]"), [], "小整数计数仍豁免");
  // 像代码 / 紧凑日期的整数是编号：600088、00700、300308.SZ、选池运行 ds2-20260903
  assert.deepEqual(check("候选 600088 中视传媒、00700 腾讯、300308.SZ [ev-c3bfb85df797]，来自运行 ds2-20260903"), []);
});

test("逗号只有后面正好 3 位数字才算千分位：「years=1,33 家」不能读成 133（ht-global3 真踩）", () => {
  const nums = (line: string) => claimNumbers(line, "00700");
  assert.deepEqual(nums("前瞻 CAGR(years=1,33 家,区间 27.6–34.19 元/股)"), [33, 27.6, 34.19]);
  assert.deepEqual(nums("市值 3,825,848,811,520 港元、均价 1,234.56 元"), [3825848811520, 1234.56]);
  assert.deepEqual(nums("档位 25,50,75 bp"), [25, 50, 75]);
});

test("🔴 档案引用只放行本次没有的旧值：本次证据 / 计算里就有的数，同行必须引它（2026-10-09 ht-global3 真踩）", () => {
  const C2 = "calc-2222222222222222";
  const ev = evMap([["ev-aaaaaaaaaaaa", 27.6, "%"]]);
  const calcs = calcMap([
    { id: CID, output: { status: "ok", value: 1, unit: "倍", display: "1.00 倍" } },
    { id: C2, output: { status: "ok", value: 34.19, unit: "倍", display: "34.19 倍" } },
  ]);
  const quoted = ["上次:毛利率 27.6%,PE 34.19 倍,旧 CAGR 59.09%"];
  const check = (body: string) => checkNumberFidelity(rep(body), ev, calcs, undefined, quoted);
  const bad = check(`| 毛利率 27.6% · PE 34.19 倍 · 结果 1.00 倍 | ${CID} |`);
  assert.deepEqual(bad.violationDetails.map((d) => [d.token, d.foundIn]), [["27.6%", ["ev-aaaaaaaaaaaa"]], ["34.19倍", [C2]]],
    "档案里有、本次也有 → 不靠档案放行，并指出本次在哪");
  assert.match(summarizeFidelityViolations(bad.violationDetails), /同行没引它，或引错了 id/);
  assert.deepEqual(check(`| 毛利率 27.6% · PE 34.19 倍 | ${CID} ev-aaaaaaaaaaaa ${C2} |`).violations, [], "同行引了就放行");
  assert.deepEqual(check(`| 旧 CAGR 59.09% 不再适用，本次 1.00 倍 | ${CID} |`).violations, [], "本次没有的旧值照样靠档案放行");
});

test("规则阈值里的数字不当数据：分歧「2 倍」阈值；具体倍数照样核对", () => {
  assert.deepEqual(claimNumbers("裁决点：一致预期 max/min 升至 2 倍以上即视为分歧扩大"), []);
  assert.deepEqual(claimNumbers("分歧仍大：max ÷ min = 2.5 倍"), [2.5], "具体的分歧倍数是数据");
  assert.deepEqual(claimNumbers("估值约 2 倍市净率"), [2], "没有分歧语境的 2 倍照样核对");
  assert.deepEqual(claimNumbers("分歧不大。PE 2 倍"), [2], "分歧和倍数隔了句号就不算同一句");
});

test("🔴 重复的章节标题不清掉前面那一节:第一节里带真实引用的错数照样要报(审计第三轮 A4)", () => {
  const ev = evMap([["ev-bbbbbbbbbbbb", 39.03, "元/股"]]);
  const twice = "## 事实\n- EPS 为 70.96 元/股 [ev-bbbbbbbbbbbb]\n\n## 事实\n- EPS 为 39.03 元/股 [ev-bbbbbbbbbbbb]\n";
  const r = checkNumberFidelity(twice, ev, calcMap([]));
  assert.equal(r.evidenceViolations?.length, 1, JSON.stringify(r));
  assert.match(r.evidenceViolations![0]!, /70\.96/);
});
