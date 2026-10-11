import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ChartPalette } from "../src/verticals/finance/lib/backtestView.ts";
import { EVENT_BENCHMARK, eventContextText, eventDateLabel, eventFlags, eventKindsFor, eventOption, parseEvents, summaryRows, type EventView } from "../src/verticals/finance/lib/eventStudyView.ts";

const P: ChartPalette = {
  text: "T", grid: "G", axis: "A", strong: "S", primary: "P", benchmark: "B",
  rise: "RED", fall: "GREEN", neutral: "N", tooltipBg: "TB", tooltipText: "TT",
};
type Obj = Record<string, any>;

const HORIZONS = [
  { key: "pre", from: -5, to: -1, label: "事件前 5 日" },
  { key: "d0_1", from: 0, to: 1, label: "第 0–1 日" },
  { key: "d0_5", from: 0, to: 5, label: "第 0–5 日" },
  { key: "d0_20", from: 0, to: 20, label: "第 0–20 日" },
];
const stats = (n: number, mean: number | null, median: number | null = mean, pos: number | null = 0.5) => ({ n, mean, median, positive_share: pos });
const offsets = Array.from({ length: 26 }, (_, i) => i - 5);

function toolResult(over: Obj = {}): Obj {
  return {
    ok: true,
    result: {
      symbol: "600519.SH", kind: "earnings_forecast", kind_label: "业绩预告", benchmark_label: "沪深300指数",
      window: { pre: 5, post: 20 }, min_events: 8, horizons: HORIZONS,
      events: [
        { date: "2025-01-03", day0: "2025-01-03", label: "2024 年年报预告", detail: "略增，归母净利润同比 +14.67%", direction: "up",
          pre: 0.0142, d0_1: -0.019, d0_5: -0.0121, d0_20: null, halted_days: 0, days_after: 12, overlaps_prev: false },
        { date: "2023-12-30", day0: "2024-01-02", label: "2023 年年报预告", detail: "略增", direction: "up",
          pre: 0.0051, d0_1: -0.003, d0_5: -0.009, d0_20: -0.0112, halted_days: 2, days_after: 20, overlaps_prev: true },
        { date: "bad", label: "没有第 0 天的不要" },
      ],
      gaps: [{ date: "2004-03-12", label: "2003 年年报预告", reason: "对照指数在事件前不够 6 个交易日" }, { date: null, label: "业绩预告", reason: "有 1 条没有公告日，没算进来" }, { label: "缺原因" }],
      summary: [
        { key: "all", label: "全部", events: 17, horizons: { pre: stats(17, -0.0102, 0.0048, 0.59), d0_1: stats(17, -0.0104), d0_5: stats(17, -0.0114), d0_20: stats(7, null, null, null) }, note: null },
        { key: "up", label: "预告向好（预增、略增、扭亏、减亏）", events: 17, horizons: { pre: stats(17, -0.0102) }, note: null },
        { key: "down", label: "预告向差（预减、略减、首亏、增亏）", events: 3, horizons: { pre: stats(3, null, null, null) }, note: "能算的只有 3 次（不到 8 次），不给平均，只看上面逐次的结果" },
      ],
      notes: ["超额收益 = …", "只是这只股票过去的情况，不代表下一次会怎样，也不是买卖提示"],
      sources: ["baostock 前复权日线", "东方财富", "腾讯 K 线"],
      ui_only: { path: { offsets, n: 9, mean: offsets.map((o) => o / 1000), median: offsets.map((o) => (o === 3 ? null : o / 2000)) } },
      ...over,
    },
  };
}

const view = (over: Obj = {}): EventView => {
  const r = parseEvents(toolResult(over));
  assert.ok(r.ok);
  return r.view;
};

test("解析：字段照抄工具输出，没有第 0 天的事件和没有原因的缺口丢掉", () => {
  const v = view();
  assert.equal(v.symbol, "600519.SH");
  assert.equal(v.kindLabel, "业绩预告");
  assert.equal(v.benchmarkLabel, "沪深300指数");
  assert.deepEqual([v.pre, v.post, v.minEvents], [5, 20, 8]);
  assert.deepEqual(v.horizons.map((h) => h.key), ["pre", "d0_1", "d0_5", "d0_20"]);
  assert.equal(v.events.length, 2);
  const [a, b] = v.events;
  assert.deepEqual(a!.values, { pre: 0.0142, d0_1: -0.019, d0_5: -0.0121, d0_20: null }, "没满 20 日的那档是空，不是 0");
  assert.equal(a!.direction, "up");
  assert.deepEqual([b!.date, b!.day0, b!.haltedDays, b!.daysAfter, b!.overlapsPrev], ["2023-12-30", "2024-01-02", 2, 20, true]);
  assert.deepEqual(v.gaps.map((g) => g.date), ["2004-03-12", null]);
  const all = v.summary[0]!;
  assert.deepEqual(all.horizons.pre, { n: 17, mean: -0.0102, median: 0.0048, positiveShare: 0.59 });
  assert.deepEqual(all.horizons.d0_20, { n: 7, mean: null, median: null, positiveShare: null }, "工具不给平均就是空");
  assert.deepEqual(v.summary[1]!.horizons.d0_1, { n: 0, mean: null, median: null, positiveShare: null }, "工具没给的那档也是空");
  assert.equal(v.summary[2]!.note, "能算的只有 3 次（不到 8 次），不给平均，只看上面逐次的结果");
  assert.deepEqual(v.sources, ["baostock 前复权日线", "东方财富", "腾讯 K 线"]);
  assert.equal(v.path!.n, 9);
  assert.equal(v.path!.median[8], null);
});

test("解析：路径长度对不上、没有 ui_only 都不画；工具失败把原因带出来", () => {
  assert.equal(view({ ui_only: undefined }).path, null);
  assert.equal(view({ ui_only: { path: null } }).path, null);
  assert.equal(view({ ui_only: { path: { offsets, n: 9, mean: [0.1], median: offsets.map(() => 0) } } }).path, null);
  assert.equal(view({ ui_only: { path: { offsets: [0], n: 9, mean: [0], median: [0] } } }).path, null, "一个点画不成线");
  assert.equal(view({ ui_only: { path: { offsets: [0, "1"], n: 9, mean: [0, 0], median: [0, 0] } } }).path, null);
  assert.equal(view({ ui_only: { path: { offsets: [0, 1, "2"], n: 9, mean: [0, 0], median: [0, 0] } } }).path, null, "横轴有坏值就整条不画，不悄悄错位");
  assert.deepEqual(parseEvents({ ok: false, error: "只做 A 股" }), { ok: false, error: "只做 A 股" });
  assert.deepEqual(parseEvents({ ok: false }), { ok: false, error: "事件回看工具没有说明原因" });
  assert.deepEqual(parseEvents(null), { ok: false, error: "事件回看工具没有返回结果" });
  assert.deepEqual(parseEvents({ ok: true, result: [] }), { ok: false, error: "事件回看工具的结果看不懂" });
});

test("汇总：和「全部」次数一样的组不重复列", () => {
  const { rows, sameAsAll } = summaryRows(view());
  assert.deepEqual(rows.map((g) => g.key), ["all", "down"]);
  assert.deepEqual(sameAsAll.map((g) => g.key), ["up"]);
  const holders = view({ summary: [{ key: "all", label: "全部", events: 11, horizons: {}, note: null }] });
  assert.deepEqual(summaryRows(holders).rows.map((g) => g.key), ["all"], "只有「全部」一组时它自己不算重复");
  assert.deepEqual(summaryRows(holders).sameAsAll, []);
});

test("逐次提示：停牌、窗口没满、和上一次重叠", () => {
  const [a, b] = view().events;
  assert.deepEqual(eventFlags(a!, 20), ["第 0 天之后只有 12 个交易日，还没满 20 个"]);
  assert.deepEqual(eventFlags(b!, 20), ["窗口里有 2 个交易日没有价格（多半停牌），不进平均", "和上一次的窗口重叠"]);
  assert.deepEqual(eventFlags({ ...a!, daysAfter: 20 }, 20), []);
  assert.deepEqual(eventFlags({ ...a!, daysAfter: -1 }, 20), ["第 0 天之后只有 0 个交易日，还没满 20 个"]);
});

test("图：平均和中位两条线，值不换算；第 0 天画竖线、刻度每 5 日一个", () => {
  assert.equal(eventOption(null, P), null);
  const o = eventOption(view().path, P) as Obj;
  assert.equal(o.xAxis.data[5], "第 0 天");
  assert.equal(o.xAxis.data[0], "前 5 日");
  assert.equal(o.xAxis.data[25], "后 20 日");
  const shown = o.xAxis.data.filter((_: string, i: number) => o.xAxis.axisLabel.interval(i));
  assert.deepEqual(shown, ["前 5 日", "第 0 天", "后 5 日", "后 10 日", "后 15 日", "后 20 日"]);
  assert.deepEqual(o.series.map((s: Obj) => s.name), ["平均", "中位数"]);
  assert.equal(o.series[0].data[25], 0.02, "累计超额收益原样画，不减 1");
  assert.equal(o.series[1].data[8], "-", "中位数缺的那天断开，不画成 0");
  assert.deepEqual(o.series[0].markLine.data, [{ yAxis: 0 }, { xAxis: "第 0 天" }]);
  assert.equal(o.series[0].itemStyle.color, "P");
  assert.equal(o.tooltip.valueFormatter(0.0123), "+1.23%");
  const noZero = eventOption({ offsets: [1, 2], n: 8, mean: [0, 0], median: [0, 0] }, P) as Obj;
  assert.deepEqual(noZero.series[0].markLine.data, [{ yAxis: 0 }]);
});

test("给 AI 的上下文：只有百分比和事实，不给平均的照说，最近几次有上限", () => {
  assert.equal(eventContextText(null), "");
  assert.equal(eventContextText({ ok: false, error: "只做 A 股" }), "事件回看没做成:只做 A 股");
  const t = eventContextText(parseEvents(toolResult()));
  assert.match(t, /^事件回看\(600519\.SH · 业绩预告，每次事件前 5 到后 20 个交易日相对沪深300指数的累计超额收益；只是过去的情况，不预测\):/);
  assert.match(t, /全部 17 次:事件前 5 日 平均 -1\.02%、中位 \+0\.48%、上涨占比 59%\(17 次\)/);
  assert.match(t, /第 0–20 日 不给平均\(能算 7 次\)/);
  assert.match(t, /这 17 次全部是预告向好/);
  assert.ok(!t.includes("预告向好（预增、略增、扭亏、减亏） 17 次"), "和全部一样的组不重复列");
  assert.match(t, /预告向差.* 3 次:.*\(能算的只有 3 次/);
  assert.match(t, /2025-01-03 2024 年年报预告\(略增，归母净利润同比 \+14\.67%\):事件前 5 日 \+1\.42%、第 0–1 日 -1\.90%、第 0–5 日 -1\.21%、第 0–20 日 —;第 0 天之后只有 12 个交易日/);
  const many = toolResult();
  many.result.events = Array.from({ length: 8 }, (_, i) => ({ ...many.result.events[0], date: `2020-01-0${i + 1}`, day0: `2020-01-0${i + 1}` }));
  const m = eventContextText(parseEvents(many));
  assert.match(m, /最近 6 次:/, "默认只给最近 6 次");
  assert.ok(m.includes("2020-01-06") && !m.includes("2020-01-07"));
  const one = eventContextText(parseEvents(toolResult()), 1);
  assert.match(one, /最近 1 次:/);
  assert.ok(!one.includes("2023-12-30"));
  const none = eventContextText(parseEvents(toolResult({ events: [], summary: [], notes: ["这只股票没查到重要股东减持"] })));
  assert.match(none, /\n这只股票没查到重要股东减持$/);
  for (const w of ["买入", "卖出", "建议", "目标价", "评级"]) assert.ok(!t.includes(w), w);
});

test("卡片：点了才跑，按票和事件类型记住结果；三个市场都显示、上下文只拼正在看的这只", () => {
  const card = readFileSync(new URL("../src/verticals/finance/components/EventStudyCard.tsx", import.meta.url), "utf8");
  assert.ok(card.includes('backend.runTool<unknown>("events", { symbol, kind, charts: true }, c.signal)'));
  assert.ok(card.includes("onClick={run}"));
  assert.ok(!/useEffect\([^)]*run\(\)/.test(card), "不自动跑");
  assert.ok(card.includes("const result = state.key === k ? state.result : cached(k);"), "每次渲染按当前这只、这类事件查记住的结果");
  assert.ok(card.includes("if (r.ok) cache.set(key, { at: Date.now(), result: r });"), "失败不记住");
  assert.ok(card.includes("useEffect(() => () => { ctl.current?.abort(); setLoading(null); }, [symbol]);"), "换票作废正在跑的");
  assert.ok(card.includes('v > 0 ? "text-danger" : v < 0 ? "text-success"'), "红涨绿跌");
  const page = readFileSync(new URL("../src/verticals/finance/pages/Research.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("<EventStudyCard symbol={chartSymbol} onData={setEvents} />"));
  assert.ok(!page.includes('=== "CN" && <EventStudyCard'), "不再只给 A 股");
  assert.ok(card.includes("const kind = kinds.some((x) => x.key === picked) ? picked : kinds[0]?.key ?? picked;"), "换到别的市场时不沿用这个市场没有的类型");
  assert.ok(page.includes("events && events.symbol === chartSymbol ? `\\n\\n${eventContextText(events.result)}` : \"\""));
});

test("事件类型按市场给：A 股七类，港美股只有业绩公布；对照随市场换", () => {
  assert.deepEqual(eventKindsFor("CN").map((k) => k.key),
    ["earnings_forecast", "holder_increase", "holder_decrease", "buyback", "survey", "dragon_tiger", "lockup"]);
  assert.deepEqual(eventKindsFor("HK").map((k) => k.key), ["earnings_release"]);
  assert.deepEqual(eventKindsFor("US").map((k) => k.key), ["earnings_release"]);
  assert.deepEqual(eventKindsFor(null), []);
  assert.match(EVENT_BENCHMARK.HK, /盈富/);
  assert.match(EVENT_BENCHMARK.US, /SPY/);
  const hk = parseEvents(toolResult({ symbol: "00700.HK", market: "hk_equity", kind: "earnings_release", kind_label: "业绩公布", benchmark_label: "盈富基金（02800.HK，跟踪恒生指数）" }));
  assert.ok(hk.ok);
  if (hk.ok) {
    assert.equal(hk.view.market, "hk_equity");
    assert.match(eventContextText(hk), /^事件回看\(00700\.HK · 业绩公布，每次事件前 5 到后 20 个交易日相对盈富基金/);
  }
});

test("限售解禁：已经排期的单独列出、进上下文，不算涨跌；逐次表的日期列按类型叫", () => {
  assert.equal(eventDateLabel("dragon_tiger"), "上榜日");
  assert.equal(eventDateLabel("lockup"), "解禁日");
  assert.equal(eventDateLabel("buyback"), "首次公告日");
  assert.equal(eventDateLabel("earnings_release"), "发布日");
  assert.equal(eventDateLabel("nope"), "日期");
  const up = [{ date: "2027-06-23", label: "解禁", detail: "定向增发机构配售股份，实际可流通 5.47 亿股，占总股本 6.39%" }, { date: "", label: "坏的" }, "x"];
  const r = parseEvents(toolResult({ kind: "lockup", kind_label: "限售解禁", upcoming: up }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.view.upcoming, [up[0]], "没有日期的不要");
  const text = eventContextText(r);
  assert.ok(text.endsWith("已经排期、还没到的限售解禁(只列出来，不算涨跌):\n2027-06-23 解禁(定向增发机构配售股份，实际可流通 5.47 亿股，占总股本 6.39%)"));
  // 过去一次都没有、只有排期的
  const none = parseEvents(toolResult({ kind: "lockup", kind_label: "限售解禁", events: [], summary: [], upcoming: up,
    notes: ["这只股票过去没有限售解禁，只有已经排期、还没到的"] }));
  assert.ok(none.ok);
  assert.match(eventContextText(none), /只有已经排期、还没到的\n已经排期、还没到的限售解禁\(只列出来，不算涨跌\):\n2027-06-23 解禁/);
  // 别的类型没有 upcoming 就是空的，上下文不多这一段
  const plain = parseEvents(toolResult());
  assert.ok(plain.ok && plain.view.upcoming.length === 0 && !eventContextText(plain).includes("已经排期"));
  const card = readFileSync(new URL("../src/verticals/finance/components/EventStudyCard.tsx", import.meta.url), "utf8");
  assert.ok(card.includes("<Upcoming v={v} />") && card.includes("{eventDateLabel(v.kind)}"));
  assert.ok(card.includes('className="flex min-w-0 flex-wrap rounded-lg border'), "七个按钮窄屏要能换行");
});
