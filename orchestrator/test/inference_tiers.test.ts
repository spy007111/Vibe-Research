import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import "../src/finance/register.ts";
import { INFERENCE_TIERS, inferenceTierErrors } from "../src/finance/inference_tiers.ts";
import { loadRun, validateStage } from "../src/validator.ts";

const report = (body: string) => `# 示例研究报告 · 状态:complete\n\n## 结论摘要\n- 摘要\n## 推断\n${body}\n## 估值\n- 无\n## 风险与反证\n- 高\n`;

test("四档：表格每行、顶层列表每条都要标一档；表头、分隔行、段落和下级列表不单算", () => {
  const table = [
    "以下按条列出。",
    "| # | 推断 | 依据 | 可信度 |",
    "|---|---|---|---|",
    "| 1 | 近四季利润高增 | calc-3ddb858cc85e09a5 | 已披露证实 |",
    "| 2 | 一致预期隐含减速 | calc-b7da07407ccd09a7 | 有依据的推断 |",
    "| 3 | 产能紧张的说法 | 公告标题 | 未核实线索 |",
    "| 4 | 旧档案说毛利下滑 | ev-9f1debb6d197 | 被反证 |",
  ].join("\n");
  assert.deepEqual(inferenceTierErrors(report(table)), []);
  const list = "- 有依据的推断：利润转向向上(calc-3ddb858cc85e09a5)\n  - 依据说明,不单算\n1. 未核实线索：渠道传闻扩产\n2) 已披露证实：见[资料:a1b2 p.3]";
  assert.deepEqual(inferenceTierErrors(report(list)), []);
  assert.deepEqual(inferenceTierErrors(report("本次数据不足以形成推断。")), []);
  assert.equal(INFERENCE_TIERS.length, 4);
});

test("四档：没标档位、还用高中低、没依据却标了前两档或被反证，都逐条报出", () => {
  const bad = [
    "| # | 推断 | 依据 | 置信度 |",
    "|---|---|---|---|",
    "| 1 | 利润高增 | calc-3ddb858cc85e09a5 | 高 |",
    "| 2 | 估值便宜 | — | 有依据的推断 |",
    "- 被反证：旧结论不成立",
    "- 已披露证实：ev-abc 太短不算 id",
  ].join("\n");
  const errors = inferenceTierErrors(report(bad));
  assert.equal(errors.length, 4, errors.join("\n"));
  assert.match(errors[0]!, /第 1 条没标可信度\(只用四档:已披露证实 \/ 有依据的推断 \/ 未核实线索 \/ 被反证\)/);
  assert.match(errors[1]!, /第 2 条标了「有依据的推断」却没写依据 id/);
  assert.match(errors[2]!, /第 3 条标了「被反证」却没写依据 id/);
  assert.match(errors[3]!, /第 4 条标了「已披露证实」却没写依据 id/);
});

test("四档：只查「推断」章节；标题带说明也认；代码块里的假标题不算", () => {
  assert.deepEqual(inferenceTierErrors("# x\n## 风险与反证\n- 高\n## 裁决点\n- 中"), []);
  assert.equal(inferenceTierErrors("# x\n## 推断(每条带可信度)\n- 高\n").length, 1);
  assert.equal(inferenceTierErrors("# x\n## 推断\n### 利润\n- 低\n## 估值\n- 低").length, 1, "推断下的子标题仍属推断");
  assert.deepEqual(inferenceTierErrors("# x\n```\n## 推断\n- 高\n```\n"), []);
});

test("四档检查接进了生产阶段 validator", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-tiers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const sub of ["fetch", "calcs", "stages"]) fs.mkdirSync(path.join(dir, sub));
  fs.writeFileSync(path.join(dir, "stages/report.json"), JSON.stringify({ stage: "report", status: "complete", summary: "测试", evidence_ids: [], calculation_ids: [], gaps: [] }));
  fs.writeFileSync(path.join(dir, "report.md"), report("- 利润高增,置信度 中"));
  assert.ok(validateStage("report", loadRun(dir)).errors.some((e) => e.includes("「推断」第 1 条没标可信度")));
  fs.writeFileSync(path.join(dir, "report.md"), report("- 未核实线索:利润高增的说法只见于标题"));
  assert.ok(!validateStage("report", loadRun(dir)).errors.some((e) => e.includes("「推断」")));
});

test("宪法、研究技能、报告阶段提示词都写成同一套四档", () => {
  const read = (rel: string) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
  for (const rel of ["methodology/constitution.md", ".agents/skills/company-research/SKILL.md", "orchestrator/src/finance/stages.ts"]) {
    const text = read(rel);
    for (const tier of INFERENCE_TIERS) assert.ok(text.includes(tier), `${rel} 没写「${tier}」`);
    assert.doesNotMatch(text, /置信度 ?高 ?\/ ?中 ?\/ ?低|依据 id \+ 置信度/, `${rel} 还留着高/中/低的旧写法`);
  }
  assert.match(read(".agents/skills/earnings-analysis/SKILL.md"), /可信度按研究宪法 §1 的四档标/);
  assert.match(read("methodology/constitution.md"), /口径提示:编排器按证据核对/);
});
