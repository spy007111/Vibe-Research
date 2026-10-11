import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ChartPalette } from "../src/verticals/finance/lib/backtestView.ts";
import { parsePerf, pctSigned, perfContextText, perfOption } from "../src/verticals/finance/lib/perfView.ts";

const P: ChartPalette = {
  text: "T", grid: "G", axis: "A", strong: "S", primary: "P", benchmark: "B",
  rise: "RED", fall: "GREEN", neutral: "N", tooltipBg: "TB", tooltipText: "TT",
};
type Obj = Record<string, any>;

function toolResult(over: Obj = {}): Obj {
  return {
    ok: true,
    result: {
      as_of: "2026-10-09", sources: ["腾讯 K 线"], notes: ["买入算当天开头投入…"],
      skipped: [{ id: "t9", symbol: "600519", why: "卖出 500 股,超过当时持有的 100 股(之前的买入或送转可能没录)" }],
      gaps: [{ symbol: "BRK.B", reason: "代码认不出：…" }],
      groups: [
        {
          market: "a_share", currency: "CNY", label: "A 股 · 人民币", ok: true,
          start: "2025-01-02", end: "2026-10-09", span_days: 645,
          symbols: [{ symbol: "600519", name: "贵州茅台" }], excluded: [{ symbol: "000001", name: "平安银行", reason: "价格没取到，这只没算进收益率：超时" }],
          twr: 0.123456, twr_annualized: 0.068, xirr: 0.071, mwr_period: 0.129,
          invested: 150000, proceeds: 20000, dividends: 1200.5, fees: 35, end_value: 151000, gain: 22200.5,
          notes: ["A 股用不复权价，送转按流水里记的比例换算股数"], warnings: ["贵州茅台 2025-06-20 价格比前一天跌了 33%，像是送转 / 拆股除权…"],
          ui_only: { series: { dates: ["2025-01-02", "2025-01-03", "2025-01-06"], value: [1, 2, 3], twr_index: [1, 1.05, 0.98], net_flow: [1, 0, 0] } },
        },
        { market: "us_equity", currency: "USD", label: "美股 · 美元", ok: false, reason: "这一组的价格都没取到，算不了", symbols: [], excluded: [], notes: [] },
      ],
      ...over,
    },
  };
}

test("收益率解析:字段原样取、没有的是 null;工具说做不了就带原因", () => {
  const r = parsePerf(toolResult());
  assert.ok(r.ok);
  const [a, u] = r.view.groups;
  assert.deepEqual([a!.twr, a!.twrAnnualized, a!.xirr, a!.mwrPeriod, a!.gain, a!.spanDays], [0.123456, 0.068, 0.071, 0.129, 22200.5, 645]);
  assert.deepEqual(a!.series, { dates: ["2025-01-02", "2025-01-03", "2025-01-06"], twrIndex: [1, 1.05, 0.98] });
  assert.equal(a!.excluded[0]!.name, "平安银行");
  assert.deepEqual([u!.ok, u!.reason, u!.twr, u!.gain, u!.series], [false, "这一组的价格都没取到，算不了", null, null, null]);
  assert.deepEqual([r.view.skipped.length, r.view.gaps[0]!.symbol, r.view.sources, r.view.asOf], [1, "BRK.B", ["腾讯 K 线"], "2026-10-09"]);
  assert.deepEqual(r.view.notes, ["买入算当天开头投入…"]);
  assert.deepEqual(parsePerf({ ok: false, error: "一次最多算 5000 笔流水" }), { ok: false, error: "一次最多算 5000 笔流水" });
  assert.equal((parsePerf(null) as { error: string }).error, "收益率工具没有返回结果");
  assert.equal((parsePerf({ ok: true, result: {} }) as { error: string }).error, "收益率工具的返回里没有分组结果");
  // 序列长度对不上就不画,不拿错位的数画图
  const bad = parsePerf(toolResult({ groups: [{ ...toolResult().result.groups[0], ui_only: { series: { dates: ["a"], twr_index: [1, 2] } } }] }));
  assert.ok(bad.ok && bad.view.groups[0]!.series === null);
});

test("收益率显示:带正负号、没有数是「—」;走势图只画百分比", () => {
  assert.deepEqual([pctSigned(0.123456), pctSigned(-0.05), pctSigned(0), pctSigned(null), pctSigned(0.1, 0)], ["+12.35%", "-5.00%", "0.00%", "—", "+10%"]);
  const r = parsePerf(toolResult());
  assert.ok(r.ok);
  const o = perfOption(r.view.groups[0]!, P) as Obj;
  assert.deepEqual(o.series[0].data.map((x: number) => Math.round(x * 1e6) / 1e6), [0, 0.05, -0.02]);
  assert.equal(o.series.length, 1, "不画市值(金额在隐私模式下要遮)");
  assert.equal(perfOption(r.view.groups[1]!, P), null);
});

test("收益率给 AI 的上下文:口径和数字照给、不评好坏;没年化就不写年化", () => {
  const r = parsePerf(toolResult());
  const text = perfContextText(r);
  assert.match(text, /A 股 · 人民币:2025-01-02 至 2026-10-09\(645 天\);时间加权 \+12\.35%\(年化 \+6\.80%\);资金加权 \+12\.90%\(年化 \+7\.10%\)/);
  assert.match(text, /投入 150000、卖出所得 20000、分红 1200\.5、期末市值 151000、盈亏 22200\.5/);
  assert.match(text, /没算进来:平安银行/);
  assert.match(text, /美股 · 美元:没算成\(这一组的价格都没取到,算不了\)|美股 · 美元:没算成\(这一组的价格都没取到，算不了\)/);
  assert.doesNotMatch(text, /跑赢|跑输|优秀|不错|建议/);
  const short = parsePerf(toolResult({ groups: [{ ...toolResult().result.groups[0], twr_annualized: null, xirr: null }] }));
  assert.doesNotMatch(perfContextText(short), /年化/);
  assert.equal(perfContextText(null), "");
  assert.equal(perfContextText({ ok: false, error: "超时" }), "收益率没算成:超时");
});

test("收益率卡:金额都过隐私遮挡、百分比不遮;服务端读台账,界面只决定什么时候算", () => {
  const src = readFileSync(new URL("../src/verticals/finance/components/PortfolioPerf.tsx", import.meta.url), "utf8");
  for (const pin of ["p(moneySigned(g.gain))", "p(money(g.endValue))", "p(money(g.invested))", "p(money(g.proceeds))", "p(money(g.dividends))", "p(money(g.fees))"]) {
    assert.ok(src.includes(pin), `金额要遮:${pin}`);
  }
  assert.ok(!/v=\{money|v=\{moneySigned/.test(src), "金额不能不经 p() 直接显示");
  assert.ok(src.includes("v={pctSigned(g.twr)}") && src.includes("v={pctSigned(g.mwrPeriod)}"), "百分比不遮");
  assert.ok(src.includes("backend.holdingsPerf(c.signal)"), "流水由服务端读台账,不经界面转发");
  assert.ok(!src.includes("runTool("), "不从界面直接把流水塞给工具(会撞请求体上限)");
  // 备注、名称改了不重算;任何一个数改了要重算
  assert.match(src, /\[t\.id, t\.symbol, t\.type, t\.date, t\.shares, t\.price, t\.fee, t\.amount, t\.ratio\]/);
  // 红涨绿跌
  assert.match(src, /v > 0 \? "text-danger" : v < 0 \? "text-success"/);
  const page = readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  assert.ok(page.includes("<PortfolioPerfCard x={perf} hide={hide} legacyPending={legacy.length} />"));
  assert.ok(page.indexOf(">持仓明细</h3>") < page.indexOf("<PortfolioPerfCard"), "收益率卡在持仓明细下面(跳过的流水原因在明细里)");
  assert.ok(page.includes("perfContextText(perf.result)"));
});

test("收益表现结果绑在算它时的那份流水上：流水改了旧结果不显示、不进 AI 上下文（第四轮审计 C3）", async () => {
  const { withRenderer } = await import("./helpers/render.ts");
  await withRenderer(async (r) => {
    const { perfFor } = await r.load("/src/verticals/finance/components/PortfolioPerf.tsx");
    const old = { ok: false as const, error: "旧结果" };
    assert.equal(perfFor({ sig: "t1:600519:buy", result: old }, "t1:600519:buy"), old);
    assert.equal(perfFor({ sig: "t1:600519:buy", result: old }, "t1:600519:buy|t2:000001:buy"), null, "多记了一笔：旧结果作废");
    assert.equal(perfFor(null, "t1"), null);
  });
  const src = readFileSync(new URL("../src/verticals/finance/components/PortfolioPerf.tsx", import.meta.url), "utf8");
  assert.match(src, /const result = perfFor\(held, sig\);/, "页面和 AI 上下文拿到的都是 perfFor 过滤后的结果");
});
