import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";

const src = (rel: string) => fs.readFileSync(new URL(`../src/verticals/finance/${rel}`, import.meta.url), "utf8");

test("SEC 联系方式:读状态走 GET,保存 / 清除走 POST {contact}", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ source: "none", masked: null, valid: false }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await backend.secContact();
    await backend.setSecContact("Zhang San zhangsan@example.com");
    await backend.setSecContact(null);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls[0].url, "/api/settings/sec-contact");
  assert.equal(calls[0].init?.method, undefined);
  assert.equal(calls[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { contact: "Zhang San zhangsan@example.com" });
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { contact: null });
});

test("SEC 联系方式卡片:在「接入 AI」页、不藏进高级信息;说清用途和去向;只显示打码后的样子", () => {
  const settings = src("pages/Settings.tsx");
  assert.match(settings, /<SecContactCard \/>/);
  assert.ok(settings.indexOf("<SecContactCard />") > settings.indexOf("</details>"), "不藏进「高级运行信息」");
  const card = src("components/SecContactCard.tsx");
  for (const t of ["美股官方数据（选填）", "英文姓名和邮箱", "只存在这台电脑上，只发给 SEC", "不填照旧用东财", "已由环境变量 VRA_SEC_CONTACT 指定",
    "{err && <p role=\"alert\"", "void save(null)", "Zhang San zhangsan@example.com"]) assert.ok(card.includes(t), t);
  assert.ok(!/st\.contact|\.contact\b/.test(card), "页面拿不到也不显示原文,只用 masked");
  assert.match(card, /\{st\.masked\}/);
  assert.match(card, /st\.source !== "env"/, "环境变量指定的不给输入框");
  assert.match(card, /autoComplete="off"/);
});
