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
import { SNAPSHOT_SCHEMA, snapshotKey } from "../src/snapshot.ts";
import { TIERS, TIERS_SOURCE, buildTiers, parsePool, parseReasons, reviewTiers, sealTime, tierOf, type ZtStock } from "../src/finance/review_tiers.ts";
import { TIERS as UI_TIERS } from "../../desktop/src/verticals/finance/lib/reviewTiers.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";

const st = (symbol: string, industry: string, boards: number | null = 1, name = `股${symbol}`): ZtStock => ({ symbol, name, industry, boards });

test("四档的名字和规则:前后端一致", () => {
  assert.deepEqual(UI_TIERS, TIERS);
  assert.deepEqual(TIERS.map((t) => t.id), ["mainline", "today", "scattered", "single"]);
});

test("涨停池解析:池不是数组返回 null;代码要 6 位、去重;行业空写「未分类」;连板数不合法写 null", () => {
  for (const d of [null, {}, { data: null }, { data: { pool: null } }, { data: { pool: "x" } }]) assert.equal(parsePool(d), null);
  assert.deepEqual(parsePool({ data: { pool: [] } }), []);
  assert.deepEqual(parsePool({ data: { pool: [
    { c: "600001", n: "*ST 某 某", hybk: " 半导体 ", lbc: 3, fbt: 93021 },
    { c: "600001", n: "重复", hybk: "银行", lbc: 1 },
    { c: "60000", n: "短", hybk: "银行", lbc: 1 }, { c: 600002, n: "数字代码", hybk: "银行" }, null, "x",
    { c: "000001", n: "平安银行", hybk: "", lbc: 0, fbt: 96000 },
    { c: "000002", n: "万科A", lbc: 1.5, fbt: "92500" },
    { c: "000003", hybk: "地产", lbc: "2", fbt: 150001 },
  ] } }), [
    { symbol: "600001", name: "*ST某某", industry: "半导体", boards: 3, first_seal: "09:30:21" },
    { symbol: "000001", name: "平安银行", industry: "未分类", boards: null, first_seal: null },
    { symbol: "000002", name: "万科A", industry: "未分类", boards: null, first_seal: null },
    { symbol: "000003", name: "", industry: "地产", boards: null, first_seal: null },
  ]);
});

test("首封时间:HMMSS 整数转 HH:MM:SS;分秒越界、竞价前、收盘后、非整数都给 null", () => {
  assert.equal(sealTime(92500), "09:25:00");
  assert.equal(sealTime(130512), "13:05:12");
  assert.equal(sealTime(150000), "15:00:00");
  for (const v of [91459, 150001, 96000, 93061, 92500.5, "92500", null, undefined]) assert.equal(sealTime(v), null, String(v));
});

test("行业内排序:连板数 → 首封早的 → 没有首封时间的排后 → 代码", () => {
  const s = (symbol: string, boards: number, first_seal: string | null): ZtStock => ({ symbol, name: symbol, industry: "出版", boards, first_seal });
  const g = buildTiers([s("600003", 2, "10:00:00"), s("600001", 2, null), s("600002", 2, "09:25:00"), s("600009", 4, "14:00:00"), s("600004", 2, "09:25:00")], [null, null], new Map());
  assert.deepEqual(g[0]!.stocks.map((x) => x.symbol), ["600009", "600002", "600004", "600003", "600001"]);
});

test("题材标签:「A+B+C」拆开、去空去重;同一只取第一条;格式不对的跳过", () => {
  const m = parseReasons({ data: [
    { code: "600001", reason: "芯片+ 存储 ++芯片" }, { code: "600001", reason: "别的" },
    { code: "600002", reason: "" }, { code: 600003, reason: "x" }, { code: "600004" }, null,
  ] });
  assert.deepEqual([...m.entries()], [["600001", ["芯片", "存储"]]]);
  assert.equal(parseReasons(null).size, 0);
  assert.equal(parseReasons({ data: {} }).size, 0);
});

test("分档边界:≥3 且前两天都 ≥2 才算连续集中;前两天有没取到的不算连续", () => {
  assert.equal(tierOf(3, [2, 2]), "mainline");
  assert.equal(tierOf(9, [5, 2]), "mainline");
  assert.equal(tierOf(3, [2, 1]), "today");
  assert.equal(tierOf(3, [1, 2]), "today");
  assert.equal(tierOf(3, [null, 9]), "today");
  assert.equal(tierOf(3, [9, null]), "today");
  assert.equal(tierOf(2, [9, 9]), "scattered");
  assert.equal(tierOf(1, [9, 9]), "single");
});

test("分组:前一天池里没有的行业记 0,池没取到记 null;排序 档位 → 只数 → 行业名;个股按连板数;标签取最多的 3 个", () => {
  const today = [st("600001", "半导体"), st("600002", "半导体", 3), st("300001", "半导体", 2), st("688001", "半导体"),
    st("600010", "汽车"), st("600011", "汽车"), st("600012", "汽车"), st("600020", "电力"), st("600021", "电力"), st("600030", "银行")];
  const p1 = [st("1", "半导体"), st("2", "半导体"), st("3", "汽车"), st("4", "汽车")];
  const reasons = new Map([["600001", ["芯片", "存储"]], ["600002", ["芯片", "封装", "存储"]], ["688001", ["芯片"]], ["300001", ["存储", "芯片", "光刻"]]]);
  const g = buildTiers(today, [p1, null], reasons);
  assert.deepEqual(g.map((x) => [x.industry, x.tier, x.today, x.prev]), [
    ["半导体", "today", 4, [2, null]], ["汽车", "today", 3, [2, null]], ["电力", "scattered", 2, [0, null]], ["银行", "single", 1, [0, null]],
  ]);
  assert.deepEqual(g[0]!.stocks.map((s) => s.symbol), ["600002", "300001", "600001", "688001"]);
  assert.deepEqual(g[0]!.tags, [{ tag: "芯片", count: 4 }, { tag: "存储", count: 3 }, { tag: "封装", count: 1 }]);
  assert.equal(g[0]!.note, "前两个交易日的涨停池没取全,分不出是不是连续");
  assert.equal(g[2]!.note, "", "不到 3 只的不用写");
  const full = buildTiers(today, [p1, [st("5", "半导体"), st("6", "半导体"), st("7", "汽车")]], reasons);
  assert.deepEqual(full.map((x) => [x.industry, x.tier, x.prev, x.note]), [
    ["半导体", "mainline", [2, 2], ""], ["汽车", "today", [2, 1], ""], ["电力", "scattered", [0, 0], ""], ["银行", "single", [0, 0], ""],
  ]);
  assert.deepEqual(buildTiers([], [p1, p1], reasons), []);
  // 同一档里只数多的在前,只数一样才按行业名
  const same = buildTiers([...["1", "2", "3"].map((x) => st(`60000${x}`, "安防")), ...["4", "5", "6", "7"].map((x) => st(`60000${x}`, "半导体"))], [null, null], new Map());
  assert.deepEqual(same.map((x) => x.industry), ["半导体", "安防"]);
});

// ── 整条链路:假取数器(读仓库根目录的 cfg.json,每次调用记一行 calls.log) ──
const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
sym=a[a.index('--symbol')+1] if '--symbol' in a else ''
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'sym':sym,'args':args})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
n=os.getpid()  # 并发取数时文件名不能撞
def done(env): print(json.dumps(env)); sys.exit(0)
def raw(name,doc):
  ref='raw/%s_%d.json'%(name,n)
  json.dump(doc,open(os.path.join(out,ref),'w'),ensure_ascii=False)
  return ref
if ep=='em_zt_pool':
  d=args.get('date','')
  if d in cfg.get('fail',[]): done({'status':'failed','evidence':[],'errors':[{'source':'eastmoney','error':'HTTP 502'}]})
  pool=cfg.get('pools',{}).get(d)
  ref=raw('em_zt_pool',{'data':None if pool is None else {'pool':pool}})
  if pool is None: done({'status':'partial','degraded':'池为空','evidence':[{'field':'zt_count','value':0,'raw_ref':ref}]})
  done({'status':'ok','evidence':[{'field':'zt_count','value':len(pool),'raw_ref':ref}]})
if ep=='ths_hot_reason':
  d=args.get('date','')
  if d in cfg.get('ths_fail',[]): done({'status':'failed','evidence':[],'errors':[{'source':'ths','error':'HTTP 403'}]})
  rows=cfg.get('reasons',{}).get(d,[])
  ref=raw('ths_hot_reason',{'data':rows})
  done({'status':'ok','evidence':[{'field':'hot_count','value':len(rows),'raw_ref':ref}]})
if ep=='tx_kline':
  rows=cfg.get('klines',{}).get(sym,[])
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_tencent_tencent_kline_%s_%d.json'%(sym,n)
  json.dump({'rows':[{'date':d,'open':1,'high':1,'low':1,'close':1000,'volume':1} for d in rows]},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
done({'status':'failed','reason':'unknown','evidence':[]})
`;

type Row = { c: string; n: string; hybk: string; lbc: number };
interface Cfg { pools?: Record<string, Row[] | null>; reasons?: Record<string, { code: string; reason: string }[]>; klines?: Record<string, string[]>; fail?: string[]; ths_fail?: string[] }
type Call = { ep: string; sym: string; args: { date?: string; count?: number } };

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): Call[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-tiers-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(dataRoot);
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call); } catch { return []; } },
  };
}
const run = (ctx: ServiceContext, query: Record<string, string>, now: string) => reviewTiers(ctx, query, new AbortController().signal, new Date(now));
const zt = (c: string, hybk: string, lbc = 1, n = `股${c}`): Row => ({ c, n, hybk, lbc });
const many = (prefix: string, hybk: string, k: number) => Array.from({ length: k }, (_, i) => zt(`${prefix}${String(i).padStart(2, "0")}`, hybk));
const eps = (calls: Call[], ep: string) => calls.filter((c) => c.ep === ep);
const cleanup = (ctx: ServiceContext) => fs.rmSync(ctx.repoRoot, { recursive: true, force: true });

test("视图已注册;日期必须是真实的 YYYY-MM-DD,refresh 只认 1", async () => {
  assert.ok(listViews().some((v) => v.id === "review_tiers" && v.label === "涨停分档"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({});
    for (const q of [{}, { date: "2026-1-8" }, { date: "2026-02-30" }, { date: "20260108" }, { date: "2026-01-08", refresh: "true" }] as Record<string, string>[]) {
      await assert.rejects(run(ctx, q, "2026-01-08T08:00:00Z"), (e: unknown) => e instanceof ServiceError && e.code === "bad_query", JSON.stringify(q));
    }
    assert.deepEqual(ctx.calls(), [], "参数不对什么都不取");
  } finally { cleanup(ctx); }
});

test("涨停分档:当天和前两个交易日的池、同花顺标签;收盘后再开用缓存,重新取只重取当天", async () => {
  const ctx = fakeCtx();
  try {
    const D = "2026-01-08";
    ctx.setCfg({
      klines: { sh000002: ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", D] },
      pools: {
        "20260108": [zt("600001", "半导体"), zt("600002", "半导体", 3), zt("688001", "半导体"), zt("300001", "半导体", 2),
          ...many("6001", "汽车零部件", 3), ...many("6002", "光伏设备", 3), ...many("6003", "电力", 2),
          zt("600400", "银行"), zt("600500", ""), zt("600001", "重复"), zt("60000", "坏代码")],
        "20260107": [...many("6011", "半导体", 2), ...many("6012", "汽车零部件", 2)],
        "20260106": [...many("6021", "半导体", 3), ...many("6022", "汽车零部件", 1), ...many("6023", "光伏设备", 2)],
      },
      reasons: { [D]: [{ code: "600001", reason: "芯片+存储" }, { code: "600002", reason: "芯片+先进封装+存储" }, { code: "688001", reason: "芯片" }, { code: "300001", reason: "存储+芯片" }] },
    });
    const NOW = "2026-01-08T08:00:00Z";
    const r = await run(ctx, { date: D }, NOW);
    assert.deepEqual([r.date, r.prev_dates, r.total, r.gaps, r.cached, r.source], [D, ["2026-01-07", "2026-01-06"], 14, [], false, TIERS_SOURCE]);
    assert.deepEqual(r.groups.map((g) => [g.industry, g.tier, g.today, g.prev]), [
      ["半导体", "mainline", 4, [2, 3]],
      ["光伏设备", "today", 3, [0, 2]],
      ["汽车零部件", "today", 3, [2, 1]],
      ["电力", "scattered", 2, [0, 0]],
      ["未分类", "single", 1, [0, 0]],
      ["银行", "single", 1, [0, 0]],
    ]);
    assert.deepEqual(r.groups[0]!.stocks.map((s) => [s.symbol, s.boards]), [["600002", 3], ["300001", 2], ["600001", 1], ["688001", 1]]);
    assert.deepEqual(r.groups[0]!.tags, [{ tag: "芯片", count: 4 }, { tag: "存储", count: 3 }, { tag: "先进封装", count: 1 }]);
    assert.deepEqual(r.groups[0]!.stocks[0]!.tags, ["芯片", "先进封装", "存储"]);
    assert.deepEqual(r.tiers.map((t) => [t.id, t.industries, t.stocks]), [["mainline", 1, 4], ["today", 2, 6], ["scattered", 1, 2], ["single", 2, 2]]);
    assert.ok(r.fetched_at);
    assert.equal(complianceGate(JSON.stringify(r)).ok, true);
    // 取数:三天的池各一次,标签一次(只要当天),指数日 K 一次、参数和异动接近度一样(100 根,共用缓存)
    const c1 = ctx.calls();
    assert.deepEqual(eps(c1, "em_zt_pool").map((c) => c.args.date).sort(), ["20260106", "20260107", "20260108"]);
    assert.deepEqual(eps(c1, "ths_hot_reason").map((c) => c.args.date), [D]);
    assert.deepEqual(eps(c1, "tx_kline").map((c) => [c.sym, c.args.count]), [["sh000002", 100]]);
    assert.equal(c1.length, 5);
    // 再开一次:全用缓存(过去的日子是收盘后取的,不重取)
    const r2 = await run(ctx, { date: D }, NOW);
    assert.equal(ctx.calls().length, 5);
    assert.equal(r2.cached, true);
    assert.deepEqual(r2.groups, r.groups);
    // 重新取:只重取当天的池和标签,前两天的池、指数日 K 照用缓存
    const r3 = await run(ctx, { date: D, refresh: "1" }, NOW);
    assert.deepEqual(ctx.calls().slice(5).map((c) => `${c.ep} ${c.args.date}`).sort(), ["em_zt_pool 20260108", `ths_hot_reason ${D}`]);
    assert.equal(r3.cached, false);
  } finally { cleanup(ctx); }
});

test("过去的日子:缓存是那天收盘前(或更早)取的,池还没定,要重取", async () => {
  const ctx = fakeCtx();
  try {
    // 日子在测试机时钟之后 ⇒ 快照的取数时间一定早于那天 15:05
    const D = "2030-01-09";
    ctx.setCfg({
      klines: { sh000002: ["2030-01-07", "2030-01-08", D, "2030-01-10"] },
      pools: { "20300109": many("6001", "半导体", 3), "20300108": many("6011", "半导体", 2), "20300107": many("6021", "半导体", 2) },
      reasons: { [D]: [] },
    });
    const NOW = "2030-01-10T08:00:00Z";
    const r = await run(ctx, { date: D }, NOW);
    assert.deepEqual([r.prev_dates, r.groups.map((g) => g.tier)], [["2030-01-08", "2030-01-07"], ["mainline"]]);
    assert.equal(ctx.calls().length, 5);
    const r2 = await run(ctx, { date: D }, NOW);
    assert.deepEqual(ctx.calls().slice(5).map((c) => `${c.ep} ${c.args.date}`).sort(),
      ["em_zt_pool 20300107", "em_zt_pool 20300108", "em_zt_pool 20300109", `ths_hot_reason ${D}`], "三天的池和标签重取,指数日 K 照用缓存");
    assert.equal(r2.cached, false);
  } finally { cleanup(ctx); }
});

test("过去的日子:缓存是那天北京时间 15:05 以后取的照用,之前取的重取", async () => {
  const ctx = fakeCtx();
  try {
    const D = "2030-01-09";
    // 预先放好快照(取数时间各不相同),假取数器那边给的是另一份数据 ⇒ 用没用缓存一看便知
    const put = (endpoint: string, args: Record<string, string>, at: string, doc: unknown) => {
      const name = `raw/pre_${endpoint}_${Object.values(args)[0]}.json`;
      fs.mkdirSync(path.join(ctx.dataRoot, "mcp", "default", "raw"), { recursive: true });
      fs.writeFileSync(path.join(ctx.dataRoot, "mcp", "default", name), JSON.stringify(doc));
      const key = snapshotKey(endpoint, "", args);
      const payload = { envelope: { status: "ok", evidence: [{ field: "n", value: 1, raw_ref: name }] }, exit_code: 0, out_dir: "mcp/default", duration_ms: 1, stderr_tail: "", cached: false, fetched_at: at };
      fs.mkdirSync(path.join(ctx.dataRoot, "snapshots"), { recursive: true });
      fs.writeFileSync(path.join(ctx.dataRoot, "snapshots", `${key}.json`), JSON.stringify({ schema: SNAPSHOT_SCHEMA, key, endpoint, symbol: "", fetched_at: at, payload }));
    };
    const poolDoc = (rows: Row[]) => ({ data: { pool: rows } });
    put("em_zt_pool", { date: "20300109" }, "2030-01-09T06:00:00.000Z", poolDoc(many("6001", "半导体", 2)));   // 14:00,池还没定
    put("em_zt_pool", { date: "20300108" }, "2030-01-08T07:10:00.000Z", poolDoc(many("6011", "半导体", 2)));   // 15:10,照用
    put("em_zt_pool", { date: "20300107" }, "2030-01-07T07:03:00.000Z", poolDoc([]));                          // 15:03,还没到 15:05,重取
    put("ths_hot_reason", { date: D }, "2030-01-09T08:00:00.000Z", { data: [{ code: "600100", reason: "缓存里的标签" }] });
    ctx.setCfg({
      klines: { sh000002: ["2030-01-07", "2030-01-08", D] },
      pools: { "20300109": many("6001", "半导体", 3), "20300108": [], "20300107": many("6021", "半导体", 2) },
      reasons: { [D]: [] },
    });
    const r = await run(ctx, { date: D }, "2030-01-10T08:00:00Z");
    assert.deepEqual(eps(ctx.calls(), "em_zt_pool").map((c) => c.args.date).sort(), ["20300107", "20300109"]);
    assert.deepEqual(eps(ctx.calls(), "ths_hot_reason"), []);
    assert.deepEqual(r.groups.map((g) => [g.industry, g.tier, g.today, g.prev, g.tags]), [["半导体", "mainline", 3, [2, 2], [{ tag: "缓存里的标签", count: 1 }]]]);
  } finally { cleanup(ctx); }
});

test("没取到的如实写:前一天的池、同花顺标签、指数日 K;当天的池空的或没取到就不分档", async () => {
  const D = "2026-01-08";
  const NOW = "2026-01-08T08:00:00Z";
  const KL = { sh000002: ["2026-01-05", "2026-01-06", "2026-01-07", D] };
  let ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: KL, fail: ["20260107"], ths_fail: [D], pools: { "20260108": [...many("6001", "半导体", 3), ...many("6002", "电力", 2)], "20260106": many("6021", "半导体", 3) } });
    const r = await run(ctx, { date: D }, NOW);
    assert.deepEqual(r.groups.map((g) => [g.industry, g.tier, g.prev, g.note, g.tags]), [
      ["半导体", "today", [null, 3], "前两个交易日的涨停池没取全,分不出是不是连续", []],
      ["电力", "scattered", [null, 0], "", []],
    ]);
    assert.deepEqual(r.gaps, ["2026-01-07 的涨停池没取到(eastmoney HTTP 502),「连续集中」分不出来", "同花顺题材标签没取到,只按东财行业分"]);
  } finally { cleanup(ctx); }

  ctx = fakeCtx();
  try {
    ctx.setCfg({ pools: { "20260108": many("6001", "半导体", 3) } });
    const r = await run(ctx, { date: D }, NOW);
    assert.deepEqual([r.prev_dates, r.groups.map((g) => [g.tier, g.prev, g.note])], [[null, null], [["today", [null, null], "前两个交易日的涨停池没取全,分不出是不是连续"]]]);
    assert.deepEqual(r.gaps, ["前两个交易日没找到(上证A股指数日 K 没取到),「连续集中」分不出来"]);
    assert.deepEqual(eps(ctx.calls(), "em_zt_pool").map((c) => c.args.date), ["20260108"], "找不到前两天就不去取");
  } finally { cleanup(ctx); }

  for (const [cfg, first] of [
    [{ klines: KL, pools: { "20260108": null } }, `${D} 的涨停池是空的(盘前、休市日或日期不对时如此),没法分档`],
    [{ klines: KL, fail: ["20260108"] }, `${D} 的涨停池没取到(eastmoney HTTP 502),没法分档`],
  ] as [Cfg, string][]) {
    ctx = fakeCtx();
    try {
      ctx.setCfg(cfg);
      const r = await run(ctx, { date: D }, NOW);
      assert.deepEqual([r.total, r.groups, r.gaps[0]], [null, [], first]);
      assert.deepEqual(r.tiers.map((t) => t.industries + t.stocks), [0, 0, 0, 0]);
    } finally { cleanup(ctx); }
  }
});
