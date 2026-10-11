import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { newAnalysisSession } from "../src/verticals/finance/lib/analysisSession.ts";
import { chatStream } from "../src/verticals/finance/lib/llm.ts";
import { reflectStream } from "../src/verticals/finance/lib/agents.ts";
import { backend } from "../src/verticals/finance/lib/backend.ts";

test("#34 无 randomUUID 环境仍可创建页面分析、记录反思与资料任务标识", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    const sessions = Array.from({ length: 20 }, () => newAnalysisSession("page-analysis"));
    assert.equal(new Set(sessions).size, 20);
    assert.ok(sessions.every((id) => /^[a-z0-9-]{1,64}$/.test(id)));
    assert.match(newAnalysisSession("note-reflection"), /^note-reflection-/);
    const source = readFileSync(new URL("../src/verticals/finance/pages/MyReports.tsx", import.meta.url), "utf8");
    assert.match(newAnalysisSession("report"), /^report-/);
    assert.match(source, /id: newAnalysisSession\("report"\)/);
    assert.doesNotMatch(source, /crypto\.randomUUID/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "crypto", previous);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("每日复盘、赛道分析、记录反思与重复分析都使用独立会话，并转发取消", async () => {
  const original = backend.chat;
  const calls: { message: string; session: string | undefined; signal: AbortSignal | undefined }[] = [];
  backend.chat = async (message, session, signal) => {
    calls.push({ message, session, signal });
    return { reply: "结果", redacted: 0 } as Awaited<ReturnType<typeof backend.chat>>;
  };
  try {
    const ctrl = new AbortController();
    for (const context of ["今日大盘数据", "算力赛道资讯", "今日大盘数据"]) {
      await chatStream([{ role: "user", content: "分析" }], context, {}, ctrl.signal);
    }
    await reflectStream("原文", "记录", {}, ctrl.signal);
    assert.equal(calls.length, 4);
    assert.equal(new Set(calls.map((c) => c.session)).size, 4);
    assert.ok(calls.every((c) => c.signal === ctrl.signal && c.session && c.session !== "default" && c.session.length <= 64));
    assert.match(calls[0]!.message, /今日大盘数据/);
    assert.match(calls[1]!.message, /算力赛道资讯/);
    assert.doesNotMatch(calls[1]!.message, /今日大盘数据/);
    assert.match(calls[3]!.session!, /^note-reflection-/);
    // 推理审计：正文放在页面数据那一段，要求放在问题里（整篇塞进问题，长一点的记录就超过手打问题的 4000 字）
    assert.match(calls[3]!.message, /^【当前页面的数据】\n标题:记录\n\n原文\n\n【问题】\n回头审上面这段/);
    ctrl.abort();
    await reflectStream("取消", "记录", {}, ctrl.signal);
    await assert.rejects(chatStream([{ role: "user", content: "取消" }], "", {}, ctrl.signal), { name: "AbortError" });
    assert.equal(calls.length, 4);
  } finally { backend.chat = original; }
});

test("赛道「今日要点」把资讯放在页面数据那一段，问题里只留要求", () => {
  const intel = readFileSync(new URL("../src/verticals/finance/pages/Intel.tsx", import.meta.url), "utf8");
  assert.match(intel, /chatStream\(\[\{ role: "user", content: prompt \}\], `\$\{ind\.name\}赛道资讯：\\n\$\{ctx\}`/);
  const prompt = intel.slice(intel.indexOf("const prompt ="), intel.indexOf("try {", intel.indexOf("const prompt =")));
  assert.doesNotMatch(prompt, /\$\{ctx\}/, "资讯不再塞进问题");
});
