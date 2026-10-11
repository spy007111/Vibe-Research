import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend, type LedgerRecord } from "../src/verticals/finance/lib/backend.ts";
import { judgedRecord, reopenedRecord, verdictLabel } from "../src/verticals/finance/lib/verdicts.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const rec: LedgerRecord = { id: "criterion-1", kind: "criterion", created_at: "c", updated_at: "u", type: "falsifier", statement: "毛利率跌破 40%", due: "2026-10-01", status: "pending", note: "原备注" };

test("状态按类型显示;没见过的值当待判", () => {
  assert.deepEqual(["met", "broken", "dropped", "pending"].map((s) => verdictLabel("decision_point", s)), ["兑现", "没兑现", "不再跟踪", "待判"]);
  assert.deepEqual(["met", "broken"].map((s) => verdictLabel("falsifier", s)), ["到期没触发", "触发了"]);
  assert.equal(verdictLabel(undefined, "weird"), "待判");
});

test("判定:整条拷贝再改(台账整条替换),说明去空格,空说明清掉旧的;不改原对象", () => {
  const a = judgedRecord(rec, "broken", "  中报毛利率 38.5%  ", "2026-10-08");
  assert.deepEqual(a, { ...rec, status: "broken", judged_at: "2026-10-08", verdict_note: "中报毛利率 38.5%" });
  assert.equal(rec.status, "pending");
  const b = judgedRecord({ ...rec, verdict_note: "旧的" }, "met", "   ", "2026-10-08");
  assert.equal("verdict_note" in b, false);
  assert.equal(b.note, "原备注", "原有备注不动");
});

test("改回待判:清掉判定日和说明", () => {
  const r = reopenedRecord({ ...rec, status: "met", judged_at: "2026-10-08", verdict_note: "x" });
  assert.equal(r.status, "pending");
  assert.equal("judged_at" in r || "verdict_note" in r, false);
});

test("前端调用:GET /view/verdicts,重新取数带 refresh=1", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => { urls.push(String(input)); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try { await backend.verdicts(); await backend.verdicts({ refresh: true }); } finally { globalThis.fetch = prev; }
  assert.deepEqual(urls, ["/api/view/verdicts", "/api/view/verdicts?refresh=1"]);
});

test("页面:只记兑现与否不算涨跌;到期判据不在过期卡片里重复;研究页判据显示中文状态", () => {
  const panel = read("components/ui/VerdictPanel.tsx");
  assert.match(panel, /不算涨跌、不算胜率/);
  assert.doesNotMatch(panel, /胜率\s*\{|收益率|目标价|买入|卖出/);
  assert.match(read("pages/Calendar.tsx"), /filter\(\(e\) => e\.kind !== "criterion"\)/);
  const thesis = read("components/ui/ThesisPanel.tsx");
  assert.match(thesis, /verdictLabel\(c\.type, c\.status\)/);
  assert.doesNotMatch(thesis, /\{String\(c\.status \?\? ""\)\}/);
});
