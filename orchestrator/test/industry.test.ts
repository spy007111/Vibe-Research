import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyIndustryGate, detectIndustryTags, industryPromptBlock, keywordHit, loadIndustryTags, writeIndustryFile } from "../src/finance/industry.ts";
import { judgeIndustryThermometer, judgePolicyAccess } from "../src/finance/hardtest.ts";
import { loadRegistry } from "../src/registry.ts";
import { extraTopics } from "../src/schemas.ts";
import { writeJson } from "../src/fsutil.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeRun(profileTexts: string[], swCodes: string[], boards: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-"));
  fs.mkdirSync(path.join(d, "fetch"));
  writeJson(path.join(d, "fetch", "fetch_profile.json"), { evidence: profileTexts.map((v, i) => ({ id: `ev-p${i}`, field: i === 0 ? "industry_em" : "industry_csrc", value: v })) });
  writeJson(path.join(d, "fetch", "sw_industry.json"), { evidence: swCodes.map((v, i) => ({ id: `ev-s${i}`, field: i === 0 ? "sw_industry_code" : "sw_l2_code", value: v })) });
  writeJson(path.join(d, "fetch", "em_concept_blocks.json"), { evidence: boards.map((v, i) => ({ id: `ev-b${i}`, field: "board_membership", value: v })) });
  return d;
}

test("产业标签表可加载,ai_compute 的温度计端点在注册表里且带 industry_tags", () => {
  const table = loadIndustryTags(repoRoot)!;
  assert.ok(table && table.tags.ai_compute);
  const reg = loadRegistry(repoRoot)!;
  const byId = new Map(reg.endpoints.map((e) => [e.id, e]));
  for (const id of table.tags.ai_compute.thermometers) {
    const e = byId.get(id)!;
    assert.ok(e, id); assert.deepEqual(e.industry_tags, ["ai_compute"]); assert.equal(e.layer, "13 产业温度计");
  }
  assert.ok(extraTopics().risk.includes("产业温度计"));
});

test("产业判定:中际旭创式(通信设备 + 申万 7302 + 光模块概念)命中 ai_compute;银行命中 0 标签;门控只跳过带标签的端点", () => {
  const table = loadIndustryTags(repoRoot)!;
  const hit = fakeRun(["通信设备", "C39计算机、通信和其他电子设备制造业"], ["730204", "730200"], ["通信设备", "光模块", "山东板块", "HS300_"]);
  const det = detectIndustryTags(hit, table);
  assert.deepEqual(det.tags, ["ai_compute"]);
  assert.ok(det.matched.ai_compute.some((x) => x.startsWith("sw:7302")) && det.matched.ai_compute.some((x) => x.startsWith("光模块←")));
  const miss = fakeRun(["银行", "J66货币金融服务"], ["480000", "480100"], ["银行", "HS300_", "融资融券"]);
  const det2 = detectIndustryTags(miss, table);
  assert.deepEqual(det2.tags, []);
  const endpoints = { tw_monthly_revenue: { industry_tags: ["ai_compute"] }, gpu_rent_thermometer: { industry_tags: ["ai_compute"] }, exa_market_voice: {} , em_margin_trading: {} };
  const g1 = applyIndustryGate(["exa_market_voice", "tw_monthly_revenue", "gpu_rent_thermometer", "em_margin_trading"], endpoints, det.tags);
  assert.deepEqual(g1.included, ["exa_market_voice", "tw_monthly_revenue", "gpu_rent_thermometer", "em_margin_trading"]);
  const g2 = applyIndustryGate(["exa_market_voice", "tw_monthly_revenue", "gpu_rent_thermometer", "em_margin_trading"], endpoints, det2.tags);
  assert.deepEqual(g2.included, ["exa_market_voice", "em_margin_trading"]);
  assert.deepEqual(g2.skipped.map((s) => s.id), ["tw_monthly_revenue", "gpu_rent_thermometer"]);
  // 落盘 + 提示词块
  const f = writeIndustryFile(hit, table, det, g1);
  assert.ok(fs.existsSync(path.join(hit, "fetch", "_industry.json")) && f.guards.ai_compute.includes("折旧参考线"));
  const block = industryPromptBlock(hit);
  assert.ok(block.includes("ai_compute") && block.includes("tw_monthly_revenue / gpu_rent_thermometer") && block.includes("护栏句必须与数字同段出现"));
  writeIndustryFile(miss, table, det2, g2);
  assert.equal(industryPromptBlock(miss), "", "无标签 → 提示词不注入温度计块");
});

test("空运行目录(profile 还没拉)→ 0 信号 0 标签,不抛", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-empty-"));
  const det = detectIndustryTags(d, loadIndustryTags(repoRoot)!);
  assert.deepEqual(det, { tags: [], matched: {}, signals: 0 });
});

test("industry-r1:弱关键词单独不挂载(通信设备 / IDC 无申万前缀 → 0 标签),弱词 + 申万前缀 → 挂载,ASCII 缩写按词边界", () => {
  const table = loadIndustryTags(repoRoot)!;
  const weakOnly = fakeRun(["通信设备", "C39计算机、通信和其他电子设备制造业"], ["270500", "270000"], ["通信设备", "IDC概念", "HS300_"]);
  assert.deepEqual(detectIndustryTags(weakOnly, table).tags, [], "宽泛行业词单独不挂整套算力温度计");
  const weakPlusSw = fakeRun(["通信设备"], ["730202", "730200"], ["通信设备"]);
  assert.deepEqual(detectIndustryTags(weakPlusSw, table).tags, ["ai_compute"]);
  const strongOnly = fakeRun(["电子", "C39"], ["270400"], ["CPO概念", "HS300_"]);
  assert.deepEqual(detectIndustryTags(strongOnly, table).tags, ["ai_compute"]);
  assert.ok(keywordHit("CPO概念", "CPO") && keywordHit("gpu 算力租赁", "GPU") && !keywordHit("GPUS Inc", "GPU") && !keywordHit("XGPU", "GPU") && keywordHit("光模块龙头", "光模块"));
});

test("industry-r1:带 industry_tags 的端点必须 optional(注册表校验)", () => {
  const reg = loadRegistry(repoRoot)!;
  for (const e of reg.endpoints) if (e.industry_tags?.length) assert.ok(!Object.values(e.stages ?? {}).includes("required"), e.id);
});

test("industry-r1:判定函数——数字行不引温度计 id 即未绑定(不回退全池);引台系 id 的行缺差分护栏 / 引 GPU id 的行缺折旧线护栏都判失败", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-judge-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const ev = [
    { id: "ev-a1a1a1a1a1a1", field: "tw_monthly_revenue", value: 192.07, unit: "亿新台币", currency: "TWD", period: "2026-07-01..2026-07-31", as_of: "2026-08-23", source: "finmind", symbol: "2383", market: "TW" },
    { id: "ev-a2a2a2a2a2a2", field: "tw_monthly_revenue_mom_pct", value: 8.3, unit: "%", currency: "n/a", period: "2026-07-01..2026-07-31", as_of: "2026-08-23", source: "finmind", symbol: "2383", market: "TW" },
    { id: "ev-b1b1b1b1b1b1", field: "gpu_spot_median_usd_per_gpu_hr", value: 6.88, unit: "美元/卡时", currency: "USD", period: "2026-08-23", as_of: "2026-08-23", source: "vast", symbol: "B200", market: "US" },
    { id: "ev-b2b2b2b2b2b2", field: "gpu_spot_offer_count", value: 23, unit: "档", currency: "n/a", period: "2026-08-23", as_of: "2026-08-23", source: "vast", symbol: "B200", market: "US" },
  ];
  writeJson(path.join(d, "evidence.json"), ev);
  writeJson(path.join(d, "fetch", "_industry.json"), { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5, titles: {}, guards: {}, thermometers: {} });
  writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "产业温度计", summary: "x", evidence_ids: ["ev-a1a1a1a1a1a1", "ev-b1b1b1b1b1b1"] }] });
  writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, industry_tags: { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5 }, fetch_ledger: { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
  const good = `# 报告\n\n## 事实\n\n- 营收 x [ev-zz]\n\n## 产业温度计\n\n- 2026-07 · FinMind · 台光月营收 192.07 亿新台币、环比 8.3%;护栏:台光须与金像电差分后归因,不能单独归因。[ev-a1a1a1a1a1a1] [ev-a2a2a2a2a2a2]\n- 2026-08-23 · Vast · B200 现货中位 6.88 美元/卡时、在租 23 档;护栏:3 美元/卡时是设备折旧参考线不是完整经济保本线。[ev-b1b1b1b1b1b1] [ev-b2b2b2b2b2b2]\n\n## 裁决点\n\n- x\n`;
  fs.writeFileSync(path.join(d, "report.md"), good);
  const r1 = judgeIndustryThermometer(d);
  assert.ok(r1.checks.filter((c) => /绑到|护栏/.test(c.name)).every((c) => c.pass), JSON.stringify(r1.checks.filter((c) => !c.pass)));
  // 假绿形态 ①:数字行不带 id,id 集中在另一行 → 数字未绑定
  fs.writeFileSync(path.join(d, "report.md"), good.replace("6.88 美元/卡时、在租 23 档;护栏:3 美元/卡时是设备折旧参考线不是完整经济保本线。[ev-b1b1b1b1b1b1] [ev-b2b2b2b2b2b2]", "6.88 美元/卡时、在租 23 档。\n- 折旧参考线、差分、不能单独归因 [ev-b1b1b1b1b1b1] [ev-b2b2b2b2b2b2]"));
  const r2 = judgeIndustryThermometer(d);
  assert.ok(!r2.checks.find((c) => /绑到/.test(c.name))!.pass, "数字行无 id 不得回退全池");
  // 假绿形态 ②:护栏只在章末出现一次,引 GPU id 的数字行没有折旧线护栏
  fs.writeFileSync(path.join(d, "report.md"), good.replace(";护栏:3 美元/卡时是设备折旧参考线不是完整经济保本线", ""));
  const r3 = judgeIndustryThermometer(d);
  assert.ok(!r3.checks.find((c) => /护栏/.test(c.name))!.pass, "护栏须与数字同行");
});

test("industry-r2:护栏反向表述判缺;温度计 id 出现在结论摘要且未写明「不是本公司数据」判泄漏;标签表缺失直接抛", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-r2-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const ev = [
    { id: "ev-a1a1a1a1a1a1", field: "tw_monthly_revenue", value: 192.07, unit: "亿新台币", currency: "TWD", period: "2026-07-01..2026-07-31", as_of: "2026-08-23", source: "finmind", symbol: "2383", market: "TW" },
    { id: "ev-b1b1b1b1b1b1", field: "gpu_spot_median_usd_per_gpu_hr", value: 6.88, unit: "美元/卡时", currency: "USD", period: "2026-08-23", as_of: "2026-08-23", source: "vast", symbol: "B200", market: "US" },
  ];
  writeJson(path.join(d, "evidence.json"), ev);
  writeJson(path.join(d, "fetch", "_industry.json"), { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5, titles: {}, guards: {}, thermometers: {} });
  writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "产业温度计", summary: "x", evidence_ids: ["ev-a1a1a1a1a1a1", "ev-b1b1b1b1b1b1"] }] });
  writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, industry_tags: { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5 }, fetch_ledger: { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
  const base = (tw: string, gpu: string, summary = "- 公司基本面 x") => `# 报告\n\n## 结论摘要\n\n${summary}\n\n## 产业温度计\n\n- 2026-07 · FinMind · 台光月营收 192.07 亿新台币;${tw} [ev-a1a1a1a1a1a1]\n- 2026-08-23 · Vast · B200 现货中位 6.88 美元/卡时;${gpu} [ev-b1b1b1b1b1b1]\n\n## 裁决点\n\n- x\n`;
  const okTw = "护栏:台光须与金像电差分后归因,不能单独归因", okGpu = "护栏:3 美元/卡时是设备折旧参考线不是完整经济保本线";
  fs.writeFileSync(path.join(d, "report.md"), base(okTw, okGpu));
  assert.ok(judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass);
  fs.writeFileSync(path.join(d, "report.md"), base("无需与金像电差分,可以单独归因英伟达链", okGpu));
  assert.ok(!judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass, "台系反向表述");
  fs.writeFileSync(path.join(d, "report.md"), base(okTw, "3 美元不是折旧参考线,而是完整保本线"));
  assert.ok(!judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass, "GPU 反向表述");
  fs.writeFileSync(path.join(d, "report.md"), base(okTw, okGpu, "- 中际旭创月营收 192.07 亿新台币 [ev-a1a1a1a1a1a1]"));
  assert.ok(!judgeIndustryThermometer(d).checks.find((c) => /只出现在/.test(c.name))!.pass, "结论摘要里把温度计写成本公司");
  fs.writeFileSync(path.join(d, "report.md"), base(okTw, okGpu, "- 上游产业链上下游数据显示台光月营收 192.07 亿新台币,不是本公司数据 [ev-a1a1a1a1a1a1]"));
  assert.ok(judgeIndustryThermometer(d).checks.find((c) => /只出现在/.test(c.name))!.pass, "写明不是本公司数据的交叉引用放行");
  assert.throws(() => loadIndustryTags(fs.mkdtempSync(path.join(os.tmpdir(), "vra-no-table-"))), /缺失/);
});

test("industry-r3:标签表为数组 / 空对象 / 字段为空都抛;合规的自然写法不被护栏正则误杀", () => {
  const mk = (body: unknown) => { const r = fs.mkdtempSync(path.join(os.tmpdir(), "vra-tags-")); fs.mkdirSync(path.join(r, "datasources")); fs.writeFileSync(path.join(r, "datasources", "industry_tags.json"), JSON.stringify(body)); return r; };
  assert.throws(() => loadIndustryTags(mk({ tags: [] })), /非法/);
  assert.throws(() => loadIndustryTags(mk({ tags: {} })), /非法/);
  assert.throws(() => loadIndustryTags(mk({ tags: { x: { strong_keywords: [], thermometers: ["a"], guard: "g" } } })), /非法/);
  assert.throws(() => loadIndustryTags(mk({ tags: { x: { strong_keywords: ["a"], thermometers: ["a"], guard: "" } } })), /非法/);
  assert.ok(loadIndustryTags(mk({ tags: { x: { strong_keywords: ["a"], thermometers: ["a"], guard: "g" } } })).tags.x);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-ind-r3-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  writeJson(path.join(d, "evidence.json"), [
    { id: "ev-a1a1a1a1a1a1", field: "tw_monthly_revenue", value: 192.07, unit: "亿新台币", currency: "TWD", period: "2026-07-01..2026-07-31", as_of: "2026-08-23", source: "finmind", symbol: "2383", market: "TW" },
    { id: "ev-b1b1b1b1b1b1", field: "gpu_spot_median_usd_per_gpu_hr", value: 6.88, unit: "美元/卡时", currency: "USD", period: "2026-08-23", as_of: "2026-08-23", source: "vast", symbol: "B200", market: "US" },
  ]);
  writeJson(path.join(d, "fetch", "_industry.json"), { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5, titles: {}, guards: {}, thermometers: {} });
  writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "产业温度计", summary: "x", evidence_ids: ["ev-a1a1a1a1a1a1", "ev-b1b1b1b1b1b1"] }] });
  writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, industry_tags: { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5 }, fetch_ledger: { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
  const rep = (tw: string, gpu: string) => `# 报告\n\n## 产业温度计\n\n- 台光月营收 192.07 亿新台币;${tw} [ev-a1a1a1a1a1a1]\n- B200 租金 6.88 美元/卡时;${gpu} [ev-b1b1b1b1b1b1]\n\n## 裁决点\n\n- x\n`;
  const naturalTw = ["该读数不可单独归因,需与金像电差分后再判断", "应先与金像电差分,差分后方可归因", "必须与金像电差分后归因,不能单独归因", "台光单月营收未能单独归因,需与金像电差分后再判断"];
  // ht17 真实写法:否定词与"保本线"之间带修饰("不是含电力、机房、运维的完整经济保本线"),必须认
  const naturalGpu = ["3 美元/卡时仅为设备折旧参考线,不能视作完整经济保本线", "3 美元是折旧参考线,并非完整经济保本线", "折旧参考线 3 美元不代表保本线", "3 美元/卡时属于 B200 设备折旧参考线,不能视为完整经济保本线", "3 美元/卡时是设备折旧参考线,不是含电力、机房、运维的完整经济保本线", "3 美元/卡时是设备折旧参考线,不能视为考虑电价后的经济保本线"];
  for (const tw of naturalTw) for (const gpu of naturalGpu) { fs.writeFileSync(path.join(d, "report.md"), rep(tw, gpu)); assert.ok(judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass, `${tw} / ${gpu}`); }
  for (const [tw, gpu] of [["无需与金像电差分,可以单独归因", naturalGpu[0]], [naturalTw[0], "3 美元不是折旧参考线,而是完整保本线"], [naturalTw[0], "折旧参考线 3 美元即完整保本线"], [naturalTw[0], "3 美元/卡时仅为设备折旧参考线,但在当前电价下相当于完整经济保本线"], [naturalTw[0], "3 美元不是折旧参考线而是含电力的完整经济保本线"], [naturalTw[0], "3 美元是折旧参考线,并非完整经济保本线;但它相当于含电力后的完整经济保本线"], [naturalTw[0], "3 美元/卡时是设备折旧参考线,不是上限,而是含电力后的完整经济保本线"]] as const) { fs.writeFileSync(path.join(d, "report.md"), rep(tw, gpu)); assert.ok(!judgeIndustryThermometer(d).checks.find((c) => /护栏/.test(c.name))!.pass, `反向:${tw} / ${gpu}`); }
});

test("policy-r1:judgePolicyAccess——护栏方向反写 / 绝对结论 / 文号 / N 条绑定 / on_list 冲突都判得出;合规写法通过", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-pol-judge-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const ev = [
    { id: "ev-a1a1a1a1a1a1", field: "policy_english_name", value: "Zhongji Innolight Co., Ltd.", unit: "text", currency: "n/a", period: "2026-08-23", as_of: "2026-08-23", source: "s", symbol: "300308", market: "SZ", note: "x" },
    { id: "ev-b1b1b1b1b1b1", field: "policy_1260h_status", value: "on_list", unit: "status", currency: "n/a", period: "2026-06-10", as_of: "2026-08-23", source: "s", symbol: "300308", market: "SZ", note: "fr_doc=2026-11571;published=2026-06-10" },
    { id: "ev-c1c1c1c1c1c1", field: "policy_1260h_context", value: "zhongji innolight co ltd innolight", unit: "text", currency: "n/a", period: "2026-06-10", as_of: "2026-08-23", source: "s", symbol: "300308", market: "SZ", note: "x" },
    { id: "ev-d1d1d1d1d1d1", field: "policy_bis_confirmed_mentions_count", value: 0, unit: "条", currency: "n/a", period: "2026-08-23", as_of: "2026-08-23", source: "s", symbol: "300308", market: "SZ", note: "x" },
    { id: "ev-d2d2d2d2d2d2", field: "policy_bis_status", value: "not_mentioned", unit: "status", currency: "n/a", period: "2026-08-23", as_of: "2026-08-23", source: "s", symbol: "300308", market: "SZ", note: "x" },
    { id: "ev-e2e2e2e2e2e2", field: "policy_fcc_covered_by_name", value: "not_on_list", unit: "status", currency: "n/a", period: "2026-08-23", as_of: "2026-08-23", source: "s", symbol: "300308", market: "SZ", note: "x" },
    { id: "ev-e1e1e1e1e1e1", field: "policy_fcc_entries_count", value: 17, unit: "条", currency: "n/a", period: "2026-08-23", as_of: "2026-08-23", source: "s", symbol: "300308", market: "SZ", note: "x" },
    { id: "ev-dd44dd44dd44", field: "policy_cn_side_status", value: "not_connected", unit: "status", currency: "n/a", period: "2026-08-23", as_of: "2026-08-23", source: "s", symbol: "300308", market: "SZ", note: "x" },
  ];
  writeJson(path.join(d, "evidence.json"), ev);
  writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "管制与准入", summary: "x", evidence_ids: ["ev-b1b1b1b1b1b1"] }] });
  writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, fetch_ledger: { policy_access: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
  const rep = (body: string) => `# 报告\n\n## 结论摘要\n\n- x\n\n## 管制与准入\n\n${body}\n\n## 裁决点\n\n- x\n`;
  const good = "- 1260H:on_list(通知 2026-06-10 · FR Doc 2026-11571 · 命中 Zhongji Innolight Co., Ltd.)[ev-b1b1b1b1b1b1][ev-c1c1c1c1c1c1];BIS:not_mentioned(原文确认提及 0 条)[ev-d2d2d2d2d2d2][ev-d1d1d1d1d1d1];FCC 点名:not_on_list [ev-e2e2e2e2e2e2],名单共 17 条 [ev-e1e1e1e1e1e1];中方侧:not_connected [ev-dd44dd44dd44]。护栏:这根轴只当打折项、不重排名次;没被点名 ≠ 不受影响;被建议列入 ≠ 已列入,只认联邦公报原文;中方侧未接入,沉默不能证明不受管制;不能据此断言不存在管制风险。";
  fs.writeFileSync(path.join(d, "report.md"), rep(good));
  const r = judgePolicyAccess(d);
  assert.ok(r.checks.slice(1).every((c) => c.pass), JSON.stringify(r.checks.filter((c) => !c.pass)));
  const fails = (body: string, re: RegExp, why: string) => { fs.writeFileSync(path.join(d, "report.md"), rep(body)); assert.ok(!judgePolicyAccess(d).checks.find((c) => re.test(c.name))!.pass, why); };
  fails(good.replace("没被点名 ≠ 不受影响", "没被点名说明没有影响"), /护栏/, "护栏方向反写");
  fails(good.replace("被建议列入 ≠ 已列入", "被建议列入就是已列入"), /护栏/, "建议列入反写");
  fails(good.replace("沉默不能证明不受管制", "沉默可以证明未受限制"), /护栏/, "中方侧反写");
  fails(good + " 综合看公司无管制风险。", /绝对结论/, "绝对结论");
  fails(good.replace("17 条", "18 条"), /N 条/, "条数未绑定");
  fails(good.replace("FR Doc 2026-11571", "FR Doc 2026-11572"), /文号/, "文号错");
  fails(good + " 该公司不在 1260H 名单。", /不在名单/, "on_list 冲突");
  fails(good.replace("[ev-d2d2d2d2d2d2]", "").replace("[ev-e2e2e2e2e2e2]", ""), /四类状态证据/, "漏引 BIS / FCC 状态证据(r2)");
  // r3:BIS 是 search_hit_unconfirmed 时写"未提及"判失败;写"检索命中但原文未确认"通过
  const evU = ev.map((e) => e.field === "policy_bis_status" ? { ...e, value: "search_hit_unconfirmed" } : e).filter((e) => e.field !== "policy_bis_confirmed_mentions_count");
  writeJson(path.join(d, "evidence.json"), evU);
  fails(good.replace("BIS:not_mentioned(原文确认提及 0 条)[ev-d2d2d2d2d2d2][ev-d1d1d1d1d1d1]", "BIS:未提及 [ev-d2d2d2d2d2d2]"), /BIS 措辞/, "unconfirmed 写成未提及");
  fs.writeFileSync(path.join(d, "report.md"), rep(good.replace("BIS:not_mentioned(原文确认提及 0 条)[ev-d2d2d2d2d2d2][ev-d1d1d1d1d1d1]", "BIS:search_hit_unconfirmed(检索命中但原文未确认)[ev-d2d2d2d2d2d2]")));
  assert.ok(judgePolicyAccess(d).checks.find((c) => /BIS 措辞/.test(c.name))!.pass);
  writeJson(path.join(d, "evidence.json"), ev);
  fs.writeFileSync(path.join(d, "report.md"), rep(good.replace("没被点名 ≠ 不受影响", "FCC 未被点名不等于不受整类禁令影响") + " 1260H 已确认 on_list,不能解释为不在名单。"));
  assert.ok(judgePolicyAccess(d).checks.find((c) => /护栏/.test(c.name))!.pass, "ht14 真实写法:未被点名不等于不受整类禁令影响");
  assert.ok(judgePolicyAccess(d).checks.find((c) => /不在名单/.test(c.name))!.pass, "否定语境里的'不在名单'不算冲突");
});

test("数据日历规则:台系月营收下一档 = 最新资料期 +1 月,期限 = +2 月 10 日(跨年);从信封推日期行", async () => {
  const { industryNextDateLines, twNextDisclosure } = await import("../src/finance/industry.ts");
  // 期限按"今天"推(不是按最新资料期):8-24 已过 10 日 → 期限 9-10、数据月 8 月;9-05 未过 → 期限 9-10
  assert.deepEqual(twNextDisclosure("2026-07-01..2026-07-31", "2026-08-24"), { data_month: "2026-08", deadline: "2026-09-10", lagging: false });
  assert.deepEqual(twNextDisclosure("2026-07-01..2026-07-31", "2026-09-05"), { data_month: "2026-08", deadline: "2026-09-10", lagging: false });
  // 提前披露:手里已有 8 月数据 → 下一档 = 9 月月报、期限 10-10(Codex datacal-r2);10 日当天同理
  assert.deepEqual(twNextDisclosure("2026-08-01..2026-08-31", "2026-09-05"), { data_month: "2026-09", deadline: "2026-10-10", lagging: false });
  assert.deepEqual(twNextDisclosure("2026-08-01..2026-08-31", "2026-09-10"), { data_month: "2026-09", deadline: "2026-10-10", lagging: false });
  assert.deepEqual(twNextDisclosure("2026-12-01..2026-12-31", "2026-12-24"), { data_month: "2027-01", deadline: "2027-02-10", lagging: false }, "提前披露跨年");
  // 资料滞后:8-24 最新只到 5 月 → 数据月 8 月,6 / 7 月缺 → lagging(Codex datacal-r1:不能把已过去的期限当下一档)
  assert.deepEqual(twNextDisclosure("2026-05-01..2026-05-31", "2026-08-24"), { data_month: "2026-08", deadline: "2026-09-10", lagging: true });
  // 跨年:12-24 → 期限 2027-01-10、数据月 2026-12
  assert.deepEqual(twNextDisclosure("2026-11-01..2026-11-30", "2026-12-24"), { data_month: "2026-12", deadline: "2027-01-10", lagging: false });
  assert.equal(twNextDisclosure("garbage", "2026-08-24"), null);
  assert.equal(twNextDisclosure("2026-13-01", "2026-08-24"), null);
  assert.equal(twNextDisclosure("2026-07-01", "not-a-date"), null);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-nd-"));
  fs.mkdirSync(path.join(d, "fetch"));
  writeJson(path.join(d, "fetch", "tw_monthly_revenue.json"), { evidence: [
    { field: "tw_monthly_revenue", period: "2026-06-01..2026-06-30" }, { field: "tw_monthly_revenue", period: "2026-07-01..2026-07-31" }, { field: "tw_monthly_revenue_mom_pct", period: "2026-08-01..2026-08-31" }] });
  writeJson(path.join(d, "fetch", "gpu_rent_thermometer.json"), { evidence: [
    { field: "gpu_forward_p_below_lowest_strike", record_key: "KXB200MS:2026-12" }, { field: "gpu_spot_median_usd_per_gpu_hr", record_key: "B200" }] });
  const lines = industryNextDateLines(d, "2026-08-24");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("2026-08 月报") && lines[0].includes("2026-09-10 前") && lines[0].includes("规则推算") && !lines[0].includes("滞后"), lines[0]);
  assert.ok(lines[1].includes("2026-12") && lines[1].includes("结算"), lines[1]);
  // 资料滞后时同一行要出声
  writeJson(path.join(d, "fetch", "tw_monthly_revenue.json"), { evidence: [{ field: "tw_monthly_revenue", period: "2026-05-01..2026-05-31" }] });
  assert.ok(industryNextDateLines(d, "2026-08-24")[0].includes("资料源滞后"));
  writeJson(path.join(d, "fetch", "tw_monthly_revenue.json"), { evidence: [
    { field: "tw_monthly_revenue", period: "2026-06-01..2026-06-30" }, { field: "tw_monthly_revenue", period: "2026-07-01..2026-07-31" }, { field: "tw_monthly_revenue_mom_pct", period: "2026-08-01..2026-08-31" }] });
  // 远期不可用(rung 0,record_key 无合约月)→ 不给 Kalshi 行;tw 信封缺 → 不给 tw 行
  writeJson(path.join(d, "fetch", "gpu_rent_thermometer.json"), { evidence: [{ field: "gpu_forward_rung_count", record_key: "KXB200MS" }] });
  fs.rmSync(path.join(d, "fetch", "tw_monthly_revenue.json"));
  assert.deepEqual(industryNextDateLines(d), []);
});

test("大宗温度计:storage_memory 标签只挂 DRAM,光模块股不被 DRAM 污染;期货挂 ai_compute;两标签同时命中时端点并集", () => {
  const table = loadIndustryTags(repoRoot)!;
  assert.ok(table.tags.storage_memory && table.tags.ai_compute.thermometers.includes("cn_commodity_futures"));
  const eps = { cn_commodity_futures: { industry_tags: ["ai_compute"] }, dram_spot_thermo: { industry_tags: ["storage_memory"] }, tw_monthly_revenue: { industry_tags: ["ai_compute"] }, fetch_quote: {} };
  const all = Object.keys(eps);
  // 中际旭创式(光模块 / CPO / 算力)→ 只 ai_compute:拿期货,不拿 DRAM
  const optical = detectIndustryTags(fakeRun(["通信设备"], ["730204"], ["光模块", "CPO概念", "算力概念"]), table);
  assert.deepEqual(optical.tags, ["ai_compute"]);
  const g1 = applyIndustryGate(all, eps, optical.tags);
  assert.ok(g1.included.includes("cn_commodity_futures") && g1.included.includes("fetch_quote"));
  assert.ok(!g1.included.includes("dram_spot_thermo"), "光模块标的不该挂 DRAM 温度计");
  assert.deepEqual(g1.skipped.map((s) => s.id), ["dram_spot_thermo"]);
  // 存储股(DRAM / 存储芯片)→ storage_memory:拿 DRAM
  const storage = detectIndustryTags(fakeRun(["半导体"], ["270600"], ["存储芯片", "DRAM"]), table);
  assert.ok(storage.tags.includes("storage_memory"));
  const g2 = applyIndustryGate(all, eps, storage.tags);
  assert.ok(g2.included.includes("dram_spot_thermo"));
  // 两个标签都命中(既做算力又做存储)→ 端点取并集
  const both = detectIndustryTags(fakeRun(["半导体"], ["270600"], ["HBM", "存储芯片", "算力"]), table);
  assert.deepEqual(both.tags.sort(), ["ai_compute", "storage_memory"]);
  const g3 = applyIndustryGate(all, eps, both.tags);
  assert.ok(g3.included.includes("dram_spot_thermo") && g3.included.includes("cn_commodity_futures") && g3.skipped.length === 0);
  // 提示词块:两个标签的护栏都在,且 DRAM 护栏点明"不是 HBM 价格"
  const d = fakeRun(["半导体"], ["270600"], ["HBM", "存储芯片", "算力"]);
  writeIndustryFile(d, table, both, g3);
  const block = industryPromptBlock(d);
  assert.ok(block.includes("不是 HBM 价格") && block.includes("采购价") && block.includes("dram_spot_thermo"));
});

test("commodity-r1:大宗护栏三条件——只写「全市场定价」/「官方存档」/ 只写影子指标 都判失败;绕过语「也是本公司成本」被抓;合规写法通过", async () => {
  const { judgeIndustryThermometer } = await import("../src/finance/hardtest.ts");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-cmd-judge-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const E = (id: string, field: string, rk: string, value: number) => ({ id, field, record_key: rk, value, unit: field.endsWith("_pct") ? "%" : "元/吨", currency: "n/a", period: "2026-08-21", as_of: "2026-08-24", source: "s", symbol: "MARKET", market: "CN", note: "x" });
  const ev = [E("ev-c1c1c1c1c1c1", "commodity_futures_close", "CU0", 107520), E("ev-d1d1d1d1d1d1", "dram_spot_avg", "DDR5", 54.1),
    E("ev-a1a1a1a1a1a1", "tw_monthly_revenue", "2383", 192.07), E("ev-b1b1b1b1b1b1", "gpu_spot_median_usd_per_gpu_hr", "B200", 7.25)];
  writeJson(path.join(d, "evidence.json"), ev);
  // 判定从**端点信封**取证据 id(commodity-r2),fixture 要写齐每个挂载端点的信封
  writeJson(path.join(d, "fetch", "cn_commodity_futures.json"), { evidence: [ev[0]] });
  writeJson(path.join(d, "fetch", "dram_spot_thermo.json"), { evidence: [ev[1]] });
  writeJson(path.join(d, "fetch", "tw_monthly_revenue.json"), { evidence: [ev[2]] });
  writeJson(path.join(d, "fetch", "gpu_rent_thermometer.json"), { evidence: [ev[3]] });
  writeJson(path.join(d, "fetch", "_industry.json"), { tags: ["ai_compute", "storage_memory"], thermometers: { ai_compute: ["tw_monthly_revenue", "gpu_rent_thermometer", "cn_commodity_futures"], storage_memory: ["dram_spot_thermo"] } });
  writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "产业温度计", summary: "x", evidence_ids: ev.map((e) => e.id) }] });
  writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, industry_tags: { tags: ["ai_compute", "storage_memory"], matched: {}, skipped: [], signals: 5 }, fetch_ledger: { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" }, cn_commodity_futures: { status: "ok" }, dram_spot_thermo: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
  const TW = "台光月营收 192.07 亿新台币;须与金像电差分后归因,不能单独归因 [ev-a1a1a1a1a1a1]";
  const GPU = "B200 现货中位 7.25 美元/卡时;3 美元/卡时是设备折旧参考线,不是完整经济保本线 [ev-b1b1b1b1b1b1]";
  const rep = (fut: string, dram: string) => `# 报告\n\n## 产业温度计\n\n- ${TW}\n- ${GPU}\n- ${fut}\n- ${dram}\n\n## 裁决点\n\n- x\n`;
  const guardCheck = () => judgeIndustryThermometer(d).checks.find((c) => /护栏句与数字同行/.test(c.name))!;
  const okFut = "沪铜 107520 元/吨,这是全市场定价,不是本公司采购价 [ev-c1c1c1c1c1c1]";
  const okDram = "DDR5 现货均价 54.1 美元/颗,来自社区转录的存档非官方一手,是 HBM 的影子指标、不是 HBM 价格 [ev-d1d1d1d1d1d1]";
  fs.writeFileSync(path.join(d, "report.md"), rep(okFut, okDram));
  assert.ok(guardCheck().pass, guardCheck().detail);
  for (const [fut, dram, why] of [
    ["沪铜 107520 元/吨,全市场定价 [ev-c1c1c1c1c1c1]", okDram, "期货只写全市场定价、没否认是采购价"],
    ["沪铜 107520 元/吨,全市场定价,也是本公司成本 [ev-c1c1c1c1c1c1]", okDram, "期货绕过语:也是本公司成本"],
    ["沪铜 107520 元/吨,按此价采购,不是本公司采购价的全市场定价 [ev-c1c1c1c1c1c1]", okDram, "期货反向:按此价采购"],
    [okFut, "DDR5 54.1 美元/颗,这是官方存档,DRAM 是 HBM 的影子指标 [ev-d1d1d1d1d1d1]", "DRAM 官方存档 + 没否认是 HBM 价格"],
    [okFut, "DDR5 54.1 美元/颗,社区转录非官方一手,是 HBM 的影子指标 [ev-d1d1d1d1d1d1]", "DRAM 缺「不是 HBM 价格」"],
    [okFut, "DDR5 54.1 美元/颗,社区转录非官方一手,不是 HBM 价格 [ev-d1d1d1d1d1d1]", "DRAM 缺「影子指标」"],
  ] as const) {
    fs.writeFileSync(path.join(d, "report.md"), rep(fut, dram));
    assert.ok(!guardCheck().pass, `应判失败但通过了:${why}`);
  }
  // 动态强制:挂载并取到数的端点被整段省略 → 判失败(Codex commodity-r1 P1-1)
  fs.writeFileSync(path.join(d, "report.md"), `# 报告\n\n## 产业温度计\n\n- ${TW}\n- ${GPU}\n\n## 裁决点\n\n- x\n`);
  const omitted = judgeIndustryThermometer(d).checks.find((c) => /每个\*\*温度计|每个.*温度计端点都在报告章节被引用/.test(c.name))!;
  assert.ok(!omitted.pass && /cn_commodity_futures/.test(omitted.detail) && /dram_spot_thermo/.test(omitted.detail), omitted.detail);
  fs.writeFileSync(path.join(d, "report.md"), rep(okFut, okDram));
  assert.ok(judgeIndustryThermometer(d).checks.find((c) => /温度计端点都在报告章节被引用/.test(c.name))!.pass);
});

test("commodity-r2:挂载端点的证据 id 直接取自信封(未知端点不再静默豁免);取数失败的挂载端点必须在 risk.gaps 出声", async () => {
  const { judgeIndustryThermometer } = await import("../src/finance/hardtest.ts");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-cmd-dyn-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const E = (id: string, field: string, rk: string, value: number, unit = "元/吨") => ({ id, field, record_key: rk, value, unit, currency: "n/a", period: "2026-08-21", as_of: "2026-08-24", source: "s", symbol: "MARKET", market: "CN", note: "x" });
  const tw = E("ev-a1a1a1a1a1a1", "tw_monthly_revenue", "2383", 192.07, "亿新台币");
  const gpu = E("ev-b1b1b1b1b1b1", "gpu_spot_median_usd_per_gpu_hr", "B200", 7.25, "美元/卡时");
  // 全新端点:字段前缀不在任何写死的映射里(旧实现会静默豁免)
  const nov = E("ev-e1e1e1e1e1e1", "ssd_channel_price", "TLC-512G", 33.3, "美元");
  const mk = (ledger: Record<string, { status: string }>, gaps: { operation: string }[], report: string) => {
    writeJson(path.join(d, "evidence.json"), [tw, gpu, nov]);
    writeJson(path.join(d, "fetch", "tw_monthly_revenue.json"), { evidence: [tw] });
    writeJson(path.join(d, "fetch", "gpu_rent_thermometer.json"), { evidence: [gpu] });
    writeJson(path.join(d, "fetch", "ssd_channel_thermo.json"), { evidence: [nov] });
    writeJson(path.join(d, "fetch", "_industry.json"), { tags: ["ai_compute"], thermometers: { ai_compute: ["tw_monthly_revenue", "gpu_rent_thermometer", "ssd_channel_thermo"] } });
    writeJson(path.join(d, "stages", "risk.json"), { extra_findings: [{ topic: "产业温度计", summary: "x", evidence_ids: [tw.id, gpu.id] }], gaps });
    writeJson(path.join(d, "manifest.json"), { status: "complete", exit_code: 0, industry_tags: { tags: ["ai_compute"], matched: {}, skipped: [], signals: 5 }, fetch_ledger: ledger, gate: { ok: true, hits: [] }, stages: [] });
    fs.writeFileSync(path.join(d, "report.md"), report);
  };
  const TWLINE = "台光月营收 192.07 亿新台币;须与金像电差分后归因,不能单独归因 [ev-a1a1a1a1a1a1]";
  const GPULINE = "B200 现货中位 7.25 美元/卡时;3 美元/卡时是设备折旧参考线,不是完整经济保本线 [ev-b1b1b1b1b1b1]";
  const base = (extra = "") => `# 报告\n\n## 产业温度计\n\n- ${TWLINE}\n- ${GPULINE}${extra}\n\n## 裁决点\n\n- x\n`;
  const chk = (re: RegExp) => judgeIndustryThermometer(d).checks.find((c) => re.test(c.name))!;
  const ok3 = { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" }, ssd_channel_thermo: { status: "ok" } };
  // ① 新端点取到数却被报告省略 → 必须判失败(不靠字段前缀映射)
  mk(ok3, [], base());
  const c1 = chk(/都在报告章节被引用/);
  assert.ok(!c1.pass && /ssd_channel_thermo/.test(c1.detail), c1.detail);
  // ② 引用了就通过
  mk(ok3, [], base("\n- 渠道 SSD 报价 33.3 美元 [ev-e1e1e1e1e1e1]"));
  assert.ok(chk(/都在报告章节被引用/).pass);
  // ③ 挂载但取数失败、报告与 gaps 都不提 → 判失败
  const failed = { tw_monthly_revenue: { status: "ok" }, gpu_rent_thermometer: { status: "ok" }, ssd_channel_thermo: { status: "failed" } };
  mk(failed, [], base());
  const c3 = chk(/取数失败.*risk\.gaps/);
  assert.ok(!c3.pass && /ssd_channel_thermo/.test(c3.detail), c3.detail);
  // ④ 失败但在 gaps 出声 → 通过,且不再要求报告引用
  mk(failed, [{ operation: "ssd_channel_thermo" }], base());
  assert.ok(chk(/取数失败.*risk\.gaps/).pass && chk(/都在报告章节被引用/).pass);
});

test("headlines-r1:judgeHeadlines 不许空跑——有命中却无章节 / 引未命中 / 空话关系句 / 缺声明 都判失败;合规写法通过;时刻不算数字", async () => {
  const { judgeHeadlines } = await import("../src/finance/hardtest.ts");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-head-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const E = (id: string, field: string, value: unknown, note: string) => ({ id, field, value, unit: field === "headline_item" ? "text" : "条", currency: "n/a", period: "2026-08-24", as_of: "2026-08-24", source: "techmeme", symbol: "300308", market: "SZ", record_key: id, note });
  const NOTE = (rel: string) => `published=2026-08-24T20:45:00+08:00;period_basis=published;source=NYT;relevance=${rel};link=https://x.com/1;untrusted_text=sanitized;读法:线索不是事实`;
  const hit = E("ev-aa11aa11aa11", "headline_item", "Nvidia expands data center supply", NOTE("命中:Nvidia"));
  const miss = E("ev-bb22bb22bb22", "headline_item", "Consumer gadget review roundup", NOTE("未命中产业关键词"));
  const cnt = E("ev-cc33cc33cc33", "headline_count", 2, "窗口 48 小时;读法:线索不是事实");
  const fact = { id: "ev-dd44dd44dd44", field: "revenue", value: 100, unit: "亿元", currency: "CNY", period: "2026-06-30", as_of: "2026-08-24", source: "em", symbol: "300308", market: "SZ", note: "x" };
  const mk = (riskIds: string[], report: string) => {
    writeJson(path.join(d, "evidence.json"), [hit, miss, cnt, fact]);
    writeJson(path.join(d, "fetch", "techmeme_headlines.json"), { evidence: [hit, miss, cnt] });
    writeJson(path.join(d, "stages", "risk.json"), { extra_findings: riskIds.length ? [{ topic: "海外头条", summary: "x", evidence_ids: riskIds }] : [] });
    writeJson(path.join(d, "manifest.json"), { symbol: "300308", status: "complete", exit_code: 0, fetch_ledger: { techmeme_headlines: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
    fs.writeFileSync(path.join(d, "report.md"), report);
  };
  const good = `# 报告\n\n## 海外头条\n\n- 2026-08-24 20:45(北京)· NYT · 英伟达扩产数据中心供应 [ev-aa11aa11aa11]\n- 与本报告的关系:与营收印证 [ev-dd44dd44dd44]\n- 以上为海外科技头条线索,非事实\n\n## 裁决点\n\n- x\n`;
  const chk = (re: RegExp) => judgeHeadlines(d).checks.find((c) => re.test(c.name))!;
  mk(["ev-aa11aa11aa11"], good);
  assert.ok(judgeHeadlines(d).pass, judgeHeadlines(d).checks.filter((c) => !c.pass).map((c) => `${c.name}:${c.detail}`).join(" | "));
  // 有命中却完全没章节 → 失败(原实现可空跑)
  mk(["ev-aa11aa11aa11"], `# 报告\n\n## 裁决点\n\n- x\n`);
  assert.ok(!chk(/有命中条目时/).pass);
  // 引了未命中条目 → 失败
  mk(["ev-aa11aa11aa11"], good.replace("[ev-aa11aa11aa11]", "[ev-aa11aa11aa11] [ev-bb22bb22bb22]"));
  assert.ok(!chk(/全部是「命中」条目/).pass);
  // 关系句是空话(不引非头条 id)→ 失败
  mk(["ev-aa11aa11aa11"], good.replace("- 与本报告的关系:与营收印证 [ev-dd44dd44dd44]", "- 线索关系"));
  assert.ok(!chk(/关系句必须引用非头条/).pass);
  // 缺"非事实"声明 → 失败
  mk(["ev-aa11aa11aa11"], good.replace("- 以上为海外科技头条线索,非事实", "- 以上为线索"));
  assert.ok(!chk(/关系句必须引用非头条/).pass);
  // 行内写了标题里的数字 → 失败;但时刻(20:45)不算数字
  mk(["ev-aa11aa11aa11"], good.replace("英伟达扩产数据中心供应", "英伟达扩产数据中心供应,涉及 1.8 亿美元"));
  assert.ok(!chk(/不写数字/).pass);
  // 贴链接 → 失败
  mk(["ev-aa11aa11aa11"], good.replace("[ev-aa11aa11aa11]", "https://nyt.com/x [ev-aa11aa11aa11]"));
  assert.ok(!chk(/不贴链接/).pass);
});

test("headlines-r2:零命中留痕不可空过(无章节 / 空 findings / 只写无关话 都判失败);时刻只在有日期的行豁免", async () => {
  const { judgeHeadlines, claimTokens } = await import("../src/finance/hardtest.ts");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-head0-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const NOTE = "published=2026-08-24T20:45:00+08:00;period_basis=published;source=NYT;relevance=未命中产业关键词;link=https://x.com/1;untrusted_text=sanitized";
  const miss = { id: "ev-bb22bb22bb22", field: "headline_item", value: "Consumer gadget roundup", unit: "text", currency: "n/a", period: "2026-08-24", as_of: "2026-08-24", source: "techmeme", symbol: "300308", market: "SZ", record_key: "u:1", note: NOTE };
  const cnt = { ...miss, id: "ev-cc33cc33cc33", field: "headline_count", value: 5, unit: "条", note: "窗口 48 小时;命中 0 条" };
  const mk = (findings: unknown[], report: string) => {
    writeJson(path.join(d, "evidence.json"), [miss, cnt]);
    writeJson(path.join(d, "fetch", "techmeme_headlines.json"), { evidence: [miss, cnt] });
    writeJson(path.join(d, "stages", "risk.json"), { extra_findings: findings });
    writeJson(path.join(d, "manifest.json"), { symbol: "300308", status: "complete", exit_code: 0, fetch_ledger: { techmeme_headlines: { status: "ok" } }, gate: { ok: true, hits: [] }, stages: [] });
    fs.writeFileSync(path.join(d, "report.md"), report);
  };
  const zc = (re: RegExp) => judgeHeadlines(d).checks.find((c) => re.test(c.name))!;
  // 完全没章节 + 没 findings → 失败(原实现直接放行)
  mk([], `# 报告\n\n## 裁决点\n\n- x\n`);
  assert.ok(!zc(/零命中时也要留痕/).pass);
  // 空 findings(topic 在但 evidence_ids 为空)→ 失败
  mk([{ topic: "海外头条", summary: "x", evidence_ids: [] }], `# 报告\n\n## 海外头条\n\n- 暂无其他内容\n\n## 裁决点\n\n- x\n`);
  assert.ok(!zc(/零命中时也要留痕/).pass);
  // 章节写明"窗口内无命中"并引计数证据 → 通过
  mk([], `# 报告\n\n## 海外头条\n\n- 窗口内无命中的海外头条 [ev-cc33cc33cc33]\n\n## 裁决点\n\n- x\n`);
  assert.ok(zc(/零命中时也要留痕/).pass, zc(/零命中时也要留痕/).detail);
  // risk 引计数证据也算留痕
  mk([{ topic: "海外头条", summary: "窗口内无命中", evidence_ids: ["ev-cc33cc33cc33"] }], `# 报告\n\n## 裁决点\n\n- x\n`);
  assert.ok(zc(/零命中时也要留痕/).pass);
  // 时刻豁免只在有日期的行:带日期的行 20:45 不算数字;不带日期的"配比 3:10"仍是主张
  assert.deepEqual(claimTokens("2026-08-24 20:45(北京)· NYT · 英伟达扩产").map((x) => x.n), []);
  // 3:10 两个数都 ≤20,本来就被小整数当计数规则跳过(无实际危害);用会被计入的比值验证时刻规则没误剥
  assert.deepEqual(claimTokens("材料配比为 35:65").map((x) => x.n), [35, 65]);
  assert.deepEqual(claimTokens("2026-08-24 20:45 发布,配比 35:65").map((x) => x.n), [35, 65], "有日期的行只豁免时刻,不豁免比值");
});

test("招聘信号 judge:合规写法通过;缺护栏 / 反向表述(等于产能)/ 数字未绑定 / id 漏进事实章节 / 把未接入读成零岗位 都判失败", async () => {
  const { judgeHiring } = await import("../src/finance/hardtest.ts");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vra-hire-"));
  fs.mkdirSync(path.join(d, "stages")); fs.mkdirSync(path.join(d, "fetch"));
  const NOTE = "Lightmatter(硅光 / 光互连;greenhouse 公开 job board)当前公开在招岗位数;产业标签=ai_compute;读法:岗位数是招聘意图不是产能,受招聘节奏与 HR 批次影响,单点数字意义有限、看变化;这些是产业链锚点公司不是本公司数据;不同 ATS 口径不同,只在同一家公司内部比较,不跨公司比大小";
  const tot = { id: "ev-aa11aa11aa11", field: "hiring_open_roles", value: 69, unit: "个", currency: "n/a", period: "2026-08-24", as_of: "2026-08-24", source: "ats-public", symbol: "MARKET", market: "US", record_key: "greenhouse:lightmatter", note: NOTE };
  const bk = { ...tot, id: "ev-bb22bb22bb22", field: "hiring_role_bucket", value: 15, record_key: "greenhouse:lightmatter:光与互连" };
  const mk = (report: string, evidence = [tot, bk]) => {
    writeJson(path.join(d, "evidence.json"), evidence);
    writeJson(path.join(d, "fetch", "hiring_anchor_signal.json"), { evidence });
    writeJson(path.join(d, "stages", "risk.json"), { extra_findings: evidence.length ? [{ topic: "招聘信号", summary: "x", evidence_ids: [tot.id] }] : [] });
    writeJson(path.join(d, "manifest.json"), { symbol: "300308", status: "complete", exit_code: 0, fetch_ledger: { hiring_anchor_signal: { status: evidence.length ? "ok" : "partial" } }, gate: { ok: true, hits: [] }, stages: [] });
    fs.writeFileSync(path.join(d, "report.md"), report);
  };
  // 护栏分两级(见 hardtest.ts judgeHiring):逐段必须标明「不是本公司」;章节级须写明「招聘意图不是产能」与「不跨公司比」
  const good = `# 报告\n\n## 招聘信号\n\n- Lightmatter(硅光/光互连锚点,不是本公司)在招 69 个 [ev-aa11aa11aa11],其中「光与互连」15 个 [ev-bb22bb22bb22]\n\n岗位数是招聘意图不是产能,看变化;不同 ATS 口径不同,只在同一家公司内部比较,不跨公司比大小\n\n## 裁决点\n\n- x\n`;
  const chk = (re: RegExp) => judgeHiring(d).checks.find((c) => re.test(c.name))!;
  mk(good);
  assert.ok(judgeHiring(d).pass, judgeHiring(d).checks.filter((c) => !c.pass).map((c) => `${c.name}:${c.detail}`).join(" | "));
  // 逐段缺「不是本公司」→ 逐段那条判失败(这条必须贴着数字:单独引用时最容易被当成本公司事实)
  mk(good.replace("(硅光/光互连锚点,不是本公司)", ""));
  assert.ok(!chk(/每段都标明/).pass);
  // 章节级缺「不跨公司比」→ 章节级那条判失败(旧实现声称查这条却根本没查 = 假绿,已补)
  mk(good.replace(";不同 ATS 口径不同,只在同一家公司内部比较,不跨公司比大小", ""));
  assert.ok(!chk(/章节级护栏齐/).pass);
  // 章节级缺「招聘意图不是产能」
  mk(good.replace("岗位数是招聘意图不是产能,看变化;", ""));
  assert.ok(!chk(/章节级护栏齐/).pass);
  // 反向表述:等于产能(在带 id 的那段里)
  mk(good.replace("在招 69 个 [ev-aa11aa11aa11]", "在招 69 个,岗位数等于产能 [ev-aa11aa11aa11]"));
  assert.ok(!chk(/每段都标明/).pass);
  // 同一段里写否定句「不等于 / 不代表 / 未必代表产能」是护栏本身,要通过(第四轮审计 B7)
  for (const neg of ["招聘意图不等于产能", "岗位数不代表产能", "未必代表产能", "并不就是产能"]) {
    mk(good.replace("在招 69 个 [ev-aa11aa11aa11]", `在招 69 个,${neg} [ev-aa11aa11aa11]`));
    assert.ok(chk(/每段都标明/).pass, neg);
  }
  // 数字未绑定(段内写了个没有证据支撑的数)
  mk(good.replace("其中「光与互连」15 个 [ev-bb22bb22bb22]", "其中「光与互连」42 个 [ev-bb22bb22bb22]"));
  assert.ok(!chk(/数字全部绑到/).pass);
  // id 漏进事实章节
  mk(`# 报告\n\n## 事实\n\n- 营收增长与招聘 [ev-aa11aa11aa11]\n\n${good.slice(good.indexOf("## 招聘信号"))}`);
  assert.ok(!chk(/不出现在事实/).pass);
  // 未接入被读成零岗位
  mk(`# 报告\n\n## 招聘信号\n\n- 锚点未接入,没人在招\n\n## 裁决点\n\n- x\n`, []);
  assert.ok(!chk(/未接入/).pass);
});
