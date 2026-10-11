import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import { TIER_PROMPT_RULES, prevText, stockText, tiersSummary, type ReviewTiersResult, type TierGroup, type TierStock } from "../src/verticals/finance/lib/reviewTiers.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const s = (symbol: string, name: string, boards: number | null = 1, tags: string[] = []): TierStock => ({ symbol, name, industry: "", boards, tags });
const g = (industry: string, tier: TierGroup["tier"], stocks: TierStock[], prev: [number | null, number | null], extra: Partial<TierGroup> = {}): TierGroup =>
  ({ industry, tier, today: stocks.length, prev, stocks, tags: [], note: "", ...extra });
const res = (groups: TierGroup[], gaps: string[] = []): ReviewTiersResult => ({
  date: "2026-10-08", prev_dates: ["2026-09-30", "2026-09-29"], total: groups.reduce((n, x) => n + x.today, 0), groups, tiers: [],
  fetched_at: null, cached: false, generated_at: "", gaps, source: "x",
});

test("写法:前两天没取到写「—」;连板数大于 1 才写", () => {
  assert.equal(prevText(g("a", "single", [s("1", "x")], [2, null])), "2 / —");
  assert.deepEqual([stockText(s("600001", "甲", 3)), stockText(s("600002", "乙", 1)), stockText(s("600003", "", null))], ["甲(3 连板)", "乙", "600003"]);
});

test("给复盘提示词的几行:按档写,单只只列行业;没算出来只写缺口,不写空的四档", () => {
  assert.deepEqual(tiersSummary(null), []);
  assert.deepEqual(tiersSummary(res([], ["2026-10-08 的涨停池是空的"])), ["【缺口·涨停分档】2026-10-08 的涨停池是空的"]);
  const lines = tiersSummary(res([
    g("半导体", "mainline", [{ ...s("600002", "乙", 3, ["芯片"]), first_seal: "09:31:05" }, s("600001", "甲")], [2, 3], { tags: [{ tag: "芯片", count: 2 }, { tag: "存储", count: 1 }] }),
    g("汽车零部件", "today", [s("600010", "丙"), s("600011", "丁"), s("600012", "戊")], [2, null], { note: "前两个交易日的涨停池没取全,分不出是不是连续" }),
    g("电力", "scattered", [s("600020", "己"), s("600021", "庚")], [0, 0]),
    g("化工", "scattered", [s("600022", "癸", null), s("600023", "子", null)], [0, 0]),
    g("银行", "single", [s("600030", "辛")], [0, 0]), g("未分类", "single", [s("600040", "壬")], [1, 0]),
  ], ["同花顺题材标签没取到,只按东财行业分"]));
  // 连板数都没取到:不编最高板,也不写梯队(板数不明 ≠ 首板)
  assert.deepEqual(lines, [
    "【涨停分档·2026-10-08】11 只涨停按东财行业归类(行业名是东财截短的,最长 4 个字),和前两个交易日(2026-09-30、2026-09-29)比;档位按只数的固定规则分,不代表能否持续:",
    "连续集中(今天同一行业 ≥ 3 只涨停,前两个交易日每天也 ≥ 2 只):",
    "  半导体 2 只(前两个交易日 2 / 3):乙(3 连板)、甲;最高板 乙(3 连板,09:31 首封);梯队 3 板 1 · 首板 1;同花顺题材标签 芯片×2、存储×1",
    "今天集中(今天同一行业 ≥ 3 只涨停,前两个交易日不是每天都 ≥ 2 只):",
    "  汽车零部件 3 只(前两个交易日 2 / 没取到):丙、丁、戊;最高板 丙(首板);梯队 首板 3;前两个交易日的涨停池没取全,分不出是不是连续",
    "零散(今天同一行业 2 只涨停):",
    "  电力 2 只(前两个交易日 0 / 0):己、庚;最高板 己(首板);梯队 首板 2",
    "  化工 2 只(前两个交易日 0 / 0):癸、子",
    "单只(今天这个行业只有 1 只涨停):银行、未分类",
    "【缺口·涨停分档】同花顺题材标签没取到,只按东财行业分",
  ]);
});

test("前端调用:GET /view/review_tiers?date=…,重新取带 refresh=1", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => { urls.push(String(input)); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try { await backend.reviewTiers({ date: "2026-10-08" }); await backend.reviewTiers({ date: "2026-10-08", refresh: true }); } finally { globalThis.fetch = prev; }
  assert.deepEqual(urls, ["/api/view/review_tiers?date=2026-10-08", "/api/view/review_tiers?date=2026-10-08&refresh=1"]);
});

test("每日复盘页:按业务日取分档,只用那一天的;提示词带分档顺序和写法要求;卡片不用红绿、写明不是推荐", () => {
  const page = read("pages/DailyReview.tsx");
  assert.match(page, /backend\.reviewTiers\(\{ date: day, refresh \}\)/);
  assert.match(page, /tiersSummary\(bizDay && tiers\?\.date === bizDay \? tiers : null\)/, "别的日子的分档不进提示词");
  assert.match(page, /<ReviewTiersCard data=\{bizDay && tiers\?\.date === bizDay \? tiers : null\}/);
  assert.match(page, /TIER_PROMPT_RULES/);
  assert.match(page, /tiersReady/);
  assert.match(TIER_PROMPT_RULES, /连续集中 → 今天集中 → 零散 → 单只/);
  assert.match(TIER_PROMPT_RULES, /不超过 25 个字/);
  const card = read("components/ReviewTiersCard.tsx");
  assert.doesNotMatch(card, /text-danger|text-success|bg-danger|bg-success|text-red|text-green/);
  assert.match(card, /也不是推荐/);
  assert.match(card, /不是核验过的因果/);
  assert.match(card, /\{topOf\(g\) && [\s\S]*?topText\(topOf\(g\)!\)[\s\S]*?ladderText\(g\)/, "每组显示最高板与梯队;连板数没取到时不显示");
});
