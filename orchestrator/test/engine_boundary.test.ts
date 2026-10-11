import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { directCapabilities, localAgentCapabilities } from "../src/engine.ts";

/**
 * **大脑边界棘轮**(v2)。
 *
 * 编排器只认 AgentRunner:跑一个 turn、拿回结果。用哪个大脑、怎么拉起、怎么鉴权,
 * 一律留在 engines/ 与组装根 run.ts 里。
 *
 * v1 的教训:编排器直接调旧引擎的专属 API,条件写的还是"有没有 agent"而不是"用哪个引擎",
 * 换引擎时悄悄带着一堆用不到的假设,直到某台机器上缺了那个二进制才炸。
 * 🔴 这类回退**不会有任何报错**,只能用棘轮钉住。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");

/** 去掉行注释与块注释,避免把"解释为什么不在这里调"的注释本身判成违规 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 拉起 / 探测 / 直连某个具体大脑的入口:只该出现在 engines/、组装根与服务层 */
const BRAIN_ONLY_APIS = ["runLocalAgent", "chatCompletion", "probeClaude", "probeCodex", "probeCodeBuddy", "localSubscriptionEnv"];
const BRAIN_CTORS = /new\s+(DirectStageAgent|LocalAgentStageAgent)\s*\(/;

test("编排器不得直接拉起、探测或直连某个大脑(只认 AgentRunner)", () => {
  const code = stripComments(read("orchestrate.ts"));
  const hits = BRAIN_ONLY_APIS.filter((api) => new RegExp(`\\b${api}\\s*\\(`).test(code));
  assert.deepEqual(hits, [], `orchestrate.ts 又直接调了大脑专属入口:${hits.join(", ")}。这些属于 engines/ 或组装根 run.ts。`);
  assert.doesNotMatch(code, BRAIN_CTORS, "orchestrate.ts 自己构造了大脑;大脑该由组装根注入");
});

test("turn 上下文的写入必须留在编排器(所有大脑都要,受控工具靠它判当前阶段)", () => {
  const code = stripComments(read("orchestrate.ts"));
  // 反向断言:这一条是"必须在"。一旦被顺手搬进某个大脑的实现,
  // 别的大脑的受控工具就会全部拿不到当前阶段而抛 turn_context_missing。
  assert.match(code, /\bwriteTurnContext\s*\(/,
    "orchestrate.ts 不再写 turn 上下文了 —— 受控工具(list/read/calculate/write_stage)将无法判断当前阶段。");
});

test("编排器必须把大脑能力写进 manifest(漏写不会有任何人发现)", () => {
  const code = stripComments(read("orchestrate.ts"));
  // manifest schema 里 capabilities 是**可选**的(干跑没有大脑),所以漏写过不了任何校验、也不报错,
  // 只是界面从此讲不出执行保障等级的差别 —— 只能在这里钉住。
  assert.match(code, /engine:\s*\{[^}]*capabilities/,
    "编排器没有把 capabilities 写进 manifest.engine。schema 里它是可选的,漏写不会报错,但界面将无法区分不同大脑的执行保障。");
});

test("大脑实现只许放在 engines/ 下;Core 里只有组装根 run.ts 能构造它们", () => {
  for (const f of ["direct_stage_agent.ts", "local_agent_stage_agent.ts"]) {
    assert.ok(fs.existsSync(path.join(SRC, "engines", f)), `engines/${f} 不见了 —— 下面的断言会空转`);
  }
  const offenders = fs.readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && f !== "run.ts")
    .filter((f) => BRAIN_CTORS.test(stripComments(read(f))));
  assert.deepEqual(offenders, [], `这些 Core 文件自己构造了大脑:${offenders.join(", ")}。大脑该由组装根注入。`);
});

test("能力声明如实:产品强制的边界对所有大脑一致,差别只在线路与结构化输出", () => {
  const direct = directCapabilities("server_schema");
  const local = localAgentCapabilities();
  // 受控工具、收工检查、方法论注入都由产品执行 ⇒ 这些字段换了大脑也不能变
  for (const k of ["sandbox", "hooks", "contextStrategy", "auditLevel", "methodology"] as const) {
    assert.equal(direct[k], local[k], `${k}:产品强制的边界不能因大脑而异`);
  }
  assert.equal(direct.sandbox, "model_has_no_host_access", "大脑只有受控工具,没有宿主命令");
  assert.equal(direct.hooks, false, "v2 没有引擎级钩子,收工检查在产品进程里");
  assert.equal(direct.auditLevel, "host_events", "拿不到大脑内部视角,不许报成 engine_events");
  assert.equal(direct.methodology, "constitution_and_skills", "宪法与阶段 skills 由产品写进每个阶段的提示词");
  // 真实的差别必须如实体现,不能一律写成同一份
  assert.notEqual(direct.kind, local.kind);
  assert.notEqual(direct.protocol, local.protocol);
  assert.equal(directCapabilities("prompt").structuredOutput, "prompt", "服务端不支持 schema 时如实降级");
  assert.equal(local.structuredOutput, "prompt", "本机 CLI 的输出约束按提示词口径声明,不往高了报");
});

test("产品不再依赖旧引擎 SDK:依赖表里没有,禁止加载它时各入口照样能起来", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(deps.filter((d) => d.startsWith("@openai/codex")), [], "依赖表里又出现了旧引擎 SDK");
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "vra-no-codex-"));
  try {
    const loader = path.join(tmp, "deny-codex.mjs");
    fs.writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@openai/codex")) throw new Error("CODEX_IMPORT_FORBIDDEN:" + specifier + ":from:" + context.parentURL);
  return nextResolve(specifier, context);
}
`);
    for (const entry of ["run.ts", "api.ts", "mcp.ts"]) {
      const url = pathToFileURL(path.join(SRC, entry)).href;
      const child = spawnSync(process.execPath, [
        "--experimental-loader", loader, "--input-type=module", "-e", `await import(${JSON.stringify(url)});`,
      ], { cwd: tmp, encoding: "utf8", timeout: 30_000 });
      assert.equal(child.status, 0, `${entry} 加载失败。stdout=${child.stdout}\nstderr=${child.stderr}`);
      assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /CODEX_IMPORT_FORBIDDEN/, `${entry} 仍在加载旧引擎 SDK`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
