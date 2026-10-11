import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { HEAD_CAVEAT, auditHeadline, fileLabel, filesText, fmtAt, issueSubject, recordTitle, type AuditIssue, type AuditNames, type AuditReport } from "../src/verticals/finance/lib/auditView.ts";

const names: AuditNames = {
  run: (id) => (id === "cc-final-1008" ? { name: "中际旭创", symbol: "300308" } : null),
  kindLabel: (k) => ({ note: "研究笔记", thesis: "投资逻辑" } as Record<string, string>)[k] ?? null,
  record: (k, id) => (k === "note" && id === "n1" ? { title: "复盘：光模块订单" } : k === "note" && id === "n2" ? { title: "加了 2000 股，成本 12.5 元" } : k === "thesis" && id === "t1" ? { statement: "x".repeat(60) } : null),
};

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  entries: 12, head: { seq: 12, hash: "a".repeat(64), at: "2026-10-09T06:00:00+08:00" },
  head_text: `登记簿第 12 条 · 2026-10-09 06:00 · ${"a".repeat(64)}`,
  chain_ok: true, problems: [], issues: [], consistent: { run: 3, ledger: 9 }, ...over,
});
const issue = (over: Partial<AuditIssue>): AuditIssue => ({ subject: "run", ref: "cc-final-1008", kind: "changed", why: "", ...over });

test("防篡改核对：显示名用公司 / 标题，取不到就退回编号，不猜", () => {
  assert.equal(issueSubject(issue({}), names), "研究 中际旭创 300308（cc-final-1008）");
  assert.equal(issueSubject(issue({ ref: "gone-run" }), names), "研究 gone-run");
  assert.equal(issueSubject(issue({ subject: "ledger", ref: "note/n1" }), names), "研究笔记「复盘：光模块订单」");
  assert.equal(issueSubject(issue({ subject: "ledger", ref: "note/n9" }), names), "研究笔记（n9）");
  assert.equal(issueSubject(issue({ subject: "ledger", ref: "mystery/z" }), names), "mystery（z）");
  assert.equal(recordTitle({ statement: "x".repeat(60) }), `${"x".repeat(40)}…`);
  assert.equal(recordTitle({ name: "腾讯控股", symbol: "00700" }), "腾讯控股 00700");
  assert.equal(recordTitle({ symbol: "600519", date: "2026-03-02", shares: 100 }), "600519 2026-03-02");
  assert.equal(recordTitle(null), "");
});

test("防篡改核对：文件名翻成中文，多了只列前几个", () => {
  assert.equal(fileLabel("report.md"), "报告（report.md）");
  assert.equal(fileLabel("stages/s1.json"), "阶段结果 s1.json");
  assert.equal(fileLabel("report_appendix.md"), "报告附录（report_appendix.md）");
  assert.equal(fileLabel("viewer.html"), "证据查看器（viewer.html）");
  assert.equal(fileLabel("odd/file.bin"), "odd/file.bin");
  assert.equal(filesText({ changed: ["report.md"], added: [], removed: ["raw/a.csv"] }), "改了：报告（report.md）；少了：原始文件 a.csv");
  const many = filesText({ changed: ["raw/1", "raw/2", "raw/3", "raw/4", "raw/5", "raw/6"], added: [], removed: [] });
  assert.match(many, /等 6 个$/);
  assert.equal(many.split("、").length, 4);
  assert.equal(filesText(undefined), "");
  assert.equal(fmtAt("2026-10-09T06:09:33.120+08:00"), "2026-10-09 06:09");
  assert.equal(fmtAt("坏时间"), "坏时间");
});

test("防篡改核对：结论按严重程度排，链断了压过一切，空登记簿不说完好", () => {
  assert.deepEqual(auditHeadline(report()), { tone: "ok", text: "登记簿完好：共 12 条，3 次研究、9 条记录和登记时一致" });
  const broken = auditHeadline(report({ chain_ok: false, problems: [{ line: 3, seq: 3, why: "改过", serious: true }, { line: 9, seq: null, why: "没写完", serious: false }], issues: [issue({})] }));
  assert.equal(broken.tone, "bad"); assert.match(broken.text, /登记簿本身被改过：1 处/);
  const changed = auditHeadline(report({ issues: [issue({}), issue({ kind: "missing", ref: "r2" }), issue({ kind: "unregistered", ref: "r3" })] }));
  assert.equal(changed.tone, "bad"); assert.match(changed.text, /1 处和登记时不一样，1 处登记过但现在不见了/);
  // 当时登记没写上也会显示成「和登记时不一样」:不能一口咬定是绕开软件改的
  assert.match(changed.text, /也可能是当时登记没写上/); assert.doesNotMatch(changed.text, /不是从软件里改或删的/);
  const unreg = auditHeadline(report({ issues: [issue({ kind: "unregistered" })] }));
  assert.equal(unreg.tone, "warn"); assert.match(unreg.text, /还有 1 条没登记/);
  const empty = auditHeadline(report({ entries: 0, head: null, head_text: null, consistent: { run: 0, ledger: 0 } }));
  assert.equal(empty.tone, "warn"); assert.doesNotMatch(empty.text, /完好/);
  // 局限必须讲清楚：能改数据的人也能重写登记簿，只有另存的链头能发现
  assert.match(HEAD_CAVEAT, /整份登记簿/); assert.match(HEAD_CAVEAT, /别处保存/);
});

test("防篡改核对卡：问题分组列出、按钮只在有对应问题时出现、隐私模式遮标题里的金额股数", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
  try {
    const { AuditFindings, AuditCard } = await server.ssrLoadModule("/src/verticals/finance/components/AuditCard.tsx");
    const { maskPrivateText } = await server.ssrLoadModule("/src/verticals/finance/lib/privacy.ts");
    const render = (r: AuditReport, shown = (s: string) => s) =>
      renderToStaticMarkup(createElement(AuditFindings, { report: r, names, shown, busy: false, onRegister: () => {} }));

    const many = Array.from({ length: 10 }, (_, k) => issue({ kind: "unregistered", ref: `run-${k}` }));
    const html = render(report({
      issues: [
        issue({ files: { changed: ["report.md"], added: [], removed: [] }, last: { seq: 4, at: "2026-10-08T21:30:00+08:00", action: "seal" } }),
        issue({ subject: "ledger", ref: "note/n1", kind: "missing" }),
        ...many,
      ],
      problems: [{ line: 7, seq: 7, why: "这一条被改过", serious: true }],
      chain_ok: false,
    }));
    for (const t of ["和登记时不一样（1）", "登记过，现在不见了（1）", "还没登记（10）", "研究 中际旭创 300308（cc-final-1008）",
      "改了：报告（report.md）", "最后登记 2026-10-08 21:30", "研究笔记「复盘：光模块订单」", "第 7 行：这一条被改过",
      "补登这 10 条", "按现在的内容重新登记", "确认这些已经不在了", "显示全部 10 条"]) assert.ok(html.includes(t), t);
    assert.equal((html.match(/run-\d/g) ?? []).length, 8, "每组先列 8 条");

    const clean = render(report());
    assert.match(clean, /登记簿完好/);
    assert.doesNotMatch(clean, /补登|重新登记|不在了/);
    const onlyUnreg = render(report({ issues: [issue({ kind: "unregistered" })] }));
    assert.match(onlyUnreg, /补登这 1 条/); assert.doesNotMatch(onlyUnreg, /重新登记|不在了/);

    // 隐私模式和研究记录页一样：只遮自己的金额、股数，标题其余照常
    const hidden = render(report({ issues: [issue({ subject: "ledger", ref: "note/n2" })] }), maskPrivateText);
    const li = hidden.match(/<li[^>]*>(.*?)<\/li>/)?.[1] ?? "";
    assert.match(li, /研究笔记「加了 •••• 股，成本 •••• 元」/);
    assert.match(render(report({ issues: [issue({ subject: "ledger", ref: "note/n2" })] })), /2000 股/);

    // 首屏不读盘：只有说明和「核对」按钮
    const first = renderToStaticMarkup(createElement(AuditCard));
    assert.match(first, /防篡改核对/); assert.match(first, />核对</); assert.match(first, /只读/);
    assert.doesNotMatch(first, /登记簿完好|链头/);
  } finally { await server.close(); }
});
