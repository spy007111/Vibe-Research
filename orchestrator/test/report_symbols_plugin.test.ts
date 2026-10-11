import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FINANCE_PLUGIN } from "../src/finance/register.ts";
import { registerPlugin, resetPlugin } from "../src/plugin.ts";
import { addReport, reportRecallPlan } from "../src/report_library.ts";

/**
 * 资料库的证券代码识别规则属于金融插件(Codex 审计第三轮 A6)。
 * 核心只调插件给的三个函数:去掉插件的规则,核心就不再认任何代码;核心源码里也不留市场写法。
 */
const SRC = (f: string) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test("核心资料库源码里没有市场代码写法(港股 / NASDAQ / .HK / SH|SZ)", () => {
  const core = SRC("report_library.ts");
  for (const re of [/港股/, /NASDAQ/i, /\\\.HK/, /SH\|SZ/]) assert.equal(re.test(core), false, String(re));
  assert.match(SRC("finance/plugin.ts"), /symbols: \{ extract: reportSymbols, aliases: reportSymbolAliases, bareCodes: reportBareCodes \}/);
});

test("插件不给代码规则时,入库不识别代码、提问不按代码召回;注册回金融插件后照常", async () => {
  const { symbols: _drop, ...rules } = FINANCE_PLUGIN.reportRecall!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-rsym-"));
  try {
    resetPlugin(); registerPlugin({ ...FINANCE_PLUGIN, reportRecall: rules });
    const bare = await addReport(root, { name: "腾讯控股-HK:700.txt", content: b64("港股 HK:700 业务复盘") });
    assert.deepEqual(bare.symbols, []);
    assert.notEqual(reportRecallPlan(root, "HK:700 最近怎么样", rules)?.reason, "symbol");
  } finally { resetPlugin(); registerPlugin(FINANCE_PLUGIN); }
  try {
    const hk = await addReport(root, { name: "腾讯点评-HK:700.txt", content: b64("港股 HK:700 游戏收入回暖") });
    assert.deepEqual(hk.symbols, ["00700"]);
    assert.equal(reportRecallPlan(root, "HK:700 最近怎么样", FINANCE_PLUGIN.reportRecall)?.reason, "symbol");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
