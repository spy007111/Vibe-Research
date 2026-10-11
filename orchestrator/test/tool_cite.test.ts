import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CITE_TARGET_HIDDEN, cleanCite, createToolExecutor, type AssistantTool } from "../src/assistant_bridge.ts";
import { assistantTools, serviceContext } from "../src/service.ts";
import "../src/finance/register.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schema = z.object({ q: z.string().max(20) }).strict();

test("来源说明逐项收紧:没名字不记、网址只收 http(s) 且不带账号、条数只收非负整数", () => {
  assert.equal(cleanCite({ target: "x" }), undefined);
  assert.equal(cleanCite("联网搜索"), undefined);
  assert.deepEqual(cleanCite({
    label: " 公告\n标题 ", target: "a".repeat(200), sources: ["szse", "szse", "", 3, "eastmoney"], count: 2.5, partial: "yes", cached: true,
    links: [{ title: "ok", url: "https://example.com/a?b=1" }, { url: "javascript:alert(1)" }, { url: "https://u:p@example.com/" }, { url: "ftp://example.com/" }, null],
  }), {
    label: "公告 标题", target: "a".repeat(120), sources: ["szse", "eastmoney"], cached: true, links: [{ title: "ok", url: "https://example.com/a?b=1" }],
  });
  assert.deepEqual(cleanCite({ label: "x", count: 0, partial: true }), { label: "x", count: 0, partial: true });
  assert.deepEqual(cleanCite({ label: "x", count: -1 }), { label: "x" });
});

test("执行器把来源记进回执:成功、业务失败、执行抛错都记;参数不合法、来源说明自己出错都不记,也不连累调用", async () => {
  const tools: AssistantTool[] = [
    { name: "ok", description: "", schema, run: ({ q }: { q: string }) => ({ rows: [q] }), cite: (a: { q: string }, r: unknown) => ({ label: "数据", target: a.q, count: (r as { rows: unknown[] } | undefined)?.rows.length }) },
    { name: "bad", description: "", schema, run: () => ({ status: "failed" }), cite: (a: { q: string }) => ({ label: "数据", target: a.q }) },
    { name: "boom", description: "", schema, run: () => { throw new Error("down"); }, cite: (a: { q: string }, r: unknown) => ({ label: "数据", target: a.q, count: r === undefined ? 0 : 1 }) },
    { name: "crash", description: "", schema, run: () => ({}), cite: () => { throw new Error("cite bug"); } },
    { name: "plain", description: "", schema, run: () => ({}) },
  ];
  const ex = createToolExecutor(tools, new AbortController().signal);
  await ex.call("ok", { q: "300308" });
  await ex.call("bad", { q: "600519" });
  await ex.call("boom", { q: "000001" });
  await ex.call("ok", { q: 1 });
  const crash = await ex.call("crash", { q: "x" });
  await ex.call("plain", { q: "x" });
  assert.deepEqual(crash.kind === "result" && crash.isError, false);
  assert.deepEqual(ex.receipts.map((r) => [r.name, r.ok, r.cite ?? null]), [
    ["ok", true, { label: "数据", target: "300308", count: 1 }],
    ["bad", false, { label: "数据", target: "600519" }],
    ["boom", false, { label: "数据", target: "000001", count: 0 }],
    ["ok", false, null],
    ["crash", true, null],
    ["plain", true, null],
  ]);
});

test("对话工具的来源:取数写端点名、实际来源、取数时间和条数;没取到时退回注册表来源;元数据类工具不算来源", () => {
  const tools = assistantTools(serviceContext({ repoRoot: repo }), { provider: "cli-claude", model: "", apiKey: "" });
  const by = (n: string) => tools.find((t) => t.name === n)!;
  const cite = (n: string, args: unknown, result?: unknown) => cleanCite(by(n).cite!(by(n).schema.parse(args) as never, result));
  assert.deepEqual(cite("fetch_endpoint", { endpoint: "fetch_announcements", symbol: "300308" }, {
    cached: true, envelope: { symbol: "300308", status: "partial", used_sources: ["eastmoney"], primary_source: "szse", fetched_at: "2026-10-08T15:02:00+08:00", evidence: [{}, {}, {}] },
  }), { label: "公告标题", target: "300308", sources: ["eastmoney"], as_of: "2026-10-08T15:02:00+08:00", count: 3, partial: true, cached: true });
  assert.deepEqual(cite("fetch_endpoint", { endpoint: "fetch_announcements", symbol: "300308" }), { label: "公告标题", target: "300308", sources: ["szse", "eastmoney"] });
  assert.deepEqual(cite("fetch_endpoint", { endpoint: "no_such" }, { envelope: { primary_source: "tencent", symbol: "AAPL" } }), { label: "no_such", target: "AAPL", sources: ["tencent"] });
  assert.deepEqual(cite("search_web", { query: "800G 光模块" }, { results: [{ title: "T", url: "https://a.example/x" }, { title: "坏", url: "file:///etc/passwd" }] }),
    { label: "联网搜索", target: "800G 光模块", count: 2, links: [{ title: "T", url: "https://a.example/x" }] });
  assert.deepEqual(cite("search_web", { query: "q" }), { label: "联网搜索", target: "q" });
  // 来源面板不经过回答的合规检查:模型写的关键词、网页标题自己过一遍
  assert.deepEqual(cite("search_web", { query: "某股 目标价 多少" }, { results: [{ title: "某券商给出目标价", url: "https://a.example/y" }, { title: "公告", url: "https://a.example/z" }] }),
    { label: "联网搜索", target: CITE_TARGET_HIDDEN, count: 2, links: [{ title: "", url: "https://a.example/y" }, { title: "公告", url: "https://a.example/z" }] });
  assert.deepEqual(cite("fetch_endpoint", { endpoint: "建仓建议" }, { envelope: { primary_source: "tencent" } }), { label: "数据工具", sources: ["tencent"] });
  assert.deepEqual(cite("read_web_page", { url: "https://a.example/old" }, { url: "https://a.example/new", fetched_at: "2026-10-08T07:03:00Z", truncated: true }),
    { label: "读取网页", as_of: "2026-10-08T07:03:00Z", partial: true, links: [{ title: "", url: "https://a.example/new" }] });
  assert.deepEqual(cite("run_tool", { name: "calc", input: { fn: "pe_ttm", args: {} } }), { label: "计算工具", target: "calc · pe_ttm" });
  assert.deepEqual(cite("get_evidence", { run_id: "r1" }, { items: [{}, {}] }), { label: "研究证据", target: "r1", count: 2 });
  assert.deepEqual(cite("read_ledger", {}), { label: "你的台账" });
  for (const n of ["list_endpoints", "list_runs", "research_status", "list_tools", "start_research"]) assert.equal(by(n).cite, undefined, n);
});
