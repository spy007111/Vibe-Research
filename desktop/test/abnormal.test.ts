import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import {
  abnormalContext, critRatio, levelText, levelTone, limitText, reachedWhen, ruleLine, showPair, splitRows,
  type AbnormalResult, type AbnormalRow, type Crit, type Proximity,
} from "../src/verticals/finance/lib/abnormal.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const crit = (days: number, up: number | null, down: number | null, limit: [number, number], reached: "up" | "down" | null = null): Crit => ({ days, up, down, limit, reached });
const prox = (level: number, extra: Partial<Proximity> = {}): Proximity => ({
  as_of: "2026-10-08", since: "2026-10-06",
  abnormal: crit(3, 12.5, -1.2, [20, -20]), severe10: crit(10, 30, null, [100, -50]), severe30: crit(30, 30, null, [200, -70]),
  same_dir: { up: 1, down: 0, need: 4 }, recent: [], level, notes: [], ...extra,
});
const row = (symbol: string, name: string, result: Proximity | null, skipped: string | null = null): AbnormalRow =>
  ({ symbol, name, board: "sh_main", board_label: "沪市主板", index_label: "上证A股指数", result, skipped });

test("数值写法:两边都写、百分号紧跟、标准对称写 ±,不对称分开写", () => {
  assert.equal(showPair(crit(3, 12.345, -1.2, [20, -20])), "+12.35% / -1.2%");
  assert.equal(showPair(crit(3, null, -16, [20, -20])), "-16%");
  assert.equal(showPair(crit(3, null, null, [20, -20])), "0%");
  assert.equal(limitText(crit(3, 0, 0, [20, -20])), "±20%");
  assert.equal(limitText(crit(10, 0, 0, [100, -50])), "+100% / -50%");
  assert.equal(critRatio(crit(10, 30, -40, [100, -50])), 0.8);
  assert.equal(critRatio(crit(10, null, null, [100, -50])), 0);
});

test("接近度显示:达到写「已达到」,其余向下取整成百分比;不用红绿", () => {
  assert.deepEqual([1, 1.14, 0.999, 0.5, 0].map(levelText), ["已达到", "已达到", "99%", "50%", "0%"]);
  for (const l of [1.2, 0.8, 0.3]) assert.doesNotMatch(levelTone(l), /danger|success|destructive|red|green/);
  assert.match(levelTone(1), /warning/);
  assert.match(levelTone(0.7), /warning/);
  assert.match(levelTone(0.69), /muted/);
});

test("分组:按接近度从高到低,不到一半的收起,没算出来的单列", () => {
  const rows = [row("600001", "一", prox(0.3)), row("600002", "二", prox(1.1)), row("600003", "三", null, "日 K 没取到"), row("600004", "四", prox(0.5)), row("600005", "五", prox(0.72))];
  const s = splitRows(rows);
  assert.deepEqual(s.shown.map((r) => r.symbol), ["600002", "600005", "600004"]);
  assert.deepEqual(s.folded.map((r) => r.symbol), ["600001"]);
  assert.deepEqual(s.skipped.map((r) => r.symbol), ["600003"]);
});

test("标准一行写全:基准指数、3 日、第几次同向、10 日 / 30 日", () => {
  assert.equal(ruleLine({ board: "star", label: "科创板", index: "科创50", abn: 30, count: 3, sev10: [100, -50], sev30: [200, -70] }),
    "科创板(基准 科创50):3 日 ±30%;10 日内第 3 次同向异常波动、10 日 +100% / -50%、30 日 +200% / -70% 为严重异常波动");
});

const result = (rows: AbnormalRow[], gaps: string[] = [], intraday = false): AbnormalResult => ({
  rows, rules: [], as_of: "2026-10-08", intraday, fetched_at: "2026-10-08T08:00:00Z", cached: false, generated_at: "", gaps, source: "交易规则(2026 年修订)",
});

test("问 Agent 的上下文:口径、每只三条标准、推算达到过的、没算的都交代;没数据时不写", () => {
  assert.equal(abnormalContext(null), "");
  assert.equal(abnormalContext(result([])), "");
  const text = abnormalContext(result([
    row("002242", "九阳股份", prox(1.14, {
      abnormal: crit(3, 22.89, null, [20, -20], "up"),
      recent: [{ date: "2026-09-29", kind: "abnormal", dir: "up", why: "3 个交易日内累计偏离 +23.65%(标准 ±20%)" }],
      notes: ["上证A股指数缺 1 个交易日的数据,缺的那几天不算"],
    })),
    row("600003", "", null, "日 K 没取到"),
  ], ["北交所 920627:没算"], true));
  const lines = text.split("\n");
  assert.equal(lines[0], "异动接近度(离交易所异常波动标准多远;按 交易规则(2026 年修订) 推算,以交易所公告为准,不判断方向),截至 2026-10-08 盘中按最新价估算:");
  assert.equal(lines[1], "九阳股份 002242(沪市主板,基准 上证A股指数):3 日 +22.89%(标准 ±20%,今天已达到);10 日 +30%(标准 +100% / -50%);30 日 +30%(标准 +200% / -70%);10 日内同向异常波动 向上 1 次 / 向下 0 次(第 4 次构成严重异常波动)");
  assert.equal(lines[2], "  2026-09-29 按规则推算达到异常波动(向上):3 个交易日内累计偏离 +23.65%(标准 ±20%)");
  assert.equal(lines[3], "  注:上证A股指数缺 1 个交易日的数据,缺的那几天不算");
  assert.equal(lines[4], "600003:没算(日 K 没取到)");
  assert.equal(lines[5], "没算的:北交所 920627:没算");
  // 收盘后 / 停牌的不说「今天」(审查 R3-2)
  const reached = prox(1.14, { abnormal: crit(3, 22.89, null, [20, -20], "up") });
  assert.match(abnormalContext(result([row("002242", "九阳股份", reached)])), /标准 ±20%,2026-10-08 已达到\)/);
  assert.match(abnormalContext(result([row("600006", "样本六", { ...reached, as_of: "2026-09-30" })], [], true)), /标准 ±20%,2026-09-30 已达到\)/);
  assert.equal(reachedWhen(reached, { as_of: "2026-10-08", intraday: true }), "今天");
  assert.equal(reachedWhen(reached, { as_of: "2026-10-08", intraday: false }), "2026-10-08");
});

test("前端调用:GET /view/abnormal,重新取带 refresh=1", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => { urls.push(String(input)); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try { await backend.abnormal(); await backend.abnormal({ refresh: true }); } finally { globalThis.fetch = prev; }
  assert.deepEqual(urls, ["/api/view/abnormal", "/api/view/abnormal?refresh=1"]);
});

test("自选页:接上异动接近度卡片和问 Agent 上下文;卡片写明以交易所公告为准,不用红绿", () => {
  const page = read("pages/Watchlist.tsx");
  assert.match(page, /<AbnormalCard codes=\{codes\} onData=\{setAbnormal\} \/>/);
  assert.match(page, /abnormalContext\(abnormal\)/);
  assert.match(page, /\[codes, quotes, abnormal\]/, "上下文随结果更新");
  const card = read("components/AbnormalCard.tsx");
  assert.match(card, /以交易所公告为准/);
  assert.match(card, /不判断方向、不预测/);
  assert.match(card, /backend\.abnormal\(\{ refresh \}\)/);
  assert.match(card, /if \(!cnKey\) return null;/, "没有 A 股自选就不显示");
  assert.doesNotMatch(card, /text-danger|text-success|bg-danger|bg-success/);
});
