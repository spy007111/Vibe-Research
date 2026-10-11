/**
 * 左侧导航的结构（只有数据，没有组件）：侧栏、顶栏标题、首页目录的分组和测试都读这一份。
 *
 * 最多两级。只有一个页面的一级栏目直接是链接；有几个页面的是一组：一级文字进第一个页面，旁边的三角展开二级。
 * 页面里自己的小分类（资讯来源、GPU 租金、持仓里的收益 / 流水 / 体检 / 回放）只在页面里切，不占侧栏。
 * 例外是产业研究：二级直接是各板块，每个配图标；点「产业研究」本身进全部板块一览（overview），不在二级里重复列（Simon 2026-10-09 定）。
 * 板块名单和图标在 `data/sectors.json`，这个文件不读 JSON —— 侧栏用 `withSectors()` 把名单拼进来，README 栏目表把各板块合成一行。
 *
 * 顺序按炒股的人每天的先后（Simon 2026-10-09 定）：先看自己的股票怎么样（首页），再复盘，再看产业资讯、做产业研究，
 * 最后才是研究工具；候选池放研究工具最后。
 */
export const NAV_ICONS = [
  "Home", "Swords", "Activity", "Radar", "Thermometer", "LayoutGrid", "CandlestickChart",
  "FlaskConical", "ListFilter", "Star", "Wallet", "CalendarDays", "Bell", "Library", "FileText", "NotebookPen", "Settings",
  // 各板块（sectors.json 的 icon 字段）
  "Bot", "Cpu", "MemoryStick", "Cable", "CircuitBoard", "Microchip", "BatteryFull", "Plane", "Car", "Pill",
  "UtilityPole", "Shield", "Atom", "Rocket", "Dna", "Pickaxe", "BrainCircuit", "Glasses", "BatteryCharging", "Database",
] as const;
export type NavIcon = (typeof NAV_ICONS)[number];
export const isNavIcon = (x: unknown): x is NavIcon => typeof x === "string" && (NAV_ICONS as readonly string[]).includes(x);

export interface NavPage { to: string; label: string; icon: NavIcon }
export interface NavSection {
  /** 一级栏目名；同时是展开状态的存储键的一部分 */
  label: string;
  icon: NavIcon;
  pages: NavPage[];
  /** 一级文字进的总览页，不在二级里列（产业研究：点它看全部板块一览，二级直接是各板块） */
  overview?: NavPage;
  /** 二级在 pages 之后接着列各板块（产业研究） */
  listsSectors?: true;
  /** 固定在侧栏底部（接入 AI） */
  pinned?: true;
}

export const NAV_SECTIONS: NavSection[] = [
  { label: "首页", icon: "Home", pages: [{ to: "/", label: "首页", icon: "Home" }] },
  { label: "每日复盘", icon: "Activity", pages: [{ to: "/daily-review", label: "每日复盘", icon: "Activity" }] },
  { label: "产业资讯", icon: "Radar", pages: [
    { to: "/intel", label: "资讯雷达", icon: "Radar" },
    { to: "/signals", label: "产业信号", icon: "Thermometer" },
  ] },
  { label: "产业研究", icon: "LayoutGrid", overview: { to: "/sectors", label: "产业研究", icon: "LayoutGrid" }, listsSectors: true, pages: [] },
  { label: "研究工具", icon: "FlaskConical", pages: [
    { to: "/research", label: "个股深挖", icon: "CandlestickChart" },
    { to: "/debate", label: "多空辩论", icon: "Swords" },
    { to: "/backtest", label: "回测", icon: "FlaskConical" },
    { to: "/candidates", label: "候选池", icon: "ListFilter" },
  ] },
  { label: "我的股票", icon: "Star", pages: [
    { to: "/my-stocks", label: "自选与持仓", icon: "Wallet" },
    { to: "/calendar", label: "事件日历", icon: "CalendarDays" },
    { to: "/inbox", label: "提醒", icon: "Bell" },
  ] },
  { label: "资料库", icon: "Library", pages: [
    { to: "/my-reports", label: "我的研报", icon: "FileText" },
    { to: "/notes", label: "研究记录", icon: "NotebookPen" },
  ] },
  { label: "接入 AI", icon: "Settings", pages: [{ to: "/settings", label: "接入 AI", icon: "Settings" }], pinned: true },
];

/** 有二级栏目的一级（展开 / 收起、收起侧栏时弹出二级） */
export const isGroup = (s: NavSection) => s.pages.length > 1 || !!s.listsSectors;

/** 一级文字点进去的页面：有总览页进总览，否则进第一个二级 */
export const sectionHome = (s: NavSection) => (s.overview ?? s.pages[0]!).to;
/** 一级栏目下所有能认出来的页面（总览页 + 二级） */
export const sectionPages = (s: NavSection) => (s.overview ? [s.overview, ...s.pages] : s.pages);

/** 侧栏里一个板块：地址里的 key、名字、图标（sectors.json 里写的；不认识的名字用格子图标） */
export interface SectorLink { key: string; label: string; icon?: string }

/** 把各板块按名单顺序接到产业研究的二级里；其他栏目原样返回 */
export function withSectors(sections: NavSection[], sectors: readonly SectorLink[]): NavSection[] {
  return sections.map((s) => s.listsSectors
    ? { ...s, pages: [...s.pages, ...sectors.map((x): NavPage => ({ to: `/sectors/${x.key}`, label: x.label, icon: isNavIcon(x.icon) ? x.icon : "LayoutGrid" }))] }
    : s);
}

/**
 * 这个地址属于哪个页面：本身或它下面的子路径（/intel/news 算资讯雷达）。首页只认 "/" 本身。
 * 几个都对得上时取地址最长的那个：接了板块以后 /sectors/humanoid 算「人形机器人」，不算产业研究总览。
 */
export function navPageOf(pathname: string, sections: NavSection[] = NAV_SECTIONS): { section: NavSection; page: NavPage } | null {
  let best: { section: NavSection; page: NavPage } | null = null;
  for (const section of sections) {
    for (const page of sectionPages(section)) {
      const hit = pathname === page.to || (page.to !== "/" && pathname.startsWith(`${page.to}/`));
      if (hit && (!best || page.to.length > best.page.to.length)) best = { section, page };
    }
  }
  return best;
}

/** 顶栏显示的当前位置 */
export const navTitle = (pathname: string, sections: NavSection[] = NAV_SECTIONS) => navPageOf(pathname, sections)?.page.label ?? "工作空间";

/** 搬了家的旧地址跳去哪：原来的查询参数和锚点照带（如 `?symbol=`），再切到新页面里对应的分页（覆盖原来的 tab）。 */
export function movedUrl(to: string, search: string, hash: string, tab?: string): string {
  const q = new URLSearchParams(search);
  if (tab) q.set("tab", tab);
  const s = q.toString();
  return `${to}${s ? `?${s}` : ""}${hash}`;
}
