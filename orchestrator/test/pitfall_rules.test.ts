import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * **踩过的坑写成机器检查**。每条都是真出过错、而且不报错只给错数的写法。
 *
 * 扫全仓的正式代码（Python / JS / TS），测试、依赖、构建产物和数据目录不扫。
 * 命中了先读规则里的说明再改写法。豁免只给「统一做这件事、并有测试把每种情况钉死」的那一行，
 * 按原样整行登记：那一行改了豁免就失效，要重新看过再登记。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".venv", "dist", ".local", ".git", "__pycache__", ".pytest_cache", ".mypy_cache", "test", "tests"]);
// 由 datasources/port_astock.py 从上游 a-stock-data 原样生成，问题回上游修
const GENERATED = new Set([".agents/skills/data-access/scripts/sources/astock_ported.py"]);

interface Rule {
  name: string; why: string; exts: string[]; re: RegExp; bad: string[]; good: string[];
  /** 文件 → 允许的整行原文（去掉首尾空白），以及钉死它的测试在哪 */
  allow?: Array<{ file: string; line: string; pinnedBy: string }>;
}

const RULES: Rule[] = [
  {
    name: "判沪深北不能只看首位",
    why: "5x 是沪市 ETF、900x 是沪 B 股、920x 是北交所，只看是不是 6 开头会判错交易所，而且不报错。按号段逐段写全，"
      + "写法见 orchestrator/src/finance/deep_target.ts 的 A_SHARE_BOARDS。",
    exts: [".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"],
    re: /\b(?:startsWith|startswith)\([^)]*["']6["']|(?:\[0\]|\[:1\]|charAt\(0\))\s*(?:===?\s*["']6["']|in\s*["'][^"']*6)|["']6["']\s*===?\s*[\w.]+(?:\[0\]|\[:1\])|\/\^6\/|["']\^6["']/,
    bad: [`s.startsWith("6") ? "SH" : "SZ"`, `"sh" if code.startswith("6") else "sz"`, `code.startswith(('6', '9'))`, `c.startswith(("5", "6", "9"))`,
      `('sh' if c[0]=='6' else 'sz')`, `code[:1] == "6"`, `code[0] in "69"`, `"6" == code[0]`, `/^6/.test(code)`, `code.charAt(0) === "6"`, `re.match(r"^6", c)`],
    good: [`c.startswith("92")`, `code.startswith("688")`, `x.startswith(("60", "68"))`, `[/^6\\d{5}$/, "SH"]`, `v[0] == "600519"`],
    allow: [{
      file: ".agents/skills/data-access/scripts/sources/tencent.py",
      line: `if c in SH_INDEX or c.startswith(("5", "6", "9")):`,
      pinnedBy: ".agents/skills/data-access/scripts/tests/test_registry_sources.py::test_tencent_prefix_routes_every_board_explicitly",
    }],
  },
  {
    name: "判内网地址不能用 is_private 一类属性",
    why: "这些属性的覆盖面随 Python 版本变，而且各版本漏的地方不一样（有的漏 IPv4 映射地址，有的漏 6to4），"
      + "每个版本至少漏一种。一律用显式网段表，写法见 .agents/skills/data-access/scripts/core/cdp.py。",
    exts: [".py"],
    re: /\.is_(?:private|global|link_local|reserved)\b/,
    bad: ["if ipaddress.ip_address(host).is_private:", "addr.is_global", "ip.is_link_local or ip.is_reserved"],
    good: ["return ipaddress.ip_address(host).is_loopback", "# 不用 `is_private` 一类属性"],
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (/\.(?:py|[cm]?[jt]sx?)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test("规则本身认得出坏写法、不误伤好写法", () => {
  // 正则写错了会永远不命中，下面那条扫描就永远是绿的
  for (const rule of RULES) {
    for (const line of rule.bad) assert.ok(rule.re.test(line), `${rule.name}：应命中 ${line}`);
    for (const line of rule.good) assert.ok(!rule.re.test(line), `${rule.name}：不该命中 ${line}`);
  }
});

test("正式代码里没有踩过的坑", () => {
  const files = sourceFiles(ROOT).map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .filter((rel) => !GENERATED.has(rel));
  assert.ok(files.length > 300, `只扫到 ${files.length} 个文件，扫描范围可能漏了目录`);
  assert.ok(files.includes("orchestrator/src/finance/deep_target.ts") && files.includes(".agents/skills/data-access/scripts/core/cdp.py"));
  for (const rule of RULES) {
    const hits: string[] = [];
    const allowSeen = new Set<string>();
    for (const rel of files) {
      if (!rule.exts.includes(path.extname(rel))) continue;
      fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
        if (!rule.re.test(line)) return;
        const ok = rule.allow?.find((a) => a.file === rel && a.line === line.trim());
        if (ok) allowSeen.add(`${ok.file}|${ok.line}`);
        else hits.push(`${rel}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, [], `${rule.name}。${rule.why}`);
    for (const a of rule.allow ?? []) {
      // 那一行改了或删了，豁免就作废：要么重新登记，要么从这里删掉，不留空头豁免
      assert.ok(allowSeen.has(`${a.file}|${a.line}`), `豁免已失效：${a.file} 里找不到「${a.line}」，按现状重新看过`);
      const [testFile, testName] = a.pinnedBy.split("::");
      assert.match(fs.readFileSync(path.join(ROOT, testFile!), "utf8"), new RegExp(`def ${testName}\\b`), `豁免要有钉死它的测试：${a.pinnedBy}`);
    }
  }
});
