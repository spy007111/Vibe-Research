import assert from "node:assert/strict";
import test from "node:test";

import { DirectTransportError, publicApiFailure } from "../../orchestrator/src/engines/direct_transport.ts";
import { ApiError, backend, friendlyAgentError } from "../src/verticals/finance/lib/backend.ts";

test("未接入 AI 仍可调用确定性工具，并传递取消信号", async () => {
  const oldFetch = globalThis.fetch;
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  const signal = new AbortController().signal;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "/api/tool/calc");
    assert.equal(init?.signal, signal);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.executionMode, "direct");
    assert.equal(body.llm, undefined);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.deepEqual(await backend.runTool("calc", { function: "peg" }, signal), { ok: true });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("AI 配置坏了 / 存储读不了：确定性工具照常按 direct 发；要 AI 的工具报本机配置的具体原因（审计 C9）", async () => {
  const oldFetch = globalThis.fetch;
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const bodies: { executionMode: string; llm?: unknown }[] = [];
  globalThis.fetch = async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (String(input) === "/api/tool/backtest") {
      return new Response(JSON.stringify({ error: "agent_required", message: "这个工具要用 AI" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  };
  const storages: [string, PropertyDescriptor, RegExp][] = [
    ["损坏的配置", { configurable: true, value: { getItem: () => "{not json" } }, /读不懂/],
    ["存储读不了", { configurable: true, value: { getItem: () => { throw new Error("SecurityError"); } } }, /不让读本地存储/],
  ];
  try {
    for (const [what, desc, why] of storages) {
      Object.defineProperty(globalThis, "localStorage", desc);
      bodies.length = 0;
      assert.deepEqual(await backend.runTool("kline", { symbol: "600519" }), { ok: true }, what);
      assert.equal(bodies[0]!.executionMode, "direct", what);
      assert.equal(bodies[0]!.llm, undefined, what);
      await assert.rejects(backend.runTool("backtest", {}), (e) => e instanceof ApiError && why.test(e.message), what);
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("Agent 认证失败只显示可行动的中文提示，不暴露重连地址与鉴权原文", () => {
  const raw = new ApiError(
    "Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: secret)",
    400,
    "turn_failed",
  );
  const shown = friendlyAgentError(raw);
  assert.equal(shown, "当前 AI 登录已失效或尚未完成。请先到「接入 AI」重新连接。");
  assert.doesNotMatch(shown, /401|Unauthorized|Missing bearer|wss?:\/\/|cf-ray|Reconnecting/i);
});

test("选中的本地 Agent 不可用时先拦住，不再发起对话请求", async () => {
  const oldFetch = globalThis.fetch;
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => JSON.stringify({
    schemaVersion: 2, modePreferenceVersion: 1, executionMode: "agent", source: { provider: "cli-codex" },
  }) } });
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    paths.push(url);
    if (url === "/api/local-agents?provider=cli-codex") {
      return new Response(JSON.stringify([{
        provider: "cli-codex", name: "Codex", installed: true, authenticated: false,
        available: false, version: "0.149.0", status: "not_authenticated", detail: "尚未登录",
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`不应请求 ${url}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => backend.chat("复盘今天", "daily-review", undefined, { provider: "cli-codex" }),
      (e: unknown) => e instanceof ApiError && e.code === "agent_not_ready"
        && e.message.includes("接入 AI"),
    );
    assert.deepEqual(paths, ["/api/local-agents?provider=cli-codex"], "只检测所选来源，不等待其他来源，也不调用 /chat");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("检测失败与未安装不再被误报成登录失效", () => {
  assert.match(friendlyAgentError(new ApiError("opaque secret diagnostic", 409, "agent_probe_failed")), /检测未完成/);
  assert.doesNotMatch(friendlyAgentError(new ApiError("opaque secret diagnostic", 409, "agent_probe_failed")), /secret|登录已失效/);
  assert.match(friendlyAgentError(new ApiError("当前选择的 Claude 尚未安装。请先到「接入 AI」完成连接。", 409, "agent_not_installed")), /尚未安装/);
});

test("Agent 端点返回非 JSON 错误页时也不回显底层正文", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    "502 upstream: Reconnecting wss://api.openai.com/v1/responses cf-ray: secret",
    { status: 502, headers: { "Content-Type": "text/html" } },
  )) as typeof fetch;
  try {
    await assert.rejects(
      () => backend.chat("复盘今天", "daily-review", undefined, { provider: "deepseek", apiKey: "k" }),
      (e: unknown) => e instanceof ApiError
        && e.message === "当前 AI 暂时没有连接成功。请到「接入 AI」检查当前连接后重试。"
        && !/wss?:\/\/|cf-ray|Reconnecting|502 upstream/i.test(e.message),
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Agent 端点返回 JSON 错误时默认不透传鉴权头、普通上游地址或 HTML", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: "turn_failed",
    message: "request headers: Authorization: Bearer secret; upstream https://example.com <html>bad gateway</html>",
  }), { status: 502, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    await assert.rejects(
      () => backend.chat("复盘今天", "daily-review", undefined, { provider: "deepseek", apiKey: "k" }),
      (e: unknown) => e instanceof ApiError
        && e.message === "当前 AI 登录已失效或尚未完成。请先到「接入 AI」重新连接。"
        && !/authorization|bearer|https?:\/\/|<html|bad gateway/i.test(e.message),
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("Agent 未知 JSON 错误也默认收口，不把内部诊断原文交给页面", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: "turn_failed", message: "opaque internal diagnostic secret-value",
  }), { status: 500, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    await assert.rejects(
      () => backend.chat("复盘今天", "daily-review", undefined, { provider: "deepseek", apiKey: "k" }),
      (e: unknown) => e instanceof ApiError
        && e.code === "turn_failed"
        && e.message === "当前 AI 暂时没有连接成功。请到「接入 AI」检查当前连接后重试。"
        && !/opaque|diagnostic|secret-value/i.test(e.message),
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("不支持的 cli provider 交给后端判定，不误报成未登录", async () => {
  const oldFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    paths.push(url);
    if (url === "/api/chat") {
      return new Response(JSON.stringify({ error: "unsupported_cli", message: "订阅档当前只支持 Codex 与 Claude Code" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`不应请求 ${url}`);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => backend.chat("复盘今天", "daily-review", undefined, { provider: "cli-unknown" }),
      (e: unknown) => e instanceof ApiError && e.code === "unsupported_cli"
        && e.message.includes("只支持 Codex 与 Claude Code"),
    );
    assert.deepEqual(paths, ["/api/chat"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("连接探针「有响应但没回填令牌」是可行动错误，原样显示而不是当成连接失败（#40）", () => {
  const raw = new ApiError("模型已响应，但没有按探针格式回填本次令牌。请确认所选模型能遵循结构化输出要求后重试", 400, "probe_bad_output");
  assert.equal(friendlyAgentError(raw), raw.message);
  assert.doesNotMatch(friendlyAgentError(raw), /连接成功|重新连接/);
});

test("远程访问链接失效 / 来源不对:按页面服务器的原话提示，不误报成 AI 没连上", () => {
  for (const raw of [
    new ApiError("访问链接无效或已失效:请用部署者发给你的完整链接重新打开页面。", 401, "access_required"),
    new ApiError("请从工作台自身页面发起请求。", 403, "forbidden_origin"),
  ]) {
    assert.equal(friendlyAgentError(raw), raw.message);
    assert.doesNotMatch(friendlyAgentError(raw), /接入 AI|登录已失效/);
  }
});

test("模型 API 拒绝 key / 限流 / 拒绝请求：按后端写死的原话显示，用户分得清是哪一种", () => {
  const oldError = console.error;
  console.error = () => { /* publicApiFailure 会往后台日志写一行,测试里不需要 */ };
  try {
    const shown = new Set<string>();
    for (const [status, code] of [[401, "api_key_rejected"], [403, "api_key_rejected"], [429, "api_rate_limited"], [400, "api_request_rejected"]] as const) {
      const failure = publicApiFailure(new DirectTransportError("http_error", "upstream raw https://example.com sk-secret", status, false), "模型名不对");
      assert.equal(failure.code, code);
      assert.equal(friendlyAgentError(new ApiError(failure.message, 400, failure.code)), failure.message, `${code} 被收口成了笼统提示`);
      assert.doesNotMatch(failure.message, /https?:\/\/|sk-/);
      shown.add(failure.message);
    }
    assert.equal(shown.size, 3, "三种失败要给三句不同的话");
    // 地址跳转:要原样告诉用户去改地址,不能收口成"稍后重试"(Codex 复审 R3-3)
    const redirect = publicApiFailure(new DirectTransportError("redirect", "模型端点返回了跳转(302) https://example.com", 302, false), "模型名不对");
    assert.equal(redirect.code, "api_redirect");
    assert.match(redirect.message, /跳转[\s\S]*Base URL/);
    assert.doesNotMatch(redirect.message, /https?:\/\/|稍后/);
    assert.equal(friendlyAgentError(new ApiError(redirect.message, 400, redirect.code)), redirect.message);
  } finally {
    console.error = oldError;
  }
});
