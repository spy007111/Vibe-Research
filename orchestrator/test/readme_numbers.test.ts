import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NAV_SECTIONS, isGroup } from "../../desktop/src/verticals/finance/lib/nav.ts";
import { FINANCE_STAGES } from "../src/finance/plugin.ts";
import { RUN_TOOLS } from "../src/run_tools.ts";

/**
 * README 里的数字由这里兜住:端点数、层数、栏目数、受控工具数、研究阶段数、上游版本号。
 * 注册表、导航或工具改了而 README 没跟着改,这里变红。
 * 🔴 每条写法都要求「至少找到几处」:README 换了说法、正则一处都没匹配上时也要变红,不能悄悄失效。
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const ZH = read("README.md");
const EN = read("README_en.md");

const ZH_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const EN_NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** 英文 README 用单词写的小数字 */
const EN_WORD = `(?:${EN_NUM.join("|")})`;
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : ZH_NUM.includes(s) ? ZH_NUM.indexOf(s) : EN_NUM.indexOf(s.toLowerCase()));

/** 每处匹配的第 group 组转成数字;少于 min 处就报错 */
function numbersAt(md: string, re: RegExp, min: number, label: string, group = 1): number[] {
  const out = [...md.matchAll(re)].map((m) => toNum(m[group]!));
  assert.ok(out.length >= min, `${label}:只找到 ${out.length} 处,至少应有 ${min} 处(README 换了写法就同步改这条测试)`);
  return out;
}
function allEqual(md: string, re: RegExp, min: number, want: number, label: string, group = 1) {
  for (const n of numbersAt(md, re, min, label, group)) assert.equal(n, want, `${label}写的是 ${n},实际是 ${want}`);
}

test("README 端点数 / 层数 / 停用数跟数据注册表一致", () => {
  const reg = JSON.parse(read("datasources/registry.json")) as { endpoints: { id: string; layer: string; enabled?: boolean; source?: string }[] };
  const total = reg.endpoints.length;
  // 与取数器、编排器同一口径:没写 enabled 算启用
  const disabled = reg.endpoints.filter((e) => e.enabled === false);
  const enabled = total - disabled.length;
  const layers = new Set(reg.endpoints.map((e) => e.layer)).size;

  allEqual(ZH, /(\d+) 个数据端点/g, 4, enabled, "中文 README「N 个数据端点」");
  allEqual(ZH, /（(\d+) 层）/g, 1, layers, "中文 README「（N 层）」");
  allEqual(ZH, /共 \*\*(\d+) 个端点、\d+ 层\*\*/g, 1, total, "中文 README 注册表总数");
  allEqual(ZH, /共 \*\*\d+ 个端点、(\d+) 层\*\*/g, 1, layers, "中文 README 注册表层数");
  // 有停用端点时要写明可用几个、停用几个;全部可用时不许留着旧的停用说明
  if (disabled.length) {
    allEqual(ZH, /可用 (\d+) 个/g, 1, enabled, "中文 README「可用 N 个」");
    allEqual(ZH, /(\d+) 个端点因服务器不再返回数据而默认停用/g, 1, disabled.length, "中文 README 停用数");
  } else {
    assert.doesNotMatch(ZH, /可用 \d+ 个|默认停用/, "注册表已没有停用端点,中文 README 还写着停用说明");
  }

  allEqual(EN, /(\d+) data endpoints/g, 4, enabled, "English README 'N data endpoints'");
  allEqual(EN, /\((\d+) layers\)/g, 1, layers, "English README '(N layers)'");
  allEqual(EN, /\*\*(\d+) endpoints across \d+ layers\*\*/g, 1, total, "English README registry total");
  allEqual(EN, /\*\*\d+ endpoints across (\d+) layers\*\*/g, 1, layers, "English README registry layers");
  if (disabled.length) {
    allEqual(EN, /(\d+) of them enabled/g, 1, enabled, "English README 'N of them enabled'");
    allEqual(EN, /the (\w+) TDX candle/g, 1, disabled.length, "English README disabled count");
  } else {
    assert.doesNotMatch(EN, /of them enabled|off by default because/, "no disabled endpoints left, but the English README still describes them");
  }

  // 两边的徽标同一个数
  for (const md of [ZH, EN]) allEqual(md, /badge\/data-(\d+)%20endpoints/g, 1, enabled, "数据端点徽标");
  // README 点名停用的是通达信的三个端点;停用别的端点时要改说明
  assert.ok(disabled.every((e) => e.id.startsWith("tdx_")), `停用的不全是通达信端点:${disabled.map((e) => e.id).join(", ")}`);
});

test("README 栏目数和栏目名跟左侧导航一致", () => {
  const sections = NAV_SECTIONS.map((s) => s.label);
  // 表里每个页面一行:有二级的写「一级 | 二级」,只有一个页面的二级写「—」;产业研究的各板块合成一行「N 个板块」
  const sectorCount = JSON.parse(read("desktop/src/verticals/finance/data/sectors.json")).sectors.length;
  const rows = NAV_SECTIONS.flatMap((s) => [
    ...s.pages.map((p) => [s.label, isGroup(s) ? p.label : "—"]),
    ...(s.listsSectors ? [[s.label, `${sectorCount} 个板块`]] : []),
  ]);
  assert.ok(sections.length >= 5 && rows.length > sections.length, `只从导航里读到 ${sections.length} 个一级、${rows.length} 个页面`);
  // README 的表格是 HTML（标签列 nowrap 防竖排，见 10-10 改动）：表头两列对上后，取到 </table> 为止每行的前两格
  const cell = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  const tableRows = (md: string, [first, second]: [string, string]) => {
    const head = new RegExp(`<tr><th[^>]*>${first}</th><th[^>]*>${second}</th>`);
    const at = md.search(head);
    assert.ok(at >= 0, `README 里找不到表头 ${first} | ${second}`);
    const table = md.slice(at, md.indexOf("</table>", at));
    return [...table.matchAll(/<tr>((?:(?!<\/tr>)[\s\S])*)<\/tr>/g)].slice(1)
      .map((row) => [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(0, 2).map((m) => cell(m[1]!)));
  };

  allEqual(ZH, /\*\*(\d+) 个一级栏目\*\*/g, 1, sections.length, "中文 README「N 个一级栏目」");
  allEqual(ZH, /左侧共 (\d+) 个一级栏目/g, 1, sections.length, "中文 README「左侧共 N 个一级栏目」");
  const listed = ZH.match(/\*\*\d+ 个一级栏目\*\*：(.+?)。/)![1]!.split("、");
  assert.deepEqual(listed, sections, "中文 README 列出的一级栏目名和顺序要跟导航一致");
  assert.deepEqual(tableRows(ZH, ["一级栏目", "二级栏目"]), rows, "中文 README 栏目表要跟导航一致");

  allEqual(EN, /\*\*(\d+) primary sections\*\*/g, 1, sections.length, "English README 'N primary sections'");
  allEqual(EN, /The sidebar has (\d+) primary sections/g, 1, sections.length, "English README sidebar count");
  const enListed = EN.match(/\*\*\d+ primary sections\*\*: (.+?)\.\s/)![1]!.split(/, (?:and )?/);
  assert.equal(enListed.length, sections.length, "English README 列出的一级栏目个数");
  const enTable = tableRows(EN, ["Section", "Page"]);
  assert.equal(enTable.length, rows.length, "English README 栏目表行数");
  // 英文表的一级栏目名跟着中文表分组:同一组的行连在一起、组数相同,只有一个页面的二级同样写「—」
  assert.deepEqual(enTable.map(([, p]) => p === "—"), rows.map(([, p]) => p === "—"), "English README 哪几行没有二级要跟导航一致");
  const groups = (t: string[][]) => t.map(([s]) => s).filter((s, i, a) => s !== a[i - 1]);
  assert.equal(groups(enTable).length, sections.length, "English README 栏目表的一级分组数");
  assert.deepEqual(groups(enTable), enListed, "English README 栏目表的一级顺序要跟列出的一致");
});

test("README 受控工具数和研究阶段数跟实现一致", () => {
  const tools = RUN_TOOLS.length;
  allEqual(ZH, /(\d+) 个受控工具/g, 3, tools, "中文 README「N 个受控工具」");
  const zhList = ZH.match(/\d+ 个受控工具（(.+?)）/)![1]!.split("、");
  assert.equal(zhList.length, tools, `中文 README 列了 ${zhList.length} 个受控工具:${zhList.join(" / ")}`);
  allEqual(EN, new RegExp(`\\b(${EN_WORD}|\\d+) controlled (?:Vibe Research )?tools`, "gi"), 3, tools, "English README 'N controlled tools'");

  const stages = FINANCE_STAGES.length;
  allEqual(ZH, /([一二三四五六七八九十])个?阶段/g, 4, stages, "中文 README「六阶段」");
  allEqual(EN, new RegExp(`\\b(${EN_WORD})[- ]stages?\\b`, "gi"), 4, stages, "English README 'six-stage'");
});

test("README 写的上游版本跟 datasources/UPSTREAM.md 的移植版本一致", () => {
  const upstream = read("datasources/UPSTREAM.md");
  const semver = (s: string) => s.split(".").map(Number);
  const newest = (cell: string) => [...cell.matchAll(/v(\d+\.\d+\.\d+)/g)].map((m) => m[1]!)
    .sort((a, b) => { const [x, y] = [semver(a), semver(b)]; return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!; }).at(-1);
  for (const repo of ["a-stock-data", "global-stock-data"]) {
    const row = upstream.split("\n").find((l) => l.startsWith(`| [${repo}]`));
    assert.ok(row, `UPSTREAM.md 没有 ${repo} 这一行`);
    const ported = newest(row.split("|")[2]!);
    assert.ok(ported, `UPSTREAM.md 的 ${repo} 行没有版本号`);
    const re = new RegExp(`\\[${repo}\\]\\([^)]*\\) v(\\d+\\.\\d+\\.\\d+)`, "g");
    for (const [name, md] of [["中文", ZH], ["English", EN]] as const) {
      const said = [...md.matchAll(re)].map((m) => m[1]!);
      assert.ok(said.length >= 1, `${name} README 没写 ${repo} 的版本`);
      for (const v of said) assert.equal(v, ported, `${name} README 写 ${repo} v${v},UPSTREAM.md 是 v${ported}`);
    }
  }
});
