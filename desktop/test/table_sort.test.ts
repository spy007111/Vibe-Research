import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyOrder, currencyRank, loadOrder, loadSort, moveInOrder, nextSort, saveOrder, saveSort, sortRows, visibleOrder, visibleSort, type SortValue,
} from "../src/verticals/finance/lib/tableSort.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");

interface Row { code: string; cur: string; v: SortValue }
const rows: Row[] = [
  { code: "a", cur: "USD", v: 5 },
  { code: "b", cur: "CNY", v: null },
  { code: "c", cur: "CNY", v: 30 },
  { code: "d", cur: "HKD", v: 30 },
  { code: "e", cur: "CNY", v: Number.NaN },
  { code: "f", cur: "USD", v: -2 },
];
const val = (r: Row) => r.v;
const codes = (xs: Row[]) => xs.map((r) => r.code).join("");

test("点表头：第一下按给的方向，第二下反过来，第三下恢复；换一列从头来", () => {
  assert.deepEqual(nextSort(null, "pnl"), { key: "pnl", dir: "desc" });
  assert.deepEqual(nextSort({ key: "pnl", dir: "desc" }, "pnl"), { key: "pnl", dir: "asc" });
  assert.equal(nextSort({ key: "pnl", dir: "asc" }, "pnl"), null);
  assert.deepEqual(nextSort(null, "name", "asc"), { key: "name", dir: "asc" });
  assert.deepEqual(nextSort({ key: "name", dir: "asc" }, "name", "asc"), { key: "name", dir: "desc" });
  assert.equal(nextSort({ key: "name", dir: "desc" }, "name", "asc"), null);
  assert.deepEqual(nextSort({ key: "pnl", dir: "asc" }, "name", "asc"), { key: "name", dir: "asc" });
});

test("排序：取不到的（null、NaN、空串）不论升降都排最后；值一样的保持原先后；不排就原样", () => {
  assert.equal(codes(sortRows(rows, { key: "v", dir: "desc" }, val)), "cdafbe");
  assert.equal(codes(sortRows(rows, { key: "v", dir: "asc" }, val)), "facdbe");
  assert.equal(codes(sortRows(rows, null, val)), "abcdef");
  const blank: Row[] = [{ code: "x", cur: "CNY", v: "" }, { code: "y", cur: "CNY", v: "乙" }, { code: "z", cur: "CNY", v: "甲" }];
  assert.equal(codes(sortRows(blank, { key: "v", dir: "asc" }, val)), "zyx", "文字按拼音比，空串在最后");
  assert.equal(codes(sortRows(blank, { key: "v", dir: "desc" }, val)), "yzx");
  // 不改原数组
  assert.equal(codes(rows), "abcdef");
});

test("金额列先按币种分块（人民币、港元、美元），块内再排；不分块的列不受币种影响", () => {
  const group = (r: Row) => currencyRank(r.cur);
  assert.equal(codes(sortRows(rows, { key: "v", dir: "desc" }, val, group)), "cbedaf");
  assert.equal(codes(sortRows(rows, { key: "v", dir: "asc" }, val, group)), "cbedfa", "升序时币种块的先后不跟着反");
  assert.equal(codes(sortRows(rows, { key: "v", dir: "desc" }, val, () => null)), "cdafbe");
  assert.equal(currencyRank("CNY"), 0);
  assert.equal(currencyRank("HKD"), 1);
  assert.equal(currencyRank("USD"), 2);
  assert.equal(currencyRank(null), 3);
  assert.equal(currencyRank("EUR"), 3);
});

test("自己排的先后：按记下的排，没记过的（新买的）按原先后跟在最后；挪到头不动", () => {
  const order = ["d", "a", "zz"];
  assert.equal(codes(applyOrder(rows, order, (r) => r.code)), "dabcef");
  assert.equal(codes(applyOrder(rows, [], (r) => r.code)), "abcdef");
  assert.deepEqual(moveInOrder(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveInOrder(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.deepEqual(moveInOrder(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveInOrder(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.deepEqual(moveInOrder(["a", "b", "c"], "q", 1), ["a", "b", "c"]);
});

test("隐私模式：记着的排序是被遮的列就先不用（不删），别的列照常；关掉隐私模式又回来", () => {
  const masked = (k: string) => k === "market_value";
  const s = { key: "market_value", dir: "desc" } as const;
  assert.equal(visibleSort(s, true, masked), null);
  assert.equal(visibleSort(s, false, masked), s);
  const pct = { key: "pnl_pct", dir: "asc" } as const;
  assert.equal(visibleSort(pct, true, masked), pct);
  assert.equal(visibleSort(null, true, masked), null);
});

test("隐私模式：按金额排完转存的手动顺序也先不用（不删），在它上面再挪仍算从金额来（第四轮审计 C4）", () => {
  const byAmount = ["c", "a", "b"];
  assert.deepEqual(visibleOrder(byAmount, true, true), { order: [], masked: false }, "隐私模式下回到默认先后");
  assert.deepEqual(visibleOrder(byAmount, true, false), { order: byAmount, masked: true }, "关掉隐私模式又回来，挪动后仍记作从金额来");
  assert.deepEqual(visibleOrder(byAmount, false, true), { order: byAmount, masked: false }, "自己排的先后隐私模式下照用");
  for (const [file, conv, mv] of [
    ["components/HomeDashboard.tsx", /saved\.setOrder\(shownCodes, HOLD_MASKED\.includes\(sort\.key\) \|\| orderMasked\)/, /saved\.move\(shownCodes, r\.code, d, orderMasked\)/],
    ["pages/Portfolio.tsx", /savedHoldOrder\.setOrder\(shownHoldCodes, !!HOLD_COLS\.find\(\(c\) => c\.key === holdSort\.key\)\?\.masked \|\| holdOrderMasked\)/, /savedHoldOrder\.move\(shownHoldCodes, h\.code, d, holdOrderMasked\)/],
  ] as const) {
    const src = read(file);
    assert.match(src, /visibleOrder\(saved(?:HoldOrder)?\.order, saved(?:HoldOrder)?\.masked, hide\)/, `${file} 先过 visibleOrder 再排`);
    assert.match(src, conv, `${file} 转存时记下是否从被遮的列来`);
    assert.match(src, mv, `${file} 挪动时带上标记`);
  }
});

test("记在本机：读回时列名不认识、方向不对、格式坏了都当没排；存不了也不报错", () => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  });
  try {
    const keys = ["name", "pnl"];
    saveSort("t-sort", { key: "pnl", dir: "asc" });
    assert.deepEqual(loadSort("t-sort", keys), { key: "pnl", dir: "asc" });
    assert.equal(loadSort("t-sort", ["name"]), null, "改过表头、那一列没了");
    for (const bad of ['{"key":"pnl","dir":"up"}', '["pnl","asc"]', "{坏", "null", '{"key":3,"dir":"asc"}']) {
      mem.set("t-sort", bad);
      assert.equal(loadSort("t-sort", keys), null, bad);
    }
    saveSort("t-sort", null);
    assert.equal(loadSort("t-sort", keys), null);
    saveOrder("t-order", ["b", "a"]);
    assert.deepEqual(loadOrder("t-order"), ["b", "a"]);
    mem.set("t-order", '["a",3,null,"c"]');
    assert.deepEqual(loadOrder("t-order"), ["a", "c"]);
    mem.set("t-order", "{坏");
    assert.deepEqual(loadOrder("t-order"), []);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    assert.equal(loadSort("t-sort", keys), null);
    assert.deepEqual(loadOrder("t-order"), []);
    assert.doesNotThrow(() => { saveSort("t-sort", { key: "pnl", dir: "asc" }); saveOrder("t-order", ["a"]); });
  } finally {
    if (prev) Object.defineProperty(globalThis, "localStorage", prev);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("页面接线：首页持仓合计是对齐的表格；首页和持仓页能排序、能自己排先后（共用一份）；自选整行点选、下面接 K 线", () => {
  const home = read("components/HomeDashboard.tsx");
  const totals = home.slice(home.indexOf('aria-label="持仓合计'), home.indexOf("</table>", home.indexOf('aria-label="持仓合计')));
  for (const h of ["币种", "市值", "持仓盈亏", "收益率", "当日盈亏", "当日涨跌"]) assert.ok(totals.includes(`>${h}</th>`), `合计表缺「${h}」列`);
  assert.match(totals, /colSpan=\{6\}/, "没取到现价这类说明单独占一行，不挤乱各列");
  assert.match(totals, /\{p\(money\(t\.market_value\)\)\}/, "合计金额照样经过隐私模式");
  assert.match(totals, /\{p\(signedMoney\(t\.pnl\)\)\}/);
  assert.match(totals, /\{p\(signedMoney\(t\.day_pnl\)\)\}/);
  assert.match(home, /const NUM = "whitespace-nowrap text-right font-mono tabular-nums";/, "数字列右对齐、等宽数字");
  assert.match(home, /sortRows\(applyOrder\(rows, order, \(r\) => r\.code\), sort, holdValue, holdGroup\)/, "先按自己排的先后，再按表头排");
  assert.match(home, /k === "market_value" \|\| k === "day_pnl" \? currencyRank\(r\.currency\) : null/, "只有金额的列不跨币种比");
  assert.match(home, /\{shown\.map\(\(r, i\) =>/);

  const port = read("pages/Portfolio.tsx");
  assert.match(port, /sortRows\(applyOrder\(holdings, holdOrder, \(h\) => h\.code\), holdSort, holdValue, holdGroup\)/);
  assert.match(port, /\{shownHoldings\.map\(\(h, i\) =>/);
  for (const k of ["price", "cost", "market_value", "pnl", "realized_pnl", "dividends"]) {
    assert.match(port, new RegExp(`key: "${k}", label: "[^"]+", right: true, byCurrency: true`), `${k} 要按币种分块`);
  }
  assert.match(port, /key: "shares", label: "[^"]+", right: true, masked: true, value/, "数量直接比");
  assert.match(port, /key: "pnl_pct", label: "[^"]+", right: true, value/, "盈亏% 直接比");
  // 隐私模式下被遮的列不给排序：数量和金额类遮住；现价是公开行情、盈亏% 推不出本金，照常排
  for (const k of ["shares", "cost", "market_value", "pnl", "realized_pnl", "dividends"]) {
    assert.match(port, new RegExp(`key: "${k}", [^\n]*masked: true`), `${k} 隐私模式下要遮`);
  }
  for (const k of ["name", "price", "pnl_pct"]) assert.doesNotMatch(port, new RegExp(`key: "${k}", [^\n]*masked: true`), `${k} 不用遮`);
  assert.match(port, /const holdSort = visibleSort\(savedHoldSort, hide, \(k\) => !!HOLD_COLS\.find\(\(c\) => c\.key === k\)\?\.masked\);/);
  assert.match(port, /disabled=\{reorder \|\| \(hide && !!c\.masked\)\} disabledTitle=\{hide && c\.masked \? PRIVATE_SORT_TITLE : undefined\}/);
  assert.match(port, /\{\(reorder \|\| holdings\.length > 1\) && <ReorderToggle/, "调整中卖到只剩一只也留着「完成」");
  assert.match(port, /pnlColor\(h\.realized_pnl\)\)\}>\{p\(signed\(h\.realized_pnl\)\)\}<\/td>/, "已实现 0 就显示 0，和排序当 0 一致");
  assert.match(port, /\{p\(fmt\(h\.dividends\)\)\}<\/td>/);

  assert.match(home, /const HOLD_MASKED: readonly string\[\] = \["market_value", "day_pnl"\];/);
  assert.match(home, /const sort = visibleSort\(savedSort, hide, \(k\) => HOLD_MASKED\.includes\(k\)\);/);
  assert.equal(home.match(/disabled=\{reorder \|\| hide\} disabledTitle=\{hide \? PRIVATE_SORT_TITLE : undefined\}/g)?.length, 2, "首页市值、当日盈亏两列隐私模式下不给排序");
  assert.match(home, /\{reorder \|\| rows\.length > 1 \? <ReorderToggle/);

  for (const page of [home, port]) {
    assert.match(page, /useRowOrder\(HOLDINGS_ORDER_KEY\)/, "首页和持仓页共用一份先后");
    assert.match(page, /<ReorderToggle on=\{reorder\} onToggle=\{toggleReorder\} \/>/);
    assert.match(page, /if \(!reorder && saved\w+\) \{ if \(\w+\) [\w.]+\(\w+, [^;]+\); \w+\(null\); \}/,
      "排着序点「调整顺序」，从眼前的先后开始挪；隐私模式下暂时没用的那份排序也清掉");
    assert.match(page, /disabled[=:] ?\{?reorder/, "调整顺序时表头不排序");
  }

  const wl = read("pages/Watchlist.tsx");
  assert.match(wl, /useTableSort\("vr-sort-watchlist", WATCH_KEYS\)/);
  assert.match(wl, /key: "price", label: "现价", right: true, byCurrency: true/, "现价不跨币种比");
  assert.match(wl, /currencyRank\(quotes\[c\]\?\.currency \?\? currencyOfSymbol\(c\)\)/, "行情没回来也按代码认币种");
  assert.match(wl, /\{shown\.map\(\(c\) =>/);
  assert.match(wl, /onClick=\{\(\) => setPicked\(c\)\}/, "整行可点");
  assert.match(wl, /<tr key=\{c\} aria-current=\{sel \? "true" : undefined\}/, "读屏能知道选中的是哪行");
  assert.match(wl, /<button type="button" aria-pressed=\{sel\} onClick=\{\(e\) => \{ e\.stopPropagation\(\); setPicked\(c\); \}\}/,
    "名称是真按钮：键盘、读屏都能选");
  assert.doesNotMatch(wl, /<tr[^>]*tabIndex/, "行本身不再进 Tab 顺序（里面的按钮会被读屏念两遍）");
  assert.match(wl, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); remove\(c\); \}\}/, "点移除不顺带换 K 线");
  assert.match(wl, /const quotesSettled = settled !== null;/, "完整取过一次行情（成功失败都算）才定住");
  assert.match(wl, /const current = picked && codes\.includes\(picked\) \? picked : quotesSettled \|\| !sort \? shown\[0\] \?\? null : null;/,
    "默认第一行；选中的被移除了回到第一行；按行情排着时行情回来之前先不画");
  assert.ok(wl.indexOf("<KlineCard") > wl.indexOf("自选总览") && wl.indexOf("<KlineCard") < wl.indexOf("<AbnormalCard"), "K 线在自选总览下面");
  assert.match(wl, /<KlineCard symbol=\{normalizeMarketSymbol\(current\) \?\? current\}/);

  const card = read("components/KlineCard.tsx");
  assert.match(card, /const res = got\?\.symbol === symbol \? got\.res : null;/, "换股票时上一只的图一帧都不显示");
  assert.equal(card.match(/setGot\(\{ symbol, res: /g)?.length, 2, "成功、失败都连同代码一起记");
  assert.doesNotMatch(card, /setRes\(/);
  assert.match(read("components/ui/SortTh.tsx"), /onClick=\{\(e\) => \{ e\.stopPropagation\(\); onMove\(-1\); \}\}/, "上移下移不冒泡成点整行");
});
