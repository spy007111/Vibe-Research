/**
 * 研究对比（/runs/<id>/compare）：同一家公司的几次研究（多半是换了一家 Agent 再跑），研究过程并排摆出来。
 *
 * 🔴 只比研究过程，不比结论对错，也不比收益；不打总分、不排名次，也不按好坏上色 ——
 *    比如缺口写得多，可能只是更老实地说了缺什么。
 * 🔴 后端给 null 的显示「—」（不知道），不当 0。
 */
import { AI_MODELS } from "./ai-models.ts";
import type { RunListItem } from "./backend.ts";

export interface RunMetrics {
  run_id: string;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  engine: { provider: string | null; version: string | null; model: string | null };
  endpoint_scope: string | null;
  duration_s: number | null;
  agent_s: number | null;
  stages: { complete: number; total: number } | null;
  first_pass: { passed: number; total: number } | null;
  numbers: { exact: number; total: number } | null;
  evidence: { fetched: number | null; cited: number | null };
  calcs: { cited: number | null; total: number | null };
  gaps: number | null;
  conflicts: number | null;
  gate_hits: number | null;
  stop_blocks: number | null;
  fetch: { ok: number; partial: number; failed: number } | null;
}
export interface RunCompareResult { run_id: string; runs: RunMetrics[]; omitted: number }

export const NA = "—";

/** 哪家 Agent：订阅档用设置页里的名字；API 档用模型名；都没有就如实说没记录 */
export function engineName(e: RunMetrics["engine"]): string {
  const p = e.provider ?? "";
  if (p.startsWith("cli-")) return AI_MODELS.find((m) => m.provider === p)?.name ?? p;
  if (e.model) return AI_MODELS.find((m) => m.id === e.model)?.name ?? e.model;
  return p || "没记录是哪家";
}

/** 版本 + 模型。订阅档的 CLI 不回报模型名，就照实说 */
export function engineDetail(e: RunMetrics["engine"]): string {
  const model = e.model ?? ((e.provider ?? "").startsWith("cli-") ? "模型由本机登录决定，没有回报" : "");
  return [e.version, model].filter(Boolean).join(" · ") || NA;
}

export function fmtDuration(s: number | null): string {
  if (s === null) return NA;
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分`;
}

const num = (n: number | null) => (n === null ? NA : String(n));
const pair = (a: number | null, b: number | null) => (a === null && b === null ? NA : `${num(a)} / ${num(b)}`);
export const SCOPE: Record<string, string> = { core: "核心", full: "完整" };
export const when = (at: string | null) => (at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) ? at.slice(0, 16).replace("T", " ") : NA);

export interface CompareRow { label: string; hint?: string; value: (r: RunMetrics) => string }

/** 表格的行，顺序即显示顺序 */
export const ROWS: CompareRow[] = [
  { label: "取数范围", hint: "核心 / 完整：范围不同，证据条数不能直接比", value: (r) => (r.endpoint_scope ? SCOPE[r.endpoint_scope] ?? r.endpoint_scope : NA) },
  { label: "总用时", hint: "从开始到结束，含取数", value: (r) => fmtDuration(r.duration_s) },
  { label: "Agent 干活的时间", hint: "各阶段每一轮相加", value: (r) => fmtDuration(r.agent_s) },
  { label: "资料齐全的阶段", hint: "其余是缺了必需的数据或计算、跳过、失败或没跑到", value: (r) => (r.stages ? pair(r.stages.complete, r.stages.total) : NA) },
  { label: "一次就过校验的阶段", hint: "第一次交上来就通过校验 / 跑过校验的阶段", value: (r) => (r.first_pass ? pair(r.first_pass.passed, r.first_pass.total) : NA) },
  { label: "报告数字对得上", hint: "只核对引了证据或计算编号的行：对得上的 / 核对了的", value: (r) => (r.numbers ? pair(r.numbers.exact, r.numbers.total) : NA) },
  { label: "取到的证据", value: (r) => num(r.evidence.fetched) },
  { label: "实际引用的证据", hint: "各阶段引用到的，去重", value: (r) => num(r.evidence.cited) },
  { label: "引用的计算", hint: "各阶段引用到的 / 这次全部计算", value: (r) => pair(r.calcs.cited, r.calcs.total) },
  { label: "写出的缺口", hint: "各阶段自己写明缺了什么；多不一定差", value: (r) => num(r.gaps) },
  { label: "跨来源对不上的证据", value: (r) => num(r.conflicts) },
  { label: "触到产出红线", value: (r) => num(r.gate_hits) },
  { label: "收尾时被拦回补做", value: (r) => num(r.stop_blocks) },
  { label: "取数脚本", hint: "成功 / 只取到一部分 / 失败（含超时、出错）", value: (r) => (r.fetch ? `${r.fetch.ok} / ${r.fetch.partial} / ${r.fetch.failed}` : NA) },
];

/** 表格上方要先说清楚的几件事 */
export function compareNotes(res: RunCompareResult): string[] {
  const notes: string[] = [];
  if (res.runs.length < 2) {
    notes.push("这家公司只有这一次研究。换一家 Agent 再研究同一只股票，就能在这里并排比较。");
    return notes;
  }
  if (new Set(res.runs.map((r) => engineName(r.engine))).size < 2) {
    notes.push("这几次都是同一家 Agent 跑的。换一家 Agent 再研究同一只股票，就能比较不同 Agent。");
  }
  if (new Set(res.runs.map((r) => r.endpoint_scope).filter(Boolean)).size > 1) {
    notes.push("这几次的取数范围不同（核心 / 完整），取到和引用的证据条数不能直接比。");
  }
  if (new Set(res.runs.map((r) => r.stages?.total).filter((n) => n !== undefined)).size > 1) {
    notes.push("有的研究只跑了部分阶段（看「资料齐全的阶段」斜杠后面的总数），各项数量不能直接比。");
  }
  if (res.runs.some((r) => r.status === "failed" || r.status === "cancelled")) {
    notes.push("中途停下的研究，各项只统计到它停下的地方。");
  }
  // 当前这次再老也列;其余挑最近的几次 —— 没列出的不一定比当前这次早
  if (res.omitted > 0) notes.push(`还有 ${res.omitted} 次研究没列出（最多并排 ${res.runs.length} 次：这一次，加上其余里最近的 ${res.runs.length - 1} 次）。`);
  return notes;
}

/** 对比说明的固定开头：卡片上、存进研究记录的、周报里都是这一句 */
export const COMPARE_BASIS = "只比研究过程，不比结论对错，也不比收益；不打总分、不排名次。每次取数时间不同，数据本身也可能不完全一样。";

/** 本机能一键请来再研究一次的订阅 Agent：只列已登录可用的；count = 表里这家已经有几次 */
export interface AgentChoice { provider: string; name: string; count: number }
export function agentChoices(agents: { provider: string; status: string }[], res: RunCompareResult): AgentChoice[] {
  return agents.filter((a) => a.status === "ready").map((a) => ({
    provider: a.provider,
    name: engineName({ provider: a.provider, version: null, model: null }),
    count: res.runs.filter((r) => r.engine.provider === a.provider).length,
  }));
}

/** 再研究一次沿用这次的取数范围；这次没记录范围的按「核心」（按钮旁边写明用的是哪个） */
export function scopeOf(res: RunCompareResult): "core" | "full" {
  return res.runs.find((r) => r.run_id === res.run_id)?.endpoint_scope === "full" ? "full" : "core";
}

const cellMd = (s: string) => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

/** 一组对比的 Markdown：先写要先说清的几件事，再是并排表格（状态的中文叫法由调用方给） */
function compareBody(res: RunCompareResult, statusText: (s: string | null) => string): string[] {
  const row = (label: string, value: (r: RunMetrics) => string) => `| ${label} | ${res.runs.map((r) => cellMd(value(r))).join(" | ")} |`;
  const notes = compareNotes(res).map((n) => `- ${n}`);
  return [
    ...(notes.length ? [...notes, ""] : []),
    row("研究过程", (r) => engineName(r.engine) + (r.run_id === res.run_id ? "（这次）" : "")),
    `| --- | ${res.runs.map(() => "---").join(" | ")} |`,
    row("开始时间", (r) => when(r.started_at)),
    row("状态", (r) => statusText(r.status)),
    ...ROWS.map((x) => row(x.label, x.value)),
  ];
}

const legend = (): string[] => ["### 各行怎么读", "", ...ROWS.filter((x) => x.hint).map((x) => `- ${x.label}：${x.hint}`)];

/** 「存进研究记录」：把卡片上这张对比表存成 Markdown */
export function compareMarkdown(res: RunCompareResult, statusText: (s: string | null) => string): string {
  return [COMPARE_BASIS, "", ...compareBody(res, statusText), "",
    `运行标识：${res.runs.map((r) => `${engineName(r.engine)} ${r.run_id}`).join("；")}`, "", ...legend()].join("\n");
}

export const WEEK_DAYS = 7;
/** 周报最多列几只（每只都要把各次报告的数字重新核对一遍，太多会很慢） */
export const WEEKLY_MAX = 10;
const DAY_MS = 86_400_000;
const startedIn = (at: string | null, from: number, to: number) => { const t = at ? Date.parse(at) : NaN; return Number.isFinite(t) && t >= from && t <= to; };

/**
 * 本周对比周报要看哪几只：近 7 天开始、已经结束的正式研究（测试运行不算），按同一对象 + 同一市场分组，
 * 至少两次的才算；每组给出最新那次（拿它去要对比），最近研究过的排前面。
 */
export function weeklyGroups(runs: RunListItem[], now: number): { run_id: string; label: string; count: number }[] {
  const from = now - WEEK_DAYS * DAY_MS;
  const groups = new Map<string, RunListItem[]>();
  for (const r of runs) {
    if (r.test_scenario || !r.symbol || !r.finished_at || !Number.isFinite(Date.parse(r.finished_at)) || !startedIn(r.started_at, from, now)) continue;
    const key = `${r.market ?? ""}:${r.symbol}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].filter((g) => g.length >= 2).map((g) => {
    const latest = g.reduce((a, b) => (Date.parse(b.started_at!) > Date.parse(a.started_at!) ? b : a));
    const named = g.find((r) => r.name)?.name;
    return { run_id: latest.run_id, label: named ? `${named}（${latest.symbol}）` : latest.symbol!, count: g.length, at: Date.parse(latest.started_at!) };
  }).sort((a, b) => b.at - a.at).map((g) => ({ run_id: g.run_id, label: g.label, count: g.count }));
}

const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/**
 * 本周各家 Agent 研究对比（只存本机的研究记录）。每只只留近 7 天开始的那几次，
 * 至少两家不同 Agent 才列；一只都没有时返回 null（不存一份空周报）。
 * `skipped` = 超出 WEEKLY_MAX 没对比的只数；`failed` = 要对比时出错的（写进周报，不悄悄漏掉）。
 */
export function weeklyCompareMarkdown(
  sections: { label: string; res: RunCompareResult }[], now: number, statusText: (s: string | null) => string,
  extra: { skipped?: number; failed?: string[] } = {},
): { title: string; markdown: string; count: number } | null {
  const from = now - WEEK_DAYS * DAY_MS;
  const parts: string[] = [];
  let count = 0;
  for (const { label, res } of sections) {
    const runs = res.runs.filter((r) => startedIn(r.started_at, from, now));
    if (runs.length < 2 || new Set(runs.map((r) => engineName(r.engine))).size < 2) continue;
    count += 1;
    // 这只的研究多到超过一次能并排的上限、而列出来的又全在本周：本周可能还有更早的几次没列
    const capped = res.omitted > 0 && runs.length === res.runs.length;
    const shown: RunCompareResult = { run_id: runs.some((r) => r.run_id === res.run_id) ? res.run_id : runs[0]!.run_id, runs, omitted: 0 };
    parts.push(`## ${label}`, "", ...(capped ? [`- 这只本周研究的次数超过一次能并排的上限，只列了最近的 ${runs.length} 次。`] : []), ...compareBody(shown, statusText), "");
  }
  const failed = extra.failed ?? [];
  if (!count) return null;
  const range = `${ymd(from)} 至 ${ymd(now)}`;
  const markdown = [
    `只列近 ${WEEK_DAYS} 天（${range}）开始、已经结束、被至少两家不同 Agent 研究过的股票；测试运行不算。这份周报只存在本机的研究记录里。`,
    "", COMPARE_BASIS, "", ...parts,
    ...(extra.skipped ? [`- 另有 ${extra.skipped} 只超出每份周报最多 ${WEEKLY_MAX} 只的上限，没有列入。`] : []),
    ...failed.map((f) => `- 没对比出来：${f}`),
    ...(extra.skipped || failed.length ? [""] : []),
    ...legend(),
  ].join("\n");
  return { title: `本周各家 Agent 研究对比（${range}）`, markdown, count };
}
