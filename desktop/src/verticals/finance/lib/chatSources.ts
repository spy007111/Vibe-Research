/**
 * 对话回答下面的「本轮来源」:这一轮查了哪些数据、读了哪些网页和资料。
 * 后端每次工具调用都带一条来源说明(cite);这里只负责排成人能读的清单,不补、不猜。
 */

export interface ToolCite {
  label: string;
  target?: string;
  sources?: string[];
  as_of?: string;
  count?: number;
  partial?: boolean;
  cached?: boolean;
  links?: { title: string; url: string }[];
}
export interface ToolReceipt { name: string; ok: boolean; duration_ms: number; cite?: ToolCite }
export interface ReportSource { id: string; name: string; page: number | null }

export const TOOL_LABEL: Record<string, string> = {
  search_web: "联网搜索", read_web_page: "读取网页", list_endpoints: "查找数据源", fetch_endpoint: "获取数据", list_runs: "查询任务",
  research_status: "查询进度", get_report: "读取报告", get_evidence: "核对证据", knowledge_recall: "读取研究记忆", read_ledger: "读取台账",
  list_tools: "查看工具", run_tool: "运行分析工具", start_research: "准备研究",
};

/** 数据源代号 → 中文名;没列到的照原样显示,不硬翻 */
const SOURCE_CN: Record<string, string> = {
  eastmoney: "东方财富", tencent: "腾讯财经", sina: "新浪财经", sina_abstract: "新浪财经", sina_futures: "新浪期货", ths: "同花顺", iwencai: "问财",
  cninfo: "巨潮资讯", szse: "深交所", sse: "上交所", bse: "北交所", baostock: "baostock", mootdx: "通达信", tdx: "通达信", cls: "财联社",
  wallstreetcn: "华尔街见闻", cctv: "央视新闻", csindex: "中证指数", chinabond: "中债", chinamoney: "中国货币网", "pbc.gov.cn": "人民银行",
  "stats.gov.cn": "国家统计局", sge: "上海黄金交易所", swsresearch: "申万宏源研究", mofcom: "商务部", baidu: "百度", calc: "本地计算",
  yahoo: "Yahoo Finance", nasdaq: "Nasdaq", sec: "SEC", finra: "FINRA", cboe: "Cboe", cftc: "CFTC", "treasury.gov": "美国财政部", finmind: "FinMind",
};
export const sourceName = (id: string) => SOURCE_CN[id] ?? id;

/** 时间统一按北京时间显示到分钟;读不出来就原样给 */
export function shortTime(iso: string, timeZone = "Asia/Shanghai"): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** 关键词、网页标题是外来文字:转义 Markdown 记号,别让它变成链接、标题或加粗 */
const esc = (s: string) => s.replace(/([\\`*_[\]<>#|~])/g, "\\$1");
const linkUrl = (u: string) => u.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
const shortUrl = (u: string) => {
  try { const x = new URL(u); return `${x.host}${x.pathname === "/" ? "" : x.pathname}`.slice(0, 60); } catch { return u.slice(0, 60); }
};
const link = (l: { title: string; url: string }) => `[${esc(l.title || shortUrl(l.url))}](${linkUrl(l.url)})`;

function citeLine(c: ToolCite, timeZone: string): string[] {
  const head = [esc(c.label)];
  if (c.target) head.push(esc(c.target));
  if (c.sources?.length) head.push(c.sources.map(sourceName).map(esc).join("、"));
  if (c.as_of) head.push(`${shortTime(c.as_of, timeZone)} 取`);
  if (c.count !== undefined) head.push(`${c.count} 条`);
  if (c.partial) head.push("只取到一部分");
  if (c.cached) head.push("上次取的快照");
  const links = c.links ?? [];
  // 读网页只有一个地址:直接放在行里;搜索结果逐条列在下面
  if (links.length === 1 && c.count === undefined) return [`- ${[...head, link(links[0]!)].join(" · ")}`];
  return [`- ${head.join(" · ")}`, ...links.map((l) => `  - ${link(l)}`)];
}

/**
 * 回答末尾的来源清单。`tool_activity` 不存在 = 普通对话(没有工具),此时只列引用的资料;
 * Agent 对话一条来源都没有时要明说,别让人以为数字都核对过。
 */
export function sourcesMarkdown(r: { tool_activity?: ToolReceipt[]; report_sources?: ReportSource[] }, timeZone = "Asia/Shanghai"): string {
  const ok: string[] = [];
  const failed: string[] = [];
  const counts = new Map<string, number>();
  const push = (arr: string[], lines: string[]) => {
    const k = lines.join("\n");
    if (counts.has(k)) { counts.set(k, counts.get(k)! + 1); return; }
    counts.set(k, 1);
    arr.push(k);
  };
  for (const t of r.tool_activity ?? []) {
    if (t.ok && t.cite) push(ok, citeLine(t.cite, timeZone));
    else if (!t.ok) push(failed, [`- ${t.cite ? [esc(t.cite.label), t.cite.target ? esc(t.cite.target) : ""].filter(Boolean).join(" · ") : TOOL_LABEL[t.name] ?? esc(t.name)}`]);
  }
  for (const s of r.report_sources ?? []) push(ok, [`- 我的研报 · ${esc(s.name)}${s.page !== null ? ` 第 ${s.page} 页` : ""}`]);
  const times = (k: string) => (counts.get(k)! > 1 ? ` (${counts.get(k)} 次)` : "");
  const withTimes = (k: string) => { const [first, ...rest] = k.split("\n"); return [first + times(k), ...rest].join("\n"); };
  if (!ok.length && !failed.length) {
    return r.tool_activity ? "\n\n---\n本轮没有查数据或资料，回答里的内容没有来源可以核对。" : "";
  }
  const parts = ["\n\n---\n**本轮来源**"];
  if (ok.length) parts.push(ok.map(withTimes).join("\n"));
  else parts.push("没有成功取到的数据或资料。");
  if (failed.length) parts.push(`没成功的:\n${failed.map(withTimes).join("\n")}`);
  return parts.join("\n\n");
}
