import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = path.join(REPO, "desktop", "src", "verticals", "finance", "lib");

/**
 * 「用户在界面上选的模型，到底有没有接到请求上」这一条的棘轮。
 *
 * 🔴 起因是一次实测：`backend.chat` 的 `llm` 参数原本要调用方自己传，
 *    三个入口里有两个（Agent 面板 `FinanceAiDock`、`agents.ts`）忘了传 ——
 *    对话照常成功、照常有答案，只是出自后端默认那家，**界面上一个字都看不出来**。
 *    这类失效没有任何人会报错，所以只能用棘轮钉住。
 */

const read = (f: string): string => fs.readFileSync(path.join(LIB, f), "utf8");

test("🔴 前提：这几个文件确实在 —— 改名 / 搬走时不许静默变成空查", () => {
  for (const f of ["backend.ts", "llm.ts", "llmStore.ts", "ai-models.ts"]) {
    assert.ok(fs.existsSync(path.join(LIB, f)), `${f} 不在了，下面几条就查不到东西`);
  }
});

test("🔴 传输层自己带上用户配置 —— 不靠每个调用方记得传", () => {
  const src = read("backend.ts");
  assert.ok(/import \{[^}]*readAiRuntime[^}]*\} from "\.\/llmStore(?:\.ts)?"/.test(src), "backend.ts 必须自己去读全局 AI 运行配置");
  // 读配置集中在 requestRuntime，chat 与标题翻译两条传输入口都必须调用它。
  // 只看整份文件会假绿：helper 留着、真正的请求入口绕开它照样能过。
  const helper = /function requestRuntime\([^)]*\)[^{]*\{([\s\S]*?)\n\}\n\nasync function call/.exec(src);
  assert.ok(helper, "没解析到 requestRuntime 的实现，断言等于没做");
  const helperBody = helper[1]!;
  assert.ok(/readAiRuntime\(\)/.test(helperBody), "传输层必须读取全局 AI 来源");
  assert.ok(/"broken"/.test(helperBody) && /"unavailable"/.test(helperBody), "必须把「坏了」「读不到」与「没配」分开处理");
  assert.ok(/throw new ApiError/.test(helperBody), "坏了 / 读不到要报出来，不能静默回落");
  assert.ok(/"none"/.test(helperBody) && /"ai_not_configured"/.test(helperBody), "真没配也必须引导接入 AI，不能借后端默认值替用户选择");

  const seg = /chat:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{([\s\S]*?)\n  \},/.exec(src);
  assert.ok(seg, "没解析到 backend.chat 的实现，断言等于没做");
  const body = seg[1]!;
  assert.ok(/requestRuntime\(llm\)/.test(body), "chat 必须走统一的用户配置读取入口");
  const translate = /translateHeadlines:\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{([\s\S]*?)\n  \},/.exec(src);
  assert.ok(translate && /requestRuntime\(llm\)/.test(translate[1]!), "标题翻译也必须走同一入口，不能静默换模型");
  // 🔴 helper 内按 `!== undefined` 判调用方覆盖，不按真值判：真值判会把显式 null 悄悄丢掉，
  //    后端的形状校验就压根不会执行。
  assert.ok(/llm !== undefined/.test(helperBody), "调用方覆盖必须按 !== undefined 判");
  assert.ok(!/if \(llm\)/.test(helperBody), "不许用真值判 —— 显式 null 会被静默丢掉");
  assert.ok(/executionMode: runtime\.executionMode, llm: runtime\.llm/.test(body), "chat 必须同时发送全局执行方式与 AI 来源");
});

test("🔴 「已实测」不许拿「目录里有这个文件」当判据", () => {
  const s = read("../pages/Settings.tsx");
  // v2.0(2026-10-07)起内置模板都还没实测过 Chat Completions；实测状态由后端按模板里的 direct.supported
  // 下发(providers.ts 的 apiVerificationOf，口径由 providers.test.ts 钉住)。按文件存在来标，界面上会出现一排假的「已实测」。
  // ⚠️ 断言要钉**下拉项那一行本身**：只查"文件里有没有 tag"是假绿 ——
  //    别处留着它、而标签改回按有无模板算，照样全绿（变异测试实测过）。
  const opt = /<option key=\{m\.id\}[\s\S]*?<\/option>/.exec(s);
  assert.ok(opt, "没解析到模型下拉项，断言等于没做");
  assert.ok(/\{tag\(m\.provider\)\}/.test(opt[0]), `下拉项的标签必须来自实测状态：${opt[0]}`);
  assert.ok(!/已实测/.test(opt[0]), "标签文案该由 tag() 决定，别在这一行写死");

  // tag() 自己的口径：只有后端明确下发 verified 才叫已实测，其余如实说出来
  const fn = /const tag = [\s\S]*?\n  \};/.exec(s);
  assert.ok(fn, "没解析到 tag()，断言等于没做");
  const body = fn[0];
  assert.ok(/const st = verificationOf\(pv\)/.test(body), "tag() 的状态必须取自 verificationOf");
  assert.ok(/未实测/.test(body), "没实测过的要如实标出来");
  const claims = body.split("\n").filter((line) => /已实测/.test(line));
  assert.equal(claims.length, 1, `「已实测」只能出现在一个分支里：${claims.join(" | ")}`);
  assert.match(claims[0]!, /st === "verified"/, "已实测只能由后端下发的 verified 状态触发");
  // 状态来自后端下发的 provider_templates，不是前端自己数文件或按有无地址推断
  const source = /const verificationOf = [^\n]*/.exec(s);
  // 整个函数体就是"取后端下发的值"：只查子串会放过 `有地址 ? "verified" : 后端值` 这类前置推断(变异实测过)
  assert.ok(source && /=>\s*info\?\.provider_templates\?\.\[pv\]\s*\?\?\s*"";\s*$/.test(source[0]), `实测状态必须原样取自后端下发的 provider_templates：${source?.[0]}`);
});

test("🔴 存取只有一处实现 —— 抄第二份迟早两边判定不一致", () => {
  assert.ok(/localStorage\.getItem\(LLM_KEY\)/.test(read("llmStore.ts")), "llmStore 才是读的地方");
  for (const f of ["llm.ts", "backend.ts"]) {
    assert.ok(
      !/localStorage\.(getItem|setItem)\(\s*["'`]vr-llm/.test(read(f)),
      `${f} 里不许直接碰 vr-llm，一律走 llmStore`,
    );
  }
});

test("🔴 订阅档不许摆一个假模型名 —— 模型由登录态决定", () => {
  const cli = read("ai-models.ts").split("\n").filter((l) => /provider:\s*"cli-/.test(l));
  assert.ok(cli.length >= 2, `没找到订阅档条目（找到 ${cli.length} 行）`);
  for (const line of cli) {
    const id = /id:\s*"([^"]+)"/.exec(line)?.[1] ?? "";
    // 实测撞过：写 "gpt-5.6-codex" 发出去，收到的是
    // "The 'gpt-5.6-codex' model is not supported when using Codex with a ChatGPT account"
    assert.ok(!/^gpt-|^claude-\d|^o\d/.test(id), `订阅档 id "${id}" 长得像模型名，会让人以为它是真模型`);
  }
});

test("🔴 前端「这份配置能不能用」的口径必须与后端一致 —— 各判一半就会分岔", async () => {
  const { resolveRuntimeProvider } = await import("../src/runtime_provider.ts");
  const REPO_ROOT = path.resolve(LIB, "..", "..", "..", "..", "..");
  const DATA = path.join(REPO_ROOT, ".local");

  // 把 llmStore 的判定抄成一份可执行的镜像 —— 抄错了下面的对照会当场炸
  const src = read("llmStore.ts");
  const fn = /function isUsable\(c: LlmConfig\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(fn, "没解析到 isUsable()，断言等于没做");
  const isUsable = new Function("c", `const isCli=(p)=>p.startsWith("cli-");${fn[1]!.replace(/Boolean\(/g, "Boolean(")}`) as (c: unknown) => boolean;

  const cases = [
    { provider: "cli-codex", baseURL: "", apiKey: "", model: "" },            // 订阅档免 key、模型由登录态定
    { provider: "cli-codex", baseURL: "", apiKey: "", model: "codex" },
    { provider: "deepseek", baseURL: "", apiKey: "k", model: "m" },           // 模板给 baseURL
    { provider: "deepseek", baseURL: "", apiKey: "k", model: "" },            // 显式空模型：后端不替你换成模板默认(R3-1)
    { provider: "deepseek", baseURL: "", apiKey: "k", model: "   " },         // 全空格同上
    { provider: "deepseek", baseURL: "", apiKey: "", model: "m" },            // 缺 key
    { provider: "custom", baseURL: "https://g.example.com/v1", apiKey: "k", model: "" },
    { provider: "custom", baseURL: "https://g.example.com/v1", apiKey: "k", model: "  " },
    { provider: "custom", baseURL: "", apiKey: "k", model: "m" },             // 自填端点缺 baseURL
    { provider: "", baseURL: "https://g.example.com/v1", apiKey: "k", model: "m" },
  ];
  for (const c of cases) {
    const front = isUsable(c);
    let back = true;
    try { resolveRuntimeProvider(REPO_ROOT, DATA, c, {}); } catch { back = false; }
    // 前端严 ⇒ 能用的配置被判「坏了」；前端松 ⇒ 界面说"已配置"、一提问才报错。两种都是分岔。
    assert.equal(front, back, `口径不一致:${JSON.stringify(c)} 前端=${front} 后端=${back}`);
  }
});

test("🔴 Base URL 不得携带查询凭据或 fragment", async () => {
  const { resolveRuntimeProvider, RuntimeProviderError } = await import("../src/runtime_provider.ts");
  const REPO_ROOT = path.resolve(LIB, "..", "..", "..", "..", "..");
  const DATA = path.join(REPO_ROOT, ".local");
  for (const baseURL of ["https://gateway.example/v1?api_key=secret", "https://gateway.example/v1#secret"]) {
    assert.throws(
      () => resolveRuntimeProvider(REPO_ROOT, DATA, { provider: "custom", baseURL, apiKey: "separate-key", model: "m" }, {}),
      (error: unknown) => error instanceof RuntimeProviderError && error.code === "bad_base_url" && !error.message.includes("secret"),
    );
  }
});

test("🔴 未显式传 llm 时，路由指纹绑定真实后台默认来源而不是固定占位符", async () => {
  const { runtimeSourceFingerprint } = await import("../src/runtime_provider.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-default-fingerprint-"));
  try {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      provider: { profile: "deepseek", auth: "api_key" },
      defaults: { model: "deepseek-chat" },
    }));
    const a = runtimeSourceFingerprint(REPO, root, undefined, { DEEPSEEK_API_KEY: "route-key-a" });
    const b = runtimeSourceFingerprint(REPO, root, undefined, { DEEPSEEK_API_KEY: "route-key-b" });
    assert.notEqual(a, b, "后台默认 key 变化后，旧路由指纹必须失效");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("🔴 成本和 ≤ 0 时的盈亏比例给 null，不给 0 —— 0 是个具体的数，读作「不赚不亏」", () => {
  const api = fs.readFileSync(path.join(LIB, "api.ts"), "utf8");
  const m = /pnl_pct:\s*costSum > 0[^\n]*/.exec(api);
  assert.ok(m, "没解析到合计盈亏比例那一行，断言等于没做");
  // 成本可以为负（分红送转吃够了）。负数当分母还会**把赚的显示成亏的**：
  // 成本 −1.5、现价 10 ⇒ (10−(−1.5))/(−1.5) = −766%，明明大赚。
  assert.ok(/:\s*null,?\s*$/.test(m[0]), `算不出时必须给 null：${m[0]}`);

  const page = fs.readFileSync(path.join(LIB, "..", "pages", "Portfolio.tsx"), "utf8");
  assert.ok(/total\.pnl_pct == null \? "—"/.test(page), "每个币种的汇总都要把算不出如实渲染成「—」");
});
