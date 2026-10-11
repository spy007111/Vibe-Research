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
import {
  abnormalLines, abnormalWatch, BOARD_RULES, boardOf, critRatio, klineBars, proximity, RULE_SOURCE,
  type AbnormalResult, type AbnormalRow, type Bar, type Crit, type Proximity,
} from "../src/finance/abnormal.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";

const day = (i: number) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
const series = (closes: number[]): Bar[] => closes.map((close, i) => ({ date: day(i), close }));
const flat = (n: number, v = 1000) => series(Array<number>(n).fill(v));
/** 从 100 起按每天的倍数连乘 */
const walk = (mult: number[]) => { const c = [100]; for (const m of mult) c.push(c[c.length - 1]! * m); return series(c); };
const SH = BOARD_RULES.sh_main;
const CY = BOARD_RULES.chinext;
const ok = (r: Proximity | { error: string }): Proximity => { assert.ok(!("error" in r), JSON.stringify(r)); return r as Proximity; };
const kinds = (p: Proximity) => p.recent.map((t) => `${t.date} ${t.kind} ${t.dir}`);

test("板块:按代码号段分;基金、债券、B 股、港美股不归任何板块", () => {
  for (const s of ["600519", "601318", "603189", "605499"]) assert.equal(boardOf(s), "sh_main", s);
  for (const s of ["688981", "689009"]) assert.equal(boardOf(s), "star", s);
  for (const s of ["000001", "001979", "002242", "003816"]) assert.equal(boardOf(s), "sz_main", s);
  for (const s of ["300308", "301236", "302132"]) assert.equal(boardOf(s), "chinext", s);
  for (const s of ["920627", "430047", "830799", "871981"]) assert.equal(boardOf(s), "bse", s);
  for (const s of ["900901", "200002", "510300", "159915", "113050", "00700.HK", "AAPL", "68898", "6005190", "687001", "303000"]) assert.equal(boardOf(s), null, s);
});

test("各板块标准与 2026 年修订版交易规则原文一致(2026-10-08 逐条核对)", () => {
  assert.deepEqual(BOARD_RULES, {
    // 上交所 5.4.2 / 5.4.3:±20%;10 日内 4 次同向;10 日 +100% / −50%;30 日 +200% / −70%;5.4.5 / 3.3.13 新股前 5 日不纳入
    sh_main: { label: "沪市主板", index: { code: "sh000002", label: "上证A股指数" }, abn: 20, count: 4, sev10: [100, -50], sev30: [200, -70], noLimitDays: 5 },
    // 上交所 6.10 / 6.11:科创板 ±30%;10 日内 3 次同向
    star: { label: "科创板", index: { code: "sh000688", label: "科创50" }, abn: 30, count: 3, sev10: [100, -50], sev30: [200, -70], noLimitDays: 5 },
    // 深交所 5.4.1 / 5.4.3
    sz_main: { label: "深市主板", index: { code: "sz399107", label: "深证A股指数" }, abn: 20, count: 4, sev10: [100, -50], sev30: [200, -70], noLimitDays: 5 },
    chinext: { label: "创业板", index: { code: "sz399102", label: "创业板综合指数" }, abn: 30, count: 3, sev10: [100, -50], sev30: [200, -70], noLimitDays: 5 },
    // 北交所 5.4.2 – 5.4.5:±40%;10 日 +150% / −60%;30 日 +300% / −75%;只有上市首日不设涨跌幅
    bse: { label: "北交所", index: { code: "bj899050", label: "北证50" }, abn: 40, count: 3, sev10: [150, -60], sev30: [300, -75], noLimitDays: 1 },
  });
  assert.match(RULE_SOURCE, /2026 年修订/);
});

test("累计偏离是区间涨幅之差,不是每天偏离值相加", () => {
  // 每天 +9.6%:两天相加 19.2% 没到,连乘 20.1216% 到了
  const up = ok(proximity(series([100, 109.6, 120.1216]), flat(3), SH));
  assert.deepEqual([up.abnormal.up, up.abnormal.reached], [20.1216, "up"]);
  assert.deepEqual(up.recent, [{ date: day(2), kind: "abnormal", dir: "up", why: "3 个交易日内累计偏离 +20.12%(标准 ±20%)" }]);
  // 每天 −10%:相加 −20% 会算到,连乘 −19% 没到
  const down = ok(proximity(series([100, 90, 81]), flat(3), SH));
  assert.deepEqual([down.abnormal.up, down.abnormal.down, down.abnormal.reached, down.recent], [null, -19, null, []]);
  assert.equal(down.level, 0.95);
  // 指数那一项也是连乘:股价不动、指数每天 +9.6% ⇒ −20.1216%
  const idx = ok(proximity(series([100, 100, 100]), series([1000, 1096, 1201.216]), SH));
  assert.deepEqual([idx.abnormal.down, idx.abnormal.reached], [-20.1216, "down"]);
});

test("「连续 3 个交易日内」:1 到 3 天的区间都算,4 天的不算;正好等于标准算达到", () => {
  // 120/100−1 在浮点里是 19.999999999999996,按 4 位小数算正好 20 ⇒ 达到
  assert.equal(ok(proximity(series([100, 120]), flat(2), SH)).abnormal.reached, "up");
  assert.equal(ok(proximity(series([100, 80]), flat(2), SH)).abnormal.reached, "down");
  const below = ok(proximity(series([100, 119.99]), flat(2), SH));
  assert.deepEqual([below.abnormal.up, below.abnormal.reached], [19.99, null]);
  // 每天 +6.3%:第 2 天 13%,第 3 天 20.1157% 达到
  const three = ok(proximity(series([100, 106.3, 112.9969, 120.1157047]), flat(4), SH));
  assert.deepEqual(kinds(three), [`${day(3)} abnormal up`]);
  assert.equal(three.abnormal.up, 20.1157);
  // 每天 +4.7%:4 天合计 20.17%,但 3 天最多 14.77% ⇒ 没到
  const four = ok(proximity(series([100, 104.7, 109.6209, 114.7730823, 120.1674172]), flat(5), SH));
  assert.deepEqual([four.abnormal.up, four.abnormal.reached, four.recent], [14.7731, null, []]);
  assert.equal(four.since, day(2));
});

test("达到后从次一交易日重新计算:前一次的涨幅不再叠进下一个区间", () => {
  // 不重算的话第 2 天 3 日累计是 +21.2%,又会算一次
  const p = ok(proximity(series([100, 120, 121.2, 122.412]), flat(4), SH));
  assert.deepEqual(kinds(p), [`${day(1)} abnormal up`]);
  assert.deepEqual([p.abnormal.up, p.abnormal.reached, p.since], [2.01, null, day(2)]);
  assert.deepEqual(p.same_dir, { up: 1, down: 0, need: 4 });
});

test("停牌:复牌之日起重新计算(复牌日本身的涨跌算在内)", () => {
  const index = series(Array<number>(8).fill(1000));
  const stock: Bar[] = [[0, 100], [1, 110], [2, 115], [5, 126.5], [6, 127.765]].map(([i, c]) => ({ date: day(i!), close: c! }));
  const p = ok(proximity(stock, index, SH));
  // 不重算的话复牌日 3 日累计是 +26.5%
  assert.deepEqual(p.recent, []);
  assert.deepEqual([p.abnormal.up, p.since, p.as_of], [11.1, day(5), day(6)]);
  assert.equal(p.severe10.up, 11.1);
  assert.deepEqual(p.notes, ["能算的只有 4 个交易日,30 日那条按已有的天数算"]);
});

test("指数缺某天:缺的那天和紧接着的一天都不算、前后不连起来,并写明缺了几天", () => {
  const index = [0, 1, 2, 4, 5].map((i) => ({ date: day(i), close: 1000 }));
  // 每天 +7%:连起来的话第 4 天 3 日累计 +22.5% 会算到
  const p = ok(proximity(series([100, 107, 114.49, 122.5043, 131.079601, 140.25517307]), index, SH));
  assert.deepEqual(p.recent, []);
  assert.deepEqual([p.abnormal.up, p.since], [7, day(5)]);
  assert.ok(p.notes.includes("上证A股指数缺 1 个交易日的数据,缺的那几天和紧接着的一天不算"), p.notes.join("|"));
});

test("指数缺的那天正好大涨:次一交易日不能把两天的指数涨幅算进一天(审查 R3-1)", () => {
  // 股价不动;指数在缺数据的第 3 天涨了 10%。第 4 天若照算,会凭空多出 −10% 的偏离
  const stock = flat(6, 100);
  const full = series([1000, 1000, 1000, 1100, 1100, 1100]);
  const gap = full.filter((b) => b.date !== day(3));
  const f = ok(proximity(stock, full, SH));
  const g = ok(proximity(stock, gap, SH));
  assert.deepEqual([f.abnormal.down, f.as_of], [-10, day(5)]);
  assert.deepEqual([g.abnormal.up, g.abnormal.down, g.level, g.since], [null, null, 0, day(5)]);
});

test("新股:沪深前 5 个交易日、北交所上市首日不纳入计算", () => {
  const ipo = series([10, 14.4, 17.28, 20.736, 24.8832, 25.132032]);
  const p = ok(proximity(ipo, flat(6), SH, { listedInRange: true }));
  assert.deepEqual([p.recent, p.abnormal.up, p.since], [[], 1, day(5)]);
  assert.ok(p.notes.includes("上市不久,上市后前 5 个交易日没有涨跌幅限制,不算"));
  // 对照:不按新股处理会在第 2 天就算到
  assert.equal(ok(proximity(ipo, flat(6), SH)).recent[0]!.date, day(1));
  // 北交所只排除首日:第 2 天 +50% 达到 ±40%
  const bj = ok(proximity(series([10, 15, 15]), flat(3), BOARD_RULES.bse, { listedInRange: true }));
  assert.deepEqual(kinds(bj), [`${day(1)} abnormal up`]);
  assert.ok(bj.notes.includes("上市不久,上市后前 1 个交易日没有涨跌幅限制,不算"));
  // 同样的数据按沪市主板:还在前 5 日里,一天都不算
  assert.deepEqual(proximity(series([10, 15, 15]), flat(3), SH, { listedInRange: true }), { error: "上市后前 5 个交易日不纳入计算" });
  assert.deepEqual(proximity(series([10, 15, 15, 15, 15]), flat(5), SH, { listedInRange: true }), { error: "上市后前 5 个交易日不纳入计算" });
  assert.equal(ok(proximity(series([10, 15, 15, 15, 15, 15]), flat(6), SH, { listedInRange: true })).as_of, day(5));
});

test("严重异常波动①:10 个交易日内第 4 次(科创板 / 创业板第 3 次)同向异常波动;之后从头数", () => {
  // 隔天 +20% / −15%:+20% 的那天各算一次,−15% 不到向下标准;10 日累计只有 +27%
  const p = ok(proximity(walk([1.2, 0.85, 1.2, 0.85, 1.2, 0.85, 1.2, 0.85, 1.2]), flat(10), SH));
  assert.deepEqual(kinds(p), [...[1, 3, 5, 7].map((i) => `${day(i)} abnormal up`), `${day(7)} severe up`, `${day(9)} abnormal up`]);
  assert.equal(p.recent[4]!.why, "10 个交易日内第 4 次向上异常波动");
  assert.deepEqual(p.same_dir, { up: 0, down: 0, need: 4 });
  // 创业板 ±30%、第 3 次
  const c = ok(proximity(walk([1.3, 0.8, 1.3, 0.8, 1.3]), flat(6), CY));
  assert.deepEqual(kinds(c), [`${day(1)} abnormal up`, `${day(3)} abnormal up`, `${day(5)} abnormal up`, `${day(5)} severe up`]);
  assert.equal(c.recent[3]!.why, "10 个交易日内第 3 次向上异常波动");
  // 第 4 次落在第 10 个交易日内才算;第 11 天的不算(第 1 次已出窗口)
  const in10 = ok(proximity(walk([1.2, 0.85, 1, 1.2, 0.85, 1, 1.2, 0.85, 1, 1.2]), flat(11), SH));
  assert.ok(kinds(in10).includes(`${day(10)} severe up`), kinds(in10).join("|"));
  const out10 = ok(proximity(walk([1.2, 0.85, 1, 1.2, 0.85, 1, 1.2, 0.85, 1, 1, 1.2]), flat(12), SH));
  assert.deepEqual(kinds(out10), [1, 4, 7, 11].map((i) => `${day(i)} abnormal up`));
  assert.deepEqual(out10.same_dir, { up: 2, down: 0, need: 4 });
});

test("严重异常波动②:10 个交易日内累计 +100% / −50%(正好等于算达到)", () => {
  const up = ok(proximity(series([100, 107, 114, 121, 128, 135, 142, 149, 156, 163, 200]), flat(11), SH));
  assert.deepEqual(kinds(up), [`${day(3)} abnormal up`, `${day(10)} abnormal up`, `${day(10)} severe up`]);
  assert.equal(up.recent[2]!.why, "10 个交易日内累计偏离 +100%(标准 +100% / -50%)");
  assert.deepEqual([up.severe10.up, up.severe10.reached, up.abnormal.up], [100, "up", 34.2282]);
  const short = ok(proximity(series([100, 107, 114, 121, 128, 135, 142, 149, 156, 163, 199.99]), flat(11), SH));
  assert.deepEqual([short.severe10.up, short.severe10.reached], [99.99, null]);
  assert.ok(!kinds(short).some((k) => k.includes("severe")));
  const down = ok(proximity(series([100, 93, 86, 79, 72, 65, 58, 51, 51, 51, 50]), flat(11), SH));
  assert.deepEqual(kinds(down), [`${day(3)} abnormal down`, `${day(6)} abnormal down`, `${day(10)} severe down`]);
  assert.equal(down.recent[2]!.why, "10 个交易日内累计偏离 -50%(标准 +100% / -50%)");
});

test("严重异常波动③:30 个交易日内累计 +200%;31 天才到的不算", () => {
  // 每天约 +3.73%:3 日、10 日都远不到,30 日正好 +200%
  const p = ok(proximity(series(Array.from({ length: 31 }, (_, i) => 100 * 3 ** (i / 30))), flat(31), SH));
  assert.deepEqual(kinds(p), [`${day(30)} severe up`]);
  assert.equal(p.recent[0]!.why, "30 个交易日内累计偏离 +200%(标准 +200% / -70%)");
  assert.deepEqual([p.severe30.reached, p.severe10.reached, p.abnormal.reached], ["up", null, null]);
  assert.deepEqual(p.notes, []);
  const slow = ok(proximity(series(Array.from({ length: 32 }, (_, i) => 100 * 3 ** (i / 31))), flat(32), SH));
  assert.deepEqual(slow.recent, []);
  assert.ok(slow.severe30.up! < 200 && slow.severe30.up! > 189, String(slow.severe30.up));
});

test("接近度:三条标准里离得最近的那条,向上向下各按自己的标准;算不了的给原因", () => {
  assert.equal(ok(proximity(series([100, 110]), flat(2), SH)).level, 0.5);
  assert.equal(ok(proximity(series([100, 90]), flat(2), SH)).level, 0.5);
  assert.equal(ok(proximity(series([100, 120]), flat(2), SH)).level, 1);
  // 创业板 3 日 +15% = 0.5 那条;10 日 0.15
  assert.equal(ok(proximity(series([100, 115]), flat(2), CY)).level, 0.5);
  // 30 天慢涨到 +190%:3 日 0.56、10 日 0.43,最近的是 30 日那条 0.95
  const slow = ok(proximity(series(Array.from({ length: 31 }, (_, i) => 100 * 2.9 ** (i / 30))), flat(31), SH));
  assert.deepEqual([critRatio(slow.abnormal) < 0.6, critRatio(slow.severe10) < 0.5, slow.level], [true, true, 0.95]);
  const crit = (up: number | null, down: number | null, limit: [number, number]): Crit => ({ days: 10, up, down, limit, reached: null });
  assert.equal(critRatio(crit(null, -40, [100, -50])), 0.8);
  assert.equal(critRatio(crit(30, -10, [100, -50])), 0.3);
  assert.equal(critRatio(crit(null, null, [100, -50])), 0);
  assert.deepEqual(proximity([{ date: day(0), close: 100 }], flat(3), SH), { error: "能算的交易日不够" });
  assert.deepEqual(proximity(series([100, 110]).map((b) => ({ ...b, date: `2025${b.date.slice(4)}` })), flat(3), SH), { error: "能算的交易日不够" });
});

function tmpRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "vra-abn-")); }

test("日 K 全表:只读本次 raw/ 下的落盘文件;日期 / 收盘价不合法的丢掉,同一天取后一条,按日期排", () => {
  const root = tmpRoot();
  try {
    const ctx = { dataRoot: root };
    fs.mkdirSync(path.join(root, "mcp", "default", "raw"), { recursive: true });
    const name = "raw/extracted_tencent_tencent_kline_1.json";
    fs.writeFileSync(path.join(root, "mcp", "default", name), JSON.stringify({ rows: [
      { date: day(1), close: 11 }, { date: day(0), close: 10 }, { date: day(1), close: 11.5 },
      { date: "2026/01/08", close: 12 }, { date: day(4), close: 0 }, { date: day(5), close: "12" }, { date: day(6), close: null }, { date: day(7), close: -1 }, null, "x",
    ] }));
    const env = (ref: string) => ({ status: "ok", evidence: [{ field: "kline_close_qfq", value: 11.5 }, { field: "kline_points", value: 9, raw_ref: ref }] });
    assert.deepEqual(klineBars(ctx, env(name), "mcp/default"), [{ date: day(0), close: 10 }, { date: day(1), close: 11.5 }]);
    assert.deepEqual(klineBars(ctx, env("raw/../../../etc/x.json"), "mcp/default"), []);
    assert.deepEqual(klineBars(ctx, env("raw/gone.json"), "mcp/default"), []);
    assert.deepEqual(klineBars(ctx, env(name), "../outside"), []);
    assert.deepEqual(klineBars(ctx, env("raw/other_1.json"), "mcp/default"), []);
    assert.deepEqual(klineBars(ctx, undefined, "mcp/default"), []);
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
if ep=='tx_kline':
  if sym in cfg.get('fail',[]): done({'status':'failed','evidence':[],'errors':[{'source':'tencent','error':'HTTP 502'}]})
  rows=cfg['klines'].get(sym,[])
  if not rows: done({'status':'failed','reason':'腾讯 K 线返回 0 根','evidence':[]})
  ref='raw/extracted_tencent_tencent_kline_%s_%d.json'%(sym,os.getpid())
  json.dump({'rows':[{'date':d,'open':c,'high':c,'low':c,'close':c,'volume':1} for d,c in rows]},open(os.path.join(out,ref),'w'))
  done({'status':'ok','evidence':[{'field':'kline_close_qfq','value':rows[-1][1],'period':rows[-1][0],'raw_ref':ref},{'field':'kline_points','value':len(rows),'raw_ref':ref}]})
if ep=='tx_quotes_batch':
  ev=[]
  for c in args['codes']:
    n=cfg.get('names',{}).get(c)
    if n: ev.append({'record_key':('sh' if c[0]=='6' else 'sz')+c,'field':'security_name','value':n,'note':n+'(x)'})
  done({'status':'ok','evidence':ev})
done({'status':'failed','reason':'unknown','evidence':[]})
`;

interface Cfg { klines: Record<string, [string, number][]>; fail?: string[]; names?: Record<string, string> }

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): { ep: string; sym: string; args: { count?: number; codes?: string[] } }[] } {
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

/** 截至 end 的 n 个连续日子 */
const upTo = (end: string, closes: number[]): [string, number][] => {
  const e = new Date(`${end}T00:00:00Z`);
  return closes.map((c, i) => { const d = new Date(e); d.setUTCDate(d.getUTCDate() - (closes.length - 1 - i)); return [d.toISOString().slice(0, 10), c]; });
};
const idxTo = (end: string, n: number) => upTo(end, Array<number>(n).fill(1000));
const flatTo = (end: string, n: number, last?: number) => upTo(end, Array.from({ length: n }, (_, i) => (i === n - 1 && last !== undefined ? last : 100)));
const watch = (ctx: ServiceContext, symbol: string, name?: string) => ledgerUpsert(ctx, { kind: "watch", record: { symbol, ...(name ? { name } : {}) } });
const run = (ctx: ServiceContext, query: Record<string, string> = {}, now = "2026-10-08T08:00:00Z") => abnormalWatch(ctx, query, new AbortController().signal, new Date(now));

test("视图已注册;refresh 只认 1", async () => {
  assert.ok(listViews().some((v) => v.id === "abnormal" && v.label === "异动接近度"));
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: {} });
    await assert.rejects(run(ctx, { refresh: "2" }), (e: unknown) => e instanceof ServiceError && e.code === "bad_query");
    // 自选为空:什么都不取,也不写「换手率那条没算」
    const empty = await run(ctx);
    assert.deepEqual([empty.rows, empty.gaps, empty.as_of, empty.intraday, ctx.calls()], [[], [], null, false, []]);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("异动接近度:按板块取基准指数,逐只推算;不适用、没取到、停牌、新股都如实写明", async () => {
  const ctx = fakeCtx();
  try {
    const D = "2026-10-08";
    ctx.setCfg({
      klines: {
        sh000002: idxTo(D, 100), sz399107: idxTo(D, 100), sh000688: idxTo(D, 100),
        "600519": flatTo(D, 81, 110), "002242": flatTo(D, 81, 120), "603189": flatTo("2026-10-07", 81),
        "688981": flatTo(D, 10, 101),
      },
      fail: ["sz399102", "600003"],
      names: { "002242": "九阳股份" },
    });
    for (const [s, n] of [["600519", "贵州茅台"], ["002242"], ["300308", "中际旭创"], ["688981", "中芯国际"], ["603189", "*ST网达"], ["600002", "博天退"],
      ["600003", "样本三"], ["510300", "沪深300ETF"], ["00700.HK", "腾讯控股"], ["920627", "北交样本"], ["900901"], ["600519", "贵州茅台"]] as [string, string?][]) watch(ctx, s, n);
    const r = await run(ctx);
    const by = new Map(r.rows.map((x) => [x.symbol, x]));
    assert.deepEqual(r.rows.map((x) => x.symbol).sort(), ["002242", "300308", "600002", "600003", "600519", "603189", "688981"]);
    assert.deepEqual([by.get("600519")!.result!.level, by.get("600519")!.result!.abnormal.up, by.get("600519")!.board_label, by.get("600519")!.index_label], [0.5, 10, "沪市主板", "上证A股指数"]);
    const jy = by.get("002242")!;
    assert.deepEqual([jy.name, jy.board, jy.result!.abnormal.reached, jy.result!.recent.map((t) => t.date)], ["九阳股份", "sz_main", "up", [D]]);
    assert.deepEqual([by.get("300308")!.result, by.get("300308")!.skipped], [null, "创业板综合指数没取到"]);
    assert.deepEqual([by.get("600002")!.result, by.get("600002")!.skipped], [null, "退市整理期不纳入计算"]);
    assert.deepEqual([by.get("600003")!.result, by.get("600003")!.skipped], [null, "日 K 没取到"]);
    assert.ok(by.get("688981")!.result!.notes.includes("上市不久,上市后前 5 个交易日没有涨跌幅限制,不算"));
    assert.equal(by.get("603189")!.result!.as_of, "2026-10-07");
    assert.deepEqual([...r.gaps].sort(), [
      "港股 / 美股 腾讯控股 00700.HK:不适用 A 股的异常波动标准",
      "基金 / 债券 沪深300ETF 510300:不适用股票的异常波动标准,没算",
      "900901:B 股或无法识别的代码,没算",
      "北交所 北交样本 920627:腾讯 K 线不支持北交所、北证50 也取不到,没算(标准是 3 日 ±40%)",
      "沪深主板「换手率放大 30 倍且累计换手 20%」这一条没算:日 K 里没有换手率",
      "创业板综合指数没取到(tencent HTTP 502),创业板的都没算",
      "日 K 没取到 1 只(tencent HTTP 502)",
      "*ST网达 603189的最新日 K 早于 2026-10-08(可能停牌),按它自己的最后一个交易日算",
    ].sort());
    assert.deepEqual([r.as_of, r.intraday, r.cached, r.source], [D, false, false, RULE_SOURCE]);
    assert.deepEqual(r.rules.map((x) => x.board).sort(), ["chinext", "sh_main", "star", "sz_main"]);
    // 取数:每个指数一次(100 根)、每只一次(80 根);退市整理、北交所、基金、港股、B 股不取;重复的自选只算一次
    const k = ctx.calls().filter((c) => c.ep === "tx_kline");
    assert.deepEqual(k.map((c) => c.sym).sort(), ["002242", "600003", "600519", "603189", "688981", "sh000002", "sh000688", "sz399102", "sz399107"]);
    for (const c of k) assert.equal(c.args.count, c.sym.length > 6 ? 100 : 80, c.sym);
    assert.deepEqual(ctx.calls().filter((c) => c.ep === "tx_quotes_batch").map((c) => c.args.codes), [["002242"]]);
    // 合规:结果里没有会被产出红线拦下的字句
    assert.equal(complianceGate(JSON.stringify(r)).ok, true);
    // 收盘前:最后一根是今天 ⇒ 盘中估算
    assert.equal((await run(ctx, {}, "2026-10-08T02:00:00Z")).intraday, true);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("自选里没有沪深主板时,不写换手率那条", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({ klines: { sh000688: idxTo("2026-10-08", 100), "688981": flatTo("2026-10-08", 81) } });
    watch(ctx, "688981", "中芯国际");
    watch(ctx, "00700.HK", "腾讯控股");
    const r = await run(ctx);
    assert.deepEqual(r.gaps, ["港股 / 美股 腾讯控股 00700.HK:不适用 A 股的异常波动标准"]);
    assert.equal(r.rows[0]!.result!.level, 0);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

const crit = (days: number, up: number | null, down: number | null, limit: [number, number], reached: "up" | "down" | null = null): Crit => ({ days, up, down, limit, reached });
const prox = (level: number, a: Crit, s10: Crit, s30: Crit): Proximity => ({ as_of: "2026-10-08", since: "2026-10-06", abnormal: a, severe10: s10, severe30: s30, same_dir: { up: 0, down: 0, need: 4 }, recent: [], level, notes: [] });
const row = (symbol: string, name: string, result: Proximity | null): AbnormalRow => ({ symbol, name, board: "sh_main", board_label: "沪市主板", index_label: "上证A股指数", result, skipped: result ? null : "x" });
const res = (rows: AbnormalRow[], intraday = false): AbnormalResult => ({ rows, rules: [], as_of: "2026-10-08", intraday, fetched_at: null, cached: false, generated_at: "", gaps: [], source: RULE_SOURCE });

test("提醒里附的一段:只写达到或接近(≥ 七成)的;没达到的写最接近的那条", () => {
  const A = (up: number | null, down: number | null, reached: "up" | "down" | null = null) => crit(3, up, down, [20, -20], reached);
  const S10 = (up: number | null, down: number | null = null) => crit(10, up, down, [100, -50]);
  const S30 = (up: number | null) => crit(30, up, null, [200, -70]);
  const lines = abnormalLines(res([
    row("002242", "九阳股份", prox(1.14, A(22.89, null, "up"), S10(30), S30(30))),
    row("600001", "样本一", prox(0.8, A(5, -3), S10(80), S30(80))),
    row("600002", "样本二", prox(0.75, A(15, -2), S10(20), S30(20))),
    row("600003", "", prox(0.8, A(null, -16), S10(null, -10), S30(null))),
    row("600004", "样本四", prox(0.69, A(13.8, null), S10(13.8), S30(13.8))),
    row("600005", "样本五", null),
  ]));
  assert.deepEqual(lines, [
    "离交易所异常波动标准较近的(按规则推算,以交易所公告为准):",
    "九阳股份 002242 2026-10-08 已达到:3 日 +22.89%",
    "样本一 600001 10 日 +80%(标准 +100% / -50%)",
    "样本二 600002 3 日 +15% / -2%(标准 ±20%)",
    "600003 3 日 -16%(标准 ±20%)",
  ]);
  assert.deepEqual(abnormalLines(res([row("600004", "样本四", prox(0.69, A(13.8, null), S10(13.8), S30(13.8)))])), []);
  const many = abnormalLines(res(Array.from({ length: 10 }, (_, i) => row(`60001${i}`, `样本${i}`, prox(0.9, A(18, null), S10(18), S30(18)))), true));
  assert.equal(many[0], "离交易所异常波动标准较近的(按规则推算,以交易所公告为准;盘中按最新价估算):");
  assert.equal(many.length, 1 + 8 + 1);
  assert.equal(many.at(-1), "另有 2 只,见自选页");
  // 盘中最新那天写「今天」;停牌的(最后一根 K 线更早)写它自己的日期,不能说成今天(审查 R3-2)
  const hitA = crit(3, 22.89, null, [20, -20], "up");
  const live = abnormalLines(res([row("002242", "九阳股份", prox(1.14, hitA, crit(10, 30, null, [100, -50]), crit(30, 30, null, [200, -70]))),
    row("600006", "样本六", { ...prox(1.14, hitA, crit(10, 30, null, [100, -50]), crit(30, 30, null, [200, -70])), as_of: "2026-09-30" })], true));
  assert.deepEqual(live.slice(1), ["九阳股份 002242 今天已达到:3 日 +22.89%", "样本六 600006 2026-09-30 已达到:3 日 +22.89%"]);
  for (const l of [...lines, ...many]) assert.equal(complianceGate(l).ok, true, l);
});
