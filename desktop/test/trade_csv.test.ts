import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { api } from "../src/verticals/finance/lib/api.ts";
import { backend, type FetchResult } from "../src/verticals/finance/lib/backend.ts";
import { emptyTradeForm, tradeRecord, type HoldingsView } from "../src/verticals/finance/lib/holdings.ts";
import { CSV_MAX_ROWS, TRADE_CSV_TEMPLATE, decodeTableFile, normalizeDate, parseTradeCsv, splitTable } from "../src/verticals/finance/lib/tradeCsv.ts";

const ok = (text: string) => {
  const r = parseTradeCsv(text);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r;
};
const fail = (text: string) => {
  const r = parseTradeCsv(text);
  assert.ok(!r.ok, "应当整体报错");
  return r.error;
};

test("表格导入:券商导出的列名、类型、日期、千分位都认;结果与手动记一笔同一套检查;报原文行号和没用上的列", () => {
  const csv = "﻿成交日期,业务名称,证券代码,证券名称,成交数量,成交价格(元),手续费,成交金额,股东代码\r\n"
    + "2025/1/2,证券买入,600519,贵州茅台,\"1,000\",1500.5,5,\"1,500,500\",A123\r\n"
    + "\r\n"
    + "20250103,证券卖出,600519,贵州茅台,200,1600,3,,A123\r\n"
    + "2025-01-04 09:30:00,红利入账,600519,贵州茅台,,,,,A123\r\n";
  const r = ok(csv);
  assert.equal(r.delimiter, ",");
  assert.deepEqual(r.unused, ["成交金额", "股东代码"]);
  assert.deepEqual(r.rows.map((x) => x.line), [2, 4, 5], "行号按原文算(含表头、空行)");
  assert.deepEqual(r.rows[0]!.record, { symbol: "600519", type: "buy", date: "2025-01-02", shares: 1000, price: 1500.5, fee: 5, name: "贵州茅台" });
  // 与手动记一笔同一套检查:结果和 tradeRecord 一字不差
  const same = tradeRecord({ ...emptyTradeForm("sell"), symbol: "600519", name: "贵州茅台", date: "2025-01-03", shares: "200", price: "1600", fee: "3" });
  assert.ok("record" in same);
  assert.deepEqual(r.rows[1]!.record, same.record);
  // 分红要的是到账金额:这份表没有「金额」列(成交金额是买卖的总额,不当分红金额),照实报缺
  assert.equal(r.rows[2]!.record, null);
  assert.match(r.rows[2]!.error!, /到账金额/);
});

test("表格导入:从表格软件复制来的制表符分隔也认;引号里的逗号、换行、两个引号都按原样", () => {
  const tsv = "日期\t类型\t代码\t数量\t价格\t备注\n2025-02-03\t买入\t00700.HK\t200\t380\t第一笔\n2025-02-04\t买\tsh600000\t100\t8\t";
  const r = ok(tsv);
  assert.equal(r.delimiter, "\t");
  assert.deepEqual(r.rows.map((x) => x.record?.symbol), ["00700.HK", "600000"]);
  const q = ok('日期,类型,代码,数量,价格,备注\n2025-02-03,买入,AAPL,10,200,"他说:""先看财报"",再说,\n第二行"\n2025-02-05,卖出,AAPL,5,210,');
  assert.equal(q.rows[0]!.record!.note, '他说:"先看财报",再说,\n第二行');
  assert.deepEqual(q.rows.map((x) => x.line), [2, 4], "引号里的换行不算新的一行,但后面的行号照原文");
  assert.deepEqual(splitTable('a,"b,c"\n', ","), [{ line: 1, cells: ["a", "b,c"] }]);
});

test("🔴 表格导入:1–5 位纯数字代码一律拒(表格软件把开头的 0 吃掉了,分不清 A 股还是港股);写全的照常认", () => {
  const r = ok("日期,类型,代码,数量,价格\n2025-01-02,买入,1,100,10\n2025-01-02,买入,700,100,10\n2025-01-02,买入,00700,100,10\n2025-01-02,买入,000001,100,10\n2025-01-02,买入,700.HK,100,10\n2025-01-02,买入,600519.SH,100,10");
  for (const row of r.rows.slice(0, 3)) {
    assert.equal(row.record, null, row.cells.symbol);
    assert.match(row.error!, /表格软件常把开头的 0 去掉.*写满 6 位.*00700\.HK/);
  }
  assert.deepEqual(r.rows.slice(3).map((x) => x.record?.symbol), ["000001", "00700.HK", "600519"]);
});

test("表格导入:类型认不出、数字不对、负数都逐行报原因(负数不取绝对值);日期各种写法", () => {
  const r = ok("日期,类型,代码,数量,价格,费用\n2025-01-02,转入,600519,100,10,\n2025-01-02,卖出,600519,-100,10,\n2025-01-02,买入,600519,100,十元,\n2025-02-30,买入,600519,100,10,\n2025-01-02,买入,600519,100,10,-1");
  assert.match(r.rows[0]!.error!, /类型「转入」不认识/);
  assert.match(r.rows[1]!.error!, /卖出数量要大于 0/);
  assert.match(r.rows[2]!.error!, /成交价要大于 0/);
  assert.match(r.rows[3]!.error!, /有效日期/);
  assert.match(r.rows[4]!.error!, /费用不能是负数/);
  assert.deepEqual(["2025/1/2", "2025.01.02", "20250102", "2025年1月2日", "2025-01-02T10:00:00", " 2025-1-2 "].map(normalizeDate), Array(6).fill("2025-01-02"));
  assert.equal(normalizeDate("1/2/2025"), "1/2/2025", "认不出的写法照原样交给检查(会报日期不对),不猜月日顺序");
});

test("表格导入:表头缺列、两列同名、超过上限整体报错;上限那一档能过;空内容报错", () => {
  assert.match(fail("代码,数量\n600519,100"), /至少要有「日期」「类型」这几列/);
  assert.match(fail("日期,类型,代码,成交价,价格\n2025-01-02,买入,600519,1,1"), /有两列都是「价格」:第 4 列和第 5 列/);
  const row = "\n2025-01-02,买入,600519,1,1";
  assert.match(fail(`日期,类型,代码,数量,价格${row.repeat(CSV_MAX_ROWS + 1)}`), /一次最多导入 1000 行,这份有 1001 行/);
  assert.equal(ok(`日期,类型,代码,数量,价格${row.repeat(CSV_MAX_ROWS)}`).rows.length, CSV_MAX_ROWS);
  assert.match(fail("  \n\n"), /没有内容/);
  assert.match(fail("﻿"), /没有内容/);
});

test("表格导入:模板每一行都能直接过检查(用户照着改不会先撞错)", () => {
  const r = ok(TRADE_CSV_TEMPLATE);
  assert.equal(r.rows.length, 6);
  assert.deepEqual(r.rows.map((x) => x.error), Array(6).fill(null));
  assert.deepEqual(r.rows.map((x) => x.record!.type), ["opening", "split", "buy", "buy", "sell", "dividend"]);
  assert.deepEqual(r.unused, []);
});

test("读文件:UTF-8(带不带 BOM)直接读;GBK 编码的中文 CSV 也读得出;Excel 工作簿说清楚要另存为 CSV", () => {
  const u = decodeTableFile(new TextEncoder().encode("﻿日期,类型\n"));
  assert.deepEqual(u, { text: "日期,类型\n" });
  // 「日期,类型,代码,数量,价格\n2025-01-02,买入,600519,100,10」的 GBK 字节
  const gbk = Uint8Array.from([0xc8, 0xd5, 0xc6, 0xda, 0x2c, 0xc0, 0xe0, 0xd0, 0xcd, 0x2c, 0xb4, 0xfa, 0xc2, 0xeb, 0x2c, 0xca, 0xfd, 0xc1, 0xbf, 0x2c, 0xbc, 0xdb, 0xb8, 0xf1, 0x0a,
    ...new TextEncoder().encode("2025-01-02,"), 0xc2, 0xf2, 0xc8, 0xeb, ...new TextEncoder().encode(",600519,100,10")]);
  const g = decodeTableFile(gbk);
  assert.ok("text" in g);
  assert.equal(g.text, "日期,类型,代码,数量,价格\n2025-01-02,买入,600519,100,10");
  assert.deepEqual(ok(g.text).rows[0]!.record, { symbol: "600519", type: "buy", date: "2025-01-02", shares: 100, price: 10 });
  const x = decodeTableFile(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
  assert.ok("error" in x && /另存为 CSV/.test(x.error));
});

test("导入走后端整批写入,带回新视图直接拼持仓数据(不再多读一次)", async () => {
  const view: HoldingsView = {
    method: "fifo", method_label: "先进先出", methods: [], holdings: [], closed: [], realized: [], dividends: [], issues: [], trades: [], legacy: [], migration_pending: 0, today: "2026-10-09",
  };
  const original = { imp: backend.holdingsImport, holdings: backend.holdings, fetch: backend.fetch, ledger: backend.ledger };
  const calls: unknown[] = [];
  backend.holdingsImport = async (rows, method) => { calls.push(["import", rows, method]); return { imported: { backup: "ledger/持仓导入备份-2026-10-09", imported: 2, ids: ["a", "b"] }, view }; };
  backend.holdings = async () => { calls.push(["holdings"]); return view; };
  backend.fetch = async (endpoint) => { throw new Error(`不该取 ${endpoint}`); };
  backend.ledger = async () => ({ records: {} }) as never;
  try {
    const rows = [{ symbol: "600519", type: "buy", date: "2025-01-02", shares: 1, price: 1 }];
    const r = await api.importTrades(rows, "fifo");
    assert.deepEqual(r.imported, { backup: "ledger/持仓导入备份-2026-10-09", imported: 2 });
    assert.equal(r.data.method, "fifo");
    assert.deepEqual(calls, [["import", rows, "fifo"]]);
  } finally { Object.assign(backend, { holdingsImport: original.imp, holdings: original.holdings, fetch: original.fetch as (e: string) => Promise<FetchResult>, ledger: original.ledger }); }
});

test("界面:导入面板挂在「记一笔」下面;本机解析不走 AI;数字列、检查结果、输入框在隐私模式下都遮", () => {
  const page = fs.readFileSync(new URL("../src/verticals/finance/pages/Portfolio.tsx", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../src/verticals/finance/components/TradeCsvImport.tsx", import.meta.url), "utf8");
  const be = fs.readFileSync(new URL("../src/verticals/finance/lib/backend.ts", import.meta.url), "utf8");
  assert.ok(page.indexOf("<TradeCsvImport") > page.indexOf(">记一笔</h3>"), "放在记一笔下面");
  assert.ok(page.indexOf("<TradeCsvImport") < page.indexOf(">持仓明细</h3>"));
  assert.match(page, /<TradeCsvImport method=\{method\} hide=\{hide\}/);
  assert.match(page, /导入前的原文件备份在数据目录的 <span className="font-mono">\{imported\.backup\}<\/span>/);
  assert.match(ui, /\{r\.record \? p\(detailOf\(r\.record\)\) : ""\}/, "数字列遮");
  assert.match(ui, /\{show\(s\.text\)\}/, "检查结果里夹着的股数遮");
  assert.match(ui, /hide \? \(\{ WebkitTextSecurity: "disc" \}/, "输入框原文遮");
  assert.ok(!/importPositions|chat\(|\/agent/.test(ui), "不调 AI 转写");
  assert.match(be, /action: "import_preview", rows, selected/);
  assert.match(be, /action: "import", rows, method/);
  assert.match(ui, /x\.problem === null && x\.duplicate !== "existing"/, "默认不勾和已记重复的");
});

test("界面:导入会让已记流水变成算不了的要提前说;预览也查大小;导入失败重新预览、已写进去的取消勾选", () => {
  const ui = fs.readFileSync(new URL("../src/verticals/finance/components/TradeCsvImport.tsx", import.meta.url), "utf8");
  const be = fs.readFileSync(new URL("../src/verticals/finance/lib/backend.ts", import.meta.url), "utf8");
  assert.match(be, /preview: ImportPreviewRow\[\]; existing_issues\?: TradeIssue\[\]/);
  assert.match(ui, /setExistingIssues\(r\.existing_issues \?\? \[\]\)/);
  assert.match(ui, /已记的 \{existingIssues\.length\} 笔会不参与计算/);
  assert.match(ui, /：\{show\(x\.why\)\}<\/li>/, "原因里夹着的股数在隐私模式下遮");
  const check = ui.slice(ui.indexOf("const check = async"), ui.indexOf("const chosen ="));
  assert.ok(check.indexOf('tooBig({ action: "import_preview"') >= 0 && check.indexOf('tooBig({ action: "import_preview"') < check.indexOf("await ask("), "预览前先查大小");
  const importNow = ui.slice(ui.indexOf("const importNow = async"), ui.indexOf("const status ="));
  const caught = importNow.slice(importNow.indexOf("} catch (e) {"));
  assert.match(caught, /await ask\(selected, records, true\)/, "失败后安静地重新预览,不冲掉失败原因");
  assert.match(caught, /pv\[i\]\?\.duplicate === "existing" && was\?\.\[i\]\?\.duplicate !== "existing"/, "只取消这次新变成「已记」的,用户特意勾上的重复不动");
});

test("勾选刚变、新预览没回来时一笔都不导：只认和当前勾选对得上的预览（第四轮审计 C5）", async () => {
  const { withRenderer } = await import("./helpers/render.ts");
  await withRenderer(async (r) => {
    const { importableRows } = await r.load("/src/verticals/finance/components/TradeCsvImport.tsx");
    const buy = { line: 2, record: { type: "buy" }, error: null };
    const sell = { line: 3, record: { type: "sell" }, error: null };
    const ok = { problem: null, duplicate: null, skip_reason: null };
    const preview = [ok, ok];
    assert.deepEqual(importableRows([buy, sell], preview, "true,true", [true, true]), [buy, sell]);
    assert.deepEqual(importableRows([buy, sell], preview, "true,true", [false, true]), [], "取消了买入、按新勾选的预览还没回来：不能按旧预览导入卖出");
    assert.deepEqual(importableRows([buy, sell], preview, "false,true", [false, true]), [sell]);
    assert.deepEqual(importableRows([buy, sell], null, null, [true, true]), []);
  });
});
