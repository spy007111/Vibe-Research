import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { openAssistantBridge, type AssistantTool } from "../src/assistant_bridge.ts";
import { assistantTurn } from "../src/assistant_turn.ts";
import { assistantTools, confirmChatResearch, serviceContext, type ResearchProposal, type startResearch } from "../src/service.ts";
import "../src/finance/register.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schema = z.object({ text: z.string().max(100) }).strict();

test("bridge validates auth, origin, schema and tool names before side effects", async () => {
  let calls = 0;
  const bridge = await openAssistantBridge([{ name: "echo", description: "Echo", schema, run: ({ text }) => { calls++; return { text }; } }], new AbortController().signal);
  const call = (body: unknown, extra = {}) => fetch(bridge.url + "/call", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}`, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await call({}, { Authorization: "wrong" })).status, 403);
    assert.equal((await call({}, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await (await call({ name: "echo", arguments: { text: "ok", path: "/private" } })).json()).isError, true);
    assert.equal((await (await call({ name: "shell", arguments: {} })).json()).isError, true);
    assert.equal(calls, 0);
    const result = await (await call({ name: "echo", arguments: { text: "ok" } })).json();
    assert.equal(JSON.parse(result.content[0].text).text, "ok");
    assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test("real stdio MCP adapter lists tools and executes through the live bridge", async () => {
  const bridge = await openAssistantBridge([{ name: "echo", description: "Echo", schema, run: (a) => a }], new AbortController().signal);
  const client = new Client({ name: "test", version: "1" });
  try {
    assert.equal(fs.readFileSync(bridge.tokenFile, "utf8"), bridge.token);
    if (process.platform !== "win32") assert.equal(fs.statSync(bridge.tokenFile).mode & 0o777, 0o600);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, "orchestrator/src/assistant_tools_mcp.ts")], env: { VRA_ASSISTANT_URL: bridge.url, VRA_ASSISTANT_TOKEN_FILE: bridge.tokenFile } }));
    const tools = await client.listTools();
    assert.equal(tools.tools[0].name, "echo");
    assert.equal(tools.tools[0].inputSchema.additionalProperties, false);
    const result = await client.callTool({ name: "echo", arguments: { text: "真实桥接" } });
    assert.match(JSON.stringify(result), /真实桥接/);
    assert.equal(bridge.receipts[0].ok, true);
  } finally { await client.close(); await bridge.close(); assert.equal(fs.existsSync(bridge.tokenFile), false); }
});

test("abort prevents tool execution, passes cancellation to active work, and oversize results are explicit", async () => {
  const controller = new AbortController();
  let called = false;
  const bridge = await openAssistantBridge([{ name: "echo", description: "Echo", schema, run: (_, signal) => { called = true; assert.equal(signal, controller.signal); return "x".repeat(120_001); } }], controller.signal);
  const request = () => fetch(bridge.url + "/call", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name: "echo", arguments: { text: "a" } }) });
  try {
    assert.equal((await (await request()).json()).isError, true);
    assert.equal(called, true);
    called = false;
    controller.abort();
    assert.equal((await request()).status, 410);
    assert.equal(called, false);
  } finally { await bridge.close(); }
});

test("business refusal is a failed receipt even when transport succeeds", async () => {
  const bridge = await openAssistantBridge([{ name: "refused", description: "Refuse", schema: z.object({}), run: () => ({ ok: false, refused: { reason: "insufficient input" } }) }], new AbortController().signal);
  try {
    const response = await fetch(bridge.url + "/call", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name: "refused", arguments: {} }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /insufficient input/);
    assert.equal(bridge.receipts[0].ok, false);
  } finally { await bridge.close(); }
});

test("fetch envelopes and nested calculations report failures without hiding partial data", async () => {
  const schema = z.object({ index: z.number().int() });
  const results = [{ envelope: { status: "failed" } }, { envelope: { status: "error" } }, { result: { status: "error" } }, { result: { status: "failed" } }, { envelope: { status: "partial", evidence: ["retained"] } }];
  const bridge = await openAssistantBridge([{ name: "fetch", description: "Fetch", schema, run: ({ index }) => results[index] }], new AbortController().signal);
  try {
    for (let index = 0; index < results.length; index++) {
      const response = await fetch(bridge.url + "/call", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name: "fetch", arguments: { index } }) });
      const result = await response.json();
      assert.equal(result.isError === true, index < 4);
      assert.equal(bridge.receipts[index].ok, index === 4);
      assert.deepEqual(JSON.parse(result.content[0].text), results[index]);
    }
  } finally { await bridge.close(); }
});

test("assistant retains bounded same-source history, isolates changed provider and hands the product tools to chatSend", async () => {
  let n = 0;
  const tools: AssistantTool[] = [];
  const complete: Parameters<typeof assistantTurn>[2] = async (opts, req) => {
    // 工具原样交给 chatSend:本机 Agent 由它开一次性 MCP 桥,模型 API 在进程内调用(桥的生命周期见 chat 测试)
    assert.equal(opts.tools, tools);
    assert.equal(opts.persistent, false);
    assert.equal("sourceKey" in opts, false, "隔离键只在这里用,不往下传");
    assert.doesNotMatch(opts.developerInstructions!, /你没有本地工具/);
    if (++n === 2) assert.match(opts.contextText!, /第一句/);
    if (n === 3) assert.doesNotMatch(opts.contextText!, /第一句/);
    return { session: req.session!, reply: "已回答", redacted: 0, duration_ms: 1 };
  };
  const opts = { repoRoot: repo, dataRoot: "/test-assistant", tools, sourceKey: "a" };
  await assistantTurn(opts, { session: "history", message: "第一句" }, complete);
  await assistantTurn(opts, { session: "history", message: "第二句" }, complete);
  await assistantTurn({ ...opts, sourceKey: "b" }, { session: "history", message: "第三句" }, complete);
});

test("手打上限只管问题：页面数据多也能问，历史只记问题（每日复盘一点就报「消息须为 1–4000 字符」）", async () => {
  const seen: { message: string; maxMessage?: number; contextText?: string }[] = [];
  const complete: Parameters<typeof assistantTurn>[2] = async (opts, req) => {
    seen.push({ message: req.message, maxMessage: opts.maxMessage, contextText: opts.contextText });
    return { session: req.session!, reply: "已回答", redacted: 0, duration_ms: 1 };
  };
  const opts = { repoRoot: repo, dataRoot: "/test-assistant-page", tools: [] as AssistantTool[], sourceKey: "a" };
  const page = `【当前页面的数据】\n${"甲".repeat(9000)}`;
  await assistantTurn(opts, { session: "page", message: `${page}\n\n【问题】\n做一次复盘` }, complete);
  assert.equal(seen[0]!.message.length > 9000, true, "整条连同页面数据交给模型");
  assert.ok((seen[0]!.maxMessage ?? 0) >= seen[0]!.message.length, "往下传的上限要放得下这一条，不然 chatSend 还会再拦");
  await assistantTurn(opts, { session: "page", message: `${page}\n\n【问题】\n接着说` }, complete);
  assert.match(seen[1]!.contextText!, /做一次复盘/);
  assert.doesNotMatch(seen[1]!.contextText!, /甲甲甲/, "历史只记问题，不记整屏数据");

  const bad = (message: string) => assert.rejects(assistantTurn(opts, { session: "page", message }, complete), (e: Error & { code?: string }) => e.code === "bad_message");
  await bad(`${page}\n\n【问题】\n${"问".repeat(4001)}`);
  await bad("问".repeat(4001));
  await bad(`${page}\n\n【问题】\n   `);
  await bad(`${"甲".repeat(64_001)}\n【问题】\n短问题`);
  assert.equal(seen.length, 2, "被拦下的都没发出去");
});

test("tool catalog opens web, data, compute and task tools without accepting provider or destructive flags", () => {
  const tools = assistantTools(serviceContext({ repoRoot: repo }), { provider: "cli-claude", model: "", apiKey: "" });
  for (const name of ["search_web", "read_web_page", "fetch_endpoint", "run_tool", "start_research", "knowledge_recall"]) assert.ok(tools.find((t) => t.name === name));
  const start = tools.find((t) => t.name === "start_research")!;
  assert.equal(start.schema.safeParse({ symbol: "300308", overwrite: true }).success, false);
  assert.equal(start.schema.safeParse({ symbol: "300308", llm: { provider: "other" } }).success, false);
});

test("research requires a one-use UI confirmation and remains bound to the selected model and data root", () => {
  const ctx = serviceContext({ repoRoot: repo });
  const llm = { provider: "cli-claude" };
  const proposals: ResearchProposal[] = [];
  const tool = assistantTools(ctx, llm, proposals).find((t) => t.name === "start_research")!;
  const draft = tool.run(tool.schema.parse({ symbol: "300308" }) as never, new AbortController().signal) as { started: boolean };
  assert.equal(draft.started, false);
  assert.equal(proposals.length, 1);
  const proposal = proposals[0];
  let calls = 0;
  const start = ((_ctx, request) => { calls++; assert.deepEqual(request.llm, llm); assert.equal(request.overwrite, undefined); return { run_id: "confirmed" }; }) as typeof startResearch;
  assert.throws(() => confirmChatResearch({ ...ctx, dataRoot: ctx.dataRoot + "-other" }, { id: proposal.id, llm }, start));
  assert.throws(() => confirmChatResearch(ctx, { id: proposal.id, llm: { provider: "cli-codex" } }, start));
  assert.throws(() => confirmChatResearch(ctx, { id: proposal.id, llm, executionMode: "direct" }, start));
  assert.equal(calls, 0);
  assert.equal(confirmChatResearch(ctx, { id: proposal.id, llm, executionMode: "agent" }, start).run_id, "confirmed");
  assert.equal(calls, 1);
  assert.throws(() => confirmChatResearch(ctx, { id: proposal.id, llm }, start));
  assert.equal(calls, 1);
});
