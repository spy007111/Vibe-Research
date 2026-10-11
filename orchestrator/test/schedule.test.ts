import assert from "node:assert/strict";
import { test } from "node:test";

import "../src/finance/register_tasks.ts";
import { currentSchedule, validateSchedule } from "../src/notify.ts";
import { FINANCE_SCHEDULE, closeDigestMessage, gateFromCalendar, quoteCodeOf, symbolOfQuoteKey, watchMessage } from "../src/finance/schedule.ts";
import type { PageResult } from "../src/service.ts";

const cal = (day: string, isToday: boolean, period = day) => ({
  status: "ok",
  evidence: [
    { field: "last_trading_day", value: isToday ? day : "2026-10-09", period },
    { field: "previous_trading_day", value: "2026-09-30", period },
    { field: "is_today_trading_day", value: isToday, period },
    { field: "session_phase", value: isToday ? "post_close" : "non_trading_day", period },
  ],
});

test("金融定时任务在 API 入口注册,形状合法", () => {
  assert.equal(currentSchedule(), FINANCE_SCHEDULE);
  validateSchedule(FINANCE_SCHEDULE);
  assert.equal(FINANCE_SCHEDULE.timeZone, "Asia/Shanghai");
  assert.deepEqual(FINANCE_SCHEDULE.jobs.map((j) => [j.id, j.at]), [["close_digest", "15:40"], ["watch_changes", "16:15"], ["verdict_due", "16:30"]]);
});

test("门判定:交易日开、休市关、日期对不上或取不到都算取不到(不当成开市)", () => {
  assert.deepEqual(gateFromCalendar(cal("2026-10-08", true), "2026-10-08"), { status: "open" });
  assert.deepEqual(gateFromCalendar(cal("2026-10-10", false), "2026-10-10"), { status: "closed", reason: "今天 A 股休市" });
  // 跨午夜:日历是按昨天算的「今天是交易日」,不能拿来判断今天
  assert.equal(gateFromCalendar(cal("2026-10-08", true), "2026-10-09").status, "unavailable");
  const failed = gateFromCalendar({ status: "failed", evidence: [], errors: [{ source: "baostock" }] }, "2026-10-08");
  assert.equal(failed.status, "unavailable");
  assert.match((failed as { reason: string }).reason, /baostock/);
  assert.equal(gateFromCalendar(undefined, "2026-10-08").status, "unavailable");
});

test("周末不联网直接不跑", async () => {
  const sat = new Date("2026-10-10T08:00:00Z");   // 北京时间周六 16:00
  const g = await FINANCE_SCHEDULE.gate({ ctx: { repoRoot: "/nonexistent", dataRoot: "/nonexistent", python: "false", node: process.execPath }, day: "2026-10-10", now: sat, signal: new AbortController().signal });
  assert.deepEqual(g, { status: "closed", reason: "周末休市" });
});

const ev = (field: string, value: unknown, extra: Record<string, unknown> = {}) => ({ field, value, period: "2026-10-08", ...extra });

function reviewPage(over: Partial<Record<string, { status: string; envelope?: unknown }>> = {}, context: Record<string, unknown> = { review_date: "2026-10-08", review_reason: "今天已收盘,显示今天" }): PageResult {
  const blocks: Record<string, { status: string; envelope?: unknown }> = {
    sentiment: { status: "ok", envelope: { evidence: [ev("limit_up_count", 43), ev("break_board_count", 12), ev("limit_down_count", 5)] } },
    zt_pool: { status: "ok", envelope: { evidence: [
      ev("pool_limit_days", 3, { record_key: "002058", note: "002058 紫竹高科 电池 3天3板 首封 09:25:00" }),
      ev("pool_limit_days", 1, { record_key: "600000", note: "600000 某银行 银行 首板" }),
    ] } },
    board_flow: { status: "ok", envelope: { evidence: [
      ev("board_main_net_today", 1.23e9, { record_key: "BK1", note: "半导体 排名 1" }),
      ev("board_main_net_today", 4.5e8, { record_key: "BK2", note: "电池 排名 2" }),
      ev("board_main_net_today", -8.1e8, { record_key: "BK3", note: "银行 排名 496" }),
    ] } },
    dragon: { status: "ok", envelope: { evidence: [
      ev("dragon_tiger_market_net_buy", 1, { record_key: "002384|日跌幅偏离值达到7%" }),
      ev("dragon_tiger_market_change_pct", -10, { record_key: "002384|日跌幅偏离值达到7%" }),
      ev("dragon_tiger_market_net_buy", 2, { record_key: "002384|连续三个交易日" }),
      ev("dragon_tiger_market_net_buy", 3, { record_key: "300308|日涨幅偏离值达到7%" }),
    ] } },
    ...over,
  };
  return { query: "review", title: "每日复盘", intent: "", context, oldest_fetched_at: null, mixed_ages: false,
    blocks: Object.entries(blocks).map(([id, b]) => ({ id, title: id, status: b!.status as never, ...(b!.envelope ? { envelope: b!.envelope as Record<string, unknown> } : {}) })) };
}

const indices = { evidence: [
  ev("change_pct", -0.79, { record_key: "sh000001", note: "上证指数(sh000001)" }),
  ev("change_pct", 1.2, { record_key: "sz399006", note: "创业板指(sz399006)" }),
  ev("change_pct", 0.5, { record_key: "usIXIC", note: "纳斯达克(usIXIC)", period: "2026-10-07" }),
] };

test("收盘摘要:只列事实,上榜按只数去重,美股指数不混进 A 股行", () => {
  const m = closeDigestMessage(reviewPage(), indices, "2026-10-08");
  assert.equal(m.title, "收盘摘要 2026-10-08");
  assert.equal(m.dedupeKey, "close_digest:2026-10-08");
  assert.equal(m.link, "/daily-review");
  assert.deepEqual(m.lines, [
    "复盘日 2026-10-08(今天已收盘,显示今天)",
    "指数 上证指数 -0.79% · 创业板指 +1.20%",
    "涨停 43 · 炸板 12 · 跌停 5",
    "最高连板 3 板(紫竹高科)",
    "主力净流入前三 半导体 +12.3 亿、电池 +4.5 亿",
    "主力净流出前三 银行 -8.1 亿",
    "龙虎榜 上榜 2 只",
  ]);
  assert.doesNotMatch(m.lines.join("\n"), /建议|关注|买|卖|看好|评分/);
});

test("收盘摘要:块没取到如实写「没取到」,不写成 0", () => {
  const m = closeDigestMessage(reviewPage({ sentiment: { status: "missing" }, board_flow: { status: "failed" }, dragon: { status: "missing" } }), undefined, "2026-10-08");
  assert.ok(m.lines.includes("指数:没取到"));
  assert.ok(m.lines.includes("涨停 / 跌停:没取到"));
  assert.ok(m.lines.includes("板块资金流:没取到"));
  assert.ok(m.lines.includes("龙虎榜:没取到"));
  assert.doesNotMatch(m.lines.join("\n"), /涨停 0|上榜 0/);
  // 取到了但还是空表(收盘后还没公布):不写「上榜 0 只」
  const empty = closeDigestMessage(reviewPage({ dragon: { status: "partial", envelope: { evidence: [] } } }), indices, "2026-10-08");
  assert.ok(empty.lines.includes("龙虎榜:还没有数据(可能还没公布)"), empty.lines.join("\n"));
});

test("收盘摘要:复盘日不是今天时(盘中手动运行),标出资金流是今天的", () => {
  const m = closeDigestMessage(reviewPage({}, { review_date: "2026-09-30", review_reason: "今天还没收盘,显示上一个交易日" }), indices, "2026-10-08");
  assert.equal(m.title, "收盘摘要 2026-09-30");
  assert.ok(m.lines.some((l) => l.startsWith("主力净流入前三(今天的)")));
  assert.match(m.lines[1]!, /\(行情日 2026-10-08\)$/);
});

test("收盘摘要:东财不通、板块资金流换新浪时,用新浪净额并标口径(第四轮审计 B1)", () => {
  const sinaFlow = { status: "ok", envelope: { evidence: [
    ev("board_net_sina", 9.8e8, { record_key: "new_blhy", note: "玻璃行业 排名 1;领涨 某玻璃;新浪口径(流入 − 流出),不是东财主力净额" }),
    ev("board_inflow_sina", 3e9, { record_key: "new_blhy", note: "玻璃行业 排名 1;领涨 某玻璃;新浪口径(流入 − 流出),不是东财主力净额" }),
    ev("board_net_sina", -2.1e8, { record_key: "new_yh", note: "银行 排名 49;领涨 某银行;新浪口径(流入 − 流出),不是东财主力净额" }),
  ] } };
  const m = closeDigestMessage(reviewPage({ board_flow: sinaFlow }), indices, "2026-10-08");
  assert.ok(m.lines.includes("板块净流入前三(新浪口径) 玻璃行业 +9.8 亿"), m.lines.join("\n"));
  assert.ok(m.lines.includes("板块净流出前三(新浪口径) 银行 -2.1 亿"), m.lines.join("\n"));
  assert.ok(!m.lines.includes("板块资金流:没取到"));
  assert.doesNotMatch(m.lines.join("\n"), /主力净/);
});

test("代码换算:台账规范形 ↔ 腾讯批量行情", () => {
  assert.deepEqual(["600519", "00700.HK", "AAPL", "BRK.B"].map(quoteCodeOf), ["600519", "hk00700", "usAAPL", "usBRK.B"]);
  assert.deepEqual(["sh600519", "600519", "hk00700", "hk700", "usAAPL", "usBRK.B"].map(symbolOfQuoteKey), ["600519", "600519", "00700.HK", "00700.HK", "AAPL", "BRK.B"]);
});

test("自选变化:按幅度排序,港美股标出不同的行情日,新公告与没取到的分开写", () => {
  const quotes = { evidence: [
    ev("change_pct", 1.1, { record_key: "sh600519", note: "贵州茅台(sh600519)" }),
    ev("change_pct", -4.2, { record_key: "hk00700", note: "腾讯控股(hk00700)" }),
    ev("change_pct", 0.3, { record_key: "usAAPL", note: "苹果(usAAPL)", period: "2026-10-07" }),
  ] };
  const m = watchMessage("2026-10-08",
    [{ symbol: "600519", name: "贵州茅台" }, { symbol: "00700.HK", name: "" }, { symbol: "AAPL", name: "苹果" }, { symbol: "300308", name: "中际旭创" }],
    quotes, [{ symbol: "600519", key: "AN1", title: "贵州茅台:关于召开业绩说明会的公告", date: "2026-10-08" }], ["300308"], 0);
  assert.equal(m.dedupeKey, "watch_changes:2026-10-08");
  assert.deepEqual(m.lines, [
    "涨跌(按幅度排,括号里是不同于今天的行情日):",
    "腾讯控股 00700.HK -4.20%",
    "贵州茅台 600519 +1.10%",
    "苹果 AAPL +0.30%(2026-10-07)",
    "没取到行情:中际旭创 300308",
    "新公告 1 条:",
    "贵州茅台 600519 2026-10-08 关于召开业绩说明会的公告",
    "公告没取到:中际旭创 300308",
  ]);
});

test("自选变化:公告标题开头的公司名(半角或全角冒号)不重复写", () => {
  const m = watchMessage("2026-10-08", [{ symbol: "300308", name: "中际旭创" }], undefined,
    [{ symbol: "300308", key: "a", title: "中际旭创：关于股份回购结果的公告", date: "2026-10-08" }, { symbol: "300308", key: "b", title: "中际旭创:H股公告", date: "2026-10-08" }], [], 0);
  assert.ok(m.lines.includes("中际旭创 300308 2026-10-08 关于股份回购结果的公告"));
  assert.ok(m.lines.includes("中际旭创 300308 2026-10-08 H股公告"));
});

test("自选变化:没有新公告时只说查到了的那几只;全没取到不说「没有」;自选里没有 A 股另说", () => {
  const w = [{ symbol: "600519", name: "贵州茅台" }, { symbol: "300308", name: "中际旭创" }, { symbol: "AAPL", name: "苹果" }];
  const lines = (failed: string[], skipped = 0, watch = w) => watchMessage("2026-10-08", watch, undefined, [], failed, skipped).lines;
  assert.ok(lines([]).includes("已查的 2 只 A 股没有新公告(港股、美股不查公告)"));
  assert.ok(lines(["300308"]).includes("已查的 1 只 A 股没有新公告(港股、美股不查公告)"));
  const all = lines(["600519", "300308"]);
  assert.ok(!all.some((l) => /没有新公告/.test(l)), all.join("\n"));
  assert.ok(all.includes("公告没取到:贵州茅台 600519、中际旭创 300308"));
  assert.ok(lines([], 0, [{ symbol: "AAPL", name: "苹果" }]).includes("自选里没有 A 股,没查公告"));
  assert.ok(lines([], 0, w.slice(0, 2)).includes("已查的 2 只 A 股没有新公告"));
});
