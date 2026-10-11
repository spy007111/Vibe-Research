/**
 * 界面查询的两件新事:块的备用端点(fallback)与页面看法(mode)。全程不联网 —— 取数换成假的。
 *
 * 🔴 备源要测的不只是"换上了",还有"什么时候**不许**换":部分成功不换、备源也失败时不拿失败的信封顶替。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { FINANCE_PLUGIN } from "../src/finance/plugin.ts";
import { registerPlugin, resetPlugin, type Plugin, type PageQueryDef } from "../src/plugin.ts";
import { ServiceError, pageQuery, type FetchResult, type ServiceContext } from "../src/service.ts";

const QUERIES: Record<string, PageQueryDef> = {
  t: {
    title: "测试页", intent: "测备源与看法", needsContext: true,
    blocks: [
      { id: "a", title: "成交额榜", endpoint: "em_turnover_rank", args: { top_n: 20 }, fallback: { endpoint: "sina_turnover_rank", args: { top_n: 20 }, note: "备源口径说明:新浪榜单" } },
      { id: "c", title: "情绪", endpoint: "em_limit_up_sentiment", injectContext: true, injectAs: { date_compact: "date" } },
    ],
  },
  plain: { title: "无上下文页", intent: "不解析上下文", blocks: [{ id: "x", title: "x", endpoint: "em_market_breadth" }] },
};

const use = (over: Partial<Plugin> = {}) => { resetPlugin(); registerPlugin({ ...FINANCE_PLUGIN, pageQueries: QUERIES, ...over }); };
after(() => { resetPlugin(); registerPlugin(FINANCE_PLUGIN); });

const CAL = (phase: string) => ({
  status: "ok",
  evidence: [
    { field: "last_trading_day", value: "2026-10-09" },
    { field: "previous_trading_day", value: "2026-10-08" },
    { field: "is_today_trading_day", value: true },
    { field: "session_phase", value: phase },
  ],
});

type Call = { endpoint: string; args?: Record<string, unknown> };
function fakeFetch(plan: Record<string, Record<string, unknown> | Error>, phase = "trading") {
  const calls: Call[] = [];
  const fetch = (async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }): Promise<FetchResult> => {
    calls.push({ endpoint: req.endpoint, args: req.args });
    const r = req.endpoint === "fetch_trade_calendar" ? CAL(phase) : plan[req.endpoint];
    if (r instanceof Error) throw r;
    if (!r) throw new Error(`测试没给 ${req.endpoint}`);
    return { envelope: r, exit_code: 0, out_dir: "", duration_ms: 1, stderr_tail: "", cached: false, fetched_at: "2026-10-09T13:00:00+08:00" };
  }) as never;
  return { calls, fetch };
}
const ctx = {} as ServiceContext;
const OK = { status: "ok", evidence: [{ field: "x", value: 1 }] };

test("主源 failed → 换备源,结果带备源口径与主源原因;块数据是备源的", async () => {
  use();
  const { calls, fetch } = fakeFetch({ em_turnover_rank: { status: "failed", reason: "clist 502" }, sina_turnover_rank: { ...OK, tag: "sina" }, em_limit_up_sentiment: OK });
  const r = await pageQuery(ctx, { query: "t" }, { fetch });
  const a = r.blocks.find((b) => b.id === "a")!;
  assert.equal(a.status, "ok");
  assert.equal((a.envelope as { tag?: string }).tag, "sina");
  assert.deepEqual(a.via_fallback, { note: "备源口径说明:新浪榜单", primary_status: "failed", primary_error: "clist 502" });
  assert.deepEqual(calls.find((c) => c.endpoint === "sina_turnover_rank")?.args, { top_n: 20 }, "备源用自己声明的参数");
  assert.ok(!JSON.stringify(a).includes("sina_turnover_rank"), "结果里不该带端点 id —— 界面不认识端点名");
});

test("主源抛错(missing)→ 换备源,primary_status=missing", async () => {
  use();
  const { fetch } = fakeFetch({ em_turnover_rank: new Error("连接被拒"), sina_turnover_rank: OK, em_limit_up_sentiment: OK });
  const a = (await pageQuery(ctx, { query: "t" }, { fetch })).blocks.find((b) => b.id === "a")!;
  assert.equal(a.status, "ok");
  assert.equal(a.via_fallback?.primary_status, "missing");
  assert.equal(a.via_fallback?.primary_error, "连接被拒");
});

test("🔴 主源 partial 不换 —— 那是主源如实说了缺哪些,换掉等于丢掉它", async () => {
  use();
  const { calls, fetch } = fakeFetch({ em_turnover_rank: { status: "partial", evidence: [] }, sina_turnover_rank: OK, em_limit_up_sentiment: OK });
  const a = (await pageQuery(ctx, { query: "t" }, { fetch })).blocks.find((b) => b.id === "a")!;
  assert.equal(a.status, "partial");
  assert.equal(a.via_fallback, undefined);
  assert.ok(!calls.some((c) => c.endpoint === "sina_turnover_rank"), "不该去取备源");
});

test("🔴 备源也失败:仍报主源的状态与原因,另带备源原因 —— 不拿失败的备源信封顶替", async () => {
  use();
  const { fetch } = fakeFetch({ em_turnover_rank: { status: "failed", reason: "主源坏" }, sina_turnover_rank: { status: "failed", missing: [{ reason: "新浪也坏" }] }, em_limit_up_sentiment: OK });
  const a = (await pageQuery(ctx, { query: "t" }, { fetch })).blocks.find((b) => b.id === "a")!;
  assert.equal(a.status, "failed");
  assert.equal((a.envelope as { reason?: string }).reason, "主源坏");
  assert.equal(a.fallback_error, "新浪也坏");
  assert.equal(a.via_fallback, undefined);

  const { fetch: f2 } = fakeFetch({ em_turnover_rank: new Error("主源断"), sina_turnover_rank: new Error("备源断"), em_limit_up_sentiment: OK });
  const b = (await pageQuery(ctx, { query: "t" }, { fetch: f2 })).blocks.find((x) => x.id === "a")!;
  assert.equal(b.status, "missing");
  assert.equal(b.error, "主源断");
  assert.equal(b.fallback_error, "备源断");
});

test("没声明 mode:盘中看上一个交易日;能切到看今天;只给当天的源与业务日不是同一天", async () => {
  use();
  const { calls, fetch } = fakeFetch({ em_turnover_rank: OK, em_limit_up_sentiment: OK });
  const r = await pageQuery(ctx, { query: "t" }, { fetch });
  assert.equal(r.context?.review_date, "2026-10-08");
  assert.equal(r.context?.live, false);
  assert.equal(r.context?.live_available, true);
  assert.equal(r.context?.realtime_matches_review_day, false);
  assert.deepEqual(calls.find((c) => c.endpoint === "em_limit_up_sentiment")?.args, { date: "20261008" });
});

test("mode=live:盘中看今天,注入的日期跟着变,原因句说收盘前还会变", async () => {
  use();
  const { calls, fetch } = fakeFetch({ em_turnover_rank: OK, em_limit_up_sentiment: OK });
  const r = await pageQuery(ctx, { query: "t", mode: "live" }, { fetch });
  assert.equal(r.context?.review_date, "2026-10-09");
  assert.equal(r.context?.live, true);
  assert.equal(r.context?.realtime_matches_review_day, true);
  assert.match(String(r.context?.review_reason), /收盘前/);
  assert.deepEqual(calls.find((c) => c.endpoint === "em_limit_up_sentiment")?.args, { date: "20261009" });
});

test("mode=live 在盘前不生效(今天还没开始),仍看上一个交易日", async () => {
  use();
  const { fetch } = fakeFetch({ em_turnover_rank: OK, em_limit_up_sentiment: OK }, "pre_open");
  const r = await pageQuery(ctx, { query: "t", mode: "live" }, { fetch });
  assert.equal(r.context?.review_date, "2026-10-08");
  assert.equal(r.context?.live, false);
  assert.equal(r.context?.live_available, false);
});

test("没声明过的 mode、或这一页不解析上下文时给 mode → bad_mode", async () => {
  use();
  const { fetch } = fakeFetch({ em_turnover_rank: OK, em_limit_up_sentiment: OK, em_market_breadth: OK });
  await assert.rejects(() => pageQuery(ctx, { query: "t", mode: "yesterday" }, { fetch }), (e: unknown) => e instanceof ServiceError && e.code === "bad_mode");
  await assert.rejects(() => pageQuery(ctx, { query: "plain", mode: "live" }, { fetch }), (e: unknown) => e instanceof ServiceError && e.code === "bad_mode");
  await assert.rejects(() => pageQuery(ctx, { query: "t", mode: 1 as never }, { fetch }), (e: unknown) => e instanceof ServiceError && e.code === "bad_mode");
  // 空串当没给
  const r = await pageQuery(ctx, { query: "t", mode: "" }, { fetch });
  assert.equal(r.context?.live, false);
});

test("注册期:备源不许与 injectContext / userArgs 同用;modes 形状要对", () => {
  const withBlock = (b: Record<string, unknown>) => ({ ...FINANCE_PLUGIN, pageQueries: { q: { title: "q", intent: "q", blocks: [{ id: "a", title: "a", endpoint: "em_turnover_rank", ...b }] } } }) as Plugin;
  const fb = { endpoint: "sina_turnover_rank", note: "口径说明口径说明" };
  resetPlugin();
  assert.throws(() => registerPlugin(withBlock({ fallback: fb, injectContext: true, injectAs: { date: "date" } })), /备用端点/);
  resetPlugin();
  assert.throws(() => registerPlugin(withBlock({ fallback: fb, userArgs: ["top_n"] })), /备用端点/);
  resetPlugin();
  assert.throws(() => registerPlugin(withBlock({ fallback: { endpoint: "sina_turnover_rank" } })), /note|required/);
  for (const modes of [[], ["Live"], ["live", "live"], "live"]) {
    resetPlugin();
    assert.throws(() => registerPlugin({ ...FINANCE_PLUGIN, pageContext: { ...FINANCE_PLUGIN.pageContext!, modes: modes as never } }), /modes/);
  }
  resetPlugin();
  assert.doesNotThrow(() => registerPlugin(withBlock({ fallback: fb })));
});
