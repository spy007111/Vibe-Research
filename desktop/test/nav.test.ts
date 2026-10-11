import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NAV_SECTIONS, isGroup, isNavIcon, movedUrl, navPageOf, navTitle, sectionHome, withSectors } from "../src/verticals/finance/lib/nav.ts";

const SECTOR_LIST: { key: string; label: string; icon?: string }[] =
  JSON.parse(readFileSync(new URL("../src/verticals/finance/data/sectors.json", import.meta.url), "utf8")).sectors;
const FULL = withSectors(NAV_SECTIONS, SECTOR_LIST);

test("当前页归属：本身和子路径都算它，首页只认 /，认不出的是 null", () => {
  assert.equal(navPageOf("/")?.page.label, "首页");
  assert.equal(navPageOf("/intel/news")?.page.label, "资讯雷达");
  assert.equal(navPageOf("/intel/news")?.section.label, "产业资讯");
  // 没接板块名单时，板块页算产业研究总览；接上后算它自己
  assert.equal(navPageOf("/sectors/humanoid")?.page.label, "产业研究");
  assert.equal(navPageOf("/sectors/humanoid", FULL)?.page.label, "人形机器人");
  assert.equal(navPageOf("/sectors/humanoid", FULL)?.section.label, "产业研究");
  assert.equal(navPageOf("/sectors", FULL)?.page.to, "/sectors");
  assert.equal(navPageOf("/sectors/no-such", FULL)?.page.to, "/sectors", "名单里没有的板块地址退回总览");
  assert.equal(navPageOf("/sectors/humanoidx", FULL)?.page.to, "/sectors", "前缀相同的别的地址不算这个板块");
  assert.equal(navPageOf("/my-stocks")?.section.label, "我的股票");
  assert.equal(navPageOf("/research")?.section.label, "研究工具");
  assert.equal(navPageOf("/debate")?.section.label, "研究工具");
  // 前缀相同但不是子路径的不能算进去（/notes 不是 /no 的子页）
  assert.equal(navPageOf("/intelx"), null);
  assert.equal(navPageOf("/stock-data"), null);
  assert.equal(navPageOf("/nope"), null);
});

test("顶栏标题跟着当前页；认不出的显示「工作空间」", () => {
  assert.equal(navTitle("/my-stocks"), "自选与持仓");
  assert.equal(navTitle("/signals/gpu-rent"), "产业信号");
  assert.equal(navTitle("/research"), "个股深挖");
  assert.equal(navTitle("/debate"), "多空辩论");
  assert.equal(navTitle("/whatever"), "工作空间");
  assert.equal(navTitle("/sectors/pcb", FULL), "PCB");
  assert.equal(navTitle("/sectors", FULL), "产业研究");
});

test("每个页面只出现一次；只有一页的一级直接是链接，几页的才是组", () => {
  const tos = NAV_SECTIONS.flatMap((s) => s.pages.map((p) => p.to));
  assert.equal(new Set(tos).size, tos.length);
  assert.deepEqual(NAV_SECTIONS.filter(isGroup).map((s) => s.label), ["产业资讯", "产业研究", "研究工具", "我的股票", "资料库"]);
  for (const s of NAV_SECTIONS.filter((x) => !isGroup(x))) assert.equal(s.pages[0]!.label, s.label, "单页一级的名字和页面一致");
});

test("产业研究的二级直接是各板块（按名单顺序、各带图标），点「产业研究」本身进总览；别的栏目不变", () => {
  assert.ok(SECTOR_LIST.length >= 20, `板块名单只有 ${SECTOR_LIST.length} 个`);
  const research = FULL.find((s) => s.label === "产业研究")!;
  assert.deepEqual(research.pages.map((p) => p.to), SECTOR_LIST.map((s) => `/sectors/${s.key}`), "二级里不再多一项总览");
  assert.deepEqual(research.pages.map((p) => p.label), SECTOR_LIST.map((s) => s.label));
  assert.equal(sectionHome(research), "/sectors");
  assert.equal(sectionHome(FULL.find((s) => s.label === "研究工具")!), "/research", "没有总览的组进第一个二级");
  // 每个板块在数据里写了登记过的图标，而且各不相同（新增板块忘了配图标这里会红）
  for (const s of SECTOR_LIST) assert.ok(isNavIcon(s.icon), `${s.label} 的图标「${s.icon}」没登记`);
  assert.equal(new Set(SECTOR_LIST.map((s) => s.icon)).size, SECTOR_LIST.length, "板块图标有重复");
  assert.deepEqual(research.pages.map((p) => p.icon), SECTOR_LIST.map((s) => s.icon));
  // 不认识的图标名不会让侧栏崩：退回格子图标
  const odd = withSectors(NAV_SECTIONS, [{ key: "x", label: "X", icon: "NoSuchIcon" }, { key: "y", label: "Y" }]);
  assert.deepEqual(odd.find((s) => s.label === "产业研究")!.pages.map((p) => p.icon), ["LayoutGrid", "LayoutGrid"]);
  const tos = FULL.flatMap((s) => s.pages.map((p) => p.to));
  assert.equal(new Set(tos).size, tos.length, "接上板块后地址仍不重复");
  for (const s of FULL.filter((x) => x.label !== "产业研究")) assert.equal(s, NAV_SECTIONS.find((x) => x.label === s.label), `${s.label} 原样返回`);
  assert.equal(NAV_SECTIONS.find((s) => s.label === "产业研究")!.pages.length, 0, "原数据不被改动");
});

test("旧地址跳转：带上原来的查询参数和锚点，再切到对应分页", () => {
  assert.equal(movedUrl("/my-stocks", "", "", "watch"), "/my-stocks?tab=watch");
  assert.equal(movedUrl("/research", "?symbol=600519", "", "debate"), "/research?symbol=600519&tab=debate");
  assert.equal(movedUrl("/research", "?symbol=00700.HK", "#x", undefined), "/research?symbol=00700.HK#x");
  // 原地址里自带的 tab 被新分页覆盖，不会出现两个 tab
  assert.equal(movedUrl("/my-stocks", "?tab=old&x=1", "", "hold"), "/my-stocks?tab=hold&x=1");
  assert.equal(movedUrl("/research", "", ""), "/research");
});
