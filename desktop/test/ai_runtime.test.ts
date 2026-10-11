import assert from "node:assert/strict";
import test from "node:test";

import { backend } from "../src/verticals/finance/lib/backend.ts";
import { LLM_KEY, clearUserLlm, readAiRuntime, saveUserLlm } from "../src/verticals/finance/lib/llmStore.ts";

function storageFixture(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set(LLM_KEY, initial);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  return values;
}

const api = { provider: "deepseek", baseURL: "https://api.deepseek.com", apiKey: "test-key", model: "deepseek-v4" };

test("旧版平铺配置照常读入，读取时不改写存储", () => {
  const values = storageFixture(JSON.stringify(api));
  const before = values.get(LLM_KEY);
  const read = readAiRuntime();
  assert.equal(read.status, "ok");
  assert.deepEqual(read.config, { schemaVersion: 2, source: api });
  assert.equal(values.get(LLM_KEY), before);
});

test("旧版存下的 Agent 开关和直连标记读的时候忽略，也不改写存储", () => {
  const old = { schemaVersion: 2, source: api, modePreferenceVersion: 1, executionMode: "direct", directSupported: true, directReason: "verified" };
  const values = storageFixture(JSON.stringify(old));
  assert.deepEqual(readAiRuntime().config, { schemaVersion: 2, source: api });
  assert.deepEqual(JSON.parse(values.get(LLM_KEY)!), old, "读取不改密钥存储");
});

test("保存只写来源，密钥只存一份；清除后回到未接入", () => {
  const values = storageFixture();
  saveUserLlm(api);
  assert.deepEqual(JSON.parse(values.get(LLM_KEY)!), { schemaVersion: 2, source: api });
  assert.equal((values.get(LLM_KEY)?.match(/test-key/g) ?? []).length, 1);
  clearUserLlm();
  assert.equal(readAiRuntime().status, "none");
});

test("页面发出的 AI 请求一律是 agent，旧版存的「关」不会让 AI 失去联网和工具", async () => {
  storageFixture(JSON.stringify({ schemaVersion: 2, source: api, executionMode: "direct", directSupported: true }));
  const oldFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ session: "s", reply: "ok", redacted: 0, duration_ms: 1 }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await backend.chat("什么是现金流？");
    await backend.runTool("calc", { function: "peg" });
    assert.deepEqual(bodies.map((b) => b.executionMode), ["agent", "agent"]);
    assert.deepEqual(bodies[0]?.llm, api);
  } finally { globalThis.fetch = oldFetch; }
});
