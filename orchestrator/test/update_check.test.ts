import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../src/api.ts";
import { CHECK_INTERVAL_MS, FETCH_TIMEOUT_MS, RELEASES_API, RETRY_INTERVAL_MS, isNewer, parseVersion, updateAction, updateStatus, type UpdateDeps } from "../src/update_check.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vr-update-"));
const T0 = Date.parse("2026-10-09T08:00:00Z");

type Call = { url: string; init: RequestInit };
function fakeFetch(reply: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return reply(calls.length);
  }) as typeof fetch;
  return { f, calls };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const release = (tag: string, extra: Record<string, unknown> = {}) => json({ tag_name: tag, html_url: "https://evil.example/x", published_at: "2026-10-08T00:00:00Z", draft: false, prerelease: false, body: "notes", ...extra });

function deps(over: Partial<UpdateDeps> & { fetchImpl: typeof fetch }): UpdateDeps & { clock: { t: number } } {
  const clock = { t: T0 };
  return { repoRoot: tmp(), dataRoot: tmp(), env: {}, now: () => clock.t, current: "2.0.0", clock, ...over };
}

test("新版提示:版本号只认 x.y.z(可带 v),预发布 / 看不懂的不比", () => {
  assert.deepEqual(parseVersion("v2.10.0"), [2, 10, 0]);
  assert.deepEqual(parseVersion(" 2.1.3 "), [2, 1, 3]);
  for (const bad of ["2.1", "2.1.0-beta.1", "latest", "", null, 2, "v2.1.0\n<script>"]) assert.equal(parseVersion(bad), null, String(bad));
  assert.ok(isNewer("2.10.0", "2.9.9"), "按数字比,不按字符串");
  assert.ok(isNewer("v3.0.0", "2.99.99"));
  assert.ok(!isNewer("2.0.0", "2.0.0"));
  assert.ok(!isNewer("1.9.9", "2.0.0"));
  assert.ok(!isNewer("2.1.0", "unknown"), "当前版本读不到就不提示");
});

test("新版提示:有新版就提示;请求只带版本号;链接按版本号自己拼,不用接口给的地址", async () => {
  const { f, calls } = fakeFetch(() => release("v2.1.0"));
  const d = deps({ fetchImpl: f });
  const v = await updateStatus(d);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RELEASES_API);
  const h = calls[0].init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(h).sort(), ["Accept", "User-Agent", "X-GitHub-Api-Version"]);
  assert.equal(h["User-Agent"], "VibeResearch/2.0.0");
  assert.ok(calls[0].init.signal instanceof AbortSignal, "要有超时");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(v.update_available, true);
  assert.deepEqual(v.latest, { version: "2.1.0", tag: "v2.1.0", url: "https://github.com/simonlin1212/Vibe-Research/releases/tag/v2.1.0", published_at: "2026-10-08T00:00:00Z" });
  assert.equal(v.current, "2.0.0");
  assert.equal(v.install, "source");
  assert.equal(v.error, null);
  const saved = JSON.parse(fs.readFileSync(path.join(d.dataRoot, "update.json"), "utf8"));
  assert.equal(saved.checked_at, new Date(T0).toISOString());
  assert.ok(!JSON.stringify(saved).includes("notes"), "发布说明不落盘");
});

test("新版提示:一天只查一次;失败一小时后重试;同时来的请求只查一次", async () => {
  let reply: () => Response = () => release("2.0.0");
  const { f, calls } = fakeFetch(() => reply());
  const d = deps({ fetchImpl: f });
  assert.equal((await updateStatus(d)).update_available, false, "已是最新");
  d.clock.t += CHECK_INTERVAL_MS - 1;
  await updateStatus(d);
  assert.equal(calls.length, 1, "不到一天不再查");
  d.clock.t += 1;
  reply = () => { throw new TypeError("fetch failed"); };
  const failed = await updateStatus(d);
  assert.equal(calls.length, 2);
  assert.match(failed.error ?? "", /连不上 GitHub/);
  assert.deepEqual(failed.latest?.version, "2.0.0", "查失败保留上次结果");
  d.clock.t += RETRY_INTERVAL_MS - 1;
  await updateStatus(d);
  assert.equal(calls.length, 2);
  d.clock.t += 1;
  reply = () => release("v2.2.0");
  const [a, b] = await Promise.all([updateStatus(d), updateStatus(d)]);
  assert.equal(calls.length, 3, "并发只发一次");
  assert.equal(a.latest?.version, "2.2.0");
  assert.equal(b.latest?.version, "2.2.0");
  assert.equal(a.error, null, "成功后清掉旧错误");
  // 时钟往回拨 / checked_at 写坏都按没查过处理
  d.clock.t -= 10 * CHECK_INTERVAL_MS;
  await updateStatus(d);
  assert.equal(calls.length, 4);
});

test("新版提示:超时、404、限流、看不懂的回复都如实写进 error,不提示", async () => {
  const cases: [() => Response | Promise<Response>, RegExp][] = [
    [() => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, new RegExp(`${FETCH_TIMEOUT_MS / 1000} 秒没有响应`)],
    [() => json({ message: "Not Found" }, 404), /还没有正式发布/],
    [() => json({ message: "rate limit" }, 403), /限制了查询次数/],
    [() => json({}, 502), /GitHub 返回 502/],
    [() => new Response("<html>", { status: 200 }), /看不懂/],
    [() => release("nightly<b>"), /版本号看不懂:nightlyb$/],
    [() => release("v9.0.0", { prerelease: true }), /还没有正式发布/],
    [() => new Response("x".repeat(2_000_001)), /太大/],
  ];
  for (const [reply, why] of cases) {
    const v = await updateStatus(deps({ fetchImpl: fakeFetch(reply).f }));
    assert.match(v.error ?? "", why);
    assert.equal(v.update_available, false);
    assert.equal(v.latest, null);
  }
});

test("新版提示:真实超时 5 秒内返回(用打桩的慢服务器)", async () => {
  const srv = http.createServer(() => { /* 永不回复 */ });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const f = ((_u: string, init: RequestInit) => fetch(`http://127.0.0.1:${port}/`, init)) as typeof fetch;
  const t = Date.now();
  try {
    const v = await updateStatus({ ...deps({ fetchImpl: f }), now: Date.now });
    assert.match(v.error ?? "", /秒没有响应/);
    assert.ok(Date.now() - t < FETCH_TIMEOUT_MS + 2000);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test("新版提示:关掉 / 跳过某版 / 环境变量关掉都不联网或不提示;再打开照常", async () => {
  const { f, calls } = fakeFetch(() => release("v2.1.0"));
  const d = deps({ fetchImpl: f });
  assert.equal((await updateAction(d, { action: "skip", version: "v2.1.0" })).skip_version, "2.1.0");
  assert.equal((await updateStatus(d)).update_available, false, "跳过的版本不提示");
  assert.equal(calls.length, 1);
  calls.length = 0;
  const off = await updateAction(d, { action: "disable" });
  assert.equal(off.enabled, false);
  d.clock.t += 2 * CHECK_INTERVAL_MS;
  assert.equal((await updateStatus(d)).update_available, false);
  assert.equal((await updateAction(d, { action: "check" })).update_available, false);
  assert.equal(calls.length, 0, "关掉后连「现在检查」也不联网");
  const on = await updateAction(d, { action: "enable" });
  assert.equal(on.enabled, true);
  assert.equal(on.skip_version, null, "重新打开也恢复跳过的版本");
  const newer = fakeFetch(() => release("v2.2.0"));
  const d2 = { ...d, fetchImpl: newer.f };
  assert.equal((await updateAction(d2, { action: "check" })).update_available, true, "更高的版本照常提示");
  // 环境变量关掉:不联网,也不提示
  const envOff = fakeFetch(() => release("v9.0.0"));
  for (const val of ["0", "false", "OFF", " no "]) {
    const v = await updateAction({ ...d, fetchImpl: envOff.f, env: { VRA_UPDATE_CHECK: val } }, { action: "check" });
    assert.equal(v.env_disabled, true);
    assert.equal(v.update_available, false);
  }
  assert.equal(envOff.calls.length, 0);
  // 参数错按原因拒
  await assert.rejects(updateAction(d, { action: "skip", version: "latest" }), /版本号看不懂/);
  await assert.rejects(updateAction(d, { action: "nuke" }), /action 只能是/);
});

test("新版提示:查的时候用户刚关掉,以磁盘上的开关为准;状态文件坏了按默认", async () => {
  let release2: (r: Response) => void = () => {};
  const { f } = fakeFetch(() => new Promise<Response>((r) => { release2 = r; }));
  const d = deps({ fetchImpl: f });
  const pending = updateStatus(d);
  await new Promise((r) => setTimeout(r, 10));
  await updateAction(d, { action: "disable" });
  release2(release("v2.1.0"));
  const v = await pending;
  assert.equal(v.enabled, false, "检查结果不能把刚关掉的开关改回来");
  assert.equal(v.update_available, false);
  fs.writeFileSync(path.join(d.dataRoot, "update.json"), "{bad");
  const fresh = await updateStatus({ ...d, fetchImpl: fakeFetch(() => release("v2.0.1")).f });
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.update_available, true);
  // 手改出来的 latest 地址不是本仓库发布页 → 丢掉
  fs.writeFileSync(path.join(d.dataRoot, "update.json"), JSON.stringify({ enabled: true, checked_at: new Date(d.clock.t).toISOString(), latest: { version: "9.0.0", url: "https://evil.example/" } }));
  const tampered = await updateStatus(d);
  assert.equal(tampered.latest, null);
  assert.equal(tampered.update_available, false);
  // 地址以本仓库发布页开头但用 ../ 跳到别处:存的地址一律不用,按标签重拼
  const at = new Date(d.clock.t).toISOString();
  const put = (latest: unknown) => fs.writeFileSync(path.join(d.dataRoot, "update.json"), JSON.stringify({ enabled: true, checked_at: at, latest }));
  put({ version: "9.0.0", tag: "v9.0.0", url: "https://github.com/simonlin1212/Vibe-Research/releases/../../../evil/repo/releases" });
  assert.equal((await updateStatus(d)).latest?.url, "https://github.com/simonlin1212/Vibe-Research/releases/tag/v9.0.0");
  for (const bad of [
    { version: "9.0.0", tag: "v9.0.0/../../../evil" },
    { version: "9.0.0", tag: " v9.0.0" },
    { version: "9.0.0", tag: "v8.0.0" },
    { version: "9.0.0" },
  ]) {
    put(bad);
    assert.equal((await updateStatus(d)).latest, null, JSON.stringify(bad));
  }
});

test("新版提示:接口给的标签带路径或怪字符就不用", async () => {
  for (const tag of ["v2.1.0/../../x", "v2.1.0?x=1", "v2.1.0#a"]) {
    const v = await updateStatus(deps({ fetchImpl: fakeFetch(() => release(tag)).f }));
    assert.equal(v.latest, null, tag);
    assert.match(v.error ?? "", /版本号看不懂/);
  }
  const padded = await updateStatus(deps({ fetchImpl: fakeFetch(() => release("  v2.1.0 ")).f }));
  assert.equal(padded.latest?.url, "https://github.com/simonlin1212/Vibe-Research/releases/tag/v2.1.0", "前后空白去掉后再拼");
});

test("新版提示:免安装包按 package-info.json 识别;写不了盘也照样返回", async () => {
  const d = deps({ fetchImpl: fakeFetch(() => release("v2.1.0")).f });
  fs.writeFileSync(path.join(d.repoRoot, "package-info.json"), JSON.stringify({ kind: "portable", version: "2.0.0" }));
  assert.equal((await updateStatus(d)).install, "portable");
  const ro = tmp();
  const file = path.join(ro, "not-a-dir");
  fs.writeFileSync(file, "");
  const v = await updateStatus({ ...d, dataRoot: file });
  assert.match(v.error ?? "", /没能保存/);
});

test("新版提示 API:要口令;GET / POST 走通;环境变量关掉时不联网", async () => {
  const prev = process.env.VRA_UPDATE_CHECK;
  process.env.VRA_UPDATE_CHECK = "0";
  const ctx = { repoRoot, dataRoot: tmp(), python: "python3", node: process.execPath };
  const TOKEN = "u".repeat(32);
  const srv = createApiServer(ctx, { token: TOKEN });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const call = (method: string, p: string, body?: unknown, auth = true) => fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ code: r.status, json: await r.json() as Record<string, unknown> }));
  try {
    assert.equal((await call("GET", "/update", undefined, false)).code, 401);
    const g = await call("GET", "/update");
    assert.equal(g.code, 200);
    assert.equal(g.json.env_disabled, true);
    assert.equal(g.json.checked_at, null, "没联网");
    assert.equal(g.json.install, "source");
    assert.ok(!JSON.stringify(g.json).includes(ctx.dataRoot), "不回传路径");
    const p = await call("POST", "/update", { action: "disable" });
    assert.equal(p.code, 200);
    assert.equal(p.json.enabled, false);
    const bad = await call("POST", "/update", { action: "x" });
    assert.equal(bad.code, 400);
    assert.equal(bad.json.error, "bad_update_action");
  } finally {
    srv.close();
    if (prev === undefined) delete process.env.VRA_UPDATE_CHECK; else process.env.VRA_UPDATE_CHECK = prev;
  }
});
