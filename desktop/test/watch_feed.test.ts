import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { api, ApiError } from "../src/verticals/finance/lib/api.ts";
import { backend, type FetchResult } from "../src/verticals/finance/lib/backend.ts";
import { allFailedMessage, gatherWatchFeed } from "../src/verticals/finance/lib/watchFeed.ts";

test("关注股资讯逐只取：取到空、取失败分开记（审计 C8）", async () => {
  const g = await gatherWatchFeed(["A", "B", "C"], async (c) => {
    if (c === "B") throw new ApiError("服务器开小差", 500);
    return c === "A" ? [1, 2] : [];
  });
  assert.deepEqual(g.got, [{ code: "A", items: [1, 2] }, { code: "C", items: [] }], "C 是真没有");
  assert.deepEqual(g.failed, ["B"]);
  assert.equal((g.errors[0] as Error).message, "服务器开小差");
  const all = await gatherWatchFeed(["A", "B"], async () => { throw new Error("超时"); });
  assert.deepEqual(all.failed, ["A", "B"]);
  assert.equal(allFailedMessage(2, "的公告", all.errors), "关注的 2 只股票的公告都没取到（超时）");
});

test("资讯页：全部没取到当错误（有存档留存档），部分没取到列出缺口；只有真取到空才写「近期暂无」", () => {
  const page = readFileSync(new URL("../src/verticals/finance/pages/Intel.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/if \(g\.failed\.length === cs\.length\) throw new Error\(allFailedMessage/g) ?? []).length, 2, "公告、新闻都要");
  assert.ok(!/\.catch\(\(\) => \(\{ c, a: \[\]/.test(page), "不再把失败吞成空数组");
  assert.match(page, /另有 \{failed\.length\} 只这次没取到\{what\}/);
  assert.match(page, /取到的 \$\{codes\.length - failed\.length\} 只/);
  assert.match(page, /cur\.error\s*\n?\s*\? <p[^>]*>这个赛道这次没取到/);
  assert.match(page, /\) : err && !data \? null : rows\.length === 0 \? \(/, "全部没取到、没有存档时不写「近期暂无」（审计第二轮 C8）");
  assert.match(page, /另有 \{cur\.failedSources\} 个来源这次没取到/);
});

test("🔴 产业资讯：来源故障在**成功返回的信封**里（extra.failures）——全部挂了算没取到，部分挂了记个数（审计第二轮 C8）", async () => {
  const original = backend.fetch;
  const fail = [{ source: "a", error: "timeout" }, { source: "b", error: "502" }];
  const item = { id: "ev-1", field: "news_title", value: "标题", unit: "text", period: "2026-10-09", note: "source=a;link=https://x/1", record_key: "x1" };
  const okCount = (n: number) => ({ id: "ev-ok", field: "rss_sources_ok", value: n, unit: "个", period: "2026-10-09" });
  backend.fetch = async (_e, opts) => {
    const ind = (opts as { args: { industry: string } }).args.industry;
    const extra = ind === "ai" ? { industries: [{ key: "ai", name: "AI" }, { key: "chip", name: "芯片" }, { key: "ev", name: "新能源车" }], failures: fail } : ind === "chip" ? { failures: fail } : { failures: [] };
    const evidence = ind === "ai" ? [okCount(0)] : ind === "chip" ? [okCount(1), item] : [okCount(2)];
    return { cached: false, fetched_at: "2026-10-09T00:00:00Z", envelope: { evidence, errors: [], extra } } as unknown as FetchResult;
  };
  try {
    const r = await api.radar();
    const [ai, chip, ev] = r.industries;
    assert.match(ai!.error ?? "", /2 个来源都没取到（timeout）/, "全部来源都挂了：当没取到，不是「暂无更新」");
    assert.equal(chip!.error, undefined);
    assert.equal(chip!.failedSources, 2, "部分挂了：有条目，另记几个来源没取到");
    assert.equal(ev!.error, undefined, "来源都通、真没有条目：照常「暂无更新」");
    assert.equal(ev!.failedSources, undefined);
  } finally { backend.fetch = original; }
});

test("产业资讯：某个赛道取失败带原因、单独计数，不显示成「暂无更新」", async () => {
  const original = backend.fetch;
  backend.fetch = async (endpoint, opts) => {
    const ind = (opts as { args: { industry: string } }).args.industry;
    if (ind === "chip") throw new ApiError("RSS 超时", 504);
    return { cached: false, fetched_at: "2026-10-09T00:00:00Z", envelope: {
      evidence: [], errors: [], extra: ind === "ai" ? { industries: [{ key: "ai", name: "AI" }, { key: "chip", name: "芯片" }, { key: "ev", name: "新能源车" }] } : {},
    } } as unknown as FetchResult;
  };
  try {
    const r = await api.radar();
    assert.deepEqual(r.industries.map((x) => [x.key, x.total, x.error ?? null]), [["ai", 0, null], ["chip", 0, "RSS 超时"], ["ev", 0, null]]);
    assert.equal(r.stats.failed_industries, 1);
  } finally { backend.fetch = original; }
});
