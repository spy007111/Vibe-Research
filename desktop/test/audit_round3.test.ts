import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { api, ApiError, gpuForwardOf, SAVED_REFRESH_FAILED } from "../src/verticals/finance/lib/api.ts";
import { backend, type Evidence } from "../src/verticals/finance/lib/backend.ts";
import type { HoldingsView } from "../src/verticals/finance/lib/holdings.ts";

// Codex 审计第三轮（2026-10-10）前端金融页那几条的回归测试
const src = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");

test("C1 批量导入：写进去了、重读持仓失败 → 报「已经导入」，界面清掉这份表格，不让再导一次", async () => {
  const view: HoldingsView = {
    method: "fifo", method_label: "先进先出", methods: [], holdings: [], closed: [], realized: [], dividends: [], issues: [], trades: [], legacy: [], migration_pending: 0, today: "2026-10-10",
  };
  const original = { imp: backend.holdingsImport, ledger: backend.ledger };
  backend.holdingsImport = async () => ({ imported: { backup: "ledger/持仓导入备份-2026-10-10", imported: 2, ids: ["a", "b"] }, view });
  backend.ledger = async () => { throw new ApiError("后台没响应", 503); };
  try {
    await assert.rejects(api.importTrades([{ symbol: "600519", type: "buy", date: "2025-01-02", shares: 1, price: 1 }], "fifo"), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, SAVED_REFRESH_FAILED);
      assert.match(e.message, /已经导入 2 笔/);
      assert.match(e.message, /持仓导入备份-2026-10-10/);
      assert.match(e.message, /不要再导入一次/);
      return true;
    });
  } finally { Object.assign(backend, { holdingsImport: original.imp, ledger: original.ledger }); }

  const ui = src("components/TradeCsvImport.tsx");
  const caught = ui.slice(ui.indexOf("const importNow = async"), ui.indexOf("const status ="));
  const saved = caught.indexOf("e.code === SAVED_REFRESH_FAILED) { setText(\"\"); reset(); setError(e.message); return; }");
  assert.ok(saved > 0, "已写入的情况先单独处理");
  assert.ok(saved < caught.indexOf("await ask(selected, records, true)"), "不再走「重新预览、保留勾选」那条路");
});

test("C2 回测对话和历史报告在隐私模式下遮自己的股数、金额", () => {
  const bt = src("pages/Backtest.tsx");
  assert.match(bt, /const shown = \(t: string\) => \(hide \? maskPrivateText\(t\) : t\);/);
  assert.equal((bt.match(/\{shown\(m\.content\)\}/g) ?? []).length, 2, "用户和 Agent 两种消息都过遮挡");
  assert.ok(!/\{m\.content\}/.test(bt), "没有漏网的原文渲染");
  const rh = src("components/ui/ReportHistory.tsx");
  assert.ok(rh.includes("{shown(n.title)}</span>") && rh.includes("{shown(n.content)}</ReactMarkdown>"));
  assert.ok(!/(?<!\$)\{n\.(title|content)\}/.test(rh), "标题和正文都不直接渲染原文（搜索用的模板字符串不算）");
});

test("C3 持仓变了重新体检时先撤下旧结果，横幅和 AI 上下文不拿旧持仓的结果", () => {
  const x = src("components/PortfolioXray.tsx");
  const run = x.slice(x.indexOf("const run = useCallback"), x.indexOf("useEffect(() => { run(false); }"));
  const clear = run.indexOf("setResult(null);\n    const c = new AbortController();");
  assert.ok(clear > 0, "发新请求前清掉旧结果");
  assert.ok(clear > run.indexOf("cache.sig === s"), "命中缓存时直接换成缓存结果，不用先清");
  assert.ok(clear < run.indexOf('backend.runTool<unknown>("xray"'));
  assert.ok(src("pages/Portfolio.tsx").includes("(xray.result?.ok ? `\\n${xrayContextText(xray.result.view, xray.breaches)}` : \"\")"), "给 AI 的只有当前结果");
});

test("C4 每日复盘记下按哪天写的：保存用那一天，业务日变了要说明", () => {
  const p = src("pages/DailyReview.tsx");
  const runReview = p.slice(p.indexOf("const runReview = async"), p.indexOf("const prompt ="));
  assert.ok(runReview.includes("setReviewDay(bizDay);"), "开写时记下业务日");
  assert.ok(p.includes("title={`每日复盘 ${reviewDay ?? \"（业务日未知）\"}`}"), "保存标题用写的那天，不用现在这一屏的");
  assert.ok(!p.includes("title={`每日复盘 ${bizDay"), "不再用当前业务日命名旧正文");
  assert.match(p, /reviewDay !== bizDay && \(\s*<p[^>]*>这份复盘是按 \{reviewDay \?\? "业务日未知"\} 的数据写的/);
});

test("C5 「存入沉淀」的状态绑在这一份内容上：换了赛道、换了内容回到没存；迟到的回包只改自己那一份", () => {
  const b = src("components/ui/SaveNoteButton.tsx");
  assert.ok(b.includes("const id = `${kind}\\u0000${title}\\u0000${content}`;"));
  assert.ok(b.includes('const state = st.id === id ? st.state : "idle";'), "别的内容的状态不算数");
  assert.equal((b.match(/setSt\(\(s\) => \(s\.id === forId \?/g) ?? []).length, 2, "存成功、存失败都只改发起时那一份");
  assert.ok(!/useState<"idle"/.test(b), "不再有不分内容的单个状态");
});

test("C6 体检横幅的「看明细」先切到体检分页再定位", () => {
  const x = src("components/PortfolioXray.tsx");
  assert.ok(!x.includes("toCard"), "不再直接找可能没挂上的卡片");
  assert.equal((x.match(/onClick=\{onOpen\}/g) ?? []).length, 2, "两个按钮都走调用方给的打开方法");
  assert.match(x, /export const scrollToXray = \(\) => requestAnimationFrame\(\(\) => requestAnimationFrame\(/, "等分页挂上再滚");
  assert.ok(src("pages/Portfolio.tsx").includes('<XrayBanner x={xray} onOpen={() => { setSub("xray"); scrollToXray(); }} />'));
});

test("C7 判据表单挂在现在的个股页「概览」里，事件日历的指引说的就是这里", () => {
  const r = src("pages/Research.tsx");
  const overview = r.slice(r.indexOf('<div hidden={tab !== "overview"}>'), r.indexOf("先在上面选一只股票"));
  assert.ok(overview.includes("<ThesisPanel key={chartSymbol} symbol={chartSymbol} name={stockName || undefined} />"), "按股票区分实例");
  assert.match(src("components/ui/VerdictPanel.tsx"), /个股研究<\/Link> 页选一只股票,「概览」最下面的「我的论点与判据」/);
});

const evd = (field: string, value: number | string | null, record_key: string): Evidence => ({
  id: `ev-${field}`, symbol: "B200", market: "US", field, value, unit: "", currency: "n/a", period: "2026-11-01~2026-11-30", as_of: "2026-10-10",
  source: "kalshi", endpoint: "gpu_rent_thermometer", fetched_at: "2026-10-10T00:00:00Z", adjustment: "none", raw_ref: null, record_key,
});

test("C8 GPU 远期：取到的最低档和概率要显示；没报价、取失败、缺一项分别说明；不补分布", () => {
  const ok = gpuForwardOf({ evidence: [evd("gpu_forward_p_below_lowest_strike", 0.23, "KXB200MS:2026-11"), evd("gpu_forward_lowest_strike_usd", 2.5, "KXB200MS:2026-11")], errors: [] });
  assert.deepEqual(ok, { lowest: { month: "2026-11", strike_usd: 2.5, p_below: 0.23 } });
  assert.equal(ok?.months, undefined, "没有逐档阶梯就不造");
  assert.deepEqual(gpuForwardOf({ evidence: [evd("gpu_forward_status", "unavailable", "KXB200MS")], errors: [] }),
    { unavailable: true, note: "Kalshi 阶梯市场这次没有有效报价（未开盘或无成交）" });
  assert.deepEqual(gpuForwardOf({ evidence: [], errors: ["B200: 超时", "forward: HTTP 502"] }), { err: "HTTP 502" });
  assert.match(gpuForwardOf({ evidence: [evd("gpu_forward_p_below_lowest_strike", 0.23, "KXB200MS:2026-11")], errors: [] })?.err ?? "", /不完整/, "缺最低档不显示半截");
  assert.match(gpuForwardOf({ evidence: [evd("gpu_forward_p_below_lowest_strike", 1.7, "KXB200MS:2026-11"), evd("gpu_forward_lowest_strike_usd", 2.5, "KXB200MS:2026-11")], errors: [] })?.err ?? "", /不完整/, "概率超出 0–1 不显示");
  assert.equal(gpuForwardOf({ evidence: [], errors: [] }), null);
  const page = src("pages/Signals.tsx");
  assert.ok(page.includes(") : fw?.lowest ? ("), "页面有最低档这一支");
  assert.ok(page.includes("这次的取数结果里没有远期这一项。"), "什么都没有时说明，不留空白");
  assert.ok(src("lib/api.ts").includes("forward: gpuForwardOf(e),"));
});
