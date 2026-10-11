import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import {
  CARD_SIZE, GAP_POINTER, REPO_LINE, STATEMENT, amount, beijingTime, cardCounts, cardFlags, cardSubtitle, drawShareCard, factMeta, factValues,
  fitText, gapHeading, num, shareSummary, wrapText, type CardLayout, type ShareCardResult, type ShareCtx, type ShareFact,
} from "../src/verticals/finance/lib/shareCard.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");

const fact = (field: string, label: string, kind: ShareFact["kind"], period: string, values: [number, string, string][], analysts: number | null = null): ShareFact =>
  ({ field, label, kind, period, values: values.map(([value, unit, source], i) => ({ value, unit, source, id: `ev-${field}-${i}` })), analysts });

const RES: ShareCardResult = {
  run_id: "cc-final-1008", symbol: "300308", market: "SZ", name: "中际旭创", status: "complete", finished_at: "2026-10-08T08:52:58.699+08:00", test_scenario: false,
  facts: [
    fact("price", "股价", "snapshot", "2026-09-30", [[808.44, "元", "tencent"]]),
    fact("total_market_cap", "总市值", "snapshot", "2026-10-08", [[952269000000, "元", "eastmoney"], [9522.69, "亿元", "tencent"]]),
    fact("pe_ttm", "市盈率(TTM)", "snapshot", "2026-09-30", [[46.56, "倍", "tencent"], [46.6, "倍", "eastmoney"]]),
    fact("revenue_cum", "营业收入", "cum", "2026-06-30", [[41777861795.03, "元", "sina_abstract"]]),
    fact("net_profit_parent_cum", "归母净利润", "cum", "2026-06-30", [[-13651149693.27, "元", "sina_abstract"]]),
    fact("eps_consensus_mean", "一致预期每股收益", "fy", "FY2026", [[28.81, "元/股", "ths"]], 29),
  ],
  missing_facts: ["市净率"],
  counts: { evidence: 1014, sources: 17, calculations: 30, stages_done: 6, stages_total: 6, conflicts: 0 },
  gaps: [
    { operation: "sw_industry", kind: "source_failed", label: "申万行业分类" },
    { operation: "policy_access", kind: "source_partial", label: "管制与准入" },
    { operation: "industry-chain", kind: "optional_skipped", label: "产业链核对" },
  ],
};

test("数字和金额只换算显示:元 → 亿元 / 万元,外币上亿写「亿 USD」,其他单位原样;整数不补小数,小于 1 的留 4 位有效数字", () => {
  assert.deepEqual([num(808.44), num(808), num(23.891234), num(0.012345), num(-1.5)], ["808.44", "808", "23.89", "0.01235", "-1.50"]);
  assert.deepEqual([amount(1e8, "元"), amount(99999999, "元"), amount(1e4, "元"), amount(9999, "元")], ["1.00 亿元", "10000.00 万元", "1.00 万元", "9999 元"]);
  assert.deepEqual([amount(41777861795.03, "元"), amount(-1.96e7, "元"), amount(5000, "元"), amount(9522.69, "亿元"), amount(46.56, "倍"), amount(29, "家"), amount(1.2e9, "USD"), amount(3.5, "")],
    ["417.78 亿元", "-1960.00 万元", "5000 元", "9522.69 亿元", "46.56 倍", "29 家", "12.00 亿 USD", "3.50"]);
  assert.deepEqual([amount(5e8, "USD"), amount(9.9e7, "USD")], ["5.00 亿 USD", "99000000 USD"]);
  assert.deepEqual([amount(364357000000, "美元"), amount(401243000000, "港元"), amount(9.9e7, "美元"), amount(37406.98, "亿港元")], ["3643.57 亿美元", "4012.43 亿港元", "99000000 美元", "37406.98 亿港元"]);
  assert.equal(factMeta({ field: "revenue_cum", label: "营业收入", kind: "cum", period: "2025-09-28..2026-06-27", values: [], analysts: null }), "报告期 2025-09-28 至 2026-06-27 · 累计");
});

test("同一期几个来源:换算后一样的合成一条、来源并列;不一样的分开列;没写来源的注明", () => {
  assert.deepEqual(factValues(RES.facts[1]!), [{ text: "9522.69 亿元", sources: "东方财富、腾讯财经" }]);
  assert.deepEqual(factValues(RES.facts[2]!), [{ text: "46.56 倍", sources: "腾讯财经" }, { text: "46.60 倍", sources: "东方财富" }]);
  assert.deepEqual(factValues(fact("price", "股价", "snapshot", "x", [[1, "元", ""], [1, "元", ""]])), [{ text: "1 元", sources: "来源未注明" }]);
  assert.deepEqual(RES.facts.map(factMeta), ["2026-09-30", "2026-10-08", "2026-09-30", "报告期 2026-06-30 · 累计", "报告期 2026-06-30 · 累计", "FY2026 全年 · 29 家机构"]);
  assert.equal(factMeta({ ...RES.facts[5]!, analysts: null }), "FY2026 全年");
});

test("页眉:北京时间带年份;没名称时不重复代码;测试数据和没做完要标出来;数量取不到写「—」", () => {
  assert.equal(beijingTime("2026-10-08T00:52:58Z"), "2026-10-08 08:52");
  assert.equal(beijingTime("2026-12-31T16:30:00Z"), "2027-01-01 00:30");
  assert.equal(beijingTime("bad"), "bad");
  assert.equal(cardSubtitle(RES), "300308 · 深市 · 研究完成于 2026-10-08 08:52(北京时间)");
  assert.equal(cardSubtitle({ ...RES, name: null, market: "XX" }), "XX · 研究完成于 2026-10-08 08:52(北京时间)");
  assert.deepEqual(cardFlags(RES), []);
  assert.deepEqual(cardFlags({ ...RES, test_scenario: true, status: "incomplete", counts: { ...RES.counts, stages_done: 2 } }),
    ["测试场景:用的是测试数据,不是真实行情", "研究没全部做完:2/6 个阶段完成,数据可能不全"]);
  assert.deepEqual(cardCounts({ ...RES, counts: { ...RES.counts, calculations: null, conflicts: null } }).map((c) => c.n), ["1014", "17", "—", "6/6", "—"]);
});

test("文字版:和卡片同样的内容,同期所有来源的值都列全;带声明和出处;不含目标价 / 买卖 / 评级 / 胜率", () => {
  assert.deepEqual(shareSummary(RES), [
    "【研究分享卡】中际旭创(300308 · 深市 · 研究完成于 2026-10-08 08:52(北京时间))",
    "【关键数据】证据原值:",
    "  股价:808.44 元(腾讯财经) · 2026-09-30",
    "  总市值:9522.69 亿元(东方财富、腾讯财经) · 2026-10-08",
    "  市盈率(TTM):46.56 倍(腾讯财经) / 46.60 倍(东方财富) · 2026-09-30",
    "  营业收入:417.78 亿元(新浪财经) · 报告期 2026-06-30 · 累计",
    "  归母净利润:-136.51 亿元(新浪财经) · 报告期 2026-06-30 · 累计",
    "  一致预期每股收益:28.81 元/股(同花顺) · FY2026 全年 · 29 家机构",
    "  没取到:市净率",
    "【这次研究用了】1014 条证据 · 17 个来源 · 30 项计算 · 6/6 个阶段完成 · 0 处来源冲突",
    "【数据缺口 3 处】",
    "  没取到 · 申万行业分类",
    "  只取到一部分 · 管制与准入",
    "  这次没做 · 产业链核对",
    `  ${GAP_POINTER}`,
    STATEMENT,
    REPO_LINE,
  ]);
  const bare = shareSummary({ ...RES, facts: [], missing_facts: [], gaps: [], test_scenario: true });
  assert.ok(bare.includes("⚠ 测试场景:用的是测试数据,不是真实行情"));
  assert.ok(bare.includes("【数据缺口:这次没有记下缺口】") && !bare.includes(`  ${GAP_POINTER}`));
  assert.doesNotMatch(shareSummary(RES).join("\n"), /目标价|买入|卖出|评级|胜率/);
  // 后端把同名的缺口合成一行并给出处数:标题按处数加总,不按行数(审查 R3-4);老接口没有 count 按 1 处
  assert.equal(gapHeading({ ...RES, gaps: [{ operation: "a", kind: "upstream_missing", label: "其他 3 处", count: 3 }, ...RES.gaps] }), "数据缺口 6 处");
});

/** 假画布:按字估宽(中文 = 字号,其余 0.56 字号),记下每次画字的位置、字号、对齐和颜色 */
type Drawn = { text: string; x: number; y: number; size: number; w: number; align: string; color: string };
function fakeCtx(): { ctx: ShareCtx; texts: Drawn[]; fills: string[]; rects: { y: number; color: string }[] } {
  const texts: Drawn[] = [];
  const fills: string[] = [];
  const rects: { y: number; color: string }[] = [];
  const size = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10);
  const ctx = {
    font: "10px sans-serif", fillStyle: "#000" as string, strokeStyle: "#000", lineWidth: 1, textAlign: "left", textBaseline: "alphabetic",
    measureText(t: string) { const s = size(this.font); return { width: [...t].reduce((a, ch) => a + (ch.codePointAt(0)! > 0x2e80 ? s : s * 0.56), 0) }; },
    fillText(t: string, x: number, y: number) {
      texts.push({ text: t, x, y, size: size(this.font), w: this.measureText(t).width, align: this.textAlign, color: String(this.fillStyle) });
    },
    fillRect(_x: number, y: number) { fills.push(String(this.fillStyle)); rects.push({ y, color: String(this.fillStyle) }); },
  };
  return { ctx: ctx as unknown as ShareCtx, texts, fills, rects };
}

function heavy(): ShareCardResult {
  return {
    ...RES, run_id: `run-${"x".repeat(70)}`, name: "某某超长名称科技股份有限公司集团控股有限责任公司测试用名称", test_scenario: true, status: "incomplete",
    counts: { ...RES.counts, calculations: null, conflicts: null, stages_done: 3 },
    facts: [...RES.facts, fact("pb", "市净率", "snapshot", "2026-09-30", [[1, "倍", "tencent"]])].map((f) => ({
      ...f, values: [0, 1, 2].map((i) => ({ value: (f.values[0]!.value) * (1 + i / 100), unit: f.values[0]!.unit, source: ["tencent", "eastmoney", "sina"][i]!, id: `${f.field}-${i}` })),
    })),
    missing_facts: [],
    gaps: Array.from({ length: 20 }, (_, i) => ({ operation: `op${i}`, kind: "source_failed" as const, label: `很长的缺口名称很长的缺口名称很长的缺口名称${i}` })),
  };
}

function check(r: ShareCardResult, layout: CardLayout) {
  const { ctx, texts, fills, rects } = fakeCtx();
  drawShareCard(ctx, r, layout);
  const { w: W, h: H } = CARD_SIZE[layout];
  const P = layout === "portrait" ? 88 : 80;
  const boxes = texts.map((t) => ({ ...t, l: t.align === "right" ? t.x - t.w : t.x, r: t.align === "right" ? t.x : t.x + t.w, b: t.y + t.size }));
  for (const b of boxes) {
    assert.ok(b.l >= P - 0.5 && b.r <= W - P + 0.5 && b.y >= P - 40 && b.b <= H - P, `${layout} 出了页边距:${b.text} ${JSON.stringify([b.l, b.y, b.r, b.b])}`);
    assert.ok(b.text.length > 0);
  }
  // 页脚先画:出处那行之后画的都是正文,要和页脚分隔线隔开至少 24
  const footLine = rects.find((x) => x.color === "#E2E0DA")!.y;
  const repoAt = texts.findIndex((t) => t.text === REPO_LINE);
  assert.ok(repoAt >= 0 && boxes.slice(0, repoAt + 1).every((b) => b.y > footLine), `${layout} 页脚都在分隔线下面`);
  for (const b of boxes.slice(repoAt + 1)) assert.ok(b.b <= footLine - 24, `${layout} 正文压到页脚:${b.text} 底 ${b.b},分隔线 ${footLine}`);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, c = boxes[j]!;
    const overlap = Math.min(a.r, c.r) - Math.max(a.l, c.l) > 0.5 && Math.min(a.b, c.b) - Math.max(a.y, c.y) > 0.5;
    assert.ok(!overlap, `${layout} 文字叠在一起:「${a.text}」和「${c.text}」`);
  }
  const all = texts.map((t) => t.text).join("\n");
  assert.doesNotMatch(all, /目标价|买入|卖出|评级|胜率/);
  // 红涨绿跌:卡片上只有墨色、灰、蓝和浅底色
  for (const c of [...texts.map((t) => t.color), ...fills]) assert.ok(["#FAFAF7", "#1A1A1A", "#6B6B6B", "#2F5BEA", "#E2E0DA", "#EAEFFC"].includes(c), `用了别的颜色 ${c}`);
  return { texts, all };
}

test("画卡片:竖版 / 横版、正常 / 塞满 / 空的,所有字都在画面里、互不重叠;声明完整、出处和研究编号都在;只用墨色和蓝色", () => {
  for (const layout of ["portrait", "landscape"] as const) {
    const { texts, all } = check(RES, layout);
    const stmt = texts.filter((t) => t.size === 24 && STATEMENT.includes(t.text)).map((t) => t.text).join("");
    assert.equal(stmt, STATEMENT, `${layout} 声明要完整画出`);
    for (const s of [REPO_LINE, "研究编号 cc-final-1008", "中际旭创", "股价", "808.44 元", "9522.69 亿元", "东方财富、腾讯财经", "46.60 倍", "-136.51 亿元", "FY2026 全年 · 29 家机构",
      "没取到:市净率", "1014", "6/6", "数据缺口 3 处", "申万行业分类", "只取到一部分", GAP_POINTER]) assert.ok(all.includes(s), `${layout} 缺:${s}`);
    assert.ok(!all.includes("测试场景"));

    const h = check(heavy(), layout);
    assert.match(h.all, /测试场景:用的是测试数据,不是真实行情/);
    assert.match(h.all, /研究没全部做完:3\/6 个阶段完成/);
    assert.match(h.all, /某某超长名称.*…/, "名称放不下截断");
    // 竖版放不下就截断(不压到左边的品牌,重叠检查兜底);横版宽,放得下全写
    assert.match(h.all, layout === "portrait" ? /研究编号 run-x+…/ : new RegExp(`研究编号 run-x{70}\n`), "研究编号太长截断");
    assert.match(h.all, /还有 \d+ 处;原因见报告「数据缺口」一节/, "缺口放不下写还有几处");
    assert.match(h.all, /另有 \d+ 个来源数值不同,见文字版/, "每项三个来源放不下时注明");
    const shownGaps = h.texts.filter((t) => /^很长的缺口名称/.test(t.text)).length;
    const rest = Number(/还有 (\d+) 处/.exec(h.all)![1]);
    assert.equal(shownGaps + rest, 20, "画出来的 + 还有几处 = 全部缺口");
    const dropped = Number(/另有 (\d+) 项放不下/.exec(h.all)?.[1] ?? 0);
    const labels = ["股价", "总市值", "市盈率(TTM)", "营业收入", "归母净利润", "一致预期每股收益", "市净率"].filter((l) => h.texts.some((t) => t.text === l)).length;
    assert.equal(labels + dropped, 7, "画出来的事实 + 放不下的 = 全部");
    if (layout === "portrait") assert.equal(labels, 7, "竖版塞满时改紧凑版,七项都放得下");

    const e = check({ ...RES, name: null, facts: [], missing_facts: ["股价", "总市值", "市盈率(TTM)", "市净率", "营业收入", "归母净利润", "一致预期每股收益"], gaps: [] }, layout);
    assert.match(e.all, /数据缺口:这次没有记下缺口/);
    assert.ok(e.texts.some((t) => t.text === "300308" && t.size >= 64), "没名称时标题是代码");
    assert.ok(e.all.replace(/\n/g, "").includes("一致预期每股收益"), "没取到的清单折行写全");
  }
});

test("关键数据怎么排只看事实本身:缺口多少(段落间距分多少)不影响放几项、每项放几个值", () => {
  const LABELS = ["股价", "总市值", "市盈率(TTM)", "市净率", "营业收入", "归母净利润", "一致预期每股收益"];
  for (const layout of ["portrait", "landscape"] as const) for (let n = 1; n <= 7; n++) for (const k of [1, 2, 3]) {
    const seen = new Set<string>();
    for (let g = 0; g <= 8; g++) {
      const { ctx, texts } = fakeCtx();
      drawShareCard(ctx, {
        ...RES, missing_facts: [],
        facts: LABELS.slice(0, n).map((l, i) => fact(`f${i}`, l, "snapshot", "2026-09-30", Array.from({ length: k }, (_, j) => [100 + i + j / 100, "元", ["tencent", "eastmoney", "sina"][j]!] as [number, string, string]))),
        gaps: Array.from({ length: g }, (_, i) => ({ operation: `o${i}`, kind: "source_failed" as const, label: `缺口${i}` })),
      }, layout);
      const from = texts.findIndex((t) => t.text === "关键数据");
      const to = texts.findIndex((t) => t.text === "这次研究用了");
      seen.add(texts.slice(from, to).map((t) => t.text).join("|"));
    }
    assert.equal(seen.size, 1, `${layout} ${n} 项 × ${k} 个值:缺口数不同,关键数据排法变了`);
  }
});

test("横版塞到放不下:整行的事实不画、注明另有几项,不压到页脚", () => {
  const tall = heavy();
  tall.facts = tall.facts.map((f) => ({ ...f, values: f.values.map((v, i) => ({ ...v, source: `very_long_source_code_number_${i}_for_layout` })) }));
  const h = check(tall, "landscape");
  const dropped = Number(/另有 (\d+) 项放不下/.exec(h.all)?.[1] ?? 0);
  assert.ok(dropped >= 1, "第三行放不下");
  assert.equal(["股价", "总市值", "市盈率(TTM)", "营业收入", "归母净利润", "一致预期每股收益", "市净率"].filter((l) => h.texts.some((t) => t.text === l)).length + dropped, 7);
});

test("竖版内容少时把空白分到段落间距里,但不因此挤得关键数据改紧凑版;剩下的空白有上限", () => {
  const LABELS = ["股价", "总市值", "市盈率(TTM)", "市净率", "营业收入"];
  const mk = (gaps: number): ShareCardResult => ({
    ...RES, missing_facts: [],
    facts: LABELS.map((l, i) => fact(`f${i}`, l, "snapshot", "2026-09-30", [[100 + i, "元", "tencent"], [101 + i, "元", "eastmoney"]])),
    gaps: RES.gaps.slice(0, gaps),
  });
  for (const g of [0, 2]) {
    const { ctx, texts, rects } = fakeCtx();
    drawShareCard(ctx, mk(g), "portrait");
    assert.ok(!texts.some((t) => /另有 \d+ 个来源/.test(t.text)), `缺口 ${g} 处:两个值都放得下,不该改紧凑版`);
    assert.equal(texts.filter((t) => /^10\d\.?\d* 元$|^10\d 元$/.test(t.text)).length, 10, `缺口 ${g} 处:五项各两个值`);
    const footLine = rects.find((x) => x.color === "#E2E0DA")!.y;
    const repoAt = texts.findIndex((t) => t.text === REPO_LINE);
    const bottom = Math.max(...texts.slice(repoAt + 1).map((t) => t.y + t.size));
    assert.ok(footLine - bottom <= 160, `缺口 ${g} 处:下面空白 ${footLine - bottom},段落间距没分出去`);
  }
});

test("截断和折行:放不下补「…」;一个字都放不下返回空串;超过行数最后一行截断", () => {
  const { ctx } = fakeCtx();
  ctx.font = "10px x";
  assert.equal(fitText(ctx, "一二三四五", 50), "一二三四五");
  assert.equal(fitText(ctx, "一二三四五", 40), "一二三…");
  assert.equal(fitText(ctx, "一二", 5), "");
  assert.deepEqual(wrapText(ctx, "一二三四五六七", 30, 3), ["一二三", "四五六", "七"]);
  assert.deepEqual(wrapText(ctx, "一二三四五六七", 30, 2), ["一二三", "四五…"]);
});

test("前端调用:GET /view/share_card?run_id=…(编码)", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => { urls.push(String(input)); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try { await backend.shareCard("cc-final-1008"); await backend.shareCard("a b/c"); } finally { globalThis.fetch = prev; }
  assert.deepEqual(urls, ["/api/view/share_card?run_id=cc-final-1008", "/api/view/share_card?run_id=a%20b%2Fc"]);
});

test("个股研究页:报告通过最终校验才有「分享卡」按钮;面板换研究就重取、慢请求丢掉;下载 PNG、复制失败有退路;不用红绿", () => {
  const page = read("pages/Research.tsx");
  assert.match(page, /\{report\.availability === "ready" && <button type="button" onClick=\{\(\) => setSharing\(\(v\) => !v\)\}/);
  assert.match(page, /\{sharing && report\.availability === "ready" && <ShareCardPanel runId=\{report\.run_id\} \/>\}/);
  const panel = read("components/ShareCardPanel.tsx");
  assert.match(panel, /backend\.shareCard\(runId\)/);
  assert.match(panel, /if \(my === seq\.current\) setData\(r\)/);
  assert.match(panel, /\}, \[runId\]\);/);
  assert.match(panel, /toBlob\(/);
  assert.match(panel, /"image\/png"/);
  assert.match(panel, /navigator\.clipboard\.writeText\(shareSummary\(data\)\.join\("\\n"\)\)/);
  assert.match(panel, /手动选中复制/);
  assert.match(panel, /STATEMENT/);
  assert.doesNotMatch(panel, /text-danger|text-success|text-red|text-green|bg-red|bg-green/);
});
