import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MASK, hideIf, maskPrivateText } from "../src/verticals/finance/lib/privacy.ts";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("hideIf：开着才遮；「—」表示没有数，不遮", () => {
  assert.equal(hideIf(true, "170,000"), MASK);
  assert.equal(hideIf(true, "+20,000"), MASK);
  assert.equal(hideIf(false, "170,000"), "170,000");
  assert.equal(hideIf(true, "—"), "—");
});

test("持仓页发给 AI 的那段文字：股数、成本、市值、盈亏遮掉，现价和百分比留着", () => {
  assert.equal(
    maskPrivateText("贵州茅台(600519,CNY) 100股 成本1500 现价1700 浮盈20000(13.33%)"),
    "贵州茅台(600519,CNY) ••••股 成本•••• 现价1700 浮盈••••(13.33%)");
  assert.equal(maskPrivateText("A 股 CNY：市值170000 浮盈20000(13.33%)"), "A 股 CNY：市值•••• 浮盈••••(13.33%)");
  assert.equal(maskPrivateText("我的持仓：暂无记录。"), "我的持仓：暂无记录。");
});

test("对话里的说法：N 股 / N 手、成本价、浮亏、持仓市值都遮", () => {
  assert.equal(maskPrivateText("持有 1,000 股，成本价 15.20 元，另有 3 手腾讯"), "持有 •••• 股，成本价 •••• 元，另有 •••• 手腾讯");
  assert.equal(maskPrivateText("浮亏 -1,200.5 元"), "浮亏 •••• 元");
  assert.equal(maskPrivateText("你的持仓市值约 17 万元，持仓价值 ¥170,000"), "你的持仓市值约 ••••元，持仓价值 ••••");
  assert.equal(maskPrivateText("已实现盈亏 HK$3,200"), "已实现盈亏 ••••");
});

test("公开数据和百分比不遮：总市值、流通市值、股价、股东户数、每股收益、盈亏比例", () => {
  for (const s of [
    "总市值 2.1 万亿，流通市值 1.9 万亿",
    "600519股价 1700，股东户数 12 万，每股收益 1.2 元",
    "盈亏比例 +13.3%",
    "现价 1700，PE 25，换手 0.8%",
  ]) assert.equal(maskPrivateText(s), s);
});

test("表格按表头遮整列：数量 / 成本 / 市值列遮，现价和百分比列留着；总市值列不算", () => {
  const table = [
    "| 名称 | 数量 | 成本 | 现价 | 市值 | 盈亏% |",
    "|---|---|---|---|---|---|",
    "| 茅台 | 100 | 1,500.00 | 1700 | 170,000 | +13.3% |",
    "",
    "正文里的成本 1500",
  ].join("\n");
  assert.equal(maskPrivateText(table), [
    "| 名称 | 数量 | 成本 | 现价 | 市值 | 盈亏% |",
    "|---|---|---|---|---|---|",
    "| 茅台 | •••• | •••• | 1700 | •••• | +13.3% |",
    "",
    "正文里的成本 ••••",
  ].join("\n"));
  const pub = "| 公司 | 总市值 | PE |\n|:--|--:|--:|\n| 茅台 | 2.1 万亿 | 25 |";
  assert.equal(maskPrivateText(pub), pub);
});

test("隐私模式接到了持仓、导入预览、对话、研究记录和顶栏开关", () => {
  const portfolio = src("verticals/finance/pages/Portfolio.tsx");
  for (const field of ["fmt(total.market_value)", "fmt(total.cost)", "fmt(h.shares)", "fmtPx(h.cost)", "fmt(h.market_value)", "fmtPx(c.price)", "fmt(c.shares)", "fmtPx(c.cost)"]) {
    assert.ok(portfolio.includes(`p(${field})`), `持仓页的 ${field} 没有经过隐私模式`);
  }
  for (const field of ["signed(total.pnl)", "signed(rz.pnl)", "fmt(rz.dividends)", "fmt(data.cny.market_value)", "fmt(data.cny.cost)", "signed(data.cny.pnl)",
    "signed(h.realized_pnl)", "fmt(h.dividends)", "tradeDetail(t)", "signed(x.realized_pnl)", "fmt(x.dividends)", "fmt(x.fees)", "fmt(l.shares)", "fmtPx(l.cost)"]) {
    assert.ok(portfolio.includes(`p(${field})`), `持仓页的 ${field} 没有经过隐私模式`);
  }
  assert.equal((portfolio.match(/\{p\(`\$\{/g) ?? []).length, 3, "持仓浮盈、旧清仓逐条与合计三处盈亏金额都要遮");
  for (const why of ["show(i.why)", "show(l.why)", "show(f.why)"]) assert.ok(portfolio.includes(why), `说明文字 ${why} 里的股数要按措辞遮`);
  assert.match(portfolio, /hide \? maskPrivateText\(text\) : text/);
  assert.match(portfolio, /\{fmtPx\(h\.price\)\}/, "现价是公开行情，不遮");
  assert.match(portfolio, /\$\{h\.pnl_pct\}%/, "盈亏百分比不遮");
  assert.match(portfolio, /context: aiContext/, "发给 AI 的仍是原值");

  assert.match(src("verticals/finance/components/PositionImport.tsx"), /hideIf\(hide, String\(draft\.fields/);
  // 「记一笔」的录入框：导入草稿填进来、手填分红金额时也不能明文（审计 C6）
  assert.match(portfolio, /const PRIVATE_FIELDS = new Set\(\["shares", "price", "fee", "amount"\]\);/);
  assert.match(portfolio, /style=\{hide && PRIVATE_FIELDS\.has\(k\) \? SECRET_INPUT : undefined\}/);
  assert.match(portfolio, /const SECRET_INPUT = \{ WebkitTextSecurity: "disc" \}/);

  const dock = src("verticals/finance/components/ui/FinanceAiDock.tsx");
  assert.equal((dock.match(/displayText=\{displayText\}/g) ?? []).length, 3, "首页对话、底部控制台、页面抽屉三处都要接");
  assert.match(dock, /on \? maskPrivateText : undefined/);

  // Core 只认一个通用的「显示前换文字」参数：提问、回答、记录标题、随问题发送的页面内容都过它；保存用原文
  const messages = src("core/ai/AiMessages.tsx");
  assert.match(messages, /renderReply\(show\(m\.content\)\)/);
  assert.match(messages, /\{show\(m\.content\)\}<\/p>/);
  assert.match(messages, /renderReplyActions\?\.\(m\.content,/, "存进记录用原文");
  assert.match(src("core/ai/AiDock.tsx"), /displayText \? displayText\(page\.context\) : page\.context/);
  assert.match(src("core/ai/AiConsole.tsx"), /displayText\(t\.title\)/);

  const notes = src("verticals/finance/pages/Notes.tsx");
  for (const v of ["n.title", "n.content", "reflectText"]) assert.ok(notes.includes(`shown(${v})`), `研究记录的 ${v} 没有经过隐私模式`);

  const layout = src("verticals/finance/components/layout/Layout.tsx");
  assert.match(layout, /aria-pressed=\{privacy\.on\}/);
  assert.match(layout, /只遮屏幕显示，不影响计算和发给 AI 的内容；对话按措辞识别，个别说法可能遮不到/, "开关说明要如实写局限");
});
