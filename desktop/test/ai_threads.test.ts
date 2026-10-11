import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withRenderer } from "./helpers/render.ts";

function memStore() {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
  } });
  return { store, restore: () => { if (prev) Object.defineProperty(globalThis, "localStorage", prev); else Reflect.deleteProperty(globalThis, "localStorage"); } };
}

test("聊天记录目录读不出来：不当成「没有记录」，也不往里写（第四轮审计 D3）", async () => {
  const { directoryReadable, listThreads, touchThread } = await withRenderer((r) => r.load("/src/core/ai/threads.ts"));
  const s = memStore();
  try {
    assert.equal(directoryReadable(), true, "没有目录 = 还没聊过，读得出来");
    s.store.set("vr-ai-threads", "{坏数据");
    assert.equal(directoryReadable(), false);
    assert.deepEqual(listThreads(), []);
    touchThread("t1", "新问题");
    assert.equal(s.store.get("vr-ai-threads"), "{坏数据", "读不出来就什么都不写");
  } finally { s.restore(); }
  const ui = readFileSync(new URL("../src/core/ai/AiConsole.tsx", import.meta.url), "utf8");
  const empty = ui.slice(ui.indexOf("{threads.length === 0 && ("), ui.indexOf("{threads.map("));
  assert.match(empty, /directoryReadable\(\)\s*\?\s*"还没有记录/, "读得出来才说「还没有记录」");
  assert.match(empty, /暂时读不出来/);
});
