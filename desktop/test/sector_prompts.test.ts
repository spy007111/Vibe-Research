import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { sectorSteps, sectorTabs } from "../src/verticals/finance/lib/sectorPrompts.ts";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const data = JSON.parse(read("verticals/finance/data/sectors.json")) as {
  sectors: { key: string; label: string; tagline: string; nodes: string[]; verified: boolean; hot: boolean }[];
};
const sector = (key: string) => {
  const s = data.sectors.find((x) => x.key === key);
  assert.ok(s, key);
  return s;
};

test("视频里做过的四个板块用视频的栏目，其余板块用通用五栏；每个板块都有提示词", () => {
  assert.deepEqual(sectorTabs(sector("cpo")), ["总览", "技术路线及产业链", "产业龙头", "CPO 路线"]);
  assert.deepEqual(sectorTabs(sector("hbm")), ["总览", "技术代际", "成本与卡口", "产业龙头", "周期温度计"]);
  assert.deepEqual(sectorTabs(sector("humanoid")), ["总览", "关节与执行", "价值量与卡口", "灵巧手", "产业本体厂商", "确定性地图"]);
  assert.deepEqual(sectorTabs(sector("pcb")), ["总览", "原理与技术路线", "价值量", "铜中板", "产业格局", "定价权地图"]);
  assert.deepEqual(sectorTabs(sector("fusion")), ["总览", "技术路线", "产业链与价值量", "全球格局", "确定性地图"]);
  assert.equal(sector("pcb").label, "PCB");
  assert.equal(new Set(data.sectors.map((s) => s.key)).size, data.sectors.length, "板块 key 不重复");
  for (const s of data.sectors) {
    const steps = sectorSteps(s, 2027);
    assert.equal(steps.length, sectorTabs(s).length + 1, s.key);
    assert.deepEqual(steps.map((x) => x.n), steps.map((_, i) => i + 1), s.key);
    assert.match(steps[0].title, /读研报/);
    steps.slice(1).forEach((x, i) => {
      const tab = sectorTabs(s)[i];
      assert.ok(x.title.startsWith(`${tab}：`), `${s.key} 第 ${x.n} 步标题`);
      assert.ok(x.prompt.startsWith(`「${s.label}」第 ${x.n} 步，产出【${tab}】页：`), `${s.key} 第 ${x.n} 步开头带板块名（存进记录时标题分得清）`);
      assert.match(x.prompt, new RegExp(`标题用「${s.label} · ${tab}」`));
      assert.match(x.prompt, /来源和年份/);
    });
  }
});

test("第 1 步：先读资料库里的研报，再找今年和去年的公开研报；年份跟着今天走，不写死", () => {
  const pcb = sectorSteps(sector("pcb"), 2027)[0].prompt;
  assert.ok(pcb.startsWith("我们来梳理「PCB」这个产业板块"), "开头带板块名");
  assert.match(pcb, /资料库里有和PCB相关的研报，先读这些/);
  assert.match(pcb, /2027 年和 2026 年的公开行业研报/);
  assert.match(pcb, /112G → 224G → 448G/, "带上视频里的读研报重点");
  assert.match(pcb, /① 总览　② 原理与技术路线　③ 价值量　④ 铜中板　⑤ 产业格局　⑥ 定价权地图/);
  assert.match(pcb, /分 7 步/);
  assert.match(pcb, /查不到就写「未查到」/);
  assert.match(pcb, /以你查到的资料为准/);
  // 不传年份 = 按今天：把时钟拨到 2031 年，写死成哪一年都会露馅
  mock.timers.enable({ apis: ["Date"], now: new Date("2031-03-01T00:00:00Z") });
  try {
    assert.match(sectorSteps(sector("fusion"))[0].prompt, /2031 年和 2030 年/, "默认按今天的年份");
  } finally { mock.timers.reset(); }
  // 已核实环节的板块：环节写进第 1 步；没核实的不编
  assert.match(sectorSteps(sector("humanoid"), 2027)[0].prompt, /已核实的核心环节有：谐波减速器、行星滚柱丝杠、无框力矩电机、灵巧手、六维力传感器、具身大模型/);
  assert.doesNotMatch(sectorSteps(sector("hbm"), 2027)[0].prompt, /已核实的核心环节/);
});

test("提示词只讲产业：不让 AI 去 clone 仓库，不写死会过期的年份，不落到个股估值和买卖", () => {
  const all = data.sectors.flatMap((s) => sectorSteps(s, 2099).map((x) => ({ key: s.key, n: x.n, text: x.prompt })));
  for (const { key, n, text } of all) {
    const at = `${key} 第 ${n} 步`;
    assert.doesNotMatch(text, /clone|Vibe-Research|simonlin1212|仓库|板块中心/, `${at}：这里就是工作台，不用再部署`);
    const years = [...text.matchAll(/(?<!\d)20\d\d(?!\d)/g)].map((m) => m[0]).filter((y) => y !== "2099" && y !== "2098");
    assert.deepEqual(years, [], `${at}：年份只能来自参数（这里传的是 2099）`);
    assert.doesNotMatch(text, /估值|下手|目标价|止损|止盈|建仓|加仓|减仓|买入|卖出|值不值得花时间|评级/, at);
    assert.doesNotMatch(text, /中国高潮栏|本期彩蛋/, `${at}：视频里的栏目名不带进来`);
  }
});

test("视频提示词里会过期的说法，改成让 AI 查最新进度", () => {
  const steps = (key: string) => sectorSteps(sector(key), 2027).map((x) => x.prompt).join("\n");
  assert.match(steps("humanoid"), /到现在兑现了多少/);
  assert.match(steps("humanoid"), /绿档看谁的产能在兑现订单/);
  assert.match(steps("hbm"), /HBM4 变了什么.*以及它现在量产到什么程度/);
  assert.match(steps("cpo"), /各写上预计年份和出处/);
  assert.match(steps("pcb"), /查最新进度。如果有延期/);
  assert.match(steps("pcb"), /哪一档值得深入研究、哪一档只需跟踪/);
});

test("产业研究页列出全部板块；板块页每一步能复制、能填进「问 Agent」（不自动发送）", () => {
  const list = read("verticals/finance/pages/Sectors.tsx");
  assert.match(list, /const sectors = sectorsData\.sectors;/, "不再只列已核实的");
  assert.match(list, /title="产业研究"/);
  const detail = read("verticals/finance/pages/SectorDetail.tsx");
  assert.match(detail, /const send = useAiDraft\(\);/);
  assert.match(detail, /<StepCard key=\{s\.n\} step=\{s\} onSend=\{send\} \/>/);
  assert.match(detail, /\{onSend && \(/, "没接上 AI 入口时不显示「发给 Agent」，而不是点了没反应");
  assert.match(detail, /navigator\.clipboard\.writeText\(step\.prompt\)/);
  assert.match(detail, /复制没成功/, "复制失败要说出来");
  assert.match(detail, /<ArrowLeft className="h-4 w-4" \/> 产业研究/);
  assert.doesNotMatch(detail, /实时核实<\/b>补全中/, "旧的「梳理中」占位卡已换成提示词");
});
