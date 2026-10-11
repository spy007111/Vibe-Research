import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

import { gateRegexps, gateStagePatterns, gatePatterns, gateExemptLines } from "../src/config.ts";
import { stageComplianceErrors } from "../src/validator.ts";
import { complianceGate, missingSections, normalizeReportStatus, referencedIds, reportStatusToken, probeReportLine } from "../src/gate.ts";
import { reportSections } from "../src/config.ts";
import { applyGate } from "../src/chat.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
test("合规 gate:命中建仓 / 目标价类词", () => {
  const r = complianceGate("## 结论摘要\n- 建议在 900 元附近建仓\n- 目标价 1200 元");
  assert.equal(r.ok, false);
  // 「建议在 900 元附近建仓」同时命中子串「建仓」和第三轮补的「建议+条件+动作」
  assert.deepEqual(r.hits.map((h) => h.pattern).sort(), ["建仓", "建议+条件+动作", "目标价"]);
  assert.equal(r.hits[0].line, 2);
});

test("合规 gate:只有整行精确等于固定免责句才豁免;'不构成投资建议,但建议建仓'不放过", () => {
  assert.equal(complianceGate("本报告不提供任何投资动作建议(建仓 / 加减仓 / 目标价 / 止损位)。\n## 事实\n- PE 53.9 倍 ev-aaaaaa").ok, true);
  assert.equal(complianceGate("- 本报告不提供任何投资动作建议。").ok, true); // 列表前缀允许
  const bad = complianceGate("本报告不构成投资建议,但建议建仓。");
  assert.equal(bad.ok, false);
  assert.equal(complianceGate("本报告不提供任何投资动作建议(建仓 / 加减仓 / 目标价 / 止损位)。但目标价 1200").ok, false);
});

test("合规 gate:正常报告通过", () => {
  assert.equal(complianceGate("## 估值\n- 扣非×4 PE = 37.4 倍(calc-0123456789abcdef)\n## 裁决点\n- 若 Q3 单季扣非环比转负,增长加速判断被推翻").ok, true);
});

test("章节缺失检测", () => {
  const report = "# X 研究报告 · 状态:complete\n## 结论摘要\n## 事实\n## 推断\n## 估值\n## 风险与反证\n## 裁决点\n";
  assert.deepEqual(missingSections(report, [...reportSections()]), ["数据缺口"]);
});

test("引用 id 提取去重", () => {
  const r = referencedIds("ev-aaaaaa ev-aaaaaa calc-0123456789abcdef ev-bbbbbb calc-0123456789abcdef");
  assert.deepEqual(r.evidence.sort(), ["ev-aaaaaa", "ev-bbbbbb"]);
  assert.deepEqual(r.calculation, ["calc-0123456789abcdef"]);
});

test("报告状态标记读取与归一", () => {
  const rep = "# X 研究报告 · 状态:complete\n## 结论摘要\n";
  assert.equal(reportStatusToken(rep), "complete");
  const n = normalizeReportStatus(rep, "incomplete");
  assert.equal(n.changed, true);
  assert.equal(reportStatusToken(n.text), "incomplete");
  assert.equal(normalizeReportStatus(n.text, "incomplete").changed, false);
  assert.equal(reportStatusToken("# 无状态"), null);
});

test("gate 正则规则:审计列出的绕过说法必须全拦,真实语料零误报(全审 r3-P1-1)", () => {
  // 旧实现(26 个中文子串)对这些**一条都拦不住**
  const BYPASS = ["当前价格值得买入", "可考虑介入", "建议继续持有", "跌破 50 元离场",
    "合理价格看至 120 元", "BUY, target price RMB 120", "风险收益比合适,可以参与",
    "评级:买入", "越跌越买", "go long here", "stop-loss 设在 80", "long position 建立"];
  for (const s of BYPASS) assert.equal(complianceGate(s).ok, false, `应被拦:${s}`);

  // 🔴 反向同样重要:这些是**合法内容**,拦了就等于拒掉正确的产出
  const LEGIT = [
    "报告不含投资动作建议、目标价、止损位或价格锚。",     // 免责声明里"提到"这些词
    "近一年机构报告 38 篇,其中买入评级 31 篇、增持评级 7 篇;仅作覆盖分布线索。",
    "四锚为 PE 情景,不是目标价或合理价。",
    "margin_financing_buy | 6191310178 | 元",              // 字段名里的 buy 不算
  ];
  for (const s of LEGIT) {
    const r = complianceGate(s, [], [], gateRegexps());   // 只看正则规则(子串表另有豁免机制)
    assert.equal(r.ok, true, `不该被正则拦:${s} → ${JSON.stringify(r.hits)}`);
  }
});

test("开源审计补充:常见建议话术全拦，机构评级分布在最终报告中放行", () => {
  const blocked = [
    "建议减持", "维持买入", "重点推荐", "建议超配", "可以低吸", "介入位置 80 元",
    "具有配置价值", "适合中长期持有", "现在可以上车", "这是首选标的", "可择机参与",
    "给予该公司买入评级", "建议给予增持评级", "维持卖出评级",
    "中际旭创：首次覆盖，买入评级", "对该公司评级为买入", "中际旭创：买入评级",
    "中际旭创获减持评级", "对中际旭创给出减持评级", "中际旭创被评为减持评级",
  ];
  for (const text of blocked) assert.equal(complianceGate(text).ok, false, `应被拦:${text}`);
  const ratingDistribution = "近一年机构报告 38 篇，其中买入评级 31 篇、增持评级 7 篇；仅作覆盖分布线索。";
  assert.equal(complianceGate(ratingDistribution).ok, true, "合法的机构评级统计不应被最终报告 gate 误拦");
  assert.equal(complianceGate("机构评级：买入评级 31 篇、增持评级 7 篇。 ").ok, true, "标题式聚合统计也应合法");
  assert.equal(complianceGate("近一年机构评级为买入 31 篇、增持评级 7 篇。 ").ok, true, "赋值式聚合统计也应合法");
});

test("阶段产物 gate:词表收窄后既拦得住建议、又放得过免责与统计(全审 r3-P1-2)", () => {
  const sub = gateStagePatterns();
  assert.ok(!sub.includes("目标价") && !sub.includes("止损"), "会出现在'提及'语境的词必须去掉");
  assert.ok(sub.includes("建仓") && sub.includes("建议买"), "明确动作词必须留着");
  for (const bad of ["建议买入,目标价 120 元", "可考虑介入", "跌破 80 元止损", "建议建仓 30%"]) {
    assert.equal(complianceGate(bad, sub, [], gateRegexps()).ok, false, `应被拦:${bad}`);
  }
  for (const okText of ["报告不含投资动作建议、目标价、止损位。", "买入评级 31 篇、增持评级 7 篇"]) {
    assert.equal(complianceGate(okText, sub, [], gateRegexps()).ok, true, `不该被拦:${okText}`);
  }
  // 递归收集:建议藏在嵌套字段里也要抓到,而 id 类字段不参与
  const rec = { stage: "risk", summary: "正常", gaps: [{ operation: "x", reason_code: "y", detail: "建议加仓至 30%" }],
    evidence_ids: ["ev-abc123"], counter_evidence: [{ claim: "ok", counter: "ok" }] };
  const errs = stageComplianceErrors("risk", rec);
  assert.ok(errs.length >= 1, JSON.stringify(errs));  // 同一行可能同时命中子串与正则,条数不写死
  assert.match(errs[0], /触发产出红线/);
  assert.equal(stageComplianceErrors("risk", { ...rec, gaps: [] }).length, 0);
});

test("referencedIds 必须整 token 匹配:伪前缀引用不算(全审 r1-P2-4)", () => {
  const real = "ev-abcdef123456";
  // 有边界:正常引用认得出
  assert.deepEqual(referencedIds(`营收 99 亿元(${real})`).evidence, [real]);
  // 无边界时 `ev-abcdef123456xyz` 会截出合法前缀,伪引用就能满足"引用存在"
  assert.deepEqual(referencedIds(`营收 99 亿元(${real}xyz)`).evidence, []);
  assert.deepEqual(referencedIds(`x${real}`).evidence, []);
  const c = "calc-0123456789abcdef";
  assert.deepEqual(referencedIds(`(${c})`).calculation, [c]);
  assert.deepEqual(referencedIds(`(${c}00)`).calculation, []);
});

test("gaps[].operation 也是自由文本,必须过 gate(修复复审 r1-P1-3)", () => {
  // 🔴 它曾被当成"标识符"排除在 gate 之外 —— 但 schema 上只要求非空字符串,
  //    建议写进去就能绕过阶段 gate 并原样进附录。判断标准是**取值受不受控**,不是名字像不像标识符。
  const rec = { stage: "risk", summary: "正常", gaps: [{ operation: "建议买入并建仓三成", reason_code: "source_failed", detail: "x" }] };
  assert.ok(stageComplianceErrors("risk", rec).length >= 1, JSON.stringify(stageComplianceErrors("risk", rec)));
  // reason_code 是受控枚举,不该被当自由文本
  const ok = { stage: "risk", summary: "正常", gaps: [{ operation: "fetch_x", reason_code: "source_failed", detail: "x" }] };
  assert.deepEqual(stageComplianceErrors("risk", ok), []);
});

/**
 * 绊线:**四个参数全给齐时,gate 不需要任何已注册的插件**。
 *
 * 🔴 注册期自检就靠这条:它在插件注册**完成之前**调 complianceGate,
 *    此刻 `currentPlugin()` 还拿不到东西。哪天有人给 complianceGate 加了第五个
 *    带默认值的参数、而那个默认值去读插件,自检会当场崩(或更糟:读到上一个插件的规则)。
 * ⚠️ 不能用 `complianceGate.length` 查 —— `Function.length` 只数**第一个默认值之前**的形参,
 *    这个函数是 1,加第五个默认参数它还是 1,**那条断言永远不会红**。
 *    ⇒ 只能直接测不变量本身:开一个没注册插件的干净进程跑一遍。
 */
test("绊线:参数给齐时 gate 不碰插件(注册期自检依赖这一点)", () => {
  const code = [
    'import { complianceGate } from "./src/gate.ts";',
    'const r = complianceGate("- 这里建议建仓", ["建仓"], [], []);',
    'if (r.ok) { console.log("NOT_BLOCKED"); } else { console.log("OK"); }',
  ].join("\n");
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const out = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
    cwd: repo, encoding: "utf8",
  });
  assert.equal(out.status, 0, `没注册插件就调不动 gate 了 —— 注册期自检会跟着崩:\n${out.stderr.slice(-600)}`);
  assert.ok(out.stdout.includes("OK"), out.stdout + out.stderr.slice(-400));
});

/** 探针拼装函数:注册期自检与真正注入必须用它,两边不能各拼各的 */
test("probeReportLine 会把探针包进报告行", () => {
  const line = probeReportLine("XX");
  assert.ok(line.includes("XX") && line.startsWith("- "), line);
  // 包装本身必须是干净的 —— 否则自检的对照组会炸(见 plugin.ts 注册期)
  assert.equal(complianceGate(probeReportLine("中性对照内容"), gatePatterns(), gateExemptLines(), gateRegexps()).ok, true);
});

/**
 * 行首前缀只剥**真的 Markdown 前缀**,不吃正文语义符号。
 * 🔴 两个方向都要测:剥少了 → 列表里的违规行漏判;剥多了 → `>18%` / `-1 倍` / `*ST`
 *    这类以符号开头的正文被改写,依赖这些符号的规则会静默永不命中(审计 gate-r3)。
 */
test("行首只剥 Markdown 前缀,正文里的 - * > 保留", () => {
  const seen = (text: string, pattern: string) => complianceGate(text, [pattern], [], []).hits[0]?.text;
  // 该剥的:列表 / 引用 / 有序列表 / 嵌套
  assert.equal(seen("- 建议建仓", "建仓"), "建议建仓");
  assert.equal(seen("* 建议建仓", "建仓"), "建议建仓");
  assert.equal(seen("> 建议建仓", "建仓"), "建议建仓");
  assert.equal(seen("1. 建议建仓", "建仓"), "建议建仓");
  assert.equal(seen(">> - 建议建仓", "建仓"), "建议建仓");
  // 不该剥的:符号紧贴内容 = 正文的一部分
  assert.equal(seen(">18% 就建仓", "建仓"), ">18% 就建仓");
  assert.equal(seen("-1 倍就建仓", "建仓"), "-1 倍就建仓");
  assert.equal(seen("*ST 也建仓", "建仓"), "*ST 也建仓");
  // ⚠️ 无论剥不剥,**违规都照样命中** —— 子串匹配与位置无关。
  //    剥前缀只影响"命中行长什么样"与"整行豁免比不比得上",不影响拦不拦。
  for (const t of ["- 建议建仓", ">18% 就建仓", "-1 倍就建仓", "*ST 也建仓"]) {
    assert.equal(complianceGate(t, ["建仓"], [], []).ok, false, t);
  }
});

test("🔴 直接买卖指令(没有「建议」前缀)和英文大小写变体都要拦;回测规则、新闻事实、字段名照常放行(审计 B7)", () => {
  const blocked = ["现在买入苹果股票。", "应当买入 AAPL。", "Buy AAPL now.", "buy AAPL", "Sell 00700 today", "立即卖出", "马上清仓",
    "你应该买进这只股票", "务必尽快卖出", "You should buy the stock.", "Consider selling it.", "short TSLA", "buy it now", "sell the dip",
    // 审计第二轮 B7:代码 / 动作换大小写、建议语气的其它说法
    "buy aapl now.", "buY AAPL now.", "你应该现在买入", "We recommend you buy AAPL.", "Now is a good time to buy NVDA.", "I would buy AAPL here.",
    "I'd sell it.", "Recommended to buy.", "结论:立即卖出", "建议现在加仓", "Sell 00700.", "Just buy msft."];
  for (const s of blocked) assert.equal(complianceGate(s, [], [], gateRegexps()).ok, false, `应被拦:${s}`);
  const legit = ["买入持有策略的年化收益为 8.2%", "信号次日开盘买入,收盘卖出", "北向资金今日买入 30 亿元", "当天买入的需要次日才能卖出(T+1)",
    "margin_financing_buy | 6191310178 | 元", "buy-and-hold 基准", "机构专用席位买入 1.2 亿元", "the buy side expects", "Buyback program of $10B",
    "对应买入日期 2025-01-02", "回测从此前收盘价计算",
    // 审计第二轮 B7:历史成交、策略规则、收购新闻、陈述句里的 buy
    "历史成交记录:当时立即买入 100 股。", "金叉出现后立即买入", "Apple to buy AI startup.", "Berkshire agreed to buy OXY shares.",
    "Investors continued to buy AAPL.", "Investors continued to buy AAPL today.", "此时买入的投资者已亏损 20%", "Short interest today rose 5%.",
    "Buy and hold returned 8%.", "Sell side analysts expect growth.", "Buy 评级 12 家", "We will buy back shares.", "single_quarters: short }"];
  for (const s of legit) {
    const r = complianceGate(s, [], [], gateRegexps());
    assert.equal(r.ok, true, `不该被正则拦:${s} → ${JSON.stringify(r.hits)}`);
  }
});

test("🔴 Markdown 把禁词拆开时按页面显示出来的文字拦:链接、图片、行内代码、字符实体、标签(审计第三轮 A2)", () => {
  for (const s of ["建议[建](https://example.org)仓。", "建议[建][ref]仓", "![建](x.png)仓位很重", "建议`建`仓", "建议&#24314;仓", "建议&#x5efa;仓", "建议<b>建</b>仓"]) {
    assert.equal(complianceGate(s).ok, false, s);
  }
  // 正则规则同样按显示出来的文字查:原文里 Buy 后面紧跟 `]`,拆开后才是「Buy AAPL now」
  assert.equal(complianceGate("[Buy](https://example.org) AAPL now.").ok, false);
  // 链接只是普通引用时不误拦
  assert.equal(complianceGate("详见[公司公告](https://example.org/a_b)与 `fetch_kline` 的结果。").ok, true);
});

test("🔴 缩略引用链接 `[仓]` 配上别处的 `[仓]: 网址`,页面显示「建仓」也要拦;没定义时方括号原样显示,不当成链接(第四轮审计 A1)", () => {
  for (const s of ["建议建[仓]。\n\n[仓]: https://example.org", "建议建[仓]。\n\n[仓]: <https://example.org> \"t\"", "- 建议建[ 仓 ]\n\n   [仓]: https://example.org",
    "> 建议[建]仓\n>\n> [建]: https://example.org", "建议[Buy] AAPL now.\n\n[buy]: https://example.org"]) {
    assert.equal(complianceGate(s).ok, false, s);
  }
  // 没有定义:页面上就是「建[仓]」,和原来一样不拆方括号
  assert.equal(complianceGate("见附注[1]与[仓位说明]。").ok, true);
  assert.equal(complianceGate("详见[公司公告]。\n\n[公司公告]: https://example.org").ok, true);
});

test("🔴 同一段里跨行写的链接 / 软换行,页面上连成一个词也要拦,并且整段都标出来;空行、列表项、标题、代码围栏隔开的不拼(审计 2026-10-11 Codex 范围 4 第 2 条)", () => {
  for (const s of ["建议建[仓](\nhttps://example.org)", "建议建[\n仓](https://example.org)。", "- 建议建[仓](\n  https://example.org)", "> 建议建\n> 仓", "建议建\n仓,理由如下。"]) {
    const g = complianceGate(s);
    assert.equal(g.ok, false, JSON.stringify(s));
    assert.deepEqual([...new Set(g.hits.map((h) => h.line))], [1, 2], `整段两行都要标出:${JSON.stringify(s)}`);
  }
  // 按行移除时整段一起去掉,不留半截链接
  const two = complianceGate("前文正常。\n\n建议建[仓](\nhttps://example.org)\n\n后文正常。");
  assert.deepEqual([...new Set(two.hits.map((h) => h.line))], [3, 4]);
  // 分开的块不拼:空行、列表项、标题、表格行、代码围栏
  for (const s of ["建议建\n\n仓位说明见附表。", "- 建议建\n- 仓位说明见附表。", "## 建议建\n仓位说明见附表。", "| 建议建 |\n| 仓位 |", "```\n建议建\n仓\n```"]) {
    assert.equal(complianceGate(s).ok, true, JSON.stringify(s));
  }
  // 🔴 同一段里先有一行逐行命中、后面几行又跨行拼出同一个词:后面几行也要标出来,移除后不能留下这个词(v2.2.0 审计 Codex 第 1 条)
  const mixed = "建议建仓甲公司。\n建议建[仓](\nhttps://example.org)乙公司。";
  assert.deepEqual([...new Set(complianceGate(mixed).hits.map((h) => h.line))], [1, 2, 3]);
  const cleaned = applyGate(mixed).reply;
  assert.equal(complianceGate(cleaned).ok, true, `移除后还剩红线:${cleaned}`);
  assert.doesNotMatch(cleaned, /乙公司|example/);
  // 已命中的行移除后会换成提示,把段落隔开:它上下两行不再拼在一起
  assert.deepEqual([...new Set(complianceGate("建议建\n建议建仓甲公司。\n仓位说明见附表。").hits.map((h) => h.line))], [2]);
  // 逐行已命中的规则不重复记整段
  const once = complianceGate("建议建仓。\n下一行正常。");
  assert.deepEqual([...new Set(once.hits.map((h) => h.line))], [1]);
  const keys = once.hits.map((h) => `${h.line}|${h.pattern}`);
  assert.equal(new Set(keys).size, keys.length, `同一行同一规则只记一次:${keys}`);
  // 阶段产物里不同字段的文字各自成段,不首尾拼接
  assert.deepEqual(stageComplianceErrors("s", { a: "成交额前十里建议建", b: "仓位数据缺失" }), []);
  assert.notDeepEqual(stageComplianceErrors("s", { a: "建议建\n仓" }), []);
});

test("🔴 建议语气和买卖动作中间插了条件 / 价位也拦;叫人看信息、陈述事实的不拦(审计第三轮 B1)", () => {
  for (const s of ["建议在回调后买入苹果股票。", "建议等股价回到 150 美元以下再分批买入", "推荐在财报发布前加仓", "不妨趁回调低吸", "可考虑在放量突破后进场",
    "应该在回调后买入", "可以等回调到 900 元再买入", "务必在财报前清仓", "值得在当前位置买进"]) {
    assert.equal(complianceGate(s).ok, false, s);
    assert.equal(complianceGate(`## 结论\n- ${s}\n`).ok, false, `报告里:${s}`);
  }
  for (const s of ["可以看到北向资金连续三日买入", "值得一提的是北向资金净买入 3 亿元", "建议关注北向资金买入动向", "可以说是机构在卖出", "应该是机构在卖出",
    "值得注意的是主力资金连续卖出", "建议结合龙虎榜买入席位判断", "可以理解为游资在卖出", "建议核实公告中的买入金额", "建议对比两家公司的买入成本", "建议关注主力是否持续买入",
    "公司计划在三季度买入设备", "最好的一笔是去年 3 月买入", "可以发现外资在持续买入的股票集中在消费"]) {
    assert.equal(complianceGate(s).ok, true, s);
  }
});

test("🔴 个股涨跌预测也拦(阶段摘要和报告正文);历史涨跌、经营预期、没有时点的说法不拦(第四轮审计 B4)", () => {
  for (const s of ["未经核实线索:预计贵州茅台明天会大涨。", "茅台明天大概率涨停", "预计宁德时代下周反弹", "苹果未来几天将大幅上涨", "下个交易日有望拉升"]) {
    assert.equal(complianceGate(s).ok, false, s);
    assert.equal(complianceGate(`## 结论\n- ${s}\n`).ok, false, `报告里:${s}`);
    assert.equal(complianceGate(s, gateStagePatterns(), [], gateRegexps()).ok, false, `阶段产物:${s}`);
  }
  for (const s of ["去年 3 月股价上涨 30%", "预计明年营收将大幅增长", "公司预计下周召开股东大会", "上周五茅台下跌 2.1%", "明天公布三季报",
    "财报发布后第一个交易日平均上涨 1.2%", "过去五次财报后的平均绝对涨跌是 3.4%", "机构:后市有望继续上涨(新闻标题原文)"]) {
    assert.equal(complianceGate(s).ok, true, s);
  }
});
