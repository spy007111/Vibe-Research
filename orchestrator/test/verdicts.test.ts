import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register_tasks.ts";
import type { LedgerRecord } from "../src/ledger.ts";
import { currentSchedule } from "../src/notify.ts";
import { ServiceError, ledgerUpsert, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import { SNAPSHOT_SCHEMA, snapshotKey } from "../src/snapshot.ts";
import {
  ANN_MAX_AGE_MS, calibration, dueCriteria, factsFromAnnouncements, judgedList, sinceDay, verdictDue, verdictLabel, verdictMessage, verdictReview, type VerdictItem,
} from "../src/finance/verdicts.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TODAY = "2026-10-08";
let n = 0;
const crit = (fields: Record<string, unknown>): LedgerRecord => ({ id: `criterion-${++n}`, kind: "criterion", created_at: "2026-09-01T02:00:00.000Z", updated_at: "2026-09-01T02:00:00.000Z", type: "decision_point", statement: "s", status: "pending", ...fields });
const ann = (period: string, title: string) => ({ field: "announcement_title", value: title, period, record_key: `${period}-${title}` });

function withRoot(fn: (ctx: ServiceContext) => Promise<void>) {
  return async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vra-verdict-"));
    try { await fn({ repoRoot: REPO, dataRoot, python: "false", node: process.execPath }); } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
  };
}

test("状态按类型读:裁决点是兑现 / 没兑现,证伪条件是到期没触发 / 触发了", () => {
  assert.deepEqual((["pending", "met", "broken", "dropped"] as const).map((s) => verdictLabel("decision_point", s)), ["待判", "兑现", "没兑现", "不再跟踪"]);
  assert.deepEqual((["pending", "met", "broken", "dropped"] as const).map((s) => verdictLabel("falsifier", s)), ["待判", "到期没触发", "触发了", "不再跟踪"]);
});

test("起点:按北京时间算写下那天;写下晚于到期日(补记)时退回到期前 30 天", () => {
  // UTC 10-01 17:00 = 北京时间 10-02 01:00
  assert.equal(sinceDay(crit({ created_at: "2026-10-01T17:00:00.000Z" }), "2026-10-20"), "2026-10-02");
  assert.equal(sinceDay(crit({ created_at: "2026-10-25T02:00:00.000Z" }), "2026-10-20"), "2026-09-20");
  assert.equal(sinceDay(crit({ created_at: "坏的" }), "2026-10-20"), "2026-09-20");
});

test("到期:只算待判、有类型、到期日不晚于今天(今天到期也算),按到期日排", () => {
  const rs = [
    crit({ due: "2026-10-08", statement: "今天" }),
    crit({ due: "2026-09-30", statement: "早" }),
    crit({ due: "2026-10-09", statement: "明天" }),
    crit({ due: "2026-09-01", status: "met", statement: "判过" }),
    crit({ due: "", statement: "没日期" }),
    crit({ due: "2026-09-02", type: "bogus", statement: "坏类型" }),
    crit({ due: "2026-09-03", type: "falsifier", statement: "证伪" }),
  ];
  assert.deepEqual(dueCriteria(rs, TODAY).map((r) => r.statement), ["证伪", "早", "今天"]);
});

test("校准表:两类分开数,只数结果,不涉及涨跌", () => {
  const rs = [
    crit({ status: "met", due: "2026-09-01" }), crit({ status: "met", due: "2026-09-02" }), crit({ status: "broken", due: "2026-09-03" }),
    crit({ status: "dropped" }), crit({ due: "2026-10-01" }), crit({ due: "2026-10-08" }), crit({ due: "2026-11-01" }), crit({ due: "" }),
    crit({ type: "falsifier", status: "broken" }), crit({ type: "falsifier" }),
  ];
  const [dp, fa] = calibration(rs, TODAY);
  assert.deepEqual({ ...dp, type: undefined }, { type: undefined, label: "裁决点", met_label: "兑现", broken_label: "没兑现", met: 2, broken: 1, dropped: 1, due_unjudged: 2, upcoming: 1, no_due: 1 });
  assert.deepEqual([fa!.label, fa!.broken_label, fa!.broken, fa!.no_due], ["证伪条件", "触发了", 1, 1]);
  assert.doesNotMatch(JSON.stringify(calibration(rs, TODAY)), /涨|跌|胜率|收益/);
});

test("判过的:按判定日倒序,带回原记录", () => {
  const rs = [crit({ status: "met", judged_at: "2026-10-01", symbol: "600519" }), crit({ status: "broken", judged_at: "2026-10-05" }), crit({ status: "pending" })];
  const j = judgedList(rs, (s) => (s === "600519" ? "贵州茅台" : ""));
  assert.deepEqual(j.map((x) => [x.status, x.judged_at, x.name]), [["broken", "2026-10-05", ""], ["met", "2026-10-01", "贵州茅台"]]);
  assert.equal(j[1]!.record, rs[0]);
});

test("公告:只列起点到今天的;来源只给 30 条且最早一条晚于起点时写明没看全;超过 15 条只列最近的、总数照实", () => {
  const f = factsFromAnnouncements({ evidence: [ann("2026-10-07", "三季报"), ann("2026-08-30", "太早"), ann("2026-10-09", "未来"), ann("2026-09-15", "合同"), ann("2026-09-01", "当天"), ann("2026-08-31", "前一天"), { field: "other", value: "x", period: "2026-10-01" }] }, "2026-09-01", TODAY);
  assert.deepEqual(f, { facts: [{ date: "2026-10-07", title: "三季报" }, { date: "2026-09-15", title: "合同" }, { date: "2026-09-01", title: "当天" }], total: 3, note: "" });

  const full = Array.from({ length: 30 }, (_, i) => ann(`2026-10-${String((i % 8) + 1).padStart(2, "0")}`, `t${i}`));
  const g = factsFromAnnouncements({ evidence: full }, "2026-09-01", TODAY);
  assert.equal(g.facts.length, 15);
  assert.equal(g.total, 30);
  assert.equal(g.note, "来源只给最近 30 条,2026-10-01 以前的公告没看到");
  // 30 条但最早一条早于起点:这段时间都覆盖到了
  const h = factsFromAnnouncements({ evidence: [...full.slice(1), ann("2026-08-01", "老")] }, "2026-09-01", TODAY);
  assert.deepEqual([h.facts.length, h.total, h.note], [15, 29, ""]);
});

const item = (over: Partial<VerdictItem>): VerdictItem => ({
  id: "c1", symbol: "300308", name: "中际旭创", type: "decision_point", statement: "800G 出货过半", due: "2026-10-08", since: "2026-09-01",
  overdue_days: 0, thesis: "", facts: [], facts_total: 0, facts_source: "", facts_fetched_at: null, facts_note: "", record: crit({}), ...over,
});

test("提醒消息:逐条写判据和期间公告,不写建议", () => {
  const m = verdictMessage(TODAY, [
    item({ facts: [{ date: "2026-10-07", title: "关于获得发明专利证书的公告" }, { date: "2026-09-20", title: "x" }], facts_total: 18 }),
    item({ id: "c2", symbol: "AAPL", name: "", type: "falsifier", statement: "毛利率跌破 40%", facts_note: "港股 / 美股目前没有逐只公告来源,请自己核对" }),
    item({ id: "c3", symbol: null, name: "", statement: "a".repeat(70), facts_note: "这条判据没写代码,没有可对照的公告" }),
  ], 2);
  assert.equal(m.title, "判据到期 2026-10-08");
  assert.equal(m.dedupeKey, "verdict_due:2026-10-08");
  assert.equal(m.link, "/calendar");
  assert.deepEqual(m.lines, [
    "中际旭创 300308 裁决点 到期 2026-10-08:800G 出货过半",
    "  2026-09-01 以来公告 18 条,最近:2026-10-07 关于获得发明专利证书的公告",
    "AAPL 证伪条件 到期 2026-10-08:毛利率跌破 40%",
    "  港股 / 美股目前没有逐只公告来源,请自己核对",
    `裁决点 到期 2026-10-08:${"a".repeat(60)}…`,
    "  这条判据没写代码,没有可对照的公告",
    "另有 2 条早先到期、还没判",
    "到「事件日历」页对照后,标记兑现与否",
  ]);
  assert.doesNotMatch(m.lines.join("\n"), /建议|买|卖|看好|评分/);
});

test("注册:判据到期任务排在自选变化之后,视图 verdicts 可用", () => {
  assert.deepEqual(currentSchedule()!.jobs.map((j) => [j.id, j.at]), [["close_digest", "15:40"], ["watch_changes", "16:15"], ["verdict_due", "16:30"]]);
  assert.ok(listViews().some((v) => v.id === "verdicts"));
});

test("台账:判据可以写判定日和判定说明;判定日要是真日期", withRoot(async (ctx) => {
  const r = ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "600519", type: "decision_point", statement: "x", due: "2026-10-01", status: "met", judged_at: "2026-10-08", verdict_note: "三季报已披露" } });
  assert.equal(r.judged_at, "2026-10-08");
  assert.throws(() => ledgerUpsert(ctx, { kind: "criterion", record: { type: "decision_point", statement: "x", judged_at: "2026-02-31" } }), ServiceError);
}));

test("整合:到期的带上事实说明;港股 / 没代码分别说明;来源取不到如实写", withRoot(async (ctx) => {
  ledgerUpsert(ctx, { kind: "watch", record: { symbol: "300308", name: "中际旭创" } });
  const th = ledgerUpsert(ctx, { kind: "thesis", record: { symbol: "300308", title: "光模块放量", status: "active" } });
  ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "300308", thesis_id: th.id, type: "decision_point", statement: "800G 过半", due: "2026-10-01", status: "pending" } });
  ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "00700.HK", type: "falsifier", statement: "游戏版号停发", due: "2026-10-08", status: "pending" } });
  ledgerUpsert(ctx, { kind: "criterion", record: { type: "decision_point", statement: "降息落地", due: "2026-10-05", status: "pending" } });
  ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "300308", type: "decision_point", statement: "未到期", due: "2026-12-01", status: "pending" } });
  ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "300308", type: "decision_point", statement: "判过", due: "2026-09-01", status: "met", judged_at: "2026-09-02" } });
  const now = new Date("2026-10-08T09:00:00Z");
  const r = await verdictReview(ctx, {}, new AbortController().signal, now);
  assert.equal(r.today, TODAY);
  assert.deepEqual(r.due.map((d) => [d.statement, d.overdue_days, d.name, d.facts_note]), [
    ["800G 过半", 7, "中际旭创", "公告没取到"],
    ["降息落地", 3, "", "这条判据没写代码,没有可对照的公告"],
    ["游戏版号停发", 0, "", "港股 / 美股目前没有逐只公告来源,请自己核对"],
  ]);
  assert.equal(r.due[0]!.thesis, "光模块放量");
  assert.equal(r.due[0]!.since, "2026-09-01", "今天才补记、到期日已过的判据,起点退回到期前 30 天");
  assert.equal(r.due[0]!.record.statement, "800G 过半");
  assert.deepEqual([r.calibration[0]!.met, r.calibration[0]!.due_unjudged, r.calibration[0]!.upcoming], [1, 2, 1]);
  assert.deepEqual(r.judged.map((j) => j.statement), ["判过"]);
}));

/** 直接放一份公告快照(取数时间 = 现在往前 ageMs),不联网 */
function annSnapshot(ctx: ServiceContext, symbol: string, ageMs: number, evidence: unknown[]): string {
  const key = snapshotKey("fetch_announcements", symbol, {});
  const at = new Date(Date.now() - ageMs).toISOString();
  const payload = { envelope: { status: "ok", evidence }, exit_code: 0, out_dir: "", duration_ms: 1, stderr_tail: "", cached: false, fetched_at: at };
  fs.mkdirSync(path.join(ctx.dataRoot, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(ctx.dataRoot, "snapshots", `${key}.json`), JSON.stringify({ schema: SNAPSHOT_SCHEMA, key, endpoint: "fetch_announcements", symbol, fetched_at: at, payload }));
  return at;
}

test("公告快照:两小时内的直接用、带上取数时间;更旧的不用(重新取,取不到就如实说)", withRoot(async (ctx) => {
  ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "300308", type: "decision_point", statement: "新", due: "2026-10-01", status: "pending" } });
  ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "600519", type: "decision_point", statement: "旧", due: "2026-10-01", status: "pending" } });
  const fresh = annSnapshot(ctx, "300308", ANN_MAX_AGE_MS - 60_000, [ann("2026-10-05", "三季度业绩预告")]);
  annSnapshot(ctx, "600519", ANN_MAX_AGE_MS + 60_000, [ann("2026-10-05", "旧快照里的公告")]);
  const r = await verdictReview(ctx, {}, new AbortController().signal, new Date("2026-10-08T09:00:00Z"));
  const by = Object.fromEntries(r.due.map((d) => [d.statement, d]));
  assert.deepEqual([by["新"]!.facts_total, by["新"]!.facts_fetched_at, by["新"]!.facts_note], [1, fresh, ""]);
  assert.deepEqual([by["旧"]!.facts_total, by["旧"]!.facts_fetched_at, by["旧"]!.facts_note], [0, null, "公告没取到"]);
}));

test("定时任务:只报新到期的;同一条不天天推;改了到期日到新日子再报;手动运行列全部", withRoot(async (ctx) => {
  const sig = new AbortController().signal;
  const job = (day: string, state: unknown, manual = false) => verdictDue({ ctx, day, now: new Date(`${day}T08:30:00Z`), signal: sig, state, manual });
  assert.deepEqual(await job(TODAY, undefined), { messages: [], note: "没有到期的判据" });

  const a = ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "600519", type: "decision_point", statement: "A", due: "2026-10-03", status: "pending" } });
  const r1 = await job(TODAY, undefined);
  assert.equal(r1.messages.length, 1);
  assert.match(r1.messages[0]!.lines[0]!, /A$/);
  assert.deepEqual(r1.state, { notified: [`${a.id}|2026-10-03`] });

  const r2 = await job("2026-10-09", r1.state);
  assert.deepEqual(r2, { messages: [], note: "没有新到期的判据(还有 1 条到期没判)" });

  ledgerUpsert(ctx, { kind: "criterion", record: { symbol: "600519", type: "decision_point", statement: "B", due: "2026-10-09", status: "pending" } });
  const r3 = await job("2026-10-09", r1.state);
  assert.equal(r3.messages[0]!.lines.filter((l) => /到期 2026-/.test(l)).length, 1, "只列新到期的 B");
  assert.ok(r3.messages[0]!.lines.includes("另有 1 条早先到期、还没判"));

  // A 改到期日后在新日子再报一次
  ledgerUpsert(ctx, { kind: "criterion", record: { id: a.id, symbol: "600519", type: "decision_point", statement: "A", due: "2026-10-09", status: "pending" } });
  const r4 = await job("2026-10-09", r3.state);
  assert.equal(r4.messages.length, 1);
  assert.match(r4.messages[0]!.lines[0]!, /:A$/);

  const r5 = await job("2026-10-09", r4.state, true);
  assert.equal(r5.messages[0]!.lines.filter((l) => /到期 2026-/.test(l)).length, 2, "手动运行列出全部到期没判的");
}));
