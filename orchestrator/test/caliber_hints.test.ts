import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import "../src/finance/register.ts";
import { caliberHintLines, latestDuePeriod } from "../src/finance/caliber_hints.ts";
import { reportPreludeLines, reportPreludePrompt } from "../src/finance/report_prelude.ts";
import type { CalcRecord, EvidenceItem } from "../src/merge.ts";
import { complianceGate } from "../src/gate.ts";
import { claimNumbers } from "../src/number_fidelity.ts";
import { loadRun, validateStage } from "../src/validator.ts";

const cid = (n: number) => `calc-${n.toString(16).padStart(16, "0")}`;
const ev = (id: string, over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id, symbol: "300308", market: "SZ", field: "x", value: 1, unit: "元", currency: "CNY", period: "2026-06-30", as_of: "2026-10-08",
  source: "tencent", endpoint: "quote", fetched_at: "2026-10-08T08:30:00+08:00", adjustment: "none", raw_ref: null, ...over,
});
const calc = (n: number, fn: string, refs: string[], inputs: Record<string, unknown> = {}, details: Record<string, unknown> = {}, status: "ok" | "error" = "ok"): CalcRecord => ({
  calculation_id: cid(n), function: fn, calc_version: "0.3.2", inputs, inputs_resolved: {},
  inputs_refs: refs.map((r) => ({ ref_type: r.startsWith("calc-") ? "calculation" as const : "evidence" as const, ref_id: r })),
  output: { status, value: 1, unit: "倍", reason: "", details },
});
const q = (rows: [string, number | null][]) => rows.map(([period, value]) => ({ period, value }));

test("币种：输入混用两种币种的计算给提示，只报源头；百分比这类不涉及币种的证据不算", () => {
  const price = ev("ev-aaaaaa01", { currency: "USD" });
  const eps = ev("ev-aaaaaa02");
  const pct = ev("ev-aaaaaa03", { currency: "n/a", unit: "%" });
  const fpe = calc(1, "forward_pe", [price.id, eps.id]);
  const peg = calc(2, "peg", [cid(1)]);
  const lines = caliberHintLines([price, eps, pct], [fpe, peg]);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /计算 forward_pe 的输入混用了 CNY \/ USD/);
  assert.ok(lines[0]!.endsWith(`[${cid(1)}]`));
  assert.deepEqual(caliberHintLines([ev("ev-aaaaaa01"), eps, pct], [calc(1, "forward_pe", ["ev-aaaaaa01", eps.id, pct.id])]), []);
  // 失败的计算不提示
  assert.deepEqual(caliberHintLines([price, eps], [calc(1, "forward_pe", [price.id, eps.id], {}, {}, "error")]), []);
});

test("TTM / 单季期末：没用序列里的最新一期要提示；几项期末不一致要提示；序列最后一期是空值不算", () => {
  const series = q([["2025-09-30", 3], ["2025-12-31", 4], ["2026-03-31", 5], ["2026-06-30", 6]]);
  const stale = caliberHintLines([], [calc(1, "ttm_sum", [], { end_period: "2026-03-31", single_quarters: series })]);
  assert.equal(stale.length, 1);
  assert.match(stale[0]!, /ttm_sum 的期末取 2026-03-31，但它所用的单季序列已有 2026-06-30/);

  const aligned = [
    calc(1, "ttm_sum", [], { end_period: "2026-06-30", single_quarters: series }),
    calc(2, "latest_quarter", [], { single_quarters: series }, { period: "2026-06-30" }),
    calc(3, "qoq", [], { end_period: "2026-06-30", single_quarters: [...series, { period: "2026-09-30", value: null }] }),
  ];
  assert.deepEqual(caliberHintLines([], aligned), []);

  // 扣非序列本身只到一季度:不是"没用最新一期",但和归母口径不是同一期
  const short = q([["2025-06-30", 2], ["2025-09-30", 3], ["2025-12-31", 4], ["2026-03-31", 5]]);
  const mixed = caliberHintLines([], [aligned[0]!, calc(4, "ttm_sum", [], { end_period: "2026-03-31", single_quarters: short })]);
  assert.deepEqual(mixed, [`> 口径提示：TTM 与单季类计算的期末不一致（2026-03-31：${cid(4)}；2026-06-30：${cid(1)}），对比时注意它们不是同一期。`]);
});

test("财报是否最新：过了披露截止日、序列还停在更早一期才提示；按北京时间算取数日；非 A 股不适用", () => {
  for (const [day, due] of [["2026-01-15", "2025-09-30"], ["2026-04-30", "2025-09-30"], ["2026-05-01", "2026-03-31"], ["2026-08-31", "2026-03-31"],
    ["2026-09-01", "2026-06-30"], ["2026-10-31", "2026-06-30"], ["2026-11-01", "2026-09-30"], ["2026-12-31", "2026-09-30"]]) {
    assert.equal(latestDuePeriod(day!), due, day);
  }
  const cum = calc(1, "quarterize", [], { cumulative: q([["2025-12-31", 10], ["2026-03-31", 3], ["2026-06-30", 7]]) });
  const at = (fetched_at: string, market = "SZ") => caliberHintLines([ev("ev-aaaaaa01", { fetched_at, market })], [cum]);
  assert.deepEqual(at("2026-11-05T09:00:00+08:00"), ["> 口径提示：按 A 股定期报告披露期限，取数日 2026-11-05 应已能取到 2026-09-30 的报告，本次财务数据最新只到 2026-06-30；增速、TTM 和 PE 都基于这一期。"]);
  assert.deepEqual(at("2026-10-08T09:00:00+08:00"), []);
  assert.deepEqual(at("2026-10-31T23:00:00+08:00"), [], "截止日当天不提示");
  assert.equal(at("2026-10-31T17:00:00Z").length, 1, "UTC 17 点已是北京时间 11 月 1 日");
  assert.deepEqual(at("2026-11-05T09:00:00+08:00", "HK"), []);
  assert.deepEqual(caliberHintLines([ev("ev-aaaaaa01", { fetched_at: "2026-11-05T09:00:00+08:00" })], []), [], "没有财务序列就不判断");
});

test("扣非×4：最新单季比前三季平均高或低三成以上才提示；断档、亏损季不比", () => {
  const run = (rows: [string, number | null][]) => {
    const lq = calc(1, "latest_quarter", [], { single_quarters: q(rows) }, { period: rows.at(-1)![0] });
    return caliberHintLines([], [lq, calc(2, "pe_deducted_annualized", ["ev-aaaaaa01", cid(1)])]);
  };
  const base: [string, number][] = [["2025-09-30", 100], ["2025-12-31", 100], ["2026-03-31", 100]];
  const high = run([...base, ["2026-06-30", 140]]);
  assert.equal(high.length, 1);
  assert.match(high[0]!, /2026-06-30 单季扣非乘 4，这一季比前三季平均高三成以上，年化后 PE 偏低/);
  assert.ok(high[0]!.endsWith(`[${cid(2)}]`));
  assert.match(run([...base, ["2026-06-30", 60]])[0]!, /平均低三成以上，年化后 PE 偏高/);
  assert.deepEqual(run([...base, ["2026-06-30", 125]]), []);
  assert.deepEqual(run([["2025-06-30", 100], ["2025-12-31", 100], ["2026-03-31", 100], ["2026-06-30", 200]]), [], "缺 2025-09-30");
  assert.deepEqual(run([["2025-09-30", -50], ["2025-12-31", 100], ["2026-03-31", 100], ["2026-06-30", 200]]), [], "有亏损季");
  assert.deepEqual(run([["2025-12-31", 100], ["2026-03-31", 100], ["2026-06-30", 200]]), [], "不足四季");
});

test("提示行只有日期、期数、币种和 id：数字忠实度不会把它们当成没出处的数字，也不触发合规闸门", () => {
  const lines = [
    ...caliberHintLines([ev("ev-aaaaaa01", { currency: "USD" }), ev("ev-aaaaaa02")], [calc(1, "forward_pe", ["ev-aaaaaa01", "ev-aaaaaa02"])]),
    ...caliberHintLines([], [calc(1, "ttm_sum", [], { end_period: "2026-03-31", single_quarters: q([["2026-06-30", 6]]) }),
      calc(2, "ttm_yoy", [], { end_period: "2026-06-30", single_quarters: [] })]),
    ...caliberHintLines([ev("ev-aaaaaa01", { fetched_at: "2026-11-05T09:00:00+08:00" })], [calc(1, "quarterize", [], { cumulative: q([["2026-06-30", 7]]) })]),
    ...caliberHintLines([], [calc(1, "latest_quarter", [], { single_quarters: q([["2025-09-30", 1], ["2025-12-31", 1], ["2026-03-31", 1], ["2026-06-30", 2]]) }, { period: "2026-06-30" }),
      calc(2, "pe_deducted_annualized", [cid(1)])]),
    ...caliberHintLines([], [calc(1, "latest_quarter", [], { single_quarters: q([["2025-09-30", 2], ["2025-12-31", 2], ["2026-03-31", 2], ["2026-06-30", 1]]) }, { period: "2026-06-30" }),
      calc(2, "pe_deducted_annualized", [cid(1)])]),
  ];
  assert.equal(lines.length, 6);
  assert.deepEqual(complianceGate(lines.join("\n")).hits, []);
  for (const line of lines) assert.deepEqual(claimNumbers(line, "300308"), [], line);
});

test("损坏的记录不让提示生成器抛异常", () => {
  const bad: unknown[] = [null, 7, { function: "ttm_sum" }, { calculation_id: cid(1), function: "ttm_sum", output: null },
    { calculation_id: cid(2), function: "ttm_sum", output: { status: "ok" }, inputs: null, inputs_refs: null },
    { calculation_id: cid(3), function: "quarterize", output: { status: "ok" }, inputs: { cumulative: "x" }, inputs_refs: [null, 1] },
    { calculation_id: cid(4), function: "pe_deducted_annualized", output: { status: "ok", details: null }, inputs_refs: [{ ref_id: cid(3) }] }];
  assert.doesNotThrow(() => caliberHintLines([null as unknown as EvidenceItem, ev("ev-aaaaaa01", { fetched_at: "坏" })], bad as CalcRecord[]));
});

test("口径提示接在 PE 分位披露之后，进入报告提示词，生产 validator 要求逐字放在开头", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-caliber-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ["fetch", "calcs", "stages"]) fs.mkdirSync(path.join(dir, sub));
  const evidence = [ev("ev-aaaaaa01", { currency: "USD", fetched_at: "2026-10-08T08:30:00+08:00" }), ev("ev-aaaaaa02")];
  const fpe = calc(1, "forward_pe", evidence.map((e) => e.id));
  fs.writeFileSync(path.join(dir, "fetch/test.json"), JSON.stringify({ script: "test", evidence }));
  fs.writeFileSync(path.join(dir, "calcs/test.json"), JSON.stringify(fpe));
  fs.writeFileSync(path.join(dir, "stages/report.json"), JSON.stringify({ stage: "report", status: "complete", summary: "测试", evidence_ids: [], calculation_ids: [cid(1)], gaps: [] }));
  const lines = reportPreludeLines(evidence, [fpe]);
  assert.deepEqual(lines, caliberHintLines(evidence, [fpe]));
  const prompt = reportPreludePrompt(dir);
  assert.ok(prompt.includes(lines[0]!));
  assert.match(prompt, /只提示、不改变状态/);
  const title = "# 示例研究报告 · 状态:complete";
  const errorsOf = (report: string) => { fs.writeFileSync(path.join(dir, "report.md"), report); return validateStage("report", loadRun(dir)).errors; };
  assert.ok(errorsOf(`${title}\n\n## 事实\n资料`).some((e) => e.startsWith("报告开头的固定披露") && e.includes(lines[0]!)));
  assert.ok(!errorsOf(`${title}\n\n${lines.join("\n")}\n\n## 事实\n资料`).some((e) => e.startsWith("报告开头的固定披露")));
  // 没有口径错位时提示词不多出那句说明
  fs.writeFileSync(path.join(dir, "fetch/test.json"), JSON.stringify({ script: "test", evidence: [ev("ev-aaaaaa01"), evidence[1]] }));
  assert.equal(reportPreludePrompt(dir), "");
});
