import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ChartPalette } from "../src/verticals/finance/lib/backtestView.ts";
import {
  bucketMembers, correlationOption, DEFAULT_THRESHOLDS, findBreaches, parseThresholds, parseXray, riskShareOption, xrayContextText,
  type XrayThresholds, type XrayView,
} from "../src/verticals/finance/lib/xrayView.ts";

const P: ChartPalette = {
  text: "T", grid: "G", axis: "A", strong: "S", primary: "P", benchmark: "B",
  rise: "RED", fall: "GREEN", neutral: "N", tooltipBg: "TB", tooltipText: "TT",
};

type Obj = Record<string, any>;

const pos = (symbol: string, name: string, weight: number, risk: number, industry: string | null = null) =>
  ({ symbol, name, value: weight * 1000, weight, risk_share: risk, vol_annualized: 0.3, industry });

function toolResult(over: Obj = {}): Obj {
  return {
    ok: true,
    result: {
      window_days: 365, min_bars: 60,
      gaps: [{ symbol: "000858", name: "五粮液", reason: "没有现价算出的市值" }],
      groups: [
        {
          market: "a_share", currency: "CNY", label: "A 股 · 人民币", total_value: 1000,
          positions_input: 5, positions_included: 4,
          positions: [
            pos("600519.SH", "贵州茅台", 0.45, 0.5, "食品饮料"),
            pos("300750.SZ", "宁德时代", 0.25, 0.3, "电力设备"),
            pos("510300.SH", "沪深300ETF", 0.2, 0.12, "ETF / 基金（不归入单一行业）"),
            pos("002371.SZ", "北方华创", 0.1, 0.08, "电子"),
          ],
          metrics: {
            window: { first_date: "2025-10-09", last_date: "2026-10-08", days: 243 },
            top1: { symbol: "600519.SH", name: "贵州茅台", weight: 0.45 },
            top3_weight: 0.9, effective_n: 3.3, hhi: 0.3,
            annualized_vol: 0.21, downside_vol: 0.15, max_drawdown: -0.18,
            max_drawdown_start: "2026-01-05", max_drawdown_trough: "2026-04-08",
            var_95: 0.021, es_95: 0.03, diversification_ratio: 1.3, avg_abs_corr: 0.41,
            max_corr_pair: { symbols: ["600519.SH", "510300.SH"], corr: 0.86 },
          },
          industry: {
            classification: "申万 2021 一级行业（按 as_of 的归属）",
            buckets: [
              { name: "食品饮料", weight: 0.45, symbols: ["600519.SH"] },
              { name: "电力设备", weight: 0.25, symbols: ["300750.SZ"] },
              { name: "ETF / 基金（不归入单一行业）", weight: 0.2, symbols: ["510300.SH"] },
              { name: "电子", weight: 0.1, symbols: ["002371.SZ"] },
            ],
          },
          gaps: [{ symbol: "430047.BJ", name: "", reason: "历史价格没取到：北交所暂不支持" }],
          notes: ["回看最近一年"], sources: ["腾讯 K 线"],
        },
        {
          market: "us_equity", currency: "USD", label: "美股 · 美元", total_value: 500,
          positions_input: 2, positions_included: 2,
          positions: [pos("AAPL", "", 0.6, 0.7), pos("MSFT", "", 0.4, 0.3)],
          metrics: {
            window: { first_date: "2025-10-08", last_date: "2026-10-07", days: 250 },
            top1: { symbol: "AAPL", name: "", weight: 0.6 }, top3_weight: 1, effective_n: 1.9,
            annualized_vol: 0.22, downside_vol: 0.16, max_drawdown: -0.2, var_95: 0.02, es_95: 0.03,
            avg_abs_corr: 0.14, max_corr_pair: { symbols: ["AAPL", "MSFT"], corr: 0.137 },
          },
          industry: null, gaps: [], notes: ["回看最近一年"], sources: ["Yahoo chart"],
        },
      ],
      ui_only: {
        correlation: {
          CNY: {
            symbols: ["600519.SH", "300750.SZ", "510300.SH", "002371.SZ"],
            values: [[1, 0.3, 0.86, 0.2], [0.3, 1, 0.82, 0.5], [0.86, 0.82, 1, 0.4], [0.2, 0.5, 0.4, 1]],
          },
          USD: { symbols: ["AAPL", "MSFT"], values: [[1, 0.137], [0.137, 1]] },
        },
      },
      ...over,
    },
  };
}

function view(over: Obj = {}): XrayView {
  const r = parseXray(toolResult(over));
  assert.ok(r.ok);
  return r.view;
}

test("工具出错 / 形状不对：原因原样带出，不画残图", () => {
  assert.deepEqual(parseXray({ ok: false, error: "持仓列表是空的" }), { ok: false, error: "持仓列表是空的" });
  assert.equal(parseXray(null).ok, false);
  assert.match((parseXray({ ok: true, result: {} }) as { error: string }).error, /分组/);
});

test("解析：字段改名、币种分组、相关矩阵按币种挂到对应组", () => {
  const v = view();
  assert.equal(v.groups.length, 2);
  const [a, us] = v.groups;
  assert.equal(a!.currency, "CNY");
  assert.equal(a!.included, 4);
  assert.equal(a!.input, 5);
  assert.equal(a!.positions[0]!.riskShare, 0.5);
  assert.equal(a!.metrics!.top3Weight, 0.9);
  assert.equal(a!.metrics!.maxDrawdownTrough, "2026-04-08");
  assert.deepEqual(a!.metrics!.window, { first: "2025-10-09", last: "2026-10-08", days: 243 });
  assert.equal(a!.matrix!.symbols.length, 4);
  assert.equal(us!.matrix!.values[0]![1], 0.137);
  assert.equal(us!.industry, null);
  assert.deepEqual(v.gaps, [{ symbol: "000858", name: "五粮液", reason: "没有现价算出的市值" }]);
  assert.equal(a!.gaps[0]!.reason, "历史价格没取到：北交所暂不支持");
});

test("相关矩阵形状不对就当没有，不拿错位的数画图", () => {
  const bad = toolResult();
  bad.result.ui_only.correlation.CNY.values[2] = [1, 2];
  const v = parseXray(bad);
  assert.ok(v.ok);
  assert.equal(v.view.groups[0]!.matrix, null);
  const none = view({ ui_only: undefined });
  assert.equal(none.groups[0]!.matrix, null, "不要 charts 时没有矩阵");
});

test("提醒线读取：空 / 坏数据退回起点值，显式 null 保持不提醒，越界退回起点值", () => {
  assert.deepEqual(parseThresholds(null), DEFAULT_THRESHOLDS);
  assert.deepEqual(parseThresholds("{oops"), DEFAULT_THRESHOLDS);
  assert.deepEqual(parseThresholds("[1]"), DEFAULT_THRESHOLDS);
  const t = parseThresholds(JSON.stringify({ single: null, top3: 0.5, industry: 3, corr: "0.9" }));
  assert.deepEqual(t, { single: null, top3: 0.5, industry: DEFAULT_THRESHOLDS.industry, corr: DEFAULT_THRESHOLDS.corr });
  assert.equal(parseThresholds(JSON.stringify({})).single, DEFAULT_THRESHOLDS.single, "没存过的项用起点值");
  const fresh = parseThresholds(null);
  fresh.single = 0.9;
  assert.equal(DEFAULT_THRESHOLDS.single, 0.3, "返回的是副本，改了不污染起点值");
});

test("超线判断：单只、前三、行业（ETF 桶不算）、相关性逐项列出", () => {
  const b = findBreaches(view(), DEFAULT_THRESHOLDS);
  const kinds = b.map((x) => `${x.group}|${x.kind}`);
  assert.deepEqual(kinds, [
    "A 股 · 人民币|single", "A 股 · 人民币|top3", "A 股 · 人民币|industry",
    "A 股 · 人民币|corr", "A 股 · 人民币|corr", "美股 · 美元|single", "美股 · 美元|single",
  ]);
  assert.match(b[0]!.text, /贵州茅台（600519\.SH） 占 45\.0%，超过你设的单只 30%/);
  assert.match(b[2]!.text, /^食品饮料行业占 45\.0%/);
  assert.deepEqual(b.filter((x) => x.kind === "industry").map((x) => x.text.split("行业占")[0]), ["食品饮料"], "ETF / 基金桶（20%）不当成单一行业");
  assert.match(b[3]!.text, /0\.86/, "相关性从高到低");
  assert.match(b[4]!.text, /0\.82/);
  assert.match(b[5]!.text, /^AAPL 占 60\.0%/, "没有名称时只写代码");
  assert.match(b[6]!.text, /^MSFT 占 40\.0%/);
});

test("超线判断：刚好等于不算超；三只及以下不比前三；设成空就不提醒", () => {
  const exact: XrayThresholds = { single: 0.45, top3: 0.9, industry: 0.45, corr: 0.86 };
  const kinds = findBreaches(view(), exact).map((x) => x.kind);
  assert.deepEqual(kinds, ["single"], "茅台 45% 不超 45%；只有美股 AAPL 60% 超；其余都只是等于");
  const usOnly = findBreaches(view(), { single: null, top3: 0.5, industry: null, corr: null });
  assert.equal(usOnly.some((x) => x.group.startsWith("美股")), false, "美股两只，前三合计必然 100%，不比");
  assert.deepEqual(findBreaches(view(), { single: null, top3: null, industry: null, corr: null }), []);
  const one = view();
  one.groups[1]!.positions = one.groups[1]!.positions.slice(0, 1);
  assert.equal(findBreaches(one, { single: 0.3, top3: null, industry: null, corr: null }).some((x) => x.group.startsWith("美股")), false,
    "一组只有一只时必然 100%，不比");
});

test("超线判断：行业线压低到 15% 时 ETF 桶（20%）仍不算；相关性按从高到低列", () => {
  const ind = findBreaches(view(), { single: null, top3: null, industry: 0.15, corr: null });
  assert.deepEqual(ind.map((x) => x.text.split("行业占")[0]), ["食品饮料", "电力设备"]);
  const r = toolResult();
  r.result.ui_only.correlation.CNY.values[0][1] = 0.81;
  r.result.ui_only.correlation.CNY.values[1][0] = 0.81;
  const p = parseXray(r);
  assert.ok(p.ok);
  const corr = findBreaches(p.view, { single: null, top3: null, industry: null, corr: 0.8 }).map((x) => x.text.match(/相关系数 (\S+)，/)![1]);
  assert.deepEqual(corr, ["0.86", "0.82", "0.81"]);
});

test("超线判断：没有矩阵时用最相关的一对兜底；没算成的组跳过", () => {
  const v = view({ ui_only: undefined });
  const corr = findBreaches(v, { single: null, top3: null, industry: null, corr: 0.8 });
  assert.equal(corr.length, 1);
  assert.match(corr[0]!.text, /贵州茅台（600519\.SH） 和 沪深300ETF（510300\.SH） 相关系数 0\.86/);
  const r = toolResult();
  r.result.groups[0].metrics = null;
  const p = parseXray(r);
  assert.ok(p.ok);
  assert.equal(findBreaches(p.view, DEFAULT_THRESHOLDS).some((x) => x.group.startsWith("A 股")), false);
});

test("风险贡献图：占比最大的在最上面，两根条分别是资金占比和风险贡献", () => {
  const g = view().groups[0]!;
  const o = riskShareOption(g, P) as Obj;
  assert.deepEqual(o.yAxis.data, ["北方华创", "沪深300ETF", "宁德时代", "贵州茅台"]);
  assert.deepEqual(o.series.map((s: Obj) => s.name), ["资金占比", "风险贡献"]);
  assert.deepEqual(o.series[1].data, [0.08, 0.12, 0.3, 0.5]);
  assert.equal(o.series[0].itemStyle.color, "B");
  assert.equal(o.series[1].itemStyle.color, "P");
  assert.equal(riskShareOption({ ...g, positions: [] }, P), null);
  assert.equal(riskShareOption({ ...g, positions: g.positions.slice(0, 1) }, P), null, "只有一只时不画");
});

test("相关性热力图：n×n 个格子，不用涨跌的红绿；一只时不画", () => {
  const g = view().groups[0]!;
  const o = correlationOption(g, P) as Obj;
  assert.equal(o.series[0].data.length, 16);
  assert.deepEqual(o.series[0].data[2], [2, 0, 0.86]);
  assert.deepEqual(o.xAxis.data, ["贵州茅台", "宁德时代", "沪深300ETF", "北方华创"]);
  const colors = JSON.stringify(o.visualMap.inRange.color);
  assert.equal(colors.includes("RED") || colors.includes("GREEN"), false, "红绿留给涨跌");
  assert.equal(o.visualMap.min, -1);
  assert.equal(o.visualMap.max, 1);
  assert.equal(correlationOption({ ...g, matrix: { symbols: ["A"], values: [[1]] } }, P), null);
  assert.equal(o.xAxis.axisLabel.formatter("沪深300ETF华泰柏瑞"), "沪深300E…", "轴上长名字截断（前 6 个字符）");
  assert.match(o.tooltip.formatter({ value: [2, 0, 0.86] }), /贵州茅台 × 沪深300ETF：0\.86/, "悬停框是全名");
  // 持仓名是用户填的，悬停框按 HTML 渲染：名字里的标签必须转义
  const evil = { ...g, positions: g.positions.map((x, i) => (i === 0 ? { ...x, name: `<img src=x onerror="alert(1)">&` } : x)) };
  const tip = (correlationOption(evil, P) as Obj).tooltip.formatter({ value: [1, 0, 0.5] }) as string;
  assert.equal(tip.includes("<img"), false, tip);
  assert.ok(tip.includes("&#60;img") && tip.includes("&#34;alert(1)&#34;&#62;&#38;"), tip);
});

test("给 AI 的体检摘要：转述工具的数和用户的线，不加评价", () => {
  const v = view();
  const text = xrayContextText(v, findBreaches(v, DEFAULT_THRESHOLDS));
  for (const w of ["A 股 · 人民币", "纳入 4/5 只", "前三合计 90.0%", "等效持股数 3.3", "最大回撤 -18.0%", "贵州茅台 资金45.0%/风险50.0%",
    "单日95%VaR（亏损幅度）2.10%", "食品饮料 45.0%", "430047.BJ 历史价格没取到", "000858 没有现价算出的市值", "超过用户自设提醒线"]) {
    assert.ok(text.includes(w), w);
  }
  assert.match(xrayContextText(v, []), /没有超过用户自设的提醒线/);
});

test("不出综合分、不给买卖建议", () => {
  const v = view();
  const blob = JSON.stringify(findBreaches(v, DEFAULT_THRESHOLDS)) + xrayContextText(v, []) +
    readFileSync(new URL("../src/verticals/finance/lib/xrayView.ts", import.meta.url), "utf8") +
    readFileSync(new URL("../src/verticals/finance/components/PortfolioXray.tsx", import.meta.url), "utf8");
  for (const w of ["评分", "得分", "健康度", "建议买入", "建议卖出", "建议减仓", "建议加仓", "目标价", "满分"]) {
    assert.equal(blob.includes(w), false, w);
  }
});

test("持仓页接上体检：走体检工具、要相关矩阵、持仓变了才重算、提醒线存本地", () => {
  const page = readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  const card = readFileSync(new URL("../src/verticals/finance/components/PortfolioXray.tsx", import.meta.url), "utf8");
  assert.match(page, /const xray = usePortfolioXray\(holdings\)/);
  assert.match(page, /<XrayBanner x=\{xray\} onOpen=\{\(\) => \{ setSub\("xray"\); scrollToXray\(\); \}\} \/>/);
  assert.match(page, /<PortfolioXrayCard x=\{xray\} \/>/);
  assert.match(page, /xrayContextText\(xray\.result\.view, xray\.breaches\)/, "体检结果进页面 AI 上下文");
  assert.ok(page.indexOf(">持仓明细</h3>") > 0 && page.indexOf("<XrayBanner") < page.indexOf(">持仓明细</h3>"), "横幅在持仓表上方");
  assert.match(card, /backend\.runTool<unknown>\("xray", \{ positions, charts: true \}, c\.signal\)/);
  assert.match(card, /value: h\.market_value/, "没取到现价传 null，让工具列进缺口而不是当 0");
  assert.match(card, /const sig = holdingsSig\(holdings\)/, "现价有无、市值漂移的判断在 holdingsDrift（见 holdings_drift.test.ts）");
  assert.match(card, /useEffect\(\(\) => \{ if \(drifted\) run\(false\); \}, \[drifted, run\]\)/, "市值变了 2% 以上也重算");
  assert.match(card, /storageSet\(THRESHOLDS_KEY, JSON\.stringify\(t\)\)/);
  assert.match(card, /ctl\.current\?\.abort\(\)/);
});

test("港美股行业暴露：GICS 一级分桶，桶里列出是哪几只和东财细分行业；没有行业资料的桶不算单一行业", () => {
  const us = {
    market: "us_equity", currency: "USD", label: "美股 · 美元", total_value: 1000, positions_input: 3, positions_included: 3,
    positions: [
      { ...pos("NVDA", "英伟达", 0.5, 0.6, "信息技术"), industry_detail: "半导体产品" },
      { ...pos("MSFT", "", 0.3, 0.3, "信息技术"), industry_detail: "系统软件" },
      pos("SPY", "标普500ETF", 0.2, 0.1, "没有行业资料（ETF、基金多是这样）"),
    ],
    metrics: { window: { first_date: "2025-10-08", last_date: "2026-10-07", days: 250 }, top1: { symbol: "NVDA", name: "英伟达", weight: 0.5 },
      top3_weight: 1, effective_n: 2.6, annualized_vol: 0.3, max_drawdown: -0.25, var_95: 0.03, es_95: 0.04, avg_abs_corr: 0.5 },
    industry: { classification: "GICS 一级行业（东财公司资料；美股按东财给的细分行业对回一级）", buckets: [
      { name: "信息技术", weight: 0.8, symbols: ["NVDA", "MSFT"] },
      { name: "没有行业资料（ETF、基金多是这样）", weight: 0.2, symbols: ["SPY"] },
    ] },
    gaps: [], notes: [], sources: [],
  };
  const v = view({ groups: [us], ui_only: undefined });
  const g = v.groups[0]!;
  assert.equal(g.positions[0]!.industryDetail, "半导体产品");
  assert.equal(g.positions[2]!.industryDetail, null);
  assert.equal(bucketMembers(g, ["NVDA", "MSFT"]), "英伟达·半导体产品，MSFT·系统软件", "没有名字用代码；带细分时各只之间用逗号");
  assert.equal(bucketMembers(g, ["SPY", "XXX"]), "标普500ETF、XXX");
  assert.match(xrayContextText(v, []),
    /行业（GICS 一级行业（东财公司资料；美股按东财给的细分行业对回一级））：信息技术 80\.0%（英伟达·半导体产品，MSFT·系统软件）；没有行业资料（ETF、基金多是这样） 20\.0%（标普500ETF）/);
  const b = findBreaches(v, { single: null, top3: null, industry: 0.1, corr: null });
  assert.deepEqual(b.map((x) => x.text.split("行业占")[0]), ["信息技术"], "没有行业资料那一桶（20%）不当成单一行业");
  const card = readFileSync(new URL("../src/verticals/finance/components/PortfolioXray.tsx", import.meta.url), "utf8");
  assert.ok(card.includes("{bucketMembers(g, b.symbols)}") && !card.includes("目前只有 A 股有行业分类"));
});
