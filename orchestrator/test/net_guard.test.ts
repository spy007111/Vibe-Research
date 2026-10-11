import assert from "node:assert/strict";
import type dns from "node:dns";
import http from "node:http";
import { test } from "node:test";
import zlib from "node:zlib";

import { DirectTransportError, chatCompletion, publicApiFailure, publicOnlyByDefault } from "../src/engines/direct_transport.ts";
import { NON_PUBLIC_CODE, isPublicAddress, publicOnlyLookup, publicOnlyPost } from "../src/net_guard.ts";

/**
 * 远程访问模式下页面填的模型地址:**连接时**查解析结果(Codex 审计 2026-10-09 A1)。
 * 写法检查(runtime_provider)管不到"公网域名解析到内网",这里补的就是那一层。
 */

test("显式网段:本机 / 内网 / 共享地址 / 元数据 / 包着内网 IPv4 的 IPv6 一律不是公网", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "100.64.0.1", "100.127.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "198.18.0.1", "192.0.2.1",
    "::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:7f00:1",
    "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "2002:a00:1::", "2001::1", "2001:db8::1", "::10.0.0.1", "[::1]", "fe80::1%en0",
    "not-an-ip", ""]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

const fakeResolve = (addrs: string[]) => ((_h: string, _o: unknown, cb: (e: Error | null, a: dns.LookupAddress[]) => void) =>
  cb(null, addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))) as unknown as typeof dns.lookup;

test("解析结果里**任何一个**不是公网就整条拒绝(只挑公网那个去连,换地址重试时仍会落到内网)", async () => {
  const run = (addrs: string[], all: boolean) => new Promise<unknown[]>((resolve) =>
    publicOnlyLookup(fakeResolve(addrs))("gw.example.com", { all }, (...args: unknown[]) => resolve(args)));
  const [err] = await run(["93.184.216.34", "10.0.0.5"], true);
  assert.equal((err as { code?: string }).code, NON_PUBLIC_CODE);
  assert.match(String((err as Error).message), /10\.0\.0\.5/);
  assert.equal(((await run([], false))[0] as { code?: string }).code, NON_PUBLIC_CODE, "解析出零个地址也不放行");
  const okAll = await run(["93.184.216.34"], true);
  assert.equal(okAll[0], null);
  assert.deepEqual(okAll[1], [{ address: "93.184.216.34", family: 4 }]);
  const okOne = await run(["2606:4700::1111"], false);
  assert.deepEqual(okOne, [null, "2606:4700::1111", 6]);
});

async function server(handler: http.RequestListener): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let n = 0;
  const s = http.createServer((req, res) => { n += 1; handler(req, res); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { port: (s.address() as { port: number }).port, hits: () => n,
    close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}
const baseReq = { apiKey: "sk-test-1234567890abcdefghij", model: "m", messages: [{ role: "user" as const, content: "hi" }], timeoutMs: 5_000 };

test("🔴 只连公网时,解析到本机的域名在**发包前**被拒:假端点收到 0 次请求,报 forbidden_address 且不重试", async () => {
  const ep = await server((_q, res) => { res.writeHead(200); res.end("{}"); });
  try {
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: `http://localhost:${ep.port}/v1`, publicOnly: true }), (e: unknown) => {
      assert.ok(e instanceof DirectTransportError);
      assert.equal(e.code, "forbidden_address");
      assert.equal(e.retryable, false);
      assert.equal(publicApiFailure(e, "x", "test").code, "api_address_forbidden");
      return true;
    });
    // IP 字面量不经过 lookup,也要拦
    await assert.rejects(chatCompletion({ ...baseReq, baseURL: `http://127.0.0.1:${ep.port}/v1`, publicOnly: true }),
      (e: unknown) => e instanceof DirectTransportError && e.code === "forbidden_address");
    assert.equal(ep.hits(), 0);
  } finally { await ep.close(); }
});

test("远程模式 + https 公网域名写法才自动打开;本机模式、本机地址、IP 不打开", () => {
  const remote = { VRA_REMOTE: "1" };
  assert.equal(publicOnlyByDefault("https://gw.example.com/v1/chat/completions", remote), true);
  assert.equal(publicOnlyByDefault("https://gw.example.com/v1/chat/completions", {}), false);
  for (const u of ["http://127.0.0.1:11434/v1", "http://localhost:11434/v1", "https://10.0.0.5/v1", "https://box.local/v1"]) {
    assert.equal(publicOnlyByDefault(u, remote), false, u);
  }
});

test("远程模式下模板 / 后台默认里的本机地址照常可用(不是公网域名写法就不套这一层)", async () => {
  const ep = await server((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] })); });
  const before = process.env.VRA_REMOTE;
  process.env.VRA_REMOTE = "1";
  try {
    const reply = await chatCompletion({ ...baseReq, baseURL: `http://127.0.0.1:${ep.port}/v1` });
    assert.equal(reply.message.content, "ok");
  } finally {
    if (before === undefined) delete process.env.VRA_REMOTE; else process.env.VRA_REMOTE = before;
    await ep.close();
  }
});

test("只连公网的 POST 返回标准 Response:状态、正文、跳转不跟随、取消都与 fetch 一致", async () => {
  const ep = await server((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1/admin" }); res.end("moved"); return; }
    if (req.url === "/hang") { res.writeHead(200); res.flushHeaders(); return; }
    let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { res.writeHead(201, { "x-a": "1" }); res.end(`got:${body}`); });
  });
  const allowAll = { resolve: fakeResolve(["127.0.0.1"]), allowed: () => true };
  const init = (signal = new AbortController().signal) => ({ headers: { "content-type": "text/plain" }, body: "hello", signal });
  try {
    const r = await publicOnlyPost(`http://gw.example.com:${ep.port}/x`, init(), allowAll);
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("x-a"), "1");
    assert.equal(await r.text(), "got:hello");
    const red = await publicOnlyPost(`http://gw.example.com:${ep.port}/redirect`, init(), allowAll);
    assert.equal(red.status, 302, "不跟随跳转,交给调用方按 3xx 报错");
    await red.body?.cancel();
    const ac = new AbortController();
    const hang = await publicOnlyPost(`http://gw.example.com:${ep.port}/hang`, init(ac.signal), allowAll);
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(hang.text());
  } finally { await ep.close(); }
});

test("🔴 压缩的响应(gzip / deflate / br,成功体和错误体)解压后再给出,与 fetch 一致;压缩体传到一半取消也会报错(审计第二轮 A1 修复引入)", async () => {
  const json = JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  const enc: Record<string, (b: Buffer) => Buffer> = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };
  let seenAccept = "";
  const ep = await server((req, res) => {
    seenAccept = String(req.headers["accept-encoding"] ?? "");
    const kind = req.url!.slice(1);
    if (kind === "hang") { res.writeHead(200, { "content-encoding": "gzip" }); res.write(zlib.gzipSync(Buffer.alloc(64 * 1024, "a")).subarray(0, 50)); return; }
    const [coding, status] = kind.split("-");
    res.writeHead(Number(status ?? 200), { "content-type": "application/json", "content-encoding": coding! });
    res.end(enc[coding!]!(Buffer.from(status ? '{"error":{"message":"bad key"}}' : json)));
  });
  const allowAll = { resolve: fakeResolve(["127.0.0.1"]), allowed: () => true };
  const init = (signal = new AbortController().signal) => ({ headers: { "content-type": "application/json" }, body: "{}", signal });
  try {
    for (const coding of ["gzip", "deflate", "br"]) {
      const r = await publicOnlyPost(`http://gw.example.com:${ep.port}/${coding}`, init(), allowAll);
      assert.deepEqual(await r.json(), JSON.parse(json), coding);
      const bad = await publicOnlyPost(`http://gw.example.com:${ep.port}/${coding}-401`, init(), allowAll);
      assert.equal(bad.status, 401);
      assert.match(await bad.text(), /bad key/, `${coding} 错误体`);
    }
    assert.match(seenAccept, /gzip/, "像 fetch 一样声明能解压");
    const ac = new AbortController();
    const hang = await publicOnlyPost(`http://gw.example.com:${ep.port}/hang`, init(ac.signal), allowAll);
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(hang.text());
  } finally { await ep.close(); }
});
