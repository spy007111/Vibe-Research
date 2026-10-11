// 行情轮询循环上锁(审计 3.10):请求在路上时切走再切回来,不能多出第二条循环。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { startPollLoop, type PollTimers } from "../src/verticals/finance/lib/pollLoop.ts";

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: PollTimers = {
    set: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clear: (id) => { pending.delete(id); },
  };
  const fireAll = () => { const due = [...pending.values()]; pending.clear(); for (const d of due) d.fn(); };
  return { timers, pending, fireAll };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(shouldRun = () => true) {
  const ft = fakeTimers();
  const calls: ReturnType<typeof deferred<number>>[] = [];
  const states: boolean[] = [];
  const poll = startPollLoop({
    shouldRun,
    tick: () => { const d = deferred<number>(); calls.push(d); return d.promise; },
    idleMs: 10_000,
    onState: (p) => states.push(p),
    timers: ft.timers,
  });
  return { ...ft, calls, states, poll };
}

test("🔴 一拍还在取时切回页面(连切三次):不多发请求,回来后只排一个定时器", async () => {
  const h = harness();
  assert.equal(h.calls.length, 1, "一开始取一次");
  h.poll.kick(); h.poll.kick(); h.poll.kick();
  await flush();
  assert.equal(h.calls.length, 1, "在路上的那拍没回来,不再发");
  assert.equal(h.pending.size, 0, "也不另排定时器");
  h.calls[0].resolve(3000);
  await flush();
  assert.equal(h.pending.size, 1, "只有一个定时器");
  assert.equal([...h.pending.values()][0].ms, 3000, "按这一拍说的间隔等");
  h.fireAll();
  await flush();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(3000);
  await flush();
  assert.equal(h.pending.size, 1, "跑了两拍仍然只有一条循环");
  h.poll.stop();
});

test("空闲等下一拍时切回页面:掐掉等着的定时器马上取,之后仍只有一个定时器", async () => {
  const h = harness();
  h.calls[0].resolve(3000);
  await flush();
  assert.equal(h.pending.size, 1);
  h.poll.kick();
  await flush();
  assert.equal(h.calls.length, 2, "马上取");
  assert.equal(h.pending.size, 0, "原来那个定时器掐掉了");
  h.calls[1].resolve(3000);
  await flush();
  assert.equal(h.pending.size, 1);
  h.poll.stop();
});

test("不该取(页面切走 / 休市)只排心跳不取数;停掉之后在路上的那拍回来也不再排", async () => {
  let run = false;
  const h = harness(() => run);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.states, [false]);
  assert.equal([...h.pending.values()][0].ms, 10_000);
  run = true;
  h.fireAll();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.states, [false, true]);
  h.poll.stop();
  h.calls[0].resolve(3000);
  await flush();
  assert.equal(h.pending.size, 0, "卸载后旧循环不复活");
  h.poll.kick();
  assert.equal(h.calls.length, 1, "停掉后再催也不取");
});

test("自选行情的轮询用这条上了锁的循环,可见性回调不再自己起 loop", () => {
  const hook = readFileSync(new URL("../src/verticals/finance/hooks/useLiveQuotes.ts", import.meta.url), "utf8");
  assert.match(hook, /const poll = startPollLoop\(\{/);
  assert.match(hook, /const onVisible = \(\) => \{\s*if \(!document\.hidden\) poll\.kick\(\);\s*\};/);
  assert.match(hook, /return \(\) => \{\s*poll\.stop\(\);/);
  assert.doesNotMatch(hook, /void loop\(\)/);
});
