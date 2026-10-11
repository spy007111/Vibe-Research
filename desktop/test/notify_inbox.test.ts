import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import { WEBHOOK_KINDS, formatInboxTime, jobStatusLabel } from "../src/verticals/finance/lib/notify.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");

test("任务状态文案:运行中优先,没跑过与今天不运行分开", () => {
  assert.deepEqual(jobStatusLabel({ status: "ok", running: true }), { text: "运行中", tone: "muted" });
  assert.deepEqual(jobStatusLabel({ status: "ok", running: false }), { text: "已运行", tone: "ok" });
  assert.deepEqual(jobStatusLabel({ status: "failed", running: false }), { text: "失败", tone: "bad" });
  assert.deepEqual(jobStatusLabel({ status: "blocked", running: false }), { text: "等待中", tone: "warn" });
  assert.deepEqual(jobStatusLabel({ status: "skipped", running: false }), { text: "今天不运行", tone: "muted" });
  assert.deepEqual(jobStatusLabel({ status: null, running: false }), { text: "还没运行过", tone: "muted" });
});

test("收件箱时间:当天只显示时分,跨天带日期,坏时间不显示", () => {
  const now = new Date(2026, 9, 8, 18, 0);
  assert.doesNotMatch(formatInboxTime(new Date(2026, 9, 8, 15, 41).toISOString(), now), /10/);
  assert.match(formatInboxTime(new Date(2026, 9, 8, 15, 41).toISOString(), now), /15:41/);
  assert.match(formatInboxTime(new Date(2026, 9, 7, 15, 41).toISOString(), now), /10.*07.*15:41/);
  assert.equal(formatInboxTime("not-a-date", now), "");
});

test("三种群机器人都有接入说明,企业微信不出签名框", () => {
  assert.deepEqual(WEBHOOK_KINDS.map((k) => k.kind), ["feishu", "wecom", "dingtalk"]);
  assert.equal(WEBHOOK_KINDS.find((k) => k.kind === "wecom")!.signLabel, null);
  for (const k of WEBHOOK_KINDS) assert.ok(k.hint.length > 20, k.kind);
});

test("前端调用:读走 GET,写走 POST JSON,测试只带渠道 id", async () => {
  const prev = globalThis.fetch;
  const calls: { url: string; method: string; body?: string }[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await backend.notify();
    await backend.notifyAction("inbox/read", { all: true });
    await backend.notifyTest("system");
  } finally { globalThis.fetch = prev; }
  assert.deepEqual(calls.map((c) => [c.url, c.method]), [["/api/notify", "GET"], ["/api/notify/inbox/read", "POST"], ["/api/notify/test", "POST"]]);
  assert.deepEqual(JSON.parse(calls[1]!.body!), { all: true });
  assert.deepEqual(JSON.parse(calls[2]!.body!), { channel: "system" });
});

test("提醒页:地址和密钥用密码框、不进本地存储,说明只在程序运行时生效,不给买卖建议", () => {
  const page = read("pages/Inbox.tsx");
  assert.match(page, /aria-label="Webhook 地址" type="password" autoComplete="off"/);
  assert.match(page, /type="password" autoComplete="off" spellCheck=\{false\} value=\{secret\}/);
  assert.doesNotMatch(page, /localStorage|storageSet|sessionStorage/);
  assert.match(page, /电脑关机或程序没开时不会运行/);
  assert.match(page, /只列事实,不给买卖建议/);
  assert.match(page, /NOTIFY_CHANGED/);
  const layout = read("components/layout/Layout.tsx");
  assert.match(read("lib/nav.ts"), /\{ to: "\/inbox", label: "提醒", icon: "Bell" \}/);
  // 未读数：「提醒」二级和它所在的一级都显示（组收起、侧栏收成图标时也看得到）
  assert.match(layout, /aria-describedby=\{inbox && unread > 0 \? \(inFlyout \? "nav-inbox-unread-flyout" : "nav-inbox-unread"\)/);
  assert.match(layout, /const describedBy = inbox && unread > 0 \? "nav-section-unread" : undefined;/);
  assert.match(layout, /\{inbox && unreadPill\("nav-section-unread"\)\}/);
});

test("操作失败的原因不被随后的自动重读冲掉（第四轮审计 C7）", () => {
  const src = read("pages/Inbox.tsx");
  const load = src.slice(src.indexOf("const load = useCallback"), src.indexOf("useEffect(() => { void load(); }"));
  assert.match(load, /setLoadError\(""\)/);
  assert.doesNotMatch(load, /setActError/, "重读只管读取失败，不碰操作失败");
  assert.match(src, /const error = actError \|\| loadError;/);
});
