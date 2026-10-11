import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diffLines, diffReports, displayLine, lineKey, splitSections } from "../src/verticals/finance/lib/reportDiff.ts";

const OLD = `# 中际旭创研究报告
运行 r1;报告生成日 2026-10-07 [ev-aaaaaaaaaaaa]

## 结论摘要

1. 扣非×4 PE 30.10 倍 [calc-1111111111111111],分位 50.00% [calc-2222222222222222]。
2. 一致预期 29 家 [ev-0c3e59efc1d9]。

## 事实

| 指标 | 值 | 来源 | ev id |
|---|---|---|---|
| 收盘价 | 800.00 | 腾讯 | ev-3188de2448ef |
| 总市值 | 9000 | 腾讯 | ev-551b325427cd |

## 管制与准入

未接入。
`;
const NEW = `# 中际旭创研究报告
运行 r2;报告生成日 2026-10-08 [ev-bbbbbbbbbbbb]

## 结论摘要

1. 扣非×4 PE 32.29 倍 [calc-a2e5859ee4e2f4e9],分位 50.00% [calc-4f23a1154a17f2e2]。
2. 一致预期 29 家 [ev-71e70941f921]。

## 事实

| 指标 | 值 | 来源 | ev id |
|:---|---:|---|---|
| 收盘价 | 808.44 | 腾讯 | ev-9999999999aa |
| 总市值 | 9000 | 腾讯 | ev-8888888888bb |

### 新的小节

## 裁决点

| # | 什么数据出来会改变判断 |
|---|---|
| 1 | 三季报扣非环比转负 |
`;

test("章节:第一个 ## 之前不算;### 留在节里;空行不算", () => {
  const s = splitSections(NEW);
  assert.deepEqual(s.map((x) => [x.title, x.lines.length]), [["结论摘要", 2], ["事实", 5], ["裁决点", 3]]);
  assert.equal(s[1]!.lines[4], "### 新的小节");
});

test("比较前去掉证据 / 计算编号;只换编号的行算没变", () => {
  assert.equal(lineKey("一致预期 29 家 [ev-0c3e59efc1d9]。"), lineKey("一致预期 29 家 [ev-71e70941f921]。"));
  assert.equal(lineKey("| 总市值 | 9000 | 腾讯 | ev-551b325427cd |"), lineKey("| 总市值 | 9000 | 腾讯 | ev-8888888888bb |"));
  assert.equal(lineKey("|:---|---:|"), "");
  assert.equal(displayLine("| 收盘价 | **808.44** | 腾讯 | ev-9999999999aa / ev-1111111111bb |"), "收盘价 · 808.44 · 腾讯");
  assert.equal(displayLine("1. PE 32.29 倍 [calc-a2e5859ee4e2f4e9]。"), "1. PE 32.29 倍。");
  assert.equal(displayLine("质押与解除质押(如 [ev-767b3b80f32b] / [ev-4a3688066552]),同期回购(如 [ev-1234567890ab])"), "质押与解除质押,同期回购");
  assert.equal(lineKey("PE 32.29 倍 [calc-a2e5859ee4e2f4e9],分位"), lineKey("PE 32.29 倍,分位"));
  // 连写的编号整体去掉,不留「/」「、」
  assert.equal(displayLine("| 估值不高 [calc-a2e5859ee4e2f4e9] / [calc-0f17342a2033c1df] | 是 |"), "估值不高 · 是");
  assert.equal(displayLine("数值支持 [calc-a2e5859ee4e2f4e9] / [calc-bd90aa65d7f3fc00];不成立"), "数值支持;不成立");
  assert.equal(displayLine("见 [ev-767b3b80f32b]、[ev-4a3688066552]、ev-1234567890ab 三条"), "见 三条");
  // 编号之间夹着真内容时不能一起吞掉
  assert.equal(displayLine("[calc-a2e5859ee4e2f4e9] / 1.97 倍 [calc-74bad437e871057a]"), "/ 1.97 倍");
});

test("逐节对比:改了的行成对列出,新增 / 删掉的节单列;没变的节标没变", () => {
  const d = diffReports(OLD, NEW);
  assert.deepEqual(d.map((x) => [x.title, x.status, x.added, x.removed]), [
    ["结论摘要", "changed", 1, 1], ["事实", "changed", 2, 1], ["裁决点", "added", 2, 0], ["管制与准入", "removed", 0, 1],
  ]);
  assert.deepEqual(d[0]!.ops, [{ op: "del", text: "1. 扣非×4 PE 30.10 倍,分位 50.00%。" }, { op: "add", text: "1. 扣非×4 PE 32.29 倍,分位 50.00%。" }]);
  assert.deepEqual(d[1]!.ops.map((o) => `${o.op} ${o.text}`), ["del 收盘价 · 800.00 · 腾讯", "add 收盘价 · 808.44 · 腾讯", "add 新的小节"]);
  assert.deepEqual(diffReports(OLD, OLD).map((x) => x.status), ["same", "same", "same"]);
});

test("逐行对齐保持顺序;太大时退回按集合比", () => {
  assert.deepEqual(diffLines(["a", "b", "c"], ["a", "x", "c", "d"]).map((o) => `${o.op}${o.text}`), ["delb", "addx", "addd"]);
  const big = Array.from({ length: 600 }, (_, i) => `行${i}`);
  const ops = diffLines(big, [...big.slice(1), "新"]);
  assert.deepEqual(ops.map((o) => `${o.op}${o.text}`), ["del行0", "add新"]);
});

test("研究页用新的对比组件,不再只比最近两次", () => {
  const src = readFileSync(new URL("../src/verticals/finance/pages/Research.tsx", import.meta.url), "utf8");
  assert.match(src, /<ReportCompare /);
  assert.doesNotMatch(src, /该公司最近两次研究的变化/);
});

import { comparableRuns, defaultPeer, fieldLabel, ordered, type RunLite } from "../src/verticals/finance/lib/reportDiff.ts";

const run = (id: string, at: string, over: Partial<RunLite> = {}): RunLite => ({ run_id: id, status: "complete", symbol: "300308", market: "SZ", started_at: at, finished_at: at, test_scenario: false, ...over });

test("能比的运行:同代码同市场、同为测试或非测试、跑完且没失败;默认比这次之前最近的一次", () => {
  const cur = run("c", "2026-10-07T22:00");
  const runs = [cur, run("a", "2026-10-07T20:00"), run("b", "2026-10-08T09:00"), run("x", "2026-10-06T10:00", { symbol: "600519" }),
    run("m", "2026-10-06T10:00", { market: "SH" }), run("f", "2026-10-06T11:00", { status: "failed" }), run("r", "2026-10-06T12:00", { finished_at: null }),
    run("t", "2026-10-06T13:00", { test_scenario: true }), run("i", "2026-10-05T10:00", { status: "incomplete" })];
  const peers = comparableRuns(cur, runs);
  assert.deepEqual(peers.map((p) => p.run_id), ["b", "a", "i"]);
  assert.equal(defaultPeer(cur, peers), "a");
  assert.equal(defaultPeer(run("z", "2026-10-01T00:00"), peers), "b", "这次最早时比最新一次");
  assert.equal(defaultPeer(cur, []), null);
  assert.deepEqual(ordered(peers[0]!, cur).map((r) => r.run_id), ["c", "b"]);
  assert.equal(fieldLabel("net_profit_parent_cum"), "归母净利润(累计)");
  assert.equal(fieldLabel("weird_field"), "weird_field");
});

test("showValue: big numbers get 亿/万, units already in 万/亿 are left alone, non-numbers pass through", async () => {
  const { showValue } = await import("../src/verticals/finance/lib/reportDiff.ts");
  assert.equal(showValue(32526887117, "元"), "325.27 亿元");
  assert.equal(showValue("205678", "户"), "20.57 万户");
  assert.equal(showValue(20, "笔"), "20 笔");
  assert.equal(showValue(0, "次"), "0 次");
  assert.equal(showValue(50000, "元"), "50000 元");
  assert.equal(showValue(100000, "元"), "10 万元");
  assert.equal(showValue(-1.5e8, "元"), "-1.5 亿元");
  assert.equal(showValue(150000, "万元"), "150000 万元");
  assert.equal(showValue(12.5, "%"), "12.5%");
  assert.equal(showValue("关于回购的公告", "text"), "关于回购的公告");
  assert.equal(showValue(null, "元"), "—");
  assert.equal(showValue("", "元"), "—");
});
