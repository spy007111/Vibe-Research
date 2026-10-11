import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { makeConfig, type Stage } from "../src/config.ts";
import { writeJson } from "../src/fsutil.ts";
import { LOCAL_AGENT_STOP_LIMITS, MAX_STOP_BLOCKS, MAX_TOTAL_STOP_BLOCKS, StopGuard, validCalcs, type StopDecision } from "../src/stop_guard.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册

/**
 * 收工守卫(v1 的 Stop 钩子搬进产品进程后)的判据回归。逐条沿用 v1 钉过的边界 ——
 * 尤其是 #46 的推进感知:合规流程是"攒好几轮计算 → 最后才写阶段文件",只数拦截次数会把还在干活的轮次误杀。
 */
function runDirFor(runId: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-stopguard-"));
  const cfg = makeConfig({ symbol: "600519", market: "SH", repoRoot: repo, runId });
  for (const d of ["stages", "fetch", "raw"]) fs.mkdirSync(path.join(cfg.runDir, d), { recursive: true });
  writeJson(path.join(cfg.runDir, "manifest.json"), { run_id: runId });
  return cfg.runDir;
}
const putCalc = (runDir: string, file: string, id: string) =>
  writeJson(path.join(runDir, "calcs", file), { calculation_id: id, function: "ttm_sum", output: { status: "ok", value: 1, details: {} } });
const block = (d: StopDecision) => { assert.equal(d.decision, "block", JSON.stringify(d)); return d as Extract<StopDecision, { decision: "block" }>; };
const term = (d: StopDecision) => { assert.equal(d.decision, "terminate", JSON.stringify(d)); return d as Extract<StopDecision, { decision: "terminate" }>; };

test("缺产物 → 拦下(最多 MAX_STOP_BLOCKS 次无推进空转)→ 仍不合格则终止本轮;新一轮计数独立,产物合格即放行", () => {
  const runDir = runDirFor("r1");
  const guard = new StopGuard(runDir, "profile");
  for (let i = 0; i < MAX_STOP_BLOCKS; i++) {
    const b = block(guard.check());
    assert.ok(b.message.includes("缺产物:stages/profile.json") && b.message.includes(`无推进空转 ${i + 1}/${MAX_STOP_BLOCKS}`), b.message);
    assert.equal(b.blocks, i + 1);
  }
  const t = term(guard.check());
  // 终止原因要说对:这条是"一直空转",不能印成累计上限那句(两条分支的文案互换不会被 blocks 断言抓到)
  assert.match(t.reason, new RegExp(`连续 ${MAX_STOP_BLOCKS} 次拦截后都没有新增计算`));
  assert.doesNotMatch(t.reason, /累计拦截已达上限/);
  assert.match(t.reason, /^收工检查终止本轮/, "编排器与真机验收都按这个前缀认");
  assert.equal(t.blocks, MAX_STOP_BLOCKS);
  // idleStreak = **已经发生过的**连续空转拦截数(= MAX),不是本次判定值(MAX+1)
  assert.equal(t.idleStreak, MAX_STOP_BLOCKS);
  assert.equal(guard.terminated, true);
  // 新一轮(新实例):产物齐全(取数无账本 → 账本类错误不拦,留给编排器)→ 放行
  writeJson(path.join(runDir, "stages", "profile.json"), { stage: "profile", status: "incomplete", summary: "x", evidence_ids: [], calculation_ids: [], gaps: [{ operation: "fetch_quote", reason_code: "source_failed", detail: "x" }, { operation: "fetch_profile", reason_code: "source_failed", detail: "x" }, { operation: "fetch_trade_calendar", reason_code: "source_failed", detail: "x" }], quote_decision: "unknown_unverified", quote_decision_reason: "x", moat_tag: "待补" });
  const next = new StopGuard(runDir, "profile");
  assert.deepEqual(next.check(), { decision: "allow" });
  assert.equal(next.blocks, 0);
});

test("推进感知:每次拦截之间都有新的合法计算落盘 ⇒ 空转计数回 1,合规攒算流不被误杀(2026-09-05 实测复现)", () => {
  const runDir = runDirFor("r2");
  const guard = new StopGuard(runDir, "financials");
  for (let i = 0; i <= MAX_STOP_BLOCKS + 2; i++) {
    const b = block(guard.check());
    assert.ok(b.idleStreak <= 1, `第 ${i + 1} 次拦截前有新计算,空转不应累计`);
    putCalc(runDir, `calc_${i}.json`, `calc-${i}`);
  }
  assert.equal(guard.blocks, MAX_STOP_BLOCKS + 3);
  assert.equal(guard.terminated, false);
});

test("推进感知:只写参数文件 / 函数清单(没有合法 calculation_id)不算推进,空转照累计", () => {
  const runDir = runDirFor("r3");
  const guard = new StopGuard(runDir, "financials");
  fs.mkdirSync(path.join(runDir, "calcs"), { recursive: true });
  for (let i = 0; i < MAX_STOP_BLOCKS; i++) {
    assert.ok(block(guard.check()).message.includes(`无推进空转 ${i + 1}/${MAX_STOP_BLOCKS}`), "无合法计算 ⇒ 空转必须逐次累计");
    writeJson(path.join(runDir, "calcs", `args_${i}.json`), { period: "TTM", unit: "亿元" });
    writeJson(path.join(runDir, "calcs", "00_list.json"), { calc_version: "0.3.2", functions: { ttm_sum: "近四季合计" } });
  }
  assert.equal(term(guard.check()).blocks, MAX_STOP_BLOCKS);
});

test("累计拦截硬上限:一直有新计算也不能无限拦,累计到 MAX_TOTAL_STOP_BLOCKS 次仍无产物则终止,原因要分得清", () => {
  const runDir = runDirFor("r4");
  const guard = new StopGuard(runDir, "financials");
  for (let i = 0; i < MAX_TOTAL_STOP_BLOCKS; i++) {
    block(guard.check());
    putCalc(runDir, `calc_${i}.json`, `calc-${i}`);
  }
  const t = term(guard.check());
  assert.match(t.reason, new RegExp(`累计拦截已达上限 ${MAX_TOTAL_STOP_BLOCKS}/${MAX_TOTAL_STOP_BLOCKS} 次`));
  assert.match(t.reason, /上一次拦截后仍有新计算落盘/, "一直在算却写不出产物,不能说成空转");
  assert.doesNotMatch(t.reason, /没有新增计算/);
  assert.equal(t.idleStreak, 1);
});

test("推进感知的边界:建空目录 / 只删不加 / 点开头文件都不算推进;重算覆盖同名文件算推进", () => {
  const runDir = runDirFor("r5");
  const guard = new StopGuard(runDir, "financials");
  const calcDir = path.join(runDir, "calcs");
  const streakOf = () => block(guard.check()).idleStreak;
  assert.equal(streakOf(), 1);   // calcs/ 还不存在:第一次拦截建立比较基线
  fs.mkdirSync(calcDir, { recursive: true });
  assert.equal(streakOf(), 2, "建一个空 calcs/ 不是推进(不存在与空目录同指纹)");
  putCalc(runDir, "01_ttm.json", "calc-a");
  assert.equal(streakOf(), 1, "第一条计算落盘是推进");
  putCalc(runDir, "01_ttm.json", "calc-b");
  assert.equal(streakOf(), 1, "重算覆盖同名文件(条数不变、id 变)是推进");
  fs.rmSync(path.join(calcDir, "01_ttm.json"));
  assert.equal(streakOf(), 2, "只删不加不是推进(否则删文件就能刷掉预算)");
  putCalc(runDir, ".sneak.json", "calc-sneaky");
  assert.equal(streakOf(), 3, "点开头的文件产物侧读不到,这里也不算");
  assert.deepEqual(validCalcs(runDir).count, 0);
});

test("本机 Agent 的上限更紧:一次空转就交给编排器;一直有推进也最多续跑 3 次", () => {
  const idle = runDirFor("r6");
  const g1 = new StopGuard(idle, "profile", LOCAL_AGENT_STOP_LIMITS);
  block(g1.check());
  const t1 = term(g1.check());
  assert.match(t1.reason, /上一次拦截后没有新增计算\(本轮累计拦截 1 次\)/, "maxIdle=1 时不能印成「连续 1 次拦截后都……」");
  assert.equal(t1.blocks, 1);

  const busy = runDirFor("r7");
  const g2 = new StopGuard(busy, "profile", LOCAL_AGENT_STOP_LIMITS);
  for (let i = 0; i < LOCAL_AGENT_STOP_LIMITS.maxTotal; i++) { block(g2.check()); putCalc(busy, `c${i}.json`, `c-${i}`); }
  const t2 = term(g2.check());
  assert.match(t2.reason, new RegExp(`累计拦截已达上限 ${LOCAL_AGENT_STOP_LIMITS.maxTotal}/${LOCAL_AGENT_STOP_LIMITS.maxTotal} 次`));
});

test("检查本身出错 → decision=error(放行但出声),不卡死大脑", () => {
  const runDir = runDirFor("r8");
  // 插件不认识的阶段:产物在,校验器抛错 —— 守卫自己的故障不能变成"拦下"
  writeJson(path.join(runDir, "stages", "no_such_stage.json"), { stage: "no_such_stage" });
  const d = new StopGuard(runDir, "no_such_stage" as Stage).check();
  assert.equal(d.decision, "error", JSON.stringify(d));
});
