import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigation } from "react-router-dom";
import {
  Activity, Bell, CalendarDays, CandlestickChart, ChevronsLeft, ChevronsRight, Eye, EyeOff, FileText, FlaskConical, Github, Globe, Home, LayoutGrid, Library, ListFilter, Menu, X, Moon, NotebookPen, Radar, Settings, Star, Sun, Swords, Thermometer, UserRound, Wallet,
  Atom, BatteryCharging, BatteryFull, Bot, BrainCircuit, Cable, Car, CircuitBoard, Cpu, Database, Dna, Glasses, MemoryStick, Microchip, Pickaxe, Pill, Plane, Rocket, Shield, UtilityPole,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PhoenixTreeLogo } from "@/components/ui/PhoenixTreeLogo";
import { AiPageProvider } from "../../../../core/ai/pageContext";
import { FinanceAiDock } from "@/components/ui/FinanceAiDock";
import { UpdateBanner } from "./UpdateBanner";
import { useDarkMode } from "@/hooks/useDarkMode";
import { usePrivacyMode } from "@/hooks/usePrivacyMode";
import { storageGet, storageSet } from "@/lib/storage";
import { useAiRuntime } from "@/hooks/useAiRuntime";
import { aiConnectionLabel } from "@/lib/aiConnection";
import { useNotifyUnread } from "@/hooks/useNotifyUnread";
import { NAV_SECTIONS, isGroup, navPageOf, navTitle, sectionHome, withSectors, type NavIcon, type NavSection } from "@/lib/nav";
import sectorsData from "@/data/sectors.json";

const REPO_URL = "https://github.com/simonlin1212/Vibe-Research";
// 作者联系方式
const X_URL = "https://x.com/linsizhen";

const ICONS: Record<NavIcon, LucideIcon> = {
  Home, Swords, Activity, Radar, Thermometer, LayoutGrid, CandlestickChart, FlaskConical, ListFilter, Star, Wallet, CalendarDays, Bell, Library, FileText, NotebookPen, Settings,
  Bot, Cpu, MemoryStick, Cable, CircuitBoard, Microchip, BatteryFull, Plane, Car, Pill,
  UtilityPole, Shield, Atom, Rocket, Dna, Pickaxe, BrainCircuit, Glasses, BatteryCharging, Database,
};

/** 一级栏目的展开按钮：实心三角，收起时朝下（点开往下展开），展开后朝上（点它收回）。Simon 10-09：不要往右的箭头。 */
const Caret = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 10 10" aria-hidden="true" className={cn("h-2.5 w-2.5 transition-transform", open && "rotate-180")}>
    <path d="M1.5 3.25h7L5 7.5z" fill="currentColor" />
  </svg>
);

// 一级栏目的展开状态，按栏目名各存一个键。
// 🔴 键名带版本号（v3 = 2026-10 合并成两级之后）：旧版三个组（资讯雷达 / 产业信号 / 板块中心）的记忆不再适用。
//    没存过 = 跟着当前页走：当前页在这组里就展开，否则收起 —— 一打开先看到一层干净的总览。
const groupKey = (label: string) => `vr-nav3-${label}`;
const hasInbox = (s: NavSection) => s.pages.some((p) => p.to === "/inbox");
// 产业研究的二级接上各板块（名单和图标就是产业研究页读的那份）
const SECTIONS = withSectors(NAV_SECTIONS, sectorsData.sectors);
const MAIN_SECTIONS = SECTIONS.filter((s) => !s.pinned);
const PINNED_SECTIONS = SECTIONS.filter((s) => s.pinned);

export function Layout() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const aiRuntime = useAiRuntime();
  const { dark, toggle } = useDarkMode();
  const privacy = usePrivacyMode();
  const navRef = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeMobileNav = () => {
    setMobileOpen(false);
    // The opener is inert until React commits the closed state.
    requestAnimationFrame(() => menuRef.current?.focus());
  };
  const [collapsed, setCollapsed] = useState(() => storageGet("vr-sidebar") === "collapsed");
  /** 用户点过的展开 / 收起（没点过的组跟着当前页走） */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean | undefined>>(() =>
    Object.fromEntries(SECTIONS.filter(isGroup).map((s) => {
      const v = storageGet(groupKey(s.label));
      return [s.label, v === "open" ? true : v === "closed" ? false : undefined];
    })));
  const here = navPageOf(pathname, SECTIONS);
  const isOpen = (s: NavSection) => openGroups[s.label] ?? here?.section === s;
  const toggleGroup = (s: NavSection) => {
    const next = !isOpen(s);
    setOpenGroups((prev) => ({ ...prev, [s.label]: next }));
    storageSet(groupKey(s.label), next ? "open" : "closed");
  };
  /** 侧栏收成图标时，点一级图标在旁边弹出它的二级栏目 */
  const [flyout, setFlyout] = useState<{ label: string; top: number } | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const flyoutOpener = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    storageSet("vr-sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  // 品牌区、「接入 AI」和底部链接固定，导航本身会滚动。窗口偏矮、二级栏目又展开时，
  // 当前页可能刚好落在可视区外 —— 路由变化后把当前项拉回视野。
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const n = nav.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    const breathingRoom = 8;
    if (a.top < n.top + breathingRoom) nav.scrollTop -= n.top + breathingRoom - a.top;
    if (a.bottom > n.bottom - breathingRoom) nav.scrollTop += a.bottom - (n.bottom - breathingRoom);
  }, [pathname, collapsed]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => {
      setMobile(query.matches);
      setMobileOpen(false);
      if (query.matches && sidebarRef.current?.contains(document.activeElement)) {
        requestAnimationFrame(() => menuRef.current?.focus());
      }
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => { setMobileOpen(false); setFlyout(null); }, [pathname]);
  // 弹出的二级栏目：打开时焦点进第一项；Escape 关掉并把焦点还给图标；点别处关掉
  useEffect(() => {
    if (!flyout) return;
    flyoutRef.current?.querySelector<HTMLElement>("a")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setFlyout(null); flyoutOpener.current?.focus(); }
    };
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!flyoutRef.current?.contains(t) && !flyoutOpener.current?.contains(t)) setFlyout(null);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", down); };
  }, [flyout]);
  useEffect(() => {
    if (!mobileOpen || !mobile) return;
    sidebarRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeMobileNav(); }
      if (event.key !== "Tab") return;
      const items = [...(sidebarRef.current?.querySelectorAll<HTMLElement>("a,button:not(:disabled)") ?? [])];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [mobile, mobileOpen]);
  const compact = collapsed && !mobile;
  useEffect(() => { if (!compact) setFlyout(null); }, [compact]);
  const unread = useNotifyUnread();
  const currentTitle = navTitle(pathname, SECTIONS);

  /** 选中一个目的页：关掉弹出的二级；手机上关抽屉并把焦点交给正文。展开 / 收起组不走这里，抽屉不关。 */
  const picked = () => {
    setFlyout(null);
    if (mobile) { setMobileOpen(false); requestAnimationFrame(() => mainRef.current?.focus()); }
  };
  // 未读角标：「提醒」二级和它所在的「我的股票」一级都显示同一个数（组收起时也看得到）
  const unreadPill = (id: string) => unread > 0 && (
    <span id={id} className={compact ? "sr-only" : "ml-auto rounded-full bg-primary/15 px-1.5 text-[10px] font-medium leading-4 text-primary tabular-nums"}>
      {compact ? `${unread} 条未读` : <>{unread > 99 ? "99+" : unread}<span className="sr-only"> 条未读</span></>}
    </span>
  );
  const unreadDot = unread > 0 && compact && <span aria-hidden="true" className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary" />;
  const linkBase = "workspace-nav-link flex min-w-0 items-center text-[13px] transition-colors";
  const idle = "text-muted-foreground hover:bg-muted/50 hover:text-foreground";

  const pageLinks = (s: NavSection, inFlyout: boolean) => s.pages.map(({ to, icon, label }) => {
    const PIcon = ICONS[icon];
    const inbox = to === "/inbox";
    return <Link key={to} to={to} aria-label={label} aria-current={here?.page.to === to ? "page" : undefined}
      aria-describedby={inbox && unread > 0 ? (inFlyout ? "nav-inbox-unread-flyout" : "nav-inbox-unread") : undefined}
      onClick={picked}
      className={cn("workspace-nav-link flex items-center gap-2 px-2 py-1 text-xs", here?.page.to === to ? "font-medium" : "text-muted-foreground hover:bg-muted/40 hover:text-foreground")}>
      <PIcon className="h-3.5 w-3.5 shrink-0" /><span>{label}</span>
      {inbox && unread > 0 && <span id={inFlyout ? "nav-inbox-unread-flyout" : "nav-inbox-unread"}
        className="ml-auto rounded-full bg-primary/15 px-1.5 text-[10px] font-medium leading-4 text-primary tabular-nums">
        {unread > 99 ? "99+" : unread}<span className="sr-only"> 条未读</span>
      </span>}
    </Link>;
  });

  const renderSection = (s: NavSection) => {
    const Icon = ICONS[s.icon];
    const inSection = here?.section === s;
    if (!isGroup(s)) {
      const { to } = s.pages[0]!;
      return <Link key={s.label} to={to} aria-label={s.label} aria-current={inSection ? "page" : undefined} title={compact ? s.label : undefined}
        onClick={picked}
        className={cn(linkBase, compact ? "justify-center p-2" : "gap-2.5 px-2.5 py-1.5", inSection ? "font-medium" : idle)}>
        <span className="relative shrink-0"><Icon className="h-4 w-4" /></span>{!compact && <span>{s.label}</span>}
      </Link>;
    }
    const inbox = hasInbox(s);
    const describedBy = inbox && unread > 0 ? "nav-section-unread" : undefined;
    if (compact) {
      return <button key={s.label} type="button" aria-label={`${s.label}（打开二级栏目）`} title={s.label}
        aria-haspopup="true" aria-expanded={flyout?.label === s.label} aria-describedby={describedBy}
        data-section-active={inSection ? "closed" : undefined}
        onClick={(e) => {
          if (flyout?.label === s.label) { setFlyout(null); return; }
          flyoutOpener.current = e.currentTarget;
          setFlyout({ label: s.label, top: e.currentTarget.getBoundingClientRect().top });
        }}
        className={cn(linkBase, "w-full justify-center p-2", inSection ? "font-medium" : idle)}>
        <span className="relative shrink-0"><Icon className="h-4 w-4" />{inbox && unreadDot}</span>
        {inbox && unreadPill("nav-section-unread")}
      </button>;
    }
    const open = isOpen(s);
    return <div key={s.label}>
      <div className="flex items-center">
        {/* 一级文字进这组的总览页或第一个页面；旁边的三角只展开 / 收起，不跳页 */}
        <Link to={sectionHome(s)} aria-label={s.label} aria-describedby={describedBy} onClick={picked}
          aria-current={s.overview && here?.page.to === s.overview.to ? "page" : undefined}
          data-section-active={inSection ? (open ? "open" : "closed") : undefined}
          className={cn(linkBase, "flex-1 gap-2.5 px-2.5 py-1.5", inSection ? "font-medium" : idle)}>
          <span className="relative shrink-0"><Icon className="h-4 w-4" /></span><span>{s.label}</span>
          {inbox && unreadPill("nav-section-unread")}
        </Link>
        <button type="button" aria-label={`${open ? "收起" : "展开"}${s.label}的二级栏目`} aria-expanded={open} onClick={() => toggleGroup(s)}
          className="rounded p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          <Caret open={open} />
        </button>
      </div>
      {open && <div className="mb-1 mt-0.5 space-y-0.5 ml-[18px] border-l border-border pl-2">{pageLinks(s, false)}</div>}
    </div>;
  };
  const flyoutSection = flyout ? SECTIONS.find((s) => s.label === flyout.label) ?? null : null;

  return (
    <AiPageProvider>
      <a className="workspace-skip" href="#workspace-main" onClick={e => {
        e.preventDefault(); setMobileOpen(false);
        requestAnimationFrame(() => mainRef.current?.focus());
      }}>跳到内容</a>
      <div className="flex h-dvh overflow-hidden">
        {mobile && mobileOpen && <button className="fixed inset-0 z-40 bg-black/60" tabIndex={-1}
          aria-label="关闭导航遮罩" onClick={closeMobileNav} />}
        <aside ref={sidebarRef} aria-label="产品侧栏" className={cn(
          "workspace-sidebar z-50 flex shrink-0 flex-col",
          mobile ? (mobileOpen ? "fixed inset-y-0 left-0 w-[216px]" : "hidden") : compact ? "w-14" : "w-[216px]",
        )}>
          <div className={cn("border-b border-border", compact ? "p-3" : "px-4 py-3")}>
            <div className="flex items-center justify-between">
              <Link to="/" aria-label="Vibe Research 首页" className="flex items-center gap-2.5">
                <PhoenixTreeLogo className="h-7 w-5 shrink-0 text-primary" />
                {!compact && <span className="workspace-brand text-base font-semibold tracking-tight">Vibe-<span className="text-primary">Research</span></span>}
              </Link>
              {mobile && <button aria-label="关闭导航" className="p-1" onClick={closeMobileNav}><X className="h-4 w-4" /></button>}
            </div>
            {!compact && <div data-ai-identity className="mt-1.5 space-y-0.5">
              <p className="text-[10px] leading-4 text-muted-foreground">A股、美股、港股的投研工作台</p>
              <Link to="/settings" data-testid="ai-runtime-badge" title="查看或更改已保存的 AI 接入" className="flex min-w-0 items-start gap-1 text-[10px] leading-5 text-muted-foreground hover:text-primary">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" /><span>{aiConnectionLabel(aiRuntime)}</span>
              </Link>
            </div>}
          </div>
          <nav ref={navRef} aria-label="原产品板块导航" className={cn("min-h-0 flex-1 space-y-0.5 overflow-auto py-2", compact ? "px-1.5" : "px-2")}>
            {MAIN_SECTIONS.map(renderSection)}
          </nav>
          {/* 接入 AI 固定在导航下面，不随导航滚动 */}
          <div className={cn("border-t border-border py-1.5", compact ? "px-1.5" : "px-2")}>{PINNED_SECTIONS.map(renderSection)}</div>
          {flyoutSection && compact && (
            <div ref={flyoutRef} role="group" aria-label={`${flyoutSection.label}的二级栏目`}
              style={{ top: Math.max(8, Math.min(flyout!.top, window.innerHeight - 48 * flyoutSection.pages.length - 56)) }}
              className="glass fixed left-[60px] z-50 max-h-[calc(100dvh-16px)] w-44 space-y-0.5 overflow-y-auto border border-border bg-card p-1.5 shadow-lg">
              {flyoutSection.overview
                ? <Link to={flyoutSection.overview.to} onClick={picked} aria-current={here?.page.to === flyoutSection.overview.to ? "page" : undefined}
                    className="block rounded px-2 pb-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">{flyoutSection.label}</Link>
                : <p className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{flyoutSection.label}</p>}
              {pageLinks(flyoutSection, true)}
            </div>
          )}
          <div className={cn("border-t border-border", compact ? "p-1.5" : "px-3 py-2")}>
            <div className={cn("flex items-center text-muted-foreground", compact ? "flex-col gap-3" : "justify-between gap-2")}>
              <a href="https://phoenixtree.ai/" target="_blank" rel="noopener noreferrer"
                aria-label="Phoenix Tree AI 官网（新标签页打开）" title="Phoenix Tree AI 官网（新标签页打开）"
                className="flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded text-xs text-primary hover:bg-muted/50">
                <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {!compact && <span>phoenixtree.ai</span>}
              </a>
              <div className={cn("flex gap-2", compact && "flex-col")}>
                <a href={X_URL} target="_blank" rel="noreferrer" aria-label="联系作者" title="联系作者 · X @linsizhen"><UserRound className="h-3.5 w-3.5" /></a>
                <a href={REPO_URL} target="_blank" rel="noreferrer" aria-label="GitHub" title="GitHub"><Github className="h-3.5 w-3.5" /></a>
                {!mobile && <button onClick={() => setCollapsed(!collapsed)} aria-label={compact ? "展开侧栏" : "收起侧栏"} title={compact ? "展开侧栏" : "收起侧栏"}>
                  {compact ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
                </button>}
              </div>
            </div>
          </div>
        </aside>
        <div inert={mobile && mobileOpen} className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="workspace-topbar flex h-11 shrink-0 items-center justify-between gap-3 px-4 md:px-5">
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              <button ref={menuRef} aria-label="打开导航" onClick={() => setMobileOpen(true)} className="p-1 md:hidden"><Menu className="h-4 w-4" /></button>
              <span className="hidden text-muted-foreground sm:inline">工作空间 /</span><strong className="truncate font-semibold">{currentTitle}</strong>
            </div>
            <div className="flex items-center gap-1.5" style={{ marginRight: "var(--ai-trigger-space, 0px)" }}>
              <span className="hidden text-[10px] text-muted-foreground lg:inline">本地金融研究工作台</span>
              <button onClick={privacy.toggle} aria-pressed={privacy.on}
                aria-label={privacy.on ? "关闭隐私模式" : "打开隐私模式"}
                title={privacy.on
                  ? "隐私模式已打开：金额、股数显示成 ••••。点一下恢复显示"
                  : "隐私模式：录屏、截图前打开，金额和股数显示成 ••••，百分比照常。只遮屏幕显示，不影响计算和发给 AI 的内容；对话按措辞识别，个别说法可能遮不到"}
                className={cn("rounded p-1.5 hover:bg-muted", privacy.on ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
                {privacy.on ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <button onClick={toggle} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={dark ? "切换为浅色" : "切换为深色"}>
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </div>
          </header>
          <UpdateBanner />
          <main ref={mainRef} id="workspace-main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto">
            <div className="workspace-content" aria-busy={navigation.state !== "idle"}>
              {navigation.state !== "idle" && <p role="status" className="mb-3 text-sm text-muted-foreground">正在打开页面…</p>}
              <Outlet />
            </div>
          </main>
        </div>
        <div inert={mobile && mobileOpen}>{pathname !== "/" && <FinanceAiDock />}</div>
      </div>
    </AiPageProvider>
  );
}
