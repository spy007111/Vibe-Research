import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { LedgerRecord } from "../src/ledger.ts";
import { COST_METHODS, replayTrades, tradeOf, type CostMethod } from "../src/finance/holdings.ts";

// 与 backtest/tests/test_portfolio_perf.py 共用一份样例:持仓页的重放和收益率工具的重放必须得出同样的股数、跳过同样的流水
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backtest", "tests", "fixtures", "trade_replay_parity.json");

test("交易流水重放:与收益率工具共用的对照样例(两种成本法)", () => {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as {
    trades: Record<string, unknown>[];
    expected: { held: Record<string, number>; skipped: { id: string; why: string }[] };
  };
  const trades = fx.trades.map((r) => tradeOf(r as unknown as LedgerRecord));
  for (const method of Object.keys(COST_METHODS) as CostMethod[]) {
    const r = replayTrades(trades, method);
    assert.deepEqual(r.issues.map((i) => ({ id: i.id, why: i.why })), fx.expected.skipped, method);
    assert.deepEqual(r.holdings.map((h) => h.symbol).sort(), Object.keys(fx.expected.held).sort(), method);
    for (const h of r.holdings) assert.ok(Math.abs(h.shares - fx.expected.held[h.symbol]!) < 1e-9, `${method} ${h.symbol} ${h.shares}`);
  }
});
