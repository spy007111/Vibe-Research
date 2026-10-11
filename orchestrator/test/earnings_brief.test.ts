import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { complianceGate } from "../src/gate.ts";
import { detectPython } from "../src/init.ts";
import { ServiceError, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { TIMING_LABEL, earningsBrief, parseAppoint, parseForecasts, timingOf, yahooBars } from "../src/finance/earnings_brief.ts";
import { TIMING_LABEL as UI_TIMING_LABEL } from "../../desktop/src/verticals/finance/lib/earningsBrief.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const NP = "归属于上市公司股东的净利润";
/** 美东夏令时 / 冬令时、香港时间 → epoch 秒 */
const et = (s: string, dst = true) => Date.parse(`${s}${dst ? "-04:00" : "-05:00"}`) / 1000;
const hkt = (s: string) => Date.parse(`${s}+08:00`) / 1000;

test("发布时段的名字:前后端一致", () => {
  assert.deepEqual(UI_TIMING_LABEL, TIMING_LABEL);
});

test("发布时刻 → 交易所当地日期与盘前 / 盘中 / 盘后;当地 00:00 当作时刻不明", () => {
  assert.deepEqual(timingOf(et("2025-10-30T16:30:00"), "US"), { day: "2025-10-30", local: "2025-10-30 16:30", timing: "after_close" });
  assert.deepEqual(timingOf(et("2026-01-29T16:00:00", false), "US"), { day: "2026-01-29", local: "2026-01-29 16:00", timing: "after_close" }, "16:00 整算收盘后");
  assert.equal(timingOf(et("2026-01-29T15:59:00", false), "US").timing, "during");
  assert.equal(timingOf(et("2026-04-30T09:29:00"), "US").timing, "before_open");
  assert.equal(timingOf(et("2026-04-30T09:30:00"), "US").timing, "during", "09:30 整算盘中");
  assert.deepEqual(timingOf(et("2026-07-30T00:00:00"), "US"), { day: "2026-07-30", local: "2026-07-30 00:00", timing: null });
  // 美东 20:30 = 香港次日 09:30:按香港时间是次日盘中
  assert.deepEqual(timingOf(et("2025-11-12T20:30:00", false), "HK"), { day: "2025-11-13", local: "2025-11-13 09:30", timing: "during" });
  assert.equal(timingOf(hkt("2025-11-13T16:30:00"), "HK").timing, "after_close");
});

test("Yahoo 日 K:按交易所当地日期;有复权价整列用复权价、不和未复权价混用;坏值跳过", () => {
  const ts = [et("2026-01-02T09:30:00", false), et("2026-01-05T09:30:00", false), et("2026-01-06T09:30:00", false), et("2026-01-07T09:30:00", false)];
  const doc = (adj: unknown[] | null) => ({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: [10, 11, 12, 13] }], ...(adj ? { adjclose: [{ adjclose: adj }] } : {}) } }] } });
  assert.deepEqual(yahooBars(doc([5, 5.5, null, 6.5]), "US"), [{ date: "2026-01-02", close: 5 }, { date: "2026-01-05", close: 5.5 }, { date: "2026-01-07", close: 6.5 }],
    "复权价缺一根就跳过这一根,不拿未复权价补");
  assert.deepEqual(yahooBars(doc(null), "US").map((b) => b.close), [10, 11, 12, 13]);
  assert.deepEqual(yahooBars(doc([null, null, null, null]), "US").map((b) => b.close), [10, 11, 12, 13], "复权列全空才退回收盘价");
  assert.deepEqual(yahooBars(doc([1, 0, -1, "x"]), "US").map((b) => b.close), [1]);
  for (const d of [null, {}, { chart: { result: [] } }, { chart: { result: [{ timestamp: "x" }] } }]) assert.deepEqual(yahooBars(d, "US"), []);
});

test("预约披露表:去重、去空格、按报告期从新到旧;业绩预告只要归母净利、同一期取最新公告", () => {
  const rows = parseAppoint({ result: { data: [
    { REPORT_TYPE_NAME: "2026年 半年报", REPORT_DATE: "2026-06-30 00:00:00", ACTUAL_PUBLISH_DATE: "2026-08-15 00:00:00", APPOINT_PUBLISH_DATE: "2026-08-15 00:00:00", FIRST_APPOINT_DATE: "2026-08-15 00:00:00" },
    { REPORT_TYPE_NAME: "2026年 三季报", REPORT_DATE: "2026-09-30 00:00:00", ACTUAL_PUBLISH_DATE: null, APPOINT_PUBLISH_DATE: "2026-10-24 00:00:00", FIRST_APPOINT_DATE: "2026-10-20 00:00:00", FIRST_CHANGE_DATE: "2026-09-28 00:00:00" },
    { REPORT_TYPE_NAME: "重复", REPORT_DATE: "2026-09-30 00:00:00" }, { REPORT_DATE: "bad" }, null, "x",
    { REPORT_DATE: "2025-12-31" },
  ] } });
  assert.deepEqual(rows, [
    { period: "2026-09-30", label: "2026年三季报", actual: null, appoint: "2026-10-24", first: "2026-10-20", changed: true },
    { period: "2026-06-30", label: "2026年半年报", actual: "2026-08-15", appoint: "2026-08-15", first: "2026-08-15", changed: false },
    { period: "2025-12-31", label: "2025-12-31", actual: null, appoint: null, first: null, changed: false },
  ]);
  for (const d of [null, {}, { result: null }, { result: { data: "x" } }]) assert.deepEqual(parseAppoint(d), []);
  const fc = parseForecasts({ rows: [
    { indicator: NP, report_date: "2026-06-30", notice_date: "2026-07-10", forecast_type: "预增", amount_lower: 1e10, amount_upper: 1.2e10, change_pct_lower: 10, change_pct_upper: 30 },
    { indicator: NP, report_date: "2026-06-30", notice_date: "2026-07-01", forecast_type: "旧", amount_lower: 1, amount_upper: 2 },
    { indicator: "营业收入", report_date: "2026-09-30", notice_date: "2026-10-05", amount_lower: 1, amount_upper: 2 },
    { indicator: NP, report_date: "2025-12-31", notice_date: "2026-01-05", forecast_type: "首次", amount_lower: 1, amount_upper: 2 },
    { indicator: NP, report_date: "2025-12-31", notice_date: "2026-01-20", forecast_type: "修正", amount_lower: 3, amount_upper: 4 },
    { indicator: NP, report_date: "2026-03-31", notice_date: null }, null,
  ] });
  assert.deepEqual([...fc.entries()], [
    ["2026-06-30", { period: "2026-06-30", notice_date: "2026-07-10", type: "预增", lower: 1e10, upper: 1.2e10, change_lower: 10, change_upper: 30 }],
    ["2025-12-31", { period: "2025-12-31", notice_date: "2026-01-20", type: "修正", lower: 3, upper: 4, change_lower: null, change_upper: null }],
  ]);
  assert.equal(parseForecasts(null).size, 0);
});

// ---------------------------------------------------------------- 整条链路(假取数器 + 真 calc)

/** 假取数器:fetch_endpoint.py 读 --endpoint;legacy 脚本(fetch_estimates.py / fetch_financials.py)按自己的文件名认端点 */
const FAKE = String.raw`import json,sys,os
a=sys.argv
ep=a[a.index('--endpoint')+1] if '--endpoint' in a else os.path.basename(a[0])[:-3]
out=a[a.index('--out-dir')+1]
sym=a[a.index('--symbol')+1] if '--symbol' in a else ''
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'sym':sym,'args':args})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
n=os.getpid()
def done(env): print(json.dumps(env,ensure_ascii=False)); sys.exit(0)
def raw(name,doc):
  ref='raw/%s_%d.json'%(name,n)
  json.dump(doc,open(os.path.join(out,ref),'w'),ensure_ascii=False)
  return ref
if ep in cfg.get('fail',[]): done({'status':'failed','evidence':[],'errors':[{'source':'fake','error':'HTTP 502'}]})
if ep=='next_disclosure':
  ref=raw('eastmoney_RPT_PUBLIC_BS_APPOIN',{'result':{'data':cfg['disc']}})
  done({'status':'ok','evidence':[{'field':'next_disclosure_date','value':'x','raw_ref':ref}]})
if ep=='earnings_forecast':
  ref=raw('extracted_eastmoney_forecast',{'rows':cfg['fc']})
  done({'status':'ok','evidence':[{'field':'forecast_count','value':len(cfg['fc']),'raw_ref':'raw/other_%d.json'%n},{'field':'forecast_count','value':len(cfg['fc']),'raw_ref':ref}]})
if ep in ('fetch_estimates','fetch_financials'):
  evs=cfg['est' if ep=='fetch_estimates' else 'fin']
  done({'status':'ok','evidence':evs})
if ep=='tx_kline':
  rows=cfg.get('klines',{}).get(sym,[])
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_tencent_tencent_kline_%s_%d.json'%(sym,n)
  json.dump({'rows':[{'date':d,'close':c} for d,c in rows]},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
if ep=='yahoo_analyst_estimates':
  ref=raw('yahoo_quoteSummary',cfg['yahoo'])
  done({'status':'ok','market':cfg.get('market','US'),'evidence':[{'field':'eps_estimate','value':1,'raw_ref':ref}]})
if ep=='yahoo_kline':
  ref=raw('yahoo_chart',cfg['ykline'])
  done({'status':'ok','market':cfg.get('market','US'),'evidence':[{'field':'close','value':1,'raw_ref':ref}]})
done({'status':'failed','reason':'unknown','evidence':[]})
`;

type Call = { ep: string; sym: string; args: Record<string, unknown> };
function fakeCtx(): ServiceContext & { setCfg(c: Record<string, unknown>): void; calls(): Call[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-earn-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  for (const f of ["fetch_endpoint.py", "fetch_estimates.py", "fetch_financials.py"]) fs.writeFileSync(path.join(scripts, f), FAKE);
  // 计算走真的 calc(runTool 在仓库根目录跑 python -m calc.tool)
  fs.cpSync(path.join(REPO, "calc"), path.join(repo, "calc"), { recursive: true, filter: (s) => !/(?:__pycache__|[\\/]tests)(?:[\\/]|$)/.test(s) });
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(dataRoot);
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } },
  };
}
const run = (ctx: ServiceContext, query: Record<string, string>, now: string) => earningsBrief(ctx, query, new AbortController().signal, new Date(now));
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });
const near = (a: number | null | undefined, b: number) => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

const appoint = (name: string, period: string, actual: string | null, extra: Record<string, unknown> = {}) =>
  ({ REPORT_TYPE_NAME: name, REPORT_DATE: `${period} 00:00:00`, ACTUAL_PUBLISH_DATE: actual ? `${actual} 00:00:00` : null, APPOINT_PUBLISH_DATE: actual ? `${actual} 00:00:00` : null, ...extra });
const CN_CFG = {
  disc: [
    appoint("2026年 三季报", "2026-09-30", null, { APPOINT_PUBLISH_DATE: "2026-10-24 00:00:00", FIRST_APPOINT_DATE: "2026-10-20 00:00:00", FIRST_CHANGE_DATE: "2026-09-28 00:00:00" }),
    appoint("2026年 半年报", "2026-06-30", "2026-08-15"),
    appoint("2026年 一季报", "2026-03-31", "2026-04-25"),
    appoint("2025年 年报", "2025-12-31", "2026-04-25"),
    appoint("2025年 三季报", "2025-09-30", "2025-10-25"),
    appoint("2025年 半年报", "2025-06-30", "2025-08-09"),
    appoint("2025年 一季报", "2025-03-31", null, { APPOINT_PUBLISH_DATE: "2025-04-26 00:00:00" }),  // 早于已披露的最新一期:不是下一期
    appoint("2026年 年报", "2026-12-31", null, { APPOINT_PUBLISH_DATE: "2027-03-28 00:00:00" }),    // 再下一期:下一期取最早的
  ],
  est: [
    { field: "eps_consensus_mean", period: "FY2027", value: 75 },
    { field: "eps_consensus_mean", period: "FY2026", value: 67.16 }, { field: "eps_consensus_min", period: "FY2026", value: 64.7 },
    { field: "eps_consensus_max", period: "FY2026", value: 70.97 }, { field: "eps_analyst_count", period: "FY2026", value: 46 },
  ],
  fc: [
    { indicator: NP, report_date: "2026-06-30", notice_date: "2026-07-10", forecast_type: "预增", amount_lower: 1e10, amount_upper: 1.2e10, change_pct_lower: 10, change_pct_upper: 30 },
    { indicator: NP, report_date: "2026-09-30", notice_date: "2026-10-05", forecast_type: "略增", amount_lower: 1.5e10, amount_upper: 1.6e10, change_pct_lower: 5, change_pct_upper: 12 },
    { indicator: "营业收入", report_date: "2026-06-30", notice_date: "2026-07-12", amount_lower: 1, amount_upper: 2 },
  ],
  fin: [{ field: "net_profit_parent_cum", period: "2026-06-30", value: 1.3e10 }, { field: "revenue_cum", period: "2026-06-30", value: 9e10 }],
  // 每次财报只给前一天和反应日两根,涨跌好手算:+4% / −2% / +6%(年报和一季报同一天)/ −5%
  klines: { "600519": [["2025-08-08", 100], ["2025-08-11", 104], ["2025-10-24", 100], ["2025-10-27", 98], ["2026-04-24", 50], ["2026-04-27", 53], ["2026-08-14", 200], ["2026-08-17", 190], ["2026-10-08", 191]] },
};
const CN_NOW = "2026-10-08T08:00:00Z";  // 北京时间 16:00,已收盘

test("视图已注册;symbol 写法不对、refresh 不是 1 → bad_query,什么都不取", async () => {
  assert.ok(listViews().some((v) => v.id === "earnings_brief" && v.label === "财报前瞻与复盘"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({});
    for (const q of [{}, { symbol: "" }, { symbol: "6005191" }, { symbol: "123" }, { symbol: "AAPL$" }, { symbol: "../x" }, { symbol: "600519", refresh: "true" }] as Record<string, string>[]) {
      await assert.rejects(run(ctx, q, CN_NOW), (e: unknown) => e instanceof ServiceError && e.code === "bad_query", JSON.stringify(q));
    }
    assert.deepEqual(ctx.calls(), []);
  } finally { cleanup(ctx); }
});

test("A 股:下一期预约日(改过期)、FY 一致预期与分歧、下一期业绩预告、过去几次的反应日涨跌与预告偏差;再开用缓存,重新取全部重取", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg(CN_CFG);
    const r = await run(ctx, { symbol: "600519" }, CN_NOW);
    assert.deepEqual(r.gaps, []);
    assert.equal(r.market, "CN");
    assert.deepEqual(r.upcoming, { period: "2026-09-30", label: "2026年三季报", date: "2026-10-24", days: 16, note: "东财预约披露日,公司可以改期,以交易所公告为准;首次预约 2026-10-20,已改期" });
    assert.equal(r.consensus?.label, "FY2026 全年每股收益一致预期(全年的,不是这一季的)");
    assert.deepEqual([r.consensus?.mean, r.consensus?.low, r.consensus?.high, r.consensus?.count, r.consensus?.unit], [67.16, 64.7, 70.97, 46, "元/股"]);
    near(r.consensus?.dispersion?.value, 70.97 / 64.7);
    assert.equal(r.consensus?.dispersion?.display, "1.10 倍");
    assert.deepEqual(r.forecast, { period: "2026-09-30", notice_date: "2026-10-05", type: "略增", lower: 1.5e10, upper: 1.6e10, change_lower: 5, change_upper: 12 });

    assert.deepEqual(r.history.map((h) => [h.id, h.published, h.timing, h.reaction_day, h.merged, h.move?.display]), [
      ["2026年半年报", "2026-08-15", "before_open", "2026-08-17", [], "-5.00%"],
      ["2026年一季报", "2026-04-25", "before_open", "2026-04-27", ["2025年年报"], "6.00%"],
      ["2025年年报", "2026-04-25", "before_open", "2026-04-27", ["2026年一季报"], "6.00%"],
      ["2025年三季报", "2025-10-25", "before_open", "2025-10-27", [], "-2.00%"],
      ["2025年半年报", "2025-08-09", "before_open", "2025-08-11", [], "4.00%"],
    ]);
    // 只有 2026 半年报有业绩预告:实际 130 亿 vs 预告 100–120 亿,中点 110 亿
    const s = r.history[0]!.surprise!;
    assert.deepEqual([s.basis, s.actual, s.estimate, s.low, s.high, s.position_label, s.unit, s.display], ["forecast", 1.3e10, 1.1e10, 1e10, 1.2e10, "高于区间上限", "元", "18.18%"]);
    assert.ok(r.history.slice(1).every((h) => h.surprise === null));
    // 最近一次 −5%,此前三次(合并算一次)平均绝对涨跌 (6 + 2 + 4) / 3 = 4%,是平均的 1.25 倍
    near(r.reaction?.mean_abs.value, 0.04);
    assert.deepEqual([r.reaction?.mean_abs.display, r.reaction?.prior_n, r.reaction?.lookback, r.reaction?.latest_vs_mean.display, r.reaction?.latest_id], ["4.00%", 3, 4, "1.25 倍", "2026年半年报"]);
    assert.equal(r.intraday, false);
    assert.equal(r.cached, false);
    assert.ok(r.fetched_at);
    assert.equal(complianceGate(JSON.stringify(r)).ok, true);

    const c1 = ctx.calls();
    assert.deepEqual(c1.map((c) => c.ep).sort(), ["earnings_forecast", "fetch_estimates", "fetch_financials", "next_disclosure", "tx_kline"]);
    assert.deepEqual(c1.find((c) => c.ep === "tx_kline")?.args, { count: 500 });
    const r2 = await run(ctx, { symbol: "600519" }, CN_NOW);
    assert.equal(ctx.calls().length, 5, "再开一次全用缓存");
    assert.equal(r2.cached, true);
    assert.deepEqual(r2.history, r.history);
    assert.equal((await run(ctx, { symbol: "600519" }, "2026-10-08T03:00:00Z")).intraday, false, "北京 11:00 盘中,但最近一次的反应日是 08-17");
    await run(ctx, { symbol: "600519", refresh: "1" }, CN_NOW);
    assert.deepEqual(ctx.calls().slice(5).map((c) => c.ep).sort(), c1.map((c) => c.ep).sort(), "重新取:五个都重取");
  } finally { cleanup(ctx); }
});

test("A 股:没有业绩预告就不取季报;预约日已过还没披露要写出来;反应日是今天、还没收盘 → intraday", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({
      ...CN_CFG,
      fc: [],
      disc: [appoint("2026年 三季报", "2026-09-30", null, { APPOINT_PUBLISH_DATE: "2026-10-07 00:00:00", FIRST_APPOINT_DATE: "2026-10-07 00:00:00" }), ...CN_CFG.disc.slice(1)],
      klines: { "600519": [...CN_CFG.klines["600519"], ["2026-10-09", 180]] },
    });
    // 让最近一次的反应日落在「今天」:把 2026 半年报的披露日改到 10-09
    const cfg = JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, "cfg.json"), "utf8"));
    cfg.disc[1] = appoint("2026年 半年报", "2026-06-30", "2026-10-09");
    ctx.setCfg(cfg);
    const r = await run(ctx, { symbol: "600519" }, "2026-10-09T03:00:00Z");  // 北京 11:00,盘中
    assert.deepEqual(r.gaps, []);
    assert.equal(r.forecast, null);
    assert.ok(!ctx.calls().some((c) => c.ep === "fetch_financials"), "没有预告就不取季报");
    assert.equal(r.upcoming?.days, -2);
    assert.match(r.upcoming!.note, /预约日已过,还没看到实际披露/);
    assert.doesNotMatch(r.upcoming!.note, /已改期|改过/, "首次预约和现在一样、没有改期记录");
    assert.deepEqual([r.history[0]!.reaction_day, r.history[0]!.move?.display], ["2026-10-09", "-5.76%"]);
    assert.equal(r.intraday, true);
    assert.ok(r.history.every((h) => h.surprise === null));
    assert.equal((await run(ctx, { symbol: "600519" }, "2026-10-09T07:00:00Z")).intraday, false, "北京 15:00 已收盘");
  } finally { cleanup(ctx); }
});

test("A 股:取不到的照实写进缺口,不编数;北交所不取日 K;发了财报但日 K 还没到 → 反应待定", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ ...CN_CFG, fail: ["next_disclosure", "fetch_estimates"] });
    const r = await run(ctx, { symbol: "600519" }, CN_NOW);
    assert.deepEqual(r.gaps, ["预约披露日没取到(fake HTTP 502)", "一致预期没取到(fake HTTP 502)"]);
    assert.deepEqual([r.upcoming, r.consensus, r.forecast, r.history, r.reaction], [null, null, null, [], null]);
    assert.ok(!ctx.calls().some((c) => c.ep === "fetch_financials"));

    const b = fakeCtx();
    try {
      b.setCfg({ ...CN_CFG, klines: {} });
      const rb = await run(b, { symbol: "920001" }, CN_NOW);
      assert.ok(!b.calls().some((c) => c.ep === "tx_kline"), "北交所不取腾讯日 K");
      assert.deepEqual(rb.gaps, ["北交所:腾讯日 K 不支持,财报后的涨跌没算"]);
      assert.equal(rb.reaction, null);
      assert.ok(rb.history.length === 5 && rb.history.every((h) => h.move === null && h.reaction_day === null));
      assert.equal(rb.history[0]!.surprise?.display, "18.18%", "偏差照算");
    } finally { cleanup(b); }

    const p = fakeCtx();
    try {
      const cfg = structuredClone(CN_CFG) as typeof CN_CFG;
      cfg.disc[0] = appoint("2026年 三季报", "2026-09-30", "2026-10-09");
      cfg.disc.unshift(appoint("2026年 年报", "2026-12-31", null, { APPOINT_PUBLISH_DATE: "2027-03-28 00:00:00" }));
      p.setCfg(cfg);
      const rp = await run(p, { symbol: "600519" }, "2027-01-10T08:00:00Z");
      assert.deepEqual([rp.upcoming?.label, rp.upcoming?.date], ["2026年年报", "2027-03-28"]);
      assert.deepEqual([rp.history[0]!.id, rp.history[0]!.pending, rp.history[0]!.move?.status, rp.history[0]!.reaction_day], ["2026年三季报", true, "not_meaningful", null]);
      assert.equal(rp.reaction?.latest_vs_mean.status, "not_meaningful");
      assert.equal(rp.reaction?.mean_abs.display, "4.25%", "平均照算(此前四次:5 6 2 4)");
      assert.deepEqual([rp.consensus?.label.slice(0, 6), rp.consensus?.mean], ["FY2026", 67.16], "已经 2027 年 1 月,但下一期是 2026 年报 → 还是 FY2026");
    } finally { cleanup(p); }

    // 下一期预约日还没公布:按已披露的最新一期推 FY,不用今天的年份(审查 R3-3)
    const q = fakeCtx();
    try {
      const cfg = structuredClone(CN_CFG) as typeof CN_CFG;
      cfg.disc = cfg.disc.filter((a) => a.REPORT_DATE !== "2026-12-31 00:00:00");
      cfg.disc[0] = appoint("2026年 三季报", "2026-09-30", "2026-10-09");
      q.setCfg(cfg);
      const rq = await run(q, { symbol: "600519" }, "2027-01-10T08:00:00Z");
      assert.equal(rq.upcoming, null);
      assert.ok(rq.gaps.includes("下一期的预约披露日还没公布"), rq.gaps.join("|"));
      assert.deepEqual([rq.consensus?.label.slice(0, 6), rq.consensus?.mean], ["FY2026", 67.16], "最新一期是 2026 三季报 → FY2026,不是今天的 2027");
      cfg.disc.unshift(appoint("2026年 年报", "2026-12-31", "2027-03-20"));
      q.setCfg(cfg);
      const ry = await run(q, { symbol: "600519", refresh: "1" }, "2027-03-25T08:00:00Z");
      assert.deepEqual([ry.upcoming, ry.consensus?.label.slice(0, 6), ry.consensus?.mean], [null, "FY2027", 75], "年报出了 → 下一年");
    } finally { cleanup(q); }
  } finally { cleanup(ctx); }
});

// ---------------------------------------------------------------- 美股 / 港股

const yq = (id: string, end: string, actual: number | null, estimate: number | null, reported: number | null) => ({
  date: id, periodEndDate: { fmt: end }, actual: actual === null ? {} : { raw: actual }, estimate: estimate === null ? {} : { raw: estimate },
  ...(reported === null ? {} : { reportedDate: { raw: reported } }),
});
const US_YAHOO = { quoteSummary: { result: [{
  earnings: { earningsChart: {
    quarterly: [
      yq("3Q2025", "2025-09-30", 1.85, 1.77, et("2025-10-30T16:30:00")),        // 盘后 → 10-31
      yq("4Q2025", "2025-12-31", 2.84, 2.67, et("2026-01-29T16:30:00", false)), // 盘后 → 01-30
      yq("1Q2026", "2026-03-31", 2.01, 2.01, et("2026-04-30T07:00:00")),        // 盘前 → 04-30
      yq("2Q2026", "2026-06-30", 2.02, null, et("2026-07-30T00:00:00")),        // 时刻不明
    ],
    earningsDate: [{ raw: et("2026-10-29T07:00:00"), fmt: "2026-10-29" }], isEarningsDateEstimate: true,
    currentCalendarQuarter: "3Q2026", currentPeriodEndDate: { fmt: "2026-09-30" },
  } },
  earningsTrend: { trend: [
    { period: "0q", endDate: "2026-09-30", earningsEstimate: { avg: { raw: 1.98 }, low: { raw: 1.8 }, high: { raw: 2.1 }, numberOfAnalysts: { raw: 28 } }, revenueEstimate: { avg: { raw: 1.0e11 } } },
    { period: "+1q", endDate: "2026-12-31", earningsEstimate: { avg: { raw: 2.9 } } },
  ] },
  earningsHistory: { history: [{ currency: "USD" }] },
}] } };
const usDay = (d: string, dst: boolean) => et(`${d}T09:30:00`, !dst ? false : true);
const US_KLINE = { chart: { result: [{
  timestamp: [usDay("2025-10-30", true), usDay("2025-10-31", true), usDay("2026-01-29", false), usDay("2026-01-30", false), usDay("2026-04-29", true), usDay("2026-04-30", true), usDay("2026-07-30", true), usDay("2026-07-31", true)],
  indicators: { quote: [{ close: [1, 1, 1, 1, 1, 1, 1, 1] }], adjclose: [{ adjclose: [200, 210, 220, 209, 100, 103, 50, 60] }] },
}] } };

test("美股:Yahoo 发布时刻换算反应日、当地 00:00 不算;实际 vs 预期由 calc 算;本季一致预期带营收;下次财报日带估计标注", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ yahoo: US_YAHOO, ykline: US_KLINE, market: "US" });
    const r = await run(ctx, { symbol: "aapl" }, "2026-10-08T20:00:00Z");
    assert.equal(r.symbol, "AAPL");
    assert.equal(r.market, "US");
    assert.deepEqual(r.gaps, ["2Q2026 的发布时刻不明(当地 00:00),财报后的涨跌没算"]);
    assert.deepEqual(r.upcoming, { period: "2026-09-30", label: "3Q2026(日历季度,截至 2026-09-30)", date: "2026-10-29", days: 21, note: "Yahoo 标注为估计日期;盘前还是盘后没注明,以公司公告为准" });
    assert.deepEqual([r.consensus?.label, r.consensus?.unit, r.consensus?.mean, r.consensus?.low, r.consensus?.high, r.consensus?.count, r.consensus?.revenue_mean],
      ["本季每股收益一致预期(截至 2026-09-30)", "USD", 1.98, 1.8, 2.1, 28, 1.0e11]);
    assert.equal(r.forecast, null);
    assert.deepEqual(r.history.map((h) => [h.id, h.published, h.timing, h.reaction_day, h.move?.display ?? null, h.surprise?.display ?? null]), [
      ["2Q2026", "2026-07-30 00:00", null, null, null, null],
      ["1Q2026", "2026-04-30 07:00", "before_open", "2026-04-30", "3.00%", "0.00%"],
      ["4Q2025", "2026-01-29 16:30", "after_close", "2026-01-30", "-5.00%", "6.37%"],
      ["3Q2025", "2025-10-30 16:30", "after_close", "2025-10-31", "5.00%", "4.52%"],
    ]);
    near(r.history[2]!.surprise!.value, (2.84 - 2.67) / 2.67);
    assert.deepEqual([r.history[2]!.surprise!.basis, r.history[2]!.surprise!.unit, r.history[2]!.surprise!.position_label], ["consensus", "USD", null]);
    // 最近一次(算得出的)是 1Q2026 +3%;此前两次平均 5%
    assert.deepEqual([r.reaction?.latest_id, r.reaction?.prior_n, r.reaction?.mean_abs.display, r.reaction?.latest_vs_mean.display], ["1Q2026", 2, "5.00%", "0.6000 倍"]);
    assert.equal(complianceGate(JSON.stringify(r)).ok, true);
    assert.deepEqual(ctx.calls().map((c) => [c.ep, c.sym, c.args]).sort(), [["yahoo_analyst_estimates", "AAPL", {}], ["yahoo_kline", "AAPL", { interval: "1d", range_: "2y" }]]);
  } finally { cleanup(ctx); }
});

test("港股:按香港时间认盘后;本季预期截止日对不上要写缺口;Yahoo 全挂 → 只有缺口", async () => {
  const ctx = fakeCtx();
  try {
    const y = structuredClone(US_YAHOO);
    const ch = y.quoteSummary.result[0]!.earnings.earningsChart;
    ch.quarterly = [yq("2Q2026", "2026-06-30", 7.433, 7.235, hkt("2026-08-12T16:31:00")), yq("1Q2026", "2026-03-31", 7.364, 7.235, hkt("2026-05-13T16:30:00")), yq("4Q2025", "2025-12-31", 6.966, 6.865, null)];
    ch.isEarningsDateEstimate = false;
    y.quoteSummary.result[0]!.earningsTrend.trend[0]!.endDate = "2026-12-31";
    y.quoteSummary.result[0]!.earningsHistory.history = [{ currency: "CNY" }];
    const day = (d: string) => hkt(`${d}T09:30:00`);
    ctx.setCfg({ market: "HK", yahoo: y, ykline: { chart: { result: [{ timestamp: [day("2026-05-13"), day("2026-05-14"), day("2026-08-12"), day("2026-08-13")], indicators: { quote: [{ close: [500, 510, 600, 588] }] } }] } } });
    const r = await run(ctx, { symbol: "00700" }, "2026-10-08T08:00:00Z");
    assert.equal(r.market, "HK");
    assert.deepEqual(r.gaps, ["Yahoo 本季预期的截止日 2026-12-31 和下一份财报的报告期 2026-09-30 对不上", "4Q2025 没有发布时刻,财报后的涨跌没算"]);
    assert.match(r.upcoming!.note, /^Yahoo 标注为公司公布的日期;/);
    assert.equal(r.consensus?.unit, "CNY");
    assert.deepEqual(r.history.map((h) => [h.id, h.timing, h.reaction_day, h.move?.display ?? null]), [["2Q2026", "after_close", "2026-08-13", "-2.00%"], ["1Q2026", "after_close", "2026-05-14", "2.00%"]]);
    assert.equal(r.reaction?.mean_abs.status, "not_meaningful", "此前只有 1 次,不算平均");

    ctx.setCfg({ fail: ["yahoo_analyst_estimates", "yahoo_kline"] });
    const f = await run(ctx, { symbol: "00700", refresh: "1" }, "2026-10-08T08:00:00Z");
    assert.deepEqual(f.gaps, ["分析师预期与历史财报没取到(fake HTTP 502)", "日 K没取到(fake HTTP 502)"]);
    assert.deepEqual([f.market, f.upcoming, f.consensus, f.history, f.reaction, f.fetched_at], ["HK", null, null, [], null, null]);
  } finally { cleanup(ctx); }
});
