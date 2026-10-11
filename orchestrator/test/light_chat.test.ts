import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { lightChatTurn } from "../src/light_chat.ts";

test("普通对话保留每个订阅/API 来源，关闭 MCP、历史与长流程，并转交取消信号", async () => {
  for (const provider of ["cli-claude", "cli-codebuddy", "cli-codex", "openai-compatible"]) {
    const controller = new AbortController();
    const llm = { provider, model: "selected", apiKey: "synthetic-test-key" };
    let calls = 0;
    const result = await lightChatTurn({ repoRoot: "/unused", signal: controller.signal,
      contextText: "本轮资料", reportSources: [{ id: "r1", name: "报告", page: 1 }] },
    { message: "你好", session: "light-test", llm }, async (opts, req) => {
      calls++;
      assert.equal(opts.tools, undefined);
      assert.equal(opts.persistent, false);
      assert.equal(opts.timeoutMs, 120_000);
      assert.equal(opts.maxMessage, 64_000, "带页面数据的消息与 Agent 路径同一个上限，不然每日复盘走本机订阅还是报 4000");
      assert.equal(opts.signal, controller.signal);
      assert.equal(opts.contextText, "本轮资料");
      assert.equal(opts.reportSources?.[0]?.id, "r1");
      assert.equal(opts.preambleText, "");
      assert.match(opts.developerInstructions!, /直接简洁/);
      assert.equal(req.llm, llm);
      return { session: "light-test", reply: "你好", redacted: 0, duration_ms: 1 };
    });
    assert.equal(calls, 1);
    assert.equal(result.reply, "你好");
  }
});

test("服务层只有 agent 分支构造研究工具，接口的 direct 单轮仍保留", () => {
  const source = readFileSync(new URL("../src/service.ts", import.meta.url), "utf8");
  assert.match(source, /executionMode === "direct" && provider/);
  assert.match(source, /executionMode === "direct"\s*\? await lightChatTurn\(chatOptions, chatRequest\)\s*: await assistantTurn/);
});
