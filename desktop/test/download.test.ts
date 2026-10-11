import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REVOKE_AFTER_MS, saveBlob } from "../src/verticals/finance/lib/download.ts";

test("存文件:点完链接不马上释放临时地址,隔一会儿再释放(第四轮审计待核实项)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log: string[] = [];
  const link = { href: "", download: "", click: () => log.push(`click ${link.download}`), remove: () => log.push("remove") };
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { document: g.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  g.document = { createElement: () => link, body: { appendChild: () => log.push("append") } };
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = (u: string) => { log.push(`revoke ${u}`); };
  try {
    saveBlob(new Blob(["a"]), "报告.html");
    assert.deepEqual(log, ["append", "click 报告.html", "remove"], "点完的同一刻不释放");
    t.mock.timers.tick(REVOKE_AFTER_MS - 1);
    assert.ok(!log.includes("revoke blob:x"));
    t.mock.timers.tick(1);
    assert.equal(log.at(-1), "revoke blob:x", "过一会儿释放,不一直占着内存");
  } finally {
    g.document = saved.document;
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
});

test("两个下载入口都走 saveBlob,不再自己同步释放", () => {
  for (const p of ["lib/api.ts", "components/ShareCardPanel.tsx"]) {
    const src = readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
    assert.match(src, /saveBlob\(/, p);
    assert.doesNotMatch(src, /revokeObjectURL/, p);
  }
});
