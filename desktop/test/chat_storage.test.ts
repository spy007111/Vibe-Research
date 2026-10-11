import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { saveChat } from "../src/core/ai/useAiChat.ts";

test("浏览器拒绝写入/删除时显式返回失败，不偷偷删除其他聊天腾空间", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let removals = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem() { throw new Error("quota"); },
    removeItem() { removals++; throw new Error("blocked"); },
  } });
  try {
    assert.equal(saveChat("test", [{ role: "user", content: "test" }, { role: "assistant", content: "answer" }]), false);
    assert.equal(removals, 0);
    assert.equal(saveChat("test", []), false);
    assert.equal(removals, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("两个标签页开着同一份对话交错保存：任何一边存过的轮次都不丢（审计 D1）", async () => {
  const { chatSyncOf, mergeChat, persistChat } = await import("../src/core/ai/useAiChat.ts");
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
  } });
  const u = (content: string) => ({ role: "user" as const, content });
  const a = (content: string, partial = false) => ({ role: "assistant" as const, content, ...(partial ? { partial } : {}) });
  try {
    const base = [u("q0"), a("r0")];
    persistChat("k", chatSyncOf("k", []), base);
    // 两个标签页都从 base 开始
    let A = { msgs: base, sync: chatSyncOf("k", base) };
    let B = { msgs: base, sync: chatSyncOf("k", base) };
    // A 答完一轮、存下
    let r = persistChat("k", A.sync, [...base, u("qA"), a("rA")]); A = { msgs: r.msgs, sync: r.sync };
    // B 还拿着旧列表：先发出提问（没答完），再答完
    r = persistChat("k", B.sync, [...B.msgs, u("qB"), a("", true)]); B = { msgs: r.msgs, sync: r.sync };
    assert.deepEqual(B.msgs.map((m) => m.content), ["q0", "r0", "qA", "rA", "qB", ""], "B 页面上也看到 A 那轮");
    r = persistChat("k", B.sync, B.msgs.map((m, i) => (i === B.msgs.length - 1 ? a("rB") : m))); B = { msgs: r.msgs, sync: r.sync };
    // A 再存一轮（它没看到 B 的）
    r = persistChat("k", A.sync, [...A.msgs, u("qA2"), a("rA2")]); A = { msgs: r.msgs, sync: r.sync };
    const disk = JSON.parse(store.get("vr-ai-chat:k")!).map((m: { content: string }) => m.content);
    assert.deepEqual(disk, ["q0", "r0", "qA", "rA", "qB", "rB", "qA2", "rA2"]);
    // 再存一次、存储没被别处改：照原样存，不重复并
    r = persistChat("k", A.sync, A.msgs);
    assert.deepEqual(JSON.parse(store.get("vr-ai-chat:k")!).map((m: { content: string }) => m.content), disk);
    // 本页清空：以本页为准
    r = persistChat("k", chatSyncOf("k", A.msgs), []);
    assert.equal(store.has("vr-ai-chat:k"), false);
    // 中间夹着没答完、留在界面上的半截回答：按 completeTurns 的规则对齐，不错位
    assert.deepEqual(mergeChat([u("x"), a("y")], [u("q0"), a("r0")], [u("q0"), a("r0"), u("q1"), a("half", true), u("q2"), a("r2")])!.map((m) => m.content),
      ["x", "y", "q1", "half", "q2", "r2"]);
    assert.equal(mergeChat([u("x")], [u("q0"), a("r0")], [u("other")]), null, "本页不是在 base 上往后加");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("🔴 写入失败不挪对齐点：A 存失败 → B 存成功 → A 恢复后再存，A 没存上的那轮不丢（审计第二轮，D1 修复引入）", async () => {
  const { chatSyncOf, persistChat } = await import("../src/core/ai/useAiChat.ts");
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  let full = false;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { if (full) throw new Error("quota"); store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  } });
  const u = (content: string) => ({ role: "user" as const, content });
  const a = (content: string) => ({ role: "assistant" as const, content });
  try {
    const S = [u("q0"), a("r0")];
    persistChat("k", chatSyncOf("k", []), S);
    let A = { msgs: S, sync: chatSyncOf("k", S) };
    const B = { msgs: S, sync: chatSyncOf("k", S) };
    full = true;
    let r = persistChat("k", A.sync, [...S, u("qA1"), a("rA1")]);
    assert.equal(r.saved, false);
    A = { msgs: r.msgs, sync: r.sync };
    full = false;
    persistChat("k", B.sync, [...S, u("qB1"), a("rB1")]);
    r = persistChat("k", A.sync, [...A.msgs, u("qA2"), a("rA2")]);
    assert.equal(r.saved, true);
    assert.deepEqual(r.msgs.map((m) => m.content), ["q0", "r0", "qB1", "rB1", "qA1", "rA1", "qA2", "rA2"]);
    assert.deepEqual(JSON.parse(store.get("vr-ai-chat:k")!).map((m: { content: string }) => m.content), r.msgs.map((m) => m.content));
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

/** 按总字数限额的假存储：超过 limit 就像浏览器那样抛「配额满」 */
function quotaStore(initial: number) {
  let limit = initial;
  const store = new Map<string, string>();
  const size = () => [...store].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const old = store.get(k);
      if (size() - (old === undefined ? 0 : k.length + old.length) + k.length + v.length > limit) throw new Error("quota");
      store.set(k, v);
    },
    removeItem: (k: string) => { store.delete(k); },
  } });
  return { store, setLimit: (n: number) => { limit = n; }, restore: () => { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); } };
}

test("🔴 合并后仍没存上：不把合并结果交回界面，连续失败不会把别的标签页那轮越并越多（审计第三轮 D4）", async () => {
  const { chatSyncOf, persistChat } = await import("../src/core/ai/useAiChat.ts");
  const { store, setLimit, restore } = quotaStore(400);
  const u = (content: string) => ({ role: "user" as const, content });
  const a = (content: string) => ({ role: "assistant" as const, content });
  try {
    const T0 = [u("q0"), a("r0")];
    persistChat("k", chatSyncOf("k", []), T0);
    const A = { msgs: T0, sync: chatSyncOf("k", T0) };
    persistChat("k", chatSyncOf("k", T0), [...T0, u("qB"), a("rB")]);   // B 存了一轮短的
    const long = "长".repeat(300);
    const mine = [...T0, u("qA"), a(long)];
    let r = persistChat("k", A.sync, mine);                               // A 的长回答连同合并结果都存不下
    assert.equal(r.saved, false);
    assert.equal(r.msgs, mine, "没存上就原样交回本页的消息（同一个数组，界面不刷新）");
    assert.equal(r.sync, A.sync, "对齐点不动");
    const again = [...mine, u("qA2"), a("rA2")];
    r = persistChat("k", r.sync, again);                                   // 再失败一次
    assert.equal(r.saved, false);
    assert.deepEqual(r.msgs.map((m) => m.content), ["q0", "r0", "qA", long, "qA2", "rA2"], "没有并进第二份 B");
    setLimit(100_000);                                                     // 腾出空间后：合并一次，B 那轮只出现一次
    r = persistChat("k", A.sync, again);
    assert.equal(r.saved, true);
    assert.deepEqual(r.msgs.map((m) => m.content), ["q0", "r0", "qB", "rB", "qA", long, "qA2", "rA2"]);
  } finally { restore(); }
});

test("🔴 清空对话：新的线程编号存下了才算清空；存储满了先删这份对话腾地方，还写不进就原样放回（审计第三轮 D5）", async () => {
  const { clearChatStorage, sessionId } = await import("../src/core/ai/useAiChat.ts");
  // 配额刚好被这份对话占满：编号第一次写不进，删掉对话后能写进
  let s = quotaStore(60);
  try {
    s.store.set("vr-ai-epoch:k", "1");
    s.store.set("vr-ai-chat:k", "x".repeat(60 - "vr-ai-epoch:k1".length - "vr-ai-chat:k".length));
    assert.equal(clearChatStorage("k", 10), true);
    assert.equal(s.store.get("vr-ai-epoch:k"), "10", "刷新后读回的是新编号");
    assert.equal(s.store.has("vr-ai-chat:k"), false);
    assert.notEqual(sessionId("k", Number(s.store.get("vr-ai-epoch:k"))), sessionId("k", 1), "后端换了一条线程");
  } finally { s.restore(); }
  // 编号怎么都写不进（别的数据占满）：不算清空，对话原样还在
  s = quotaStore(40);
  try {
    s.store.set("vr-ai-epoch:k", "1");
    s.store.set("other", "y".repeat(40 - "vr-ai-epoch:k1".length - "other".length));
    assert.equal(clearChatStorage("k", 10), false);
    assert.equal(s.store.get("vr-ai-epoch:k"), "1");
  } finally { s.restore(); }
  s = quotaStore(1000);
  try {
    s.store.set("vr-ai-chat:k", "[]");
    const orig = globalThis.localStorage.setItem;
    let calls = 0;
    globalThis.localStorage.setItem = (k: string, v: string) => { calls++; if (k.startsWith("vr-ai-epoch:")) throw new Error("quota"); orig(k, v); };
    assert.equal(clearChatStorage("k", 5), false);
    assert.equal(s.store.get("vr-ai-chat:k"), "[]", "写不进编号就把对话放回去");
    assert.ok(calls >= 3);
  } finally { s.restore(); }
  const hook = readFileSync(new URL("../src/core/ai/useAiChat.ts", import.meta.url), "utf8");
  const clear = hook.slice(hook.indexOf("const clear = useCallback"), hook.indexOf("const session = useMemo"));
  const guard = clear.indexOf("if (!clearChatStorage(keyRef.current, next))");
  assert.ok(guard > 0 && guard < clear.indexOf("abort();"), "先确认存下了再中止、清界面");
  assert.ok(!clear.includes("writeText(EPOCH_KEY"), "不再忽略写入结果");
});

test("两个标签页先后清空同一份对话：第二次清空接着存储里的编号往上加，不和第一次撞线程（第四轮审计 D3）", async () => {
  const { clearChatStorage, nextEpoch, sessionId } = await import("../src/core/ai/useAiChat.ts");
  const s = quotaStore(10_000);
  try {
    const a = nextEpoch("k", 0);                       // 标签页 A：本页 0 → 1
    assert.equal(clearChatStorage("k", a), true);
    const b = nextEpoch("k", 0);                       // 标签页 B 不刷新，本页还是 0
    assert.equal(b, 2, "要接着存储里的 1 往上加");
    assert.notEqual(sessionId("k", b), sessionId("k", a));
    assert.equal(nextEpoch("k", 7), 8, "本页记着的更大时用本页的");
  } finally { s.restore(); }
  const hook = readFileSync(new URL("../src/core/ai/useAiChat.ts", import.meta.url), "utf8");
  assert.match(hook, /const next = nextEpoch\(keyRef\.current, epochRef\.current\);/);
});
