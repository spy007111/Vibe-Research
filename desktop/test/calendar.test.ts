import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import { KIND_META, dayLabel, groupByDate, type CalendarEvent } from "../src/verticals/finance/lib/calendar.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const ev = (date: string, kind: CalendarEvent["kind"], title = "t"): CalendarEvent => ({ date, kind, symbol: null, name: "", title, detail: [], source: "s", fetched_at: null });

test("日期标签按窗口起点算相对天数,不拿浏览器时区猜", () => {
  assert.deepEqual(dayLabel("2026-10-08", "2026-10-08"), { main: "10月8日 周四", rel: "今天" });
  assert.deepEqual(dayLabel("2026-10-09", "2026-10-08"), { main: "10月9日 周五", rel: "明天" });
  assert.deepEqual(dayLabel("2026-11-02", "2026-10-08"), { main: "11月2日 周一", rel: "25 天后" });
  assert.equal(dayLabel("2026-09-30", "2026-10-08").rel, "8 天前");
  assert.deepEqual(dayLabel("bad", "2026-10-08"), { main: "bad", rel: "" });
});

test("按日期分组保持后端顺序", () => {
  const g = groupByDate([ev("2026-10-12", "criterion", "a"), ev("2026-10-12", "dividend", "b"), ev("2026-10-24", "disclosure", "c")]);
  assert.deepEqual(g.map((d) => [d.date, d.items.map((e) => e.title)]), [["2026-10-12", ["a", "b"]], ["2026-10-24", ["c"]]]);
  assert.deepEqual(groupByDate([]), []);
});

test("每类事件都有归组;台账三类归「我的台账」;不用红绿(红涨绿跌,事件不带涨跌含义)", () => {
  const kinds = ["disclosure", "lockup", "dividend", "earnings", "macro", "criterion", "review", "action"] as const;
  for (const k of kinds) assert.ok(KIND_META[k], k);
  assert.deepEqual(kinds.filter((k) => KIND_META[k].group === "ledger"), ["criterion", "review", "action"]);
  for (const k of kinds) assert.doesNotMatch(KIND_META[k].tone, /red-|green-|emerald-|rose-/, k);
});

test("前端调用:GET /view/calendar,参数只带天数和是否重新取", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    urls.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await backend.calendar();
    await backend.calendar({ days: 90, refresh: true });
  } finally { globalThis.fetch = prev; }
  assert.deepEqual(urls, ["/api/view/calendar", "/api/view/calendar?days=90&refresh=1"]);
});

test("页面:不给建议、取不到单独列出、选择只存在本机偏好里", () => {
  const src = read("pages/Calendar.tsx");
  assert.match(src, /不打分、不给买卖建议/);
  assert.match(src, /没查到的/);
  assert.match(src, /不代表真的没有/);
  assert.match(src, /storageSet\("vr-calendar-groups"/);
  assert.doesNotMatch(src, /localStorage/);
  assert.doesNotMatch(src, /目标价|评级|买入|卖出/);
  assert.match(read("lib/nav.ts"), /\{ to: "\/calendar", label: "事件日历", icon: "CalendarDays" \}/);
  assert.match(src, /<Link to="\/my-stocks\?tab=watch"[^>]*>自选股<\/Link>/, "空状态带去自选与持仓的自选分页");
});
