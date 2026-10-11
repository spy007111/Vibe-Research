import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import { createApiServer } from "../src/api.ts";
import { deleteRun, ServiceError, type ServiceContext } from "../src/service.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 造一个最小可用的 ServiceContext(dataRoot 指向临时目录) */
function tmpCtx(): { ctx: ServiceContext; runs: string; cleanup: () => void } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vr-delete-run-"));
  const runs = path.join(dataRoot, "runs");
  fs.mkdirSync(runs, { recursive: true });
  const ctx: ServiceContext = { repoRoot: REPO, dataRoot, python: "python3", node: "node" };
  return { ctx, runs, cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }) };
}
function mkRun(runs: string, id: string): string {
  const d = path.join(runs, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const FINISHED = "2026-09-06T18:39:50.505+08:00";
function writeManifest(dir: string, body: string | object): void {
  fs.writeFileSync(path.join(dir, "manifest.json"), typeof body === "string" ? body : JSON.stringify(body));
}
const codeOf = (e: unknown): string | undefined => (e instanceof ServiceError ? e.code : undefined);

test("deleteRun:清单确认结束(complete+finished_at)→ 正常删,目录消失", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-done");
    writeManifest(d, { run_id: "run-done", symbol: "300308", status: "complete", exit_code: 0, finished_at: FINISHED, gate: { ok: true } });
    const r = deleteRun(t.ctx, "run-done");
    assert.equal(r.deleted, true);
    assert.equal(fs.existsSync(d), false, "运行目录应被删除");
  } finally { t.cleanup(); }
});

test("deleteRun:清单未结束(finished_at 缺失)→ 拒删 run_in_progress,目录保留", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-running");
    writeManifest(d, { run_id: "run-running", symbol: "300308", status: "running" });
    assert.throws(() => deleteRun(t.ctx, "run-running"), (e: unknown) => codeOf(e) === "run_in_progress");
    assert.equal(fs.existsSync(d), true, "进行中的运行目录必须保留");
  } finally { t.cleanup(); }
});

test("deleteRun:清单损坏(JSON 无法解析)→ 拒删 manifest_corrupt,目录保留", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-corrupt");
    writeManifest(d, "{ run_id: run-corrupt, status: complete, ");  // 半截 JSON,典型写到一半
    assert.throws(() => deleteRun(t.ctx, "run-corrupt"), (e: unknown) => codeOf(e) === "manifest_corrupt");
    assert.equal(fs.existsSync(d), true, "清单损坏的运行目录必须保留(数据不可信,不删)");
  } finally { t.cleanup(); }
});

test("deleteRun:清单缺失(目录在但无 manifest.json)→ 拒删 manifest_missing,目录保留", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-nomanifest");
    fs.writeFileSync(path.join(d, "events.jsonl"), "{}\n");  // 有别的产物,但没清单
    assert.throws(() => deleteRun(t.ctx, "run-nomanifest"), (e: unknown) => codeOf(e) === "manifest_missing");
    assert.equal(fs.existsSync(d), true, "无从确认终态的运行目录必须保留");
  } finally { t.cleanup(); }
});

test("deleteRun:进程级兜底——清单已结束但 control 明确未收尾 → 仍拒删 run_in_progress", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-control");
    writeManifest(d, { run_id: "run-control", symbol: "300308", status: "complete", exit_code: 0, finished_at: FINISHED, gate: { ok: true } });
    // control(owner.json)存在且 finished_at=null = worker 还活着(比 manifest 更实时)
    const cdir = path.join(t.ctx.dataRoot, "research-control", "run-control");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "owner.json"), JSON.stringify({ token: "11111111-2222-3333-4444-555555555555", state: "running", finished_at: null }));
    assert.throws(() => deleteRun(t.ctx, "run-control"), (e: unknown) => codeOf(e) === "run_in_progress");
    assert.equal(fs.existsSync(d), true);
  } finally { t.cleanup(); }
});

test("deleteRun:进程级兜底——control 损坏读不出来 → 拒删 control_unreadable,目录保留", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-badcontrol");
    writeManifest(d, { run_id: "run-badcontrol", symbol: "300308", status: "complete", exit_code: 0, finished_at: FINISHED, gate: { ok: true } });
    // owner.json 半截 JSON:readResearchControl 抛 ResearchControlError(不是 ServiceError)。
    // 少一条证据就不该删——吞掉它等于"确认不了也照删"。
    const cdir = path.join(t.ctx.dataRoot, "research-control", "run-badcontrol");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "owner.json"), '{ "token": "1111');
    assert.throws(() => deleteRun(t.ctx, "run-badcontrol"), (e: unknown) => codeOf(e) === "control_unreadable");
    assert.equal(fs.existsSync(d), true, "确认不了是否还在跑,运行目录必须保留");
  } finally { t.cleanup(); }
});

test("deleteRun:删除成功时连带清掉 control 目录,不留孤儿(否则同名 run 再也建不起来)", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-cleanup");
    writeManifest(d, { run_id: "run-cleanup", symbol: "300308", status: "complete", exit_code: 0, finished_at: FINISHED, gate: { ok: true } });
    const cdir = path.join(t.ctx.dataRoot, "research-control", "run-cleanup");
    fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, "owner.json"), JSON.stringify({ token: "11111111-2222-3333-4444-555555555555", state: "complete", finished_at: FINISHED }));
    assert.equal(deleteRun(t.ctx, "run-cleanup").deleted, true);
    assert.equal(fs.existsSync(d), false, "运行目录应被删除");
    assert.equal(fs.existsSync(cdir), false, "control 目录要一起清掉:留着的话 reserveResearch 会判 run_exists");
  } finally { t.cleanup(); }
});

// chmod 在 Windows 上挡不住目录删除,这条只在 POSIX 跑(仓库既有写法,见 ingest.test.ts)
test("deleteRun:清 control 失败 → delete_failed(不是 500),且运行目录原封不动(锁住「先 control 后目录」的顺序)",
  { skip: process.platform === "win32" }, () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.runs, "run-locked");
    writeManifest(d, { run_id: "run-locked", symbol: "300308", status: "complete", exit_code: 0, finished_at: FINISHED, gate: { ok: true } });
    const croot = path.join(t.ctx.dataRoot, "research-control");
    fs.mkdirSync(path.join(croot, "run-locked"), { recursive: true });
    fs.writeFileSync(path.join(croot, "run-locked", "owner.json"), JSON.stringify({ token: "11111111-2222-3333-4444-555555555555", state: "complete", finished_at: FINISHED }));
    fs.chmodSync(croot, 0o500);   // 目录只读:删不掉里面的 run-locked
    try {
      // 删除动作自身失败抛的是 fs 的 errno 错误,不接就是 HTTP 500 "internal",用户看不到一句有用的话
      assert.throws(() => deleteRun(t.ctx, "run-locked"), (e: unknown) => codeOf(e) === "delete_failed");
      // 顺序反过来的话运行目录已经没了,而 control 成孤儿 —— 这条断言就是用来钉住顺序的
      assert.equal(fs.existsSync(d), true, "第一步失败时运行目录必须还在");
    } finally { fs.chmodSync(croot, 0o700); }
  } finally { t.cleanup(); }
});

test("deleteRun:目录不存在 → 404 语义(deleted:false),不抛", () => {
  const t = tmpCtx(); try {
    const r = deleteRun(t.ctx, "run-absent");
    assert.equal(r.deleted, false);
  } finally { t.cleanup(); }
});

test("deleteRun:非法 run-id(路径穿越)→ bad_run_id,不碰任何目录", () => {
  const t = tmpCtx(); try {
    assert.throws(() => deleteRun(t.ctx, "../../etc"), (e: unknown) => codeOf(e) === "bad_run_id");
  } finally { t.cleanup(); }
});

test("DELETE /runs/:id:404 体必须带 not_found 码,200 体不带;无 Bearer 一律 401", async () => {
  const TOKEN = "t".repeat(32);
  const t = tmpCtx();
  const server = createApiServer(t.ctx, { token: TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const del = (id: string, auth = true) => fetch(`${base}/runs/${id}`, { method: "DELETE", ...(auth ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {}) });
  try {
    // 前端靠这个码把"这条本来就不在了"和"代理/路由返回的 404"分开;光靠状态码分不开(见 backend.deleteRun)
    const gone = await del("run-absent");
    assert.equal(gone.status, 404);
    assert.deepEqual(await gone.json(), { run_id: "run-absent", deleted: false, error: "not_found" });
    const d = mkRun(t.runs, "run-http");
    writeManifest(d, { run_id: "run-http", symbol: "300308", status: "complete", exit_code: 0, finished_at: FINISHED, gate: { ok: true } });
    const ok = await del("run-http");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { run_id: "run-http", deleted: true }, "成功体不带 error 码");
    assert.equal(fs.existsSync(d), false);
    // cookie 鉴权只放行白名单只读 GET,删除必须带 Bearer
    assert.equal((await del("run-absent", false)).status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    t.cleanup();
  }
});
