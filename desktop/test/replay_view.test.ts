import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ChartPalette } from "../src/verticals/finance/lib/backtestView.ts";
import { parseReplay, replayContextText, replayOption } from "../src/verticals/finance/lib/replayView.ts";

const P: ChartPalette = {
  text: "T", grid: "G", axis: "A", strong: "S", primary: "P", benchmark: "B",
  rise: "RED", fall: "GREEN", neutral: "N", tooltipBg: "TB", tooltipText: "TT",
};
type Obj = Record<string, any>;

const stats = (ret: number, mdd: number, worst: number) => ({
  return: ret, max_drawdown: mdd, max_drawdown_peak: "2015-06-08", max_drawdown_trough: "2015-07-08", worst_day: worst, worst_day_date: "2015-06-26",
});

function toolResult(over: Obj = {}): Obj {
  return {
    ok: true,
    result: {
      min_coverage: 0.5,
      gaps: [{ symbol: "00700.HK", name: "腾讯控股", reason: "没有市值（现价没取到），不知道占多少，没放进回放" }],
      groups: [{
        market: "a_share", currency: "CNY", label: "A 股 · 人民币", total_value: 200000, positions_input: 2, benchmark_label: "沪深300指数",
        notes: ["按现在的持仓比例回看这几段历史行情，不是你当时的真实持仓，也不预测下一次会怎样"], sources: ["baostock_kline", "tx_kline"],
        scenarios: [
          {
            id: "cn_2015", label: "2015 年 6–8 月大跌", start: "2015-06-08", end: "2015-08-26", unavailable: null,
            benchmark: { ...stats(-0.435, -0.45, -0.08), first_date: "2015-06-08", last_date: "2015-08-26" }, benchmark_error: null,
            portfolio: { ...stats(-0.3, -0.38, -0.09), value_change: -36000, included_value: 120000, first_date: "2015-06-08", last_date: "2015-08-26", days: 57 },
            portfolio_note: "权重只在这段时期有价格的 1 只之间分配（占这一组市值的 60%）",
            holdings: [{ symbol: "600519", name: "贵州茅台", weight: 1, return: -0.3, contribution: -0.3, first_date: "2015-06-08", last_date: "2015-08-26", halted_days: 0 }],
            gaps: [{ symbol: "300308", name: "中际旭创", reason: "这段时期开始时还没有价格（最早的价格在 2017-06-01），可能当时还没上市" }],
            coverage: 0.6, positions_included: 1,
          },
          {
            id: "cn_2016", label: "2016 年初熔断", start: "2015-12-22", end: "2016-01-28", unavailable: null,
            benchmark: null, benchmark_error: "对照指数这段时期开始时还没有价格",
            portfolio: null, portfolio_note: "这段时期有价格的持仓只占这一组市值的 40%（不到一半），组合数字没有代表性，不给，只列各只的涨跌",
            holdings: [], gaps: [], coverage: 0.4, positions_included: 1,
          },
          {
            id: "cn_old", label: "很早的一段", start: "2008-01-01", end: "2008-10-01", unavailable: "这段时期取不到",
            benchmark: null, benchmark_error: null, portfolio: null, portfolio_note: null, holdings: [], gaps: [], coverage: null, positions_included: 0,
          },
        ],
      }],
      ui_only: { paths: { CNY: {
        cn_2015: { dates: ["2015-06-08", "2015-06-09", "2015-06-10"], portfolio: [1, 0.95, 0.7], benchmark: [1, null, 0.6] },
        cn_2016: { dates: ["2015-12-22", "2015-12-23"], portfolio: null, benchmark: [1, 0.9] },
      } } },
      ...over,
    },
  };
}

test("情景回放解析:字段原样取、没有的是 null;路径按币种和时期对上;工具说做不了就带原因", () => {
  const r = parseReplay(toolResult());
  assert.ok(r.ok);
  const g = r.view.groups[0]!;
  assert.deepEqual([g.currency, g.benchmarkLabel, g.input, g.totalValue, g.sources], ["CNY", "沪深300指数", 2, 200000, ["baostock_kline", "tx_kline"]]);
  const [a, b, old] = g.scenarios;
  assert.deepEqual([a!.portfolio!.ret, a!.portfolio!.maxDrawdown, a!.portfolio!.worstDay, a!.portfolio!.valueChange, a!.portfolio!.days], [-0.3, -0.38, -0.09, -36000, 57]);
  assert.deepEqual([a!.portfolio!.mddPeak, a!.portfolio!.mddTrough, a!.portfolio!.worstDayDate], ["2015-06-08", "2015-07-08", "2015-06-26"]);
  assert.deepEqual([a!.benchmark!.ret, a!.coverage, a!.included], [-0.435, 0.6, 1]);
  assert.deepEqual(a!.holdings[0], { symbol: "600519", name: "贵州茅台", weight: 1, ret: -0.3, contribution: -0.3, firstDate: "2015-06-08", lastDate: "2015-08-26", haltedDays: 0 });
  assert.equal(a!.gaps[0]!.symbol, "300308");
  assert.deepEqual(a!.path, { dates: ["2015-06-08", "2015-06-09", "2015-06-10"], portfolio: [1, 0.95, 0.7], benchmark: [1, null, 0.6] });
  assert.deepEqual([b!.portfolio, b!.benchmark, b!.benchmarkError], [null, null, "对照指数这段时期开始时还没有价格"], "没给的就是没有,不补 0");
  assert.deepEqual(b!.path, { dates: ["2015-12-22", "2015-12-23"], portfolio: null, benchmark: [1, 0.9] });
  assert.deepEqual([old!.unavailable, old!.path, old!.coverage], ["这段时期取不到", null, null]);
  assert.equal(r.view.gaps[0]!.name, "腾讯控股");
  assert.deepEqual(parseReplay({ ok: false, error: "一次最多回放 60 只" }), { ok: false, error: "一次最多回放 60 只" });
  assert.equal((parseReplay(null) as { error: string }).error, "回放工具没有返回结果");
  // 没带路径(Agent 那条路)照样能解析,只是不画图
  const noPaths = parseReplay(toolResult({ ui_only: undefined }));
  assert.ok(noPaths.ok && noPaths.view.groups[0]!.scenarios.every((s) => s.path === null));
  // 路径长度对不上就不用那条线,不拿错位的数画图
  const bad = parseReplay(toolResult({ ui_only: { paths: { CNY: { cn_2015: { dates: ["a", "b"], portfolio: [1], benchmark: [1, 0.9] } } } } }));
  assert.ok(bad.ok);
  assert.deepEqual(bad.view.groups[0]!.scenarios[0]!.path, { dates: ["a", "b"], portfolio: null, benchmark: [1, 0.9] });
  // 只有一天的路径画不成线
  const one = parseReplay(toolResult({ ui_only: { paths: { CNY: { cn_2015: { dates: ["a"], portfolio: [1], benchmark: [1] } } } } }));
  assert.ok(one.ok && one.view.groups[0]!.scenarios[0]!.path === null);
  // 停牌天数没给按 0;路径按各组自己的币种取,不串组
  const base = toolResult();
  const cny = base.result.groups[0];
  const usd = { ...cny, currency: "USD", label: "美股 · 美元", scenarios: [{ ...cny.scenarios[0], holdings: [{ symbol: "AAPL", name: "苹果", weight: 1, return: -0.2, contribution: -0.2, first_date: "2015-06-08", last_date: "2015-08-26" }] }] };
  const hkd = { ...cny, currency: "HKD", label: "港股 · 港元" };
  const two = parseReplay({ ok: true, result: { ...base.result, groups: [cny, usd, hkd], ui_only: { paths: { ...base.result.ui_only.paths, USD: { cn_2015: { dates: ["x", "y"], portfolio: [1, 1.1], benchmark: null } } } } } });
  assert.ok(two.ok);
  assert.equal(two.view.groups[1]!.scenarios[0]!.holdings[0]!.haltedDays, 0);
  assert.deepEqual(two.view.groups[0]!.scenarios[0]!.path!.dates, ["2015-06-08", "2015-06-09", "2015-06-10"]);
  assert.deepEqual(two.view.groups[1]!.scenarios[0]!.path, { dates: ["x", "y"], portfolio: [1, 1.1], benchmark: null });
  assert.ok(two.view.groups[2]!.scenarios.every((s) => s.path === null), "这一组没带路径就不画图,不借别的组的");
});

test("情景回放走势图:两条线都从 0% 起步、只画百分比;缺的点留空不画成 0", () => {
  const r = parseReplay(toolResult());
  assert.ok(r.ok);
  const [a, b, old] = r.view.groups[0]!.scenarios;
  const o = replayOption(a!, "沪深300指数", P) as Obj;
  assert.equal(o.series.length, 2);
  assert.deepEqual(o.series[0].data.map((x: number) => Math.round(x * 1e6) / 1e6), [0, -0.05, -0.3]);
  assert.equal(o.series[0].lineStyle.color, "P");
  assert.deepEqual([o.series[1].name, o.series[1].lineStyle.type], ["沪深300指数", "dashed"]);
  assert.deepEqual(o.series[1].data.map((x: number | string) => (typeof x === "number" ? Math.round(x * 1e6) / 1e6 : x)), [0, "-", -0.4]);
  assert.deepEqual(o.series[0].markLine.data, [{ yAxis: 0 }]);
  assert.equal(o.tooltip.valueFormatter(-0.3), "-30.00%");
  const onlyBench = replayOption(b!, "沪深300指数", P) as Obj;
  assert.deepEqual(onlyBench.series.map((s: Obj) => s.name), ["沪深300指数"], "组合数字没给时只画对照");
  assert.equal(replayOption(old!, "沪深300指数", P), null);
});

test("情景回放给 AI 的上下文:只给百分比和覆盖,不给金额、不评好坏、写明不是当时的真实持仓", () => {
  const text = replayContextText(parseReplay(toolResult()));
  assert.match(text, /按现在的持仓比例回看历史大跌期，不是当时的真实持仓，不预测/);
  assert.match(text, /A 股 · 人民币 · 2015 年 6–8 月大跌\(2015-06-08 至 2015-08-26\):组合 -30\.00%、期间最大回撤 -38\.00%、最差单日 -9\.00%;沪深300指数 -43\.50%;有价格的持仓占这一组市值 60%/);
  assert.match(text, /2016 年初熔断.*组合数字没给\(这段时期有价格的持仓只占这一组市值的 40%.*;对照没取到/);
  assert.match(text, /很早的一段:这段时期取不到/);
  assert.doesNotMatch(text, /36000|120000|200000/, "金额不进上下文");
  assert.doesNotMatch(text, /跑赢|跑输|抗跌|建议|加仓|减仓|买入|卖出/);
  assert.equal(replayContextText(null), "");
  assert.equal(replayContextText({ ok: false, error: "超时" }), "历史情景回放没做成:超时");
});

test("情景回放卡:点按钮才跑;金额过隐私遮挡、百分比不遮;红涨绿跌;持仓变了旧结果不给 AI", () => {
  const src = readFileSync(new URL("../src/verticals/finance/components/ScenarioReplay.tsx", import.meta.url), "utf8");
  assert.ok(src.includes('backend.runTool<unknown>("replay", { positions, charts: true }, c.signal)'));
  assert.ok(!/useEffect\(\(\) => \{ run/.test(src), "要取十几年日线,不自动跑");
  assert.ok(src.includes("onClick={x.run}"));
  // 持仓异步加载:第一次渲染时持仓还是空的,只在初始化时查缓存的话回到页面永远查不到
  assert.ok(src.includes("const remembered = current ? null : cached(sig, holdings);"), "每次渲染按当前持仓查记住的结果");
  assert.ok(src.includes("const current = state.result !== null && state.sig === sig && !valuesDrifted(state.values, holdings);"), "市值漂移也算过期");
  assert.ok(src.includes("stale: !remembered && state.result !== null && !current"));
  assert.ok(!/useState<[^>]+>\(\(\) =>/.test(src), "不在初始化里查缓存");
  assert.ok(src.includes("value: h.market_value }));"), "没取到现价的传 null 进缺口,不当 0");
  assert.ok(src.includes("hideIf(hide, moneySigned(p.valueChange))"), "金额要遮");
  assert.ok(src.includes("hideIf(hide, moneySigned(live))"), "按现在市值现算的金额也要遮");
  assert.equal((src.match(/moneySigned\(/g) ?? []).length, (src.match(/hideIf\(hide, moneySigned\(/g) ?? []).length, "金额只在遮挡里用");
  assert.ok(src.includes("v={pctSigned(p.ret)}"), "百分比不遮");
  assert.match(src, /v > 0 \? "text-danger" : v < 0 \? "text-success"/);
  assert.match(src, /A 股要一只一只取/);
  assert.match(src, /不预测，也不给买卖提示/);
  assert.doesNotMatch(src, /抗跌|跑赢|跑输|建议|加仓|减仓|空仓|满仓/);
  const page = readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("<ScenarioReplayCard x={replay} hide={hide} />"));
  assert.ok(page.indexOf("<PortfolioXrayCard") < page.indexOf("<ScenarioReplayCard"), "回放卡放在体检卡下面");
  assert.ok(page.includes('const replayText = replay.stale ? "" : replayContextText(replay.result);'));
  assert.ok(page.includes("[holdingsText, perfText, replayText].filter(Boolean).join"));
});
