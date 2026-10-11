import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  COMPARE_BASIS, NA, ROWS, WEEKLY_MAX, agentChoices, compareMarkdown, compareNotes, engineDetail, engineName, fmtDuration, scopeOf, weeklyCompareMarkdown, weeklyGroups, when,
  type RunCompareResult, type RunMetrics,
} from "../src/verticals/finance/lib/runCompareView.ts";
import type { RunListItem } from "../src/verticals/finance/lib/backend.ts";

// 卡片里有 Link:react-router 要交给 vite 处理(同 route_error.test.ts)
const SSR_ROUTER = { ssr: { noExternal: ["react-router-dom", "react-router"], resolve: { conditions: ["module-sync", "node", "import", "development"] } } };
const run = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  run_id: "cc-1", status: "complete", started_at: "2026-10-08T09:05:00+08:00", finished_at: "2026-10-08T09:30:40+08:00",
  engine: { provider: "cli-claude", version: "claude/2.1.285 (Claude Code)", model: null }, endpoint_scope: "full",
  duration_s: 1540, agent_s: 1426, stages: { complete: 6, total: 6 }, first_pass: { passed: 5, total: 6 }, numbers: { exact: 151, total: 151 },
  evidence: { fetched: 1014, cited: 221 }, calcs: { cited: 30, total: 30 }, gaps: 16, conflicts: 0, gate_hits: 0, stop_blocks: 3,
  fetch: { ok: 35, partial: 2, failed: 2 }, ...over,
});
const bare = (): RunMetrics => run({
  status: null, started_at: null, finished_at: null, engine: { provider: null, version: null, model: null }, endpoint_scope: null,
  duration_s: null, agent_s: null, stages: null, first_pass: null, numbers: null, evidence: { fetched: null, cited: null },
  calcs: { cited: null, total: null }, gaps: null, conflicts: null, gate_hits: null, stop_blocks: null, fetch: null,
});
const cell = (label: string, r: RunMetrics) => ROWS.find((x) => x.label === label)!.value(r);

test("研究对比:前端的 RunMetrics 与后端逐字段一致(只比字段,不比注释)", () => {
  const block = (p: string) => {
    const src = fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    const m = src.match(/export interface RunMetrics \{[\s\S]*?\n\}/);
    assert.ok(m, p);
    return m[0].replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\s+/g, "");
  };
  assert.equal(block("../src/verticals/finance/lib/runCompareView.ts"), block("../../orchestrator/src/run_compare.ts"));
});

test("研究对比:Agent 名用设置页的叫法,订阅档如实说模型没回报;用时、比值、没数据都有固定写法", () => {
  assert.equal(engineName(run().engine), "Claude Code");
  assert.equal(engineName({ provider: "cli-codex", version: "codex/0.160.0", model: null }), "Codex 订阅");
  assert.equal(engineName({ provider: "cli-codebuddy", version: null, model: null }), "WorkBuddy / CodeBuddy");
  assert.equal(engineName({ provider: "mimo", version: null, model: "mimo-v2.6-flash" }), "MiMo V2.6 Flash");
  assert.equal(engineName({ provider: "openai-compatible", version: null, model: "my-model" }), "my-model");
  assert.equal(engineName({ provider: "deepseek", version: null, model: null }), "deepseek");
  assert.equal(engineName(bare().engine), "没记录是哪家");
  assert.equal(engineDetail(run().engine), "claude/2.1.285 (Claude Code) · 模型由本机登录决定，没有回报");
  assert.equal(engineDetail({ provider: "mimo", version: null, model: "mimo-v2.6-flash" }), "mimo-v2.6-flash");
  assert.equal(engineDetail(bare().engine), NA);

  assert.equal(fmtDuration(null), NA); assert.equal(fmtDuration(0), "0 秒"); assert.equal(fmtDuration(59), "59 秒");
  assert.equal(fmtDuration(60), "1 分"); assert.equal(fmtDuration(1540), "25 分 40 秒");
  assert.equal(when("2026-10-08T09:05:00+08:00"), "2026-10-08 09:05"); assert.equal(when(null), NA); assert.equal(when("坏"), NA);

  const r = run();
  assert.equal(cell("取数范围", r), "完整"); assert.equal(cell("取数范围", run({ endpoint_scope: "core" })), "核心");
  assert.equal(cell("资料齐全的阶段", run({ stages: { complete: 2, total: 6 } })), "2 / 6");
  assert.equal(cell("一次就过校验的阶段", r), "5 / 6");
  assert.equal(cell("报告数字对得上", run({ numbers: { exact: 3, total: 4 } })), "3 / 4");
  // 分母只是引了编号、拿去核对的那几行,不是报告里的全部数字
  assert.match(ROWS.find((x) => x.label === "报告数字对得上")!.hint!, /只核对引了证据或计算编号的行/);
  assert.equal(cell("取到的证据", r), "1014"); assert.equal(cell("实际引用的证据", r), "221");
  assert.equal(cell("引用的计算", run({ calcs: { cited: null, total: 30 } })), "— / 30");
  assert.equal(cell("取数脚本", r), "35 / 2 / 2");
  // 🔴 读不到 = 「—」,不能显示成 0
  for (const row of ROWS) assert.equal(row.value(bare()), NA, row.label);
  assert.equal(cell("写出的缺口", run({ gaps: 0 })), "0", "真的是 0 就写 0");
});

test("研究对比:先说清楚的几件事 —— 只有一次、同一家 Agent、取数范围不同、中途停下、没列全", () => {
  const res = (runs: RunMetrics[], omitted = 0): RunCompareResult => ({ run_id: runs[0]!.run_id, runs, omitted });
  assert.deepEqual(compareNotes(res([run()])), ["这家公司只有这一次研究。换一家 Agent 再研究同一只股票，就能在这里并排比较。"]);
  const same = compareNotes(res([run(), run({ run_id: "cc-2", endpoint_scope: "core" })]));
  assert.ok(same.some((n) => n.includes("同一家 Agent")));
  assert.ok(same.some((n) => n.includes("取数范围不同")));
  const mixed = compareNotes(res([run(), run({ run_id: "cx-1", engine: { provider: "cli-codex", version: null, model: null }, status: "failed" })], 3));
  assert.ok(!mixed.some((n) => n.includes("同一家 Agent")));
  assert.ok(!mixed.some((n) => n.includes("取数范围不同")));
  assert.ok(mixed.some((n) => n.includes("中途停下")));
  assert.ok(mixed.some((n) => n.includes("还有 3 次研究没列出（最多并排 2 次：这一次，加上其余里最近的 1 次）")));
  assert.ok(!mixed.some((n) => n.includes("更早")), "没列出的不一定比这一次早");
  // 只跑了部分阶段的那次:分母不同要先说
  assert.ok(compareNotes(res([run(), run({ run_id: "p", stages: { complete: 1, total: 1 } })])).some((n) => n.includes("只跑了部分阶段")));
  assert.ok(!compareNotes(res([run(), run({ run_id: "p", stages: null })])).some((n) => n.includes("只跑了部分阶段")), "读不到阶段的不算");
  assert.ok(!same.some((n) => n.includes("只跑了部分阶段")));
  // 没记录取数范围的那次不算「范围不同」
  assert.ok(!compareNotes(res([run(), run({ run_id: "x", engine: { provider: "cli-codex", version: null, model: null }, endpoint_scope: null })])).some((n) => n.includes("取数范围不同")));
});

test("研究对比卡:并排列出、标出「这次」、不排名不标最好;首屏只有说明和按钮", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", ...SSR_ROUTER });
  try {
    const { RunCompareTable, RunCompareCard } = await server.ssrLoadModule("/src/verticals/finance/components/RunCompareCard.tsx");
    const res: RunCompareResult = {
      run_id: "cx-1", omitted: 0,
      runs: [
        run({ run_id: "cx-1", status: "incomplete", engine: { provider: "cli-codex", version: "codex/0.160.0", model: null }, stages: { complete: 2, total: 6 } }),
        run(),
        bare(),
      ],
    };
    const html = renderToStaticMarkup(createElement(RunCompareTable, { res }));
    for (const t of ["Codex 订阅", "Claude Code", "没记录是哪家", "这次", "资料不完整", "状态未知", "2026-10-08 09:05",
      "资料齐全的阶段", "2 / 6", "6 / 6", "1014", "35 / 2 / 2", "25 分 40 秒"]) assert.ok(html.includes(t), t);
    assert.equal((html.match(/>这次</g) ?? []).length, 1, "只有当前这次标「这次」");
    assert.equal((html.match(/<tr/g) ?? []).length, ROWS.length + 1, "每个指标一行 + 表头");
    assert.doesNotMatch(html, /最好|最佳|排名|第一名|胜出|总分|得分|推荐/);
    // 表头三列顺序与后端一致
    assert.ok(html.indexOf("Codex 订阅") < html.indexOf("Claude Code") && html.indexOf("Claude Code") < html.indexOf("没记录是哪家"));

    const first = renderToStaticMarkup(createElement(RunCompareCard, { current: { run_id: "cx-1" } }));
    assert.match(first, /各次研究过程对比/); assert.match(first, />对比</);
    assert.match(first, /不比结论对错，也不比收益/); assert.match(first, /不打总分、不排名次/);
    assert.doesNotMatch(first, /<table/);
  } finally { await server.close(); }
});

const st = (s: string | null) => ({ complete: "完成", failed: "失败" } as Record<string, string>)[s ?? ""] ?? s ?? "状态未知";
const codex = (over: Partial<RunMetrics> = {}) => run({ run_id: "cx-1", engine: { provider: "cli-codex", version: "codex/0.160.0", model: null }, ...over });

test("模型擂台:只列已登录的订阅 Agent,带表里已有几次;再研究沿用这次的取数范围,没记录按核心", () => {
  const res: RunCompareResult = { run_id: "cc-1", omitted: 0, runs: [run(), run({ run_id: "cc-2" }), codex()] };
  const agents = [
    { provider: "cli-codex", status: "ready" }, { provider: "cli-claude", status: "ready" },
    { provider: "cli-codebuddy", status: "not_authenticated" },
  ];
  assert.deepEqual(agentChoices(agents, res), [
    { provider: "cli-codex", name: "Codex 订阅", count: 1 }, { provider: "cli-claude", name: "Claude Code", count: 2 },
  ]);
  assert.deepEqual(agentChoices([{ provider: "cli-codebuddy", status: "probe_failed" }], res), []);
  assert.equal(scopeOf(res), "full");
  assert.equal(scopeOf({ ...res, runs: [run({ endpoint_scope: "core" })] }), "core");
  assert.equal(scopeOf({ ...res, runs: [run({ endpoint_scope: null })] }), "core");
});

test("模型擂台:存进研究记录的 Markdown —— 说明在前、每家一列、标出这次、读不到写「—」、不排名", () => {
  const res: RunCompareResult = { run_id: "cc-1", omitted: 0, runs: [run(), codex({ status: "failed", gaps: null })] };
  const md = compareMarkdown(res, st);
  assert.ok(md.startsWith(COMPARE_BASIS));
  assert.ok(md.includes("| 研究过程 | Claude Code（这次） | Codex 订阅 |"));
  assert.ok(md.includes("| 状态 | 完成 | 失败 |"));
  assert.ok(md.includes("| 写出的缺口 | 16 | — |"), "读不到写「—」不写 0");
  assert.ok(md.includes("| 开始时间 | 2026-10-08 09:05 | 2026-10-08 09:05 |"));
  assert.ok(md.includes("中途停下的研究"), "要先说清的几件事也存下来");
  assert.ok(md.includes("运行标识：Claude Code cc-1；Codex 订阅 cx-1"));
  assert.ok(md.includes("- 报告数字对得上：只核对引了证据或计算编号的行"), "各行怎么读跟着存");
  const tableRows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
  assert.equal(tableRows.length, ROWS.length + 3, "表头 + 开始时间 + 状态 + 每个指标一行");
  assert.doesNotMatch(md.replace(COMPARE_BASIS, ""), /最好|最佳|排名|第一名|胜出|总分|得分|推荐/);
  // 单元格里的竖线不能把表格拆坏
  assert.ok(compareMarkdown({ ...res, runs: [run({ engine: { provider: "x", version: null, model: "a|b" } })] }, st).includes("| a\\|b（这次） |"));
});

const item = (over: Partial<RunListItem>): RunListItem => ({
  run_id: "r", status: "complete", symbol: "600519", name: "贵州茅台", market: null,
  started_at: "2026-10-08T09:00:00+08:00", finished_at: "2026-10-08T09:30:00+08:00", stages_done: 6, stages_total: 6, test_scenario: false, ...over,
});
const NOW = Date.parse("2026-10-09T12:00:00+08:00");

test("本周对比周报:近 7 天、已结束、正式研究、同一对象同一市场至少两次;给最新那次,最近研究的排前", () => {
  const runs = [
    item({ run_id: "a1", started_at: "2026-10-05T09:00:00+08:00" }),
    item({ run_id: "a2", started_at: "2026-10-08T09:00:00+08:00", name: null }),
    item({ run_id: "a-old", started_at: "2026-09-20T09:00:00+08:00" }),            // 超过 7 天
    item({ run_id: "a-run", started_at: "2026-10-09T09:00:00+08:00", finished_at: null, status: "running" }), // 还在跑
    item({ run_id: "a-test", test_scenario: true }),                               // 测试运行
    item({ run_id: "h1", symbol: "00700", market: "HK", name: "腾讯控股", started_at: "2026-10-09T08:00:00+08:00" }),
    item({ run_id: "h2", symbol: "00700", market: "HK", name: "腾讯控股", started_at: "2026-10-09T10:00:00+08:00" }),
    item({ run_id: "u1", symbol: "00700", market: "US", started_at: "2026-10-09T10:00:00+08:00" }), // 同代码不同市场不是一组
    item({ run_id: "x1", symbol: "000001", started_at: "2026-10-07T09:00:00+08:00" }),            // 只有一次
  ];
  assert.deepEqual(weeklyGroups(runs, NOW), [
    { run_id: "h2", label: "腾讯控股（00700）", count: 2 },
    { run_id: "a2", label: "贵州茅台（600519）", count: 2 },
  ]);
  assert.deepEqual(weeklyGroups([item({ run_id: "a1" }), item({ run_id: "a2", started_at: null })], NOW), [], "开始时间读不到的不算本周");
});

test("本周对比周报:每只只留本周的几次、至少两家不同 Agent;一只都没有不存空周报;超限和出错都写明", () => {
  const thisWeek = { run_id: "cc-1", omitted: 0, runs: [run(), codex({ started_at: "2026-10-06T10:00:00+08:00" }), run({ run_id: "cc-old", started_at: "2026-09-01T10:00:00+08:00" })] };
  const sameAgent = { run_id: "cc-9", omitted: 0, runs: [run({ run_id: "cc-9" }), run({ run_id: "cc-8" })] };
  const out = weeklyCompareMarkdown([{ label: "贵州茅台（600519）", res: thisWeek }, { label: "平安银行（000001）", res: sameAgent }], NOW, st,
    { skipped: 2, failed: ["腾讯控股（00700）（没有可读的运行清单）"] });
  assert.ok(out);
  assert.equal(out.count, 1, "同一家 Agent 跑两次的不算各家对比");
  assert.equal(out.title, "本周各家 Agent 研究对比（2026-10-02 至 2026-10-09）");
  assert.ok(out.markdown.includes("## 贵州茅台（600519）") && !out.markdown.includes("平安银行"));
  assert.ok(!out.markdown.includes("cc-old") && !out.markdown.includes("2026-09-01"), "本周以前的那次不列");
  assert.ok(out.markdown.includes("| 研究过程 | Claude Code（这次） | Codex 订阅 |"));
  assert.ok(out.markdown.includes("只存在本机"));
  assert.ok(out.markdown.includes(`另有 2 只超出每份周报最多 ${WEEKLY_MAX} 只的上限`));
  assert.ok(out.markdown.includes("没对比出来：腾讯控股（00700）（没有可读的运行清单）"));
  assert.doesNotMatch(out.markdown.replace(COMPARE_BASIS, ""), /最好|最佳|排名|第一名|胜出|总分|得分|推荐/);
  // 列出的几次全在本周、又有没列出的:本周可能还有更早的几次
  const capped = weeklyCompareMarkdown([{ label: "茅台", res: { ...thisWeek, runs: thisWeek.runs.slice(0, 2), omitted: 4 } }], NOW, st)!;
  assert.ok(capped.markdown.includes("超过一次能并排的上限，只列了最近的 2 次"));
  assert.equal(weeklyCompareMarkdown([{ label: "平安银行", res: sameAgent }], NOW, st), null);
  assert.equal(weeklyCompareMarkdown([], NOW, st), null);
});

test("模型擂台:研究记录的「研究对比」分类在垂类枚举里注册了(前端每个分类都要有,不然存的时候抛错)", () => {
  const read = (p: string) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  const notes = read("../src/verticals/finance/lib/notes.ts");
  const kinds = read("../../orchestrator/src/finance/ledger_kinds.ts");
  const map = notes.match(/const KIND_TO_CATEGORY[^{]*\{([\s\S]*?)\};/)![1]!;
  const enumList = kinds.match(/category: \{ type: "string", enum: \[([^\]]*)\]/)![1]!;
  const cats = new Set([...map.matchAll(/:\s*"(\w+)"/g)].map((m) => m[1]));
  assert.ok(cats.has("compare"));
  for (const c of cats) {
    assert.ok(enumList.includes(`"${c}"`), `${c} 不在 note.category 枚举里`);
    assert.match(kinds, new RegExp(`\\b${c}: "`), `${c} 没有中文名`);
  }
});

test("模型擂台界面:按钮只列已登录的、跑着研究时禁用;没有就指去接入 AI;页面这一次才用那家的订阅,不收起报告", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", ...SSR_ROUTER });
  try {
    const { AskAnother, RunCompareCard } = await server.ssrLoadModule("/src/verticals/finance/components/RunCompareCard.tsx");
    const { MemoryRouter } = await server.ssrLoadModule("react-router-dom");
    const res: RunCompareResult = { run_id: "cc-1", omitted: 0, runs: [run(), codex()] };
    const agent = (provider: string, status: string) => ({ provider, status, name: provider, installed: true, authenticated: true, available: true, version: null, detail: "" });
    const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(AskAnother, { res, agentsErr: "", launch: null, researchBusy: false, onPick: () => {}, ...props })));

    const ready = render({ agents: [agent("cli-codex", "ready"), agent("cli-claude", "ready"), agent("cli-codebuddy", "not_installed")] });
    assert.match(ready, /请另一家 Agent 也研究这只/);
    assert.match(ready, /用 Codex 订阅 研究/); assert.match(ready, /用 Claude Code 研究/);
    assert.doesNotMatch(ready, /WorkBuddy \/ CodeBuddy 研究/, "没装的不列");
    assert.match(ready, /表里已有 1 次/);
    assert.match(ready, /取数范围沿用这次的「完整」/); assert.match(ready, /不改「接入 AI」里的设置/);
    assert.doesNotMatch(ready, /disabled=""/);

    const busy = render({ agents: [agent("cli-codex", "ready")], researchBusy: true });
    assert.match(busy, /disabled=""/); assert.match(busy, /跑完才能再开/);
    const none = render({ agents: [agent("cli-codex", "not_authenticated")] });
    assert.match(none, /本机没有已登录的订阅 Agent/); assert.match(none, /href="\/settings"/);
    assert.match(render({ agents: null }), /正在查本机已登录的 Agent/);
    assert.match(render({ agents: null, agentsErr: "接口挂了" }), /没查到本机有哪些 Agent：接口挂了/);
    assert.match(render({ agents: [agent("cli-codex", "ready")], launch: { state: "failed", text: "没有开始：额度用完" } }), /没有开始：额度用完/);

    const first = renderToStaticMarkup(createElement(RunCompareCard, { current: { run_id: "cc-1" }, onRunWith: async () => {} }));
    assert.doesNotMatch(first, /请另一家 Agent/, "对比出来之前不列");
  } finally { await server.close(); }

  const page = fs.readFileSync(fileURLToPath(new URL("../src/verticals/finance/pages/Research.tsx", import.meta.url)), "utf8");
  const fn = page.match(/const runWith = async[\s\S]*?\n  \};/)![0];
  assert.match(fn, /backend\.startResearch\(\{[\s\S]*endpoints,[\s\S]*\}, subscriptionConfig\(provider\)\)/);
  assert.doesNotMatch(fn, /setReport\(null\)/, "报告留着,对比卡就在旁边");
  assert.doesNotMatch(fn, /saveUserLlm|saveAi/, "不改接入 AI 里存的设置");
  assert.match(page, /<WeeklyCompareButton \/>/);
});
