import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { backend, type ResearchTaskRequest } from "../src/verticals/finance/lib/backend.ts";

const page = readFileSync(new URL("../src/verticals/finance/pages/MyReports.tsx", import.meta.url), "utf8");

// 旧版本存下的「Agent 开关 = 关」：读的时候忽略，页面请求仍是 agent
const runtime = {
  schemaVersion: 2, executionMode: "direct", directSupported: true, directReason: "verified",
  source: { provider: "deepseek", apiKey: "test-key", baseURL: "https://api.example.test", model: "test-model" },
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => key === "vr-llm" ? JSON.stringify(runtime) : null,
  setItem() {}, removeItem() {},
} });

const task = (): ResearchTaskRequest => ({
  schemaVersion: 1,
  id: "report-task-test",
  kind: "locate_passages",
  requestedMode: "auto",
  objective: "定位收入变化原文",
  evidenceScope: "existing",
  workflow: "single_step",
  inputRefs: [{ kind: "report", id: "report-a" }],
  outputFormat: "text",
  operation: null,
});

const routed = {
  status: "routed", executionAvailable: true, events: [],
  route: {
    target: "quick", requestedMode: "auto", reasonCode: "prepared_bounded_task",
    reason: "材料完备且任务有界", routeFingerprint: "a".repeat(64), materialState: "ready",
  },
};

test("routeTask 提交高层任务与 AI 来源，让后端绑定路由指纹", async () => {
  const oldFetch = globalThis.fetch;
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(routed), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await backend.routeTask(task());
    assert.equal(seen[0]?.url, "/api/tasks");
    assert.equal(seen[0]?.body.execute, false);
    assert.equal(seen[0]?.body.executionMode, "agent");
    assert.deepEqual(seen[0]?.body.llm, runtime.source);
    assert.equal("engine" in seen[0]!.body, false);
    assert.equal("engine" in (seen[0]!.body.task as Record<string, unknown>), false);
  } finally { globalThis.fetch = oldFetch; }
});

test("runTask 的 Quick 配置直接发给统一任务入口，不预检本地订阅 Agent", async () => {
  const oldFetch = globalThis.fetch;
  const paths: string[] = [];
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    paths.push(String(input));
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ...routed, status: "completed" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await backend.runTask(task(), "a".repeat(64), undefined, {
      provider: "deepseek", apiKey: "test-key", baseURL: "https://api.example.test", model: "test-model",
    });
    assert.deepEqual(paths, ["/api/tasks"]);
    assert.equal(body.execute, true);
    assert.equal(body.expectedRouteFingerprint, "a".repeat(64));
    assert.equal(body.executionMode, "agent");
    assert.deepEqual(body.llm, {
      provider: "deepseek", apiKey: "test-key", baseURL: "https://api.example.test", model: "test-model",
    });
    assert.equal("engine" in body, false);
  } finally { globalThis.fetch = oldFetch; }
});

test("resumeTask 只按运行编号与路由指纹读取 Deep 状态，不发送 engine", async () => {
  const oldFetch = globalThis.fetch;
  let url = "";
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ status: "running", events: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await backend.resumeTask("task-run-1", "b".repeat(64));
    assert.equal(url, "/api/tasks/resume");
    assert.deepEqual(body, { runId: "task-run-1", routeFingerprint: "b".repeat(64) });
    assert.equal("engine" in body, false);
  } finally { globalThis.fetch = oldFetch; }
});

test("我的研报隐藏内部档位，由系统自动选择并保留六阶段恢复能力", () => {
  assert.doesNotMatch(page, /auto: "Auto", quick: "Quick", deep: "Deep"/);
  assert.doesNotMatch(page, /aria-label="任务模式"/);
  assert.match(page, /由系统自动判断/);
  assert.match(page, /routeDecision\.reason/);
  assert.match(page, /请只选择同一个 A 股代码的资料/);
  assert.match(page, /DEEP_REPORT_LIMIT = 16/);
  assert.match(page, /系统判断需要完整研究，但一次最多使用/);
  assert.match(page, /kind: "locate_passages"/);
  assert.doesNotMatch(page, /wantsDeep|\.test\(goal\)/);
  assert.match(page, /backend\.resumeTask\(/);
  assert.match(page, /六阶段研究已完成/);
  assert.match(page, /backend\.routeTask\(task/);
  assert.match(page, /backend\.runTask\(task/);
  assert.doesNotMatch(page, /backend\.startResearch/);
  assert.doesNotMatch(page, /["']engine["']\s*:/);
});
