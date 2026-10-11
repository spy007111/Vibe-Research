/**
 * 防篡改登记簿:链的复算、现状对比、补登 / 重新登记、链头核对,以及「登记失败不拦原操作」。
 * 每种篡改都真的去改磁盘文件,而不是改内存里的对象 —— 要防的就是绕开软件直接动文件。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import { GENESIS, appendAudit, canonicalJson, chainFile, checkHead, fingerprint, formatHead, parseChain, runSeal, verifyAudit, type AuditEntry } from "../src/audit_chain.ts";
import { createApiServer } from "../src/api.ts";
import { auditCheckHead, auditRegister, auditVerify, deleteRun, ledgerInsertMany, ledgerRemove, ledgerUpsert, ServiceError, type ServiceContext } from "../src/service.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FINISHED = "2026-10-09T15:00:00.000+08:00";

function tmpCtx(): { ctx: ServiceContext; cleanup: () => void } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vr-audit-"));
  return { ctx: { repoRoot: REPO, dataRoot, python: "python3", node: "node" }, cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }) };
}

const APPENDIX = "## 附录\n证据 ev-aaaaaa\n";
const VIEWER = "<html>查看器</html>";
/** 造一次已结束的研究运行(清单 + 报告 + 证据 + 阶段 + 原始文件 + 附录 + 查看器),返回目录 */
function mkRun(ctx: ServiceContext, id: string, finished = true): string {
  const d = path.join(ctx.dataRoot, "runs", id);
  for (const sub of ["stages", "raw", "fetch", "calcs"]) fs.mkdirSync(path.join(d, sub), { recursive: true });
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ run_id: id, status: finished ? "complete" : "running", finished_at: finished ? FINISHED : null }));
  fs.writeFileSync(path.join(d, "report.md"), "状态:complete\n\n# 结论\n数字 12.3 [ev-aaaaaa]\n");
  fs.writeFileSync(path.join(d, "evidence.json"), JSON.stringify([{ id: "ev-aaaaaa", value: 12.3 }]));
  fs.writeFileSync(path.join(d, "stages", "profile.json"), JSON.stringify({ stage: "profile", gaps: [] }));
  fs.writeFileSync(path.join(d, "raw", "resp_1.json"), JSON.stringify({ v: 1 }));
  fs.writeFileSync(path.join(d, "report_appendix.md"), APPENDIX);
  fs.writeFileSync(path.join(d, "viewer.html"), VIEWER);
  fs.writeFileSync(path.join(d, "events.jsonl"), "{}\n");
  return d;
}
const seal = (ctx: ServiceContext, id: string) => appendAudit(ctx.dataRoot, [runSeal(id, path.join(ctx.dataRoot, "runs", id))]);
const chainLines = (ctx: ServiceContext) => fs.readFileSync(chainFile(ctx.dataRoot), "utf8").split("\n").filter(Boolean);
const note = (title: string) => ({ title, body: "正文", category: "review" });
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

const kinds = (ctx: ServiceContext) => auditVerify(ctx).issues.map((i) => `${i.subject}:${i.kind}:${i.ref}`).sort();

test("规范化 JSON:键顺序不影响指纹,undefined 键与没有这个键相同", () => {
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: null }] }), '{"a":[1,{"c":null,"d":2}],"b":1}');
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.equal(fingerprint({ a: 1, b: undefined }), fingerprint({ a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: "1" }));
});

test("追加:序号从 1 连续、第一条接 64 个 0、每条接上一条;一次多条也是一条条接", () => {
  const t = tmpCtx(); try {
    const a = appendAudit(t.ctx.dataRoot, [{ subject: "ledger", ref: "note/a", action: "save", content: fingerprint(1) }]);
    const b = appendAudit(t.ctx.dataRoot, [
      { subject: "ledger", ref: "note/b", action: "save", content: fingerprint(2) },
      { subject: "ledger", ref: "note/a", action: "remove", content: null },
    ]);
    assert.equal(a[0]!.seq, 1); assert.equal(a[0]!.prev, GENESIS);
    assert.deepEqual(b.map((e) => e.seq), [2, 3]);
    assert.equal(b[0]!.prev, a[0]!.hash); assert.equal(b[1]!.prev, b[0]!.hash);
    const parsed = parseChain(fs.readFileSync(chainFile(t.ctx.dataRoot), "utf8"));
    assert.equal(parsed.entries.length, 3);
    assert.deepEqual(parsed.problems, []);
  } finally { t.cleanup(); }
});

test("台账:从软件里增改删都登记,核对一致;绕开软件改 / 删 / 加,各报一种问题", () => {
  const t = tmpCtx(); try {
    const a = ledgerUpsert(t.ctx, { kind: "note", record: note("第一条") });
    const b = ledgerUpsert(t.ctx, { kind: "note", record: note("第二条") });
    ledgerUpsert(t.ctx, { kind: "note", record: { ...note("第二条改"), id: b.id } });
    const [c] = ledgerInsertMany(t.ctx, { kind: "note", records: [note("第三条")] });
    ledgerRemove(t.ctx, { kind: "note", id: c!.id });
    let r = auditVerify(t.ctx);
    assert.equal(r.chain_ok, true);
    assert.deepEqual(r.issues, []);
    assert.equal(r.consistent.ledger, 2);
    assert.equal(r.entries, 5);
    assert.deepEqual(chainLines(t.ctx).map((l) => (JSON.parse(l) as AuditEntry).action), ["save", "save", "save", "save", "remove"]);

    // 绕开软件:改 a、删 b、手写一条新的
    const file = path.join(t.ctx.dataRoot, "ledger", "note.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.records = data.records.filter((x: { id: string }) => x.id !== b.id)
      .map((x: { id: string; title: string }) => (x.id === a.id ? { ...x, title: "被人改过" } : x));
    data.records.push({ ...note("手写的"), id: "note-hand", kind: "note", created_at: FINISHED, updated_at: FINISHED });
    fs.writeFileSync(file, JSON.stringify(data));
    r = auditVerify(t.ctx);
    assert.equal(r.chain_ok, true, "改的是台账不是登记簿,链本身是通的");
    assert.deepEqual(kinds(t.ctx), [`ledger:changed:note/${a.id}`, `ledger:missing:note/${b.id}`, "ledger:unregistered:note/note-hand"].sort());
    assert.equal(r.issues.find((i) => i.kind === "changed")!.last!.action, "save");

    // 从软件里删过的 c 被人手动加回来 → 报「又出现了」,不是普通的改过
    data.records.push({ ...note("第三条"), id: c!.id, kind: "note", created_at: FINISHED, updated_at: FINISHED });
    fs.writeFileSync(file, JSON.stringify(data));
    const back = auditVerify(t.ctx).issues.find((i) => i.ref === `note/${c!.id}`)!;
    assert.equal(back.kind, "changed"); assert.match(back.why, /已删除，现在又出现了/);

    // 删一条本来就没有的:什么都没删,就不登记
    const n = chainLines(t.ctx).length;
    assert.equal(ledgerRemove(t.ctx, { kind: "note", id: "note-nope" }).removed, false);
    assert.equal(chainLines(t.ctx).length, n);
  } finally { t.cleanup(); }
});

test("研究运行:登记后改报告 / 加原始文件 / 删阶段结果都能说出是哪个文件;过程日志不算内容,附录和查看器算", () => {
  const t = tmpCtx(); try {
    const d = mkRun(t.ctx, "r1");
    seal(t.ctx, "r1");
    fs.appendFileSync(path.join(d, "events.jsonl"), "{\"later\":1}\n");
    assert.deepEqual(auditVerify(t.ctx).issues, [], "过程日志追加不算改动");
    assert.equal(auditVerify(t.ctx).consistent.run, 1);

    // 附录显示在报告下面、查看器里嵌着报告:直接改它们也要查出来
    fs.appendFileSync(path.join(d, "report_appendix.md"), "加了一句\n");
    fs.writeFileSync(path.join(d, "viewer.html"), "<html>换过</html>");
    assert.deepEqual(auditVerify(t.ctx).issues[0]!.files, { changed: ["report_appendix.md", "viewer.html"], added: [], removed: [] });
    fs.writeFileSync(path.join(d, "report_appendix.md"), APPENDIX); fs.writeFileSync(path.join(d, "viewer.html"), VIEWER);
    assert.deepEqual(auditVerify(t.ctx).issues, [], "改回原样就一致");

    fs.writeFileSync(path.join(d, "report.md"), "状态:complete\n\n# 结论\n数字 99.9 [ev-aaaaaa]\n");
    fs.writeFileSync(path.join(d, "raw", "resp_2.json"), "{}");
    fs.rmSync(path.join(d, "stages", "profile.json"));
    const [issue] = auditVerify(t.ctx).issues;
    assert.equal(issue!.kind, "changed");
    assert.deepEqual(issue!.files, { changed: ["report.md"], added: ["raw/resp_2.json"], removed: ["stages/profile.json"] });
  } finally { t.cleanup(); }
});

test("研究运行:没结束的不判没登记;已结束没登记的要补登;从软件删除不报,手动删目录报不见了", () => {
  const t = tmpCtx(); try {
    mkRun(t.ctx, "running", false);
    mkRun(t.ctx, "old");
    mkRun(t.ctx, "gone");
    mkRun(t.ctx, "deleted");
    seal(t.ctx, "gone"); seal(t.ctx, "deleted");
    assert.deepEqual(kinds(t.ctx), ["run:unregistered:old"]);
    assert.equal(deleteRun(t.ctx, "deleted").deleted, true);
    fs.rmSync(path.join(t.ctx.dataRoot, "runs", "gone"), { recursive: true });
    assert.deepEqual(kinds(t.ctx), ["run:missing:gone", "run:unregistered:old"]);
    assert.equal((JSON.parse(chainLines(t.ctx).at(-1)!) as AuditEntry).action, "remove");
    mkRun(t.ctx, "deleted");   // 删过的目录被人放回来
    const back = auditVerify(t.ctx).issues.find((i) => i.ref === "deleted")!;
    assert.equal(back.kind, "changed"); assert.match(back.why, /已删除，现在又出现了/);
  } finally { t.cleanup(); }
});

test("补登只登没登记的;改过的 / 不见了的要明说才认,认了以后旧登记仍在链上", () => {
  const t = tmpCtx(); try {
    mkRun(t.ctx, "old");
    const a = ledgerUpsert(t.ctx, { kind: "note", record: note("a") });
    const b = ledgerUpsert(t.ctx, { kind: "note", record: note("b") });
    const file = path.join(t.ctx.dataRoot, "ledger", "note.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.records = data.records.filter((x: { id: string }) => x.id !== b.id).map((x: { id: string }) => (x.id === a.id ? { ...x, title: "改" } : x));
    fs.writeFileSync(file, JSON.stringify(data));

    let out = auditRegister(t.ctx, {});
    assert.equal(out.added, 1);
    assert.deepEqual(out.report.issues.map((i) => i.kind).sort(), ["changed", "missing"]);
    assert.equal((JSON.parse(chainLines(t.ctx).at(-1)!) as AuditEntry).action, "backfill");

    out = auditRegister(t.ctx, { changed: true, missing: "yes" });   // 只有 true 才算明说
    assert.equal(out.added, 1);
    assert.deepEqual(out.report.issues.map((i) => i.kind), ["missing"]);
    out = auditRegister(t.ctx, { missing: true });
    assert.equal(out.added, 1);
    assert.deepEqual(out.report.issues, []);
    const actions = chainLines(t.ctx).map((l) => (JSON.parse(l) as AuditEntry).action);
    assert.deepEqual(actions, ["save", "save", "backfill", "reseal", "drop"]);
    assert.equal(out.report.chain_ok, true);
  } finally { t.cleanup(); }
});

test("改登记簿:改一条报「被改过」,改完重算指纹也接不上下一条,删中间一条只报一处「接不上」,插一条同样接不上", () => {
  for (const how of ["edit", "rehash", "delete", "insert"] as const) {
    const t = tmpCtx(); try {
      for (const x of ["a", "b", "c", "d"]) ledgerUpsert(t.ctx, { kind: "note", record: note(x) });
      const lines = chainLines(t.ctx);
      if (how === "edit") { const e = JSON.parse(lines[1]!); e.ref = "note/别的"; lines[1] = JSON.stringify(e); }
      if (how === "rehash") {   // 懂算法的人:改完把这条自己的指纹也重算
        const e = JSON.parse(lines[1]!); e.ref = "note/别的";
        e.hash = fingerprint({ seq: e.seq, at: e.at, subject: e.subject, ref: e.ref, action: e.action, content: e.content, files: e.files, prev: e.prev });
        lines[1] = JSON.stringify(e);
      }
      if (how === "delete") lines.splice(1, 1);
      if (how === "insert") lines.splice(2, 0, lines[1]!);
      fs.writeFileSync(chainFile(t.ctx.dataRoot), lines.join("\n") + "\n");
      const r = auditVerify(t.ctx);
      assert.equal(r.chain_ok, false, how);
      const serious = r.problems.filter((p) => p.serious);
      if (how === "edit") assert.deepEqual(serious.map((p) => p.why.slice(0, 6)), ["这一条被改过"]);
      else assert.equal(serious.length, 1, `${how}:${JSON.stringify(serious)}`);
      if (how !== "edit") assert.match(serious[0]!.why, /接不上|序号不连续/);
      if (how === "rehash") assert.deepEqual(serious.map((p) => [p.line, p.why.slice(0, 7)]), [[3, "和上一条接不上"]]);
    } finally { t.cleanup(); }
  }
});

test("写到一半中断:最后半行不算链断;下一次登记另起一行,照常接在最后一条完整的后面", () => {
  const t = tmpCtx(); try {
    ledgerUpsert(t.ctx, { kind: "note", record: note("a") });
    fs.appendFileSync(chainFile(t.ctx.dataRoot), '{"seq":2,"at":"2026-10');   // 没有换行的半截
    let r = auditVerify(t.ctx);
    assert.equal(r.chain_ok, true);
    assert.equal(r.problems.length, 1);
    assert.equal(r.problems[0]!.serious, false);
    assert.match(r.problems[0]!.why, /没写完/);
    const b = ledgerUpsert(t.ctx, { kind: "note", record: note("b") });
    r = auditVerify(t.ctx);
    assert.equal(r.chain_ok, true);
    assert.equal(r.entries, 2);
    assert.deepEqual(r.issues, []);
    assert.equal(r.head!.seq, 2);
    assert.match(r.problems[0]!.why, /读不出来/, "半截变成中间一行,说法跟着变");
    assert.ok(b.id);
  } finally { t.cleanup(); }
});

test("链头:对得上 / 登记被删减 / 整份按新内容重写 / 粘错东西,各有说法", () => {
  const t = tmpCtx(); try {
    for (const x of ["a", "b", "c"]) ledgerUpsert(t.ctx, { kind: "note", record: note(x) });
    const saved = auditVerify(t.ctx).head_text!;
    assert.match(saved, /^登记簿第 3 条 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · [0-9a-f]{64}$/);
    ledgerUpsert(t.ctx, { kind: "note", record: note("d") });
    assert.equal(auditCheckHead(t.ctx, saved).ok, true, "之后又登记了新的,旧链头照样对得上");
    assert.equal(checkHead(t.ctx.dataRoot, saved.split(" · ").at(-1)!).ok, true, "只粘指纹也能找");

    // 整份重写:改掉第 2 条的内容,再从头把链重算一遍 —— 链本身是通的,只有旧链头能发现
    const lines = chainLines(t.ctx).map((l) => JSON.parse(l) as AuditEntry);
    fs.rmSync(chainFile(t.ctx.dataRoot));
    for (const e of lines) appendAudit(t.ctx.dataRoot, [{ subject: e.subject, ref: e.ref, action: e.action, content: e.seq === 2 ? fingerprint("假的") : e.content }]);
    assert.equal(auditVerify(t.ctx).chain_ok, true);
    const rewritten = auditCheckHead(t.ctx, saved);
    assert.equal(rewritten.ok, false);
    assert.match(rewritten.why, /第 3 条的指纹对不上/);

    // 删减到只剩 2 条
    fs.writeFileSync(chainFile(t.ctx.dataRoot), chainLines(t.ctx).slice(0, 2).join("\n") + "\n");
    assert.match(auditCheckHead(t.ctx, saved).why, /只到第 2 条/);
    assert.match(checkHead(t.ctx.dataRoot, "ab".repeat(32)).why, /找不到这个指纹/);
    assert.match(checkHead(t.ctx.dataRoot, "随便一段话").why, /没在粘贴的内容里找到/);
    // 第 3 条那一行被改坏(读不出来):不能说成「少了」
    fs.writeFileSync(chainFile(t.ctx.dataRoot), [...chainLines(t.ctx), "{坏掉的一行"].join("\n") + "\n");
    const garbled = auditCheckHead(t.ctx, saved);
    assert.equal(garbled.ok, false); assert.match(garbled.why, /第 3 行读不出来/);
    assert.doesNotMatch(garbled.why, /少/);
    assert.throws(() => auditCheckHead(t.ctx, "  "), (e: unknown) => e instanceof ServiceError && e.code === "bad_head");
  } finally { t.cleanup(); }
});

test("链头那一条被删、后面的还在 → 说「这一条被删掉」,不说「少了」", () => {
  const t = tmpCtx(); try {
    for (const x of ["a", "b"]) ledgerUpsert(t.ctx, { kind: "note", record: note(x) });
    const saved = auditVerify(t.ctx).head_text!;   // 第 2 条
    for (const x of ["c", "d"]) ledgerUpsert(t.ctx, { kind: "note", record: note(x) });
    const lines = chainLines(t.ctx);
    fs.writeFileSync(chainFile(t.ctx.dataRoot), [lines[0], lines[2], lines[3]].join("\n") + "\n");
    const r = auditCheckHead(t.ctx, saved);
    assert.equal(r.ok, false); assert.match(r.why, /没有第 2 条，却有更后面的登记/);
  } finally { t.cleanup(); }
});

test("链头对得上但它之前的登记有一行被改过 → 不能算完好", () => {
  const t = tmpCtx(); try {
    for (const x of ["a", "b", "c"]) ledgerUpsert(t.ctx, { kind: "note", record: note(x) });
    const saved = auditVerify(t.ctx).head_text!;
    const lines = chainLines(t.ctx);
    const e = JSON.parse(lines[0]!); e.content = fingerprint("改"); lines[0] = JSON.stringify(e);
    fs.writeFileSync(chainFile(t.ctx.dataRoot), lines.join("\n") + "\n");
    const r = auditCheckHead(t.ctx, saved);
    assert.equal(r.ok, false);
    assert.match(r.why, /第 1 行有问题/);
  } finally { t.cleanup(); }
});

test("登记写不进去时,台账照常保存;核对把没登记上的报出来", () => {
  const t = tmpCtx(); try {
    fs.writeFileSync(path.join(t.ctx.dataRoot, "audit"), "占位:不是目录");   // 登记簿目录建不出来
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
    let saved;
    try { saved = ledgerUpsert(t.ctx, { kind: "note", record: note("照常保存") }); } finally { console.error = orig; }
    assert.ok(saved.id);
    assert.ok(errs.some((m) => m.includes("[audit] 登记没写进去")), errs.join("\n"));
    fs.rmSync(path.join(t.ctx.dataRoot, "audit"));
    assert.deepEqual(kinds(t.ctx), [`ledger:unregistered:note/${saved.id}`]);
  } finally { t.cleanup(); }
});

test("登记簿是符号链接 → 拒绝读写", () => {
  const t = tmpCtx(); try {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "vr-audit-elsewhere-"));
    fs.writeFileSync(path.join(elsewhere, "chain.jsonl"), "");
    fs.mkdirSync(path.join(t.ctx.dataRoot, "audit"));
    fs.symlinkSync(path.join(elsewhere, "chain.jsonl"), chainFile(t.ctx.dataRoot));
    assert.throws(() => auditVerify(t.ctx), (e: unknown) => e instanceof ServiceError);
    const empty = { runs: new Map(), ledger: new Map() };
    assert.throws(() => verifyAudit(t.ctx.dataRoot, empty), (e: unknown) => (e as { code?: string }).code === "chain_link");
    assert.throws(() => checkHead(t.ctx.dataRoot, "a".repeat(64)), (e: unknown) => (e as { code?: string }).code === "chain_link");
    assert.throws(() => appendAudit(t.ctx.dataRoot, [{ subject: "ledger", ref: "note/x", action: "save", content: fingerprint(1) }]));
    assert.equal(fs.readFileSync(path.join(elsewhere, "chain.jsonl"), "utf8"), "", "链接指向的文件没被写");
    fs.rmSync(elsewhere, { recursive: true, force: true });
  } finally { t.cleanup(); }

  // 登记簿所在的文件夹是链接:同样拒绝,而且不往链接那头写任何东西(锁文件也不写)
  const t2 = tmpCtx(); try {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "vr-audit-dirlink-"));
    fs.symlinkSync(elsewhere, path.join(t2.ctx.dataRoot, "audit"));
    const isLink = (e: unknown) => (e as { code?: string }).code === "chain_link";
    assert.throws(() => appendAudit(t2.ctx.dataRoot, [{ subject: "ledger", ref: "note/x", action: "save", content: fingerprint(1) }]), isLink);
    assert.throws(() => verifyAudit(t2.ctx.dataRoot, { runs: new Map(), ledger: new Map() }), isLink);
    assert.throws(() => checkHead(t2.ctx.dataRoot, "a".repeat(64)), isLink);
    assert.throws(() => auditVerify(t2.ctx), (e: unknown) => e instanceof ServiceError);
    assert.deepEqual(fs.readdirSync(elsewhere), [], "链接那头一个文件都没写");
    fs.rmSync(elsewhere, { recursive: true, force: true });
  } finally { t2.cleanup(); }
});

test("防篡改接口:核对 / 补登 / 链头三条路都要鉴权,补登只认 true,链头太长或为空拒绝", async () => {
  const t = tmpCtx(); try {
    mkRun(t.ctx, "old");
    await withApi(t.ctx, async (call) => {
      assert.equal((await call("/audit", undefined, "wrong")).status, 401);
      assert.equal((await call("/audit/register", {}, "wrong")).status, 401);
      let r = await (await call("/audit")).json() as { issues: { kind: string }[]; head_text: string | null };
      assert.deepEqual(r.issues.map((i) => i.kind), ["unregistered"]); assert.equal(r.head_text, null);
      const reg = await (await call("/audit/register", { changed: "yes" })).json() as { added: number; report: { head_text: string } };
      assert.equal(reg.added, 1);
      r = await (await call("/audit")).json() as { issues: { kind: string }[]; head_text: string | null };
      assert.deepEqual(r.issues, []); assert.match(r.head_text ?? "", /^登记簿第 1 条 · /);
      const ok = await (await call("/audit/check-head", { head: r.head_text })).json() as { ok: boolean };
      assert.equal(ok.ok, true);
      for (const head of ["", "x".repeat(2001), 42]) {
        const bad = await call("/audit/check-head", { head });
        assert.equal(bad.status, 400, String(head).slice(0, 10)); assert.equal((await bad.json() as { error: string }).error, "bad_head");
      }
    });
  } finally { t.cleanup(); }
});

test("核对只读:跑完核对,登记簿和数据都一字不变", () => {
  const t = tmpCtx(); try {
    mkRun(t.ctx, "old");
    ledgerUpsert(t.ctx, { kind: "note", record: note("a") });
    const before = fs.readFileSync(chainFile(t.ctx.dataRoot), "utf8");
    const r = verifyAudit(t.ctx.dataRoot, { runs: new Map([["old", { dir: path.join(t.ctx.dataRoot, "runs", "old"), finished: true }]]), ledger: new Map() });
    assert.equal(r.issues.length, 2);
    auditVerify(t.ctx);
    assert.equal(fs.readFileSync(chainFile(t.ctx.dataRoot), "utf8"), before);
    assert.equal(formatHead({ seq: 7, at: "2026-10-09T15:20:31.000+08:00", hash: "f".repeat(64) }), `登记簿第 7 条 · 2026-10-09 15:20 · ${"f".repeat(64)}`);
  } finally { t.cleanup(); }
});
