import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { judge, matrixOptionsFromArgs, runMatrix, scrubWith, solidPng, suggestDirect, type MatrixCase, type TurnSummary } from "../src/finance/provider_matrix.ts";
import { parseArgs } from "../src/run.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const T = (p: Partial<TurnSummary> = {}): TurnSummary => ({ text: "", calls: [], max_calls_per_message: 0, rounds: 1, finish: "stop", error: null, ...p });
const call = (name: string, args: Record<string, unknown> | null, ok = true) => ({ name, args, ok });

test("matrix judge ①②:约定 token / 工具输出带回;传输错误一律 error", () => {
  assert.equal(judge(1, T({ text: "vra-ok-7731" })).verdict, "pass");
  assert.equal(judge(1, T({ text: "nope" })).verdict, "fail");
  assert.equal(judge(1, T({ text: "vra-ok-7731", error: "api_http_error HTTP 500:boom" })).verdict, "error");
  const echoed = [call("echo_text", { text: "hello-tool-4412" })];
  assert.equal(judge(2, T({ calls: echoed, text: "工具返回 hello-tool-4412" })).verdict, "pass");
  assert.equal(judge(2, T({ calls: echoed, text: "完成了" })).verdict, "partial", "调了工具但没把输出带回回复");
  assert.equal(judge(2, T({ text: "hello-tool-4412" })).verdict, "fail", "没调工具、直接抄 prompt 里的字不算");
  assert.equal(judge(2, T({ calls: [call("echo_text", null, false)], text: "hello-tool-4412" })).verdict, "fail", "参数不合法的调用不算");
});

test("matrix judge ③:三次调用必须依次用上一次的码;少调 / 乱序 → partial;不调 → fail", () => {
  const chain = ["start", "K7", "Q2"].map((code) => call("next_code", { code }));
  assert.equal(judge(3, T({ calls: chain, text: "Z9" })).verdict, "pass");
  assert.equal(judge(3, T({ calls: chain, text: "z9" })).verdict, "pass", "大小写不敏感");
  assert.equal(judge(3, T({ calls: chain.slice(0, 2), text: "Q2" })).verdict, "partial");
  assert.equal(judge(3, T({ calls: [chain[0]!, chain[2]!, chain[1]!], text: "Z9" })).verdict, "partial", "乱序");
  assert.equal(judge(3, T({ text: "Z9" })).verdict, "fail");
});

test("matrix judge ④:同一条回复里 ≥2 个调用 → pass;分开调 → partial;缺一 → fail", () => {
  const both = [call("lookup", { key: "alpha" }), call("lookup", { key: "beta" })];
  assert.equal(judge(4, T({ calls: both, max_calls_per_message: 2 })).verdict, "pass");
  assert.equal(judge(4, T({ calls: both, max_calls_per_message: 1 })).verdict, "partial");
  assert.equal(judge(4, T({ calls: [both[0]!], max_calls_per_message: 2 })).verdict, "fail");
});

test("matrix judge ⑤:失败调用 → 改读成功 → 最终回复带出结果,三者齐全才 pass", () => {
  const calls = [call("read_file", { path: "/missing/vra-7731.txt" }, false), call("read_file", { path: "/data/recovered.txt" })];
  assert.equal(judge(5, T({ calls, text: "读到 recovered-5519" })).verdict, "pass");
  assert.equal(judge(5, T({ calls, text: "done" })).verdict, "partial", "回复未带出结果");
  assert.equal(judge(5, T({ calls: [calls[1]!], text: "recovered-5519" })).verdict, "partial", "跳过了失败那一步");
  assert.equal(judge(5, T({ calls: [calls[0]!], text: "失败了" })).verdict, "fail", "没有改读");
});

test("matrix judge ⑥:1..200 一个不缺且 finish_reason=stop → pass;缺号 / 被截断 → partial", () => {
  const full = Array.from({ length: 200 }, (_, i) => `${i + 1}. line`).join("\n");
  assert.equal(judge(6, T({ text: full })).verdict, "pass");
  assert.equal(judge(6, T({ text: full, finish: "length" })).verdict, "partial");
  const r = judge(6, T({ text: full.replace("\n150. line", "") })); assert.equal(r.verdict, "partial"); assert.match(r.detail, /缺 1 个.*150/);
});

test("matrix judge ⑦⑧⑨⑩:收尾 JSON / schema 字段 / 约定词复述 / 图片颜色", () => {
  assert.equal(judge(7, T({ text: '{"key":"gamma","value":"g-904"}' })).verdict, "pass");
  assert.equal(judge(7, T({ text: '```json\n{"key":"gamma","value":"g-904"}\n```' })).verdict, "pass", "代码围栏剥掉后合法也算");
  assert.equal(judge(7, T({ text: '{"key":"gamma","value":"g-000"}' })).verdict, "partial");
  assert.equal(judge(7, T({ text: "gamma 是 g-904" })).verdict, "fail");
  assert.equal(judge(8, T({ text: '{"answer":"vra","n":42}' })).verdict, "pass");
  assert.equal(judge(8, T({ text: '{"answer":"vra","n":"42"}' })).verdict, "partial", "类型不对");
  assert.equal(judge(8, T({ text: '{"answer":"vra","n":42,"extra":1}' })).verdict, "partial", "多字段");
  assert.equal(judge(8, T({ text: "not json" })).verdict, "fail");
  assert.equal(judge(9, T({ text: "cobalt-lantern-5519" }), { token: "cobalt-lantern-5519" }).verdict, "pass");
  assert.equal(judge(9, T({ text: "忘了" }), { token: "cobalt-lantern-5519" }).verdict, "fail");
  assert.equal(judge(10, T({ text: "红色" })).verdict, "pass");
  assert.equal(judge(10, T({ text: "Red" })).verdict, "pass");
  assert.equal(judge(10, T({ text: "the image was rendered blue" })).verdict, "fail", "rendered 里的 red 不算");
});

test("suggestDirect:核心项全过才 supported;⑧ 决定 structured_output;未跑的核心项不能当通过", () => {
  const mk = (verdicts: Record<number, MatrixCase["verdict"]>): MatrixCase[] =>
    Object.entries(verdicts).map(([no, verdict]) => ({ no: Number(no), name: "", verdict, detail: "", duration_ms: 0, calls: 0, rounds: 1 }));
  const all = mk({ 1: "pass", 2: "pass", 3: "pass", 4: "partial", 5: "pass", 6: "pass", 7: "pass", 8: "pass", 9: "pass", 10: "fail" });
  const s = suggestDirect(all, "2026-10-07");
  assert.equal(s.supported, true); assert.equal(s.structured_output, "server_schema"); assert.equal(s.verified_at, "2026-10-07");
  assert.ok(s.notes.some((n) => /并行/.test(n)) && s.notes.some((n) => /图片/.test(n)), "④⑩ 只进 notes");
  assert.equal(suggestDirect(mk({ ...Object.fromEntries(all.map((c) => [c.no, c.verdict])), 8: "fail" }), "d").structured_output, "prompt");
  assert.equal(suggestDirect(mk({ ...Object.fromEntries(all.map((c) => [c.no, c.verdict])), 3: "partial" }), "d").supported, false);
  const partialRun = suggestDirect(mk({ 1: "pass", 2: "pass", 8: "pass" }), "d");
  assert.equal(partialRun.supported, false); assert.ok(partialRun.notes.some((n) => /未跑/.test(n)));
});

test("matrix scrubWith:已知密钥值精确抹掉 + 通用 Bearer / query token / 签名 URL 脱敏", () => {
  const key = "sk-live-ABCDEF0123456789";
  const msg = `401 from https://api.example.com/v1/chat?api_key=${key}&sig=zzz  Authorization: Bearer ${key}  raw ${key} tail`;
  const out = scrubWith([key], msg);
  assert.ok(!out.includes(key), out);
  assert.ok(out.includes("***"));
  assert.ok(!/sig=zzz/.test(out), "带签名 URL 的 query 被抹掉");
  assert.equal(scrubWith(["short"], "short is gone"), "*** is gone", "短值也抹(已知密钥不论长短)");
  assert.equal(scrubWith([""], "empty keeps"), "empty keeps");
});

test("solidPng:合法 PNG(签名 / CRC / 尺寸 / 像素)", () => {
  const png = solidPng(4, 3, [220, 20, 20]);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let i = 8; const types: string[] = [];
  while (i < png.length) {
    const n = png.readUInt32BE(i); const type = png.subarray(i + 4, i + 8).toString("ascii"); const data = png.subarray(i + 8, i + 8 + n);
    assert.equal(png.readUInt32BE(i + 8 + n), zlib.crc32(png.subarray(i + 4, i + 8 + n)), `${type} CRC`);
    if (type === "IHDR") { assert.equal(data.readUInt32BE(0), 4); assert.equal(data.readUInt32BE(4), 3); }
    if (type === "IDAT") { const raw = zlib.inflateSync(data); assert.equal(raw.length, 3 * (1 + 4 * 3)); assert.deepEqual([...raw.subarray(1, 4)], [220, 20, 20]); }
    types.push(type); i += 12 + n;
  }
  assert.deepEqual(types, ["IHDR", "IDAT", "IEND"]);
});

const FAKE_KEY = "sk-test-matrix-0123456789abcdef";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 端到端:对本地假端点真跑 runMatrix。盯三件事 ——
 * 工具结果按 tool_call_id 喂回、模型回复**原样**放回历史(reasoning_content 不丢)、密钥不进任何落盘文件。
 */
test("runMatrix 对假端点:工具往返、原样回填历史、schema 请求与产品同形、密钥不落盘", async () => {
  const seen = { toolFedBack: false, reasoningKept: false, schemaStrictFalse: false, toolChoiceAuto: false, auth: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.auth ||= req.headers.authorization === `Bearer ${FAKE_KEY}`;
      const r = JSON.parse(body) as { messages: { role: string; content?: unknown; tool_call_id?: string; reasoning_content?: string; tool_calls?: unknown[] }[]; tools?: unknown[]; tool_choice?: string; response_format?: { json_schema?: { strict?: boolean } } };
      const first = String(r.messages.find((m) => m.role === "user")?.content ?? "");
      const send = (message: Record<string, unknown>, finish = "stop") => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...message }, finish_reason: finish }] }));
      };
      if (Array.isArray(r.messages.find((m) => m.role === "user")?.content)) {
        // ⑩ 图片:端点拒绝,并在错误里回显密钥 —— 落盘前必须被抹掉
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `image input not supported for key ${FAKE_KEY}` } }));
      } else if (r.response_format) {
        seen.schemaStrictFalse = r.response_format.json_schema?.strict === false;
        send({ content: '{"answer":"vra","n":42}' });
      } else if (first.includes("echo_text")) {
        seen.toolChoiceAuto = r.tool_choice === "auto";
        const tool = r.messages.find((m) => m.role === "tool");
        if (!tool) return send({ content: null, reasoning_content: "先调工具", tool_calls: [{ id: "call_e1", type: "function", function: { name: "echo_text", arguments: '{"text":"hello-tool-4412"}' } }] }, "tool_calls");
        seen.toolFedBack = tool.tool_call_id === "call_e1" && String(tool.content).includes("hello-tool-4412");
        seen.reasoningKept = r.messages.some((m) => m.role === "assistant" && m.reasoning_content === "先调工具" && Array.isArray(m.tool_calls));
        send({ content: "工具返回 hello-tool-4412" });
      } else send({ content: "vra-ok-7731" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-matrix-"));
  try {
    fs.mkdirSync(path.join(dataRoot, "providers"));
    fs.writeFileSync(path.join(dataRoot, "providers/matrix-fixture.json"), JSON.stringify({
      id: "matrix-fixture", name: "Fixture only", base_url: baseURL, env_key: "MATRIX_FIXTURE_KEY", default_model: "fixture-model",
    }));
    const r = await runMatrix({ provider: "matrix-fixture", tests: [1, 2, 8, 10], repoRoot: REPO, timeoutMs: 5_000,
      env: { VRA_DATA_ROOT: dataRoot, MATRIX_FIXTURE_KEY: FAKE_KEY } });
    assert.deepEqual(r.cases.map((c) => [c.no, c.verdict]), [[1, "pass"], [2, "pass"], [8, "pass"], [10, "error"]]);
    assert.deepEqual(seen, { toolFedBack: true, reasoningKept: true, schemaStrictFalse: true, toolChoiceAuto: true, auth: true });
    assert.equal(r.suggestion.supported, false, "核心项没跑全,不能建议 supported");
    assert.equal(r.suggestion.structured_output, "server_schema");
    assert.ok(r.dir.startsWith(path.join(dataRoot, "provider-matrix", "matrix-fixture")));
    for (const f of ["results.json", "summary.md"]) {
      const text = fs.readFileSync(path.join(r.dir, f), "utf8");
      assert.ok(!text.includes(FAKE_KEY), `${f} 不得含密钥`);
    }
    assert.match(fs.readFileSync(path.join(r.dir, "summary.md"), "utf8"), /图片输入 \| error/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("runMatrix:key 只从模板声明的环境变量读,缺了直接报错、不发请求", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-matrix-"));
  try {
    fs.mkdirSync(path.join(dataRoot, "providers"));
    fs.writeFileSync(path.join(dataRoot, "providers/matrix-fixture.json"), JSON.stringify({
      id: "matrix-fixture", name: "Fixture only", base_url: "https://api.example.invalid/v1", env_key: "MATRIX_FIXTURE_KEY", default_model: "m",
    }));
    await assert.rejects(runMatrix({ provider: "matrix-fixture", repoRoot: REPO, env: { VRA_DATA_ROOT: dataRoot } }), /缺少环境变量 MATRIX_FIXTURE_KEY/);
    await assert.rejects(runMatrix({ provider: "matrix-fixture", repoRoot: REPO, baseURL: "http://api.example.com/v1", env: { VRA_DATA_ROOT: dataRoot, MATRIX_FIXTURE_KEY: "k" } }), /HTTPS/);
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("矩阵命令行:带了参数却没给值、测试编号无效、超时不是正数,一律在建目录、发请求之前报错", async () => {
  assert.equal(matrixOptionsFromArgs(parseArgs([])), null, "没给 --provider 打用法");
  for (const [argv, re] of [
    [["--provider"], /--provider 需要一个值/],
    [["--provider", "x", "--model"], /--model 需要一个值/],
    [["--provider", "x", "--model="], /--model 需要一个值/],
    [["--provider", "x", "--base-url", "--tests", "1"], /--base-url 需要一个值/],
    [["--provider", "x", "--tests", "11"], /--tests 只收 1-10/],
    [["--provider", "x", "--tests", "1,abc"], /--tests 只收 1-10/],
    [["--provider", "x", "--timeout-min=0"], /--timeout-min 需要大于 0 的数字/],
  ] as const) assert.throws(() => matrixOptionsFromArgs(parseArgs([...argv])), re, argv.join(" "));
  assert.deepEqual(matrixOptionsFromArgs(parseArgs(["--provider", "x", "--model", "m", "--tests", "1, 8", "--timeout-min", "1.5"])),
    { provider: "x", model: "m", baseURL: undefined, tests: [1, 8], timeoutMs: 90_000 });
  // 程序化调用同样不许把空模型当成"用模板默认"(Codex 复审 R3-1)
  await assert.rejects(runMatrix({ provider: "matrix-fixture", model: "  ", repoRoot: REPO }), /--model 需要一个值/);
});
