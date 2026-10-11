import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { NAV_SECTIONS, sectionPages } from "../../desktop/src/verticals/finance/lib/nav.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(REPO, "desktop", "src");
const FINANCE = path.join(SRC, "verticals", "finance");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p);

/**
 * 前端的 Core / 垂类边界。
 *
 * 🔴 **2026-08-26 界面整套换成开源版 Vibe-Research 之后,前端的形状变了**:
 *    整套 UI(外壳 / 导航 / 组件 / 页面)都在 `verticals/finance/` 里,
 *    Core 只剩 `src/` 顶层那几个文件(组装根 + 全局样式)。
 *    ⇒ 断言必须跟着改。旧版查的是 `src/core/` 与 `lib/nav.ts`,那两样**已经不存在**,
 *      而 `walk()` 对不存在的目录返回空数组 ⇒ 前三条会**全绿地什么都没查**。
 *      (第四条读文件才炸出来 —— 否则这条棘轮会静默失效,那正是它最该防的事。)
 */

const coreFiles = () =>
  walk(SRC).filter((f) => !rel(f).startsWith("verticals" + path.sep));

test("🔴 Core UI 确实存在 —— 目录改名 / 搬走时,后面几条不许静默变成空查", () => {
  const files = coreFiles().map(rel);
  assert.ok(files.includes("main.tsx"), `没找到组装根 main.tsx,现有 Core 文件:${files.join(", ")}`);
  assert.ok(fs.existsSync(FINANCE), "垂类目录 verticals/finance 不在了");
  assert.ok(walk(FINANCE).length > 20, `垂类文件太少(${walk(FINANCE).length}),路径大概不对`);
});

test("🔴 只有组装根可以 import 垂类 —— 别处 import 等于绕开注册点", () => {
  const roots = new Set(["main.tsx"]);
  const bad: string[] = [];
  for (const f of coreFiles()) {
    const r = rel(f);
    if (roots.has(r)) continue;
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(/from\s+"([^"]+)"/g)) {
      if (/verticals\//.test(m[1]!)) bad.push(`${r} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `只有 main.tsx 能接垂类:\n  ${bad.join("\n  ")}`);
});

test("Core UI 里不许出现行业词(它换个行业要能原样搬走)", () => {
  // ⚠️ 收词优先收完整术语;"证伪 / 目标"这类二字词会命中普通中文,反而制造噪音。
  const WORDS = ["持仓", "涨停", "复盘", "板块", "行情", "标的", "estimates", "valuation",
    "成本", "建仓", "仓位", "裁决点", "证伪条件", "开盘", "收盘", "换手", "账户", "论点", "股票"];
  const hits: string[] = [];
  for (const f of coreFiles()) {
    const s = fs.readFileSync(f, "utf8");
    for (const w of WORDS) if (s.includes(w)) hits.push(`${rel(f)}:${w}`);
  }
  assert.deepEqual(hits, [], `Core UI 出现行业词:\n  ${hits.join("\n  ")}`);
});

test("导航与路由双向对得上 —— 有导航没路由=点了白屏,有路由没导航=永远点不到", () => {
  // ⚠️ 不动态 import .tsx —— Node 的测试跑不了 JSX。路由按文本解析;导航结构在纯数据的 nav.ts 里,直接读。
  const routerSrc = fs.readFileSync(path.join(FINANCE, "router.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  assert.match(layoutSrc, /NAV_SECTIONS/, "侧栏要从 nav.ts 渲染,否则这里查的不是用户看到的导航");

  const routes = [...routerSrc.matchAll(/\{\s*path:\s*"([^"]+)"/g)].map((m) => m[1]!);
  // 一级栏目的总览页（产业研究 → /sectors）也算导航能点到的；各板块走 /sectors/:key
  const navTos = NAV_SECTIONS.flatMap((s) => sectionPages(s).map((p) => p.to));
  assert.ok(routes.length >= 10 && navTos.length >= 10,
    `解析出来太少,正则可能失效:routes=${routes.length} nav=${navTos.length}`);

  // 参数路由(`/sectors/:key`)覆盖它的静态前缀 —— 导航里的子项走的就是这条
  const staticRoutes = routes.filter((p) => !p.includes(":"));
  const paramPrefixes = routes.filter((p) => p.includes(":")).map((p) => p.slice(0, p.indexOf("/:")));
  const reachable = (to: string) =>
    staticRoutes.includes(to) || paramPrefixes.some((pre) => to.startsWith(pre + "/"));

  assert.deepEqual(navTos.filter((t) => !reachable(t)), [], "有导航项没有对应路由(点了白屏)");

  // 反向:每条静态路由要么在导航里,要么是明示的旧地址兼容跳转。
  const redirects = [...routerSrc.matchAll(/\{\s*path:\s*"([^"]+)"\s*,\s*element:\s*<(?:Navigate|Moved)\b/g)].map((m) => m[1]!);
  const orphan = staticRoutes.filter((p) => p !== "/" && !navTos.includes(p) && !redirects.includes(p));
  assert.deepEqual(orphan, [], "有路由不在导航里(永远点不到)");
  // 旧地址要跳到导航里还在的页面,不能跳到另一个旧地址或白屏
  const targets = [...routerSrc.matchAll(/element:\s*<(?:Navigate replace|Moved) to="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(targets.length >= redirects.length, `旧地址跳转只解析出 ${targets.length} 个目标`);
  assert.deepEqual(targets.filter((t) => !navTos.includes(t)), [], "旧地址跳到了导航里没有的页面");

  // 参数路由的静态父路径必须真的存在,否则它谁也点不到
  assert.deepEqual(paramPrefixes.filter((p) => p !== "" && !staticRoutes.includes(p)), [],
    "参数路由的静态父路径要有页面");
});

test("侧栏展示用户指定的品牌官网，并安全打开新标签", () => {
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  assert.match(layoutSrc, /href="https:\/\/phoenixtree\.ai\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(layoutSrc, /aria-label="Phoenix Tree AI 官网（新标签页打开）"/);
  assert.match(layoutSrc, /!compact && <span>phoenixtree\.ai<\/span>/);
  const brandLink = layoutSrc.match(/<a href="https:\/\/phoenixtree\.ai\/"[\s\S]*?<\/a>/)?.[0] ?? "";
  assert.match(brandLink, /text-primary/);
  assert.doesNotMatch(brandLink, /text-muted-foreground|hover:text-foreground/);
  assert.doesNotMatch(layoutSrc, /APP_VERSION|· 本地工作台/);
  assert.equal((layoutSrc.match(/href="https:\/\/phoenixtree\.ai\/"/g) ?? []).length, 1);
  // 实际可见性由浏览器验收；源码断言不假设容器必须是 footer 标签。
  assert.match(layoutSrc, /<Globe[^>]*aria-hidden="true"/);
  assert.match(layoutSrc, /to="\/" aria-label="Vibe Research 首页"/);
});

test("首屏后端失败态给普通用户一键启动命令与重试入口", () => {
  const mainSrc = fs.readFileSync(path.join(SRC, "main.tsx"), "utf8");
  const viteSrc = fs.readFileSync(path.join(REPO, "desktop", "vite.config.ts"), "utf8");
  assert.match(mainSrc, /macOS \/ Linux 请运行 scripts\/start/);
  assert.match(mainSrc, /Windows 请运行 scripts\\\\start\.cmd/);
  assert.match(mainSrc, /retry\.textContent = "重新连接"/);
  assert.match(mainSrc, /window\.location\.reload\(\)/);
  assert.match(viteSrc, /本机服务没有启动或已经关闭/);
  assert.doesNotMatch(viteSrc, /先执行 node orchestrator\/src\/api\.ts/);
});

test("根路径是极简功能首页,首屏可直接与 Agent 交流", () => {
  const routerSrc = fs.readFileSync(path.join(FINANCE, "router.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  const homeSrc = fs.readFileSync(path.join(FINANCE, "pages", "Home.tsx"), "utf8");

  assert.match(routerSrc, /path:\s*"\/",\s*element:\s*<Home\s*\/>/);
  assert.ok(!/Navigate\s+to="\/daily-review"/.test(routerSrc), "根路径仍在跳过首页");
  assert.equal(NAV_SECTIONS[0]!.label, "首页");
  assert.deepEqual(NAV_SECTIONS[0]!.pages.map((p) => p.to), ["/"]);
  // 接入 AI 固定在侧栏底部,所以首页目录里不用再列一遍
  const ai = NAV_SECTIONS.find((s) => s.pages.some((p) => p.to === "/settings"));
  assert.equal(ai?.label, "接入 AI");
  assert.equal(ai?.pinned, true);
  assert.match(homeSrc, /<FinanceHomeAgent\s*\/>/);
  // M23 首屏改为聊天与快捷接入，状态在侧栏显示；不强制跳离首页。
  const featuresSrc = fs.readFileSync(path.join(FINANCE, "lib", "homeFeatures.ts"), "utf8");
  assert.match(homeSrc, /<h1\b[^>]*>Vibe Research 研究工作台<\/h1>/);
  assert.match(layoutSrc, /aiConnectionLabel\(aiRuntime\)/);
  assert.doesNotMatch(layoutSrc, /<Navigate/);
  assert.ok(!/Codex Harness 研究流程|全部功能，一页直达|先看清今天发生了什么/.test(homeSrc),
    "首页仍保留上一版的大段说明");

  for (const route of [
    "/daily-review", "/intel", "/signals", "/sectors", "/candidates", "/backtest",
    "/research", "/debate", "/my-stocks", "/calendar", "/inbox", "/my-reports", "/notes",
  ]) {
    assert.match(featuresSrc, new RegExp(`to:\\s*"${route}"`), `首页缺少功能入口:${route}`);
  }
  // 旧地址只留作跳转,首页不再列
  assert.ok(!/to:\s*"\/(?:stock-data|watchlist|portfolio)\b/.test(featuresSrc), "首页还在列旧地址");
  // 个股页只有一个入口;深度研究是它的分页(?tab=),多空辩论 10-09 起是单独一页(/debate)
  assert.equal((featuresSrc.match(/to:\s*"\/research"/g) ?? []).length, 1, "首页只保留一个个股入口");
});

test("个股深挖只有一个入口、多空辩论是研究工具下单独一页，旧地址跳转且归档保留名称代码与状态时间", () => {
  const routerSrc = fs.readFileSync(path.join(FINANCE, "router.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  const researchSrc = fs.readFileSync(path.join(FINANCE, "pages", "Research.tsx"), "utf8");

  assert.match(routerSrc, /path:\s*"\/stock-data"\s*,\s*element:\s*<Moved\s+to="\/research"\s*\/>/);
  // 10-09 Simon：多空辩论从个股页的分页搬回研究工具下单独一页；个股页旧的 ?tab=debate 由个股页自己跳过去
  assert.match(routerSrc, /path:\s*"\/debate"\s*,\s*lazy:/);
  assert.doesNotMatch(routerSrc, /<Moved\s+to="\/research"\s+tab="debate"/);
  const tools = NAV_SECTIONS.find((s) => s.label === "研究工具");
  assert.deepEqual(tools?.pages.map((p) => [p.to, p.label]), [["/research", "个股深挖"], ["/debate", "多空辩论"], ["/backtest", "回测"], ["/candidates", "候选池"]]);
  assert.equal(NAV_SECTIONS.flatMap((s) => s.pages).filter((p) => p.to === "/research").length, 1, "个股深挖在侧栏里只有一个入口");
  const labels = NAV_SECTIONS.flatMap((s) => [s.label, ...s.pages.map((p) => p.label)]);
  assert.ok(!labels.includes("深度研究"), "深度研究是个股深挖的分页,不占侧栏");
  assert.doesNotMatch(layoutSrc, /个股研究|深度研究/);
  assert.match(researchSrc, /title="个股深挖"/);
  // v2.1 起港美股接通六阶段研究:输入按三市场规范形识别,认不出的拒绝;港股去掉 .HK 后缀,港美股把市场一起传
  assert.match(researchSrc, /const market = marketOfSymbol\(code\);\s*if \(!market\) \{ setErr\(/, "认不出市场的代码不能启动研究");
  assert.match(researchSrc, /const runSymbol = market === "HK" \? code\.slice\(0, 5\) : code;/);
  assert.match(researchSrc, /startResearch\(\{[\s\S]{0,400}symbol:\s*runSymbol,\s*\.\.\.\(market === "CN" \? \{\} : \{ market \}\),[\s\S]{0,400}endpoints:\s*scope,/, "代码和市场必须传到真实研究入口");
  const archiveAt = researchSrc.indexOf("研究归档</h3>");
  assert.ok(archiveAt >= 0, "找不到研究归档的标题");
  const archive = researchSrc.slice(archiveAt);
  // 2026-09-06 Simon 确认补充状态和时间；不改变原导航与研究入口。
  assert.match(archive, /<ResearchRunItem key=\{r\.run_id\} run=\{r\}/);
  const item = fs.readFileSync(path.join(FINANCE, "components", "ResearchRunItem.tsx"), "utf8");
  assert.match(item, /run\.name\s*\?\?\s*"个股"/);
  assert.match(item, /run\.symbol\s*\?\?\s*"—"/);
  assert.match(item, /run\.status/); assert.match(item, /run\.started_at/);
});

test("首页 Agent 是可发送的真实对话区,不是装饰输入框", () => {
  const homeSrc = fs.readFileSync(path.join(FINANCE, "pages", "Home.tsx"), "utf8");
  const dockSrc = fs.readFileSync(path.join(FINANCE, "components", "ui", "FinanceAiDock.tsx"), "utf8");
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  const llmSrc = fs.readFileSync(path.join(FINANCE, "lib", "llm.ts"), "utf8");

  assert.match(homeSrc, /<FinanceHomeAgent\s*\/>/,
    "首页对话可用性必须读取全局 AI 运行状态，不能另开一套后端回落判定");
  const homeAgent = dockSrc.slice(
    dockSrc.indexOf("export function FinanceHomeAgent"),
    dockSrc.indexOf("export function FinanceAiConsole"),
  );
  assert.match(homeAgent, /FinanceHomeAgent\(\)/);
  assert.match(homeAgent, /const configured = runtime\.status === "ok"/);
  assert.match(homeAgent, /useAiChat\("home-agent",\s*sendTurn\)/);
  assert.match(homeAgent, /!configured[\s\S]*<AiMessages[\s\S]*<AiComposer/);
  assert.match(homeAgent, /onPick=\{\(text\) => \{ setDraft\(text\);/,
    "首页任务模板应先填入输入框，不能点击后立刻冒充已执行");
  assert.match(homeAgent, /value=\{draft\}[\s\S]*onValueChange=\{setDraft\}/,
    "预填任务必须允许用户把‘这家公司 / 这个行业’改成真实名称");
  assert.match(homeAgent, /onSend=\{\(text\) => void chat\.submit\(text\)\}/);
  assert.match(homeAgent, /onClick=\{chat\.clear\}/);
  assert.match(dockSrc, /backend\.chat\(message, session, signal\)/,
    "首页 submit 必须最终接到真实后端对话接口");
  assert.match(dockSrc, /FinanceAiConsole[\s\S]*configured=\{runtime\.status === "ok"\}/);
  assert.match(dockSrc, /FinanceAiDock[\s\S]*configured=\{runtime\.status === "ok"\}/);
  const hasLlmBlock = llmSrc.slice(llmSrc.indexOf("export function hasLlm"), llmSrc.indexOf("export function loadLlm"));
  assert.match(hasLlmBlock, /readAiRuntime\(\)/, "全局对话必须识别浏览器里保存的 AI 来源");
  assert.doesNotMatch(hasLlmBlock, /cached|optimistic|backendProvider/,
    "首次接入必须由用户明确选择，不能暗中回落到后端环境变量");
  assert.match(layoutSrc, /pathname !== "\/" && <FinanceAiDock/);
  assert.doesNotMatch(layoutSrc, /FinanceAiConsole|vr-ai-console|toggleConsole/,
    "首页与右上角是聊天入口，不恢复左下角旧卡片");
});

test("全局 AI 来源在品牌区、对话面板与模型页三处口径一致，不再有 Agent 开关和普通对话", () => {
  const layoutSrc = fs.readFileSync(path.join(FINANCE, "components", "layout", "Layout.tsx"), "utf8");
  const dockSrc = fs.readFileSync(path.join(FINANCE, "components", "ui", "FinanceAiDock.tsx"), "utf8");
  const settingsSrc = fs.readFileSync(path.join(FINANCE, "pages", "Settings.tsx"), "utf8");

  assert.match(layoutSrc, /A股、美股、港股的投研工作台/);
  assert.match(layoutSrc, /aiConnectionLabel\(aiRuntime\)/);
  const connectionSrc = fs.readFileSync(path.join(FINANCE, "lib", "aiConnection.ts"), "utf8");
  assert.match(connectionSrc, /Claude订阅/);
  assert.match(connectionSrc, /WorkBuddy CLI/);
  assert.equal(fs.existsSync(path.join(FINANCE, "components", "ui", "AgentToggle.tsx")), false, "Agent 开关已取消");
  for (const [name, src] of [["Layout", layoutSrc], ["FinanceAiDock", dockSrc], ["Settings", settingsSrc]]) {
    assert.doesNotMatch(src, /AgentToggle|agentEnabled|saveExecutionMode|普通对话|Agent 已关闭|默认关闭|开启 ?Agent/,
      `${name} 里还有 Agent 开关或普通对话的文案`);
  }
  assert.match(dockSrc, /研究助手/);
  assert.match(dockSrc, /trigger: "问 Agent"/);
  assert.match(settingsSrc, /一、连接 AI/);
  assert.match(settingsSrc, /二、接入后能做什么/);
  assert.match(settingsSrc, /等待连接 AI/, "未配置时不能冒充已经选中了某个运行时");
  assert.match(settingsSrc, /本地 API 已连接/);
  assert.match(settingsSrc, /WorkBuddy \/ CodeBuddy/);
  assert.match(settingsSrc, /@tencent-ai\/codebuddy-code/);
  assert.doesNotMatch(settingsSrc, /适配器尚未完成|目前只接通 Codex 与 Claude Code/);
});

test("产品能力与密钥文案不许超过代码实际做到的范围", () => {
  const dailySrc = fs.readFileSync(path.join(FINANCE, "pages", "DailyReview.tsx"), "utf8");
  const settingsSrc = fs.readFileSync(path.join(FINANCE, "pages", "Settings.tsx"), "utf8");
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const english = fs.readFileSync(path.join(REPO, "README_en.md"), "utf8");

  const quickReview = dailySrc.match(/\) : !needConfig[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert.match(quickReview, /已经取到的客观数据、缺口与读法护栏交给所选模型整理/);
  assert.match(quickReview, /不会启动完整研究工具链/);
  assert.match(quickReview, /to="\/research"/);
  assert.ok(!/调用[^，。；<]{0,20}工具|校验(?:证据|数据)|证据校验/.test(quickReview),
    `快速复盘段不许承诺实际没有执行的工具或校验:${quickReview}`);

  const runtimeBlock = settingsSrc.slice(settingsSrc.indexOf("const runtimeState"), settingsSrc.indexOf("return (", settingsSrc.indexOf("const runtimeState")));
  assert.match(runtimeBlock, /info\s*\?\s*\{\s*label:\s*"本地 API 已连接"/);
  assert.match(runtimeBlock, /err\s*\?\s*\{\s*label:\s*"本地 API 未连接"/);
  assert.ok(!/label:\s*"(?!本地 API )[^"\n]*已连接"/.test(runtimeBlock),
    `运行状态只能证明本地 API 连通:${runtimeBlock}`);

  const zhSecurity = readme.slice(readme.indexOf("## 安全与隐私"), readme.indexOf("## 开发与测试"));
  const enSecurity = english.slice(english.indexOf("## Security and privacy"), english.indexOf("## Development and tests"));
  assert.match(zhSecurity, /后端默认 provider 的 key 只走环境变量/);
  assert.match(zhSecurity, /浏览器里填写的 API key[^\n]*localStorage/);
  assert.match(zhSecurity, /仅在调用时经本机后端转给所选模型服务商/);
  assert.ok(!/密钥只走环境变量/.test(zhSecurity), "浏览器已支持 localStorage，README 不能继续声称全部密钥只走环境变量");
  assert.match(enSecurity, /backend's default provider come only from environment variables/);
  assert.match(enSecurity, /API key entered in the browser[^\n]*localStorage/);
  assert.match(enSecurity, /sent through the local backend to the selected model provider only when used/);
  assert.ok(!/Secrets via environment variables only/i.test(enSecurity), "English README 不能继续声称全部密钥只走环境变量");
});

test("README 架构图区分本地 Agent 运行时与模型供应商；Codex Harness 只能以「已移除」的身份出现", () => {
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  const english = fs.readFileSync(path.join(REPO, "README_en.md"), "utf8");

  for (const [name, source] of [["中文", readme], ["英文", english]] as const) {
    assert.match(source, /Local Agent Runtime/, `${name} README 架构图没有本地 Agent 运行时`);
    assert.match(source, /Model Provider/, `${name} README 架构图没有把模型供应商拆成独立一层`);
    // v2 不再内置 Harness:提到它的每一行都必须同时说明已经移除,不能再当成现行底座介绍
    const stale = source.split("\n").filter((line) => /Codex Harness/i.test(line) && !/不再|移除|removed|no longer|dropped/i.test(line));
    assert.deepEqual(stale, [], `${name} README 仍把 Codex Harness 当现行底座:${stale.join(" | ")}`);
    assert.doesNotMatch(source, /badge\/runtime-Codex/i, `${name} README 首屏还挂着 Codex Harness 运行时徽标`);
    assert.doesNotMatch(source, /(?:→|->)\s*Codex Harness/i, `${name} README 架构图还把来源路由到 Codex Harness`);
  }
});

test("v2 界面不再有产品专用的 Codex 登录与旧 Responses 引擎文案；Codex 与另外两家同级，用用户自己的 CLI 登录", () => {
  const bad = [/startCodexLogin|\/local-agents\/codex\/login/, /产品专用|产品自带引擎/, /Codex Harness/, /Responses (?:API|引擎)/, /login_pending|login_failed/];
  const offenders: string[] = [];
  for (const f of walk(SRC)) {
    const s = fs.readFileSync(f, "utf8");
    for (const re of bad) if (re.test(s)) offenders.push(`${rel(f)}: ${re}`);
  }
  assert.deepEqual(offenders, [], `界面里还有 v1 的产品专用登录 / 旧引擎文案:\n  ${offenders.join("\n  ")}`);
  const quick = fs.readFileSync(path.join(FINANCE, "components", "ui", "QuickAiConnect.tsx"), "utf8");
  assert.match(quick, /codex login/, "Codex 没登录时要告诉用户去终端运行 codex login");
  const settingsSrc = fs.readFileSync(path.join(FINANCE, "pages", "Settings.tsx"), "utf8");
  assert.match(settingsSrc, /\["cli-codex", "cli-claude", "cli-codebuddy"\]\.includes\(selectedProvider\)/,
    "Codex 是本机订阅 Agent 之一，接入后的说明要与另外两家一致");
  assert.match(settingsSrc, /npm install -g @openai\/codex/);
});
