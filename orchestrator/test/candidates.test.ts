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
import { ledgerUpsert, ServiceError, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { failedNote } from "../src/finance/schedule.ts";
import {
  candidatePool, checkRow, indexMembers, isStName, METRICS, parseRanges, QUOTE_CHUNK, quoteRows, rangeLabel, showMetric, UNIVERSES, verdictOf,
  type CandidateResult, type QuoteRow,
} from "../src/finance/candidates.ts";
import { METRICS as UI_METRICS, UNIVERSES as UI_UNIVERSES } from "../../desktop/src/verticals/finance/lib/candidates.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";

const bad = (e: unknown) => e instanceof ServiceError && e.code === "bad_query";
const q = (fields: Record<string, number | null>, name = "平安银行", halted = false): QuoteRow => ({ name, fields, halted });
const ALL = { excludeSt: false, excludeHalted: false, haltKnown: true };

test("查询串 → 区间:空值不设、非法数字和下限大于上限直接报错", () => {
  assert.deepEqual(parseRanges({}), {});
  assert.deepEqual(parseRanges({ pe_ttm_min: "0", pe_ttm_max: "15", pb_max: " ", amount_min: "" }), { pe_ttm: { min: 0, max: 15 } });
  assert.deepEqual(parseRanges({ pb_min: "1.5", pb_max: "1.5" }), { pb: { min: 1.5, max: 1.5 } });
  assert.deepEqual(parseRanges({ pe_ttm_max: "-1" }), { pe_ttm: { min: null, max: -1 } });
  assert.deepEqual(parseRanges({ other_min: "1" }), {});
  for (const v of ["abc", "1e10", "-1e10", "NaN", "Infinity", "12abc"]) assert.throws(() => parseRanges({ pb_min: v }), bad, v);
  assert.throws(() => parseRanges({ pe_ttm_min: "20", pe_ttm_max: "10" }), (e: unknown) => bad(e) && /下限 20 大于上限 10/.test((e as Error).message));
});

test("条件写法与显示值:单位、百分号不空格、成交额不到 1 亿写万元、负市盈率注明亏损", () => {
  assert.equal(rangeLabel("pe_ttm", { min: 0, max: 15 }), "市盈率(TTM) 0–15 倍");
  assert.equal(rangeLabel("amount", { min: 1, max: null }), "成交额 ≥ 1 亿元");
  assert.equal(rangeLabel("turnover", { min: 1, max: null }), "换手率 ≥ 1%");
  assert.equal(rangeLabel("pb", { min: null, max: 1.5 }), "市净率 ≤ 1.5 倍");
  assert.equal(rangeLabel("market_cap", { min: 0.123456, max: null }), "总市值 ≥ 0.1235 亿元");
  assert.equal(showMetric("amount", 0.5), "5000 万元");
  assert.equal(showMetric("amount", 1.234), "1.23 亿元");
  assert.equal(showMetric("amount", 1), "1.00 亿元");
  assert.equal(showMetric("pe_ttm", -12.3), "-12.30 倍(亏损)");
  assert.equal(showMetric("pe_ttm", 12.3), "12.30 倍");
  assert.equal(showMetric("pb", -1), "-1.00 倍");
  assert.equal(showMetric("turnover", 2.5), "2.50%");
});

test("逐条核对:腾讯的 0 只在市盈率 / 市净率 / 总市值上算缺数据;边界值算满足;万元换成亿元不出浮点尾巴", () => {
  const r = parseRanges({ pe_ttm_min: "0", pe_ttm_max: "15", pb_max: "1.5", market_cap_min: "100", amount_max: "7", turnover_min: "0" });
  const zero = checkRow(q({ pe_ttm: 0, pb: 0, market_cap: 0, turnover_amount: 0, turnover_rate: 0 }), r, ALL);
  assert.deepEqual(zero.map((c) => [c.id, c.state, c.value, c.shown]), [
    ["pe_ttm", "missing", null, "来源没给"], ["pb", "missing", null, "来源没给"], ["market_cap", "missing", null, "来源没给"],
    ["amount", "met", 0, "0 万元"], ["turnover", "met", 0, "0.00%"],
  ]);
  // 70000 万元 = 7 亿,正好在上限上;乘 1e-4 会得到 7.000000000000001 被判不满足
  const edge = checkRow(q({ pe_ttm: 15, pb: 1.5, market_cap: 100, turnover_amount: 70000, turnover_rate: 0.01 }), r, ALL);
  assert.deepEqual(edge.map((c) => c.state), ["met", "met", "met", "met", "met"]);
  assert.equal(edge.find((c) => c.id === "amount")!.value, 7);
  const out = checkRow(q({ pe_ttm: -8, pb: 1.51, market_cap: 99.99, turnover_amount: 70001, turnover_rate: null }), r, ALL);
  assert.deepEqual(out.map((c) => [c.id, c.state]), [["pe_ttm", "unmet"], ["pb", "unmet"], ["market_cap", "unmet"], ["amount", "unmet"], ["turnover", "missing"]]);
  assert.equal(out[0]!.shown, "-8.00 倍(亏损)");
  assert.equal(out[0]!.value, -8);
  // 没设的指标不出现
  assert.deepEqual(checkRow(q({ pe_ttm: 10 }), parseRanges({ pe_ttm_max: "20" }), ALL).map((c) => c.id), ["pe_ttm"]);
  // 整只没取到:每条都是缺数据,写「没取到」而不是「来源没给」
  const none = checkRow(undefined, r, { excludeSt: true, excludeHalted: true, haltKnown: true });
  assert.ok(none.every((c) => c.state === "missing" && c.value === null));
  assert.deepEqual(none.map((c) => c.shown), ["没取到", "没取到", "没取到", "没取到", "没取到", "没取到简称", "没取到"]);
  // 万元换亿元用除法,值不带浮点尾巴
  assert.equal(checkRow(q({ turnover_amount: 12345 }), parseRanges({ amount_min: "0" }), ALL)[0]!.value, 1.2345);
});

test("ST 与停牌两条:简称里的 ST / *ST / SST / 退市标记;开盘前的「没有成交」记缺数据", () => {
  for (const n of ["ST华微", "*ST金科", "*ST 金 科", "SST前锋", "S*ST天成", "退市美都", "博天退"]) assert.equal(isStName(n), true, n);
  for (const n of ["平安银行", "中国中车", "退休", "TCL科技"]) assert.equal(isStName(n), false, n);
  const st = checkRow(q({}, "*ST 金科"), {}, { excludeSt: true, excludeHalted: false, haltKnown: true });
  assert.deepEqual(st, [{ id: "st", state: "unmet", value: null, shown: "简称是「*ST金科」" }]);
  assert.deepEqual(checkRow(q({}, "平安银行"), {}, { excludeSt: true, excludeHalted: false, haltKnown: true }).map((c) => [c.state, c.shown]), [["met", "不是 ST"]]);
  assert.deepEqual(checkRow(q({}, ""), {}, { excludeSt: true, excludeHalted: false, haltKnown: true }).map((c) => [c.state, c.shown]), [["missing", "没取到简称"]]);
  const h = (halted: boolean, haltKnown: boolean) => checkRow(q({}, "平安银行", halted), {}, { excludeSt: false, excludeHalted: true, haltKnown })[0]!;
  assert.deepEqual([h(true, true).state, h(true, true).shown], ["unmet", "当天没有成交"]);
  assert.deepEqual([h(false, true).state, h(false, true).shown], ["met", "有成交"]);
  assert.deepEqual([h(true, false).state, h(true, false).shown], ["missing", "还没有成交数据"]);
  assert.deepEqual([h(false, false).state, h(false, false).shown], ["missing", "还没有成交数据"]);
  // 开盘前成交额 / 换手率是 0:还没开始交易,不拿 0 去比
  const pre = checkRow(q({ turnover_amount: 0, turnover_rate: 0 }, "平安银行", true), { amount: { min: 1, max: null }, turnover: { min: null, max: 5 } }, { excludeSt: false, excludeHalted: false, haltKnown: false });
  assert.deepEqual(pre.map((c) => [c.id, c.state, c.shown]), [["amount", "missing", "还没有成交数据"], ["turnover", "missing", "还没有成交数据"]]);
  const halted = checkRow(q({ turnover_amount: 0 }, "平安银行", true), { amount: { min: 1, max: null } }, ALL);
  assert.deepEqual(halted.map((c) => [c.state, c.shown]), [["unmet", "0 万元"]], "能判断停牌时,停牌票的 0 成交是真的");
});

test("失败原因:取数器写在 errors[] 里,只留来源和一句话;调用方接住的异常写在 reason", () => {
  assert.equal(failedNote({ status: "failed", errors: [{ source: "csindex", error: "ReadTimeout: HTTPSConnectionPool(host='oss-ch.csindex.com.cn', port=443): Read timed out. (read timeout=40)" }] }), "csindex 超时");
  assert.equal(failedNote({ errors: [{ source: "eastmoney", error: "ConnectionError: Max retries exceeded" }] }), "eastmoney 连不上");
  assert.equal(failedNote({ errors: [null, { source: "tencent", error: "HTTP 502" }] }), "tencent HTTP 502");
  assert.equal(failedNote({ errors: [{ error: "x".repeat(200) }] }), "x".repeat(60));
  assert.equal(failedNote({ reason: "spawn ENOENT", errors: [{ source: "s", error: "e" }] }), "spawn ENOENT");
  assert.equal(failedNote({ degraded: "部分来源没取到" }), "部分来源没取到");
  assert.equal(failedNote({ errors: [] }), "");
  assert.equal(failedNote(undefined), "");
  assert.equal(failedNote("x"), "");
});

test("结论:有一条不满足就排除;没有不满足但有缺数据的单独一组", () => {
  const c = (state: "met" | "unmet" | "missing") => ({ id: "x", state, value: null, shown: "" });
  assert.equal(verdictOf([c("met"), c("met")]), "met");
  assert.equal(verdictOf([c("met"), c("missing")]), "missing");
  assert.equal(verdictOf([c("missing"), c("unmet")]), "unmet");
  assert.equal(verdictOf([c("unmet"), c("missing")]), "unmet");
});

const quoteEv = (key: string, name: string, fields: Record<string, unknown>) =>
  Object.entries(fields).map(([field, value]) => ({ record_key: key, field, value, note: `${name}(${key})`, period: "2026-10-08" }));

test("腾讯行情信封 → 每只的指标;extra.stale 记为当天没有成交;简称缺时从 note 取", () => {
  const env = {
    status: "ok",
    evidence: [
      ...quoteEv("sh600000", "浦发银行", { pe_ttm: 6.1, pb: 0.5, security_name: "浦发银行" }),
      ...quoteEv("sz000001", "平安银行", { pe_ttm: "x", turnover_amount: 12345 }),
    ],
    extra: { stale: ["sz000001"] },
  };
  const rows = quoteRows(env);
  assert.deepEqual([...rows.keys()].sort(), ["000001", "600000"]);
  assert.deepEqual(rows.get("600000"), { name: "浦发银行", fields: { pe_ttm: 6.1, pb: 0.5, security_name: null }, halted: false });
  assert.deepEqual(rows.get("000001"), { name: "平安银行", fields: { pe_ttm: null, turnover_amount: 12345 }, halted: true });
  assert.equal(quoteRows(undefined).size, 0);
  assert.equal(quoteRows({ evidence: "x", extra: { stale: "x" } }).size, 0);
});

function tmpRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "vra-cand-")); }

test("指数成分:读落盘全表;raw_ref 不合法或文件没了就退回信封里的前几只", () => {
  const root = tmpRoot();
  try {
    const ctx = { dataRoot: root };
    fs.mkdirSync(path.join(root, "mcp", "default", "raw"), { recursive: true });
    const name = "raw/extracted_csindex_x_1.json";
    fs.writeFileSync(path.join(root, "mcp", "default", name), JSON.stringify({ rows: [{ code: "000012", name: "南  玻A" }, { code: "600000", name: "浦发银行" }, { code: "bad", name: "x" }] }));
    const env = (ref: string) => ({ status: "ok", evidence: [
      { field: "index_member_count", value: 300, period: "2026-09-30", raw_ref: ref },
      { field: "index_member", value: "000001 平安银行", raw_ref: ref },
      { field: "index_member", value: "000002 万  科A", raw_ref: ref },
    ] });
    assert.deepEqual(indexMembers(ctx, env(name), "mcp/default"), {
      members: [{ symbol: "000012", name: "南玻A" }, { symbol: "600000", name: "浦发银行" }], total: 300, as_of: "2026-09-30", full: true,
    });
    const fallback = { members: [{ symbol: "000001", name: "平安银行" }, { symbol: "000002", name: "万科A" }], total: 300, as_of: "2026-09-30", full: false };
    assert.deepEqual(indexMembers(ctx, env("raw/../../../etc/x.json"), "mcp/default"), fallback);
    // 数据区里别的目录(另一个会话)的文件也不读:raw_ref 只认本次 raw/ 下的文件名
    fs.mkdirSync(path.join(root, "mcp", "other", "raw"), { recursive: true });
    fs.writeFileSync(path.join(root, "mcp", "other", "raw", "y.json"), JSON.stringify({ rows: [{ code: "999999", name: "别处" }] }));
    assert.deepEqual(indexMembers(ctx, env("raw/../../other/raw/y.json"), "mcp/default"), fallback);
    assert.deepEqual(indexMembers(ctx, env("raw/gone.json"), "mcp/default"), fallback);
    assert.deepEqual(indexMembers(ctx, env(name), "../outside"), fallback);
    assert.deepEqual(indexMembers(ctx, undefined, "mcp/default"), { members: [], total: null, as_of: null, full: false });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── 整条链路:假取数器(读仓库根目录的 cfg.json,每次调用记一行 calls.log) ──
const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
sym=a[a.index('--symbol')+1] if '--symbol' in a else ''
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'sym':sym,'args':args})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
def done(env): print(json.dumps(env)); sys.exit(0)
if ep=='index_constituents':
  if cfg.get('idx_fail'): done({'status':'failed','evidence':[],'errors':[{'source':'csindex','endpoint':'index constituents','error':"ReadTimeout: HTTPSConnectionPool(host='oss-ch.csindex.com.cn', port=443): Read timed out. (read timeout=40)"}]})
  ms=cfg['members']; ref='raw/extracted_csindex_%s_%d.json'%(sym,os.getpid())
  if not cfg.get('no_raw'): json.dump({'rows':[{'code':c,'name':n} for c,n in ms]},open(os.path.join(out,ref),'w'))
  ev=[{'field':'index_member_count','value':cfg.get('count',len(ms)),'period':'2026-09-30','raw_ref':ref}]
  ev+=[{'field':'index_member','value':c+' '+n,'period':'2026-09-30','raw_ref':ref} for c,n in ms[:30]]
  done({'status':'ok','evidence':ev})
if ep=='tx_quotes_batch':
  codes=args['codes']
  if any(c in cfg.get('fail_codes',[]) for c in codes): done({'status':'failed','evidence':[],'errors':[{'source':'tencent','error':'HTTP 502 Bad Gateway'}]})
  ev=[]
  for c in codes:
    f=cfg['quotes'].get(c)
    if f is None: continue
    k=('sh' if c[0]=='6' else 'sz')+c
    ev+=[{'record_key':k,'field':x,'value':v,'note':f.get('security_name','')+'('+k+')','period':'2026-10-08'} for x,v in f.items()]
  st=[('sh' if c[0]=='6' else 'sz')+c for c in codes if c in cfg.get('stale',[])]
  done({'status':'ok','evidence':ev,'extra':{'stale':st}})
done({'status':'failed','reason':'unknown','evidence':[]})
`;

interface Cfg { members?: [string, string][]; count?: number; quotes?: Record<string, Record<string, unknown>>; fail_codes?: string[]; stale?: string[]; idx_fail?: boolean; no_raw?: boolean }

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): { ep: string; sym: string; args: { codes?: string[] } }[] } {
  const repo = tmpRoot();
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
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
  };
}

/** 120 只:代码倒序给出(检验结果按代码排),第 7 只是 ST,第 0 只亏损,第 1 只市盈率缺 */
function members120(): { members: [string, string][]; quotes: Record<string, Record<string, unknown>> } {
  const members: [string, string][] = [];
  const quotes: Record<string, Record<string, unknown>> = {};
  for (let i = 119; i >= 0; i--) {
    const code = (i < 60 ? 600000 + i : 1 + i).toString().padStart(6, "0");
    const name = i === 7 ? "*ST样本" : `样本${i}`;
    members.push([code, name]);
    quotes[code] = { security_name: name, pe_ttm: i === 0 ? -5 : i === 1 ? 0 : 5 + (i % 20), pb: 1, market_cap: 200, turnover_amount: 50000, turnover_rate: 1 };
  }
  return { members, quotes };
}

const run = (ctx: ServiceContext, query: Record<string, string>) => candidatePool(ctx, query, new AbortController().signal, new Date("2026-10-08T08:00:00Z"));
const quoteCalls = (ctx: ReturnType<typeof fakeCtx>) => ctx.calls().filter((c) => c.ep === "tx_quotes_batch");

test("候选池视图已注册;界面上的范围和指标与后端同序同名同单位", () => {
  assert.ok(listViews().some((v) => v.id === "candidates" && v.label === "候选池"));
  assert.deepEqual(UI_UNIVERSES.map((u) => [u.id, u.label]), UNIVERSES.map((u) => [u.id, u.label]));
  assert.deepEqual(UI_METRICS.map((m) => [m.id, m.label, m.unit]), Object.entries(METRICS).map(([id, m]) => [id, m.label, m.unit]));
});

test("候选池:指数成分全表 → 每 50 只一批取行情 → 按代码排、不排名,逐条给状态和来源", async () => {
  const ctx = fakeCtx();
  try {
    const { members, quotes } = members120();
    ctx.setCfg({ members, quotes });
    const r = await run(ctx, { universe: "hs300", pe_ttm_min: "0", pe_ttm_max: "15", exclude_st: "1" });
    const qc = quoteCalls(ctx);
    assert.equal(qc.length, 3);
    assert.ok(qc.every((c) => c.args.codes!.length <= QUOTE_CHUNK));
    assert.deepEqual(qc.map((c) => c.args.codes!.length).sort((a, b) => a - b), [20, 50, 50]);
    assert.deepEqual(ctx.calls().filter((c) => c.ep === "index_constituents").map((c) => c.sym), ["000300"]);
    assert.equal(r.rows.length, 120);
    assert.deepEqual(r.rows.map((x) => x.symbol), [...r.rows.map((x) => x.symbol)].sort());
    assert.deepEqual(r.universe, { id: "hs300", label: "沪深300", size: 120, as_of: "2026-09-30", source: "中证指数官网成分文件" });
    assert.equal(r.quotes.source, "腾讯行情");
    assert.ok(r.quotes.fetched_at);
    assert.equal(r.quotes.cached, false);
    assert.deepEqual(r.conditions.map((c) => [c.id, c.label]), [["pe_ttm", "市盈率(TTM) 0–15 倍"], ["st", "排除 ST / *ST / 退市整理"]]);
    assert.deepEqual(r.gaps, []);
    const by = new Map(r.rows.map((x) => [x.symbol, x]));
    assert.equal(by.get("600000")!.verdict, "unmet");          // 亏损
    assert.equal(by.get("600001")!.verdict, "missing");        // 市盈率缺
    assert.equal(by.get("600007")!.verdict, "unmet");          // ST
    assert.equal(by.get("600007")!.checks[1]!.shown, "简称是「*ST样本」");
    assert.equal(by.get("600010")!.verdict, "met");            // 5 + 10 = 15,边界
    assert.equal(by.get("600011")!.verdict, "unmet");          // 16
    assert.equal(r.counts.met + r.counts.unmet + r.counts.missing, 120);
    assert.equal(r.counts.missing, 1);
    assert.equal(r.generated_at, "2026-10-08T08:00:00.000Z");
    // 合规:结果里没有任何一行会被产出红线拦下
    const text = JSON.stringify(r, null, 1);
    assert.equal(complianceGate(text).ok, true, JSON.stringify(complianceGate(text).hits.slice(0, 3)));
    assert.doesNotMatch(text, /推荐|买入|卖出|评级|目标价|排名|得分|score|rank/i);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("候选池:「重新取数」只重取行情,不重取成分文件;不刷新时整条走缓存", async () => {
  const ctx = fakeCtx();
  try {
    const { members, quotes } = members120();
    ctx.setCfg({ members, quotes });
    const qy = { universe: "hs300", pb_max: "2" };
    await run(ctx, qy);
    const second = await run(ctx, qy);
    assert.equal(ctx.calls().length, 4, "第二次不联网");
    assert.equal(second.quotes.cached, true);
    assert.equal(second.rows.length, 120);
    await run(ctx, { ...qy, refresh: "1" });
    assert.equal(ctx.calls().filter((c) => c.ep === "index_constituents").length, 1);
    assert.equal(quoteCalls(ctx).length, 6);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("候选池:一批行情没取到 → 那 50 只记缺数据、写进 gaps;没返回的只数单独写明", async () => {
  const ctx = fakeCtx();
  try {
    const { members, quotes } = members120();
    delete quotes["000100"];
    ctx.setCfg({ members, quotes, fail_codes: ["600000"] });
    const r = await run(ctx, { universe: "hs300", pb_max: "2" });
    const lost = r.rows.filter((x) => x.checks[0]!.shown === "没取到");
    assert.equal(lost.length, 51);                         // 失败的一批 50 只 + 没返回的 1 只
    assert.ok(lost.every((x) => x.verdict === "missing"));
    assert.equal(r.counts.missing, 51);
    assert.ok(r.gaps.includes("腾讯行情没取到 50 只(tencent HTTP 502 Bad Gateway)"), JSON.stringify(r.gaps));
    assert.ok(r.gaps.includes("腾讯行情没有返回 1 只:000100(代码可能已变更)"), JSON.stringify(r.gaps));
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("候选池:几乎全都没有成交时,停牌那条记缺数据(开盘前);少数没有成交才算停牌", async () => {
  const ctx = fakeCtx();
  try {
    const { members, quotes } = members120();
    ctx.setCfg({ members, quotes, stale: members.map(([c]) => c).filter((c) => c !== "600003") });
    const r = await run(ctx, { universe: "hs300", exclude_halted: "1" });
    assert.ok(r.rows.every((x) => x.verdict === "missing" && x.checks[0]!.shown === "还没有成交数据"));
    assert.ok(r.gaps.some((g) => /停牌这一条没法判断/.test(g)));
    ctx.setCfg({ members, quotes, stale: ["600003", "000101"] });
    const r2 = await run(ctx, { universe: "hs300", exclude_halted: "1", refresh: "1" });
    assert.equal(r2.counts.unmet, 2);
    assert.equal(r2.counts.met, 118);
    assert.ok(!r2.gaps.some((g) => /停牌/.test(g)));
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("候选池:成分没取到、只读到前 30 只、只数对不上,都写进 gaps", async () => {
  const ctx = fakeCtx();
  try {
    const { members, quotes } = members120();
    ctx.setCfg({ members, quotes, idx_fail: true });
    const r = await run(ctx, { universe: "zz500", pb_max: "2" });
    assert.deepEqual([r.rows.length, r.gaps], [0, ["中证500成分没取到(csindex 超时)"]]);
    assert.equal(quoteCalls(ctx).length, 0);

    ctx.setCfg({ members, quotes, no_raw: true });
    const r2 = await run(ctx, { universe: "zz1000", pb_max: "2" });
    assert.equal(r2.rows.length, 30);
    assert.deepEqual(r2.gaps, ["中证1000成分全表没读到,只核对了来源列出的前 30 只(共 120 只)"]);

    ctx.setCfg({ members, quotes, count: 121 });
    const r3 = await run(ctx, { universe: "cyb", pb_max: "2" });
    assert.equal(r3.universe.source, "国证指数官网成分文件");
    assert.deepEqual(r3.gaps, ["创业板指成分文件写的是 121 只,读到 120 只"]);
    assert.deepEqual(ctx.calls().filter((c) => c.ep === "index_constituents").map((c) => [c.sym, c.args]),
      [["000905", { provider: "csi" }], ["000852", { provider: "csi" }], ["399006", { provider: "cni" }]]);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("候选池:自选里的基金 / 债券、港股 / 美股不核对,写明原因;重复的只算一次", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ quotes: { "600519": { security_name: "贵州茅台", pe_ttm: 19, pb: 6, market_cap: 15000, turnover_amount: 300000, turnover_rate: 0.2 } } });
    for (const record of [{ symbol: "600519", name: "贵州茅台" }, { symbol: "510300", name: "沪深300ETF" }, { symbol: "00700.HK", name: "腾讯控股" }, { symbol: "AAPL", name: "" }]) {
      ledgerUpsert(ctx, { kind: "watch", record });
    }
    const r: CandidateResult = await run(ctx, { universe: "watch", pe_ttm_max: "20" });
    assert.deepEqual(r.rows.map((x) => [x.symbol, x.name, x.verdict]), [["600519", "贵州茅台", "met"]]);
    assert.deepEqual(r.universe, { id: "watch", label: "我的自选", size: 1, as_of: null, source: "我的台账" });
    assert.deepEqual(r.gaps, ["基金 / 债券 沪深300ETF 510300:没有市盈率这类指标,没核对", "港股 / 美股 腾讯控股 00700.HK、AAPL:候选池暂只支持 A 股,没核对"]);
    // 自选只有几只、全都还没成交(开盘前):不能把它们都判成停牌
    ctx.setCfg({ quotes: { "600519": { security_name: "贵州茅台", pe_ttm: 19, pb: 6, market_cap: 15000, turnover_amount: 0, turnover_rate: 0 } }, stale: ["600519"] });
    const pre = await run(ctx, { universe: "watch", exclude_halted: "1", amount_min: "1", refresh: "1" });
    assert.deepEqual(pre.rows.map((x) => [x.verdict, x.checks.map((c) => c.shown)]), [["missing", ["还没有成交数据", "还没有成交数据"]]]);
    assert.ok(pre.gaps.includes("这次行情里几乎都没有成交(开盘前或非交易时段),停牌这一条、成交额没法判断,记为缺数据"), JSON.stringify(pre.gaps));
    const empty = await run(ctx, { universe: "position", pe_ttm_max: "20" });
    assert.deepEqual([empty.rows, empty.gaps, empty.quotes.fetched_at], [[], [], null]);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("候选池:「我的持仓」按交易流水重放算(卖光的不算),没迁成流水的旧持有记录照样算", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ quotes: Object.fromEntries(["600519", "601318", "000858"].map((s) => [s, { security_name: s, pe_ttm: 10, pb: 1, market_cap: 1000, turnover_amount: 300000, turnover_rate: 1 }])) });
    ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", name: "贵州茅台", type: "buy", date: "2025-01-02", shares: 100, price: 10 } });
    ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000858", name: "五粮液", type: "buy", date: "2025-01-02", shares: 100, price: 10 } });
    ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000858", type: "sell", date: "2025-02-02", shares: 100, price: 11 } });
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "601318", name: "中国平安", shares: 10, cost: 50 } });
    const r = await run(ctx, { universe: "position", pe_ttm_max: "20" });
    assert.deepEqual(r.rows.map((x) => x.symbol).sort(), ["600519", "601318"]);
    assert.equal(r.universe.size, 2);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("候选池:没有的范围、一个条件都没设、区间写错,都报参数错误且不联网", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ quotes: {} });
    await assert.rejects(() => run(ctx, { universe: "nope", pb_max: "1" }), bad);
    await assert.rejects(() => run(ctx, { universe: "hs300" }), (e: unknown) => bad(e) && /至少设一个条件/.test((e as Error).message));
    await assert.rejects(() => run(ctx, { universe: "hs300", exclude_st: "0", exclude_halted: "true" }), bad);
    await assert.rejects(() => run(ctx, { universe: "hs300", pb_min: "3", pb_max: "1" }), bad);
    assert.equal(ctx.calls().length, 0);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});
