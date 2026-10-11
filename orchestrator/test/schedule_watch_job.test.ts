import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { detectPython } from "../src/init.ts";
import type { JobResult } from "../src/notify.ts";
import { FINANCE_SCHEDULE } from "../src/finance/schedule.ts";
import { ledgerUpsert, type ServiceContext } from "../src/service.ts";

/**
 * 「自选变化」任务整条跑(审计第三轮 B5 / B6):假取数器读仓库根目录的 cfg.json,每次调用记一行 calls.log。不联网。
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";

const FAKE_EP = String.raw`import json,sys
a=sys.argv; ep=a[a.index('--endpoint')+1]
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'args':args})+'\n')
def done(env): print(json.dumps(env)); sys.exit(0)
if ep=='tx_quotes_batch':
  codes=args['codes']
  if any(c in cfg.get('crash_codes',[]) for c in codes): print('Traceback: boom'); sys.exit(1)
  if any(c in cfg.get('fail_codes',[]) for c in codes): done({'status':'failed','evidence':[],'errors':[{'source':'tencent','error':'HTTP 502'}]})
  done({'status':'ok','evidence':[{'record_key':'sh'+c,'field':'change_pct','value':1.5,'note':'样本('+c+')','period':cfg['day']} for c in codes]})
done({'status':'failed','reason':'unknown','evidence':[]})
`;
const FAKE_ANN = String.raw`import json,sys
a=sys.argv; sym=a[a.index('--symbol')+1]
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':'fetch_announcements','sym':sym})+'\n')
if sym in cfg.get('ann_crash',[]): print('Traceback: boom'); sys.exit(1)
if sym in cfg.get('ann_fail',[]): print(json.dumps({'status':'failed','evidence':[],'errors':[{'source':'szse','error':'HTTP 503'}]})); sys.exit(0)
ev=[{'field':'announcement_title','value':t,'period':d,'record_key':d+'-'+t} for d,t in cfg.get('ann',{}).get(sym,[])]
print(json.dumps({'status':'ok','evidence':ev}))
`;

interface Cfg { day: string; fail_codes?: string[]; crash_codes?: string[]; ann_fail?: string[]; ann_crash?: string[]; ann?: Record<string, [string, string][]> }

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): { ep: string; args?: { codes?: string[] }; sym?: string }[]; done(): void } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-watchjob-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE_EP);
  fs.writeFileSync(path.join(scripts, "fetch_announcements.py"), FAKE_ANN);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(dataRoot);
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    done: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

const job = FINANCE_SCHEDULE.jobs.find((x) => x.id === "watch_changes")!;
const runOn = (ctx: ServiceContext, day: string, state: unknown): Promise<JobResult> =>
  job.run({ ctx, day, now: new Date(`${day}T08:15:00Z`), signal: new AbortController().signal, state, manual: false });
const codes = (n: number) => Array.from({ length: n }, (_, i) => String(600000 + i));

test("🔴 自选超过 50 只:行情每 50 只一批取,结果合并;一批失败只影响那一批并写明(审计第三轮 B5)", async () => {
  const ctx = fakeCtx();
  try {
    for (const c of codes(51)) ledgerUpsert(ctx, { kind: "watch", record: { symbol: c, name: `样本${c}` } });
    ctx.setCfg({ day: "2026-10-12" });
    const r = await runOn(ctx, "2026-10-12", undefined);
    const batches = ctx.calls().filter((c) => c.ep === "tx_quotes_batch").map((c) => c.args!.codes!.length).sort((a, b) => b - a);
    assert.deepEqual(batches, [50, 1]);
    const text = r.messages[0]!.lines.join("\n");
    assert.doesNotMatch(text, /没取到行情/, text);
    assert.match(text, /另有 41 只,见自选页/, "51 只都有涨跌");

    ctx.setCfg({ day: "2026-10-13", fail_codes: ["600050"] });
    const r2 = await runOn(ctx, "2026-10-13", r.state);
    const t2 = r2.messages[0]!.lines.join("\n");
    assert.match(t2, /没取到行情:样本600050 600050/, t2);
    assert.match(t2, /行情分 2 批取\(每批最多 50 只\),其中 1 批没取到/);
    assert.match(t2, /另有 40 只,见自选页/, "另一批的 50 只照常用");

    // 取数器直接崩掉(不出信封)也一样:只丢那一批,不让整个任务失败
    ctx.setCfg({ day: "2026-10-14", crash_codes: ["600050"] });
    const t3 = (await runOn(ctx, "2026-10-14", r2.state)).messages[0]!.lines.join("\n");
    assert.match(t3, /没取到行情:样本600050 600050/, t3);
    assert.match(t3, /行情分 2 批取\(每批最多 50 只\),其中 1 批没取到/);
    assert.match(t3, /另有 40 只,见自选页/);
  } finally { ctx.done(); }
});

test("🔴 公告取数失败不推进检查起点:恢复后补提醒一次,之后不再重复(审计第三轮 B6)", async () => {
  const ctx = fakeCtx();
  try {
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "600519", name: "贵州茅台" } });
    ctx.setCfg({ day: "2026-10-12" });
    let r = await runOn(ctx, "2026-10-12", undefined);
    assert.deepEqual(r.state, { since: "2026-10-12", seen: { "600519": [] }, behind: {} });
    // 13 日接口报失败、14 日取数器直接崩掉:两种都不推进起点
    for (const day of ["2026-10-13", "2026-10-14"]) {
      ctx.setCfg(day === "2026-10-13" ? { day, ann_fail: ["600519"] } : { day, ann_crash: ["600519"] });
      r = await runOn(ctx, day, r.state);
      assert.match(r.messages[0]!.lines.join("\n"), /公告没取到:贵州茅台 600519/);
      assert.deepEqual((r.state as { behind: unknown }).behind, { "600519": "2026-10-12" }, `${day}:起点停在最后一次查成功那天`);
    }
    ctx.setCfg({ day: "2026-10-15", ann: { "600519": [["2026-10-13", "贵州茅台:关于回购股份的公告"]] } });
    r = await runOn(ctx, "2026-10-15", r.state);
    const t = r.messages[0]!.lines.join("\n");
    assert.match(t, /新公告 1 条:\n贵州茅台 600519 2026-10-13 关于回购股份的公告/, t);
    assert.deepEqual((r.state as { behind: unknown }).behind, {});
    ctx.setCfg({ day: "2026-10-16", ann: { "600519": [["2026-10-13", "贵州茅台:关于回购股份的公告"]] } });
    r = await runOn(ctx, "2026-10-16", r.state);
    assert.match(r.messages[0]!.lines.join("\n"), /已查的 1 只 A 股没有新公告/, "提醒过的不再提醒");
  } finally { ctx.done(); }
});
