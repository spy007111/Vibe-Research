import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { amountAtNow, holdingsSig, holdingValues, valuesDrifted } from "../src/verticals/finance/lib/holdingsDrift.ts";

const h = (code: string, shares: number, mv: number | null, name = code) => ({ code, name, shares, market_value: mv });

test("体检 / 回放的输入签名：代码、股数、名称、现价有无；市值本身不进签名", () => {
  const a = [h("600519", 100, 1000, "贵州茅台"), h("300750", 100, 1000)];
  assert.equal(holdingsSig(a), holdingsSig([...a].reverse()), "顺序无关");
  assert.equal(holdingsSig(a), holdingsSig([h("600519", 100, 2000, "贵州茅台"), h("300750", 100, 1000)]), "市值变了不改签名（改由漂移判断）");
  assert.notEqual(holdingsSig(a), holdingsSig([h("600519", 200, 1000, "贵州茅台"), h("300750", 100, 1000)]), "股数");
  assert.notEqual(holdingsSig(a), holdingsSig([h("600519", 100, null, "贵州茅台"), h("300750", 100, 1000)]), "现价有无");
  assert.notEqual(holdingsSig(a), holdingsSig([h("600519", 100, 1000, "茅台"), h("300750", 100, 1000)]), "名称（会传给工具、出现在结果里）");
});

test("市值漂移：股数相同、市值从 1000/1000 变成 2000/1000 算变了；2% 以内不算", () => {
  const prev = holdingValues([h("A", 100, 1000), h("B", 100, 1000)]);
  assert.equal(valuesDrifted(prev, [h("A", 100, 2000), h("B", 100, 1000)]), true, "审计 C2 的例子");
  assert.equal(valuesDrifted(prev, [h("A", 100, 1015), h("B", 100, 990)]), false, "行情小幅跳动不重算");
  assert.equal(valuesDrifted(prev, [h("A", 100, 1021), h("B", 100, 1000)]), true);
  assert.equal(valuesDrifted(prev, [h("A", 100, 1000), h("B", 100, null)]), true, "现价没了");
  assert.equal(valuesDrifted(holdingValues([h("A", 1, null)]), [h("A", 1, null)]), false, "一直没有现价不算变");
  assert.equal(valuesDrifted(prev, [h("A", 100, 1000)]), true, "少了一只");
  assert.equal(valuesDrifted(prev, [h("A", 100, 1000), h("C", 100, 1000)]), true, "换了一只");
  assert.equal(valuesDrifted(holdingValues([h("A", 1, 0)]), [h("A", 1, 0)]), false);
  assert.equal(valuesDrifted(holdingValues([h("A", 1, 0)]), [h("A", 1, 5)]), true);
});

test("🔴 回放金额按现在的市值现算：2% 以内不重算，但金额不沿用回放那一刻的总额（审计第二轮 C2）", () => {
  const now = holdingValues([h("A", 100, 101_500), h("B", 100, 101_500)]);
  assert.equal(amountAtNow(-0.3, ["A", "B"], now), -60_900, "Codex 的例子：两只都从 100,000 涨到 101,500");
  assert.equal(amountAtNow(-0.3, ["a "], holdingValues([h("A", 1, 1000)])), -300, "代码大小写 / 空格不同也对得上");
  assert.equal(amountAtNow(-0.3, ["A", "C"], now), null, "有一只现在对不上：不现算，改用回放时的金额");
  assert.equal(amountAtNow(-0.3, ["A"], holdingValues([h("A", 1, null)])), null, "现在没有市值");
  assert.equal(amountAtNow(null, ["A"], now), null);
  assert.equal(amountAtNow(-0.3, [], now), null);
  const src = readFileSync(new URL("../src/verticals/finance/components/ScenarioReplay.tsx", import.meta.url), "utf8");
  assert.match(src, /按现在的市值约 \$\{hideIf\(hide, moneySigned\(live\)\)\}/, "「按现在的市值约」显示的是现算的金额");
  assert.match(src, /按回放时的市值约/, "现算不了时写明是回放那一刻的");
});

test("体检、收益率：先作废还在跑的请求，再走命中缓存 / 持仓清空的提前返回（审计 C7）", () => {
  for (const f of ["PortfolioXray.tsx", "PortfolioPerf.tsx", "ScenarioReplay.tsx"]) {
    const src = readFileSync(new URL(`../src/verticals/finance/components/${f}`, import.meta.url), "utf8");
    const body = src.slice(src.indexOf("const run = useCallback("));
    const abort = body.indexOf("ctl.current?.abort();");
    const firstReturn = body.indexOf("return; }");
    assert.ok(abort > 0 && firstReturn > 0 && abort < firstReturn, `${f}：abort 要在第一个提前返回之前`);
    for (const m of body.slice(0, body.indexOf("const c = new AbortController()")).matchAll(/\{([^{}]*)return; \}/g)) {
      assert.match(m[1]!, /setLoading\(false\)/, `${f}：提前返回也要结束 loading：${m[0]}`);
    }
  }
});
