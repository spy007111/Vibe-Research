import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register_tasks.ts";
import { ledgerUpsert, type ServiceContext } from "../src/service.ts";
import { listViews, runView } from "../src/views.ts";
import {
  CN_MAX, addDays, disclosureEvents, dividendEvents, earningsEvents, eventCalendar, isCnFundOrBond, ledgerEvents, lockupEvents, macroEvents, quoteNames, reportName,
} from "../src/finance/events.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const name = (s: string) => ({ "600519": "贵州茅台", "300308": "中际旭创", AAPL: "苹果" } as Record<string, string>)[s] ?? "";
const F = "2026-10-08", T = "2026-11-07";
const env = (...evidence: Record<string, unknown>[]) => ({ status: "ok", evidence });
const rec = (kind: string, fields: Record<string, unknown>) => ({ id: `${kind}-${Math.random()}`, kind, created_at: "", updated_at: "", ...fields });

test("日期与报告期", () => {
  assert.equal(addDays("2026-10-08", 30), "2026-11-07");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.deepEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31", "x"].map(reportName), ["2026 一季报", "2026 半年报", "2026 三季报", "2026 年报", "定期报告"]);
});

test("预约披露:窗口内进时间轴,过了预约日还没披露进「已过期」,窗口外不要", () => {
  const ok = disclosureEvents("600519", env({ field: "next_report_appoint_date", value: "2026-10-31", period: "2026-09-30", fetched_at: "t" }, { field: "latest_report_published_date", value: "2026-08-15", period: "2026-06-30" }), F, T, name);
  assert.deepEqual(ok.events.map((e) => [e.date, e.title, e.name, e.source]), [["2026-10-31", "2026 三季报预约披露", "贵州茅台", "东方财富 · 定期报告预约披露表"]]);
  assert.equal(ok.overdue.length, 0);
  const late = disclosureEvents("600519", env({ field: "next_report_appoint_date", value: "2026-09-28", period: "2026-06-30", fetched_at: "2026-10-08T01:00:00Z" }), F, T, name);
  assert.deepEqual(late.overdue.map((e) => e.title), ["2026 半年报已过预约披露日,还没披露"]);
  // 表是预约日当天(北京时间)或更早取的、或者不知道几时取的:看不到当天的披露,不说「还没披露」
  for (const at of ["2026-09-28T15:59:00Z", "2026-09-27T01:00:00Z", undefined, "坏的"]) {
    const r = disclosureEvents("600519", env({ field: "next_report_appoint_date", value: "2026-09-28", period: "2026-06-30", fetched_at: at }), F, T, name);
    assert.deepEqual([r.overdue.length, r.events.length], [0, 0], String(at));
  }
  // 北京时间 09-29 00:30(UTC 还是 09-28)取的表已经过了预约日
  assert.equal(disclosureEvents("600519", env({ field: "next_report_appoint_date", value: "2026-09-28", period: "2026-06-30", fetched_at: "2026-09-28T16:30:00Z" }), F, T, name).overdue.length, 1);
  assert.equal(disclosureEvents("600519", env({ field: "next_report_appoint_date", value: "2027-01-20", period: "2026-12-31" }), F, T, name).events.length, 0);
});

test("限售解禁:只用实际解禁数量,不把解禁后流通股本当成解禁数", () => {
  const e = env(
    { field: "lockup_shares", value: 74704.356, period: "2026-10-20", note: "待解禁:定向增发机构配售股份", record_key: "up|2026-10-20|0|定向增发机构配售股份" },
    { field: "lockup_able_shares", value: 8708, period: "2026-10-20", note: "待解禁:定向增发机构配售股份", record_key: "up|2026-10-20|0|定向增发机构配售股份" },
    { field: "lockup_ratio_of_total", value: 0.1166, period: "2026-10-20", note: "待解禁:定向增发机构配售股份" },
    // 同一批在历史段里又出现一次
    { field: "lockup_able_shares", value: 8708, period: "2026-10-20", note: "历史解禁:定向增发机构配售股份", record_key: "hist|2026-10-20|0|定向增发机构配售股份" },
    { field: "lockup_able_shares", value: 100, period: "2022-05-05", note: "历史解禁:首发原股东限售股份" },
  );
  const out = lockupEvents("300308", e, F, T, name);
  assert.deepEqual(out.map((x) => [x.date, x.title, x.detail]), [["2026-10-20", "限售股解禁", ["实际解禁 8,708 万股", "类型:定向增发机构配售股份"]]]);
  assert.doesNotMatch(JSON.stringify(out), /74,704|11\.6/);
});

test("除权除息:按每 10 股写(来源字段是每 10 股派现),送转合并成一行", () => {
  const e = env(
    { field: "dividend_pretax_per_10_shares", value: 280.2423, period: "2026-10-26", note: "进度=实施分配;报告期=2026-06-30;源字段 PRETAX_BONUS_RMB 口径" },
    { field: "transfer_per_10_shares", value: 4, period: "2026-10-26", note: "进度=实施分配" },
    { field: "bonus_per_10_shares", value: 0, period: "2026-10-26", note: "进度=实施分配" },
    { field: "dividend_pretax_per_share", value: 239.57, period: "2025-12-19", note: "进度=实施分配" },
    { field: "dividend_record_count", value: 47, period: "2016-07-01..2026-10-26" },
  );
  assert.deepEqual(dividendEvents("600519", e, F, T, name).map((x) => [x.date, x.detail]),
    [["2026-10-26", ["每 10 股派 280.2423 元(税前),每 10 股转增 4 股", "进度:实施分配"]]]);
  // 旧字段名(缓存里的)照认
  const old = env({ field: "dividend_pretax_per_share", value: 239.57, period: "2026-10-20", note: "进度=实施分配" });
  assert.deepEqual(dividendEvents("600519", old, F, T, name).map((x) => x.detail[0]), ["每 10 股派 239.57 元(税前)"]);
});

test("美股财报日:预估日标出来,写明是美东日期", () => {
  const e = env(
    { field: "us_anchor_earnings_date", value: "2026-10-29", period: "2026-09-30", symbol: "AAPL", record_key: "AAPL", note: "AAPL 下一个财报日:预估日(交易所 / Zacks 口径,带 * );after market;财季止 2026-09-30;" },
    { field: "us_anchor_earnings_date", value: "2026-11-05", period: "n/a", symbol: "NVDA", record_key: "NVDA", note: "NVDA 下一个财报日:Nasdaq 页面日期,确认状态未核实(公司确认以 IR 为准);" },
    { field: "us_anchor_earnings_date", value: "2027-01-28", symbol: "MSFT" },
  );
  const out = earningsEvents(e, F, T, name);
  assert.deepEqual(out.map((x) => [x.symbol, x.date, x.estimated]), [["AAPL", "2026-10-29", true], ["NVDA", "2026-11-05", false]]);
  assert.deepEqual(out[0]!.detail, ["预估日(交易所 / Zacks 口径),不是公司确认的日期", "日期按美东时间", "财季止 2026-09-30"]);
  assert.equal(out[0]!.name, "苹果");
});

test("宏观日历:来源占位的 12:02 不当成时刻,预期和前值带单位", () => {
  const out = macroEvents(env(
    { field: "macro_event_count", value: 64, period: "2026-10-09..2026-11-06" },
    { field: "macro_event", value: "9月CPI同比", period: "2026-10-14", note: "time=2026-10-14 09:30;country=中国;importance=4;previous=0.8;unit=%;period=月" },
    { field: "macro_event", value: "台积电第三季法说会", period: "2026-10-15", note: "time=2026-10-15 12:02;country=中国;importance=3" },
    { field: "macro_event", value: "  ", period: "2026-10-15", note: "" },
  ), F, T);
  assert.deepEqual(out.map((x) => [x.date, x.name, x.title, x.detail]), [
    ["2026-10-14", "中国", "9月CPI同比", ["北京时间 09:30", "前值 0.8%"]],
    ["2026-10-15", "中国", "台积电第三季法说会", []],
  ]);
});

test("台账:只算没处理的;过期的单独列出;证伪条件、复核、待办各有名字", () => {
  const recs = {
    criterion: [
      rec("criterion", { symbol: "600519", type: "decision_point", statement: "批发价回到 2000", due: "2026-10-31", status: "pending" }),
      rec("criterion", { symbol: "300308", type: "decision_point", statement: "800G 过半", due: "2026-09-30" }),
      rec("criterion", { symbol: "300308", type: "falsifier", statement: "毛利率跌破 30%", due: "2026-10-20", status: "pending" }),
      rec("criterion", { symbol: "600519", type: "decision_point", statement: "已判", due: "2026-10-10", status: "met" }),
      rec("criterion", { type: "falsifier", statement: "没写日期" }),
    ],
    thesis: [rec("thesis", { symbol: "AAPL", title: "服务收入占比提升", review_by: "2026-10-30", status: "active" }), rec("thesis", { title: "关掉的", review_by: "2026-10-12", status: "closed" })],
    action: [rec("action", { title: "看法说会纪要", due: "2026-10-16", status: "open" }), rec("action", { title: "做完了", due: "2026-10-16", status: "done" })],
  };
  const out = ledgerEvents(recs as never, F, T, name);
  assert.deepEqual(out.events.map((e) => [e.date, e.kind, e.title, e.detail[0], e.name]), [
    ["2026-10-31", "criterion", "裁决点到期", "批发价回到 2000", "贵州茅台"],
    ["2026-10-20", "criterion", "证伪条件到期", "毛利率跌破 30%", "中际旭创"],
    ["2026-10-30", "review", "论点复核日", "服务收入占比提升", "苹果"],
    ["2026-10-16", "action", "待办到期", "看法说会纪要", ""],
  ]);
  assert.deepEqual(out.overdue.map((e) => [e.date, e.title, e.symbol]), [["2026-09-30", "裁决点到期", "300308"]]);
  assert.ok(out.events.every((e) => e.source === "我的台账" && e.ref));
});

test("名字:腾讯批量行情的 note 补名字;基金 / 债券码单独识别", () => {
  const names = quoteNames({ evidence: [
    { field: "price", value: 1, record_key: "300750", note: "宁德时代(sz300750)" },
    { field: "change_pct", value: 1, record_key: "300750", note: "别的(sz300750)" },
    { field: "price", value: 1, record_key: "hk00700", note: "腾讯控股(hk00700)" },
    { field: "price", value: 1, record_key: "usAAPL", note: "苹果(usAAPL)" },
    { field: "price", value: 1, record_key: "usMSFT", note: "" },
  ] });
  assert.deepEqual([...names], [["300750", "宁德时代"], ["00700.HK", "腾讯控股"], ["AAPL", "苹果"]]);
  assert.deepEqual(["510300", "159915", "113050", "600519", "300750", "688981", "000001", "830799"].map(isCnFundOrBond), [true, true, true, false, false, false, false, false]);
});

test("视图在 API 入口注册;没有的视图报 not_found", async () => {
  assert.ok(listViews().some((v) => v.id === "calendar" && v.label === "事件日历"));
  await assert.rejects(runView({} as never, "nope", {}, new AbortController().signal), /没有这个视图/);
});

test("整合:来源全取不到时每一项都进 gaps,台账照常出;港股如实说没有来源;A 股超量只查前 30 只", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-cal-"));
  // python 指向 false:任何取数都失败,不联网
  const ctx: ServiceContext = { repoRoot: REPO, dataRoot, python: "false", node: process.execPath };
  try {
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "300308", name: "中际旭创", shares: 1, cost: 1 } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "300308", name: "" } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "AAPL", name: "苹果" } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "00700.HK", name: "腾讯控股" } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "510300", name: "沪深300ETF" } });
    ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "300308", type: "decision_point", statement: "800G 过半", due: "2026-10-20", status: "pending" } });
    const now = new Date("2026-10-08T09:00:00Z");
    const r = await eventCalendar(ctx, { days: "999" }, new AbortController().signal, now);
    // days 超上限按 90 天算
    assert.deepEqual(r.window, { from: "2026-10-08", to: "2027-01-06", days: 90 });
    assert.deepEqual(r.symbols.map((s) => [s.symbol, s.name, s.origin]), [["300308", "中际旭创", ["持有", "自选"]], ["AAPL", "苹果", ["自选"]], ["00700.HK", "腾讯控股", ["自选"]], ["510300", "沪深300ETF", ["自选"]]]);
    assert.deepEqual(r.events.map((e) => [e.date, e.kind, e.name]), [["2026-10-20", "criterion", "中际旭创"]]);
    for (const g of ["中际旭创 300308 预约披露:没取到", "中际旭创 300308 限售解禁:没取到", "中际旭创 300308 分红送转:没取到", "美股财报日:没取到", "宏观日历:没取到", "港股 腾讯控股 00700.HK:目前没有可用的逐只事件来源,没查", "基金 / 债券 沪深300ETF 510300:预约披露、解禁、分红这几个来源只有股票,没查"]) {
      assert.ok(r.gaps.some((x) => x.startsWith(g)), `缺少 gap:${g}\n${r.gaps.join("\n")}`);
    }
    assert.ok(!r.gaps.some((g) => /510300 (预约披露|限售解禁|分红送转)/.test(g)), "基金不去查股票的表");
    // 不传 days 用 30;macro=0 不查宏观
    const r2 = await eventCalendar(ctx, { macro: "0" }, new AbortController().signal, now);
    assert.equal(r2.window.days, 30);
    assert.ok(!r2.gaps.some((g) => g.startsWith("宏观日历")));

    for (let i = 0; i < CN_MAX + 2; i++) ledgerUpsert(ctx, { kind: "watch", record: { symbol: String(600000 + i * 3).padStart(6, "0") } });
    const r3 = await eventCalendar(ctx, { macro: "0" }, new AbortController().signal, now);
    assert.ok(r3.gaps.includes(`A 股只查了前 ${CN_MAX} 只(持有优先),另有 3 只没查`), r3.gaps.filter((g) => g.startsWith("A 股")).join());
    assert.ok(r3.gaps.some((g) => g.startsWith("中际旭创 300308 预约披露")), "持有的排在前面,一定被查到");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
