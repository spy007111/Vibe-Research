import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { api, ApiError, SAVED_REFRESH_FAILED } from "../src/verticals/finance/lib/api.ts";
import { backend, type FetchResult } from "../src/verticals/finance/lib/backend.ts";
import {
  cnyTotal, emptyTradeForm, fxFromEnvelope, isRealDay, tradeDetail, tradeRecord,
  type HoldingsView, type MigrationResult, type Trade, type TradeForm,
} from "../src/verticals/finance/lib/holdings.ts";

const form = (patch: Partial<TradeForm>): TradeForm => ({ ...emptyTradeForm(), symbol: "600519", date: "2026-09-01", ...patch });

test("「记一笔 / 导入」默认开不开只在第一次拿到数据时定：记下第一笔、导入完成后不自己收起", () => {
  const page = fs.readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  assert.match(page, /useEffect\(\(\) => \{\n    if \(entryOpen === null && data !== null\) setEntryOpen\(trades\.length === 0 && legacy\.length === 0\);/);
  assert.match(page, /\}, \[data\]\);/);
  assert.match(page, /aria-controls="portfolio-entry"/);
  assert.match(page, /<div id="portfolio-entry" hidden=\{!entryShown\}>/);
});

test("记一笔:每类只交自己的字段;不对的写原因,空着不当 0", () => {
  assert.deepEqual(tradeRecord(form({ type: "buy", shares: "100", price: "12.5", fee: "5", amount: "999", ratio: "2", name: " 贵州茅台 ", note: " 看中报 " })),
    { record: { symbol: "600519", type: "buy", date: "2026-09-01", shares: 100, price: 12.5, fee: 5, name: "贵州茅台", note: "看中报" } });
  assert.deepEqual(tradeRecord(form({ type: "sell", shares: "100", price: "13" })), { record: { symbol: "600519", type: "sell", date: "2026-09-01", shares: 100, price: 13 } }, "费用没填就不写,不写成 0");
  assert.deepEqual(tradeRecord(form({ type: "opening", symbol: "aapl", shares: "10", price: "-3.2" })), { record: { symbol: "AAPL", type: "opening", date: "2026-09-01", shares: 10, price: -3.2 } }, "期初成本可以是负数");
  assert.deepEqual(tradeRecord(form({ type: "dividend", amount: "320", shares: "100" })), { record: { symbol: "600519", type: "dividend", date: "2026-09-01", amount: 320 } });
  assert.deepEqual(tradeRecord(form({ type: "split", symbol: "700", ratio: "1.5" })), { record: { symbol: "00700.HK", type: "split", date: "2026-09-01", ratio: 1.5 } });
  const bad: [Partial<TradeForm>, RegExp][] = [
    [{ symbol: "" }, /代码/],
    [{ date: "2026-02-30" }, /有效日期/],
    [{ date: "2026/09/01" }, /有效日期/],
    [{ type: "buy", shares: "", price: "1" }, /数量要大于 0/],
    [{ type: "buy", shares: "0", price: "1" }, /数量要大于 0/],
    [{ type: "sell", shares: "10", price: "abc" }, /成交价要大于 0/],
    [{ type: "buy", shares: "10", price: "1", fee: "-1" }, /费用不能是负数/],
    [{ type: "buy", shares: "10", price: "1", fee: "x" }, /费用不能是负数/],
    [{ type: "opening", shares: "10", price: "" }, /每股成本/],
    [{ type: "dividend", amount: "0" }, /到账金额/],
    [{ type: "split", ratio: "-1" }, /比例/],
  ];
  for (const [patch, why] of bad) {
    const r = tradeRecord(form(patch));
    assert.ok("error" in r && why.test(r.error), `${JSON.stringify(patch)} 应报 ${why}`);
  }
  assert.equal(isRealDay("2024-02-29"), true);
  assert.equal(isRealDay("2025-02-29"), false);
  const t = { shares: 100, price: 12.5, fee: 0, amount: null, ratio: null } as unknown as Trade;
  assert.equal(tradeDetail({ ...t, type: "buy" }), "100 股 × 12.5", "费用 0 不显示");
  assert.equal(tradeDetail({ ...t, type: "sell", fee: 5 }), "100 股 × 12.5,费用 5");
  assert.equal(tradeDetail({ ...t, type: "split", ratio: null }), "每 1 股变 ? 股", "缺数显示问号,不显示 0");
});

test("人民币合计:每个用到的币种都有汇率才给,缺哪个说哪个", () => {
  const fx = fxFromEnvelope({ evidence: [
    { field: "fx_usd_cny", value: 7.1, period: "2026-09-01" },
    { field: "fx_hkd_cny", value: 0, period: "2026-09-01" },
  ] } as never, "2026-09-01T08:00:00Z");
  assert.deepEqual(fx, { USD: 7.1, HKD: null, date: "2026-09-01", fetched_at: "2026-09-01T08:00:00Z" }, "汇率 0 当没取到");
  assert.deepEqual(fxFromEnvelope(null), { USD: null, HKD: null, date: null, fetched_at: null });
  const cny = { currency: "CNY" as const, market_value: 1000, cost: 800 };
  const usd = { currency: "USD" as const, market_value: 100, cost: 120 };
  assert.deepEqual(cnyTotal([cny, { currency: "HKD", market_value: 50, cost: 40 }], fx), { missing: ["HKD"] });
  const ok = cnyTotal([cny, usd], fx);
  assert.ok(!("missing" in ok));
  assert.equal(ok.market_value, 1710);
  assert.equal(ok.cost, 1652);
  assert.ok(Math.abs(ok.pnl - 58) < 1e-9);
  assert.equal(cnyTotal([{ currency: "CNY", market_value: 10, cost: 0 }], fx).hasOwnProperty("missing"), false);
  assert.equal((cnyTotal([{ currency: "CNY", market_value: 10, cost: 0 }], fx) as { pnl_pct: number | null }).pnl_pct, null, "成本 ≤ 0 不给比例");
});

const holding = (symbol: string, name: string, shares: number, cost: number, extra: Partial<HoldingsView["holdings"][number]> = {}) =>
  ({ symbol, name, shares, unit_cost: cost / shares, cost_total: cost, opened_at: "2026-01-05", lots: [], realized_pnl: 0, dividends: 0, fees: 0, trade_count: 1, ...extra });

const viewOf = (patch: Partial<HoldingsView> = {}): HoldingsView => ({
  method: "average", method_label: "移动加权平均", methods: [{ id: "fifo", label: "先进先出" }, { id: "average", label: "移动加权平均" }],
  holdings: [], closed: [], realized: [], dividends: [], issues: [], trades: [], legacy: [], migration_pending: 0, today: "2026-09-01",
  ...patch,
});

function stub(views: { first: HoldingsView; after?: HoldingsView; migration?: MigrationResult }, fxEvidence: unknown[] | null, closedRecords: Record<string, unknown>[] = []) {
  const original = { holdings: backend.holdings, act: backend.holdingsAct, fetch: backend.fetch, ledger: backend.ledger, save: backend.ledgerSave, del: backend.ledgerDelete };
  const calls: unknown[] = [];
  backend.holdings = async (method) => { calls.push(["holdings", method]); return views.first; };
  backend.holdingsAct = async (body) => { calls.push(["act", body]); return { result: views.migration ?? { backup: null, migrated: [], removed_stale: [], failed: [] }, view: views.after ?? views.first }; };
  backend.fetch = async (endpoint, opts) => {
    calls.push(["fetch", endpoint, opts]);
    if (endpoint === "tx_quotes_batch") return { cached: false, fetched_at: "t", envelope: { evidence: [
      { record_key: "600519", field: "price", value: 12, period: "2026-09-01" },
      { record_key: "600519", field: "security_name", value: "行情名", period: "2026-09-01" },
      { record_key: "hk00700", field: "price", value: 400, period: "2026-09-01" },
    ] } } as unknown as FetchResult;
    if (endpoint === "fx_rates" && fxEvidence) return { cached: false, fetched_at: "2026-09-01T08:00:00Z", envelope: { evidence: fxEvidence } } as unknown as FetchResult;
    throw new Error(`不该取 ${endpoint}`);
  };
  backend.ledger = async () => ({ records: { closed_position: closedRecords } }) as never;
  backend.ledgerSave = async (kind, record) => { calls.push(["save", kind, record]); return { ...record, id: "new" } as never; };
  backend.ledgerDelete = async (kind, id) => { calls.push(["delete", kind, id]); return { removed: true } as never; };
  return { calls, restore: () => Object.assign(backend, { holdings: original.holdings, holdingsAct: original.act, fetch: original.fetch, ledger: original.ledger, ledgerSave: original.save, ledgerDelete: original.del }) };
}

test("持仓页数据:有旧记录先迁移;缺行情的不进合计;按币种分开,人民币合计缺汇率就不给", async () => {
  const migration: MigrationResult = { backup: "ledger/持仓迁移备份-2026-09-01", migrated: [{ position_id: "p1", trade_id: "t1", symbol: "600519" }], removed_stale: [], failed: [] };
  const after = viewOf({
    holdings: [
      holding("600519", "", 100, 1000, { realized_pnl: 50, dividends: 8 }),
      holding("00700.HK", "腾讯控股", 10, 4200),
      holding("AAPL", "苹果", 5, 900, { realized_pnl: -20 }),
    ],
    closed: [{ symbol: "MSFT", name: "微软", realized_pnl: 30, dividends: 2, fees: 1, last_date: "2026-08-01" }],
  });
  const s = stub({ first: viewOf({ migration_pending: 1 }), after, migration }, [{ field: "fx_usd_cny", value: 7, period: "2026-09-01" }], [
    { id: "c1", symbol: "600519", name: "茅台", price: 1200, shares: 1, cost: 1000, closed_at: "2026-08-01" },
    { id: "damaged", symbol: "600519", price: null, shares: 1, cost: 0, closed_at: "2026-08-01" },
  ]);
  try {
    const d = await api.portfolio("fifo");
    assert.deepEqual(s.calls.slice(0, 2), [["holdings", "fifo"], ["act", { action: "migrate", method: "fifo" }]]);
    assert.equal(d.migration, migration);
    const [mt, tc, ap] = d.holdings;
    assert.equal(mt!.name, "行情名", "流水没写名称时用行情的名称");
    assert.equal(mt!.market_value, 1200);
    assert.equal(mt!.pnl, 200);
    assert.equal(mt!.pnl_pct, 20);
    assert.equal(mt!.cost, 10);
    assert.equal(tc!.pnl, -200);
    assert.equal(ap!.price, null, "拉不到行情是 null,不是成本也不是 0");
    assert.equal(ap!.pnl, null);
    assert.deepEqual(d.totals.map((t) => [t.currency, t.market_value, t.cost]), [["CNY", 1200, 1000], ["HKD", 4000, 4200]], "没行情的 AAPL 不进合计");
    assert.deepEqual(d.cny, { missing: ["HKD"] }, "缺港元汇率就不给人民币合计");
    assert.deepEqual(d.realized_totals, [{ currency: "CNY", pnl: 50, dividends: 8 }, { currency: "HKD", pnl: 0, dividends: 0 }, { currency: "USD", pnl: 10, dividends: 2 }],
      "持有中和已卖光的已实现按币种相加;流水算出来的 0 是真 0,照样列");
    assert.deepEqual(d.closed.map((c) => [c.code, c.currency, c.realized_pnl]), [["MSFT", "USD", 30]]);
    assert.deepEqual(d.legacy_closed.map((c) => [c.id, c.pnl]), [["c1", 200]]);
    assert.equal(d.legacy_closed_invalid, 1, "格式不对的旧清仓记录只计数,不删");
    assert.deepEqual(d.legacy_realized_totals, [{ currency: "CNY", pnl: 200 }], "旧清仓单独汇总,不并进流水的已实现");
    assert.deepEqual(d.unquoted, [{ currency: "USD", count: 1 }], "没取到行情的按币种计数,页面据此说明合计里少了几只");
    assert.equal(d.migration_error, null);
  } finally { s.restore(); }
});

test("持仓页数据:自动迁移失败不让整页空白,照常显示已有流水并带上原因", async () => {
  const first = viewOf({ migration_pending: 2, holdings: [holding("600519", "茅台", 100, 1000)] });
  const s = stub({ first }, null);
  backend.holdingsAct = async () => { throw new ApiError("台账文件被占用", 500); };
  try {
    const d = await api.portfolio("fifo");
    assert.equal(d.migration, null);
    assert.equal(d.migration_error, "台账文件被占用");
    assert.deepEqual(d.holdings.map((h) => [h.code, h.market_value]), [["600519", 1200]], "已有流水照常算");
    assert.deepEqual(d.unquoted, []);
  } finally { s.restore(); }
});

test("持仓页数据:汇率都有才折人民币;只有 A 股不取汇率", async () => {
  const both = viewOf({ holdings: [holding("600519", "茅台", 100, 1000), holding("00700.HK", "腾讯控股", 10, 4200)] });
  let s = stub({ first: both }, [{ field: "fx_hkd_cny", value: 0.9, period: "2026-09-01" }]);
  try {
    const d = await api.refreshPortfolio();
    assert.ok(d.cny && !("missing" in d.cny));
    assert.equal(d.cny.market_value, 1200 + 4000 * 0.9);
    assert.equal(d.cny.cost, 1000 + 4200 * 0.9);
    assert.equal(d.cny.fx.date, "2026-09-01");
    assert.equal(s.calls.filter((c) => (c as unknown[])[0] === "act").length, 0, "没有待迁移就不调写动作");
    assert.deepEqual(s.calls.find((c) => (c as unknown[])[1] === "tx_quotes_batch"), ["fetch", "tx_quotes_batch", { args: { codes: ["600519", "hk00700"] }, refresh: true }]);
  } finally { s.restore(); }
  s = stub({ first: viewOf({ holdings: [holding("600519", "茅台", 100, 1000)] }) }, null);
  try {
    const d = await api.portfolio();
    assert.equal(d.cny, null, "只有人民币就不另给一行");
    assert.ok(!s.calls.some((c) => (c as unknown[])[1] === "fx_rates"));
  } finally { s.restore(); }
});

test("记一笔 / 删流水 / 处理旧记录 / 删旧清仓都走对的台账与动作", async () => {
  const s = stub({ first: viewOf() }, null);
  try {
    await assert.rejects(api.addTrade(form({ type: "buy", shares: "", price: "1" }), "fifo"), (e) => e instanceof ApiError && /数量/.test(e.message));
    assert.ok(!s.calls.some((c) => (c as unknown[])[0] === "save"), "表单不对不写台账");
    await api.addTrade(form({ type: "dividend", amount: "50" }), "fifo");
    assert.deepEqual(s.calls.find((c) => (c as unknown[])[0] === "save"), ["save", "trade", { symbol: "600519", type: "dividend", date: "2026-09-01", amount: 50 }]);
    await api.removeTrade("t9", "fifo");
    await api.removeClosed("c1", "fifo");
    const dels = s.calls.filter((c) => (c as unknown[])[0] === "delete");
    assert.deepEqual(dels, [["delete", "trade", "t9"], ["delete", "closed_position", "c1"]]);
    s.calls.length = 0;
    await api.resolveLegacy("adopt", "p2", "fifo");
    assert.deepEqual(s.calls[0], ["act", { action: "adopt", id: "p2", method: "fifo" }]);
    assert.ok(!s.calls.some((c) => (c as unknown[])[0] === "holdings"), "写动作已带回新视图,不再多读一次");
  } finally { s.restore(); }
});

test("写进台账以后重读持仓失败：报「已经记下」而不是「记录失败」，表单照样清掉，只写一次（审计 C4）", async () => {
  const s = stub({ first: viewOf() }, null);
  backend.holdings = async () => { throw new ApiError("服务器开小差", 500, "internal"); };
  try {
    for (const [job, kind, says] of [
      [() => api.addTrade(form({ type: "buy", shares: "100", price: "12" }), "fifo"), "save", /这笔已经记下.*服务器开小差.*不用重做/],
      [() => api.removeTrade("t9", "fifo"), "delete", /这笔流水已经删掉/],
      [() => api.removeClosed("c1", "fifo"), "delete", /这条清仓记录已经删掉/],
    ] as const) {
      s.calls.length = 0;
      await assert.rejects(job(), (e) => e instanceof ApiError && e.code === SAVED_REFRESH_FAILED && says.test(e.message) && e.status === 500);
      assert.equal(s.calls.filter((c) => (c as unknown[])[0] === kind).length, 1, "只写一次");
    }
    // 写台账本身失败：不是这个码，照常报失败
    backend.ledgerSave = async () => { throw new ApiError("写不进去", 500, "internal"); };
    await assert.rejects(api.addTrade(form({ type: "buy", shares: "100", price: "12" }), "fifo"), (e) => e instanceof ApiError && e.code === "internal");
  } finally { s.restore(); }
  const page = fs.readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(e instanceof ApiError && e\.code === SAVED_REFRESH_FAILED\) setForm\(emptyTradeForm\(form\.type\)\);/, "已经记下就清表单");
  assert.match(page, /setErr\(savedButStale\(e\) \?\? "删除流水失败，请重试"\)/);
  assert.match(page, /setErr\(savedButStale\(e\) \?\? "删除清仓记录失败，请重试"\)/);
});

test("界面:备注在隐私模式下遮;缺行情的只数写在合计旁;只有已实现的币种也有卡片;迁移失败有提示;对不上的旧记录可替换", () => {
  const page = fs.readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  assert.match(page, /\{show\(t\.note\)\}/, "流水备注遮");
  assert.match(page, /\{show\(c\.note\)\}/, "旧清仓备注遮");
  assert.ok(!/\{(t|c)\.note\}/.test(page), "不留没遮的备注");
  assert.match(page, /另有 \{uq\} 只没取到行情，没算进上面的市值和成本/);
  assert.match(page, /另有 \{unquotedAll\} 只没取到行情，没算进来/);
  assert.match(page, /\(totals\.length > 0 \|\| extraTotals\.length > 0\) &&/, "全都没行情时汇总区照样出来");
  assert.match(page, /只持有中，没取到行情，市值和浮动盈亏暂缺/);
  assert.match(page, /\{data\?\.migration_error && \(/);
  assert.match(page, /没能自动转成流水：\{show\(data\.migration_error\)\}/);
  assert.match(page, /l\.migrated_trade \? "按它现在的数替换那笔期初持仓" : "按它补一笔期初持仓"/);
});

test("给 AI 的持仓：没取到现价直说，不写「现价null」；汇总说清有几只没算进去（第四轮审计 C4）", async () => {
  const { withRenderer } = await import("./helpers/render.ts");
  const { holdingContextLine } = await withRenderer((r) => r.load("/src/verticals/finance/pages/Portfolio.tsx"));
  const h = { code: "600519", name: "示例", shares: 100, cost: 10, cost_total: 1000, market: "a_share", currency: "CNY",
    opened_at: "2026-01-05", realized_pnl: 0, dividends: 0, price: null, market_value: null, pnl: null, pnl_pct: null };
  const line = holdingContextLine(h);
  assert.doesNotMatch(line, /null/);
  assert.match(line, /现价没取到/);
  assert.match(holdingContextLine({ ...h, price: 12, market_value: 1200, pnl: 200, pnl_pct: 20 }), /现价12 浮盈200\(20%\)/);
  const page = fs.readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  assert.match(page, /另有 \$\{unquotedOf\(t\.currency\)\} 只没取到现价/);
});

test("删清仓记录要按两次（第四轮审计 C5）", () => {
  const page = fs.readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  const fn = page.slice(page.indexOf("const removeClosed = async"), page.indexOf("const holdings = data?.holdings"));
  assert.ok(fn.indexOf("setConfirmDel(`closed:${id}`); return;") >= 0 && fn.indexOf("setConfirmDel(`closed:${id}`); return;") < fn.indexOf("api.removeClosed"),
    "第一次只变成「再按一次删除」，不调删除接口");
  assert.match(page, /confirmDel === `closed:\$\{c\.id\}` \? "再按一次删除"/);
});

test("B 股（900、200 开头）记一笔就拦下，和后端重放同一句话（第四轮审计 C1）", () => {
  for (const symbol of ["900901", "sh900901", "200002"]) {
    const r = tradeRecord(form({ type: "buy", symbol, shares: "100", price: "1" }));
    assert.ok("error" in r && r.error.startsWith("B 股"), symbol);
  }
  assert.ok("record" in tradeRecord(form({ type: "buy", symbol: "600900", shares: "100", price: "1" })), "600900 是沪市主板，不是 B 股");
  assert.ok("record" in tradeRecord(form({ type: "buy", symbol: "002000", shares: "100", price: "1" })));
  const ts = fs.readFileSync(new URL("../../orchestrator/src/finance/holdings.ts", import.meta.url), "utf8");
  const msg = /B_SHARE_UNSUPPORTED = "([^"]+)"/.exec(ts)?.[1];
  const r = tradeRecord(form({ type: "buy", symbol: "900901", shares: "100", price: "1" }));
  assert.equal("error" in r ? r.error : "", msg);
});
