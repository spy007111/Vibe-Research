/**
 * 垂类工具的能力说明（{"action":"catalog"} 的输出）会原样进模型上下文（引导式工具的【真实能力说明】）。
 * 模型照抄里面的话写进报告，报告就会被产品红线拦掉 ⇒ 每个工具的说明都要先过一遍真的红线（E3 审查 P2-3：
 * 情景回放说明里写过「不给加减仓建议」，其中「减仓」本身就是红线词）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import { FINANCE_PLUGIN } from "../src/finance/plugin.ts";
import { complianceGate } from "../src/gate.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.VRA_PYTHON ?? "python3";

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}

test("每个垂类工具的能力说明都过得了产品红线", () => {
  const tools = Object.entries(FINANCE_PLUGIN.tools ?? {});
  assert.ok(tools.length >= 8, "工具表变了要同步这条测试");
  for (const [name, spec] of tools) {
    // calc 认 catalog:true，其余认 action:"catalog"
    const p = spawnSync(PYTHON, ["-m", spec.module], { cwd: REPO, input: JSON.stringify({ action: "catalog", catalog: true }), encoding: "utf8", timeout: 60_000 });
    assert.equal(p.status, 0, `${name}: ${p.stderr}`);
    const out = JSON.parse(p.stdout) as { ok?: boolean; catalog?: unknown };
    assert.equal(out.ok, true, `${name} 不认 catalog`);
    const lines = strings(out.catalog);
    assert.ok(lines.length > 0, `${name} 的说明是空的`);
    const gate = complianceGate(lines.join("\n"));
    assert.deepEqual(gate.hits, [], `${name} 的能力说明里有红线词`);
  }
});
