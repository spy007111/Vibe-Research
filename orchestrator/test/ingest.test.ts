import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts"; // 测试文件也是入口:插件要先注册
import { DirectTransportError, type ChatContentPart, type ChatReply, type ChatRequest } from "../src/engines/direct_transport.ts";
import { IngestError, MAX_FILES, ingestFiles } from "../src/ingest.ts";
import { listRecords, upsertRecord } from "../src/ledger.ts";
import { readIngestFile, type IngestReadContext } from "../src/ingest_tools.ts";
import type { LocalAgentId, RunLocalAgentOptions } from "../src/local_agent_runtime.ts";
import type { LlmOverride } from "../src/runtime_provider.ts";

// ⚠️ fileURLToPath 而不是 new URL(...).pathname —— 仓库路径含中文时 pathname 是百分号编码的
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Cap {
  agent?: LocalAgentId;
  opts?: RunLocalAgentOptions;
  /** 受控工具指向的暂存目录(VRA_INGEST_DIR) */
  dir?: string;
  /** 暂存目录里实际落盘的文件名 */
  names?: string[];
  image?: { data: string; mimeType: string };
}

/**
 * 假的本机 Agent(默认 Claude Code):照真 MCP 适配器的做法,经受控工具把清单里每个文件读完,
 * 再回放预设 JSON。`read=false` = 声称读过、其实一个字没读。
 */
function fakeAgent(reply: string, cap: Cap = {}, read = true, provider = "cli-claude") {
  return {
    llm: { provider } as LlmOverride,
    localAgentRunner: async (agent: LocalAgentId, opts: RunLocalAgentOptions): Promise<string> => {
      cap.agent = agent;
      cap.opts = opts;
      const env = opts.controlledMcp!.env;
      const ctx: IngestReadContext = { dir: env.VRA_INGEST_DIR!, files: JSON.parse(env.VRA_INGEST_FILES!) };
      cap.dir = ctx.dir;
      cap.names = fs.readdirSync(ctx.dir).filter((name) => !name.startsWith("."));
      if (read) {
        for (const file of ctx.files) {
          let offset = 0;
          for (;;) {
            const result = readIngestFile(ctx, { name: file.name, offset });
            const chunk = JSON.parse(result.content[0]!.text!) as { end: number; has_more?: boolean };
            const image = result.content.find((block) => block.type === "image");
            if (image) cap.image = { data: image.data, mimeType: image.mimeType };
            if (!chunk.has_more) break;
            offset = chunk.end;
          }
        }
      }
      return reply;
    },
  };
}

/** 自填端点:没有产品实测记录 ⇒ 结构化要求走提示词 */
const API: LlmOverride = { provider: "custom", baseURL: "https://api.example.invalid/v1", apiKey: "sk-test-ingest-0123456789", model: "test-vision" };

/** 假的模型 API:记录请求,回放预设回答 */
function fakeApi(reply: string, seen: ChatRequest[] = []) {
  return async (req: ChatRequest): Promise<ChatReply> => {
    seen.push(req);
    return { message: { role: "assistant", content: reply }, finishReason: "stop", usage: null, durationMs: 1 };
  };
}

/** 模型 API 请求里那条用户消息的各段(提示词 + 文本全文 + 图片) */
const userParts = (req: ChatRequest): ChatContentPart[] => (req.messages[1] as { content: ChatContentPart[] }).content;
const partsText = (req: ChatRequest): string =>
  userParts(req).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vra-ingest-"));
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64"); // PNG 魔数,够当"一张图"
const OK_REPLY = JSON.stringify({
  drafts: [
    { source_file: "01_a.csv", fields: { symbol: "300308", shares: 100, cost: 846 }, uncertain: ["cost:截图模糊"] },
  ],
  warnings: ["第二张图看不清"],
});

for (const agent of ["claude", "codex", "codebuddy"] as const) {
  test(`${agent} 转写只经上传白名单 MCP，保持出处且不自动写台账`, async (t) => {
    const root = tmp();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const out = await ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: `cli-${agent}` },
      localAgentRunner: async (actual, opts) => {
        assert.equal(actual, agent);
        if (agent === "codebuddy") {
          assert.equal(opts.outputSchema, undefined, "WorkBuddy 工具轮不同时启用 CLI schema 模式");
          assert.match(opts.userPrompt, /JSON Schema/);
          assert.match(opts.userPrompt, /source_file/);
        } else assert.ok(opts.outputSchema);
        assert.deepEqual(opts.controlledMcp?.allowedTools, ["mcp__vra_ingest__read_ingest_file"]);
        const env = opts.controlledMcp!.env;
        const ctx: IngestReadContext = { dir: env.VRA_INGEST_DIR!, files: JSON.parse(env.VRA_INGEST_FILES!) };
        const result = readIngestFile(ctx, { name: "01_a.csv" });
        assert.match((result.content[0] as { text: string }).text, /300308/);
        return OK_REPLY;
      },
    }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("代码,数量\n300308,100") }] });
    assert.equal(out.drafts[0]!.source_file, "a.csv");
    assert.deepEqual(listRecords(root, "position"), []);
  });
}

test("本机 Agent 未读取全部资料时不能返回看似完整的草稿，失败清理原件", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-claude" },
    localAgentRunner: async () => OK_REPLY,
  }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }), /完整读取/);
  assert.deepEqual(fs.readdirSync(path.join(root, "import")), []);
});

test("WorkBuddy 图片走原生附件，混合文本仍须读完白名单工具", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const mixed of [false, true]) {
    const out = await ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-codebuddy" },
      localAgentRunner: async (agent, opts) => {
        assert.equal(agent, "codebuddy");
        assert.equal(opts.userImages?.[0]?.data, PNG);
        assert.equal(opts.userImages?.[0]?.name, "01_表格.png");
        assert.match(opts.systemPrompt, /原生附件/);
        if (mixed) {
          const env = opts.controlledMcp!.env;
          const ctx = { dir: env.VRA_INGEST_DIR!, files: JSON.parse(env.VRA_INGEST_FILES!) } as IngestReadContext;
          assert.equal(ctx.files.length, 1);
          assert.equal(ctx.files[0]?.kind, "text");
          readIngestFile(ctx, { name: ctx.files[0]!.name });
        } else assert.equal(opts.controlledMcp, undefined, "纯图片不启动 MCP 或开放工具");
        return JSON.stringify({ drafts: [{ source_file: "01_表格.png", fields: { symbol: "600519", shares: 300, cost: 123.45 }, uncertain: [] }], warnings: [] });
      },
    }, { kind: "position", files: [{ name: "表格.png", content_base64: PNG }, ...(mixed ? [{ name: "notes.txt", content_base64: b64("说明") }] : [])] });
    assert.equal(out.drafts[0]?.source_file, "表格.png");
    assert.deepEqual(listRecords(root, "position"), []);
  }
});

test("本机 Agent 首轮漏读资料时只补跑一次同源受控读取，再校验草稿", async (t) => {
  const dataRoot = tmp();
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  let calls = 0;
  const result = await ingestFiles({ repoRoot: REPO, dataRoot, llm: { provider: "cli-codebuddy" },
    localAgentRunner: async (agent, opts) => {
      assert.equal(agent, "codebuddy");
      calls++;
      if (calls === 2) {
        assert.match(opts.userPrompt, /尚未完整读取/);
        const ctx = { dir: opts.controlledMcp!.env.VRA_INGEST_DIR,
          files: JSON.parse(opts.controlledMcp!.env.VRA_INGEST_FILES) } as IngestReadContext;
        for (const file of ctx.files) readIngestFile(ctx, { name: file.name });
      }
      return JSON.stringify({ drafts: [], summary: "空测试表", warnings: [] });
    },
  }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("symbol,shares,cost") }] });
  assert.equal(calls, 2);
  assert.equal(result.drafts.length, 0);
});

test("两次新调用不能各读一半资料后拼成完整回执", async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(() => ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-codebuddy" },
    localAgentRunner: async (_agent, opts) => {
      const env = opts.controlledMcp!.env;
      const ctx = { dir: env.VRA_INGEST_DIR!, files: JSON.parse(env.VRA_INGEST_FILES!) } as IngestReadContext;
      readIngestFile(ctx, { name: ctx.files[calls++]!.name });
      return JSON.stringify({ drafts: [], warnings: [] });
    },
  }, { kind: "position", files: ["a.txt", "b.txt"].map(name => ({ name, content_base64: b64("text") })) }), /完整读取/);
  assert.equal(calls, 2);
});

for (const damage of ["original", "receipt"]) test(`资料完整性损坏立即失败不重试：${damage}`, async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(() => ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-codebuddy" },
    localAgentRunner: async (_agent, opts) => {
      calls++;
      const env = opts.controlledMcp!.env;
      const files = JSON.parse(env.VRA_INGEST_FILES!);
      // Leave the first file unread; damage in the later file must win over retry.
      fs.writeFileSync(path.join(env.VRA_INGEST_DIR!, damage === "original" ? files[1].name : ".read-receipts.json"), "corrupt");
      return JSON.stringify({ drafts: [], warnings: [] });
    },
  }, { kind: "position", files: ["a.txt", "b.txt"].map(name => ({ name, content_base64: b64("text") })) }));
  assert.equal(calls, 1);
});

test("转写的硬约束:本机 Agent 只挂「读本次上传文件」这一个受控工具,模型 API 不带任何工具", async () => {
  const cap: Cap = {};
  const files = [{ name: "a.csv", content_base64: b64("代码,数量\n300308,100") }];
  await ingestFiles({ repoRoot: REPO, dataRoot: tmp(), ...fakeAgent(OK_REPLY, cap) }, { kind: "position", files });
  const mcp = cap.opts!.controlledMcp!;
  // 🔴 转写要是能跑命令 / 能联网 / 能调研究阶段的工具,它就能"自己去补数据" —— 那正是取数纪律要挡的
  assert.deepEqual(mcp.allowedTools, ["mcp__vra_ingest__read_ingest_file"]);
  assert.ok(mcp.args[0]!.endsWith(path.join("orchestrator", "src", "ingest_tools_mcp.ts")));
  assert.deepEqual(Object.keys(mcp.env).sort(), ["VRA_INGEST_DIR", "VRA_INGEST_FILES"], "受控工具只拿到暂存目录与本次清单");
  assert.match(cap.opts!.systemPrompt, /不联网/);
  assert.match(cap.opts!.systemPrompt, /不写台账/);

  const seen: ChatRequest[] = [];
  await ingestFiles({ repoRoot: REPO, dataRoot: tmp(), llm: API, apiComplete: fakeApi(OK_REPLY, seen) }, { kind: "position", files });
  assert.equal(seen.length, 1, "一次请求,没有工具循环");
  assert.equal(seen[0]!.tools, undefined, "模型 API 转写不带任何工具");
  assert.match(String((seen[0]!.messages[0] as { content: string }).content), /不联网/);
});

test("模型 API 转写:文本全文内联、图片作为原生附件,都在同一条用户消息里", async () => {
  const seen: ChatRequest[] = [];
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp(), llm: API, apiComplete: fakeApi(OK_REPLY.replace("01_a.csv", "01_shot.png"), seen) },
    { kind: "position", files: [{ name: "shot.png", content_base64: PNG }, { name: "rows.csv", content_base64: b64("代码,数量\n300308,100") }] },
  );
  assert.equal(r.drafts[0]!.source_file, "shot.png");
  const images = userParts(seen[0]!).flatMap((p) => (p.type === "image_url" ? [p.image_url.url] : []));
  assert.deepEqual(images, [`data:image/png;base64,${PNG}`], "图片原样作为 data: URL 附件");
  const text = partsText(seen[0]!);
  assert.ok(text.includes("【图片 01_shot.png】"), "附件前标出安全文件名,草稿出处才对得上");
  assert.ok(text.includes("300308,100"), "文本全文内联");
  assert.ok(text.includes("全文已附在本条消息末尾"));
  assert.ok(!text.includes("read_ingest_file"), "模型 API 没有工具,提示词里不能让它去调工具");
});

test("模型 API 转写的结构化约束按来源能力走:实测支持 schema 的发 response_format,没实测的写进提示词", async () => {
  const root = tmp();
  const files = [{ name: "a.csv", content_base64: b64("x") }];
  const untested: ChatRequest[] = [];
  await ingestFiles({ repoRoot: REPO, dataRoot: root, llm: API, apiComplete: fakeApi(OK_REPLY, untested) }, { kind: "position", files });
  assert.equal(untested[0]!.responseFormat, undefined, "没实测过的来源硬传 schema 可能被整轮拒掉");
  assert.match(partsText(untested[0]!), /JSON Schema/, "降级为提示词约束,不是静默丢掉");

  fs.mkdirSync(path.join(root, "providers"), { recursive: true });
  fs.writeFileSync(path.join(root, "providers", "fixture.json"), JSON.stringify({
    id: "fixture", name: "Fixture", base_url: "https://api.fixture.invalid/v1", env_key: "FIXTURE_API_KEY", default_model: "fixture-vision",
    direct: { supported: true, structured_output: "server_schema", verified_at: "2026-10-07" },
  }));
  const verified: ChatRequest[] = [];
  await ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "fixture", apiKey: "sk-fixture-0123456789" }, apiComplete: fakeApi(OK_REPLY, verified) },
    { kind: "position", files });
  const rf = verified[0]!.responseFormat as { type: string; json_schema: { schema: { required: string[] } } };
  assert.equal(rf.type, "json_schema");
  assert.deepEqual(rf.json_schema.schema.required, ["drafts", "warnings"]);
  assert.doesNotMatch(partsText(verified[0]!), /JSON Schema/, "服务端已强制 schema,不必再在提示词里重复");
  assert.equal(verified[0]!.model, "fixture-vision");
});

test("模型 API 转写失败:按 HTTP 状态给固定文案,上游原文与资料片段一个字都不带,暂存件照样清掉", async () => {
  const root = tmp();
  const cases: [Error, string][] = [
    [new DirectTransportError("http_error", "模型端点返回 401:{\"error\":\"bad key sk-leak-0123456789\"}", 401, false), "api_key_rejected"],
    [new DirectTransportError("http_error", "模型端点返回 400:{\"error\":\"image input not supported 私密内容\"}", 400, false), "api_request_rejected"],
    [new DirectTransportError("timeout", "请求超时", null, true), "timeout"],
    [new Error("socket hang up 私密内容 sk-leak-0123456789"), "turn_failed"],
  ];
  for (const [err, code] of cases) {
    await assert.rejects(
      () => ingestFiles({ repoRoot: REPO, dataRoot: root, llm: API, apiComplete: async () => { throw err; } },
        { kind: "position", files: [{ name: "a.txt", content_base64: b64("私密内容") }] }),
      (e: unknown) => e instanceof IngestError && e.code === code && !/sk-leak|私密内容|socket hang up/.test(e.message),
      `${err.message.slice(0, 20)} 应报 ${code}`,
    );
  }
  assert.deepEqual(fs.readdirSync(path.join(root, "import")), [], "失败后不许有残留批次");
});

test("模型 API 输出被截断(finish_reason=length):剩下的哪怕是合法 JSON 也整批失败,不交半截草稿(第四轮审计 A5)", async () => {
  const root = tmp();
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root, llm: API,
      apiComplete: async () => ({ message: { role: "assistant", content: OK_REPLY }, finishReason: "length", usage: null, durationMs: 1 }) },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("代码,数量\n300308,100\n000001,200") }] }),
    (e: unknown) => e instanceof IngestError && e.code === "reply_truncated" && /截断/.test(e.message),
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "import")), [], "失败后不许有残留批次");
});

test("模型 API 转写中途取消:请求本身被中止,报 cancelled,暂存件清掉", async () => {
  const root = tmp();
  const ac = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = ingestFiles({ repoRoot: REPO, dataRoot: root, llm: API, signal: ac.signal,
    apiComplete: (req) => new Promise<ChatReply>((_resolve, reject) => {
      req.signal!.addEventListener("abort", () => reject(new DirectTransportError("cancelled", "请求已被取消", null, false)), { once: true });
      entered();
    }) }, { kind: "position", files: [{ name: "a.txt", content_base64: b64("私密内容") }] });
  const rejected = assert.rejects(pending, (e: unknown) => e instanceof IngestError && e.code === "cancelled");
  await started;
  assert.equal(fs.readdirSync(path.join(root, "import")).length, 1, "请求进行中暂存件还在");
  ac.abort();
  await rejected;
  assert.deepEqual(fs.readdirSync(path.join(root, "import")), []);
});

test("没选 AI 来源就当场报错 —— 不替用户挑大脑,也不先把文件落盘", async () => {
  const root = tmp();
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }),
    (e: unknown) => e instanceof IngestError && e.code === "ai_source_not_configured",
  );
  assert.equal(fs.existsSync(path.join(root, "import")), false);
});

/**
 * 真实运行时 + 假 CLI 进程。
 * 取消:TERM 后有 2 秒宽限再 KILL 整组(运行时契约);出错:CLI 先退出、后代还活着,运行时要杀掉整组。
 * 要钉住的是**顺序**:整棵进程树确认退出之后,才清理上传批次 —— 暂存件被删时不许还有进程活着。
 * 孙进程每 20 毫秒看一眼暂存目录,活着的时候目录没了就留下记号。
 */
for (const scenario of ["cancel", "error"] as const) test(`真实本机 Agent 转写 ${scenario}:先确认进程树退出,再清理上传批次`, { skip: process.platform === "win32" }, async (t) => {
  const root = tmp();
  const bin = path.join(root, "claude");
  const state = path.join(root, "child.json");
  const sawMissing = path.join(root, "saw-missing");
  fs.writeFileSync(bin, [
    `#!${process.execPath}`,
    `const fs = require("fs");`,
    `const { spawn } = require("child_process");`,
    `const STATE = ${JSON.stringify(state)};`,
    `const SAW = ${JSON.stringify(sawMissing)};`,
    `const a = process.argv.slice(2);`,
    // 运行时每次调用前先查能力参数与登录方式:应答“参数齐全、订阅登录”
    `if (a[0] === "--help") { console.log("--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format --system-prompt --json-schema"); process.exit(0); }`,
    `if (a[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })); process.exit(0); }`,
    `const dir = JSON.parse(a[a.indexOf("--mcp-config") + 1]).mcpServers.vra_ingest.env.VRA_INGEST_DIR;`,
    `const watcher = "process.on('SIGTERM',()=>{});const fs=require('fs');const d=" + JSON.stringify(dir) + ";const s=" + JSON.stringify(SAW) + ";setInterval(()=>{if(!fs.existsSync(d))fs.writeFileSync(s,'1')},20);";`,
    `const child = spawn(process.execPath, ["-e", watcher], { stdio: "ignore" });`,
    `process.on("SIGTERM", () => {});`,
    // 先写临时文件再改名:测试端一看到文件就读,不许读到写了一半的空文件(负载高时真读到过)
    `fs.writeFileSync(STATE + ".tmp", JSON.stringify({ pid: process.pid, child: child.pid, dir })); fs.renameSync(STATE + ".tmp", STATE);`,
    scenario === "error" ? `setTimeout(() => process.exit(1), 300);` : "",
    `setInterval(() => {}, 100);`,
  ].join("\n"), { mode: 0o700 });
  const before = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = before;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ac = new AbortController();
  const turn = ingestFiles({ repoRoot: REPO, dataRoot: root, llm: { provider: "cli-claude" }, signal: ac.signal },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("public-fixture") }] });
  const rejected = assert.rejects(turn, (e: unknown) => e instanceof IngestError && e.code === (scenario === "cancel" ? "agent_cancelled" : "agent_failed"));
  for (let i = 0; i < 500 && !fs.existsSync(state); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(state), "假 CLI 应已启动");
  const info = JSON.parse(fs.readFileSync(state, "utf8")) as { pid: number; child: number; dir: string };
  if (scenario === "cancel") ac.abort(new Error("cancel fixture"));
  await rejected;
  for (const pid of [info.pid, info.child]) {
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "CLI 与它派生的进程都必须已退出");
  }
  assert.equal(fs.existsSync(info.dir), false, "上传批次已清理");
  assert.equal(fs.existsSync(sawMissing), false, "暂存件被删时还有进程活着 —— 顺序反了");
});

test("🔴 只产草稿,绝不写台账 —— 转写认错一个数字,落库后没人分得清是机器填的", async () => {
  const root = tmp();
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY) },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
  );
  assert.equal(r.drafts.length, 1);
  assert.equal(listRecords(root, "position").length, 0, "台账必须一条都没多");
  // 草稿不带信封字段:id/kind/created_at 只有真正落库时才由 Core 给
  for (const k of ["id", "kind", "created_at", "updated_at"]) {
    assert.ok(!(k in r.drafts[0]!.fields), `草稿不该自带 ${k}`);
  }
});

test("Claude / Codex 的图片与文本只经上传白名单工具读取,不把图片当本机附件交出去", async () => {
  for (const provider of ["cli-claude", "cli-codex"]) {
    const cap: Cap = {};
    await ingestFiles(
      { repoRoot: REPO, dataRoot: tmp(), ...fakeAgent(OK_REPLY.replace("01_a.csv", "01_shot.png"), cap, true, provider) },
      {
        kind: "position",
        files: [
          { name: "shot.png", content_base64: PNG },
          { name: "rows.csv", content_base64: b64("a,b") },
        ],
      },
    );
    assert.equal(cap.opts!.userImages, undefined, `${provider}:只有 WorkBuddy 走原生附件,其余一律经受控工具读图`);
    assert.deepEqual(cap.image, { data: PNG, mimeType: "image/png" }, "图片经受控工具读出");
    assert.equal(fs.existsSync(cap.dir!), false, "转写结束清理暂存件");
    const text = cap.opts!.userPrompt;
    assert.ok(text.includes("rows.csv"), "文本文件名要写进提示词");
    assert.ok(text.includes("01_shot.png"), "仍须向模型列出安全图片文件名");
    assert.ok(cap.opts!.outputSchema, "必须强制结构化产出,否则解析全靠运气");
  }
});

test("字段说明来自契约而不是写死 —— 垂类改字段,提示词自动跟着变", async () => {
  const cap: Cap = {};
  await ingestFiles(
    { repoRoot: REPO, dataRoot: tmp(), ...fakeAgent(JSON.stringify({ drafts: [], warnings: [] }), cap) },
    { kind: "criterion", files: [{ name: "a.txt", content_base64: b64("x") }] },
  );
  const text = cap.opts!.userPrompt;
  // criterion 的枚举字段:提示词里要出现它的取值,否则模型只能瞎填
  assert.ok(text.includes("decision_point") && text.includes("falsifier"), "枚举取值要出现在提示词里");
  assert.ok(text.includes("statement"), "必填字段要点名");
});

test("文件名是不可信输入:路径穿越要被净化,原名只作为出处留在草稿里", async () => {
  const root = tmp();
  const cap: Cap = {};
  await ingestFiles(
    {
      repoRoot: REPO, dataRoot: root,
      ...fakeAgent(JSON.stringify({ drafts: [{ source_file: "01_passwd.txt", fields: {}, uncertain: [] }], warnings: [] }), cap),
    },
    { kind: "position", files: [{ name: "../../../../etc/passwd.txt", content_base64: b64("x") }] },
  );
  assert.ok(cap.dir!.startsWith(path.resolve(root) + path.sep), "暂存目录必须在数据根内");
  const files = cap.names!;
  assert.equal(files.length, 1);
  assert.ok(!files[0]!.includes(".."), `落盘名不许含 ..:${files[0]}`);
  assert.ok(!fs.existsSync(path.join(root, "..", "passwd.txt")), "不许写到数据根之外");
});

test("类型白名单:pdf / xlsx 明确拒绝,并说清为什么(半成品比不支持更糟)", async () => {
  const root = tmp();
  for (const name of ["a.pdf", "b.xlsx", "c.exe", "d"]) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY) },
          { kind: "position", files: [{ name, content_base64: b64("x") }] },
        ),
      (e: unknown) => e instanceof IngestError && e.code === "unsupported_type",
      `应拒绝 ${name}`,
    );
  }
});

test("体积与数量上限;空文件与非法种类当场拒绝", async () => {
  const root = tmp();
  const one = { name: "a.txt", content_base64: b64("x") };
  const opts = { repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY) };
  await assert.rejects(
    () => ingestFiles(opts, { kind: "position", files: [] }),
    (e: unknown) => e instanceof IngestError && e.code === "no_files",
  );
  await assert.rejects(
    () => ingestFiles(opts, { kind: "position", files: Array.from({ length: MAX_FILES + 1 }, () => one) }),
    (e: unknown) => e instanceof IngestError && e.code === "too_many_files",
  );
  await assert.rejects(
    () => ingestFiles(opts, { kind: "position", files: [{ name: "a.txt", content_base64: "" }] }),
    (e: unknown) => e instanceof IngestError && e.code === "bad_content",
  );
  await assert.rejects(
    () => ingestFiles(opts, { kind: "nosuch", files: [one] }),
    (e: unknown) => e instanceof IngestError && e.code === "unknown_kind",
  );
});

test("产出解析不了就报错,不许'尽力还原' —— 半份草稿会被当成全部", async () => {
  const root = tmp();
  for (const bad of ["不是 JSON", '{"warnings":[]}', '{"drafts":{"not":"array"},"warnings":[]}']) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root, ...fakeAgent(bad) },
          { kind: "position", files: [{ name: "a.txt", content_base64: b64("x") }] },
        ),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output:${bad.slice(0, 30)}`,
    );
  }
});

test("草稿里的出处换回用户原来的文件名(他认得的是那个)", async () => {
  const r = await ingestFiles(
    {
      repoRoot: REPO, dataRoot: tmp(),
      ...fakeAgent(JSON.stringify({ drafts: [{ source_file: "01_我的持仓截图.png", fields: {}, uncertain: [] }], warnings: [] })),
    },
    { kind: "position", files: [{ name: "我的持仓截图.png", content_base64: PNG }] },
  );
  assert.equal(r.drafts[0]!.source_file, "我的持仓截图.png");
});

test("🔴 产出解析必须严格:非法结构不许被'修'成草稿(半份草稿会被当成全部)", async () => {
  const root = tmp();
  const cases: [string, string][] = [
    ['{"drafts":[null],"warnings":[]}', "草稿不是对象"],
    ['{"drafts":[{"fields":{}, "uncertain":[]}],"warnings":[]}', "缺 source_file"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":"x","uncertain":[]}],"warnings":[]}', "fields 不是对象"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{},"uncertain":"x"}],"warnings":[]}', "uncertain 不是数组"],
    // 🔴 最要命的一条:模型自己说"这几处没看清",非法结构被抹平后**这条信息整个消失**
    ['{"drafts":[{"source_file":"01_a.csv","fields":{},"uncertain":[1]}],"warnings":[]}', "uncertain 有非字符串"],
    ['{"drafts":[],"warnings":"failed"}', "warnings 不是数组"],
    ['[]', "顶层不是对象"],
  ];
  for (const [reply, why] of cases) {
    await assert.rejects(
      () =>
        ingestFiles(
          { repoRoot: REPO, dataRoot: root, ...fakeAgent(reply) },
          { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
        ),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output(${why})`,
    );
  }
});

test("🔴 扩展名是用户给的,内容也得对得上 —— 否则 PDF 改名叫 .txt 就绕开了'不收 PDF'", async () => {
  const root = tmp();
  const PDF = Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1").toString("base64");
  const bad: [string, string][] = [
    ["shot.png", b64("这根本不是 PNG")],              // 二进制伪装成图片
    ["shot.webp", PNG],                                // 图片格式对不上扩展名
    ["notes.txt", Buffer.from([0x00, 0x01, 0x02]).toString("base64")], // NUL = 二进制
    ["notes.txt", PDF],                                // 正是"改个名混进来"那一类
    ["notes.md", Buffer.from([0xff, 0xfe, 0x41]).toString("base64")],  // 非法 UTF-8
  ];
  for (const [name, content] of bad) {
    await assert.rejects(
      () => ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY) }, { kind: "position", files: [{ name, content_base64: content }] }),
      (e: unknown) => e instanceof IngestError && e.code === "content_mismatch",
      `应拒绝 ${name}`,
    );
  }
  // 真图片 / 真文本照过(不是把门一律关死)
  await ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY.replace("01_a.csv", "01_ok.png")) }, { kind: "position", files: [{ name: "ok.png", content_base64: PNG }] });
  await ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY.replace("01_a.csv", "01_ok.csv")) }, { kind: "position", files: [{ name: "ok.csv", content_base64: b64("代码,数量\n300308,100") }] });
});

test("超大 base64 在**解码之前**就被拒(解码本身要扫一遍、要分配内存)", async () => {
  const root = tmp();
  // 🔴 这里的输入是刻意挑的:30 MB 全是非 base64 字符。
  //    Node 的解码器会跳过非法字符 ⇒ **解码后是 0 字节**。
  //    - 有前置长度校验:先看编码长度 30 MB > 上限 → file_too_large
  //    - 没有前置校验  :解码完得到 0 字节 → bad_content
  //    两条路给出**不同的错误码**,这条断言才真的在测"检查发生在解码之前"。
  //    ⚠️ 换成 "A".repeat(30MB) 是测不出来的:它解码后 22.5 MB,两条路都会报 file_too_large
  //       —— 断言看着对,其实把变异放过去了(第一版就是这么写的)。
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY) }, { kind: "position", files: [{ name: "a.txt", content_base64: "!".repeat(30 * 1024 * 1024) }] }),
    (e: unknown) => e instanceof IngestError && e.code === "file_too_large",
  );
  // 正常的超大文件也照样拒(这条走的是解码后的那道)
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY) }, { kind: "position", files: [{ name: "a.txt", content_base64: Buffer.alloc(9 * 1024 * 1024, 0x41).toString("base64") }] }),
    (e: unknown) => e instanceof IngestError && e.code === "file_too_large",
  );
});

test("🔴 失败时暂存目录要清掉 —— 里面是用户的私密截图,而调用方拿不到 batch 路径", async () => {
  const root = tmp();
  const importDir = path.join(root, "import");
  // 第一个文件合法、第二个类型不对:第一个已经落盘了
  await assert.rejects(
    () =>
      ingestFiles(
        { repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY) },
        { kind: "position", files: [{ name: "a.txt", content_base64: b64("私密内容") }, { name: "b.pdf", content_base64: b64("x") }] },
      ),
    (e: unknown) => e instanceof IngestError && e.code === "unsupported_type",
  );
  assert.deepEqual(fs.existsSync(importDir) ? fs.readdirSync(importDir) : [], [], "失败后不许有残留批次");

  // 转写阶段失败同样要清
  await assert.rejects(
    () => ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent("不是 JSON") }, { kind: "position", files: [{ name: "a.txt", content_base64: b64("私密内容") }] }),
    (e: unknown) => e instanceof IngestError && e.code === "bad_output",
  );
  assert.deepEqual(fs.existsSync(importDir) ? fs.readdirSync(importDir) : [], [], "转写失败后同样不许有残留");

  // 成功也清理本次暂存件，用户在产品外选择的原文件不受影响。
  const r = await ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent(OK_REPLY) }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] });
  assert.equal(fs.existsSync(path.join(root, r.dir)), false, "成功的批次不残留上传原件");
});

test("🔴 导入要认用户配的后台默认来源 —— 不认的话,用户配了等于没配", async () => {
  const root = tmp();
  // <数据根>/config.json 里选 mimo(模板没有产品实测记录 ⇒ 结构化要求走提示词)
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ provider: { profile: "mimo" } }));
  const seen: ChatRequest[] = [];
  process.env.MIMO_API_KEY = "k-for-test-0123456789";
  try {
    await ingestFiles({ repoRoot: REPO, dataRoot: root, apiComplete: fakeApi(OK_REPLY, seen) },
      { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] });
  } finally {
    delete process.env.MIMO_API_KEY;
  }
  // ① 来源真的被认了:端点、模型、key 都来自用户选的那份模板与它声明的环境变量
  assert.equal(seen[0]!.baseURL, "https://api.xiaomimimo.com/v1");
  assert.equal(seen[0]!.model, "mimo-v2.6-flash", "模型应来自用户配的来源模板");
  assert.equal(seen[0]!.apiKey, "k-for-test-0123456789");
  // ② 能力也跟着生效:没实测过 ⇒ 不许硬传 schema,schema 要进提示词
  assert.equal(seen[0]!.responseFormat, undefined, "硬传可能被这家整轮拒掉");
  assert.match(partsText(seen[0]!), /JSON Schema/, "schema 要写进提示词");
});

test("🔴 草稿的 fields 一律按契约校验 —— 降级到提示词后没人拒非法字段,那就是在放松要求", async () => {
  const root = tmp();
  const bad: [string, string][] = [
    // 拼错字段名 / 模型自己加的字段:硬传 schema 时平台会拒,降级后必须由我们拒
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"symbol":"300308","confidence":0.9},"uncertain":[]}],"warnings":[]}', "多了未声明字段"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"shares":"很多"},"uncertain":[]}],"warnings":[]}', "类型不对"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"smybol":"300308"},"uncertain":[]}],"warnings":[]}', "字段名拼错"],
  ];
  for (const [reply, why] of bad) {
    await assert.rejects(
      () => ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent(reply) }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output(${why})`,
    );
  }
  // 只给读到的那几个字段(键不齐)是**允许**的:"没给这个键"和"给了 null"本来就同义
  const ok = await ingestFiles(
    { repoRoot: REPO, dataRoot: root, ...fakeAgent('{"drafts":[{"source_file":"01_a.csv","fields":{"symbol":"300308","shares":100,"cost":8.46},"uncertain":[]}],"warnings":[]}') },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
  );
  assert.deepEqual(ok.drafts[0]!.fields, { symbol: "300308", shares: 100, cost: 8.46 });
});

test("🔴 用户放在自己数据根下的来源覆盖模板要生效 —— 配置与模板必须同一个根", async () => {
  const root = tmp();
  // 用户配置选 mimo,并在**同一个根**下放一份自己的覆盖模板(改了默认模型)
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ provider: { profile: "mimo" } }));
  fs.mkdirSync(path.join(root, "providers"), { recursive: true });
  const tpl = JSON.parse(fs.readFileSync(path.join(REPO, "providers", "mimo.json"), "utf8")) as Record<string, unknown>;
  tpl.default_model = "mimo-v2.6-pro"; // 与仓库模板(mimo-v2.6-flash)不同 —— 用来区分到底读了哪一份
  fs.writeFileSync(path.join(root, "providers", "mimo.json"), JSON.stringify(tpl));

  const seen: ChatRequest[] = [];
  process.env.MIMO_API_KEY = "k-for-test-0123456789";
  try {
    await ingestFiles({ repoRoot: REPO, dataRoot: root, apiComplete: fakeApi(OK_REPLY, seen) }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] });
  } finally {
    delete process.env.MIMO_API_KEY;
  }
  assert.equal(seen[0]!.model, "mimo-v2.6-pro", "读的必须是用户那份覆盖模板,不是仓库自带的");
});

test("🔴 草稿校验用**完整契约**:值越界也要当场拒,不能等落库才被拒", async () => {
  const root = tmp();
  const bad: [string, string][] = [
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"symbol":"AAPL!"},"uncertain":[]}],"warnings":[]}', "symbol 不是三市场规范代码(pattern)"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"shares":-1},"uncertain":[]}],"warnings":[]}', "数量为负(minimum)"],
    ['{"drafts":[{"source_file":"01_a.csv","fields":{"opened_at":"2026-99-99"},"uncertain":[]}],"warnings":[]}', "不是真日历日(format)"],
  ];
  for (const [reply, why] of bad) {
    await assert.rejects(
      () => ingestFiles({ repoRoot: REPO, dataRoot: root, ...fakeAgent(reply) }, { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] }),
      (e: unknown) => e instanceof IngestError && e.code === "bad_output",
      `应判 bad_output(${why})`,
    );
  }
});

test("🔴 读不到的字段给 null 是**设计里的正常路径**,不能因此把整批判成坏产出", async () => {
  const root = tmp();
  // 提示词就是要求"读不到的给 null 而不是省略键";契约里的类型不含 null,
  // 所以校验必须发生在 dropNulls **之后**,否则最常见的合法草稿全被拒
  const reply = JSON.stringify({
    drafts: [{
      source_file: "01_a.csv",
      fields: { symbol: "300308", name: null, account: null, shares: 100, cost: 8.46, opened_at: null, note: null },
      uncertain: ["name:截图里没有"],
    }],
    warnings: [],
  });
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: root, ...fakeAgent(reply) },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
  );
  assert.deepEqual(r.drafts[0]!.fields, { symbol: "300308", shares: 100, cost: 8.46 }, "null 全部剥掉,剩下的原样保留");
  assert.deepEqual(r.drafts[0]!.uncertain, ["name:截图里没有"], "模型说不确定的地方要留着");
});

test("🔴 必填字段没读到的草稿要**标出来**,而不是让人点一个注定失败的按钮", async () => {
  const root = tmp();
  const reply = JSON.stringify({
    drafts: [
      { source_file: "01_a.csv", fields: { symbol: null, shares: 100, cost: 8.46 }, uncertain: ["symbol:截图糊了"] },
      { source_file: "01_a.csv", fields: { symbol: "300308", shares: 100, cost: 8.46 }, uncertain: [] },
    ],
    warnings: [],
  });
  const r = await ingestFiles(
    { repoRoot: REPO, dataRoot: root, ...fakeAgent(reply) },
    { kind: "position", files: [{ name: "a.csv", content_base64: b64("x") }] },
  );
  // 整批不许因此被毙掉 —— 截图里一个字段没拍清是常态
  assert.equal(r.drafts.length, 2);
  assert.deepEqual(r.drafts[0]!.missing_required, ["symbol"], "缺的必填要点名");
  assert.deepEqual(r.drafts[1]!.missing_required, [], "好的那条不受连累");
  // 口径要对得上落库:标了缺必填的,落库确实会被拒
  await assert.rejects(
    async () => { upsertRecord(root, "position", r.drafts[0]!.fields); },
    (e: unknown) => e instanceof Error && /symbol/.test(e.message),
    "标出来的那条,落库路径也确实拒",
  );
  assert.ok(upsertRecord(root, "position", r.drafts[1]!.fields).id, "没标的那条要能真存进去");
});
