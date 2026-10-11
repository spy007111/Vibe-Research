import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { API_MODELS, PROVIDER_BASE, SUBSCRIPTION_MODELS } from "../src/verticals/finance/lib/ai-models.ts";
import { aiConnectionLabel, subscriptionConfig, testAndSaveAi } from "../src/verticals/finance/lib/aiConnection.ts";

test("接入标签按来源显示，不泄露模型密钥或地址", () => {
  for (const status of ["none", "broken", "unavailable"] as const) assert.equal(aiConnectionLabel({ status, config: null }), "未接入AI，请设置");
  for (const [provider, label] of Object.entries({ "cli-codex": "Codex订阅版", "cli-claude": "Claude订阅", "cli-codebuddy": "WorkBuddy CLI", deepseek: "DeepSeek API", mimo: "MiMo API", "openai-compatible": "自定义 API" })) {
    assert.equal(aiConnectionLabel({ status: "ok", config: { schemaVersion: 2, source: { provider, apiKey: "secret", baseURL: "private", model: "model" } } }), `已接入AI：${label}`);
  }
});

test("三个快捷订阅使用现有来源，探针通过前不保存", async () => {
  for (const provider of ["cli-codex", "cli-claude", "cli-codebuddy"]) {
    const cfg = subscriptionConfig(provider);
    let saves = 0;
    await testAndSaveAi(cfg, { read: () => null, probe: async (input) => { assert.deepEqual(input, cfg); assert.equal(saves, 0); return { ok: true }; }, save: (input) => { assert.deepEqual(input, cfg); saves++; } });
    assert.equal(saves, 1);
    assert.equal(cfg.apiKey, "");
  }
  assert.throws(() => subscriptionConfig("unknown"));
});

test("探针失败、取消、配置被另一个页面改动时不保存", async () => {
  const cfg = subscriptionConfig("cli-claude");
  const success = { ok: true as const };
  for (const mode of ["failed", "aborted", "changed", "invalid"]) {
    const controller = new AbortController();
    let stored: string | null = null;
    await assert.rejects(testAndSaveAi(cfg, { read: () => stored, probe: async () => {
      if (mode === "failed") throw new Error("failed");
      if (mode === "aborted") controller.abort();
      if (mode === "changed") stored = "another source";
      if (mode === "invalid") return { ...success, ok: false } as unknown as typeof success;
      return success;
    }, save: () => assert.fail("must not save") }, controller.signal));
  }
});

test("无法持久化时不冒充接入成功", async () => {
  await assert.rejects(testAndSaveAi(subscriptionConfig("cli-codex"), { read: () => null, probe: async () => ({ ok: true }), save: () => { throw new Error("storage failed"); } }), /storage failed/);
});

test("API 档预设与 providers/ 模板一致：预填地址相同、模板的默认模型就在清单里（模板改了页面忘改会红）", () => {
  const dir = fileURLToPath(new URL("../../providers/", import.meta.url));
  const templated = API_MODELS.filter((m) => fs.existsSync(path.join(dir, `${m.provider}.json`)));
  const providers = [...new Set(templated.map((m) => m.provider))].sort();
  assert.deepEqual(providers, ["deepseek", "glm", "kimi", "mimo", "openai-api", "qwen"], "有模板的厂商少了一家:路径或清单不对");
  for (const pv of providers) {
    const tpl = JSON.parse(fs.readFileSync(path.join(dir, `${pv}.json`), "utf8")) as { base_url: string; default_model: string };
    assert.equal(PROVIDER_BASE[pv], tpl.base_url, `${pv} 的预填地址和模板不一致`);
    assert.ok(templated.some((m) => m.provider === pv && m.id === tpl.default_model),
      `${pv} 模板的默认模型 ${tpl.default_model} 不在页面清单里`);
  }
});

test("订阅档用的是用户自己登录好的 CLI：不再出现 v1 的「产品自带引擎 / 产品专用登录」，也不替用户推荐某一家", () => {
  assert.deepEqual(SUBSCRIPTION_MODELS.map((m) => m.provider), ["cli-codex", "cli-claude", "cli-codebuddy"]);
  for (const m of SUBSCRIPTION_MODELS) assert.doesNotMatch(m.description, /产品自带|产品专用|推荐/, m.name);
});
