import assert from "node:assert/strict";
import test from "node:test";
import { API_MODELS, apiPresetForSaved, modelNameForPreset } from "../src/verticals/finance/lib/ai-models.ts";
import { loadUserLlm, readAiRuntime, saveUserLlm } from "../src/verticals/finance/lib/llmStore.ts";

test("自定义端点保存重读后保留来源、模型及密钥，预设不按模型名串台 (#48)", () => {
  let stored: string | null = null;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; },
  } });
  for (const [provider, model, preset] of [
    ["openai-compatible", "my-model", "custom"],
    ["openai-compatible", "gpt-4o", "custom"],
    ["openrouter", "my-model", "openai/gpt-4o"],
    ["deepseek", "deepseek-v4-pro", "deepseek-v4-pro"],
  ]) {
    const cfg = { provider, model, apiKey: "fixture-key", baseURL: "https://example.com/v1" };
    saveUserLlm(cfg);
    assert.deepEqual(loadUserLlm(), cfg);
    assert.equal(apiPresetForSaved(loadUserLlm()), preset);
    assert.deepEqual(loadUserLlm(), cfg, "显示预设不得覆盖实际模型或凭据");
  }
});

test("选「其它 OpenAI 兼容端点」不把 custom 当模型名填进去，其它预设照填自己的模型名", () => {
  assert.equal(modelNameForPreset("custom"), "");
  for (const m of API_MODELS.filter((x) => x.id !== "custom")) assert.equal(modelNameForPreset(m.id), m.id);
});

test("浏览器静默丢弃写入时保存必须报错，不显示成功", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => null, setItem: () => {},
  } });
  assert.throws(() => saveUserLlm({ provider: "openai-compatible", model: "test", apiKey: "fixture-key", baseURL: "https://example.com" }), /保存/);
});

test("v2 之前页面存的 OpenAI 预设(来源名 openai,一直是官方 API)按 openai-api 读出;打开页面不改写存储,其它来源原样", () => {
  const legacy = { provider: "openai", model: "gpt-4o", apiKey: "fixture-key", baseURL: "https://api.openai.com/v1" };
  for (const stored of [JSON.stringify(legacy), JSON.stringify({ schemaVersion: 2, modePreferenceVersion: 1, source: legacy, executionMode: "agent" })]) {
    let writes = 0;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: () => stored, setItem: () => { writes += 1; },
    } });
    const read = readAiRuntime();
    assert.equal(read.status, "ok");
    assert.deepEqual(read.config?.source, { ...legacy, provider: "openai-api" }, "只改来源名,模型、key、地址原样");
    assert.equal(apiPresetForSaved(read.config!.source), "gpt-5.4", "落到 OpenAI 官方 API 这组预设上");
    assert.equal(writes, 0, "只读不写:等用户下次保存才写回");
  }
  const other = { provider: "openai-compatible", model: "m", apiKey: "fixture-key", baseURL: "https://example.com/v1" };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => JSON.stringify(other), setItem: () => {} } });
  assert.deepEqual(readAiRuntime().config?.source, other);
});
