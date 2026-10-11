import assert from "node:assert/strict";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";

test("翻译与引导工具的订阅预检可取消，已取消时不发请求", async () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const oldFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => JSON.stringify({ schemaVersion: 2, source: { provider: "cli-claude" } }),
  } });
  let requests = 0;
  globalThis.fetch = (async (input, init) => {
    requests++;
    assert.equal(String(input), "/api/local-agents?provider=cli-claude");
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    for (const action of [
      (signal: AbortSignal) => backend.translateHeadlines([{ id: "one", title: "test" }], signal),
      (signal: AbortSignal) => backend.guidedTool("calc", "test", "test", signal),
    ]) {
      const controller = new AbortController();
      const pending = action(controller.signal);
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
      const before = requests;
      await assert.rejects(action(controller.signal), { name: "AbortError" });
      assert.equal(requests, before);
    }
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
