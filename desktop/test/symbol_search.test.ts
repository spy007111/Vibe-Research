import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { normalizeMarketSymbol } from "../src/verticals/finance/lib/marketSymbol.ts";
import {
  BATCH_SEARCH_MAX, codeFallback, collectPicks, directCode, liveMatches, matchTag, offlineItems, parseBatch, parseSearch, planBatch,
  splitTokens, type BatchItem, type SymbolMatch,
} from "../src/verticals/finance/lib/symbolSearch.ts";

const src = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");

const M = (symbol: string, name: string, market: "CN" | "HK" | "US" = "CN", board = "沪A"): SymbolMatch =>
  ({ symbol, name, market, kind: "股票", board, pinyin: "" });
const item = (query: string, over: Partial<BatchItem> = {}): BatchItem =>
  ({ query, code: null, matches: [], pick: null, reason: "没找到", ...over });

test("parseSearch：只收规范代码和认得的市场，错误原样带出", () => {
  const r = parseSearch({ ok: true, result: { matches: [
    M("600519", "贵州茅台"), M("00700.HK", "腾讯控股", "HK", "港股"),
    { symbol: "700.HK", name: "写法不规范", market: "HK" },
    { symbol: "600000", name: "市场不认得", market: "JP" },
    "垃圾", null,
  ] } });
  assert.ok(r.ok);
  assert.deepEqual(r.matches.map((m) => m.symbol), ["600519", "00700.HK"]);
  assert.deepEqual(parseSearch({ ok: false, error: "名称搜索暂时不通（ConnectionError）" }), { ok: false, error: "名称搜索暂时不通（ConnectionError）" });
  assert.equal(parseSearch({ ok: true, result: {} }).ok, false);
  assert.equal(parseSearch(null).ok, false);
});

test("parseBatch：pick 不规范就当没选", () => {
  const r = parseBatch({ ok: true, result: { items: [
    { query: "茅台", code: null, matches: [M("600519", "贵州茅台")], pick: M("600519", "贵州茅台"), reason: "名称一致" },
    { query: "x", code: "X", matches: [], pick: { symbol: "x", name: "", market: "US" }, reason: "?" },
    7,
  ] } });
  assert.ok(r.ok);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0]!.pick?.symbol, "600519");
  assert.equal(r.items[1]!.pick, null);
  assert.equal(r.items[1]!.code, "X");
  assert.equal(parseBatch({ ok: false, error: "一次最多查 30 个名称" }).ok, false);
});

test("splitTokens：分隔符与旧的批量添加一致，并去重", () => {
  assert.deepEqual(splitTokens(" 600519，茅台、AAPL;腾讯；600519\n gzmt\t"), ["600519", "茅台", "AAPL", "腾讯", "gzmt"]);
  assert.deepEqual(splitTokens("   "), []);
});

test("directCode：数字 / 前后缀 / 带股份类别的直接认；纯字母、中文、北交所老代码要搜", () => {
  const cases: [string, string | null][] = [
    ["600519", "600519"], ["sh600519", "600519"], ["00700.HK", "00700.HK"], ["700", "00700.HK"], ["hk700", "00700.HK"],
    ["us:aapl", "AAPL"], ["usAAPL", "AAPL"], ["BRK.B", "BRK.B"], ["brk-b", "BRK.B"], ["920047", "920047"],
    ["AAPL", null], ["gzmt", null], ["茅台", null], ["腾讯控股", null],
    ["430047", null], ["bj430047", null], ["830799.BJ", null], ["872925", null],
    ["1234567", null],
  ];
  for (const [t, want] of cases) assert.equal(directCode(t), want, t);
});

test("代码规范化与 Python 的 normalize_code 同一张表", () => {
  // 直接读 Python 测试里的 NORMALIZE 表：哪边加了样例，另一边也要过
  const py = readFileSync(new URL("../../backtest/tests/test_symbol_search.py", import.meta.url), "utf8");
  const block = py.slice(py.indexOf("NORMALIZE = ["), py.indexOf("]\n", py.indexOf("NORMALIZE = [")));
  const rows = [...block.matchAll(/\("([^"]*)", (?:"([^"]*)"|None)\)/g)].map((m) => [m[1]!, m[2] ?? null] as const);
  assert.ok(rows.length >= 18, `只读到 ${rows.length} 条`);
  for (const [text, want] of rows) assert.equal(normalizeMarketSymbol(text), want, text);
});

test("planBatch：代码本地加、其余去搜、超出 30 个退回、太长的跳过", () => {
  const p = planBatch("600519 茅台 AAPL 600519 sh600519 430047 " + "很".repeat(31));
  assert.deepEqual(p.direct, ["600519"]);
  assert.deepEqual(p.search, ["茅台", "AAPL", "430047"]);
  assert.deepEqual(p.skipped, ["很".repeat(31)]);
  assert.deepEqual(p.rest, []);

  const many = Array.from({ length: BATCH_SEARCH_MAX + 3 }, (_, i) => `名${i}`);
  const q = planBatch(many.join(","));
  assert.equal(q.search.length, BATCH_SEARCH_MAX);
  assert.deepEqual(q.rest, many.slice(BATCH_SEARCH_MAX));
});

test("collectPicks：选中的并入、交代换号和原样使用、其余待点选", () => {
  const items = [
    item("茅台", { matches: [M("600519", "贵州茅台")], pick: M("600519", "贵州茅台"), reason: "名称一致" }),
    item("AAPL", { code: "AAPL", matches: [M("AAPL", "苹果", "US", "美股")], pick: M("AAPL", "苹果", "US", "美股"), reason: "代码一致" }),
    item("430047", { code: "430047", matches: [M("920047", "诺思兰德", "CN", "京A")], pick: M("920047", "诺思兰德", "CN", "京A"), reason: "代码已变更：430047 → 920047" }),
    item("BRK.B", { code: "BRK.B", pick: M("BRK.B", "", "US", ""), reason: "搜索里没有，按代码原样使用，请核对" }),
    item("中国平安", { matches: [M("601318", "中国平安"), M("02318.HK", "中国平安", "HK", "港股")], reason: "名称一致的有 2 个，请选一个" }),
    item("gzmt2", { code: "GZMT2", reason: "没找到" }),
  ];
  const r = collectPicks(["600519", "00700.HK"], items);
  assert.deepEqual(r.picks, ["600519", "00700.HK", "AAPL", "920047", "BRK.B"]);
  // 输入本身就是规范代码的（AAPL / BRK.B）不再重复列出
  assert.deepEqual(r.notes, ["茅台 → 贵州茅台 600519", "430047 → 诺思兰德 920047（代码已变更）"]);
  assert.deepEqual(r.pending.map((p) => p.query), ["中国平安", "gzmt2"]);
});

test("按代码加只在一个候选都没搜到时给，避免把拼音当美股代码", () => {
  assert.equal(codeFallback(item("zzzqqq", { code: "ZZZQQQ" })), "ZZZQQQ");
  assert.equal(codeFallback(item("ndsd", { code: "NDSD", matches: [M("300750", "宁德时代", "CN", "创业板")] })), null);
  assert.equal(codeFallback(item("茅台")), null);
  const off = offlineItems(["AAPL", "茅台", "430047"], "名称搜索不通");
  assert.deepEqual(off.map(codeFallback), ["AAPL", null, "430047"]);
  assert.ok(off.every((o) => o.reason === "名称搜索不通" && o.pick === null));
});

test("候选标签：A 股写板块、场内基金单列、港美股写市场", () => {
  assert.equal(matchTag(M("688981", "中芯国际", "CN", "科创板")), "科创板");
  assert.equal(matchTag(M("510300", "沪深300ETF", "CN", "基金")), "场内基金");
  assert.equal(matchTag(M("00700.HK", "腾讯控股", "HK", "港股")), "港股");
  assert.equal(matchTag(M("AAPL", "苹果", "US", "美股")), "美股");
});

test("输入代码的页面都接上了同一个搜索框", () => {
  const research = src("pages/Research.tsx");
  const debate = src("pages/Debate.tsx");
  const portfolio = src("pages/Portfolio.tsx");
  const watch = src("pages/Watchlist.tsx");
  assert.match(research, /<SymbolSearch[\s\S]*?value=\{symbol\}/);
  assert.equal((research.match(/<SymbolSearch/g) ?? []).length, 1, "个股深挖只在页头选一次股票，两个分页共用");
  assert.match(research, /onEnter=\{\(\) => choose\(symbol\)\}/, "回车 = 看这只（规范代码），不开始研究");
  // 港美股:查不到公司名不开跑;手敲的字母代码先报公司名、再按一次才开始(md / ba 这类拼音也是真实美股代码)
  const gate = research.slice(research.indexOf("const start = async"), research.indexOf("backend.startResearch("));
  assert.match(gate, /if \(market !== "CN"\) \{[\s\S]*?if \(!name\) \{ setErr\([\s\S]*?return; \}/);
  assert.match(gate, /if \(pickedCode\.current !== code && pending\?\.code !== code\) \{[\s\S]*?setConfirm\([\s\S]*?return;/);
  assert.match(research, /onPick=\{\(m\) => \{ pickedCode\.current = normalizeMarketSymbol\(m\.symbol\); choose\(m\.symbol\); \}\}/);
  assert.match(research, /onChange=\{\(v\) => \{ setSymbol\(v\); setConfirm\(null\); \}\}/, "改了代码,上一次的确认作废");
  // 多空辩论 10-09 起是研究工具下单独一页：页面上一个只认 A 股的搜索框（跑的途中锁住），
  // 辩论本体不带搜索框、股票由页面传进来；只支持 A 股，港美股给去处而不是点了才报错
  const debatePage = debate.slice(debate.indexOf("export function DebatePage"), debate.indexOf("export function Debate("));
  assert.equal((debatePage.match(/<SymbolSearch/g) ?? []).length, 1);
  const debateBox = debatePage.slice(debatePage.indexOf("<SymbolSearch"), debatePage.indexOf("/>", debatePage.indexOf("<SymbolSearch")));
  assert.match(debateBox, /markets=\{\["CN"\]\}/);
  assert.match(debateBox, /disabled=\{busy\}/, "辩论跑的途中不让换股票");
  assert.doesNotMatch(debate.slice(debate.indexOf("export function Debate(")), /<SymbolSearch/);
  assert.match(debate, /const code = normalizeMarketSymbol\(symbol\) \?\? "";/, "sh600519 这类写法也能开始辩论");
  assert.match(debate, /if \(!\/\^\\d\{6\}\$\/\.test\(c\)\) \{ setError\(/, "开始前仍按 A 股 6 位代码把关");
  assert.match(debate, /<button onClick=\{start\} disabled=\{!canStart\}/);
  assert.match(debate, /多空辩论目前只支持 A 股。\{code\} 是/);
  assert.match(debate, /setRunCode\(c\);/, "跑到一半换股票，显示的仍是开始时那只");
  assert.doesNotMatch(research, /<Debate\b/, "个股深挖不再内嵌辩论");
  assert.match(research, /<Link to=\{`\/debate\?symbol=\$\{encodeURIComponent\(chartSymbol\)\}`\}/, "页头按钮带着这只去多空辩论");
  assert.match(research, /if \(tabParam === "debate"\) \{[\s\S]*?q\.delete\("tab"\);[\s\S]*?<Navigate replace to=\{`\/debate/, "旧的 ?tab=debate 带着原参数跳到多空辩论页");
  assert.equal((portfolio.match(/<SymbolSearch/g) ?? []).length, 1, "买卖、分红、送转都在「记一笔」一处录");
  assert.match(portfolio, /onPick=\{\(m\) => \{ if \(!form\.name\.trim\(\)\) set\(\{ name: m\.name \}\); \}\}/);
  assert.match(watch, /runTool<unknown>\("search", \{ queries: plan\.search \}/);
  assert.match(watch, /offlineItems\(plan\.search/, "搜索不通时退回只认代码，并把其余词交给用户");
  assert.doesNotMatch(watch, /addCodes/, "旧的「纯字母一律当美股代码」不再用于自选批量添加");
  const review = src("pages/DailyReview.tsx");
  assert.doesNotMatch(review, /<SymbolSearch|addWatch|loadWatch/, "每日复盘只看市场;自选在首页看盘,不在这里重复一份");
  assert.doesNotMatch(src("lib/watchlist.ts"), /addCodes|parseCodes/);
  const box = src("components/SymbolSearch.tsx");
  assert.match(box, /runTool<unknown>\("search", \{ query: q \}/);
  assert.match(box, /isComposing/, "中文输入法选字时的回车不算");
  assert.doesNotMatch(box, /bg-popover/, "没有 popover 这个颜色");
  assert.match(box, /createPortal\(/, "下拉挂到 body 上：卡片带毛玻璃各自成层，留在卡片里会被后面的卡片盖住");
  assert.doesNotMatch(box, /absolute left-0 top-full/);
});

test("个股页换股票：上一只的报错、已结束的研究、跑完的辩论不挂在新股票名下；打开报告途中换股票以人选的为准", () => {
  const research = src("pages/Research.tsx");
  const debate = src("pages/Debate.tsx");
  const eff = research.slice(research.indexOf("useEffect(() => {\n    pickSeq.current += 1;"));
  const body = eff.slice(0, eff.indexOf("}, [chartSymbol]);"));
  assert.ok(body.length > 0, "找不到换股票时的清理");
  assert.match(body, /setErr\(""\);/, "上一只的报错不留到这一只");
  assert.match(body, /if \(active\?\.finished_at != null && activeCode !== chartSymbol\) setActive\(null\);/, "上一只已结束的研究收起来，还在跑的留着");
  assert.match(research, /setActiveCode\(code\);\n      watch\(r\.run_id\);/, "开始研究时记下是哪只");
  assert.match(research, /if \(st\) \{ setActive\(st\); setActiveCode\(c\);/, "打开归档时记下是哪只");
  assert.match(research, /researchBusy && activeCode !== chartSymbol && \([\s\S]{0,120}下面还在跑的是/, "别的股票的研究在跑时说明开始为什么是灰的");
  assert.match(research, /\+ \(active && activeCode === chartSymbol\n      \? `当前研究运行/, "AI 只把正在看的这只的研究当成「当前研究」");
  // 打开归档报告：两次请求回来都要核对人有没有换股票，报告等两次都回来才显示
  const open = research.slice(research.indexOf("const openReport = async"), research.indexOf("useAiPage({"));
  assert.match(open, /const stale = \(\) => wantRun\.current !== id \|\| generation !== watchGeneration\.current \|\| pick !== pickSeq\.current;/);
  assert.equal((open.match(/if \(stale\(\)\) return;/g) ?? []).length, 2);
  assert.ok(open.indexOf("setReport(r)") > open.lastIndexOf("if (stale()) return;"), "报告在最后一次核对之后才显示");
  assert.match(research.slice(research.indexOf("const choose = (raw: string) =>")), /^[\s\S]*?if \(c !== chartSymbol\) \{ pickSeq\.current \+= 1;/);
  // 辩论：跑完以后结果还是上一只的，也要说清楚
  assert.match(debate, /\{runCode && runCode !== code && \(/);
  assert.match(debate, /下面是 \$\{runCode\} 的辩论结果，不是/);
  assert.equal((debate.match(/<Disclaimer/g) ?? []).length, 1, "免责声明由多空辩论页给一次");
  assert.doesNotMatch(debate.slice(debate.indexOf("export function Debate(")), /<Disclaimer/, "辩论本体不再自带一份");
});

test("候选只认当前输入：改了词还没搜回来时，回车不能选中上一个词的结果", () => {
  const r = { query: "茅台", matches: [M("600519", "贵州茅台")] };
  assert.deepEqual(liveMatches(r, " 茅台 ").map((m) => m.symbol), ["600519"]);
  assert.deepEqual(liveMatches({ query: "gzmt", matches: [M("600519", "贵州茅台")] }, "GZMT").length, 1, "大小写不算换词");
  assert.deepEqual(liveMatches(r, "000858"), []);
  assert.deepEqual(liveMatches(r, "茅"), []);
  assert.deepEqual(liveMatches(null, "茅台"), []);
  const c = src("components/SymbolSearch.tsx");
  assert.match(c, /const matches = liveMatches\(result, value\);/, "回车和下拉用的必须是按词对号后的候选");
  assert.doesNotMatch(c, /setMatches\(/);
});
