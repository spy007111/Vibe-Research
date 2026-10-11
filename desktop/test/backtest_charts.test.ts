import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { textOf, withRenderer } from "./helpers/render.ts";

import {
  appendixMarkdown, bootstrapBase, costSummary, points, symmetricMax, equityOption, monthlyOption, parseBacktestView, sensitivityOption, sharePct, underwaterOption, yearlyOption,
  type ChartPalette,
} from "../src/verticals/finance/lib/backtestView.ts";

const P: ChartPalette = {
  text: "T", grid: "G", axis: "A", strong: "S", primary: "P", benchmark: "B",
  rise: "RED", fall: "GREEN", neutral: "N", tooltipBg: "TB", tooltipText: "TT",
};

const N = (v: number | null) => v;
function toolResult(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      benchmark_is_self: false,
      benchmark: { ticker: "INDEX:sh000300", label: "沪深300指数" },
      metrics: { total_return: 0.1 },
      tables: {
        monthly: { years: [2021, 2022], ret: [[...Array(11).fill(null), 0.02], [-0.05, ...Array(11).fill(0)]], bench: null },
        yearly: [{ year: 2021, ret: 0.02, bench: 0.01, excess: 0.01, bars: 5, partial: true },
          { year: 2022, ret: -0.05, bench: null, excess: null, bars: 240, partial: false }],
        drawdowns: [{ start: "2022-01-01", trough: "2022-02-01", end: null, depth: -0.2, bars_to_trough: 20, bars_to_recover: null, bars: 30 }],
      },
      robustness: { bootstrap_sharpe: { ci_lower: -0.1, ci_upper: 1.2, prob_positive: 0.8, confidence: 0.95, n_bootstrap: 1000 },
        segments: { error: "too short" } },
      sensitivity: {
        x: { param: "fast", values: [10, 20, 30] }, y: { param: "slow", values: [20, 60] }, fixed: {}, base: { fast: 20, slow: 60 },
        total_return: [[0.1, null, null], [0.2, -0.3, 0.05]], sharpe: [[1, null, null], [1, -1, 0.2]],
        max_drawdown: [[-0.1, null, null], [-0.2, -0.4, -0.1]], trade_count: [[3, null, null], [4, 5, 6]],
        skipped: [[0, 1, "invalid"], [0, 2, "invalid"]], complete: true, runs: 4, invalid_cells: 2,
        summary: { positive_share: 0.75, return_min: -0.3, return_max: 0.2 },
      },
      ui_only: { charts: { initial: 1000, dates: ["2021-12-30", "2021-12-31", "2022-01-04"],
        equity: [1000, 1100, 900], drawdown: [0, 0, -0.1818], benchmark: [1000, 1010, N(1020)] } },
      ...over,
    },
  };
}

test("解析工具原样返回；格式不对的那一块不画，不拿默认值凑", () => {
  const v = parseBacktestView(toolResult());
  assert.ok(v);
  assert.equal(v.benchmarkLabel, "沪深300指数");
  assert.equal(v.charts?.dates.length, 3);
  assert.equal(parseBacktestView({ ok: false, error: "x" }), null);
  assert.equal(parseBacktestView(null), null);

  const broken = parseBacktestView(toolResult({ ui_only: { charts: { initial: 1000, dates: ["a", "b"], equity: [1], drawdown: [0, 0], benchmark: null } } }));
  assert.equal(broken?.charts, null, "长度对不上就不画净值图");
  assert.ok(broken?.monthly, "其余部分照常");
  const nan = parseBacktestView(toolResult({ ui_only: { charts: { initial: 0, dates: ["a"], equity: [1], drawdown: [0], benchmark: null } } }));
  assert.equal(nan?.charts, null, "初始资金不合法就不换算累计收益");

  const self = parseBacktestView(toolResult({ benchmark_is_self: true, benchmark: undefined }));
  assert.equal(self?.benchmarkLabel, "标的等权买入持有");
});

test("重抽样为正比例的分母：有样本夏普算不出时说清楚是其中几次（审计 D12）", () => {
  const v = parseBacktestView(toolResult())!;
  const b = v.robustness!.bootstrap as { n_bootstrap: number | null; n_valid: number | null };
  assert.equal(b.n_valid, null, "旧结果没有这一项");
  assert.equal(bootstrapBase(b as never), "重抽样 1000 次");
  const part = parseBacktestView(toolResult({ robustness: { bootstrap_sharpe: { ci_lower: 0, ci_upper: 1, prob_positive: 0.5, confidence: 0.95, n_bootstrap: 1000, n_valid: 640 } } }))!;
  assert.equal(bootstrapBase(part.robustness!.bootstrap as never), "重抽样 1000 次，其中 640 次夏普算得出（其余样本收益没有波动），这 640 次");
  const all = parseBacktestView(toolResult({ robustness: { bootstrap_sharpe: { ci_lower: 0, ci_upper: 1, prob_positive: 0.5, confidence: 0.95, n_bootstrap: 1000, n_valid: 1000 } } }))!;
  assert.equal(bootstrapBase(all.robustness!.bootstrap as never), "重抽样 1000 次");
});

test("净值图只做「÷ 初始资金 − 1」这一步换算；回撤图原样画工具写出的回撤列", () => {
  const v = parseBacktestView(toolResult())!;
  const eq = equityOption(v, P) as { series: { name: string; data: number[] }[] };
  assert.deepEqual(eq.series[0]!.data, [0, 0.1, -0.1]);
  assert.equal(eq.series[1]!.name, "沪深300指数");
  assert.deepEqual(eq.series[1]!.data, [0, 0.01, 0.02]);
  const uw = underwaterOption(v, P) as { series: { data: number[] }[] };
  assert.deepEqual(uw.series[0]!.data, [0, 0, -0.1818]);
});

test("月度热力图红涨绿跌，空月份不画；没有基准月度表就不给基准视图", () => {
  const v = parseBacktestView(toolResult())!;
  const m = monthlyOption(v, P) as { visualMap: { inRange: { color: string[] }; min: number; max: number }; series: { data: number[][] }[] };
  assert.deepEqual(m.visualMap.inRange.color, ["GREEN", "N", "RED"]);
  assert.equal(m.visualMap.min, -m.visualMap.max, "色阶以 0 为中心");
  assert.equal(m.series[0]!.data.length, 13, "2021 年只有 12 月有数");
  assert.deepEqual(m.series[0]!.data[0], [11, 0, 0.02]);
  assert.equal(monthlyOption(v, P, "bench"), null);
});

test("月度色阶按 95 分位截顶：一个极端月份不把其余格子压成浅色", () => {
  const vals = [...Array(99).fill(0.02), 0.5];
  assert.equal(symmetricMax(vals), 0.5);
  assert.equal(symmetricMax(vals, 0.01, 0.95), 0.02);
  assert.equal(symmetricMax([0, 0, null]), 0.01, "全是零时色阶不塌");
  assert.equal(symmetricMax([-0.3, 0.1]), 0.3, "按绝对值");
});

test("年度柱：不完整年份标星；没有基准的年份留空，不当成 0", () => {
  const v = parseBacktestView(toolResult())!;
  const y = yearlyOption(v, P) as { xAxis: { data: string[] }; series: { data: unknown[] }[] };
  assert.deepEqual(y.xAxis.data, ["2021*", "2022"]);
  assert.deepEqual(y.series[1]!.data, [0.01, "-"]);
});

test("参数敏感度：当前参数加框标「当前」，不成立的格子单独一层且不进色阶，不标最优", () => {
  const v = parseBacktestView(toolResult())!;
  const s = v.sensitivity!;
  const o = sensitivityOption(s, "total_return", P) as {
    series: { data: { value: number[]; itemStyle?: { borderWidth: number }; why?: string }[]; label: { formatter: (x: unknown) => string } }[];
    visualMap: { seriesIndex: number; min: number; max: number; show?: boolean; inRange: { color: string[] } }[];
  };
  assert.deepEqual(o.visualMap.map((m) => m.seriesIndex), [0, 1], "每个热力图系列都要有色阶，否则 ECharts 直接抛错");
  assert.equal(o.visualMap[1]!.show, false);
  assert.equal(o.series[0]!.data.length, 4, "只有算出来的 4 格进色阶");
  const base = o.series[0]!.data.find((d) => d.value[0] === 1 && d.value[1] === 1);
  assert.equal(base?.itemStyle?.borderWidth, 2);
  assert.equal(o.series[0]!.data.filter((d) => d.itemStyle).length, 1, "只有当前参数那一格有框");
  assert.ok(o.series[0]!.data.at(-1)!.itemStyle, "带框的格子最后画，框不被相邻格子压住");
  assert.match(o.series[0]!.label.formatter({ value: [1, 1, -0.3] }), /^当前\n-30\.0%$/);
  assert.deepEqual(o.series[1]!.data.map((d) => d.why), ["invalid", "invalid"]);
  assert.deepEqual(o.visualMap[0]!.inRange.color, ["GREEN", "N", "RED"]);
  assert.doesNotMatch(JSON.stringify(o), /最优|最佳|best|推荐/i);

  const dd = sensitivityOption(s, "max_drawdown", P) as { visualMap: { max: number; inRange: { color: string[] } }[] };
  assert.equal(dd.visualMap[0]!.max, 0);
  assert.deepEqual(dd.visualMap[0]!.inRange.color, ["GREEN", "N"]);
});

test("归档附表：年度收益与回撤段原样写进 Markdown，未恢复的回撤写明", () => {
  const md = appendixMarkdown(parseBacktestView(toolResult())!);
  assert.match(md, /## 附表（回测工具原样输出）/);
  assert.match(md, /\| 2021（不完整） \| 2\.00% \| 1\.00% \| 1\.00% \|/);
  assert.match(md, /\| 2022 \| -5\.00% \| — \| — \|/);
  assert.match(md, /\| 2022-01-01 \| 2022-02-01 \| 未恢复 \| -20\.00% \| 30 \|/);
});

test("扣费前后对照：实际一列取主回测的数，不计成本一列和成本吃掉多少原样取工具；滑点不算进费用", () => {
  const costs = { cost_free: { total_return: 0.2563, annual_return: 0.0486, max_drawdown: -0.3896, sharpe: 0.331, fill_count: 34 },
    drag: { total_return: 0.085951, annual_return: 0.015338 }, note: "不计成本：只用来量交易成本吃掉多少" };
  const v = parseBacktestView(toolResult({
    plan: { currency: "CNY" }, cost_compare: costs,
    metrics: { total_return: 0.1703, annual_return: 0.0332, max_drawdown: -0.41, sharpe: 0.21, fill_count: 33, execution_fees: 15580.76 },
  }))!;
  const c = v.costs;
  assert.ok(c && !("error" in c));
  assert.equal(c.actual.total_return, 0.1703);
  assert.equal(c.free.fill_count, 34);
  assert.equal(costSummary(c), "交易成本（费用 + 滑点）吃掉总收益 8.6 个百分点，年化 1.5 个百分点；成交记录里实际扣的费用合计 15,580.76 元，滑点不在其中（体现在成交价里）。");
  const md = appendixMarkdown(v);
  assert.match(md, /### 扣费前后对照/);
  assert.match(md, /\| 总收益 \| 17\.0% \| 25\.6% \|/);
  assert.match(md, /\| 成交笔数 \| 33 \| 34 \|/);
  assert.match(md, /不计成本：只用来量交易成本吃掉多少/);

  const err = parseBacktestView(toolResult({ cost_compare: { error: "不计成本那次没有跑出来（RuntimeError）" } }))!;
  assert.deepEqual(err.costs, { error: "不计成本那次没有跑出来（RuntimeError）" });
  assert.doesNotMatch(appendixMarkdown(err), /扣费前后对照/, "没跑出来就不写对照表");
  assert.equal(parseBacktestView(toolResult())!.costs, null, "工具没给就不显示");

  const flat = { actual: c.actual, free: c.free, fees: null, currency: "USD", note: "" };
  assert.match(costSummary({ ...flat, dragTotal: -0.003, dragAnnual: -0.001 }), /^不计成本那次反而少 0\.3 个百分点.*几乎没有影响/);
  const big = costSummary({ ...flat, dragTotal: -0.04, dragAnnual: -0.008 });
  assert.match(big, /反而少 4\.0? ?个百分点.*量不出/);
  assert.doesNotMatch(big, /几乎没有影响/, "差了好几个百分点不能说成本没影响");
  assert.equal(costSummary({ ...flat, dragTotal: null, dragAnnual: null }), "成本吃掉多少没有算出来。");
  assert.equal(points(0.0002), "不到 0.1 个百分点");
  assert.equal(points(0), "0.0 个百分点");
  assert.equal(points(null), "—");
});

test("占比不四舍五入成 100% / 0%：真机里 99.5% 曾显示成 100%", () => {
  assert.equal(sharePct(0.995), "99.5%");
  assert.equal(sharePct(0.9996), ">99.9%");
  assert.equal(sharePct(1), "100%");
  assert.equal(sharePct(0.0004), "<0.1%");
  assert.equal(sharePct(0), "0%");
  assert.equal(sharePct(0.8), "80%");
  assert.equal(sharePct(null), "—");
});

test("回测页挂上图表与附表；敏感度区写明不代表最优参数", () => {
  const page = readFileSync(new URL("../src/verticals/finance/pages/Backtest.tsx", import.meta.url), "utf8");
  assert.match(page, /parseBacktestView\(out\.tool_result\)/);
  assert.match(page, /\{view && <BacktestCharts view=\{view\} \/>\}/);
  assert.match(page, /appendix \? \["", appendix\]/);
  assert.match(page, /setView\(null\)/, "新建会话要清掉上一份图表");
});

test("图表区真渲染：扣费对照、两处占比按 sharePct 显示、敏感度写明不代表最优参数；没给的块不画", async () => {
  const base = toolResult().result as Record<string, any>;
  // 两个占比都挑「四舍五入会变成 100.0% / 0.0%」的值：走错格式化函数就看得出来
  const view = parseBacktestView(toolResult({
    plan: { currency: "CNY" },
    metrics: { total_return: 0.1703, annual_return: 0.0332, max_drawdown: -0.41, sharpe: 0.21, fill_count: 33, execution_fees: 15580.76 },
    cost_compare: { cost_free: { total_return: 0.2563, annual_return: 0.0486, max_drawdown: -0.3896, sharpe: 0.331, fill_count: 34 },
      drag: { total_return: 0.085951, annual_return: 0.015338 }, note: "不计成本：只用来量交易成本吃掉多少" },
    robustness: { ...base.robustness, bootstrap_sharpe: { ...base.robustness.bootstrap_sharpe, prob_positive: 0.9996, n_bootstrap: 10000 } },
    sensitivity: { ...base.sensitivity, summary: { ...base.sensitivity.summary, positive_share: 0.0004 } },
  }))!;
  const bare = parseBacktestView(toolResult({ robustness: undefined, sensitivity: undefined }))!;
  await withRenderer(async (r) => {
    const { BacktestCharts } = await r.load("/src/verticals/finance/components/BacktestCharts.tsx");
    const text = textOf(r.html(BacktestCharts, { view }));
    assert.match(text, /扣费前后对照/);
    assert.match(text, /现实里做不到零成本/);
    assert.match(text, /重抽样 10000 次里为正的比例 >99\.9%/, "不是每次都为正就不能显示 100%");
    assert.match(text, /<0\.1% 收益为正/, "有为正的格子就不能显示 0%");
    assert.doesNotMatch(text, /100\.0%|(?<![\d.])0\.0% 收益为正/);
    assert.match(text, /不代表最优参数/);

    const plain = textOf(r.html(BacktestCharts, { view: bare }));
    assert.doesNotMatch(plain, /扣费前后对照/, "工具没给对照结果就不画这一块");
    assert.doesNotMatch(plain, /稳健性检验|参数敏感度/);
    assert.match(plain, /年度收益/, "其余部分照常");
  });
});
