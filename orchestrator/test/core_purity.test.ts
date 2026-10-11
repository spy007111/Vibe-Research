import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
import "../src/finance/register.ts";
import { currentPlugin } from "../src/plugin.ts";
/**
 * **Core 词汇纯净度棘轮**(架构审计 2026-08-24 的第一件事)。
 *
 * 战略:做垂类行业 AgentOS(Core + Plugin),第一个是金融,后面按行业铺开。
 * 审计结论:当前是「金融产品内部包含一批可抽取的通用机制」,**不是**可挂载 FinancePack / RestaurantPack 的 Core;
 * 验收标准是「**Core 中不再出现 A股 / EPS / PE / TTM / 申万行业等词汇**」。
 *
 * 🔴 这不是"代码整洁度"检查,而是**垂类系列能否成立的度量**:
 * Core 里每一处金融词汇,都是明天做餐饮 AgentOS 时要重写或绕开的地方。
 *
 * 做成**棘轮**而不是一次性红灯:87 处不可能一次清完,但**只许变好不许变坏** ——
 * 每搬走一块就把基线调低,新写的 Core 代码不许再引入行业词。
 * ⚠️ 基线只能下调。要上调必须在这里写明理由 —— 那等于承认边界又退了一步。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

/**
 * ASCII 词必须走词边界 —— 否则 `PE` 会命中 TYPE / OPEN / PERMISSION(初版就这么误报了 25 处)。
 * ⚠️ **大小写不敏感**:`pe` / `ttm` / `QFQ` 同样是行业词,区分大小写等于留了一条绕过路径
 * (Codex lexicon-r1 P2)。
 */
const ASCII_TERMS = ["EPS", "PE", "PEG", "TTM", "qfq", "hfq", "EDGAR"];
const CJK_TERMS = [ "申万", "扣非", "归母", "估值", "财报", "股价", "涨跌", "市值", "证券",
  "交易日", "停牌", "复权", "研报", "一致预期", "净利", "营收", "季报", "年报", "个股", "标的",
  "产业链", "上市", "股东", "龙虎榜", "融资融券", "筹码", "行业", "板块",
  // 2026-08-26 补:台账字段名那一批。**这次就是被它们绕过去的** ——
  // Core 的表单组件里写着 cost=成本 / decision_point=裁决点,而词表一个都没收录,棘轮全绿。
  "成本", "持仓", "建仓", "仓位", "裁决点", "证伪条件", "开盘", "收盘", "换手",
  // 2026-10-09 补(Codex 审计 A13):对话提示词里的「不编造行情或财务数字」「运行回测」一直没被看见
  "行情", "财务", "回测",
  // 2026-10-10 补(第四轮审计 A6):市场 / 数据源名 —— 某个数据源专用的联系方式整套写在 Core 里,词表一个都没收
  "港股", "美股", "东财", "大盘", "北交所", "沪深",
  // 2026-10-11 补(VA 审计 Codex 范围 4 第 11 条):核心报错里写死「投资动作建议」、注释里写着「金融工作台」,词表没收
  "金融", "投资动作建议"];
// ⚠️ CJK 没有词边界,**子串会误命中**:先收了"证伪"→ 命中普通中文「已证伪」(=被推翻,
//    任何领域都这么说);"标的" 命中「并入目标的人话」里的 目标的。
//    ⇒ 收词时优先收**不会被别的词包住的完整术语**(证伪条件 / 裁决点),别收通用二字词。

/** 明确属于 finance-pack、不参与本检查的文件(它们本来就该是行业实现) */
/**
 * 曾经的**文件名白名单**。现在全部物理搬进 `src/finance/`,由 `PLUGIN_DIRS` 的目录边界覆盖 ——
 * 审计点名过:文件名白名单挡不住"把通用编排继续写进 src/stages.ts",目录边界才挡得住。
 */
export const FINANCE_FILES: string[] = [];

/**
 * 全局上限:所有 Core 文件的行业词**总数**。**只能下调。**
 *
 * 🔴 为什么在逐文件基线之外还要一个总数:逐文件基线可以"加耦合的同时把该文件基线一起调高",
 * 两条断言都还是绿的(Codex lexicon-r1 P1)。总数是**一个**数字,调高它在 review 里藏不住。
 * ⚠️ 诚实说明:这仍是**约定 + 可见性**,不是机器证明"相对历史只降不升" ——
 * 真要机器保证得跟 git 历史比。它的定位是回归提示器,不是安全边界。
 */
/**
 * 全局上限:所有 Core 文件的行业词**总数**。**已经清到 0,从此零容忍。**
 *
 * 沿革:67(词表有盲区,数不全)→ 146(ASCII 改大小写不敏感)→ 149(修好 A股 正则)
 * → 126(stages / schemas 抽进 Plugin)→ 83(语义槽位 + 报价规则进包)
 * → 69(阶段显示名 / 议题映射 / 提醒字段 / 列标签进包)→ 18(注释措辞中性化)→ **0**。
 *
 * 🔴 **"0" 是什么意思,不是什么意思**:
 * - 是:`src/`(除已声明的 pack 目录)里**不再出现这张词表上的任何词**;
 *   阶段、脚本、计算函数、议题、章节、证据枚举、标准列、语义槽位、报价判定、基准期,
 *   全部经 `Plugin` 注入。
 * - **不是**:Core 已经与垂类完全无关。证据契约里的 `symbol` / `market` / `period` /
 *   `adjustment` 仍带着证券味道;`knowledge.ts` 的档案模板、`stages.ts` 的提示词
 *   仍是金融写法(后者本就在 pack 文件清单里)。**词表只测得到它认识的词。**
 * ⇒ 别把这个 0 当成"可以挂第二个垂类了"的证明;它只证明**这一类耦合**清干净了。
 */
const CEILING = 0;

/**
 * 基线:每个 Core 文件允许的行业词数量。**现在全部为 0** —— 空表即"所有文件都必须是 0"。
 * 新增 Core 文件默认落进这一档;要往里加行业词,先问自己它是不是该进 `src/finance/`。
 */
const BASELINE: Record<string, number> = {};

/**
 * 需要用正则表达的词条(**不走下面的整体转义**)。
 * 🔴 我一度把 `A\s*股` 塞进 `CJK_TERMS`,而那张表在构造正则前会整体转义 —— 于是它变成了
 * 匹配字面文本 `A\s*股` 的模式,`A股` / `A 股` 一个都命中不了,棘轮假绿(Codex lexicon-r2 P1)。
 */
const CJK_PATTERNS: [string, RegExp][] = [
  ["A股", /A\s*股/gi],
  // 🔴 "盘前"会从**落盘前**里切出来 —— CJK 逐词 substring 没有词边界,这类词必须加负向前瞻。
  //    这是继"A股 被整体转义"之后第二次证明:**词表本身不可信时,棘轮的数字就是假的**。
  ["盘前", /(?<!落)盘前/g],
  // 美国证监会只收大写:小写 sec 在 Core 里是「秒」(`ms / 1000` 那类),不能大小写不敏感
  ["SEC", /(?<![A-Za-z])SEC(?![A-Za-z])/g],
];

export function countDomainTerms(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ASCII_TERMS) {
    const n = (text.match(new RegExp(`(?<![A-Za-z])${t}(?![A-Za-z])`, "gi")) ?? []).length;
    if (n) out[t] = n;
  }
  for (const [label, re] of CJK_PATTERNS) {
    const n = (text.match(re) ?? []).length;
    if (n) out[label] = n;
  }
  for (const t of CJK_TERMS) {
    const n = (text.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    if (n) out[t] = n;
  }
  return out;
}

/** 已声明的 Plugin 目录:整目录属于垂类实现,不参与 Core 纯净度检查 */
export const PLUGIN_DIRS = ["finance"];

/**
 * 待检查的 Core 文件(**递归**,相对 `src/` 的路径)。
 *
 * 🔴 初版只扫 `src/` 顶层,于是"把带 PE / 申万 的实现搬进 `src/core/valuation.ts`"
 * 就能整片免检 —— 棘轮看不见的地方才是耦合最容易长回来的地方(Codex lexicon-r1 P1)。
 */
function coreFiles(dir = SRC, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // 🔴 按**相对路径**精确排除,不是按目录名:`PLUGIN_DIRS.includes(e.name)` 会让任意层级的
      //    `src/core/finance/` 也白白拿到豁免,而它根本不是已声明的插件目录(Codex lexicon-r2 P1)
      if (!PLUGIN_DIRS.includes(rel)) out.push(...coreFiles(path.join(dir, e.name), rel));
    } else if (e.name.endsWith(".ts") && !FINANCE_FILES.includes(rel)) {
      out.push(rel);
    }
  }
  return out;
}

const termsIn = (f: string) => Object.values(countDomainTerms(fs.readFileSync(path.join(SRC, f), "utf8"))).reduce((a, b) => a + b, 0);

test("Core 纯净度棘轮:任何 Core 文件的行业词数量都不许高于基线", () => {
  const worse: string[] = [];
  for (const f of coreFiles()) {
    const hits = countDomainTerms(fs.readFileSync(path.join(SRC, f), "utf8"));
    const n = Object.values(hits).reduce((a, b) => a + b, 0);
    const cap = BASELINE[f] ?? 0;
    if (n > cap) {
      worse.push(`${f}: ${n} > 基线 ${cap}(${Object.entries(hits).map(([k, v]) => `${k}×${v}`).join(", ")})`);
    }
  }
  assert.deepEqual(worse, [], `以下 Core 文件的行业耦合变严重了 —— 新代码不许把行业词写进 Core:\n${worse.join("\n")}`);
});

test("基线不许虚高:已经比基线干净的文件要把基线调下来(否则棘轮会松掉)", () => {
  const stale: string[] = [];
  for (const [f, cap] of Object.entries(BASELINE)) {
    if (!fs.existsSync(path.join(SRC, f))) { stale.push(`${f}: 文件已不存在,基线该删`); continue; }
    const n = termsIn(f);
    if (n < cap) stale.push(`${f}: 实际 ${n} < 基线 ${cap},把基线改成 ${n}`);
  }
  assert.deepEqual(stale, [], `棘轮松了 —— 搬走行业代码后要同步下调基线:\n${stale.join("\n")}`);
});

test("全局上限:行业词总数只许降不许升(逐文件基线可以被一起调高,总数藏不住)", () => {
  const total = coreFiles().reduce((a, f) => a + termsIn(f), 0);
  assert.ok(total <= CEILING, `行业词总数 ${total} 超过上限 ${CEILING} —— 新代码不许把行业词写进 Core`);
});

test("进度可见:报出当前总量与干净文件数(不断言,只为让每次跑测试都看得到还差多少)", () => {
  const files = coreFiles();
  let total = 0, clean = 0;
  for (const f of files) { const n = termsIn(f); total += n; if (n === 0) clean += 1; }
  console.error(`[core-purity] 行业词 ${total} 处 · 干净 ${clean}/${files.length} 个文件 · 目标 0`);
  assert.ok(total >= 0);
});

test("A 股要真的能命中(它一度被整体转义成字面量,棘轮因此假绿)", () => {
  assert.deepEqual(countDomainTerms("A股"), { A股: 1 });
  assert.deepEqual(countDomainTerms("A 股"), { A股: 1 });
  assert.deepEqual(countDomainTerms("A   股"), { A股: 1 });
  assert.deepEqual(countDomainTerms("a股"), { A股: 1 });          // 与 ASCII 词表同口径:大小写不敏感
  assert.deepEqual(countDomainTerms("AB股份"), {});
});

test("词表本身要可信:ASCII 词走词边界,不能命中 TYPE / OPEN 里的 PE", () => {
  assert.deepEqual(countDomainTerms("const TYPE = OPEN_PERMISSION;"), {});
  assert.deepEqual(countDomainTerms("PE 为 30 倍"), { PE: 1 });
  assert.deepEqual(countDomainTerms("扣非归母净利"), { 扣非: 1, 归母: 1, 净利: 1 });
  // SEC 只认大写:Core 里的 `sec` 是秒,`SECURITY_HEADERS` 也不算
  assert.deepEqual(countDomainTerms("const sec = ms / 1000; SECURITY_HEADERS; timeoutSec"), {});
  assert.deepEqual(countDomainTerms("SEC EDGAR 的联系方式;VRA_SEC_CONTACT"), { SEC: 2, EDGAR: 1 });
});

/**
 * composition root 守卫:只有**真入口**允许 import 垂类包的 register(副作用注册)。
 *
 * 🔴 全审 r4-P1:原本 9 个文件都无条件 `import "./finance/register.ts"` —— 库模块(service / viewer /
 * knowledge / fixture)只要被引用就会**暗中激活金融包**。后果:换个垂类时这些入口仍跑金融;
 * 同一进程先后用两个垂类会撞进程级单例;而且这层耦合**纯净度词表看不见**(全是英文标识符)。
 */
test("composition root:只有真入口可以 import 垂类包的 register", () => {
  const srcDir = SRC;
  const ENTRY_POINTS = new Set(["run.ts", "api.ts", "mcp.ts", "batch.ts", "alerts.ts", "doctor.ts"]);
  const offenders: string[] = [];
  const walk = (dir: string, rel = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!PLUGIN_DIRS.includes(r)) walk(p, r); continue; }
      if (!e.name.endsWith(".ts")) continue;
      const txt = fs.readFileSync(p, "utf8");
      // 只看 import 语句,注释里提到路径不算
      if (/^\s*import\s+["'][^"']*\/register\.ts["']/m.test(txt) && !ENTRY_POINTS.has(r)) offenders.push(r);
    }
  };
  walk(srcDir);
  assert.deepEqual(offenders, [], `这些不是入口,不该 import 垂类 register(改成由调用方注入):${offenders.join(", ")}`);
});

/**
 * 🔴 词表看不见的那一类:**英文阶段名、市场代码、结构性 import**。
 *
 * 全审 r4 证明了「行业词 0」给的是**错误的安心感** —— 真正的耦合是
 * `stage === "profile"`、`market: ["SH","SZ"]`、`import "./finance/xxx"` 这些,词表一个都数不到。
 * 这条把它们变成机器可查的:**Core 不许出现插件声明的阶段名 / 市场代码字面量,也不许 import 垂类包**。
 *
 * ⚠️ 只查**代码**不查注释 —— 注释里写"这里原本是 `stage === \"profile\"`"是有价值的历史说明,
 *    不是耦合;把它们也算进去只会逼人删掉解释。
 */
test("Core 不许出现垂类的阶段名 / 市场代码字面量,也不许 import 垂类包(词表看不见的那一类)", () => {
  const stages = [...currentPlugin().stages];
  const markets = [...currentPlugin().evidence.markets].filter((m) => m.length >= 2);
  const offenders: string[] = [];
  for (const rel of coreFiles()) {
    const raw = fs.readFileSync(path.join(SRC, rel), "utf8");
    const code = stripComments(raw);
    for (const st of stages) {
      // ⚠️ 只算**当阶段用**的字面量:比较 / 索引 / 数组元素。
      //    实测有四处纯误报:URL 路径段 `parts[2] === "report"`(它是 HTTP 路由不是阶段)、
      //    体检项 id `{ id: "report" }`、查看器的 HTML tab 名 `data-t="report"`。
      //    把这些也算进去只会逼人去改毫无关系的代码 —— 棘轮误报会让人开始无视它。
      const re = new RegExp(`(?:stage\\s*[=!]==?\\s*|includes\\(|\\bstage\\(|\\[)["'\`]${st}["'\`]|["'\`]${st}["'\`]\\s*(?:\\]|,\\s*["'\`](?:${stages.join("|")})["'\`])`, "g");
      const n = (code.match(re) ?? []).length;
      if (n) offenders.push(`${rel}: 阶段名字面量 "${st}" ×${n}`);
    }
    for (const m of markets) {
      const re = new RegExp(`["']${m}["']`, "g");
      const n = (code.match(re) ?? []).length;
      if (n) offenders.push(`${rel}: 市场代码字面量 "${m}" ×${n}`);
    }
    if (/from\s+["'][^"']*\/(finance)\//.test(code)) offenders.push(`${rel}: import 了垂类包`);
  }
  assert.deepEqual(offenders, [], `Core 里不该有垂类字面量 / 垂类 import(改成从契约取):\n  ${offenders.join("\n  ")}`);
});

/** 去掉行注释与块注释(粗略但够用:只用来避免把历史说明当耦合) */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}
