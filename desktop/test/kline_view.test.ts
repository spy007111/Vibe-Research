import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ChartPalette } from "../src/verticals/finance/lib/backtestView.ts";
import { barRises, fmtChange, fmtPrice, fmtVolume, klineOption, parseKline } from "../src/verticals/finance/lib/klineView.ts";

const P: ChartPalette = {
  text: "T", grid: "G", axis: "A", strong: "S", primary: "P", benchmark: "B",
  rise: "RED", fall: "GREEN", neutral: "N", tooltipBg: "TB", tooltipText: "TT",
};

type Obj = Record<string, any>;

function toolResult(n = 150, over: Record<string, unknown> = {}) {
  const dates = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
  const open = dates.map((_, i) => 10 + i);
  // 偶数根收涨、奇数根收跌
  const close = dates.map((_, i) => (i % 2 === 0 ? 10.5 + i : 9.5 + i));
  return {
    ok: true,
    result: {
      symbol: "600519.SH", market: "a_share", market_label: "A 股", period: "day", period_label: "日线",
      adjust: "qfq", adjust_label: "前复权（等比，按新浪复权因子）", source: "腾讯 K 线、新浪复权因子",
      fetched_at: "2026-10-08T15:31:00+08:00", volume_unit: "股", notes: ["示例说明"],
      ui_only: { series: {
        dates, open, close,
        high: close.map((c, i) => Math.max(c, open[i]!) + 1),
        low: close.map((c, i) => Math.min(c, open[i]!) - 1),
        volume: dates.map((_, i) => 1000 * (i + 1)),
        change: dates.map((_, i) => (i === 0 ? null : 0.01)),
        ma: { "5": dates.map((_, i) => (i < 4 ? null : 12)), "20": dates.map(() => null), bad: [1] },
      } },
      ...over,
    },
  };
}

test("工具出错 / 形状不对时不画残图，把原因带出来", () => {
  assert.deepEqual(parseKline({ ok: false, error: "北交所暂不支持" }), { ok: false, error: "北交所暂不支持" });
  assert.equal(parseKline(null).ok, false);
  assert.match((parseKline({ ok: true, result: {} }) as { error: string }).error, /没有序列/);
  const short = toolResult();
  (short.result.ui_only.series as Obj).close = [1, 2];
  assert.match((parseKline(short) as { error: string }).error, /close/);
  const badDate = toolResult();
  (badDate.result.ui_only.series as Obj).dates[3] = "2026/01/04";
  assert.match((parseKline(badDate) as { error: string }).error, /日期/);
});

test("解析结果：标签、单位、均线只留数字窗口", () => {
  const r = parseKline(toolResult());
  assert.ok(r.ok);
  const v = r.view;
  assert.equal(v.bars, 150);
  assert.equal(v.volumeUnit, "股");
  assert.equal(v.marketLabel, "A 股");
  assert.deepEqual(Object.keys(v.series.ma).sort(), ["20", "5"]);
  assert.deepEqual(v.notes, ["示例说明"]);
});

test("K 线数据顺序是 [开, 收, 低, 高]，红涨绿跌", () => {
  const r = parseKline(toolResult());
  assert.ok(r.ok);
  const o = klineOption(r.view, P) as Obj;
  const k = o.series.find((s: Obj) => s.type === "candlestick");
  const s = r.view.series;
  assert.deepEqual(k.data[1], [s.open[1], s.close[1], s.low[1], s.high[1]]);
  assert.equal(k.itemStyle.color, "RED");
  assert.equal(k.itemStyle.color0, "GREEN");
  const vol = o.series.find((x: Obj) => x.name === "成交量");
  assert.equal(vol.data[0].itemStyle.color, "RED", "收涨那根量柱是红的");
  assert.equal(vol.data[1].itemStyle.color, "GREEN", "收跌那根量柱是绿的");
  assert.equal(barRises(s, 0), true);
  assert.equal(barRises(s, 1), false);
});

test("均线按窗口从小到大，热身期是空位不连线", () => {
  const r = parseKline(toolResult());
  assert.ok(r.ok);
  const o = klineOption(r.view, P) as Obj;
  const ma = o.series.filter((s: Obj) => s.type === "line");
  assert.deepEqual(ma.map((s: Obj) => s.name), ["MA5", "MA20"]);
  assert.equal(ma[0].data[0], "-");
  assert.equal(ma[0].data[4], 12);
  assert.deepEqual(o.legend.data, ["MA5", "MA20"]);
});

test("成交量单位确认不了就不画量图，只剩一个价格区", () => {
  const r = parseKline(toolResult(150, { volume_unit: null }));
  assert.ok(r.ok);
  const o = klineOption(r.view, P) as Obj;
  assert.equal(o.series.some((s: Obj) => s.name === "成交量"), false);
  assert.equal(o.grid.length, 1);
  assert.equal(o.xAxis.length, 1);
  assert.deepEqual(o.dataZoom[0].xAxisIndex, [0]);
});

test("默认只显示最近一段：日线 120 根，量价两区一起缩放", () => {
  const r = parseKline(toolResult(150));
  assert.ok(r.ok);
  const o = klineOption(r.view, P) as Obj;
  assert.equal(o.dataZoom[0].startValue, 30);
  assert.equal(o.dataZoom[0].endValue, 149);
  assert.deepEqual(o.dataZoom[1].xAxisIndex, [0, 1]);
  assert.equal(o.dataZoom[0].zoomOnMouseWheel, "ctrl", "普通滚轮要留给页面滚动，不能被图表吃掉");
  assert.equal(o.dataZoom[0].moveOnMouseWheel, false);
  const few = parseKline(toolResult(40));
  assert.ok(few.ok);
  assert.equal((klineOption(few.view, P) as Obj).dataZoom[0].startValue, 0, "不够 120 根就全显示");
});

test("悬停框列出开高低收与涨跌，不出买卖点或信号", () => {
  const r = parseKline(toolResult());
  assert.ok(r.ok);
  const o = klineOption(r.view, P) as Obj;
  const html = o.tooltip.formatter([{ dataIndex: 5 }]) as string;
  for (const w of ["开盘", "最高", "最低", "收盘", "涨跌幅", "成交量", "MA5"]) assert.ok(html.includes(w), w);
  assert.equal(o.tooltip.formatter([{ dataIndex: 999 }]), "");
  const blob = JSON.stringify(o) + html;
  for (const w of ["买点", "卖点", "信号", "markPoint", "目标价"]) assert.equal(blob.includes(w), false, w);
});

test("数字格式", () => {
  assert.equal(fmtPrice(1688.5), "1688.50");
  assert.equal(fmtPrice(3.4567), "3.457");
  assert.equal(fmtPrice(null), "—");
  assert.equal(fmtVolume(123_456_789), "1.23亿");
  assert.equal(fmtVolume(56_000), "5.6万");
  assert.equal(fmtVolume(3_400_000), "340万");
  assert.equal(fmtVolume(800), "800");
  assert.equal(fmtChange(0.0123), "+1.23%");
  assert.equal(fmtChange(-0.05), "-5.00%");
  assert.equal(fmtChange(null), "—");
});

test("研究页接上走势卡：走 K 线工具、要序列、切换时丢掉旧请求", () => {
  const page = readFileSync(new URL("../src/verticals/finance/pages/Research.tsx", import.meta.url), "utf8");
  const card = readFileSync(new URL("../src/verticals/finance/components/KlineCard.tsx", import.meta.url), "utf8");
  const chart = readFileSync(new URL("../src/verticals/finance/components/ui/EChart.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ KlineCard \} from "\.\.\/components\/KlineCard"/);
  assert.match(page, /<KlineCard symbol=\{chartSymbol\} \/>/);
  assert.match(card, /aShareCode \? \{ symbol, period, adjust, charts: true \} : \{ symbol, period, charts: true \}/);
  assert.match(card, /backend\.runTool<unknown>\("kline", body, ctl\.signal\)/);
  assert.match(card, /return \(\) => ctl\.abort\(\)/);
  assert.match(chart, /CandlestickChart, GridComponent/, "K 线图要按需注册，否则画出来是空白");
});
