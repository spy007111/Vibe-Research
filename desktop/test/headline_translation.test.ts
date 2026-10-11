import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TITLE_TRANSLATION_CACHE_KEY,
  displayedHeadlineTranslation,
  hasChinese,
  headlineNeedsTranslation,
  loadHeadlineTranslationCache,
  parseHeadlineTranslations,
  saveHeadlineTranslationCache,
  splitHeadlineBatches,
  type StorageLike,
} from "../src/verticals/finance/lib/headlineTranslation.ts";

test("中文标题判定:中英混排也不重复翻译", () => {
  assert.equal(hasChinese("OpenAI 发布新模型"), true);
  assert.equal(hasChinese("OpenAI releases a new model"), false);
});

test("分批同时守条数与字符上限", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: String(i), title: "x".repeat(40) }));
  const byCount = splitHeadlineBatches(items, 2, 10_000);
  assert.deepEqual(byCount.map((x) => x.length), [2, 2, 1]);
  const byChars = splitHeadlineBatches(items, 10, 130);
  assert.ok(byChars.length > 1);
  assert.deepEqual(byChars.flat(), items);
});

test("翻译回包只收预期 id / 中文短标题，不按顺序猜", () => {
  const expected = [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }];
  const got = parseHeadlineTranslations(
    '```json\n{"items":[{"id":"b","zh":"Beta 的中文标题"},{"id":"a","zh":"still English"},{"id":"x","zh":"不应收下"},{"id":"b","zh":"重复覆盖"}]}\n```',
    expected,
  );
  assert.deepEqual([...got.entries()], [["b", "Beta 的中文标题"]]);
  assert.throws(() => parseHeadlineTranslations("not json", expected), /没有返回/);
});

test("翻译缓存损坏时回空，正常时可往返", () => {
  let raw = "broken";
  const storage: StorageLike = {
    getItem: (key) => key === TITLE_TRANSLATION_CACHE_KEY ? raw : null,
    setItem: (_key, value) => { raw = value; },
  };
  assert.equal(loadHeadlineTranslationCache(storage).size, 0);
  const cache = new Map([["OpenAI launches X", "OpenAI 发布 X"]]);
  assert.equal(saveHeadlineTranslationCache(cache, storage), true);
  assert.deepEqual([...loadHeadlineTranslationCache(storage)], [...cache]);
});

test("上游已有 zh 时自动跳过，手动重译时缓存的新译文覆盖旧 zh", () => {
  const item = { title: "OpenAI launches X", zh: "上游旧译文" };
  const cache = new Map<string, string>();
  assert.equal(headlineNeedsTranslation(item, cache), false);
  assert.equal(headlineNeedsTranslation(item, cache, true), true);
  assert.equal(displayedHeadlineTranslation(item, cache), "上游旧译文");
  cache.set(item.title, "手动重译的新译文");
  assert.equal(displayedHeadlineTranslation(item, cache), "手动重译的新译文");
});

test("浏览器禁用存储：读 window.localStorage 属性本身就抛错时当没有缓存，资讯页照常渲染（审计 C10）", async () => {
  const { storageObject } = await import("../src/verticals/finance/lib/storage.ts");
  const old = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage(): Storage { throw new Error("SecurityError"); } } });
  try {
    assert.equal(storageObject(), undefined);
    assert.equal(loadHeadlineTranslationCache(storageObject()).size, 0);
  } finally {
    if (old) Object.defineProperty(globalThis, "window", old); else Reflect.deleteProperty(globalThis, "window");
  }
  const page = readFileSync(new URL("../src/verticals/finance/pages/Intel.tsx", import.meta.url), "utf8");
  assert.ok(!page.includes("window.localStorage"), "资讯页不直接碰 window.localStorage");
  assert.equal((page.match(/storageObject\(\)/g) ?? []).length, 2, "读、写缓存都走兜底");
});
