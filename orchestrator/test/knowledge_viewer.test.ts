import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { packCriticalScripts, stageScripts, makeConfig } from "../src/config.ts";
import { sha256File, writeJson } from "../src/fsutil.ts";
import { currentPlugin } from "../src/plugin.ts";
import { archiveRun, buildArchiveMarkdown, companyDir, recallKnowledge, safeFmValue, sensitiveHits, shDate, shouldRecall, truncateBySection } from "../src/knowledge.ts";
import type { Manifest } from "../src/merge.ts";
import { loadRun } from "../src/validator.ts";
import { APPENDIX_REL, VIEWER_REL, renderAppendix, collectViewerData, scrubForTest, writeViewer } from "../src/viewer.ts";
import { EventsLog } from "../src/agent_runner.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const TS = "2026-08-22T10:00:00+08:00";

function fakeRun(): { cfg: ReturnType<typeof makeConfig>; ledger: Record<string, unknown>; manifest: Manifest } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-kv-"));
  fs.mkdirSync(path.join(repo, ".local", "runs"), { recursive: true });
  const cfg = makeConfig({ symbol: "300308", market: "SZ", repoRoot: repo, runId: "kv1", python: "false" });
  for (const d of ["fetch", "raw", "calcs", "stages"]) fs.mkdirSync(path.join(cfg.runDir, d), { recursive: true });
  fs.writeFileSync(path.join(cfg.runDir, "raw", "a.json"), "{}");
  const ev = (id: string, field: string, value: unknown, extra: Record<string, unknown> = {}) => ({ id, symbol: "300308", market: "SZ", field, value, unit: "元", currency: "CNY", period: "2026-06-30", as_of: "2026-08-22", source: "tencent", endpoint: "qt", fetched_at: TS, adjustment: "none", raw_ref: "raw/a.json", ...extra });
  const f = path.join(cfg.runDir, "fetch", "fetch_profile.json");
  writeJson(f, { script: "fetch_profile", symbol: "300308", market: "SZ", status: "ok", fetched_at: TS, primary_source: "tencent", used_sources: ["tencent", "baostock"], evidence: [ev("ev-aaaaa1", "company_name", "中际旭创", { unit: "text", currency: "n/a" }), ev("ev-aaaaa2", "price", 943)], extra: {}, errors: [], missing: [] });
  const ledger = { fetch_profile: { script: "fetch_profile", argv: [], exit_code: 0, duration_ms: 5, status: "ok", file: "fetch/fetch_profile.json", sha256: sha256File(f), raw_files: { "a.json": sha256File(path.join(cfg.runDir, "raw", "a.json")) }, started_at: TS, finished_at: TS, stage: "profile" } };
  writeJson(path.join(cfg.runDir, "calcs", "01_x.json"), { calculation_id: "calc-0123456789abcdef", function: "ttm_sum", calc_version: "0.2.0", inputs: {}, inputs_resolved: {}, inputs_refs: [{ ref_type: "evidence", ref_id: "ev-aaaaa2" }], output: { status: "ok", value: 1.5, unit: "元", reason: "", details: {} } });
  writeJson(path.join(cfg.runDir, "stages", "profile.json"), { stage: "profile", status: "complete", summary: "光模块龙头;报价正常", evidence_ids: ["ev-aaaaa1"], calculation_ids: [], gaps: [], quote_decision: "normal", quote_decision_reason: "r", moat_tag: "待补" });
  writeJson(path.join(cfg.runDir, "stages", "risk.json"), { stage: "risk", status: "complete", summary: "风险摘要", evidence_ids: [], calculation_ids: [], gaps: [{ operation: "fetch_kline", reason_code: "source_failed", detail: "K 线失败" }],
    counter_evidence: [{ claim: "增长可持续", counter: "一致预期分歧大", evidence_ids: ["ev-aaaaa2"] }], decision_points: [{ what_would_change: "三季报单季环比转负", next_data_point: "2026-10-30 三季报" }], source_conflicts: [],
    knowledge_conflicts: [{ claim: "旧档案:PE 30 倍", refuted_by: "实时 pe_ttm 53.9(ev-aaaaa2)", evidence_ids: ["ev-aaaaa2"] }] });
  fs.writeFileSync(path.join(cfg.runDir, "report.md"), "# 中际旭创(SZ:300308)研究报告 · 状态:complete\n\n## 结论摘要\n事实 ev-aaaaa2\n");
  const manifest: Manifest = { run_id: "kv1", symbol: "300308", market: "SZ", started_at: TS, finished_at: TS, status: "complete", stages: [{ stage: "profile", status: "complete", attempts: 1, errors: [], validator_ok: true }, { stage: "risk", status: "complete", attempts: 1, errors: [], validator_ok: true }],
    engine_version: "t", model: null, model_note: "", provider: { name: "cli-claude", wire_api: "cli_subscription", base_url: null, env_key: "", auth: "subscription_login", profile: "cli-claude", matrix_status: null }, engine: { kind: "local_agent", binary: null }, constitution: { path: "x", sha256: "0".repeat(64) },
    stop_guard: { blocks: 0, terminations: 0 }, calc_version: "0.2.0", repo_version: "t", config_hash: "h", raw_hashes: {}, execution_scope: ["profile", "risk"], partial_run: true,
    thread_id: null, fetch_ledger: {}, evidence_count: 2, calculation_count: 1, evidence_conflicts: [], gate: { ok: true, hits: [] }, exit_code: 0, endpoint_scope: "full", registry_version: "1.0.0" };
  return { cfg, ledger, manifest };
}

test("viewer:生成自包含 viewer.html + report_appendix.md,含证据 / 计算 / 阶段 / 账本", () => {
  const { cfg, ledger, manifest } = fakeRun();
  const run = loadRun(cfg.runDir, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} });
  const { htmlPath, appendixPath } = writeViewer(cfg, run, manifest);
  assert.equal(path.basename(htmlPath), VIEWER_REL);
  assert.equal(path.basename(appendixPath), APPENDIX_REL);
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.ok(html.includes("ev-aaaaa2") && html.includes("calc-0123456789abcdef") && html.includes("fetch_profile") && !/https?:\/\//.test(html.replace(/xmlns|w3\.org/g, "")), "自包含且含关键 id");
  assert.ok(!html.includes("\u003c/script>\u003c/script>"), "data 块转义");
  const md = fs.readFileSync(appendixPath, "utf8");
  assert.ok(md.includes("## A. 取数账本") && md.includes("## G. 证据索引") && md.includes("ev-aaaaa2") && md.includes("ttm_sum") && md.includes("fetch_kline:source_failed"));
  const d = collectViewerData(cfg, run, manifest);
  assert.equal(d.evidence.length, 2);
  assert.ok(renderAppendix(d).includes("raw/a.json"));
});

test("knowledge:归档到 .local/knowledge(runs + latest + 索引),正文只含结构化字段;召回按 as_of+valid_days 判 fresh/stale;refuted 不召回", () => {
  const { cfg, ledger, manifest } = fakeRun();
  const run = loadRun(cfg.runDir, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} });
  const now = new Date("2026-08-22T06:00:00Z");
  const r = archiveRun(cfg, run, manifest, { now });
  assert.ok(fs.existsSync(r.runFile) && fs.existsSync(r.latestFile));
  assert.ok(r.latestFile.startsWith(path.join(cfg.dataRoot, "knowledge", "companies", "SZ_300308")), "归档必须落在用户数据区 .local/knowledge");
  const txt = fs.readFileSync(r.latestFile, "utf8");
  assert.ok(txt.startsWith("---\nschema_version: 1\n") && txt.includes("as_of: 2026-08-22") && txt.includes("valid_days: 90") && txt.includes("name: 中际旭创"));
  assert.ok(txt.includes("## 4. 裁决点") && txt.includes("三季报单季环比转负") && txt.includes("## 6. 对上次档案的裁决") && txt.includes("fetch_kline:source_failed"));
  assert.ok(!txt.includes("建仓"), "归档不得含投资动作词");
  const idx = JSON.parse(fs.readFileSync(path.join(cfg.dataRoot, "knowledge", "manifest.json"), "utf8"));
  assert.equal(idx.companies["SZ:300308"].last_run_id, "kv1");
  // 召回:同日 fresh;91 天后 stale;改 status: refuted 后不召回;截断
  const k1 = recallKnowledge(cfg, { now });
  assert.ok(k1 && k1.status === "fresh" && k1.as_of === "2026-08-22" && k1.text.includes("裁决点") && !k1.text.startsWith("---"));
  const k2 = recallKnowledge(cfg, { now: new Date("2026-11-25T06:00:00Z") });
  assert.equal(k2?.status, "stale");
  const k3 = recallKnowledge(cfg, { now, maxChars: 50 });
  assert.ok(k3?.truncated && k3.text.length < 120);
  fs.writeFileSync(r.latestFile, txt.replace("status: fresh", "status: refuted"));
  assert.equal(recallKnowledge(cfg, { now }), null);
  assert.equal(shDate(new Date("2026-08-22T17:00:00Z")), "2026-08-23");
  assert.equal(companyDir({ dataRoot: "/d", symbol: "AAPL", market: "US" }), path.join("/d", "knowledge", "companies", "US_AAPL"));
});

test("knowledge:归档正文命中合规 gate 的行被整行删除并记录", () => {
  const { cfg, ledger, manifest } = fakeRun();
  writeJson(path.join(cfg.runDir, "stages", "risk.json"), { stage: "risk", status: "complete", summary: "建议逢低买入并加仓", evidence_ids: [], calculation_ids: [], gaps: [], counter_evidence: [], decision_points: [], source_conflicts: [] });
  const run = loadRun(cfg.runDir, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} });
  const r = archiveRun(cfg, run, manifest);
  assert.ok(r.gateRemoved.length >= 1 && r.gateRemoved[0].includes("加仓"));
  assert.ok(!fs.readFileSync(r.latestFile, "utf8").includes("加仓"));
});

test("提示词:召回的 cfg.knowledge 注入为知识层档案;scenario.knowledge 优先;无档案不注入;扩展数据规则只在 full 计划下出现", async () => {
  const { buildStagePrompt } = await import("../src/finance/stages.ts");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-kp-"));
  fs.mkdirSync(path.join(repo, ".local", "runs"), { recursive: true });
  const REPO_REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const base = { symbol: "300308", market: "SZ", repoRoot: REPO_REAL, python: "false" };
  const c0 = makeConfig({ ...base, runId: "kp0" });
  // 研究宪法正文本身就提到「知识层档案」(不可信数据那条),判"有没有注入"要认注入块自己的抬头
  const KB = "**知识层档案**(as_of";
  assert.ok(!buildStagePrompt("profile", c0, { attempt: 0 }).includes(KB));
  const c1 = makeConfig({ ...base, runId: "kp1", knowledge: { as_of: "2026-08-01", text: "旧档案:PE 30 倍", status: "stale" } });
  const p1 = buildStagePrompt("risk", c1, { attempt: 0 });
  assert.ok(p1.includes(KB) && p1.includes("旧档案:PE 30 倍") && p1.includes("状态 stale") && p1.includes("knowledge_conflicts"));
  const c2 = makeConfig({ ...base, runId: "kp2", knowledge: { as_of: "2026-08-01", text: "召回文本" }, scenario: { knowledge: { as_of: "2026-07-01", text: "硬测试注入文本" } } });
  const p2 = buildStagePrompt("profile", c2, { attempt: 0 });
  assert.ok(p2.includes("硬测试注入文本") && !p2.includes("召回文本"), "scenario.knowledge 优先");
  // 扩展数据规则:core 计划不出现;full 计划出现且含"不得解读成买卖信号"
  assert.ok(!buildStagePrompt("risk", c0, { attempt: 0 }).includes("扩展数据(可选"));
  const c3 = makeConfig({ ...base, runId: "kp3", endpointScope: "full" });
  const p3 = buildStagePrompt("risk", c3, { attempt: 0 });
  assert.ok(p3.includes("扩展数据(可选") && p3.includes("不得解读成买卖信号") && p3.includes("extra_findings"));
});


test("knowledge:私密信息 gate 整行删除(邮箱 / 手机 / 用户路径 / 密钥);stale 运行归档为 stale;shouldRecall 在 scenario.knowledge 存在时为 false", () => {
  const { cfg, ledger, manifest } = fakeRun();
  writeJson(path.join(cfg.runDir, "stages", "risk.json"), { stage: "risk", status: "complete", summary: "联系人 someone@example.com 电话 13800138000", evidence_ids: [], calculation_ids: [], gaps: [],
    counter_evidence: [{ claim: "文件在 /Users/someone/Desktop/私密.xlsx", counter: "api_key: sk-xxxx", evidence_ids: [] }], decision_points: [{ what_would_change: "正常裁决点", next_data_point: "2026-10-30" }], source_conflicts: [] });
  const run = loadRun(cfg.runDir, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} });
  const r = archiveRun(cfg, run, { ...manifest, status: "stale" } as typeof manifest);
  const txt = fs.readFileSync(r.latestFile, "utf8");
  assert.ok(r.gateRemoved.length >= 2);
  assert.ok(!txt.includes("someone@example.com") && !txt.includes("13800138000") && !txt.includes("/Users/someone") && !txt.includes("sk-xxxx"));
  assert.ok(txt.includes("正常裁决点"));
  assert.ok(txt.includes("status: stale") && txt.includes("运行状态 stale"));
  assert.equal(recallKnowledge(cfg)?.status, "stale");
  assert.deepEqual(sensitiveHits("a\nfoo@bar.com\n密钥: x\nok").map((h) => h.line), [2, 3]);
  assert.equal(shouldRecall({ knowledgeRecall: true, scenario: null }), true);
  assert.equal(shouldRecall({ knowledgeRecall: true, scenario: { knowledge: { as_of: "2026-01-01", text: "t" } } }), false);
  assert.equal(shouldRecall({ knowledgeRecall: false, scenario: null }), false);
});

test("viewer:DOM id 唯一;agent 写的 </script> / HTML 载荷不会逃出数据块或表格", () => {
  const { cfg, ledger, manifest } = fakeRun();
  writeJson(path.join(cfg.runDir, "stages", "risk.json"), { stage: "risk", status: "complete", summary: "</script><script>alert(1)</script><img src=x onerror=alert(2)>", evidence_ids: [], calculation_ids: [], gaps: [], counter_evidence: [], decision_points: [], source_conflicts: [] });
  fs.writeFileSync(path.join(cfg.runDir, "report.md"), "# r\n</script><b>x</b>\n");
  const run = loadRun(cfg.runDir, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} });
  const { htmlPath } = writeViewer(cfg, run, manifest);
  const html = fs.readFileSync(htmlPath, "utf8");
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "DOM id 重复:" + ids.join(","));
  const dataBlock = html.slice(html.indexOf('<script id="data"'), html.indexOf("</script>", html.indexOf('<script id="data"')));
  assert.ok(!dataBlock.includes("</script") && !dataBlock.includes("<img"), "数据块内不得出现任何未转义的 < 标签");
  assert.ok(!html.includes("<img src=x onerror=alert(2)>"), "静态 HTML 不含原样载荷");
});

test("knowledge:frontmatter 动态字段(公司名 / 来源)单行规范化 + 敏感回退;11 位金额不被当成手机号", () => {
  assert.equal(safeFmValue("中际旭创", "300308"), "中际旭创");
  assert.equal(safeFmValue("恶意\nname: x\n# 注入", "300308"), "恶意 name x 注入");
  assert.equal(safeFmValue("联系 foo@bar.com", "300308"), "300308");
  assert.equal(safeFmValue("建议建仓的公司", "300308"), "300308");
  assert.equal(sensitiveHits("| net_profit_parent_cum | 13651149693.27 | 元 |").length, 0, "金额不是手机号");
  assert.equal(sensitiveHits("电话 13800138000。").length, 1);
  const { cfg, ledger, manifest } = fakeRun();
  const f = path.join(cfg.runDir, "fetch", "fetch_profile.json");
  const env = JSON.parse(fs.readFileSync(f, "utf8"));
  env.evidence[0].value = "恶意公司\nstatus: refuted";
  env.used_sources = ["tencent", "evil\nvalid_days: 1"];
  fs.writeFileSync(f, JSON.stringify(env));
  (ledger.fetch_profile as { sha256: string }).sha256 = sha256File(f);
  const run = loadRun(cfg.runDir, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} });
  const r = archiveRun(cfg, run, manifest);
  const txt = fs.readFileSync(r.latestFile, "utf8");
  const fm = txt.split("\n---\n")[0];
  assert.ok(!fm.includes("\nstatus: refuted") && !fm.includes("\nvalid_days: 1\n") && fm.includes("name: 恶意公司 status refuted"), fm);
  assert.equal(recallKnowledge(cfg)?.status, "fresh");
});

test("knowledge:召回截断按章节——插件标 tail 的章节保留,只截中间章节", () => {
  // 标题从插件契约取:写死字面量的话,插件改标题时这条会"绿着失效"(重构前的 /^## (4\.|5\.|6\.)/ 正是这样)
  const secs = currentPlugin().archive.sections;
  const heads = secs.filter((x) => !x.tail), tails = secs.filter((x) => x.tail);
  assert.ok(heads.length && tails.length, "本条测试要求插件同时有 head 与 tail 章节");
  const bulk = Array.from({ length: 400 }, (_, i) => `| f${i} | ${i} | 元 | 2026 | s | d | 90 | ev-${i.toString(16).padStart(6, "0")} |`);
  const body = [
    ...heads.flatMap((x, i) => [`## ${x.title}`, ...(i === heads.length - 1 ? bulk : [`正文 ${i}`])]),
    ...tails.flatMap((x, i) => [`## ${x.title}`, `尾部条目 T${i}`]),
  ].join("\n");
  const r = truncateBySection(body, 3000);
  assert.ok(r.truncated && r.text.length <= 3200, String(r.text.length));
  for (const [i, x] of tails.entries()) assert.ok(r.text.includes(`## ${x.title}`) && r.text.includes(`尾部条目 T${i}`), `尾部章节必须完整保留:${x.title}`);
  assert.ok(r.text.includes("本章已截断"), "中间章节被截断并标记");
  assert.equal(truncateBySection("short", 100).truncated, false);
  // 尾部本身超长 → 按比例截但仍在上限附近
  const t0 = tails[0].title;
  const longTail = [`## ${heads[0].title}`, "a", `## ${t0}`, ...Array.from({ length: 500 }, (_, i) => `- 裁决点 ${i}`)].join("\n");
  const r2 = truncateBySection(longTail, 2000);
  assert.ok(r2.truncated && r2.text.length <= 2200 && r2.text.includes(`## ${t0}`));
  // 显式传 tailTitles(旧档案 / 第三方标题)也要生效
  assert.ok(truncateBySection(["## A", "x".repeat(4000), "## B", "keep"].join("\n"), 1000, ["B"]).text.includes("keep"));
});
test("knowledge:档案 frontmatter 是不可信输入——valid_days 异常值不能把召回带崩", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vra-vd-"));
  const cfg = makeConfig({ symbol: "VD1", market: "SZ", repoRoot: repo, runId: "vd1", python: "false" });
  const dir = companyDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  const fallback = currentPlugin().archive.validDays;
  const write = (vd: string) => fs.writeFileSync(path.join(dir, "latest.md"),
    `---\nschema_version: 1\nsymbol: "VD1"\nas_of: ${shDate()}\nstatus: fresh\nvalid_days: ${vd}\n---\n正文\n`);
  // 1e100 不夹紧的话 as_of + valid_days 天会超出 Date 范围 → RangeError(不是"永远 fresh")
  for (const bad of ["1e100", "-1", "0", "abc", "99999999999999999999", "1.5"]) {
    write(bad);
    const r = recallKnowledge(cfg);
    assert.equal(r?.valid_days, fallback, `valid_days=${bad} 应回退到插件声明的 ${fallback}`);
    assert.ok(r?.status === "fresh" || r?.status === "stale");
  }
  // 合法值照常生效
  write("30");
  assert.equal(recallKnowledge(cfg)?.valid_days, 30);
});

test("knowledge:截断严格不超预算 + 标题整行匹配 + 匹配不上退到保护最后一节(Codex archive-r1)", () => {
  const sec = (t: string, text: string) => `## ${t}\n${text}`;
  const big = "x".repeat(5000);
  // 1) 尾部本身就超预算时,总长仍 <= max(旧实现会多带两个 marker 溢出)
  for (const max of [80, 300, 2000]) {
    const r = truncateBySection([sec("H", big), sec("T", big)].join("\n"), max, ["T"]);
    assert.ok(r.text.length <= max, `max=${max} 实际=${r.text.length}`);
  }
  // 2) marker 都放不下的极小预算也不许溢出
  assert.ok(truncateBySection(sec("T", big), 5, ["T"]).text.length <= 5);
  // 3) 标题必须整行相等:tail 标题「风险」不能把更早的「风险因素」一节吃成尾部
  const body = [sec("风险因素", big), sec("中间", "m"), sec("风险", "真尾部")].join("\n");
  const r3 = truncateBySection(body, 400, ["风险"]);
  // 判别点就是这一条:用 startsWith 的话 tailIdx 会落在「风险因素」那节,「真尾部」根本进不了结果
  assert.ok(r3.text.includes("真尾部"), "真正的 tail 章节必须保住(整行匹配才不会被「风险因素」抢先)");
  assert.ok(r3.text.includes("本章已截断"), "「风险因素」应落在被截的 head 里");
  // 4) 一节都匹配不上(档案是改标题之前写的)→ 退到保护最后一节,而不是尾部保护整个失效
  const r4 = truncateBySection([sec("旧标题A", big), sec("旧标题B", "最后一节的内容")].join("\n"), 300, ["现在的标题"]);
  assert.ok(r4.text.includes("最后一节的内容"), "匹配不上时要退到保护最后一节");
});

test("knowledge:表格单元格里的竖线必须转义,否则字段整体错位(Codex archive-r1 P1)", () => {
  const { cfg, ledger, manifest } = fakeRun();
  const run = loadRun(cfg.runDir, ledger as never);
  for (const e of run.evidence.values()) { (e as { value: unknown }).value = "10 | 20"; break; }
  const { body } = buildArchiveMarkdown(cfg, run, manifest, "2026-08-22");
  const BS = String.fromCharCode(92);
  const cols = (row: string) => row.split(BS + "|").join("").split("|").length;
  // 逐张表比:档案里有 8 列的证据表也有 6 列的结论表,混在一起比会误判
  const lines = body.split("\n");
  let header = -1, checked = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("|---")) { header = cols(lines[i - 1]); continue; }
    if (header > 0 && lines[i].startsWith("| ")) { assert.equal(cols(lines[i]), header, `列数不一致,表格被撑坏:${lines[i].slice(0, 120)}`); checked += 1; }
    else if (!lines[i].startsWith("| ")) header = -1;
  }
  assert.ok(checked >= 3, `应检查到多张表的数据行,实际 ${checked}`);
  assert.ok(body.includes("10 " + BS + "| 20"), "含竖线的证据值必须转义后落进单元格");
});

test("knowledge:反斜杠+竖线不能击穿转义 / max 异常值 / 兜底保护最后 N 节(Codex archive-r2)", () => {
  const BS = String.fromCharCode(92);
  // 1) 输入本身就带 反斜杠+竖线:只替竖线的话两个反斜杠互相转义掉,竖线又变回分隔符
  const { cfg, ledger, manifest } = fakeRun();
  const run = loadRun(cfg.runDir, ledger as never);
  for (const e of run.evidence.values()) { (e as { value: unknown }).value = "A" + BS + "|B"; break; }
  const { body } = buildArchiveMarkdown(cfg, run, manifest, "2026-08-22");
  const cols = (row: string) => row.split(BS + BS).join("").split(BS + "|").join("").split("|").length;
  const lines = body.split("\n");
  let header = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("|---")) { header = cols(lines[i - 1]); continue; }
    if (header > 0 && lines[i].startsWith("| ")) assert.equal(cols(lines[i]), header, `表格被撑坏:${lines[i].slice(0, 120)}`);
    else if (!lines[i].startsWith("| ")) header = -1;
  }
  assert.ok(body.includes("A" + BS + BS + BS + "|B"), "反斜杠要先转义,竖线再转义");

  // 2) max 是负数 / NaN 时不许违约。⚠️ 这是**契约测试不是回归测试**:去掉归一化那行它也不会红(见 knowledge.ts 注释)
  const sec = (t: string, text: string) => `## ${t}\n${text}`;
  const long = [sec("H", "x".repeat(3000)), sec("T", "尾")].join("\n");
  for (const bad of [-1, Number.NaN, -1e9]) {
    const r = truncateBySection(long, bad as number, ["T"]);
    assert.equal(r.text.length, 0, `max=${String(bad)} 应归一化为 0`);
    assert.equal(r.truncated, true);
  }

  // 2b) Infinity = 预算无限 → 全文照返,不能被归一化成 0 吃掉(Codex archive-r3)
  assert.deepEqual(truncateBySection(long, Number.POSITIVE_INFINITY, ["T"]), { text: long, truncated: false });
  // 2c) 显式传空 tailTitles = 调用方明说"没有尾部" → 不做最后一节兜底
  const noTail = truncateBySection([sec("A", "x".repeat(3000)), sec("B", "最后一节")].join("\n"), 300, []);
  assert.ok(!noTail.text.includes("最后一节"), "调用方说没有尾部就不该兜底保护最后一节");

  // 3) 插件有多节 tail 而档案标题全改过 → 兜底要保住最后 N 节,不是只保最后一节
  const body3 = [sec("旧A", "x".repeat(3000)), sec("旧B", "倒数第二节"), sec("旧C", "最后一节")].join("\n");
  const r3 = truncateBySection(body3, 400, ["新甲", "新乙"]);  // 当前插件有 2 节 tail
  assert.ok(r3.text.includes("最后一节") && r3.text.includes("倒数第二节"), "两节 tail 都要保住");
  // 只有 1 节 tail 时仍只保最后一节
  const r1 = truncateBySection(body3, 400, ["新甲"]);
  assert.ok(r1.text.includes("最后一节") && !r1.text.includes("倒数第二节"), "1 节 tail 就只保最后一节");
});

test("viewer / 附录:生成后必须过合规复验,且不再声称'不含任何建议'(全审 r3-P1-3)", () => {
  const { cfg, ledger, manifest } = fakeRun();
  // 把建议塞进阶段产物的自由文本 —— 附录与 HTML 都会把它抄过去
  const sp = path.join(cfg.runDir, "stages", "risk.json");
  if (fs.existsSync(sp)) {
    const rec = JSON.parse(fs.readFileSync(sp, "utf8"));
    writeJson(sp, { ...rec, summary: `${rec.summary ?? ""} 建议逢低买入并加仓至三成。` });
  }
  const run = loadRun(cfg.runDir, ledger as never);
  const v = writeViewer(cfg, run, manifest);
  const appendix = fs.readFileSync(v.appendixPath, "utf8");
  const html = fs.readFileSync(v.htmlPath, "utf8");
  assert.ok(!appendix.includes("建议逢低买入") && !html.includes("建议逢低买入"), "命中的字符串必须被替换掉");
  // 🔴 结构不能被破坏:第一版按行删除,把整个 `<script id="data">` 数据块删没了,页面直接报废
  //    (修复复审 r1-P2-4)。现在改成数据层逐字符串替换,结构完全不动。
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "数据块必须还在(第一版会把它整行删掉)");
  assert.doesNotThrow(() => JSON.parse(m![1].replace(/\\u003c/g, "<")), "数据块必须仍是合法 JSON");
  assert.ok(html.includes("〔已按产出红线移除〕"), "命中的字符串该留下占位,而不是悄悄消失");
  // 🔴 声称必须与实现一致:原文写着"不含任何判断与建议"而代码从不复验
  assert.ok(!appendix.includes("不含任何判断与建议") && !html.includes("不含任何投资动作建议"),
    "不许再声称代码做不到的事");
  assert.ok(appendix.includes("已过合规复验") && html.includes("已过合规复验"));
});

test("events 脱敏:主目录用户名 / 内网地址 / user:pass 都不许进事件流(全审 r3-P1-4)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-red-"));
  const log = new EventsLog(path.join(d, "events.jsonl"), []);
  log.append({ type: "command", command: "cat /Users/alice/x", output_tail: "proxy http://10.0.0.8:3128",
    url: "https://user:pw@api.example.com/v1", host: "http://build-host.local:4000" });
  const txt = fs.readFileSync(path.join(d, "events.jsonl"), "utf8");
  for (const leaked of ["/Users/alice", "10.0.0.8", "user:pw@", "build-host.local"]) {
    assert.ok(!txt.includes(leaked), `仍泄露 ${leaked}:${txt}`);
  }
  for (const marker of ["[USER]", "[PRIVATE_IP]", "[REDACTED_USERINFO]", "[INTERNAL_HOST]"]) {
    assert.ok(txt.includes(marker), `缺 ${marker}`);
  }
  // 摘要必须基于脱敏后内容(否则审计哈希对不上)
  assert.equal(sha256File(path.join(d, "events.jsonl")), log.digest());
});

test("viewer 净化:对象键也要查,结构性字符串不许动(修复复审 r2-P1-1 / P2-3)", () => {
  const { cfg, ledger, manifest } = fakeRun();
  const run = loadRun(cfg.runDir, ledger as never);
  const raw = collectViewerData(cfg, run, manifest) as unknown as Record<string, unknown>;
  // 🔴 键本身载着建议(calc 的 inputs / output.details 是自由形状)——第二版只查值,键原样外传
  (raw as { calcs?: { inputs?: Record<string, unknown> }[] }).calcs?.push({ inputs: { 建议建仓: "30%" } } as never);
  // 🔴 结构性字符串恰好命中英文规则 —— 第二版会把它整串换掉,证据就追不回去了
  (raw as { run: Record<string, unknown> }).run.run_id = "BUY";
  const v = writeViewer(cfg, run, manifest);
  const html = fs.readFileSync(v.htmlPath, "utf8");
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "数据块必须还在");
  const data = JSON.parse(m![1].replace(/\\u003c/g, "<"));
  assert.equal(data.run.run_id, cfg.runId, "run_id 这类身份字段不该被净化改写");
  // 直接验函数行为(collectViewerData 每次重算,上面的注入进不了 writeViewer)
  const probe = scrubForTest({ run: { run_id: "BUY", raw_ref: "raw/BUY" }, note: "建议买入", bad: { 建议建仓: "30%" } });
  assert.equal(probe.value.run.run_id, "BUY", "身份字段原样");
  assert.equal(probe.value.run.raw_ref, "raw/BUY", "路径原样");
  assert.equal(probe.value.note, "〔已按产出红线移除〕", "自由文本要净化");
  assert.ok(!Object.keys(probe.value.bad).includes("建议建仓"), "命中的键也要换掉");
  assert.ok(Object.keys(probe.value.bad)[0].startsWith("〔已移除键-"), "占位键要带编号,避免多个键碰撞丢数据");
});

test("viewer 净化的两个边界:占位键避开原有键;只受控字段才放行(修复复审 r3-P2)", () => {
  // 🔴 占位键要避开**原有键**,否则会覆盖别人的数据(编号只保证彼此不撞是不够的)
  const r = scrubForTest({ "〔已移除键-1〕": "原有审计数据", 建议买入: "另一项数据" });
  const keys = Object.keys(r.value);
  assert.equal(keys.length, 2, `不许覆盖已有键:${JSON.stringify(r.value)}`);
  assert.equal((r.value as Record<string, unknown>)["〔已移除键-1〕"], "原有审计数据");

  // 🔴 source / endpoint / field 这些 schema 上只要求"非空字符串",不是受控字段 —— 必须净化
  const free = scrubForTest({ source: "建议买入并建仓三成", endpoint: "fetch_quote", field: "close" });
  assert.equal(free.value.source, "〔已按产出红线移除〕", "不受控字段必须过 gate");
  assert.equal(free.value.endpoint, "fetch_quote", "正常值不该被动");
  // 真正受控的身份字段照旧不碰
  const ident = scrubForTest({ run_id: "BUY", raw_ref: "raw/BUY", function: "stop-loss", adjustment: "none" });
  assert.deepEqual(ident.value, { run_id: "BUY", raw_ref: "raw/BUY", function: "stop-loss", adjustment: "none" });

  // 🔴 键名不等于位置:自由形状里的同名 `status` 装得下一句建议,只按键名放行就是后门(复审 r4-P2)
  const nested = scrubForTest({ extra_findings: [{ topic: "其他", status: "建议建仓三成" }], status: "ok" });
  const nestedItem = (nested.value as { extra_findings: { status: string }[] }).extra_findings[0];
  assert.equal(nestedItem.status, "〔已按产出红线移除〕", "自由形状里的 status 必须过 gate");
  assert.equal((nested.value as { status: string }).status, "ok", "受控形状的枚举值不该被动");
});

test("🔴 知识索引的读改写持锁:另一个进程正持锁改索引时,归档等它写完再读,两边的项都在(审计第三轮 A1)", async () => {
  const { spawn } = await import("node:child_process");
  const { cfg, ledger, manifest } = fakeRun();
  const run = loadRun(cfg.runDir, ledger as never, { plan: stageScripts(), critical: packCriticalScripts(), endpoints: {} });
  const idxPath = path.join(cfg.dataRoot, "knowledge", "manifest.json");
  fs.mkdirSync(path.dirname(idxPath), { recursive: true });
  const took = path.join(cfg.dataRoot, "child-took-lock");
  // 子进程:拿到锁 → 读索引 → 停 600ms → 加一项写回(没持锁的归档会在这期间读到旧索引,然后被子进程整份覆盖)
  const code = `import fs from "node:fs";
import { withLock } from ${JSON.stringify(new URL("../src/ledger.ts", import.meta.url).href)};
const P = ${JSON.stringify(idxPath)};
withLock(P, () => {
  const idx = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, "utf8")) : { schema_version: 1, companies: {} };
  fs.writeFileSync(${JSON.stringify(took)}, "1");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  idx.companies["US:OTHER"] = { dir: "US_OTHER" };
  fs.writeFileSync(P, JSON.stringify(idx));
});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(took)) {
    if (Date.now() > deadline) { child.kill(); throw new Error("子进程没拿到锁"); }
    await new Promise((r) => setTimeout(r, 10));
  }
  archiveRun(cfg, run, manifest);
  assert.equal(await exited, 0);
  const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
  assert.ok(idx.companies["US:OTHER"], "另一个进程加的那项还在");
  assert.equal(idx.companies["SZ:300308"]?.last_run_id, "kv1", "这次归档的那项也在");
  assert.equal(fs.existsSync(`${idxPath}.lock`), false, "锁用完放掉");
});
