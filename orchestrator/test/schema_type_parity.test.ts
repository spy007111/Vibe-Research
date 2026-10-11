import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";   // manifestSchema() 要读插件契约(市场枚举等)
import { calcRecordSchema, evidenceItemSchema, fetchEnvelopeSchema, gapSchema, manifestSchema } from "../src/schemas.ts";
import { LEGACY_PROFILE_KEYS, providerProfileSchema } from "../src/providers.ts";

/**
 * **TS 接口 ↔ JSON Schema 键集一致性棘轮**。
 *
 * 这个代码库里有六对「TS 接口 + 对应的 ajv Schema」描述同一份磁盘数据。
 * TS 类型只在**编译期**存在,运行时真正的门是 Schema ⇒ 两份真理源。
 *
 * 🔴 两种漂移方向,都不会有任何提示:
 *  - **接口加了字段、Schema 没加** → `additionalProperties: false` 会在运行时拒掉那份数据。
 *    表现极具迷惑性:所有阶段都跑完了,**收尾校验时整轮判 failed**。
 *    (双引擎第 1-2 步在 manifest 上踩过一次,第 4 步在 provider profile 上又踩一次 ——
 *     同一类坑两次,所以才有这条棘轮。)
 *  - **Schema 加了字段、接口没加** → 写代码时拿不到类型提示,数据里那个字段等于隐身。
 *
 * ⚠️ 只比**顶层**键集。嵌套对象(如 manifest.engine.capabilities)不在此列 ——
 *    那需要真正的类型解析,而这里刻意用轻量文本解析,以免棘轮本身变成需要维护的负担。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

/** 去掉注释与字符串字面量:注释里的花括号、正则里的 `{` 都会把深度算歪 */
function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** 取出 `export interface Name { ... }` 的花括号内容(按配对计数,不用正则贪婪匹配) */
function interfaceBody(src: string, name: string): string {
  const m = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).exec(src);
  if (!m) throw new Error(`源码里找不到 export interface ${name}`);
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  throw new Error(`interface ${name} 的花括号没有闭合`);
}

/** 扫出接口体里**顶层**的字段名(嵌套对象/函数/数组里的都跳过) */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let token = "";
  let expectingField = true;
  for (const c of body) {
    if (c === "{" || c === "(" || c === "[") { depth++; token = ""; continue; }
    if (c === "}" || c === ")" || c === "]") { depth--; token = ""; continue; }
    if (depth !== 0) continue;
    if (c === ";" || c === "\n" || c === ",") { token = ""; expectingField = true; continue; }
    if (c === ":") {
      const m = /([A-Za-z_$][\w$]*)\s*\??\s*$/.exec(token);
      if (expectingField && m) keys.push(m[1]);
      expectingField = false;
      token = "";
      continue;
    }
    token += c;
  }
  return keys;
}

function keysOfInterface(file: string, name: string): string[] {
  const src = stripNoise(fs.readFileSync(path.join(SRC, file), "utf8"));
  return topLevelKeys(interfaceBody(src, name)).filter((k) => k !== "readonly");
}

/** `schemaOnly`:刻意只放在 Schema 里的键(运行时放行、代码不读),不算漂移 */
const PAIRS: { iface: string; file: string; schema: Record<string, unknown>; label: string; schemaOnly?: readonly string[] }[] = [
  { iface: "FetchEnvelope", file: "merge.ts", schema: fetchEnvelopeSchema(), label: "取数信封" },
  { iface: "EvidenceItem", file: "merge.ts", schema: evidenceItemSchema(), label: "证据条目" },
  { iface: "CalcRecord", file: "merge.ts", schema: calcRecordSchema as unknown as Record<string, unknown>, label: "计算记录" },
  { iface: "Gap", file: "validator.ts", schema: gapSchema as unknown as Record<string, unknown>, label: "缺口" },
  { iface: "Manifest", file: "merge.ts", schema: manifestSchema(), label: "运行清单" },
  // v1 旧引擎字段:Schema 放行(用户的旧覆盖模板照样能加载),但刻意不进 TS 类型 —— 代码不该再读它们
  { iface: "ProviderProfileFile", file: "providers.ts", schema: providerProfileSchema as unknown as Record<string, unknown>, label: "provider 模板",
    schemaOnly: LEGACY_PROFILE_KEYS },
];

test("🔴 解析器自检:每个接口都要真的解析出字段(返回空数组会让下面的比对全部假绿)", () => {
  // 这一条钉的是**棘轮自己**。如果 interfaceBody / topLevelKeys 哪天坏了返回空,
  // 下面的 deepEqual([], []) 会全部通过 —— 一个什么都没查的绿灯。本项目在别处栽过这个。
  const known: Record<string, string> = {
    FetchEnvelope: "script", EvidenceItem: "id", CalcRecord: "calculation_id",
    Gap: "operation", Manifest: "run_id", ProviderProfileFile: "env_key",
  };
  for (const { iface, file } of PAIRS) {
    const keys = keysOfInterface(file, iface);
    assert.ok(keys.length >= 3, `${iface} 只解析出 ${keys.length} 个字段 —— 解析器多半坏了`);
    assert.ok(keys.includes(known[iface]), `${iface} 解析结果里没有已知字段 ${known[iface]}:${keys.join(", ")}`);
  }
});

for (const { iface, file, schema, label, schemaOnly = [] } of PAIRS) {
  test(`${label}:TS 接口 ${iface} 与 JSON Schema 的顶层键集必须一致`, () => {
    const tsKeys = new Set(keysOfInterface(file, iface));
    const schemaKeys = new Set(Object.keys((schema.properties ?? {}) as Record<string, unknown>));
    for (const k of schemaOnly) {
      assert.ok(schemaKeys.has(k), `${iface} 的豁免键 ${k} 已不在 Schema 里 —— 删掉这条豁免,别让它悄悄失效`);
      assert.ok(!tsKeys.has(k), `${iface} 的旧字段 ${k} 进了 TS 类型 —— 代码不该再读它`);
      schemaKeys.delete(k);
    }
    const onlyInTs = [...tsKeys].filter((k) => !schemaKeys.has(k)).sort();
    const onlyInSchema = [...schemaKeys].filter((k) => !tsKeys.has(k)).sort();
    assert.deepEqual({ onlyInTs, onlyInSchema }, { onlyInTs: [], onlyInSchema: [] },
      `${iface} 与它的 Schema 漂移了。\n` +
      `  只在 TS 里有:${onlyInTs.join(", ") || "(无)"}  ← 运行时会被 additionalProperties:false 拒掉,` +
      "表现是「所有阶段都跑完、收尾却整轮 failed」\n" +
      `  只在 Schema 里有:${onlyInSchema.join(", ") || "(无)"}  ← 写代码时没有类型提示,这个字段等于隐身`);
  });
}
