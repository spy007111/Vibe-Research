import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shortTime, sourcesMarkdown, type ToolReceipt } from "../src/verticals/finance/lib/chatSources.ts";

const r = (name: string, ok: boolean, cite?: ToolReceipt["cite"]): ToolReceipt => ({ name, ok, duration_ms: 1, ...(cite ? { cite } : {}) });

test("时间按北京时间显示到分钟;读不出来原样给", () => {
  assert.equal(shortTime("2026-10-08T07:02:30Z"), "10-08 15:02");
  assert.equal(shortTime("2026-10-08T23:59:00+08:00"), "10-08 23:59");
  assert.equal(shortTime("昨天"), "昨天");
});

test("本轮来源:取数写端点、对象、来源中文名、时间、条数;网页给链接;重复的合并计次;失败单列", () => {
  const md = sourcesMarkdown({
    tool_activity: [
      r("list_endpoints", true),
      r("fetch_endpoint", true, { label: "公告标题", target: "300308", sources: ["szse", "eastmoney", "xyz"], as_of: "2026-10-08T07:02:00Z", count: 30, partial: true }),
      r("fetch_endpoint", true, { label: "公告标题", target: "300308", sources: ["szse", "eastmoney", "xyz"], as_of: "2026-10-08T07:02:00Z", count: 30, partial: true }),
      r("read_web_page", true, { label: "读取网页", as_of: "2026-10-08T07:03:00Z", links: [{ title: "", url: "https://a.example/news/1(2)" }] }),
      r("search_web", true, { label: "联网搜索", target: "800G *光模块*", count: 1, links: [{ title: "[标题]", url: "https://b.example/x" }] }),
      r("fetch_endpoint", false, { label: "腾讯实时行情", target: "600519", sources: ["tencent"] }),
      r("get_report", false),
    ],
    report_sources: [{ id: "a", name: "年报.pdf", page: 3 }, { id: "b", name: "纪要.txt", page: null }],
  });
  assert.equal(md, [
    "\n\n---\n**本轮来源**",
    [
      "- 公告标题 · 300308 · 深交所、东方财富、xyz · 10-08 15:02 取 · 30 条 · 只取到一部分 (2 次)",
      "- 读取网页 · 10-08 15:03 取 · [a.example/news/1(2)](https://a.example/news/1%282%29)",
      "- 联网搜索 · 800G \\*光模块\\* · 1 条\n  - [\\[标题\\]](https://b.example/x)",
      "- 我的研报 · 年报.pdf 第 3 页",
      "- 我的研报 · 纪要.txt",
    ].join("\n"),
    "没成功的:\n- 腾讯实时行情 · 600519\n- 读取报告",
  ].join("\n\n"));
});

test("Agent 对话一条来源都没有要明说;普通对话没有工具时不加任何东西;只有失败时写明没取到", () => {
  assert.match(sourcesMarkdown({ tool_activity: [] }), /本轮没有查数据或资料/);
  assert.match(sourcesMarkdown({ tool_activity: [r("list_runs", true)] }), /本轮没有查数据或资料/);
  assert.equal(sourcesMarkdown({}), "");
  assert.equal(sourcesMarkdown({ report_sources: [] }), "");
  assert.equal(sourcesMarkdown({ report_sources: [{ id: "a", name: "x.pdf", page: 1 }] }), "\n\n---\n**本轮来源**\n\n- 我的研报 · x.pdf 第 1 页");
  assert.equal(sourcesMarkdown({ tool_activity: [r("fetch_endpoint", false, { label: "公告标题", target: "300308" })] }),
    "\n\n---\n**本轮来源**\n\n没有成功取到的数据或资料。\n\n没成功的:\n- 公告标题 · 300308");
});

test("对话入口用来源清单替换了原来的工具流水", () => {
  const src = readFileSync(new URL("../src/verticals/finance/components/ui/FinanceAiDock.tsx", import.meta.url), "utf8");
  assert.match(src, /sourcesMarkdown\(r\)/);
  assert.doesNotMatch(src, /本轮工具记录/);
});
