import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import "../src/finance/register.ts"; // 数字判定的词表由插件注册
import type { AssistantTool } from "../src/assistant_bridge.ts";
import { chatSend, resetChatSessions } from "../src/chat.ts";
import type { ChatReply, ChatRequest } from "../src/engines/direct_transport.ts";
import { FINANCE_GATE_LABELS } from "../src/finance/lexicon.ts";
import { NUMBER_MARK, bound, gateNumbers, nearInPool, registerGateLabels, sourceNumbers } from "../src/number_gate.ts";
import type { RunLocalAgentOptions } from "../src/local_agent_runtime.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const body = (r: { reply: string }) => r.reply.split("\n\n※")[0];

test("有出处的数字原样保留:万 / 亿 / 百分数换算、四舍五入、负数写成「下降」都认", () => {
  const src = ['{"margin_balance": 32526887117, "growth": -0.052, "pe": 46.5618}'];
  const r = gateNumbers("融资余额 325.27 亿元，同比下降 5.2%，市盈率 46.56 倍。", src);
  assert.equal(r.masked, 0);
  assert.equal(r.reply, "融资余额 325.27 亿元，同比下降 5.2%，市盈率 46.56 倍。");
});

test("🔴 数字相同、数量级写错:资料「2 万元」不能替回答「2 亿元」作证(审计 A6)", () => {
  assert.equal(body(gateNumbers("营收 2 亿元。", ["营收 2 万元"])), `营收 ${NUMBER_MARK}。`);
  assert.equal(gateNumbers("营收 2 万元。", ["营收 2 万元"]).masked, 0);
  assert.equal(gateNumbers("营收 20000 元。", ["营收 2 万元"]).masked, 0, "换算后相等照常认");
  // 资料里没写数量级的数(表头 / 单位字段在别处):不知道它的数量级,原样比照常认
  assert.equal(gateNumbers("营收 325.27 亿元。", ["| 营收 | 325.27 |"]).masked, 0);
  assert.equal(gateNumbers("营收 2 亿元。", ['{"value": 2, "unit": "亿元"}']).masked, 0);
  // 审计第二轮 A6:JSON 自己带了数量级 ⇒ 它的 value 不再算「没写数量级」,不能替写错倍率的回答作证
  assert.equal(body(gateNumbers("营收 2 亿元。", ['{"value": 2, "unit": "万元"}'])), `营收 ${NUMBER_MARK}。`);
  assert.equal(body(gateNumbers("营收 2 亿元。", ['[{"field":"revenue","value":-2,"unit":"万元","period":"2025"}]'])), `营收 ${NUMBER_MARK}。`);
  assert.equal(gateNumbers("营收 2 万元。", ['{"value": 2, "unit": "万元"}']).masked, 0);
  assert.equal(gateNumbers("营收 20000 元。", ['{"value": 2, "unit": "万元"}']).masked, 0);
  assert.equal(gateNumbers("市盈率 2 倍。", ['{"value": 2, "unit": "倍"}']).masked, 0, "没有数量级的单位照常原样比");
  // 审计第二轮 A7:金额加百分比不是合法算式,结果拿不到「算出来的」出处
  //   (例子选 2 元 + 50%:Codex 原例 100 元 + 20% = 100.2 元里,100.2 与资料的 100 只差 0.2%,本来就在容差内)
  assert.equal(body(gateNumbers("2 元 + 50% = 2.5 元。", ["金额 2 元、比例 50%"])), `2 元 + 50% = ${NUMBER_MARK}。`);
  assert.equal(gateNumbers("2 元 × 50% = 1 元。", ["金额 2 元、比例 50%"]).masked, 0, "金额 × 百分比照常算出处");
  // 表头写了数量级的表格同样按这个规则
  assert.equal(gateNumbers("| 项目 | 金额(亿元) |\n|---|---|\n| 营收 | 2.35 |", ["营收 2.35 万元"]).masked, 1);
  assert.equal(gateNumbers("| 项目 | 金额(亿元) |\n|---|---|\n| 营收 | 2.35 |", ["营收 2.35 亿元"]).masked, 0);
  // 算式里混了数量级:按裸数 2 + 3 = 5 不能给「5 亿元」作证(审计 A7)
  assert.equal(body(gateNumbers("合计 2 亿 + 3 万 = 5 亿元。", ["A 2 亿元,B 3 万元"])), `合计 2 亿 + 3 万 = ${NUMBER_MARK}。`);
  assert.equal(gateNumbers("合计 2 亿 + 3 万 = 2.0003 亿元。", ["A 2 亿元,B 3 万元"]).masked, 0);
});

test("找不到出处的数字连同单位换成「（略※）」,只换那一个,末尾说明几处", () => {
  const r = gateNumbers("市盈率 46.56 倍，营业收入 120.5 亿元，毛利率 33.8%。", ["pe=46.56"]);
  assert.equal(r.masked, 2);
  assert.equal(body(r), `市盈率 46.56 倍，营业收入 ${NUMBER_MARK}，毛利率 ${NUMBER_MARK}。`);
  assert.match(r.reply, /※ 有 2 处数字在本轮看得到的内容里/);
});

test("算式:运算数有出处、算对了,结果算有出处;算错了或运算数是编的,结果照样略去", () => {
  const src = ["revenue 444.64 / prior 453.90 / net 100 / shares 8"];
  assert.equal(gateNumbers("444.64 ÷ 453.90 − 1 = −2.04%", src).masked, 0);
  assert.equal(gateNumbers("444.64 ÷ 453.90 − 1 ≈ −2.04%", src).masked, 0, "写 ≈ 也一样(v2.2.0 审计 Codex 第 7 条)");
  assert.equal(gateNumbers("100 ÷ 8 = 12.5 元", src).masked, 0);
  const wrong = gateNumbers("100 ÷ 8 = 13.5 元", src);
  assert.equal(body(wrong), `100 ÷ 8 = ${NUMBER_MARK}`);
  // 编一个运算数做一道对的算术:运算数和结果都略去
  const made = gateNumbers("300 ÷ 8 = 37.5 元", src);
  assert.equal(made.masked, 2);
  assert.equal(body(made), `${NUMBER_MARK} ÷ 8 = ${NUMBER_MARK}`);
});

test("不是数字主张的不动:日期、年份、季度、序号、小计数、钟点、资料引用、代码块、链接", () => {
  const reply = [
    "1. 2026 年 3 季度报告 2026-10-28 发布，10:30 开会，见 [资料:rpt-a1b2 p.35]",
    "21. 近 5 年里有 3 次，10-08 和 10/28、10月28日、9 月 30 号都有记录",
    "```",
    "df.rolling(60).mean()",
    "```",
    "原文见 https://example.com/a/12345.html",
  ].join("\n");
  const r = gateNumbers(reply, []);
  assert.equal(r.masked, 0, r.reply);
  assert.equal(r.reply, reply);
  // 配比不是钟点、区间不是日期,要核对
  assert.equal(gateNumbers("配比 35:65", []).masked, 2);
  assert.equal(body(gateNumbers("区间 12-25%", ["12"])), `区间 12-${NUMBER_MARK}`);
});

test("名称、时间窗口、参数组里的数字不算主张;点位、数值照样核对", () => {
  const ok = "沪深300、中证500、上证50 和 S&P 500;60 日均线、60/120/250 日均线、近 30 个交易日、过去 52 周;MACD (12,26,9)";
  assert.equal(gateNumbers(ok, []).masked, 0, gateNumbers(ok, []).reply);
  assert.equal(body(gateNumbers("中证1000点,沪深300 涨 1.2%", [])), `中证${NUMBER_MARK}点,沪深300 涨 ${NUMBER_MARK}`, "指数名后面跟「点」是点位");
  assert.equal(gateNumbers("回款周期约 30 天", []).masked, 1, "没有「近 / 过去」的天数是真主张");
  assert.equal(gateNumbers("(12.5, 26)", []).masked, 2, "带小数的不是参数组");
  // 名称写法由插件注册;没注册时一律核对(只会多略,不会漏核)
  registerGateLabels([]);
  try { assert.equal(gateNumbers("沪深300 和 60 日均线", []).masked, 2); }
  finally { registerGateLabels(FINANCE_GATE_LABELS); }
  assert.throws(() => registerGateLabels([/\d+点/]), /必须是带 g/);
  assert.equal(gateNumbers("沪深300", []).masked, 0, "注册失败不该冲掉已注册的");
});

test("写明「假设」的那一句是举例:数字算出处,后面用它的算式也认;「比如」不算", () => {
  assert.equal(gateNumbers("假设价格 100 元、每股收益 5 元。\n那么 100 ÷ 5 = 20 倍。", []).masked, 0);
  const plain = gateNumbers("比如价格 100 元,100 ÷ 5 = 20 倍。", []);
  assert.equal(plain.masked, 3, plain.reply);
  // 同一行里不带「假设」的那句照样核对
  assert.equal(body(gateNumbers("假设增速 15%。去年是 37.2%。", [])), `假设增速 15%。去年是 ${NUMBER_MARK}。`);
  // 代码块里的「假设」不算
  assert.equal(gateNumbers("```\n# 假设 x = 88.8\n```\n结果 88.8", []).masked, 1);
  // 只认「假设」所在的那一小句:同一句里逗号前面的数字照样核对
  assert.equal(body(gateNumbers("营收 1741 亿元，净利 862 亿元，市场普遍假设明年增速 10%。", [])), `营收 ${NUMBER_MARK}，净利 ${NUMBER_MARK}，市场普遍假设明年增速 10%。`);
  assert.equal(gateNumbers("假设营收 1,741 亿元", []).masked, 0, "千分位的逗号不切小句");
});

test("年份样子的整数后面跟着金额 / 点位单位、以及「35.2x」这种倍数,是数字主张,要核对", () => {
  for (const [s, n] of [["最新价 1985 元", 1], ["营收 2035 亿元", 1], ["创业板指收于 2080 点", 1], ["募资 1950 万元", 1], ["PE 约 35.2x", 1], ["2026 年营收", 0], ["2025年 3 季度", 0], ["FY2026 净利", 0]] as const) {
    assert.equal(gateNumbers(s, []).masked, n, s);
  }
  assert.equal(body(gateNumbers("PE 约 35.2x，远高于行业", [])), `PE 约 ${NUMBER_MARK}，远高于行业`, "连同 x 一起换掉");
  assert.equal(gateNumbers("最新价 1985 元，PE 35.2x", ['{"price": 1985, "pe": 35.2}']).masked, 0, "资料里有就放行");
});

test("只有闭合的、装着代码的代码块不核对;没闭合的、装数据或文字的照常核对", () => {
  assert.equal(gateNumbers("```python\nma = close.rolling(60).mean() * 1.05\n```", []).masked, 0);
  assert.equal(gateNumbers("```\nimport pandas as pd\nx = 88.8\n```", []).masked, 0);
  // 没闭合:后面全是正文
  assert.equal(gateNumbers("数据如下:\n```text\n营收 9876.5 亿元\n\n结论:净利润 4321.1 亿元", []).masked, 2);
  // 闭合了,但装的是数据表 / json
  assert.equal(gateNumbers("```\n指标      数值\n营收      9876.5 亿元\n净利润    4321.1 亿元\n```", []).masked, 2);
  assert.equal(gateNumbers("```json\n{\"revenue\": 9876.5}\n```", []).masked, 1);
  // 没标语言:像代码的行要过半(正好一半算代码);一行赋值夹在三行数据里不算代码块
  assert.equal(gateNumbers("```\nx = 1\n营收 9876.5 亿元\n净利润 4321.1 亿元\n毛利 1234.5 亿元\n```", []).masked, 3);
  assert.equal(gateNumbers("```\nx = 1\ny = x * 2\n营收 9876.5 亿元\n净利润 4321.1 亿元\n```", []).masked, 0);
});

test("取数结果里带单位字段的数按那个单位换算后也算出处", () => {
  const src = [JSON.stringify({ envelope: { evidence: [
    { field: "market_cap", value: 18234.56, unit: "亿元", period: "2026-10-08" },
    { field: "turnover_amount", value: 523456.0, unit: "万元", period: "2026-10-08" },
  ] } })];
  assert.equal(gateNumbers("总市值 18234.56 亿元,成交额 523456 万元。", src).masked, 0);
  assert.equal(gateNumbers("总市值约 1.82 万亿元,成交额 52.35 亿元。", src).masked, 0, gateNumbers("总市值约 1.82 万亿元,成交额 52.35 亿元。", src).reply);
  assert.equal(gateNumbers("总市值约 1.95 万亿元", src).masked, 1, "换算后对不上的照样略去");
});

test("区间写法里的「-」是区间号,换数字时留下;千分位与 JSON 数组两种读法都算出处", () => {
  assert.equal(body(gateNumbers("区间 2.5-3.75 倍", ["2.5"])), `区间 2.5-${NUMBER_MARK}`);
  assert.deepEqual(sourceNumbers(['{"a":[12,33.1]}']).filter((n) => n > 1), [12, 33.1, 1233.1]);
  assert.deepEqual(sourceNumbers(['[12,33]']), [12, 33, 1233], "整数数组两种读法都收");
  assert.equal(gateNumbers("12.5 和 33.1", ['{"a":[12.5,33.1]}']).masked, 0);
  assert.equal(gateNumbers("共 1,234.5 万", ["12345000"]).masked, 0);
});

test("按写出来的单位换算:一堆小数字(如几百个价格)不会让编出来的大数字蒙混过关", () => {
  const prices = [JSON.stringify(Array.from({ length: 9_900 }, (_, i) => +(1 + i * 0.01).toFixed(2)))];
  // 旧比对允许任意 万 / 亿 / 百分数换算:156.3 ÷ 100 = 1.563 会对上某个价格
  assert.equal(gateNumbers("营业收入 156.3 亿元", prices).masked, 1);
  assert.equal(gateNumbers("融资余额 32526887117 元", prices).masked, 1);
  assert.equal(gateNumbers("收在 15.63 元", prices).masked, 0, "真在资料里的照样认");
});

test("容差按写到的那一位;表头或同一行写了单位的,表里的数按那个单位算", () => {
  const src = ["32526887117"];
  assert.equal(gateNumbers("融资余额约 325 亿元", src).masked, 0, "325 亿容许 ±0.5 亿");
  assert.equal(gateNumbers("融资余额约 330 亿元", src).masked, 1);
  assert.equal(gateNumbers("融资余额 325.3 亿", src).masked, 0);
  assert.equal(gateNumbers("收在约 33 元", ["33.4"]).masked, 0, "写到个位的容许 ±0.5");
  assert.equal(gateNumbers("收在约 33 元", ["33.6"]).masked, 1);
  assert.equal(gateNumbers("占 35%", ["0.35 元"]).masked, 0, "百分数按比例比:资料里的 0.35 能对上 35%");
  assert.equal(gateNumbers("变动 0.35 元", ["35%"]).masked, 1, "反过来不行:资料写 35%,回答写 0.35 不认");
  assert.equal(gateNumbers("合计 32500 亿元", ["余额 3.25 万亿"]).masked, 0, "资料和回答用的单位不同也认");
  assert.equal(gateNumbers("| 日期 | 融资余额(亿元) |\n|---|---|\n| 09-29 | 325.27 |", src).masked, 0);
  assert.equal(gateNumbers("| 日期 | 融资余额 |\n|---|---|\n| 09-29 | 325.27 |", src).masked, 1, "没写单位就不替它乘");
  assert.equal(gateNumbers("同比 5.2%", ["-0.052"]).masked, 0, "比例写成百分数");
  assert.equal(bound("5.2", "%", [], sourceNumbers(["5.2%"])), true);
  assert.equal(nearInPool(10, 0.5, [9.4, 10.6]), false);
  assert.equal(nearInPool(10, 0.5, [9.4, 10.5]), true);
});

test("工具结果几十万个数也很快", () => {
  const big = JSON.stringify(Array.from({ length: 300_000 }, (_, i) => i * 1.37));
  const t0 = Date.now();
  const r = gateNumbers(Array.from({ length: 60 }, (_, i) => `第 ${i} 行 ${(i * 1.37 * 1000).toFixed(2)} 和 ${(7_777_777 + i * 0.5).toFixed(2)}`).join("\n"), [big]);
  assert.ok(Date.now() - t0 < 3000, `用了 ${Date.now() - t0} ms`);
  assert.equal(r.masked, 60, "每行第二个数资料里没有");
});

// ── 接进对话 ─────────────────────────────────────────────────────

const API = { provider: "custom", baseURL: "https://api.example.invalid/v1", apiKey: "sk-test-api-key-0123456789", model: "test-model" };
const textReply = (content: string): ChatReply => ({ message: { role: "assistant", content }, finishReason: "stop", usage: null, durationMs: 1 });
const toolCall = (q: string): ChatReply => ({ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: JSON.stringify({ q }) } }] }, finishReason: "tool_calls", usage: null, durationMs: 1 });
const fakeApi = (steps: ChatReply[]) => { let n = 0; return async (_req: ChatRequest) => steps[Math.min(n++, steps.length - 1)]!; };
const lookup: AssistantTool = { name: "lookup", description: "查", schema: z.object({ q: z.string() }).strict(), run: () => ({ ok: true, value: 32526887117 }) };

test("对话:工具结果和用户消息算出处;只有开了闸门才核对,略去几处随结果带回", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-gate-"));
  try {
    const answer = "余额 325.27 亿元，你说的成本 12.8 元，另一个数 66.6%。";
    const run = (numberGate: boolean | undefined, steps: ChatReply[]) => chatSend(
      { repoRoot: REPO, dataRoot: root, persistent: false, tools: [lookup], apiComplete: fakeApi(steps), ...(numberGate === undefined ? {} : { numberGate }) },
      { message: "我的成本 12.8 元，查一下余额", llm: API });
    resetChatSessions();
    const on = await run(true, [toolCall("x"), textReply(answer)]);
    assert.equal(on.numbers_masked, 1);
    assert.equal(body(on), `余额 325.27 亿元，你说的成本 12.8 元，另一个数 ${NUMBER_MARK}。`);
    // 没调工具:325.27 亿也没有出处了
    const noTool = await run(true, [textReply(answer)]);
    assert.equal(noTool.numbers_masked, 2);
    // 没开闸门(辩论、翻译等内部任务):原样
    const off = await run(undefined, [toolCall("x"), textReply(answer)]);
    assert.equal(off.reply, answer);
    assert.equal(off.numbers_masked, undefined);
    assert.equal(Object.hasOwn(off, "toolTexts") || Object.hasOwn(on, "toolTexts"), false, "工具原文不进返回值");
  } finally { resetChatSessions(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("对话:本机 Agent 经桥调的工具结果同样算出处;内部任务 skipGate 时不核对", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-gate-"));
  try {
    const runner = async (_agent: string, opts: RunLocalAgentOptions) => {
      const mcp = opts.controlledMcp!;
      const token = fs.readFileSync(mcp.env.VRA_ASSISTANT_TOKEN_FILE!, "utf8").trim();
      await fetch(`${mcp.env.VRA_ASSISTANT_URL}/call`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "lookup", arguments: { q: "x" } }),
      });
      return "余额 325.27 亿元，另有 88.8 亿元";
    };
    resetChatSessions();
    const r = await chatSend({ repoRoot: REPO, dataRoot: root, persistent: false, tools: [lookup], numberGate: true, localAgentRunner: runner as never },
      { message: "查一下", llm: { provider: "cli-claude" } });
    assert.equal(body(r), `余额 325.27 亿元，另有 ${NUMBER_MARK}`);
    const skip = await chatSend({ repoRoot: REPO, dataRoot: root, persistent: false, numberGate: true, skipGate: true, localAgentRunner: async () => "另有 88.8 亿元" },
      { message: "查一下", llm: { provider: "cli-claude" } });
    assert.equal(skip.reply, "另有 88.8 亿元");
  } finally { resetChatSessions(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("对话:系统提示词里给过的数也算出处", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-gate-"));
  try {
    resetChatSessions();
    const r = await chatSend({ repoRoot: REPO, dataRoot: root, persistent: false, numberGate: true, preambleText: "本机共有 150 个端点。", apiComplete: fakeApi([textReply("一共 150 个端点、34 层")]) },
      { message: "有几个端点", llm: API });
    assert.equal(body(r), `一共 150 个端点、${NUMBER_MARK} 层`);
  } finally { resetChatSessions(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("服务层:用户对话的三条路都开闸门,提示词里先说明会核对", () => {
  const src = (f: string) => fs.readFileSync(path.join(REPO, "orchestrator", "src", f), "utf8");
  const service = src("service.ts");
  assert.match(service, /numberGate: true,/, "普通对话和 Agent 共用的 chatOptions 要开闸门");
  assert.match(service, /gateNumbers\(redLine\.reply, \[contextText \?\? "", message\]\)/, "模型直连那条路自己核对");
  for (const f of ["light_chat.ts", "assistant_turn.ts"]) assert.match(src(f), /\$\{NUMBER_GATE_RULE\}/, f);
  assert.match(service, /NUMBER_GATE_RULE,\n/);
  assert.match(src("light_chat.ts"), /"numberGate">/, "普通对话要把开关透传给 chatSend");
});
