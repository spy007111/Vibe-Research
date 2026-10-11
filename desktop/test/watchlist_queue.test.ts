import assert from "node:assert/strict";
import test from "node:test";

import { backend } from "../src/verticals/finance/lib/backend.ts";
import { addWatch, hydrateWatch, loadWatch, saveWatch } from "../src/verticals/finance/lib/watchlist.ts";

/** 内存台账；每次写都慢一拍，好让第二次添加在第一次写完之前发出 */
function fakeLedger() {
  const rows: { id: string; symbol: string }[] = [];
  let n = 0;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const original = { ledger: backend.ledger, save: backend.ledgerSave, del: backend.ledgerDelete };
  backend.ledger = async () => { await tick(); return { records: { watch: rows.map((r) => ({ ...r })) } } as never; };
  backend.ledgerSave = async (_k, rec) => { await tick(); const r = { id: `w${++n}`, symbol: String(rec.symbol) }; rows.push(r); return r as never; };
  backend.ledgerDelete = async (_k, id) => { await tick(); rows.splice(rows.findIndex((r) => r.id === id), 1); return undefined as never; };
  return { rows, restore: () => Object.assign(backend, { ledger: original.ledger, ledgerSave: original.save, ledgerDelete: original.del }) };
}

test("研究页连着加两只自选：两只都留在台账里（审计 C3）", async () => {
  const f = fakeLedger();
  try {
    await hydrateWatch();
    assert.deepEqual(loadWatch(), []);
    const a = addWatch("600519");
    assert.deepEqual(loadWatch(), ["600519"], "排队中的这只别的页面马上读得到");
    const b = addWatch("AAPL");
    assert.deepEqual(loadWatch(), ["600519", "AAPL"]);
    await Promise.all([a, b]);
    assert.deepEqual(f.rows.map((r) => r.symbol).sort(), ["600519", "AAPL"].sort());
    assert.deepEqual(loadWatch().sort(), ["600519", "AAPL"].sort());
    await addWatch("600519");
    assert.equal(f.rows.length, 2, "已经有了就不重复写");
    // 第一只写完、重读回来时第二只还在排队：缓存里不能把它丢掉
    const c = addWatch("00700");
    const d = addWatch("300750");
    await c;
    assert.ok(loadWatch().includes("300750"), "前一次重读不能把还在排队的那只从缓存里抹掉");
    await d;
    // 整表保存（自选页）排在增量添加之后，仍以台账真实状态算差集
    await saveWatch(["600519"]);
    assert.deepEqual(f.rows.map((r) => r.symbol), ["600519"]);
    await assert.rejects(addWatch("???"), /代码不对/);
  } finally { f.restore(); }
});

test("🔴 加自选时读台账失败、补读也失败：这只从缓存撤掉，恢复后能重试，台账里只有一条（审计第二轮，C3 修复引入）", async () => {
  const f = fakeLedger();
  const ok = backend.ledger;
  try {
    await hydrateWatch();
    assert.deepEqual(loadWatch(), []);
    backend.ledger = async () => { throw new Error("连不上"); };
    await assert.rejects(addWatch("600519"), /连不上/);
    assert.deepEqual(loadWatch(), [], "没写进去，不能显示成「已在自选」");
    backend.ledger = ok;
    await addWatch("600519");
    assert.deepEqual(f.rows.map((r) => r.symbol), ["600519"]);
    assert.deepEqual(loadWatch(), ["600519"]);
    // 写进去了、重读失败：保留（真存上了）
    const save = backend.ledgerSave;
    backend.ledgerSave = async (k, rec) => { const r = await save(k, rec); backend.ledger = async () => { throw new Error("连不上"); }; return r; };
    await addWatch("AAPL");
    assert.deepEqual(loadWatch().sort(), ["600519", "AAPL"].sort());
    backend.ledgerSave = save;
  } finally { backend.ledger = ok; f.restore(); }
});
