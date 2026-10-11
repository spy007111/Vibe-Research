/**
 * 研究对比:各项指标从运行目录里怎么数、读不到时给 null 而不是 0,以及挑哪几次放在一起比。
 * 指标对照 10-08 三家 9 次真实运行人工数过一遍(见开发计划 E4.2),这里用造出来的小运行把每条规则钉住。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import { createApiServer } from "../src/api.ts";
import { runMetrics } from "../src/run_compare.ts";
import { COMPARE_MAX, ServiceError, compareRuns, type ServiceContext } from "../src/service.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
type Obj = Record<string, unknown>;

const TOKEN = "t".repeat(32);
async function withApi(ctx: ServiceContext, fn: (call: (p: string, body?: unknown, token?: string) => Promise<Response>) => Promise<void>): Promise<void> {
  const server = createApiServer(ctx, { token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const call = (p: string, body?: unknown, token = TOKEN) => fetch(`${base}${p}`, body === undefined
    ? { headers: { Authorization: `Bearer ${token}` } }
    : { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try { await fn(call); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

function tmpCtx(): { ctx: ServiceContext; cleanup: () => void } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vr-compare-"));
  fs.mkdirSync(path.join(dataRoot, "runs"));
  return { ctx: { repoRoot: REPO, dataRoot, python: "python3", node: "node" }, cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }) };
}

const ev = (id: string, field: string, value: number, unit: string) => ({ id, symbol: "300308", market: "SZ", field, value, unit, period: "2026-09-30", source: "tencent", fetched_at: "2026-10-08T08:30:00+08:00" });
const CALC = "calc-0123456789abcdef";

/** 一次完整的小运行;`patch` 改清单,`skip` 不写某些文件 */
function mkRun(ctx: ServiceContext, id: string, patch: Obj = {}, skip: string[] = []): string {
  const d = path.join(ctx.dataRoot, "runs", id);
  for (const sub of ["fetch", "calcs", "stages"]) fs.mkdirSync(path.join(d, sub), { recursive: true });
  const manifest: Obj = {
    run_id: id, symbol: "300308", market: "SZ", status: "complete", exit_code: 0, gate: { ok: true, hits: [] }, final_errors: [],
    started_at: "2026-10-08T08:00:00+08:00", finished_at: "2026-10-08T08:10:30+08:00",
    provider: { name: "cli-claude" }, engine_version: "claude/2.1.285 (Claude Code)", model: null, endpoint_scope: "core",
    stages: [
      { stage: "profile", status: "complete", attempts: 1, validator_ok: true },
      { stage: "financials", status: "incomplete", attempts: 2, validator_ok: true },
      { stage: "report", status: "complete", attempts: 1, validator_ok: true },
    ],
    execution_scope: ["profile", "financials", "report"], quote_decision: "normal",
    stop_guard: { blocks: 2, terminations: 0 }, evidence_conflicts: [{ a: 1 }],
    fetch_ledger: { fetch_quote: { status: "ok" }, a: { status: "partial" }, b: { status: "failed" }, c: { status: "timeout" }, e: { status: "error" }, d: { status: "odd" } },
    ...patch,
  };
  if (!skip.includes("manifest")) fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(d, "fetch", "fetch_quote.json"), JSON.stringify({
    script: "fetch_quote", symbol: "300308", market: "SZ", status: "ok", fetched_at: "2026-10-08T08:30:00+08:00",
    evidence: [ev("ev-aaaaaa01", "price", 808.44, "元"), ev("ev-aaaaaa02", "pe_ttm", 46.56, "倍"), ev("ev-aaaaaa03", "total_shares", 11.1, "亿股"), ev("ev-aaaaaa04", "x", 1.5, "元")],
    errors: [], missing: [],
  }));
  fs.writeFileSync(path.join(d, "calcs", "01_x.json"), JSON.stringify({ calculation_id: CALC, function: "ratio", inputs: {}, output: { status: "ok", value: 17.36, unit: "倍", display: "17.36 倍" } }));
  if (!skip.includes("stages")) {
    fs.writeFileSync(path.join(d, "stages", "profile.json"), JSON.stringify({ stage: "profile", evidence_ids: ["ev-aaaaaa01", "ev-aaaaaa02", "ev-nothere1"], calculation_ids: [], gaps: [{ operation: "a" }, { operation: "b" }] }));
    fs.writeFileSync(path.join(d, "stages", "financials.json"), JSON.stringify({ stage: "financials", evidence_ids: ["ev-aaaaaa02", "ev-aaaaaa03"], calculation_ids: [CALC, "calc-ffffffffffffffff"], gaps: [{ operation: "c" }] }));
    fs.writeFileSync(path.join(d, "stages", "report.json"), JSON.stringify({ stage: "report", evidence_ids: [], calculation_ids: [CALC], gaps: [] }));
  }
  if (!skip.includes("report")) {
    fs.writeFileSync(path.join(d, "report.md"), [
      "状态:complete", "", "## 一、关键数据", "",
      "- 价格 808.44 元 [ev-aaaaaa01]",
      "- 市盈率 46.56 倍 [ev-aaaaaa02]",
      "- 总股本 12.3 亿股 [ev-aaaaaa03]",
      `- 比值 17.36 倍 [${CALC}]`, "",
    ].join("\n"));
  }
  if (!skip.includes("events")) {
    fs.writeFileSync(path.join(d, "events.jsonl"), [
      JSON.stringify({ type: "local_agent.turn_end", stage: "profile", duration_ms: 40_400 }),
      JSON.stringify({ type: "local_agent.turn_end", stage: "financials", duration_ms: 100_000 }),
      '{"type":"local_agent.turn_end","duration_ms":', // 写到一半的行
      JSON.stringify({ type: "validator", stage: "report", ok: true }),
      JSON.stringify({ type: "local_agent.turn_end", stage: "report", duration_ms: -50_000 }),
    ].join("\n"));
  }
  return d;
}

test("研究对比指标:每一项按规则数,引用只数确实存在的、去重", () => {
  const t = tmpCtx(); try {
    const m = runMetrics(mkRun(t.ctx, "r1"));
    assert.deepEqual(m.engine, { provider: "cli-claude", version: "claude/2.1.285 (Claude Code)", model: null });
    assert.equal(m.endpoint_scope, "core");
    assert.equal(m.duration_s, 630);
    assert.equal(m.agent_s, 140, "半行和负数跳过,只加两轮");
    assert.deepEqual(m.stages, { complete: 2, total: 3 }, "资料不完整的阶段不算齐全");
    assert.deepEqual(m.first_pass, { passed: 2, total: 3 }, "交了两次的不算第一次就过");
    assert.deepEqual(m.evidence, { fetched: 4, cited: 3 }, "不存在的 ev-nothere1 不算,两阶段都引的 ev-aaaaaa02 算一次");
    assert.deepEqual(m.calcs, { cited: 1, total: 1 }, "不存在的计算不算");
    assert.equal(m.gaps, 3);
    assert.equal(m.conflicts, 1);
    assert.equal(m.gate_hits, 0, "红线没命中是 0,不是 null");
    assert.equal(m.stop_blocks, 2);
    assert.deepEqual(m.fetch, { ok: 1, partial: 1, failed: 3 }, "超时、出错算失败;认不出的状态不归到任何一类");
    // 报告数字:808.44 / 46.56 / 17.36 对上,12.3 和同行引的证据(11.1)对不上
    assert.deepEqual(m.numbers, { exact: 3, total: 4 });

    // 首轮过校验:校验没过的不算过;一次都没交(attempts 0)的不进分母
    const fp = runMetrics(mkRun(t.ctx, "fp", { stages: [
      { stage: "profile", status: "failed", attempts: 1, validator_ok: false },
      { stage: "financials", status: "complete", attempts: 1, validator_ok: true },
      { stage: "report", status: "failed", attempts: 0, validator_ok: false },
    ] }));
    assert.deepEqual(fp.first_pass, { passed: 1, total: 2 });
    assert.deepEqual(fp.stages, { complete: 1, total: 3 });

    // 分母是这次要跑的阶段:停在第 2 个的那次,不能算成「2 个全齐」
    const stopped = { stages: [{ stage: "profile", status: "complete", attempts: 1, validator_ok: true }, { stage: "financials", status: "complete", attempts: 1, validator_ok: true }] };
    assert.deepEqual(runMetrics(mkRun(t.ctx, "stop", stopped)).stages, { complete: 2, total: 3 });
    // 没写执行范围(或写坏了)的老运行:退回按阶段记录数
    assert.deepEqual(runMetrics(mkRun(t.ctx, "noscope", { ...stopped, execution_scope: undefined })).stages, { complete: 2, total: 2 });
    assert.deepEqual(runMetrics(mkRun(t.ctx, "badscope", { ...stopped, execution_scope: ["profile", 1, "report"] })).stages, { complete: 2, total: 2 });
    // 收尾时报价判定可以是 null:照样算收尾了
    assert.equal(runMetrics(mkRun(t.ctx, "qdnull", { quote_decision: null })).gate_hits, 0);
  } finally { t.cleanup(); }
});

test("研究对比指标:没收尾的研究,开跑时的空占位不当 0;空账本、某栏不是列表也给 null", () => {
  const t = tmpCtx(); try {
    // 取消 / 崩溃:清单里没有收尾才写的 quote_decision,冲突和红线还是开跑时的空占位
    const cut = runMetrics(mkRun(t.ctx, "cut", { status: "failed", quote_decision: undefined, evidence_conflicts: [], gate: { ok: true, hits: [] } }));
    assert.equal(cut.conflicts, null); assert.equal(cut.gate_hits, null);
    assert.equal(cut.stop_blocks, 2, "拦回次数是边跑边记的,照样给");
    assert.deepEqual(cut.fetch, { ok: 1, partial: 1, failed: 3 }, "取数账本也是边跑边记的");
    // 还没取过数就停了:账本是空的,不是「0 成功 0 失败」
    assert.equal(runMetrics(mkRun(t.ctx, "nofetch", { fetch_ledger: {} })).fetch, null);

    // 某个阶段的某一栏不是列表:那一栏整体数不出来,别的栏照常
    const odd = mkRun(t.ctx, "oddfield");
    fs.writeFileSync(path.join(odd, "stages", "report.json"), JSON.stringify({ stage: "report", evidence_ids: "ev-aaaaaa04", calculation_ids: [CALC], gaps: "不是列表" }));
    const o = runMetrics(odd);
    assert.equal(o.gaps, null); assert.equal(o.evidence.cited, null);
    assert.equal(o.calcs.cited, 1); assert.equal(o.evidence.fetched, 4);
    fs.writeFileSync(path.join(odd, "stages", "report.json"), JSON.stringify({ stage: "report", evidence_ids: [], gaps: [] }));
    assert.equal(runMetrics(odd).calcs.cited, null, "缺这一栏也一样");
  } finally { t.cleanup(); }
});

test("研究对比指标:只读普通文件 —— 链接、命名管道、不像阶段名的阶段一律当读不到,不卡住", () => {
  const t = tmpCtx(); try {
    // 阶段名带路径:不去读别处的文件,也不悄悄跳过它只数其余阶段(会少算)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vr-compare-esc-"));
    fs.writeFileSync(path.join(outside, "x.json"), JSON.stringify({ evidence_ids: ["ev-aaaaaa01"], calculation_ids: [], gaps: [{ operation: "外面" }] }));
    const escName = path.relative(path.join(t.ctx.dataRoot, "runs", "esc", "stages"), path.join(outside, "x"));
    const esc = runMetrics(mkRun(t.ctx, "esc", { stages: [
      { stage: "profile", status: "complete", attempts: 1, validator_ok: true },
      { stage: escName, status: "complete", attempts: 1, validator_ok: true },
    ] }));
    assert.equal(esc.gaps, null); assert.equal(esc.evidence.cited, null);
    fs.rmSync(outside, { recursive: true, force: true });

    // 命名管道:读它会一直卡住。过程日志、阶段文件、报告是管道 → 那几项给 null,不卡
    const fifo = (p: string) => { fs.rmSync(p, { force: true }); execFileSync("mkfifo", [p]); };
    const a = mkRun(t.ctx, "fifo-events"); fifo(path.join(a, "events.jsonl"));
    assert.equal(runMetrics(a).agent_s, null);
    const b = mkRun(t.ctx, "fifo-stage"); fifo(path.join(b, "stages", "profile.json"));
    const mb = runMetrics(b);
    assert.equal(mb.gaps, null); assert.equal(mb.evidence.fetched, null, "要读的目录里有管道:整块不读");
    assert.deepEqual(mb.stages, { complete: 2, total: 3 }, "清单里的照样给");
    const c = mkRun(t.ctx, "fifo-report"); fifo(path.join(c, "report.md"));
    assert.equal(runMetrics(c).numbers, null);
    const d = mkRun(t.ctx, "fifo-manifest"); fifo(path.join(d, "manifest.json"));
    const md = runMetrics(d);
    assert.equal(md.status, null); assert.equal(md.evidence.fetched, null);

    // 链接:阶段目录、单个取数文件、清单是链接 → 不读
    const e = mkRun(t.ctx, "link-stages");
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "vr-compare-lnk-"));
    fs.cpSync(path.join(e, "stages"), real, { recursive: true }); fs.rmSync(path.join(e, "stages"), { recursive: true });
    fs.symlinkSync(real, path.join(e, "stages"));
    assert.equal(runMetrics(e).gaps, null);
    const f = mkRun(t.ctx, "link-fetch");
    fs.renameSync(path.join(f, "fetch", "fetch_quote.json"), path.join(real, "q.json"));
    fs.symlinkSync(path.join(real, "q.json"), path.join(f, "fetch", "fetch_quote.json"));
    assert.equal(runMetrics(f).evidence.fetched, null);
    const h = mkRun(t.ctx, "link-calcs");
    fs.renameSync(path.join(h, "calcs", "01_x.json"), path.join(real, "c.json"));
    fs.symlinkSync(path.join(real, "c.json"), path.join(h, "calcs", "01_x.json"));
    assert.equal(runMetrics(h).calcs.total, null);
    const g = mkRun(t.ctx, "link-manifest");
    fs.renameSync(path.join(g, "manifest.json"), path.join(real, "m.json"));
    fs.symlinkSync(path.join(real, "m.json"), path.join(g, "manifest.json"));
    assert.equal(runMetrics(g).status, null);
    fs.rmSync(real, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

test("研究对比指标:读不到的给 null,不给 0", () => {
  const t = tmpCtx(); try {
    const bare = runMetrics(mkRun(t.ctx, "bare", {
      stages: undefined, stop_guard: undefined, evidence_conflicts: undefined, gate: undefined, fetch_ledger: undefined,
      provider: undefined, engine_version: undefined, endpoint_scope: undefined, finished_at: "坏时间",
    }, ["report", "events"]));
    assert.equal(bare.stages, null); assert.equal(bare.first_pass, null);
    assert.equal(bare.agent_s, null); assert.equal(bare.numbers, null); assert.equal(bare.duration_s, null);
    assert.equal(bare.gaps, null, "不知道有哪些阶段 → 缺口数不知道");
    assert.equal(bare.evidence.cited, null); assert.equal(bare.calcs.cited, null);
    assert.equal(bare.evidence.fetched, 4, "取到的证据照样数得出来");
    assert.equal(bare.conflicts, null); assert.equal(bare.gate_hits, null); assert.equal(bare.stop_blocks, null); assert.equal(bare.fetch, null);
    assert.deepEqual(bare.engine, { provider: null, version: null, model: null });

    // 结束早于开始、拦回次数不是非负整数:不知道,不硬算
    const odd = runMetrics(mkRun(t.ctx, "odd", { finished_at: "2026-10-08T07:00:00+08:00", stop_guard: { blocks: "3" } }));
    assert.equal(odd.duration_s, null); assert.equal(odd.stop_blocks, null);
    assert.equal(runMetrics(mkRun(t.ctx, "odd2", { stop_guard: { blocks: -1 } })).stop_blocks, null);
    // 有过程日志、但一轮都没记到:Agent 时间不知道,不是 0 秒
    const quiet = mkRun(t.ctx, "quiet");
    fs.writeFileSync(path.join(quiet, "events.jsonl"), JSON.stringify({ type: "validator", ok: true }) + "\n");
    assert.equal(runMetrics(quiet).agent_s, null);

    // 阶段在清单里、阶段文件一个都没有:引用和缺口不知道,不是 0
    const noStages = runMetrics(mkRun(t.ctx, "nostages", {}, ["stages"]));
    assert.equal(noStages.gaps, null); assert.equal(noStages.evidence.cited, null); assert.equal(noStages.calcs.cited, null);
    assert.deepEqual(noStages.stages, { complete: 2, total: 3 });

    // 清单都没有:整体只剩目录名,其余全是 null
    const none = runMetrics(mkRun(t.ctx, "nomanifest", {}, ["manifest"]));
    assert.equal(none.run_id, "nomanifest"); assert.equal(none.status, null); assert.equal(none.stages, null);

    // 坏 JSON 的阶段文件:那一阶段数不出来 → 引用和缺口给 null(只数其余阶段会少算),不报错
    const broken = mkRun(t.ctx, "broken");
    fs.writeFileSync(path.join(broken, "stages", "profile.json"), "{坏");
    const b = runMetrics(broken);
    assert.equal(b.gaps, null); assert.equal(b.evidence.cited, null);
    assert.equal(b.calcs.cited, null);
    assert.deepEqual(b.stages, { complete: 2, total: 3 }, "清单里的照样给");
    assert.deepEqual(b.numbers, { exact: 3, total: 4 }, "报告数字和阶段文件无关,照样核对");

    // 跑到一半失败、后面的阶段没有文件:只数已有的阶段(没跑的阶段本来就没有缺口可写)
    const partial = mkRun(t.ctx, "partial");
    fs.rmSync(path.join(partial, "stages", "report.json"));
    const p = runMetrics(partial);
    assert.equal(p.gaps, 3); assert.equal(p.evidence.cited, 3); assert.equal(p.calcs.cited, 1);
  } finally { t.cleanup(); }
});

test("研究对比挑哪几次:同一对象、同一市场、同为正式 / 测试、已结束(失败也算),从新到旧最多 8 次,这一次总在里面", () => {
  const t = tmpCtx(); try {
    const at = (h: number) => `2026-10-0${h < 10 ? 8 : 9}T${String(h % 10).padStart(2, "0")}:00:00+08:00`;
    mkRun(t.ctx, "anchor", { started_at: "2026-10-01T08:00:00+08:00", finished_at: "2026-10-01T09:00:00+08:00" });  // 最老的一次
    for (let i = 0; i < 9; i++) mkRun(t.ctx, `peer-${i}`, { started_at: at(i), finished_at: at(i + 1) });
    mkRun(t.ctx, "failed-one", { status: "failed", exit_code: 3, started_at: "2026-10-02T08:00:00+08:00" });
    mkRun(t.ctx, "running", { finished_at: null });
    mkRun(t.ctx, "other-market", { market: "SH" });
    mkRun(t.ctx, "other-symbol", { symbol: "600519" });
    mkRun(t.ctx, "test-run", { test_scenario: true });
    fs.mkdirSync(path.join(t.ctx.dataRoot, "runs", "no-manifest"));
    // 链接进来的运行目录不算
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vr-compare-out-"));
    fs.writeFileSync(path.join(outside, "manifest.json"), JSON.stringify({ run_id: "linked", symbol: "300308", market: "SZ", finished_at: at(5) }));
    fs.symlinkSync(outside, path.join(t.ctx.dataRoot, "runs", "linked"));

    const r = compareRuns(t.ctx, "anchor");
    assert.equal(COMPARE_MAX, 8);
    assert.equal(r.runs.length, COMPARE_MAX);
    assert.ok(r.runs.some((x) => x.run_id === "anchor"), "这一次再老也在");
    const ids = r.runs.map((x) => x.run_id);
    assert.deepEqual(ids, ["peer-8", "peer-7", "peer-6", "peer-5", "peer-4", "peer-3", "peer-2", "anchor"], "从新到旧");
    assert.equal(r.omitted, 3, "peer-1 / peer-0 / failed-one 没摆进来");
    for (const bad of ["running", "other-market", "other-symbol", "test-run", "no-manifest", "linked"]) assert.ok(!ids.includes(bad), bad);

    // 只剩少数时失败的那次也在,状态按归档同一个判据
    const t2 = tmpCtx(); try {
      mkRun(t2.ctx, "a");
      mkRun(t2.ctx, "f", { status: "failed", exit_code: 3, started_at: "2026-10-08T07:00:00+08:00" });
      mkRun(t2.ctx, "c", { cancelled: true, status: "incomplete", started_at: "2026-10-08T06:00:00+08:00" });
      // 按真实时刻排:UTC 写的 00:30Z = 北京 08:30,比 a(08:00)新;字符串比会把它排到最后。没有开始时间的排最后
      mkRun(t2.ctx, "utc", { started_at: "2026-10-08T00:30:00Z" });
      mkRun(t2.ctx, "nostart", { started_at: null });
      const r2 = compareRuns(t2.ctx, "a");
      assert.deepEqual(r2.runs.map((x) => [x.run_id, x.status]), [["utc", "complete"], ["a", "complete"], ["f", "failed"], ["c", "cancelled"], ["nostart", "complete"]]);
      assert.equal(r2.omitted, 0);
      // 只有一次:照样返回这一次,不报错
      const t3 = tmpCtx(); try {
        mkRun(t3.ctx, "solo");
        assert.deepEqual(compareRuns(t3.ctx, "solo").runs.map((x) => x.run_id), ["solo"]);
      } finally { t3.cleanup(); }
    } finally { t2.cleanup(); }

    assert.throws(() => compareRuns(t.ctx, "no-manifest"), (e: unknown) => e instanceof ServiceError && e.code === "not_found");
    assert.throws(() => compareRuns(t.ctx, "../etc"), (e: unknown) => e instanceof ServiceError);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

test("研究对比接口:GET /runs/<id>/compare 要鉴权,读不到清单回 not_found", async () => {
  const t = tmpCtx(); try {
    mkRun(t.ctx, "a"); mkRun(t.ctx, "b", { started_at: "2026-10-08T07:00:00+08:00" });
    fs.mkdirSync(path.join(t.ctx.dataRoot, "runs", "empty"));
    await withApi(t.ctx, async (call) => {
      assert.equal((await call("/runs/a/compare", undefined, "wrong")).status, 401);
      const r = await call("/runs/a/compare");
      assert.equal(r.status, 200);
      const body = await r.json() as { run_id: string; runs: { run_id: string }[]; omitted: number };
      assert.equal(body.run_id, "a"); assert.deepEqual(body.runs.map((x) => x.run_id), ["a", "b"]); assert.equal(body.omitted, 0);
      const miss = await call("/runs/empty/compare");
      assert.equal(miss.status, 400); assert.equal((await miss.json() as { error: string }).error, "not_found");
    });
  } finally { t.cleanup(); }
});

test("研究对比只读:跑完不改运行目录里的任何文件", () => {
  const t = tmpCtx(); try {
    mkRun(t.ctx, "a"); mkRun(t.ctx, "b", { started_at: "2026-10-08T07:00:00+08:00" });
    const snap = () => {
      const out: Record<string, string> = {};
      const walk = (d: string) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else out[p] = fs.readFileSync(p, "utf8"); } };
      walk(t.ctx.dataRoot); return out;
    };
    const before = snap();
    compareRuns(t.ctx, "a");
    assert.deepEqual(snap(), before);
  } finally { t.cleanup(); }
});

test("🔴 取数 / 计算目录丢了、取数文件读不出、账本记过的文件不在 → 证据、计算、报告数字给 null,不是 0(审计 A9)", () => {
  const t = tmpCtx(); try {
    for (const [name, breakIt] of [
      ["没有 fetch 目录", (d: string) => fs.rmSync(path.join(d, "fetch"), { recursive: true })],
      ["没有 calcs 目录", (d: string) => fs.rmSync(path.join(d, "calcs"), { recursive: true })],
      ["取数 JSON 坏了", (d: string) => fs.writeFileSync(path.join(d, "fetch", "a.json"), '{"script":"a","evidence":[')],
      ["计算 JSON 坏了", (d: string) => fs.writeFileSync(path.join(d, "calcs", "02_y.json"), "{")],
      ["账本记过的文件不在", (d: string) => {
        const mp = path.join(d, "manifest.json");
        const m = JSON.parse(fs.readFileSync(mp, "utf8"));
        m.fetch_ledger.fetch_quote.file = "fetch/fetch_quote.json";
        m.fetch_ledger.a.file = "fetch/a.json";
        fs.writeFileSync(mp, JSON.stringify(m));
      }],
    ] as const) {
      const d = mkRun(t.ctx, `r-${Buffer.from(name).toString("hex").slice(0, 12)}`);
      breakIt(d);
      const m = runMetrics(d);
      assert.deepEqual(m.evidence, { fetched: null, cited: null }, name);
      assert.deepEqual(m.calcs, { cited: null, total: null }, name);
      assert.equal(m.numbers, null, name);
      assert.equal(m.gaps, 3, `${name}:缺口条数与取数文件无关,照常`);
    }
    // 账本记的文件都在:照常数
    const ok = mkRun(t.ctx, "r-ledger-ok");
    const mp = path.join(ok, "manifest.json");
    const m = JSON.parse(fs.readFileSync(mp, "utf8"));
    m.fetch_ledger = { fetch_quote: { status: "ok", file: "fetch/fetch_quote.json" } };
    fs.writeFileSync(mp, JSON.stringify(m));
    assert.deepEqual(runMetrics(ok).evidence, { fetched: 4, cited: 3 });
  } finally { t.cleanup(); }
});

test("🔴 生产形状的清单(账本摘要只有 sha256、带 calculation_count):删掉单个取数 / 计算文件,对应几项给 null(审计第二轮 A9)", () => {
  const t = tmpCtx(); try {
    // 生产 ledgerSummary 的形状:没有 file,有 sha256;failed 的那条当时没写出文件(sha256 = null)
    const prod = { fetch_ledger: { fetch_quote: { status: "ok", exit_code: 0, sha256: "ab".repeat(32), raw_files: 1 },
      b: { status: "failed", exit_code: 3, sha256: null, raw_files: 0 } }, calculation_count: 1 };
    const whole = mkRun(t.ctx, "p-ok", prod);
    fs.writeFileSync(path.join(whole, "calculations.json"), JSON.stringify([{ calculation_id: CALC }]));
    assert.deepEqual(runMetrics(whole).evidence, { fetched: 4, cited: 3 }, "文件都在:照常数(sha256 为 null 的那条不要求有文件)");
    assert.deepEqual(runMetrics(whole).calcs, { cited: 1, total: 1 });
    for (const [name, breakIt] of [
      ["删掉账本里的取数文件", (d: string) => fs.rmSync(path.join(d, "fetch", "fetch_quote.json"))],
      ["删掉计算文件、目录还在", (d: string) => fs.rmSync(path.join(d, "calcs", "01_x.json"))],
    ] as const) {
      const d = mkRun(t.ctx, `p-${Buffer.from(name).toString("hex").slice(0, 12)}`, prod);
      fs.writeFileSync(path.join(d, "calculations.json"), JSON.stringify([{ calculation_id: CALC }]));
      breakIt(d);
      const got = runMetrics(d);
      assert.deepEqual(got.evidence, { fetched: null, cited: null }, name);
      assert.deepEqual(got.calcs, { cited: null, total: null }, name);
      assert.equal(got.numbers, null, name);
    }
    // 只有 calculation_count、没有合并产物:计算文件少于这个数也算不完整
    const d = mkRun(t.ctx, "p-count", { calculation_count: 2 });
    assert.deepEqual(runMetrics(d).calcs, { cited: null, total: null });
  } finally { t.cleanup(); }
});
