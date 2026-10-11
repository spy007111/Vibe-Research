import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { chatStream } from "../src/verticals/finance/lib/llm.ts";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import { TIER_PROMPT_RULES, tiersSummary } from "../src/verticals/finance/lib/reviewTiers.ts";
import { parseReview, reviewLines } from "../src/verticals/finance/lib/marketReview.ts";

test("全球指数失败进入可见状态与 AI 摘要，不静默消失", async () => {
  const text = fs.readFileSync(new URL("../src/verticals/finance/pages/DailyReview.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("DailyReview.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions = new Map<string, ts.Expression>();
  function visit(n: ts.Node): void {
    if (ts.isVariableDeclaration(n) && n.initializer) expressions.set(n.name.getText(source), n.initializer);
    ts.forEachChild(n, visit);
  }
  visit(source);
  const compile = (name: string) => ts.transpileModule(`(${expressions.get(name)!.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let globalErr: string | null = null;
  let globalDone = false;
  let pageMeta: unknown = { business_date: "2026-09-03" };
  let requests = 0;
  const pageOpts: unknown[] = [];
  let releasePage!: (v: { blocks: never[] }) => void;
  const pagePromise = new Promise<{ blocks: never[] }>(resolve => { releasePage = resolve; });
  const fetchingRef = { current: false };
  const noop = () => {};
  const load = vm.runInNewContext(compile("loadPage"), {
    Error, String, Promise,
    fetchingRef, reviewLoading: false, mode: "live",
    api: { globalIndices: async () => { throw new Error("全球指数未接入"); } },
    backend: { page: (_q: string, opts: unknown) => { requests++; pageOpts.push(opts); return pagePromise; } },
    setGlobalIdx: noop,
    setGlobalDone: (v: boolean) => { globalDone = v; }, setGlobalErr: (v: string | null) => { globalErr = v; },
    setPageErr: noop, setPageMeta: (v: unknown) => { pageMeta = v; }, setOvDone: noop,
  }) as (refresh?: boolean, view?: string) => Promise<void>;
  const first = load();
  assert.equal(pageMeta, null, "刷新开始必须撤下旧业务日，不能等新请求返回才清理");
  await load();
  assert.equal(requests, 1, "前一轮尚未结束时重复刷新不能叠加请求");
  releasePage({ blocks: [] });
  await first;
  assert.equal(fetchingRef.current, false, "各请求结束后可以重新刷新");
  assert.equal(JSON.stringify(pageOpts[0]), JSON.stringify({ mode: "live" }), "默认看今天:盘中打开就是此刻的市场");
  await load(true, "close");
  assert.equal(JSON.stringify(pageOpts[1]), JSON.stringify({ refresh: true }), "切到上一个交易日 = 不带 mode;刷新带 refresh");
  assert.equal(globalDone, true);
  assert.match(globalErr!, /全球指数未接入/);
  const summaryCtx = {
    pageMeta: null, globalIdx: [], globalErr, globalDone, dataReady: true, ovDone: true, pageErr: null,
    ctx: undefined, R: parseReview(null), reviewLines, bizDay: null, tiers: null, tiersErr: "", tiersSummary,
  };
  const summary = vm.runInNewContext(compile("dataSummary"), summaryCtx);
  assert.match(summary, /【海外指数】.*未接入/);
  assert.match(summary, /【缺口】这一屏没取到/, "整屏没取到要写缺口,不能留空");

  // 有这一屏时:各块的事实行 + 没取到的块写缺口 + 换了备源的块写口径
  const meta = {
    query: "review", title: "每日复盘", mixed_ages: false,
    context: { review_date: "2026-10-08", review_reason: "收盘后", session_phase: "closed", live: false, live_available: false, realtime_matches_review_day: true },
    blocks: [
      { id: "margin", title: "两融余额", status: "failed", error: "上交所接口超时" },
      { id: "board_flow", title: "板块资金", status: "ok", note: "净额口径", via_fallback: { note: "东财没取到,换新浪行业资金流", primary_status: "failed" },
        envelope: { status: "ok", evidence: [] } },
    ],
  };
  const s2 = vm.runInNewContext(compile("dataSummary"), { ...summaryCtx, pageMeta: meta, ctx: meta.context, R: parseReview(meta as never), bizDay: "2026-10-08" });
  assert.match(s2, /【业务日】2026-10-08/);
  assert.match(s2, /【缺口】两融余额 这次没取到/);
  assert.match(s2, /【备用来源·板块资金】东财没取到,换新浪/);
  assert.match(s2, /【读法·板块资金】净额口径/);
  assert.doesNotMatch(text, /\{globalIdx\.length > 0 &&\s*\(/, "面板不再以有数据为显示前提；状态标签仍可以检查数据是否为空");
});

test("复盘按钮通过真实 chatStream 发出一次页面数据，并保留业务日、缺口与读法", async () => {
  // 执行页面本身的回调，避免在测试中重抄一份提示词而掩盖调用方回归。
  const source = ts.createSourceFile("DailyReview.tsx", fs.readFileSync(new URL(
    "../src/verticals/finance/pages/DailyReview.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks: ts.Expression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runReview" && node.initializer) callbacks.push(node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(callbacks.length, 1);
  const compiled = ts.transpileModule(`(${callbacks[0]!.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const summary = "业务日：2026-09-04\n上涨：1234家\n【缺口】资金流未取到\n【读法·行情】样本范围受限";
  const messages: string[] = [];
  const errors: unknown[] = [];
  const loading: boolean[] = [];
  const days: unknown[] = [];
  const original = backend.chat;
  backend.chat = async (message) => {
    messages.push(message);
    return { reply: "客观复盘", redacted: 0 } as Awaited<ReturnType<typeof backend.chat>>;
  };
  try {
    const run = vm.runInNewContext(compiled, {
      dataSummary: summary, hasLlm: () => true, chatStream, TIER_PROMPT_RULES,
      dataReady: true, fetchingRef: { current: false }, reviewLoading: false,
      setReviewErr: (error: unknown) => errors.push(error), setNeedConfig: () => {},
      setReviewLoading: (value: boolean) => loading.push(value), setReview: () => {},
      bizDay: "2026-10-09", setReviewDay: (d: unknown) => days.push(d),
    }) as () => Promise<void>;
    await run();
    assert.deepEqual(errors, [null]);
    assert.deepEqual(loading, [true, false]);
    assert.deepEqual(days, ["2026-10-09"], "记下这份复盘按哪个业务日写的");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.split(summary).length - 1, 1, "页面摘要在最终消息里只能出现一次");
    assert.match(messages[0]!, /不要就它下任何结论/);
    assert.match(messages[0]!, /引用数字时带上它的读法护栏/);
    assert.equal(messages[0]!.split(TIER_PROMPT_RULES).length - 1, 1, "分档顺序和写法要求在提示词里");
  } finally { backend.chat = original; }
});

test("加载中或刷新当帧不能发起复盘；全部结束后可分析带缺口的快照", async () => {
  const text = fs.readFileSync(new URL("../src/verticals/finance/pages/DailyReview.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("DailyReview.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions = new Map<string, ts.Expression>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer) expressions.set(node.name.getText(source), node.initializer);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const compile = (key: string) => ts.transpileModule(`(${expressions.get(key)!.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [dataReady, fetching, reviewing] of [[false, true, false], [true, true, false], [true, false, true], [true, false, false]]) {
    let sent = 0;
    const noop = () => {};
    const run = vm.runInNewContext(compile("runReview"), {
      dataReady, fetchingRef: { current: fetching }, reviewLoading: reviewing,
      hasLlm: () => true, dataSummary: "【缺口】资金未取得", chatStream: async () => { sent++; }, TIER_PROMPT_RULES,
      setReviewErr: noop, setNeedConfig: noop, setReviewLoading: noop, setReview: noop, bizDay: "2026-10-09", setReviewDay: noop,
    }) as () => Promise<void>;
    await run();
    assert.equal(sent, dataReady && !fetching && !reviewing ? 1 : 0);
  }
  const flags = { globalDone: true, ovDone: true, tiersReady: true };
  for (const key of Object.keys(flags)) {
    assert.equal(vm.runInNewContext(compile("dataReady"), { ...flags, [key]: false }), false, key);
  }
  assert.equal(vm.runInNewContext(compile("dataReady"), flags), true);
  // 分档:有业务日时等那一天的取完;业务日没拿到时跟着页面那块走
  const tr = (ctx: Record<string, unknown>) => vm.runInNewContext(compile("tiersReady"), ctx);
  assert.equal(tr({ bizDay: "2026-10-08", tiersFor: "2026-10-08", ovDone: true }), true);
  assert.equal(tr({ bizDay: "2026-10-08", tiersFor: "2026-09-30", ovDone: true }), false, "上一轮别的日子的分档不算");
  assert.equal(tr({ bizDay: "2026-10-08", tiersFor: null, ovDone: true }), false);
  assert.equal(tr({ bizDay: null, tiersFor: null, ovDone: true }), true);
  assert.equal(tr({ bizDay: null, tiersFor: null, ovDone: false }), false);
  assert.match(text, /disabled=\{reviewLoading \|\| !dataReady\}/);
});
