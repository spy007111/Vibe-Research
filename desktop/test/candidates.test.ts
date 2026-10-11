import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import {
  STATE_META, VERDICT_TABS, candidateQuery, defaultForm, formError, parseStoredForm, rowsOfTab, type CandidateForm, type CandidateRow,
} from "../src/verticals/finance/lib/candidates.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const form = (patch: Partial<CandidateForm> = {}, ranges: Partial<CandidateForm["ranges"]> = {}): CandidateForm => {
  const f = defaultForm();
  return { ...f, excludeSt: false, ...patch, ranges: { ...f.ranges, ...ranges } };
};

test("查询串:空的不带,两头可只填一头,前后空格去掉", () => {
  assert.equal(candidateQuery(form({ universe: "hs300" }, { pe_ttm: { min: " 0 ", max: "15" }, pb: { min: "", max: "1.5" } })),
    "universe=hs300&pe_ttm_min=0&pe_ttm_max=15&pb_max=1.5");
  assert.equal(candidateQuery(form({ excludeSt: true, excludeHalted: true }), true), "universe=watch&exclude_st=1&exclude_halted=1&refresh=1");
});

test("提交前核对:至少一个条件、数字合法、下限不大于上限", () => {
  assert.equal(formError(form()), "至少设一个条件");
  assert.equal(formError(form({ excludeSt: true })), "");
  assert.equal(formError(form({}, { amount: { min: "1", max: "" } })), "");
  assert.equal(formError(form({}, { pb: { min: "2", max: "2" } })), "");
  assert.equal(formError(form({}, { pb: { min: "abc", max: "" } })), "市净率下限不是合法数字");
  assert.equal(formError(form({}, { pb: { min: "", max: "1e10" } })), "市净率上限不是合法数字");
  assert.equal(formError(form({}, { pe_ttm: { min: "20", max: "10" } })), "市盈率(TTM)的下限大于上限");
  assert.equal(formError(form({}, { pe_ttm: { min: "-5", max: "" } })), "");
});

test("本机记住的条件:坏数据退回默认,不认识的范围不用", () => {
  assert.deepEqual(parseStoredForm(null), defaultForm());
  assert.deepEqual(parseStoredForm("{bad"), defaultForm());
  assert.deepEqual(parseStoredForm(JSON.stringify({ universe: "nope", ranges: { pb: { min: 1, max: "2" } }, excludeSt: "yes" })),
    { ...defaultForm(), ranges: { ...defaultForm().ranges, pb: { min: "", max: "2" } } });
  const saved = form({ universe: "zz500", excludeHalted: true }, { turnover: { min: "1", max: "" } });
  assert.deepEqual(parseStoredForm(JSON.stringify(saved)), saved);
});

test("分组:先满足、再缺数据、最后不满足;状态不用红绿", () => {
  assert.deepEqual(VERDICT_TABS.map((t) => t.key), ["met", "missing", "unmet"]);
  const r = (symbol: string, verdict: CandidateRow["verdict"]): CandidateRow => ({ symbol, name: "", verdict, checks: [] });
  assert.deepEqual(rowsOfTab([r("1", "met"), r("2", "unmet"), r("3", "met")], "met").map((x) => x.symbol), ["1", "3"]);
  for (const m of Object.values(STATE_META)) assert.doesNotMatch(m.tone, /red-|green-|emerald-|rose-|destructive|success/);
});

test("前端调用:GET /view/candidates,查询串原样带上", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    urls.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await backend.candidates("universe=hs300&pb_max=1");
  } finally { globalThis.fetch = prev; }
  assert.deepEqual(urls, ["/api/view/candidates?universe=hs300&pb_max=1"]);
});

test("页面:不排名、不给建议、缺数据单独列出、条件只存在本机偏好里;导航和首页都有入口", () => {
  const src = read("pages/Candidates.tsx");
  assert.match(src, /只排除、不排名,不打分、不给买卖建议/);
  assert.match(src, /按代码排列,不排名/);
  assert.match(src, /不是选股结论/);
  assert.match(src, /没取到的不算「不满足」/);
  assert.match(src, /storageSet\(FORM_KEY/);
  assert.doesNotMatch(src, /localStorage|\.sort\(/);
  assert.doesNotMatch(src, /目标价|评级|买入|卖出|推荐|得分|排行/);
  assert.match(src, /to=\{`\/research\?symbol=\$\{encodeURIComponent\(r\.symbol\)\}`\}/);
  // 10-09 Simon：候选池放研究工具最后一个
  assert.match(read("lib/nav.ts"), /\{ to: "\/backtest", label: "回测", icon: "FlaskConical" \},\n    \{ to: "\/candidates", label: "候选池", icon: "ListFilter" \},\n  \] \}/);
  assert.match(src, /watch: \{ to: "\/my-stocks\?tab=watch", label: "自选股" \}, position: \{ to: "\/my-stocks\?tab=hold", label: "我的持仓" \}/);
  assert.match(read("lib/homeFeatures.ts"), /to: "\/candidates", title: "候选池"/);
});

test("个股页读 ?symbol=:选股只换正在看的那只、显示走势,不自动开始研究", () => {
  const src = read("pages/Research.tsx");
  assert.match(src, /const chartSymbol = normalizeMarketSymbol\(params\.get\("symbol"\)\) \?\? "";/, "正在看哪只只认地址里的 symbol");
  assert.match(src, /useEffect\(\(\) => \{ setSymbol\(chartSymbol\); \}, \[chartSymbol\]\);/, "搜索框跟着地址里的 symbol，没选股票时清空");
  const from = src.indexOf("const choose = (raw: string) =>");
  const choose = src.slice(from, src.indexOf("\n  };", from));
  assert.match(choose, /normalizeMarketSymbol\(raw\)/);
  assert.match(choose, /setQuery\(\{ symbol: c \}, false\)/);
  assert.doesNotMatch(choose, /start\(|startResearch/, "选股不开始研究");
  // start 这个名字只出现两次：定义一次、「开始」按钮里调用一次 —— 别处（effect、选股、打开报告）都不许碰它
  assert.deepEqual(src.match(/(?<![\w.$])start(?!\w)/g), ["start", "start"], "只有深度研究分页里的「开始」按钮会启动研究");
  assert.match(src, /onClick=\{\(\) => void start\(\)\}/);
  // 带进来的代码会触发一次名称搜索;没点输入框时结果不弹下拉
  const search = read("components/SymbolSearch.tsx");
  assert.equal((search.match(/setOpen\(focused\.current\)/g) ?? []).length, 2);
  assert.doesNotMatch(search, /setHi\(0\); setOpen\(true\)/);
});
