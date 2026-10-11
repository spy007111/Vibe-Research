import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

test("页面放进 AI 输入框的文字：只填当前这一页放的；输入框按行数撑高，最多 8 行", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  try {
    const { draftFor } = await server.ssrLoadModule("/src/core/ai/pageContext.tsx");
    const d = { text: "第 1 步", seq: 3, key: "sector:pcb" };
    assert.equal(draftFor(d, "sector:pcb"), "第 1 步");
    assert.equal(draftFor(d, "sector:hbm"), null, "换了页才收到的丢掉，不填进另一页的对话");
    assert.equal(draftFor(d, ""), null, "当前没有可聊的页面");
    assert.equal(draftFor({ ...d, key: "" }, ""), null);
    assert.equal(draftFor(null, "sector:pcb"), null);

    const { AiComposer } = await server.ssrLoadModule("/src/core/ai/AiMessages.tsx");
    const rows = (value?: string) => /rows="(\d+)"/.exec(renderToStaticMarkup(createElement(AiComposer, {
      placeholder: "问", disabled: false, onSend: () => {}, value, onValueChange: () => {},
    })))?.[1];
    assert.equal(rows(undefined), "1");
    assert.equal(rows(""), "1");
    assert.equal(rows("一行"), "1");
    assert.equal(rows("第一行\n第二行\n第三行"), "3");
    assert.equal(rows(Array.from({ length: 20 }, (_, i) => `第 ${i} 行`).join("\n")), "8");
  } finally { await server.close(); }
});

test("AI 入口收件：先收走再判断；填进输入框、打开面板，但不替用户发送；输入框里的字按页记", () => {
  const dock = read("core/ai/AiDock.tsx");
  const eff = dock.slice(dock.indexOf("const [draft, takeDraft] = useAiDraftInbox();"), dock.indexOf("}, [draft, pageKey, takeDraft]);"));
  assert.ok(eff.length > 0, "找不到收件的那段");
  assert.ok(eff.indexOf("takeDraft(draft.seq)") >= 0 && eff.indexOf("takeDraft(draft.seq)") < eff.indexOf("draftFor(draft, pageKey)"),
    "丢掉的也要先收走，不然留在那里，换到别的页面又被拿出来判断");
  assert.match(eff, /setOpen\(true\)/);
  assert.doesNotMatch(eff, /submit|send\(/, "不替用户发送：发出去会用掉用户 AI 的额度");
  assert.match(dock, /const text = input\.key === pageKey \? input\.text : "";/, "换页不显示上一页没发出去的字");
  assert.match(dock, /value=\{text\}\s*onValueChange=\{setText\}/);
  const ctx = read("core/ai/pageContext.tsx");
  assert.match(ctx, /setDraft\(\{ text, seq: seq\.current, key: pageKey \}\)/, "放的时候记下是哪一页放的");
  assert.match(ctx, /setDraft\(\(d\) => \(d\?\.seq === n \? null : d\)\)/, "只收走自己拿到的那一份，紧接着又放进来的不被误清");
  assert.match(ctx, /return useContext\(DraftCtx\)\?\.put \?\? null;/, "没挂 Provider 时给 null，让页面把按钮藏起来");
});
