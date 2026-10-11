import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register_tasks.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { ServiceError, ledgerList, ledgerUpsert, type ServiceContext } from "../src/service.ts";
import { eventCalendar } from "../src/finance/events.ts";
import { heldFromLedger, replayTrades, tradeOf, type CostMethod, type Trade } from "../src/finance/holdings.ts";
import { convertOne, holdingsAct, holdingsPerf, holdingsView, legacyAct } from "../src/finance/holdings_view.ts";
import { createApiServer } from "../src/api.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let n = 0;
const rec = (fields: Record<string, unknown>): LedgerRecord => {
  n += 1;
  const at = new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
  return { id: `trade-${String(n).padStart(4, "0")}`, kind: "trade", created_at: at, updated_at: at, ...fields };
};
const tr = (fields: Record<string, unknown>): Trade => tradeOf(rec({ symbol: "600519", ...fields }));
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, `${msg ?? ""} ${a} ≠ ${b}`);

/**
 * 手算场景(两种成本法同一组流水):
 *   1/2 买 100 @10 费 5 → 批次 1:100 股,每股 10.05(总 1005)
 *   2/3 买 200 @13 费 6 → 批次 2:200 股,每股 13.03(总 2606)
 *   3/4 卖 150 @15 费 7.5 → 所得 2250 − 7.5 = 2242.5
 *       先进先出成本 = 100×10.05 + 50×13.03 = 1656.5 → 盈亏 586
 *       加权平均成本 = 150 × 3611/300 = 1805.5 → 盈亏 437
 *   4/1 现金分红 30(收入,不改成本)
 *   5/6 10 转 5(比例 1.5)→ 持有 150 → 225
 *       先进先出剩批次 2 的 150 股 → 225 股,每股 13.03/1.5,总成本 1954.5 不变
 *       加权平均剩余总成本 3611 − 1805.5 = 1805.5 不变
 */
function scenario(): Trade[] {
  return [
    tr({ type: "buy", date: "2025-01-02", shares: 100, price: 10, fee: 5, name: "贵州茅台" }),
    tr({ type: "buy", date: "2025-02-03", shares: 200, price: 13, fee: 6 }),
    tr({ type: "sell", date: "2025-03-04", shares: 150, price: 15, fee: 7.5 }),
    tr({ type: "dividend", date: "2025-04-01", amount: 30 }),
    tr({ type: "split", date: "2025-05-06", ratio: 1.5 }),
  ];
}

test("重放:先进先出与加权平均按手算结果;分红单列、不改成本;送转按比例换算", () => {
  const expect: Record<CostMethod, { realized: number; cost: number; cost_basis: number }> = {
    fifo: { realized: 586, cost: 1954.5, cost_basis: 1656.5 },
    average: { realized: 437, cost: 1805.5, cost_basis: 1805.5 },
  };
  for (const method of ["fifo", "average"] as const) {
    const r = replayTrades(scenario(), method);
    assert.equal(r.method, method);
    assert.deepEqual(r.issues, [], method);
    assert.equal(r.holdings.length, 1);
    const h = r.holdings[0]!;
    assert.equal(h.symbol, "600519");
    assert.equal(h.name, "贵州茅台");
    close(h.shares, 225, method);
    close(h.cost_total, expect[method].cost, `${method} 成本`);
    close(h.unit_cost, expect[method].cost / 225, `${method} 每股成本`);
    close(h.realized_pnl, expect[method].realized, `${method} 已实现`);
    close(h.dividends, 30);
    close(h.fees, 18.5);
    assert.equal(h.opened_at, "2025-01-02");
    assert.equal(h.trade_count, 5);
    assert.equal(r.realized.length, 1);
    close(r.realized[0]!.proceeds, 2242.5);
    close(r.realized[0]!.cost, expect[method].cost_basis);
    assert.deepEqual(r.dividends.map((d) => [d.date, d.amount]), [["2025-04-01", 30]]);
    assert.deepEqual(r.closed, []);
  }
  const fifo = replayTrades(scenario(), "fifo").holdings[0]!;
  assert.equal(fifo.lots.length, 1);
  close(fifo.lots[0]!.shares, 225);
  close(fifo.lots[0]!.unit_cost, 13.03 / 1.5);
  assert.equal(fifo.lots[0]!.date, "2025-02-03");
  assert.deepEqual(replayTrades(scenario(), "average").holdings[0]!.lots, []);
});

test("重放:输入顺序不影响结果;同一天先送转再成交(哪怕送转录得更晚)", () => {
  const base = replayTrades(scenario(), "fifo");
  const shuffled = replayTrades([...scenario()].reverse(), "fifo");
  // id / 录入时间不同,只比数
  const nums = (r: typeof base) => r.holdings.map((h) => [h.symbol, h.shares, h.cost_total, h.realized_pnl, h.dividends]);
  assert.deepEqual(nums(shuffled), nums(base));

  const sellFirst = tr({ type: "buy", date: "2025-01-02", shares: 100, price: 10 });
  const sameDaySell = tr({ type: "sell", date: "2025-05-06", shares: 150, price: 8 });
  const lateSplit = tr({ type: "split", date: "2025-05-06", ratio: 1.5 });
  const r = replayTrades([sellFirst, sameDaySell, lateSplit], "average");
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.holdings, []);
  close(r.realized[0]!.cost, 1000);
  assert.deepEqual(r.closed.map((c) => [c.symbol, c.last_date]), [["600519", "2025-05-06"]]);
  close(r.closed[0]!.realized_pnl, 200);
});

test("重放:数据不对的流水逐条说原因、不参与计算", () => {
  const ok = tr({ type: "buy", date: "2025-01-02", shares: 100, price: 10 });
  const bad = [
    tr({ type: "sell", date: "2025-01-03", shares: 150, price: 11 }),
    tr({ type: "buy", date: "2025-01-04", shares: 10 }),
    tr({ type: "buy", date: "2025-01-04", shares: 10, price: 0 }),
    tr({ type: "buy", date: "2025-01-04", shares: 0, price: 9 }),
    tr({ type: "buy", date: "2025-01-04", shares: 10, price: 9, fee: -1 }),
    tr({ type: "buy", date: "2026-02-31", shares: 10, price: 9 }),
    tr({ type: "transfer", date: "2025-01-04", shares: 10 }),
    tr({ type: "dividend", date: "2025-01-04" }),
    tr({ type: "split", date: "2025-01-04", ratio: 0 }),
    tr({ type: "opening", date: "2025-01-04", shares: 10 }),
    tr({ symbol: "", type: "buy", date: "2025-01-04", shares: 10, price: 9 }),
  ];
  // 空仓时记的送转照收、不改股数(港美股算收益率要靠它还原拆股前的价格),不算数据不对
  const flatSplit = tr({ symbol: "000001", type: "split", date: "2025-01-04", ratio: 2 });
  const r = replayTrades([ok, ...bad, flatSplit], "fifo");
  assert.deepEqual(r.issues.map((i) => i.id).sort(), bad.map((t) => t.id).sort());
  const why = Object.fromEntries(r.issues.map((i) => [i.id, i.why]));
  assert.match(why[bad[0]!.id]!, /卖出 150 股,超过当时持有的 100 股/);
  assert.match(why[bad[1]!.id]!, /成交价/);
  assert.match(why[bad[2]!.id]!, /成交价/);
  assert.match(why[bad[3]!.id]!, /数量/);
  assert.match(why[bad[4]!.id]!, /费用不能是负数/);
  assert.match(why[bad[5]!.id]!, /不是有效日期/);
  assert.match(why[bad[6]!.id]!, /不认识/);
  assert.match(why[bad[7]!.id]!, /到账金额/);
  assert.match(why[bad[8]!.id]!, /比例/);
  assert.match(why[bad[9]!.id]!, /每股成本/);
  assert.match(why[bad[10]!.id]!, /没有代码/);
  // 跳过的不影响有效的那笔
  assert.deepEqual(r.holdings.map((h) => [h.symbol, h.shares, h.cost_total, h.trade_count]), [["600519", 100, 1000, 1]]);
});

test("重放:期初持仓成本可以是负数;卖光后再买从新的一天算;小数股不误报卖超", () => {
  const r = replayTrades([tr({ type: "opening", date: "2024-06-01", shares: 100, price: -2 })], "average");
  close(r.holdings[0]!.cost_total, -200);
  close(r.holdings[0]!.unit_cost, -2);

  const again = replayTrades([
    tr({ type: "buy", date: "2025-01-02", shares: 100, price: 10 }),
    tr({ type: "sell", date: "2025-02-01", shares: 100, price: 12 }),
    tr({ type: "buy", date: "2025-03-01", shares: 50, price: 11 }),
  ], "fifo");
  assert.equal(again.holdings[0]!.opened_at, "2025-03-01");
  close(again.holdings[0]!.cost_total, 550);
  close(again.holdings[0]!.realized_pnl, 200);

  const frac = replayTrades([
    tr({ symbol: "AAPL", type: "buy", date: "2025-01-02", shares: 0.3, price: 100 }),
    tr({ symbol: "AAPL", type: "sell", date: "2025-01-03", shares: 0.1, price: 110 }),
    tr({ symbol: "AAPL", type: "sell", date: "2025-01-04", shares: 0.2, price: 120 }),
  ], "fifo");
  assert.deepEqual(frac.issues, []);
  assert.deepEqual(frac.holdings, []);
  close(frac.closed[0]!.realized_pnl, 0.1 * 10 + 0.2 * 20);

  // 卖光后的分红(登记日在卖出之前)照样记收入,进清仓清单
  const div = replayTrades([
    tr({ symbol: "000001", type: "buy", date: "2025-01-02", shares: 100, price: 10 }),
    tr({ symbol: "000001", type: "sell", date: "2025-06-01", shares: 100, price: 10 }),
    tr({ symbol: "000001", type: "dividend", date: "2025-06-20", amount: 25 }),
  ], "average");
  assert.deepEqual(div.closed.map((c) => [c.symbol, c.realized_pnl, c.dividends]), [["000001", 0, 25]]);
});

test("现在持有:流水重放后数量 > 0 的,加上还没迁成流水的旧持有记录", () => {
  const pos = (id: string, fields: Record<string, unknown>): LedgerRecord => ({ id, kind: "position", created_at: "", updated_at: "", ...fields });
  const held = heldFromLedger({
    trade: [
      rec({ symbol: "600519", type: "buy", date: "2025-01-02", shares: 100, price: 10, name: "贵州茅台" }),
      rec({ symbol: "000858", type: "buy", date: "2025-01-02", shares: 100, price: 10, name: "五粮液" }),
      rec({ symbol: "000858", type: "sell", date: "2025-02-02", shares: 100, price: 11 }),
      rec({ symbol: "000002", type: "opening", date: "2025-01-02", shares: 10, price: 5, migrated_from: "position-old" }),
      rec({ symbol: "000002", type: "sell", date: "2025-03-02", shares: 10, price: 5 }),
    ],
    position: [
      pos("position-old", { symbol: "000002", shares: 10, cost: 5 }),
      pos("position-new", { symbol: "601318", name: "中国平安", shares: 10, cost: 50 }),
      pos("position-zero", { symbol: "000333", shares: 0, cost: 50 }),
      pos("position-dup", { symbol: "600519", name: "茅台(旧)", shares: 5, cost: 50 }),
    ],
  });
  assert.deepEqual(held, [{ symbol: "600519", name: "贵州茅台" }, { symbol: "601318", name: "中国平安" }]);
  // 字段不合台账规则的流水不算持有(与持仓页同口径)
  const odd = rec({ symbol: "300750", type: "buy", date: "2025-01-02", shares: 100, price: 10 });
  assert.deepEqual(heldFromLedger({ trade: [odd] }).map((h) => h.symbol), ["300750"]);
  assert.deepEqual(heldFromLedger({ trade: [odd] }, { trade: [{ id: odd.id, why: "手改坏了" }] }), []);
});

test("台账:交易流水种类已注册;日期 / 类型必填,数量、比例、金额要大于 0,费用不能为负,期初成本可以为负", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-trade-"));
  const ctx: ServiceContext = { repoRoot: REPO, dataRoot, python: "false", node: process.execPath };
  try {
    const good = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "opening", date: "2025-01-02", shares: 100, price: -3 } });
    assert.equal(good.kind, "trade");
    for (const record of [
      { symbol: "600519", type: "buy", shares: 1, price: 1 },
      { symbol: "600519", date: "2025-01-02", shares: 1, price: 1 },
      { symbol: "600519", type: "swap", date: "2025-01-02" },
      { symbol: "600519", type: "buy", date: "2025-02-31", shares: 1, price: 1 },
      { symbol: "600519", type: "buy", date: "2025-01-02", shares: 0, price: 1 },
      { symbol: "600519", type: "buy", date: "2025-01-02", shares: 1, price: 1, fee: -1 },
      { symbol: "600519", type: "split", date: "2025-01-02", ratio: 0 },
      { symbol: "600519", type: "dividend", date: "2025-01-02", amount: -1 },
      { symbol: "hk00700", type: "buy", date: "2025-01-02", shares: 1, price: 1 },
    ]) {
      assert.throws(() => ledgerUpsert(ctx, { kind: "trade", record }), (e: unknown) => e instanceof ServiceError, JSON.stringify(record));
    }
    assert.equal(ledgerList(ctx, "trade").trade!.length, 1);
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("事件日历:持有按流水重放算,卖光的只算自选;没迁的旧持有记录照样算持有", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-trade-cal-"));
  const ctx: ServiceContext = { repoRoot: REPO, dataRoot, python: "false", node: process.execPath };
  try {
    ledgerUpsert(ctx, { kind: "trade", record: { symbol: "300308", name: "中际旭创", type: "buy", date: "2025-01-02", shares: 100, price: 10 } });
    ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000858", name: "五粮液", type: "buy", date: "2025-01-02", shares: 100, price: 10 } });
    ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000858", type: "sell", date: "2025-02-02", shares: 100, price: 11 } });
    ledgerUpsert(ctx, { kind: "watch", record: { symbol: "000858", name: "五粮液" } });
    ledgerUpsert(ctx, { kind: "position", record: { symbol: "601318", name: "中国平安", shares: 10, cost: 50 } });
    const r = await eventCalendar(ctx, { days: "30" }, new AbortController().signal, new Date("2026-10-08T09:00:00Z"));
    assert.deepEqual(r.symbols.map((s) => [s.symbol, s.name, s.origin]), [["300308", "中际旭创", ["持有"]], ["601318", "中国平安", ["持有"]], ["000858", "五粮液", ["自选"]]]);
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

function withRoot(fn: (ctx: ServiceContext) => Promise<void>) {
  return async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-hold-"));
    try { await fn({ repoRoot: REPO, dataRoot, python: "false", node: process.execPath }); } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  };
}
const NOW = new Date("2026-10-09T06:00:00Z"); // 新加坡 14:00
const sig = new AbortController().signal;
const ledgerFile = (ctx: ServiceContext, f: string) => path.join(ctx.dataRoot, "ledger", f);
const backups = (ctx: ServiceContext) => fs.readdirSync(path.join(ctx.dataRoot, "ledger")).filter((f) => f.startsWith("持仓迁移备份")).sort();

test("迁移:旧持有记录转成期初持仓流水;先备份原样文件;数量为 0、同代码已有流水的不动;再跑一次什么都不写", withRoot(async (ctx) => {
  const a = ledgerUpsert(ctx, { kind: "position", record: { symbol: "600519", name: "贵州茅台", account: "华泰", shares: 100, cost: 1500.5, opened_at: "2024-05-01", note: "长线" } });
  const b = ledgerUpsert(ctx, { kind: "position", record: { symbol: "00700.HK", name: "腾讯控股", shares: 200, cost: -3 } });
  const c = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000333", shares: 0, cost: 50 } });
  const d = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000858", name: "五粮液", shares: 300, cost: 120 } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000858", type: "buy", date: "2025-03-03", shares: 100, price: 130 } });
  const posBefore = fs.readFileSync(ledgerFile(ctx, "position.json"));
  const tradeBefore = fs.readFileSync(ledgerFile(ctx, "trade.json"));

  const before = await holdingsView(ctx, {}, sig, NOW);
  assert.equal(before.migration_pending, 2);
  assert.deepEqual(before.legacy.map((l) => [l.symbol, l.state]), [["600519", "pending"], ["00700.HK", "pending"], ["000333", "skipped"], ["000858", "conflict"]]);

  const { result, view } = await legacyAct(ctx, { action: "migrate" }, sig, NOW);
  assert.equal(result.backup, "ledger/持仓迁移备份-2026-10-09");
  const dir = path.join(ctx.dataRoot, result.backup!);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["README.md", "position.json", "trade.json"]);
  assert.ok(fs.readFileSync(path.join(dir, "position.json")).equals(posBefore), "备份是迁移前的原样字节");
  assert.ok(fs.readFileSync(path.join(dir, "trade.json")).equals(tradeBefore));
  assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /恢复:先退出 Vibe Research/);
  assert.deepEqual(result.migrated.map((m) => [m.symbol, m.position_id]), [["600519", a.id], ["00700.HK", b.id]]);
  assert.deepEqual(result.failed, []);

  const trades = ledgerList(ctx, "trade").trade!;
  const ta = trades.find((t) => t.migrated_from === a.id)!;
  assert.deepEqual([ta.symbol, ta.name, ta.account, ta.type, ta.date, ta.shares, ta.price, ta.note], ["600519", "贵州茅台", "华泰", "opening", "2024-05-01", 100, 1500.5, "长线\n从旧持有记录迁移"]);
  const tb = trades.find((t) => t.migrated_from === b.id)!;
  assert.deepEqual([tb.date, tb.price, tb.note], ["2026-10-09", -3, "从旧持有记录迁移;旧记录没写建立日期,按迁移当天记"]);
  assert.deepEqual(ledgerList(ctx, "position").position!.map((p) => p.id).sort(), [c.id, d.id].sort());

  // 迁移后持仓数与成本和迁移前一致(平均法)
  const hold = Object.fromEntries(view.holdings.map((h) => [h.symbol, [h.shares, h.unit_cost]]));
  assert.deepEqual(hold["600519"], [100, 1500.5]);
  assert.deepEqual(hold["00700.HK"], [200, -3]);
  assert.deepEqual(hold["000858"], [100, 130], "冲突的旧记录不进流水");
  assert.equal(view.method, "average");
  assert.equal(view.migration_pending, 0);
  assert.deepEqual(view.legacy.map((l) => [l.symbol, l.state]), [["000333", "skipped"], ["000858", "conflict"]]);

  const again = await legacyAct(ctx, { action: "migrate" }, sig, NOW);
  assert.deepEqual(again.result, { backup: null, migrated: [], removed_stale: [], failed: [] });
  assert.equal(backups(ctx).length, 1, "没有要做的就不备份");
  assert.equal(ledgerList(ctx, "trade").trade!.length, 3);

  // 迁完之后截图导入又写进同一只的持有记录(常是总持仓):不自动叠加;同一代码两条新记录也不自动迁
  const e = ledgerUpsert(ctx, { kind: "position", record: { symbol: "600519", shares: 150, cost: 1480 } });
  const f1 = ledgerUpsert(ctx, { kind: "position", record: { symbol: "601318", shares: 100, cost: 45 } });
  const f2 = ledgerUpsert(ctx, { kind: "position", record: { symbol: "601318", shares: 300, cost: 46 } });
  const later = await legacyAct(ctx, { action: "migrate" }, sig, NOW);
  assert.deepEqual(later.result, { backup: null, migrated: [], removed_stale: [], failed: [] });
  const st = Object.fromEntries(later.view.legacy.map((l) => [l.id, [l.state, l.why]]));
  assert.equal(st[e.id]![0], "conflict");
  assert.match(st[e.id]![1] as string, /已经有交易流水/);
  assert.deepEqual([st[f1.id]![0], st[f2.id]![0]], ["conflict", "conflict"]);
  assert.match(st[f1.id]![1] as string, /有 2 条旧持有记录/);
  assert.deepEqual(Object.fromEntries(later.view.holdings.map((h) => [h.symbol, h.shares]))["600519"], 100, "持有数不被叠成 250");
  // 选一条补上:另一条随即因已有流水仍是冲突
  const picked = await legacyAct(ctx, { action: "adopt", id: f2.id }, sig, NOW);
  assert.deepEqual(picked.result.migrated.map((m) => m.position_id), [f2.id]);
  assert.deepEqual(picked.view.legacy.find((l) => l.id === f1.id)?.state, "conflict");
  assert.equal(picked.view.holdings.find((h) => h.symbol === "601318")?.shares, 300);
}));

test("迁移:中途断掉留下「流水已写、旧记录还在」的,下次只删旧记录;数对不上算冲突、不删", withRoot(async (ctx) => {
  const p = ledgerUpsert(ctx, { kind: "position", record: { symbol: "600519", shares: 100, cost: 10 } });
  const q = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000001", shares: 100, cost: 10 } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "opening", date: "2026-10-09", shares: 100, price: 10, migrated_from: p.id } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000001", type: "opening", date: "2026-10-09", shares: 50, price: 10, migrated_from: q.id } });
  const v = await holdingsView(ctx, {}, sig, NOW);
  assert.deepEqual(v.legacy.map((l) => [l.symbol, l.state]), [["600519", "stale"], ["000001", "conflict"]]);
  const oldOpening = ledgerList(ctx, "trade").trade!.find((t) => t.migrated_from === q.id)!;
  assert.deepEqual(v.legacy.map((l) => l.migrated_trade), [null, oldOpening.id], "对不上的那条带上已转过的那笔,界面据此说「替换」");
  assert.match(v.legacy[1]!.why, /替换那笔/);
  const { result } = await legacyAct(ctx, { action: "migrate" }, sig, NOW);
  assert.deepEqual([result.removed_stale, result.migrated], [[p.id], []]);
  assert.deepEqual(ledgerList(ctx, "position").position!.map((r) => r.id), [q.id]);
  assert.equal(ledgerList(ctx, "trade").trade!.length, 2, "不另写流水");
  // 现在持有:stale 的旧记录不重复算;冲突的旧记录照样算持有
  assert.deepEqual(heldFromLedger(ledgerList(ctx)).map((h) => h.symbol), ["000001", "600519"]);
  // 确认转换 = 替换那笔期初(按旧记录现在的 100 股),不是再补一笔
  await legacyAct(ctx, { action: "adopt", id: q.id }, sig, NOW);
  const openings = ledgerList(ctx, "trade").trade!.filter((t) => t.symbol === "000001");
  assert.deepEqual(openings.map((t) => [t.type, t.shares, t.migrated_from]), [["opening", 100, q.id]]);
  assert.equal(openings[0]!.id, oldOpening.id, "原地改写那一笔(审计第二轮 B3)");
}));

test("迁移:写完流水发现旧记录已被别处改了 —— 撤回刚写的流水、旧记录不删", withRoot(async (ctx) => {
  const p = ledgerUpsert(ctx, { kind: "position", record: { symbol: "600519", shares: 100, cost: 10 } });
  ledgerUpsert(ctx, { kind: "position", record: { ...p, shares: 150 } });
  const r = convertOne(ctx, p, "2026-10-09");
  assert.ok("why" in r && /被别处改了/.test(r.why), JSON.stringify(r));
  assert.deepEqual(ledgerList(ctx, "trade").trade ?? [], []);
  assert.equal(ledgerList(ctx, "position").position![0]!.shares, 150);
  const gone = { ...p, id: "position-gone" };
  const r2 = convertOne(ctx, gone, "2026-10-09");
  assert.ok("why" in r2 && /被别处删了/.test(r2.why));
  assert.deepEqual(ledgerList(ctx, "trade").trade ?? [], []);
}));

test("冲突由用户选:按它补一笔期初持仓,或删掉;两次都先备份(同一天第二个备份加时分秒)", withRoot(async (ctx) => {
  const d = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000858", name: "五粮液", shares: 300, cost: 120 } });
  const c = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000333", shares: 0, cost: 50 } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000858", type: "buy", date: "2025-03-03", shares: 100, price: 130 } });
  await assert.rejects(legacyAct(ctx, { action: "adopt", id: c.id }, sig, NOW), /没法转/);
  await assert.rejects(legacyAct(ctx, { action: "adopt", id: "position-nope" }, sig, NOW), /没有这条旧持有记录/);
  assert.equal(backups(ctx).length, 0, "拒绝的动作不备份");

  const adopted = await legacyAct(ctx, { action: "adopt", id: d.id }, sig, NOW);
  assert.equal(adopted.result.backup, "ledger/持仓迁移备份-2026-10-09");
  assert.equal(adopted.result.migrated.length, 1);
  const h = adopted.view.holdings.find((x) => x.symbol === "000858")!;
  assert.equal(h.shares, 400);
  assert.equal(h.cost_total, 300 * 120 + 100 * 130);

  const discarded = await legacyAct(ctx, { action: "discard", id: c.id }, sig, NOW);
  assert.equal(discarded.result.backup, "ledger/持仓迁移备份-2026-10-09-140000");
  assert.deepEqual(discarded.result.removed_stale, [c.id]);
  assert.deepEqual(ledgerList(ctx, "position").position ?? [], []);
  assert.deepEqual(discarded.view.legacy, []);
  // 第二份备份里是删除前的旧记录
  const kept = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, discarded.result.backup!, "position.json"), "utf8")) as { records: LedgerRecord[] };
  assert.deepEqual(kept.records.map((r) => r.id), [c.id]);
}));

test("持仓视图:成本法可选、写错报参数错误;动作写错报错;手改坏的流水说原因、不参与计算", withRoot(async (ctx) => {
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "buy", date: "2025-01-02", shares: 100, price: 10 } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "buy", date: "2025-02-02", shares: 100, price: 20 } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "sell", date: "2025-03-02", shares: 100, price: 30 } });
  const avg = await holdingsView(ctx, {}, sig, NOW);
  const fifo = await holdingsView(ctx, { method: "fifo" }, sig, NOW);
  assert.deepEqual([avg.method, avg.method_label, avg.holdings[0]!.cost_total, avg.holdings[0]!.realized_pnl], ["average", "移动加权平均", 1500, 1500]);
  assert.deepEqual([fifo.method, fifo.method_label, fifo.holdings[0]!.cost_total, fifo.holdings[0]!.realized_pnl], ["fifo", "先进先出", 2000, 2000]);
  assert.deepEqual(avg.methods.map((m) => m.id), ["fifo", "average"]);
  assert.deepEqual(avg.trades.map((t) => t.date), ["2025-01-02", "2025-02-02", "2025-03-02"]);
  await assert.rejects(holdingsView(ctx, { method: "lifo" }, sig, NOW), (e: unknown) => e instanceof ServiceError && e.code === "bad_request");
  await assert.rejects(holdingsAct(ctx, { action: "wipe" }, sig, NOW), (e: unknown) => e instanceof ServiceError && e.code === "bad_request");

  const file = ledgerFile(ctx, "trade.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
  doc.records[1]!.symbol = "hk00700";
  fs.writeFileSync(file, JSON.stringify(doc));
  const v = await holdingsView(ctx, {}, sig, NOW);
  assert.deepEqual(v.issues.map((i) => [i.symbol, /字段不合台账规则/.test(i.why)]), [["hk00700", true]]);
  // 坏的那笔被排除:买 100 卖 100 正好卖光,进清仓清单(30 − 10)× 100
  assert.deepEqual(v.holdings, []);
  assert.deepEqual(v.closed.map((c) => [c.symbol, c.realized_pnl]), [["600519", 2000]]);
}));

test("收益率:服务端读台账流水交给收益率工具;手改坏的流水不送、只送计算要的字段", withRoot(async (ctx) => {
  // 假 Python:把收到的参数和 stdin 原样记下来,回一个合法结果 —— 只验「送了什么」,收益率本身在 backtest/tests 里验
  const seen = path.join(ctx.dataRoot, "seen.json");
  const fake = path.join(ctx.dataRoot, "fake-python.sh");
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s ' "$@" > '${seen}.args'\ncat > '${seen}'\necho '{"ok":true,"result":{"groups":[]}}'\n`, { mode: 0o755 });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", name: "贵州茅台", type: "buy", date: "2025-01-02", shares: 100, price: 10, fee: 5, note: "备注不送" } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "00700.HK", type: "split", date: "2025-02-02", ratio: 5 } });
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "AAPL", type: "dividend", date: "2025-03-02", amount: 3 } });
  const file = ledgerFile(ctx, "trade.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
  doc.records[2]!.amount = "3";   // 手改坏
  fs.writeFileSync(file, JSON.stringify(doc));
  const out = await holdingsPerf({ ...ctx, python: fake }, {}, sig);
  assert.deepEqual(out, { ok: true, result: { groups: [] } });
  assert.equal(fs.readFileSync(`${seen}.args`, "utf8").trim(), "-m backtest.portfolio_perf");
  const sent = JSON.parse(fs.readFileSync(seen, "utf8")) as { charts: boolean; trades: Record<string, unknown>[] };
  assert.equal(sent.charts, true);
  assert.deepEqual(sent.trades.map((t) => t.symbol), ["600519", "00700.HK"]);
  assert.deepEqual(Object.keys(sent.trades[0]!).sort(), ["amount", "created_at", "date", "fee", "id", "name", "price", "ratio", "shares", "symbol", "type"]);
  assert.deepEqual([sent.trades[0]!.shares, sent.trades[0]!.fee, sent.trades[0]!.amount, sent.trades[1]!.ratio], [100, 5, null, 5]);
}));

const importBackups = (ctx: ServiceContext) => fs.readdirSync(path.join(ctx.dataRoot, "ledger")).filter((f) => f.startsWith("持仓导入备份")).sort();
type Preview = { problem: string | null; duplicate: string | null; duplicate_of: number | null; skip_reason: string | null }[];

test("导入预览:逐行说数据对不对、和已记的是否一样、表格里重复、写进去以后会不会算不了;只看不写", withRoot(async (ctx) => {
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "buy", date: "2025-01-02", shares: 100, price: 10 } });
  const before = fs.readFileSync(ledgerFile(ctx, "trade.json"));
  const rows = [
    { symbol: "600519", type: "buy", date: "2025-01-02", shares: 100, price: 10, fee: 0 }, // 和已记的一样(没写费用 = 费用 0)
    { symbol: "000858", type: "buy", date: "2025-02-03", shares: 100, price: 130, fee: 5 },
    { symbol: "000858", type: "buy", date: "2025-02-03", shares: 100, price: 130, fee: 5 }, // 表格里和上一行一样
    { symbol: "000858", type: "sell", date: "2025-03-01", shares: 300, price: 140 }, // 超过持有
    { symbol: "000858", type: "buy", date: "2025-03-02", shares: 100, price: 0 },
    { symbol: "abc!!", type: "buy", date: "2025-03-02", shares: 100, price: 1 },
    { symbol: "600519", type: "sell", date: "2025-01-02", shares: 50, price: 11 }, // 和已记的买入同一天:排在它后面,能卖
    { symbol: "600519", type: "sell", date: "2025-01-03", shares: 100, price: 11 }, // 第 1 行(重复)默认不勾 ⇒ 只剩 50
  ];
  const { preview } = (await holdingsAct(ctx, { action: "import_preview", rows }, sig, NOW)) as { preview: Preview };
  assert.deepEqual(preview.map((r) => [r.duplicate, r.duplicate_of]), [["existing", null], [null, null], ["table", 1], [null, null], [null, null], [null, null], [null, null], [null, null]]);
  assert.deepEqual(preview.slice(0, 4).map((r) => r.problem), [null, null, null, null]);
  assert.equal(preview[6]!.skip_reason, null, "同一天:导入的排在已记的后面");
  assert.match(preview[7]!.skip_reason!, /卖出 100 股,超过当时持有的 50 股/, "和已记重复的那行默认不算进去");
  assert.match(preview[4]!.problem!, /买入要写大于 0 的成交价/);
  assert.match(preview[5]!.problem!, /字段不合台账规则/);
  // 默认勾选 = 数据对、且不和已记的重复:第 2、3 行都买 ⇒ 卖 300 超过 200
  assert.deepEqual(preview.map((r) => r.skip_reason === null), [true, true, true, false, true, true, true, false]);
  assert.match(preview[3]!.skip_reason!, /卖出 300 股,超过当时持有的 200 股/);
  // 界面改了勾选:只勾第 2 行和卖出那行 ⇒ 当时只持有 100
  const re = (await holdingsAct(ctx, { action: "import_preview", rows, selected: [true, true, false, true, false, false, true, true] }, sig, NOW)) as { preview: Preview };
  assert.match(re.preview[3]!.skip_reason!, /超过当时持有的 100 股/);
  assert.equal(re.preview[7]!.skip_reason, null, "勾上重复那行 ⇒ 当时持有 150,够卖");
  assert.ok(fs.readFileSync(ledgerFile(ctx, "trade.json")).equals(before), "预览不写盘");
  assert.deepEqual(importBackups(ctx), [], "预览不备份");
}));

test("导入预览:已记的流水会因为这批新流水变成算不了的,单独列出来;本来就算不了的不重复说", withRoot(async (ctx) => {
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "buy", date: "2025-01-02", shares: 100, price: 10 } });
  const sold = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "sell", date: "2025-03-03", shares: 100, price: 12 } });
  const brokenAlready = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000858", type: "sell", date: "2025-03-03", shares: 10, price: 12 } });
  type Full = { preview: Preview; existing_issues: { id: string; symbol: string; date: string; why: string }[] };
  const rows = [{ symbol: "600519", type: "sell", date: "2025-02-03", shares: 50, price: 11 }];
  const r = (await holdingsAct(ctx, { action: "import_preview", rows }, sig, NOW)) as Full;
  assert.equal(r.preview[0]!.skip_reason, null, "表格里这笔本身能算");
  assert.deepEqual(r.existing_issues.map((x) => [x.id, x.symbol, x.date]), [[sold.id, "600519", "2025-03-03"]]);
  assert.match(r.existing_issues[0]!.why, /卖出 100 股,超过当时持有的 50 股/);
  assert.ok(!r.existing_issues.some((x) => x.id === brokenAlready.id), "导入前就算不了的不算新问题");
  // 不勾这一行 ⇒ 没有新问题
  const none = (await holdingsAct(ctx, { action: "import_preview", rows, selected: [false] }, sig, NOW)) as Full;
  assert.deepEqual(none.existing_issues, []);
}));

test("导入:先备份原样文件,再一次写进去;只收流水字段;同一天按表格顺序;写完视图跟着变", withRoot(async (ctx) => {
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000858", type: "buy", date: "2025-02-03", shares: 100, price: 120 } });
  const before = fs.readFileSync(ledgerFile(ctx, "trade.json"));
  const rows = [
    { symbol: "000858", type: "buy", date: "2025-02-03", shares: 100, price: 130, fee: 5, note: "表格第一行", id: "trade-偷塞", created_at: "1999", migrated_from: "position-x", 多余: 1 },
    { symbol: "000858", type: "sell", date: "2025-02-03", shares: 150, price: 140 },
    { symbol: "000858", type: "dividend", date: "2025-06-01", amount: 25 },
  ];
  const out = (await holdingsAct(ctx, { action: "import", rows, method: "fifo" }, sig, NOW)) as { imported: { backup: string; imported: number; ids: string[] }; view: { method: string; holdings: { symbol: string; shares: number }[]; issues: unknown[] } };
  assert.equal(out.imported.backup, "ledger/持仓导入备份-2026-10-09");
  const dir = path.join(ctx.dataRoot, out.imported.backup);
  assert.ok(fs.readFileSync(path.join(dir, "trade.json")).equals(before), "备份是导入前的原样字节");
  assert.match(fs.readFileSync(path.join(dir, "README.md"), "utf8"), /# 持仓导入备份[\s\S]*从表格导入 3 笔交易流水/);
  assert.equal(out.imported.imported, 3);
  const saved = ledgerList(ctx, "trade").trade!.filter((t) => out.imported.ids.includes(t.id));
  assert.equal(saved.length, 3);
  assert.ok(!saved.some((t) => t.id === "trade-偷塞" || "migrated_from" in t || "多余" in t), "只收流水字段");
  assert.equal(saved[0]!.note, "表格第一行");
  assert.ok(saved[0]!.created_at < saved[1]!.created_at, "同一天:表格里先买后卖,重放也先买后卖");
  assert.deepEqual([out.view.method, out.view.issues, out.view.holdings.map((h) => [h.symbol, h.shares])], ["fifo", [], [["000858", 50]]]);
}));

test("🔴 导入有一行不对就一条不写、也不留备份;空表、超过上限、不是数组都拒", withRoot(async (ctx) => {
  ledgerUpsert(ctx, { kind: "trade", record: { symbol: "600519", type: "buy", date: "2025-01-02", shares: 100, price: 10 } });
  const before = fs.readFileSync(ledgerFile(ctx, "trade.json"));
  const good = { symbol: "600519", type: "buy", date: "2025-02-03", shares: 1, price: 10 };
  const bad = (msg: RegExp) => (e: unknown) => e instanceof ServiceError && e.code === "bad_request" && msg.test(e.message);
  await assert.rejects(holdingsAct(ctx, { action: "import", rows: [good, { ...good, date: "2025-02-31" }, { ...good, type: "转入" }] }, sig, NOW),
    bad(/有 2 条数据不对,这次一条都没写:第 2 条:日期「2025-02-31」不是有效日期;第 3 条:类型「转入」不认识/));
  // 月份不存在的日期:以前 toISOString 直接抛错(500),要和别的坏日期一样逐条说
  await assert.rejects(holdingsAct(ctx, { action: "import", rows: [{ ...good, date: "2025-13-01" }] }, sig, NOW), bad(/第 1 条:日期「2025-13-01」不是有效日期/));
  await assert.rejects(holdingsAct(ctx, { action: "import", rows: [] }, sig, NOW), bad(/没有要导入的流水/));
  await assert.rejects(holdingsAct(ctx, { action: "import", rows: "600519,buy" }, sig, NOW), bad(/没有要导入的流水/));
  await assert.rejects(holdingsAct(ctx, { action: "import", rows: Array.from({ length: 1001 }, () => good) }, sig, NOW), bad(/一次最多导入 1000 行,这次有 1001 行/));
  await assert.rejects(holdingsAct(ctx, { action: "import_preview", rows: [good, 5] }, sig, NOW), bad(/第 2 条不是一笔流水/));
  assert.ok(fs.readFileSync(ledgerFile(ctx, "trade.json")).equals(before), "一字未动");
  assert.deepEqual(importBackups(ctx), [], "没写就不备份");
  // 上限那一档本身能导
  const ok = (await holdingsAct(ctx, { action: "import", rows: Array.from({ length: 1000 }, () => good) }, sig, NOW)) as { imported: { imported: number } };
  assert.equal(ok.imported.imported, 1000);
}));

test("接口:GET /view/holdings 读、POST /view/holdings 迁移;没有写动作的视图 POST 报参数错误", withRoot(async (ctx) => {
  ledgerUpsert(ctx, { kind: "position", record: { symbol: "600519", shares: 100, cost: 10 } });
  const server = createApiServer(ctx, { token: "t-test-token-0123456789" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: "Bearer t-test-token-0123456789", "content-type": "application/json" };
  try {
    const g = await fetch(`${base}/view/holdings?method=fifo`, { headers });
    assert.equal(g.status, 200);
    assert.equal(((await g.json()) as { migration_pending: number }).migration_pending, 1);
    assert.equal(ledgerList(ctx, "position").position!.length, 1, "读不写盘");
    const p = await fetch(`${base}/view/holdings`, { method: "POST", headers, body: JSON.stringify({ action: "migrate", method: "fifo" }) });
    assert.equal(p.status, 200);
    const body = (await p.json()) as { result: { migrated: unknown[] }; view: { method: string; holdings: { symbol: string }[] } };
    assert.deepEqual([body.result.migrated.length, body.view.method, body.view.holdings.map((h) => h.symbol)], [1, "fifo", ["600519"]]);
    const pre = await fetch(`${base}/view/holdings`, { method: "POST", headers, body: JSON.stringify({ action: "import_preview", rows: [{ symbol: "600519", type: "buy", date: "2025-01-02", shares: 1, price: 10 }] }) });
    assert.deepEqual([pre.status, ((await pre.json()) as { preview: unknown[] }).preview.length], [200, 1]);
    const noAct = await fetch(`${base}/view/calendar`, { method: "POST", headers, body: "{}" });
    assert.deepEqual([noAct.status, ((await noAct.json()) as { error: string }).error], [400, "bad_request"]);
    const form = await fetch(`${base}/view/holdings`, { method: "POST", headers: { authorization: headers.authorization, "content-type": "text/plain" }, body: "{}" });
    assert.equal(form.status, 415, "写动作与台账写入同一套防护:非 JSON 拒");
  } finally { server.close(); }
}));

test("🔴 已转过期初、旧记录后来被改成 0 股:确认转换要当场拒绝,原来那笔期初不能先被删掉(审计 B3)", withRoot(async (ctx) => {
  const q = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000001", shares: 100, cost: 10 } });
  const opening = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000001", type: "opening", date: "2026-10-09", shares: 100, price: 10, migrated_from: q.id } });
  const zero = ledgerUpsert(ctx, { kind: "position", record: { ...q, shares: 0 } });
  const v = await holdingsView(ctx, {}, sig, NOW);
  assert.equal(v.legacy.find((l) => l.id === q.id)?.state, "conflict", "前提:分类成冲突(先于数量检查)");
  await assert.rejects(legacyAct(ctx, { action: "adopt", id: q.id }, sig, NOW), /数量是 0/);
  assert.deepEqual(ledgerList(ctx, "trade").trade!.map((t) => t.id), [opening.id], "原来那笔期初还在");
  assert.equal(backups(ctx).length, 0, "拒绝的动作不备份");
  ledgerUpsert(ctx, { kind: "position", record: { ...zero, shares: 120 } });
  // 改回有效数量:照常替换 —— 原地改写原来那笔(同一个 id),一次写盘,中途出错也不会留下两笔(审计第二轮 B3)
  const ok = await legacyAct(ctx, { action: "adopt", id: q.id }, sig, NOW);
  assert.equal(ok.result.migrated.length, 1);
  assert.deepEqual(ledgerList(ctx, "trade").trade!.map((t) => [t.id, t.shares, t.migrated_from]), [[opening.id, 120, q.id]]);
  assert.equal(ok.result.migrated[0]!.trade_id, opening.id);
  assert.equal(ledgerList(ctx, "position").position!.length, 0, "旧记录删了");
}));

test("🔴 替换改写之后、删旧记录之前进程退出:下次打开归为「已转过」自动删旧记录,始终只有一笔期初(审计第二轮 B3)", withRoot(async (ctx) => {
  const q = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000001", shares: 120, cost: 10 } });
  const opening = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000001", type: "opening", date: "2026-10-09", shares: 100, price: 10, migrated_from: q.id } });
  // 模拟 convertOne 只做完第一步:原来那笔已改写成 120 股,旧记录还没删
  const posNow = ledgerList(ctx, "position").position![0]!;
  ledgerUpsert(ctx, { kind: "trade", record: { ...opening, shares: 120 } });
  assert.equal(posNow.id, q.id);
  const v = await holdingsView(ctx, {}, sig, NOW);
  assert.equal(v.legacy.find((l) => l.id === q.id)?.state, "stale", "流水已和旧记录一致 ⇒ 已转过,不是冲突");
  const { result } = await legacyAct(ctx, { action: "migrate" }, sig, NOW);
  assert.deepEqual(result.removed_stale, [q.id]);
  assert.deepEqual(ledgerList(ctx, "trade").trade!.map((t) => [t.id, t.shares]), [[opening.id, 120]], "只有一笔期初");
  assert.equal(ledgerList(ctx, "position").position!.length, 0, "自动迁移把已转过的旧记录删了");
}));

test("🔴 替换时旧记录被别处改了:原地改写的那笔期初写回原样,旧记录不删(审计第二轮 B3)", withRoot(async (ctx) => {
  const q = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000001", shares: 120, cost: 10 } });
  const opening = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000001", type: "opening", date: "2026-10-09", shares: 100, price: 10, migrated_from: q.id } });
  const stalePos = { ...q, shares: 130 };   // 调用方手里的旧版本 ≠ 磁盘上的现状
  const r = convertOne(ctx, stalePos as LedgerRecord, "2026-10-10", opening);
  assert.ok("why" in r && /被别处改了/.test(r.why));
  const t = ledgerList(ctx, "trade").trade!;
  assert.deepEqual(t.map((x) => [x.id, x.shares, x.price, x.date]), [[opening.id, 100, 10, "2026-10-09"]], "写回原样");
  assert.equal(ledgerList(ctx, "position").position!.length, 1);
}));

test("🔴 已转过期初、旧记录字段被手改坏:确认转换当场拒绝,原来那笔期初保留(审计 B3)", withRoot(async (ctx) => {
  const q = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000001", shares: 100, cost: 10 } });
  const opening = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000001", type: "opening", date: "2026-10-09", shares: 100, price: 10, migrated_from: q.id } });
  const file = ledgerFile(ctx, "position.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
  Object.assign(doc.records[0]!, { shares: 120, opened_at: "2025-02-31" });
  fs.writeFileSync(file, JSON.stringify(doc));
  await assert.rejects(legacyAct(ctx, { action: "adopt", id: q.id }, sig, NOW), /字段不合台账规则/);
  assert.deepEqual(ledgerList(ctx, "trade").trade!.map((t) => t.id), [opening.id]);
  assert.equal(backups(ctx).length, 0, "拒绝的动作不备份");
}));

test("🔴 替换时新那笔写不进去:原来那笔期初不能先被删掉(先写新的、写成了再撤旧的,审计 B3)", withRoot(async (ctx) => {
  const q = ledgerUpsert(ctx, { kind: "position", record: { symbol: "000001", shares: 100, cost: 10 } });
  const opening = ledgerUpsert(ctx, { kind: "trade", record: { symbol: "000001", type: "opening", date: "2026-10-09", shares: 100, price: 10, migrated_from: q.id } });
  // 手改过的台账:旧记录 id 超过流水 migrated_from 的 80 字上限 ⇒ 新流水一定写不进去(字段本身都合规)
  const longId = `position-${"x".repeat(90)}`;
  for (const f of ["position.json", "trade.json"]) {
    const p = ledgerFile(ctx, f);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").split(q.id).join(longId));
  }
  const pf = ledgerFile(ctx, "position.json");
  const doc = JSON.parse(fs.readFileSync(pf, "utf8")) as { records: Record<string, unknown>[] };
  doc.records[0]!.shares = 120;
  fs.writeFileSync(pf, JSON.stringify(doc));
  const r = await legacyAct(ctx, { action: "adopt", id: longId }, sig, NOW);
  assert.equal(r.result.migrated.length, 0);
  assert.match(r.result.failed[0]?.why ?? "", /写入流水失败/);
  assert.deepEqual(ledgerList(ctx, "trade").trade!.map((t) => [t.id, t.migrated_from]), [[opening.id, longId]], "原来那笔期初还在");
}));
