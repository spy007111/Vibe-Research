import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 前端适配层里几条**只会给出错值、不会报错**的规则。
 *
 * ⚠️ 这里不 import 前端源码(那是 ESM + `@/` 别名 + JSX 的世界,测试跑不动),
 *    而是把被测函数按同一份实现抄进来跑 —— **所以必须同时断言源文件里那一行还在**,
 *    否则源码改了、这里还绿着,测的就是一份影子实现。
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = path.join(REPO, "desktop", "src", "verticals", "finance", "lib");
const backendSrc = fs.readFileSync(path.join(LIB, "backend.ts"), "utf8");
const watchSrc = fs.readFileSync(path.join(LIB, "watchlist.ts"), "utf8");
const notesSrc = fs.readFileSync(path.join(LIB, "notes.ts"), "utf8");

test("num():空字符串是「没有」,不是 0", () => {
  assert.ok(
    backendSrc.includes('if (typeof e.value === "string" && e.value.trim() === "") return null;'),
    "num() 里挡空字符串的那一行不见了 —— Number(\"\") 是 0,会把缺失读成真实零值",
  );
  // 变异对照:没有那一行时,下面这个等价实现会给出 0
  const naive = (v: unknown) => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  assert.equal(naive(""), 0, "前提校验:Number(\"\") 确实是 0(否则这条测试没有意义)");
  assert.equal(naive("   "), 0);
});

test("rows():同 key+field 多条时取资料期最新的,不押在后端返回顺序上", () => {
  // ⚠️ 只断言**行为**(比资料期、取更新的那条),不断言某一行的字面量 ——
  //    第二轮写死了 `(e.period ?? "") > (prev.period ?? "")`,第三轮把比较换成 periodKey 之后
  //    这条就红了,而实现其实是变好了。断言实现细节 = 每次改进都要回来改测试。
  assert.ok(/if \(!prev \|\| periodKey\(e\.period\) > periodKey\(prev\.period\)\) r\.fields\[e\.field\] = e;/.test(backendSrc),
    "rows() 的「取最新资料期」不见了 —— 退回「保留第一条」等于把口径押在上游排序上");
  assert.ok(!/r\.fields\[e\.field\] \?\?= e/.test(backendSrc), "旧的「保留第一条」写法又回来了");
});

test("noteKV():终止符要认中文键,否则未登记的中文键会被上一个键吞掉", () => {
  const m = /const KV_TERM = "([^"]+)"/.exec(backendSrc);
  assert.ok(m, "KV_TERM 不见了或写法变了");
  assert.ok(/u4e00/.test(m![1]!), "KV_TERM 没有覆盖中文标识符 —— 注释宣称「任何标识符」就成了空话");
  // 前提校验:终止符真的能切断
  const term = new RegExp(m![1]!.replace(/\\\\/g, "\\"));
  assert.ok(term.test("资料期="), "中文键匹配不上,规则写错了");
  assert.ok(term.test("predictThisYearEps="), "ASCII 键匹配不上,规则写错了");
});

test("saveWatch():写到一半失败也要把缓存刷成台账真实状态", () => {
  assert.ok(/finally\s*\{[\s\S]*hydrateWatch\(\)/.test(watchSrc),
    "saveWatch 没有在 finally 里重读 —— 中途失败会让界面停在一个从未存在过的列表上");
  assert.ok(!/\bcache = want;/.test(watchSrc),
    "还在直接把「想写成的列表」当结果 —— 那不是台账的真实状态");
});

test("saveWatch():同一页面的连续保存必须串行，旧保存不能反删新代码", () => {
  assert.match(watchSrc, /let saveQueue:\s*Promise<void>/);
  assert.match(watchSrc, /saveQueue\.catch\(\(\) => undefined\)\.then\(\(\) => writeWatch\(want\)\)/);
});

test("hydrate 的慢快照不许覆盖新缓存(读写并发)", () => {
  for (const [name, src] of [["watchlist", watchSrc], ["notes", notesSrc]] as const) {
    assert.ok(/const mine = \+\+seq;/.test(src) && /if \(mine !== seq\) return;/.test(src),
      `${name}.ts 的 hydrate 没有丢弃过期快照 —— 刚存的记录会被在途的旧快照冲掉`);
  }
  assert.ok(/seq\+\+;/.test(notesSrc), "notes 的写入没有推进 seq,在途的旧 hydrate 仍会覆盖它");
});

test("同步读返回副本,不把内部缓存交出去", () => {
  assert.ok(/export function loadWatch\(\): string\[\] \{\s*\n\s*return \[\.\.\.cache\];/.test(watchSrc),
    "loadWatch 直接返回了内部数组");
  assert.ok(/export function loadNotes\(\): Note\[\] \{\s*\n\s*return \[\.\.\.cache\];/.test(notesSrc),
    "loadNotes 直接返回了内部数组");
});

/* 第二轮审计(端点映射)那几条测的是估值 / 分位 / 财报取数函数;这些函数没有页面调用,2026-10-10 随函数一起删掉 */

/* ===== 第三轮复审的三条(其中两条是第二轮修复自己引入的回归) ===== */

test("资料期比较要按时间,不按字符串 —— 月份不补零时字符串比会取到旧的那条", () => {
  assert.ok(/export function periodKey/.test(backendSrc) && /padStart\(8, "0"\)/.test(backendSrc),
    "periodKey 不见了 —— 直接用字符串比 period,'2026-10-31' < '2026-9-30' 为真,「取最新」会取到 9 月");
  assert.ok(/periodKey\(e\.period\) > periodKey\(prev\.period\)/.test(backendSrc),
    "rows() 没有用 periodKey 比较");
  // 前提校验:这个陷阱确实存在
  assert.ok("2026-10-31" < "2026-9-30", "前提校验:未补零时字符串比较确实是反的");
  const key = (s: string) => s.replace(/\d+/g, (d) => d.padStart(8, "0"));
  assert.ok(key("2026-10-31") > key("2026-9-30"), "补齐之后顺序才对");
});

test("noteKV 的中文键要从一个字起算(`年=2026`)", () => {
  const m = /const KV_TERM = "([^"]+)"/.exec(backendSrc);
  assert.ok(m && /\{1,8\}/.test(m[1]!),
    "中文键仍写成 {2,8} —— 单字键会被上一个字段吞掉,而注释宣称的是「任何标识符形状」");
});

/* ===== 个股研究页实测挖出来的（2026-08-27） ===== */

/**
 * 从源文件里把 `noteKV` 重建出来（本文件的既有做法：不 import 前端源码）。
 * ⚠️ 按文件头的规矩，**先断言源里那几段还在** —— 否则源码改了这里还绿着，测的是影子实现。
 */
function rebuildNoteKV(): (note: string) => Record<string, string> {
  const keysM = /const KV_KEYS = \[([\s\S]*?)\] as const;/.exec(backendSrc);
  const termM = /const KV_TERM = "([^"]+)"/.exec(backendSrc);
  const kvM = /const KV = new RegExp\(\s*`([^`]+)`/.exec(backendSrc);
  assert.ok(keysM && termM && kvM, "KV_KEYS / KV_TERM / KV 有一个不见了或写法变了");
  const keys = [...keysM![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const term = termM![1]!.replace(/\\\\/g, "\\");
  const src = kvM![1]!
    .replace("${KV_KEYS.join(\"|\")}", keys.join("|"))
    .replace("${KV_TERM}", term)
    .replace(/\\\\/g, "\\");
  const re = new RegExp(src, "g");
  return (note: string) => {
    const out: Record<string, string> = {};
    for (const m of note.matchAll(re)) {
      const k = m[1]; const v = m[2];
      if (k && v !== undefined && !(k in out)) out[k] = v.trim();
    }
    return out;
  };
}

test("🔴 note 末尾那句没有键的尾注,不能被最后一个键的值吞掉", () => {
  // 真实数据:大宗交易的 note 以 `;单位按东财数据中心口径` 收尾（没有 `=`）。
  // 不挡的话界面上显示成「卖方 = 广发证券…营业部;单位按东财数据中心口径」—— 一眼假,但不报错。
  const kv = rebuildNoteKV()("买方=中信证券股份有限公司总部(非营业场所);卖方=广发证券股份有限公司昆明东风东路证券营业部;单位按东财数据中心口径");
  assert.equal(kv.买方, "中信证券股份有限公司总部(非营业场所)");
  assert.equal(kv.卖方, "广发证券股份有限公司昆明东风东路证券营业部");
});

test("尾注终止符不能误伤正常的 k=v;k=v", () => {
  const kv = rebuildNoteKV()("板块代码=BK0438;当日涨跌=-0.38%;龙头=五芳斋");
  assert.deepEqual([kv.板块代码, kv.当日涨跌, kv.龙头], ["BK0438", "-0.38%", "五芳斋"]);
});

test("个股研究页要用的中文键都在白名单里", () => {
  // 🔴 白名单外的键会被**安静地丢掉** —— 界面上表现为「那一行就是不显示」,
  //    而上层往往还写着 `?? r.note`,于是回退成把整条 note 当文本渲染:
  //    用户看到的是 `板块代码=BK0438;当日涨跌=-0.38%;龙头=五芳斋` 这种内部字符串。
  //    (同一个坑的第三次:研报的 industry、GPU 现货卡的可租张数、这次。)
  const kv = rebuildNoteKV()("买方=A;卖方=B;当日涨跌=-1.5%;龙头=甲;板块代码=BK1;概念=白酒");
  for (const [k, v] of Object.entries({ 买方: "A", 卖方: "B", 当日涨跌: "-1.5%", 龙头: "甲", 板块代码: "BK1", 概念: "白酒" })) {
    assert.equal(kv[k], v, `白名单漏了「${k}」`);
  }
});
