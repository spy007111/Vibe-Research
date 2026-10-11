import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NAV_SECTIONS } from "../src/verticals/finance/lib/nav.ts";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
test("侧栏两级：一级栏目固定顺序、二级收进组里、接入 AI 固定在底部，保留真实 AI 入口", () => {
  const layout = read("verticals/finance/components/layout/Layout.tsx");
  // 2026-10 Simon：左侧栏目太多要合并成两级（方案与 Codex gpt-6-astra 讨论定稿）；
  // 10-09 Simon 重排：先看自己的股票（首页）→ 复盘 → 产业资讯 → 产业研究 → 研究工具（候选池放最后）
  assert.deepEqual(NAV_SECTIONS.map((s) => s.label), ["首页", "每日复盘", "产业资讯", "产业研究", "研究工具", "我的股票", "资料库", "接入 AI"]);
  assert.deepEqual(NAV_SECTIONS.map((s) => s.pages.map((p) => p.label)), [
    ["首页"], ["每日复盘"], ["资讯雷达", "产业信号"], [], ["个股深挖", "多空辩论", "回测", "候选池"],
    ["自选与持仓", "事件日历", "提醒"], ["我的研报", "研究记录"], ["接入 AI"],
  ]);
  assert.deepEqual(NAV_SECTIONS.filter((s) => s.pinned).map((s) => s.label), ["接入 AI"]);
  assert.match(layout, /\{MAIN_SECTIONS\.map\(renderSection\)\}[\s\S]*?\{PINNED_SECTIONS\.map\(renderSection\)\}/, "接入 AI 在导航下面单独一块，不随导航滚动");
  // 页面里的小分类（资讯来源、GPU 租金）只在页面里切，不占侧栏 —— 但页面里必须真的能切到
  assert.doesNotMatch(layout, /\/intel\/|\/signals\//);
  // 例外：产业研究的各板块列在侧栏二级里（Simon 10-09），名单读产业研究页同一份数据
  assert.match(layout, /const SECTIONS = withSectors\(NAV_SECTIONS, sectorsData\.sectors\);/);
  assert.match(layout, /navPageOf\(pathname, SECTIONS\)/, "当前页按接上板块后的栏目认，板块页高亮它自己");
  assert.match(layout, /navTitle\(pathname, SECTIONS\)/, "顶栏显示板块名");
  assert.match(layout, /max-h-\[calc\(100dvh-16px\)\][^"]*overflow-y-auto/, "收起侧栏时弹出的二级（产业研究 20 项）超高自己滚动");
  assert.match(layout, /<Link to=\{sectionHome\(s\)\}/, "点「产业研究」进总览页，不在二级里重复列一项");
  assert.match(layout, /flyoutSection\.overview\s*\?\s*<Link to=\{flyoutSection\.overview\.to\}/, "收起侧栏时，弹出层的标题能点回总览");
  for (const icon of ["Bot", "Cpu", "MemoryStick", "CircuitBoard", "Rocket", "Database"]) assert.match(layout, new RegExp(`\\b${icon}\\b`), `板块图标 ${icon} 要接进图标表`);
  // 一级栏目的展开按钮是实心三角：收起朝下、展开朝上，不再是往右的箭头
  assert.match(layout, /<path d="M1\.5 3\.25h7L5 7\.5z" fill="currentColor" \/>/);
  assert.match(layout, /open && "rotate-180"/);
  assert.doesNotMatch(layout, /ChevronDown|ChevronRight|-rotate-90/);
  assert.match(read("verticals/finance/pages/Intel.tsx"), /navigate\(`\/intel\/\$\{key\}`\)/);
  assert.match(read("verticals/finance/pages/Signals.tsx"), /navigate\(`\/signals\/\$\{key\}`\)/);
  assert.match(read("verticals/finance/pages/Sectors.tsx"), /to=\{`\/sectors\/\$\{s\.key\}`\}/);
  // 一级文字进第一个页面，箭头只展开 / 收起；展开状态按栏目记住，没点过就跟着当前页走
  assert.match(layout, /const isOpen = \(s: NavSection\) => openGroups\[s\.label\] \?\? here\?\.section === s;/);
  assert.match(layout, /const groupKey = \(label: string\) => `vr-nav3-\$\{label\}`;/);
  const toggle = layout.slice(layout.indexOf("const toggleGroup ="), layout.indexOf("};", layout.indexOf("const toggleGroup =")));
  assert.doesNotMatch(toggle, /setMobileOpen/, "手机抽屉里展开 / 收起组不关抽屉");
  // 侧栏收成图标时，点一级图标弹出二级；Escape 关掉并把焦点还给图标
  assert.match(layout, /e\.key === "Escape"\) \{ e\.preventDefault\(\); setFlyout\(null\); flyoutOpener\.current\?\.focus\(\); \}/);
  assert.match(layout, /aria-haspopup="true" aria-expanded=\{flyout\?\.label === s\.label\}/);
  assert.match(layout, /const currentTitle = navTitle\(pathname, SECTIONS\);/);
  assert.doesNotMatch(layout, /FinanceAiConsole|consoleOpen|vr-ai-console|openAgent|打开普通对话/);
  assert.match(layout, /href="https:\/\/phoenixtree\.ai\/"/);
  for (const label of ["联系作者", "GitHub", "收起侧栏"]) assert.ok(layout.includes(label));
  assert.match(layout, /const \[collapsed, setCollapsed\] = useState\(\(\) => storageGet\("vr-sidebar"\) === "collapsed"\);/, "没点过收起就是展开的文字栏目");
  assert.match(layout, /compact \? "w-14" : "w-\[216px\]"/);
  assert.match(layout, /workspace-topbar flex h-11/, "顶栏 44px");
  // 给右上角「问 Agent」让位：按按钮实际宽度让（系统字体放大、文案变长都不压住主题按钮），按钮不在（首页）就不让
  assert.match(layout, /style=\{\{ marginRight: "var\(--ai-trigger-space, 0px\)" \}\}/);
  assert.doesNotMatch(layout, /"mr-2[48]"/, "不再写死让位宽度");
  const dock = read("core/ai/AiDock.tsx");
  assert.match(dock, /ref=\{triggerRef\}/);
  assert.match(dock, /setProperty\("--ai-trigger-space", `\$\{Math\.ceil\(el\.getBoundingClientRect\(\)\.width\) \+ TRIGGER_GAP\}px`\)/);
  assert.match(dock, /new ResizeObserver\(apply\);\s*ro\?\.observe\(el\);/, "字号变了按钮变宽，让位跟着变");
  assert.match(dock, /root\.style\.removeProperty\("--ai-trigger-space"\)/, "按钮卸载（回首页）就撤掉让位");
  assert.match(layout, /<FinanceAiDock/);
  assert.match(layout, /workspace-sidebar/);
  assert.match(layout, /aria-expanded=\{open\} onClick=\{\(\) => toggleGroup\(s\)\}/);
  assert.match(layout, /aria-label=\{label\}/);
  assert.match(layout, /const closeMobileNav = \(\) => \{\s*setMobileOpen\(false\);[\s\S]*?requestAnimationFrame\(\(\) => menuRef\.current\?\.focus\(\)\)/);
  assert.equal((layout.match(/onClick=\{closeMobileNav\}/g) ?? []).length, 2);
  assert.match(layout, /event\.key === "Escape"[^\n]*closeMobileNav\(\)/);
});
test("静默数据台（2026-10 方向 B）：石墨底、橙色主色、方框面板，不用玻璃和光晕，保留可访问性", () => {
  const css = read("index.css");
  // 中性石墨底（饱和度低、不带蓝），亮 / 暗两套橙色主色
  assert.match(css, /--background: 220 10% 6%/);
  assert.match(css, /--card: 228 11% 9%/);
  assert.match(css, /--primary: 16 100% 56%/);
  assert.match(css, /--primary: 17 88% 36%/);
  assert.match(css, /--radius: 8px/);
  // 红涨绿跌：danger 是红、success 是绿
  assert.match(css, /--danger: 359 87% 62%/);
  assert.match(css, /--success: 151 71% 42%/);
  // 每块数据一个方框：面板底色 + 1px 线框，不投影、不模糊、不加光晕
  assert.match(css, /\.glass \{\s*background-color: hsl\(var\(--card\)\);\s*border: 1px solid hsl\(var\(--border\)\);\s*border-radius: var\(--radius\);\s*\}/);
  assert.doesNotMatch(css, /radial-gradient|blur\(|glass-fill|text-shadow: 0 0/);
  // 面板标题条与紧凑表格
  assert.match(css, /\.workspace-panel-head \{[^}]*min-height: 34px;/);
  assert.match(css, /\.data-table :where\(th\) \{/, "表格默认样式用 :where()，单元格上的 text-right / px-* 才能覆盖");
  assert.doesNotMatch(css, /--workspace-grid|217 92% 72%|263 78% 78%|Songti|STSong|Georgia/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(forced-colors: active\)/);
});
test("左上角使用官网凤凰原始矢量图，不增加外部请求或品牌跳转", () => {
  const layout = read("verticals/finance/components/layout/Layout.tsx");
  const logo = read("verticals/finance/components/ui/PhoenixTreeLogo.tsx");
  assert.match(layout, /<PhoenixTreeLogo/);
  assert.doesNotMatch(layout, /LineChart/);
  assert.match(layout, /to="\/" aria-label="Vibe Research 首页"/);
  assert.match(logo, /viewBox="0 0 674\.547814 1040\.507203"/);
  assert.match(logo, /aria-hidden="true" focusable="false"/);
  assert.match(logo, /fill="currentColor"/);
  assert.doesNotMatch(logo, /<image|<script|<foreignObject|href=|fetch\(/);
});
test("首页以 Agent 为首屏，不自动取数或启动任务", () => {
  const home = read("verticals/finance/pages/Home.tsx");
  assert.doesNotMatch(home, /backend\.fetch|backend\.research/);
  assert.match(home, /<FinanceHomeAgent/);
});
