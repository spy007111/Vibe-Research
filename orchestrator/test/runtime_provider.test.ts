import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_KEY_VAR, RuntimeProviderError, defaultLlm, isCliProvider, parseRequestLlmMeta, remotePageBaseUrlError, requestLlmMeta,
  resolveRuntimeProvider, resolveSelectedRuntime, runtimeSourceFingerprint, templateIds, templateMatrix,
} from "../src/runtime_provider.ts";

import "../src/finance/register.ts";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_ENV: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

const code = (fn: () => unknown): string => {
  try { fn(); return "(没抛)"; } catch (e) { return e instanceof RuntimeProviderError ? e.code : `(不是 RuntimeProviderError:${e})`; }
};

/**
 * 语义测试用自造模板(放在临时数据根的 providers/ 下),不跟某家厂商当下的地址 / 模型名绑死;
 * 产品自带模板能不能加载,单独在最后一条里验。
 */
function dataRoot(templates: Record<string, unknown> = {}, config?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vra-rp-"));
  fs.mkdirSync(path.join(root, "providers"));
  for (const [id, body] of Object.entries(templates)) fs.writeFileSync(path.join(root, "providers", `${id}.json`), JSON.stringify(body));
  if (config !== undefined) fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
  return root;
}
const tpl = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Fixture ${id}`, base_url: "https://api.fixture.invalid/v1", env_key: "FIXTURE_API_KEY", default_model: "fixture-default", ...extra,
});

test("本机订阅:三种 CLI 各映射到自己的本机 Agent,env 原样传、不塞任何东西;未知 cli-* 报错不回落", () => {
  const DATA = dataRoot();
  for (const [provider, agent] of [["cli-claude", "claude"], ["cli-codex", "codex"], ["cli-codebuddy", "codebuddy"]] as const) {
    const r = resolveRuntimeProvider(REPO, DATA, { provider, model: "ignored-model", apiKey: "ignored-key" }, BASE_ENV);
    assert.deepEqual(r, { runtime: "local-agent", agent, env: BASE_ENV }, `${provider}:模型与 key 都不该被带进本机 Agent`);
    assert.equal(r.env, BASE_ENV, "订阅档不该复制或改写 env");
  }
  for (const p of ["cli-qwen", "cli-deepseek", "cli-anything"]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: p }, BASE_ENV)), "unsupported_cli", p);
  }
  assert.ok(isCliProvider("cli-x") && !isCliProvider("deepseek"));
});

test("模板:按模板自己的 env_key 注入 key,默认模型来自模板;没实测过就如实标未实测", () => {
  const DATA = dataRoot({ "fixture-api": tpl("fixture-api") });
  const r = resolveRuntimeProvider(REPO, DATA, { provider: "fixture-api", apiKey: "sk-secret-abc" }, BASE_ENV);
  if (r.runtime !== "api") assert.fail("模板应解析成模型 API");
  assert.equal(r.api.name, "fixture-api");
  assert.equal(r.api.label, "Fixture fixture-api");
  assert.equal(r.api.baseURL, "https://api.fixture.invalid/v1");
  assert.equal(r.api.model, "fixture-default", "没指定 model 时用模板的默认模型");
  assert.equal(r.api.envKey, "FIXTURE_API_KEY");
  assert.equal(r.env.FIXTURE_API_KEY, "sk-secret-abc", "子进程按模板声明的变量名取 key");
  assert.equal(r.env[RUNTIME_KEY_VAR], undefined, "不该同时塞一份固定名的");
  assert.equal(r.api.verified, false, "模板里没有实测记录 = 没测过");
  assert.equal(r.api.structuredOutput, "prompt", "没测过就不声称服务端能强制 schema");
  assert.ok(Object.isFrozen(r.api));
  assert.equal(BASE_ENV.FIXTURE_API_KEY, undefined, "不许改动传进来的那份 env");
  const m = resolveRuntimeProvider(REPO, DATA, { provider: "fixture-api", apiKey: "k", model: "other-model" }, BASE_ENV);
  assert.equal(m.runtime === "api" && m.api.model, "other-model");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "fixture-api" }, BASE_ENV)), "missing_key");
  // 显式空模型 ≠ 没传:不许悄悄换成模板默认模型去调用、计费(Codex 复审 R3-1)
  for (const model of ["", "   "]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "fixture-api", apiKey: "k", model }, BASE_ENV)), "missing_model", JSON.stringify(model));
  }
});

test("模板的实测记录:实测可用才标已实测并按实测口径用 schema;实测不可用直接拒;没有默认模型必须填", () => {
  const DATA = dataRoot({
    ok: tpl("ok", { direct: { supported: true, structured_output: "server_schema", verified_at: "2026-10-01" } }),
    broken: tpl("broken", { direct: { supported: false, structured_output: "prompt", verified_at: "2026-10-01" } }),
    nomodel: tpl("nomodel", { default_model: null }),
  });
  const ok = resolveRuntimeProvider(REPO, DATA, { provider: "ok", apiKey: "k" }, BASE_ENV);
  if (ok.runtime !== "api") assert.fail("应解析成模型 API");
  assert.equal(ok.api.verified, true);
  assert.equal(ok.api.structuredOutput, "server_schema");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "broken", apiKey: "k" }, BASE_ENV)), "api_unsupported");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "nomodel", apiKey: "k" }, BASE_ENV)), "missing_model");
  const filled = resolveRuntimeProvider(REPO, DATA, { provider: "nomodel", apiKey: "k", model: "m1" }, BASE_ENV);
  assert.equal(filled.runtime === "api" && filled.api.model, "m1");
  const matrix = templateMatrix(REPO, DATA);
  assert.equal(matrix.ok, "verified");
  assert.equal(matrix.broken, "unsupported");
  assert.equal(matrix.nomodel, "untested", "界面靠它打「已实测」标:没有实测记录绝不能标成已实测");
});

test("带占位符的模板:用户在界面上填了 baseURL 就能用起来", () => {
  const DATA = dataRoot({ ws: tpl("ws", { base_url: "https://{WorkspaceId}.example-cloud.invalid/compatible-mode/v1" }) });
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "ws", apiKey: "k" }, BASE_ENV)), "needs_base_url");
  // 🔴 覆盖必须发生在**校验之前**。顺序反了的话,用户明明填了自己的网关地址,
  //    仍然会被告知"模板不能直接用" —— 而他已经照要求填了。
  const filled = "https://ws-1234.example-cloud.invalid/compatible-mode/v1";
  const r = resolveRuntimeProvider(REPO, DATA, { provider: "ws", apiKey: "k", baseURL: filled }, BASE_ENV);
  if (r.runtime !== "api") assert.fail("应解析成模型 API");
  assert.equal(r.api.baseURL, filled);
  assert.equal(r.env.FIXTURE_API_KEY, "k");
});

test("自填端点:三样都要填;产品没测过就如实标出来;没有模板的厂商填了地址按自填端点走", () => {
  const DATA = dataRoot();
  const r = resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: "https://gw.example.com/v1", model: "my-model" }, BASE_ENV);
  if (r.runtime !== "api") assert.fail("自填端点应解析成模型 API");
  assert.equal(r.api.name, "openai-compatible");
  assert.equal(r.api.label, "自定义端点(gw.example.com)");
  assert.equal(r.api.model, "my-model");
  assert.equal(r.api.verified, false, "没测过就不许声称测过");
  assert.equal(r.api.structuredOutput, "prompt");
  assert.equal(r.api.envKey, RUNTIME_KEY_VAR);
  assert.equal(r.env[RUNTIME_KEY_VAR], "k");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", model: "m" }, BASE_ENV)), "missing_base_url");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", baseURL: "https://a.b/v1", model: "m" }, BASE_ENV)), "missing_key");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "openai-compatible", baseURL: "https://a.b/v1", apiKey: "k" }, BASE_ENV)), "missing_model");
  const vendor = resolveRuntimeProvider(REPO, DATA, { provider: "siliconflow", apiKey: "k", baseURL: "https://api.siliconflow.example/v1", model: "m" }, BASE_ENV);
  assert.equal(vendor.runtime === "api" && vendor.api.name, "siliconflow", "请求只会发到用户自己填的地址,名字照实记");
});

test("本地 HTTP 可配置;远程 HTTP 与伪装回环拒绝", () => {
  const DATA = dataRoot();
  for (const baseURL of ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://[::1]:1234/v1"]) {
    const r = resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "local-test", baseURL, model: "m" }, BASE_ENV);
    if (r.runtime !== "api") throw new Error("wrong runtime");
    assert.equal(r.api.baseURL, baseURL);
  }
  for (const baseURL of ["http://192.168.1.2/v1", "http://example.com/v1", "http://localhost.evil.test/v1", "http://127.0.0.1@evil.test/v1", "http://127.1/v1"]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "local-test", baseURL, model: "m" }, BASE_ENV)), "bad_base_url", baseURL);
  }
});

test("远程访问模式:页面填的模型地址只收 https 公网域名;IP(含十进制 / 十六进制写法)、localhost、内网名字一律拒;模板自带地址与订阅不受影响", () => {
  for (const ok of ["https://api.deepseek.com", "https://api.openai.com/v1", "https://gw.example.com:8443/v1", "https://api.example.com./v1",
    "https://xn--fsqu00a.xn--0zwm56d/v1"]) {
    assert.equal(remotePageBaseUrlError(ok), null, ok);
  }
  for (const bad of ["http://api.deepseek.com/v1", "https://127.0.0.1/v1", "https://2130706433/v1", "https://0x7f.0.0.1/v1", "https://127.1/v1",
    "https://169.254.169.254/latest", "https://10.0.0.5/v1", "https://[::1]/v1", "https://[::ffff:169.254.169.254]/v1", "https://[fd00::1]/v1",
    "https://localhost/v1", "https://LOCALHOST./v1", "https://vr.localhost/v1", "https://intranet/v1", "https://printer.local/v1",
    "https://metadata.google.internal/computeMetadata", "https://router.home.arpa/v1", "https://home.arpa/v1", "https://box.localdomain/v1", "http://127.0.0.1:11434/v1"]) {
    assert.match(String(remotePageBaseUrlError(bad)), /只能是 https 公网域名/, bad);
  }
  assert.equal(remotePageBaseUrlError("不是个 URL"), null, "格式错误交给 bad_base_url 报");

  const DATA = dataRoot({ "fixture-api": tpl("fixture-api"), "local-gw": tpl("local-gw", { base_url: "http://127.0.0.1:11434/v1" }) });
  const REMOTE = { ...BASE_ENV, VRA_REMOTE: "1", FIXTURE_API_KEY: "k" };
  const custom = (baseURL: string, env: NodeJS.ProcessEnv) =>
    code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL, model: "m" }, env));
  assert.equal(custom("http://127.0.0.1:11434/v1", REMOTE), "remote_base_url_forbidden");
  assert.equal(custom("https://169.254.169.254/v1", REMOTE), "remote_base_url_forbidden");
  assert.equal(custom("https://gw.example.com/v1", REMOTE), "(没抛)");
  assert.equal(custom("http://127.0.0.1:11434/v1", BASE_ENV), "(没抛)", "本机模式照旧能接本机模型服务");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "fixture-api", apiKey: "k", baseURL: "https://10.0.0.1/v1" }, REMOTE)),
    "remote_base_url_forbidden", "模板 + 页面覆盖地址同样受限");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "siliconflow", apiKey: "k", baseURL: "https://[::1]/v1", model: "m" }, REMOTE)),
    "remote_base_url_forbidden", "没有模板的厂商 + 页面地址同样受限");
  // 页面不传地址时用模板自己的地址(部署者放的模板可以指向本机):不归这条管
  const tplOwn = resolveRuntimeProvider(REPO, DATA, { provider: "local-gw", apiKey: "k" }, REMOTE);
  assert.equal(tplOwn.runtime === "api" && tplOwn.api.baseURL, "http://127.0.0.1:11434/v1");
  assert.equal(resolveRuntimeProvider(REPO, DATA, { provider: "cli-codex" }, REMOTE).runtime, "local-agent");
  // 后台默认不带页面地址,也不受限
  const DEF = dataRoot({ "local-gw": tpl("local-gw", { base_url: "http://127.0.0.1:11434/v1" }) }, { provider: { profile: "local-gw" } });
  const def = resolveSelectedRuntime(REPO, DEF, undefined, REMOTE);
  assert.equal(def.runtime === "api" && def.api.baseURL, "http://127.0.0.1:11434/v1");
  // 报错不回显原串
  try {
    resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: "http://10.0.0.1/secret-path-xyz", model: "m" }, REMOTE);
    assert.fail("应当报错");
  } catch (e) {
    assert.ok(e instanceof RuntimeProviderError && !e.message.includes("secret-path-xyz"));
  }
});

test("baseURL 只放 http(s);认不出的来源报错而不是换一家去打", () => {
  const DATA = dataRoot({ "fixture-api": tpl("fixture-api") });
  for (const bad of ["file:///etc/passwd", "ftp://x/y", "不是个 URL"]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: bad, model: "m" }, BASE_ENV)), "bad_base_url", bad);
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "fixture-api", apiKey: "k", baseURL: bad }, BASE_ENV)), "bad_base_url", bad);
  }
  // 🔴 URL 里内嵌凭据要拒 —— 否则 key 会跟着 base_url 走进运行记录、也会跟着报错走回界面
  for (const creds of ["https://u:p@gw.example.com/v1", "https://user@gw.example.com/v1", "https://gw.example.com/v1?key=sk-x"]) {
    assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: creds, model: "m" }, BASE_ENV)), "bad_base_url", creds);
  }
  // 🔴 报错不许回显原串:用户可能把密钥粘进 URL,而报错消息一路回到界面、也可能被上层记下来
  try {
    resolveRuntimeProvider(REPO, DATA, { provider: "custom", apiKey: "k", baseURL: "ht!tp://never mind/secret-token-xyz", model: "m" }, BASE_ENV);
    assert.fail("非法 URL 应当报错");
  } catch (e) {
    assert.ok(e instanceof RuntimeProviderError && !e.message.includes("secret-token-xyz"), `报错回显了原串:${String(e)}`);
  }
  // 🔴 悄悄回落到默认 = 用户以为在用自己选的模型,账单和产出却来自别处,且没有任何提示
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "nosuchvendor", apiKey: "k" }, BASE_ENV)), "unknown_provider");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "../etc", apiKey: "k" }, BASE_ENV)), "bad_provider");
  assert.equal(code(() => resolveRuntimeProvider(REPO, DATA, { provider: "   " }, BASE_ENV)), "bad_provider");
});

test("后台默认:没配就报错(不替用户编一个大脑);订阅档不接 --model;API 模板的 key 只从环境变量读", () => {
  assert.equal(code(() => defaultLlm(REPO, dataRoot(), BASE_ENV)), "ai_source_not_configured");
  // v1 用户留着产品专用登录的配置:报错要指路到 cli-codex,而不是只说"没配"
  try { defaultLlm(REPO, dataRoot({}, { provider: { auth: "chatgpt" } }), BASE_ENV); assert.fail("应当报错"); }
  catch (e) { assert.ok(e instanceof RuntimeProviderError && e.code === "ai_source_not_configured" && /cli-codex/.test(e.message), String(e)); }
  assert.deepEqual(defaultLlm(REPO, dataRoot({}, { provider: { profile: "cli-codex" } }), BASE_ENV), { provider: "cli-codex" });
  assert.deepEqual(defaultLlm(REPO, dataRoot(), { ...BASE_ENV, VRA_PROVIDER: "cli-claude" }), { provider: "cli-claude" });
  assert.equal(code(() => defaultLlm(REPO, dataRoot({}, { provider: { profile: "cli-codex" } }), BASE_ENV, { model: "gpt-x" })), "model_not_supported");

  const api = dataRoot({ "fixture-api": tpl("fixture-api") }, { provider: { profile: "fixture-api" }, defaults: { model: "cfg-model" } });
  try { defaultLlm(REPO, api, BASE_ENV); assert.fail("缺 key 应当报错"); }
  catch (e) { assert.ok(e instanceof RuntimeProviderError && e.code === "missing_key" && e.message.includes("FIXTURE_API_KEY"), String(e)); }
  assert.deepEqual(defaultLlm(REPO, api, { ...BASE_ENV, FIXTURE_API_KEY: "sk-env" }), { provider: "fixture-api", apiKey: "sk-env", model: "cfg-model" });
  assert.deepEqual(defaultLlm(REPO, api, { ...BASE_ENV, FIXTURE_API_KEY: "sk-env" }, { model: "cli-model" }).model, "cli-model");
  // 显式空模型(程序化 runBatch({ model: "" }))要原样进统一校验,不能被省略后换成模板默认(Codex 复审 R4-1)
  assert.equal(code(() => resolveSelectedRuntime(REPO, api, undefined, { ...BASE_ENV, FIXTURE_API_KEY: "sk-env" }, { model: "" })), "missing_model");
  // 配置文件里写空模型:加载时就被拒(null 才表示"不指定"),不会落到模板默认
  const blank = dataRoot({ "fixture-api": tpl("fixture-api") }, { provider: { profile: "fixture-api" }, defaults: { model: "" } });
  assert.equal(code(() => resolveSelectedRuntime(REPO, blank, undefined, { ...BASE_ENV, FIXTURE_API_KEY: "sk-env" })), "bad_provider");
  assert.equal(code(() => defaultLlm(REPO, dataRoot({}, { provider: { profile: "ghost" } }), BASE_ENV)), "bad_template");
  assert.equal(code(() => defaultLlm(REPO, dataRoot({}, { brain: "x" }), BASE_ENV)), "bad_provider");
  // 显式传了来源就不读后台默认
  const sel = resolveSelectedRuntime(REPO, dataRoot(), { provider: "cli-codebuddy" }, BASE_ENV);
  assert.equal(sel.runtime === "local-agent" && sel.agent, "codebuddy");
});

test("v1 的 openai(产品内置 Codex 的 ChatGPT 登录)在 v2 一律报错指路,不会因为环境里有 OPENAI_API_KEY 就悄悄改走按量 API", () => {
  const withKey = { ...BASE_ENV, OPENAI_API_KEY: "sk-fixture-not-to-be-used" };
  // v1 init 写出的骨架原样(provider 默认 openai,不写 auth)
  const v1 = dataRoot({}, { python: null, provider: { profile: "openai" }, defaults: { model: null, reasoning: null } });
  const leftover = dataRoot({ openai: tpl("openai", { env_key: "OPENAI_API_KEY" }) });
  for (const [label, run] of [
    ["v1 骨架", () => defaultLlm(REPO, v1, withKey)],
    ["v1 骨架 → resolveSelectedRuntime", () => resolveSelectedRuntime(REPO, v1, undefined, withKey)],
    ["VRA_PROVIDER", () => defaultLlm(REPO, dataRoot(), { ...withKey, VRA_PROVIDER: "openai" })],
    ["--provider", () => defaultLlm(REPO, dataRoot(), withKey, { providerOverride: "openai" })],
    ["页面请求", () => resolveRuntimeProvider(REPO, dataRoot(), { provider: "openai", apiKey: "sk-page" }, withKey)],
    ["数据根留着同名覆盖模板", () => resolveRuntimeProvider(REPO, leftover, { provider: "openai", apiKey: "sk-page" }, withKey)],
  ] as const) {
    try { run(); assert.fail(`${label}:应当报错`); }
    catch (e) { assert.ok(e instanceof RuntimeProviderError && e.code === "provider_renamed" && /cli-codex/.test(e.message) && /openai-api/.test(e.message), `${label}:${e}`); }
  }
  assert.ok(!templateIds(REPO, leftover).includes("openai"), "停用的 id 不进模板清单");
  // 新名字照常解析成 OpenAI 官方 API
  const r = resolveRuntimeProvider(REPO, dataRoot(), { provider: "openai-api", apiKey: "sk-page" }, BASE_ENV);
  assert.ok(r.runtime === "api" && new URL(r.api.baseURL).host === "api.openai.com" && r.api.model === "gpt-5.4", r.runtime);
  assert.deepEqual(defaultLlm(REPO, dataRoot({}, { provider: { profile: "openai-api" } }), withKey), { provider: "openai-api", apiKey: "sk-fixture-not-to-be-used" });
});

test("服务层 → 研究子进程的来源交接:描述里不带 key,子进程从 envKey 取回;形状不对一律报错", () => {
  const DATA = dataRoot({ "fixture-api": tpl("fixture-api") });
  const llm = { provider: "fixture-api", apiKey: "sk-handoff", model: "m2" };
  const runtime = resolveRuntimeProvider(REPO, DATA, llm, BASE_ENV);
  const meta = requestLlmMeta(llm, runtime);
  assert.deepEqual(meta, { provider: "fixture-api", model: "m2", envKey: "FIXTURE_API_KEY" });
  assert.ok(!JSON.stringify(meta).includes("sk-handoff"), "来源描述里不许出现 key");
  assert.deepEqual(parseRequestLlmMeta(JSON.stringify(meta), runtime.env), llm);
  const local = resolveRuntimeProvider(REPO, DATA, { provider: "cli-claude" }, BASE_ENV);
  assert.deepEqual(requestLlmMeta({ provider: "cli-claude", model: "x" }, local), { provider: "cli-claude" });
  for (const bad of ["{oops", "[]", '{"provider":1}', '{"provider":"fixture-api"}', '{"provider":"cli-claude","apiKey":"sk"}', '{"provider":"x","envKey":"lower"}']) {
    assert.equal(code(() => parseRequestLlmMeta(bad, {})), "bad_request_meta", bad);
  }
  // 指纹:换 key / 换模型 / 换大脑都要变;不含 key 原文
  const fp = (l: typeof llm | { provider: string }) => runtimeSourceFingerprint(REPO, DATA, l, BASE_ENV);
  assert.match(fp(llm), /^[0-9a-f]{64}$/);
  assert.notEqual(fp(llm), fp({ ...llm, apiKey: "sk-other" }));
  assert.notEqual(fp(llm), fp({ ...llm, model: "m3" }));
  assert.notEqual(fp({ provider: "cli-claude" }), fp({ provider: "cli-codex" }));
  assert.equal(fp({ provider: "cli-claude" }), fp({ provider: "cli-claude" }));
});

test("模板清单来自磁盘;产品自带模板都过得了 v2 契约(带占位符的只差用户填地址)", () => {
  const DATA = dataRoot();
  const ids = templateIds(REPO, DATA);
  const onDisk = fs.readdirSync(path.join(REPO, "providers")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  // 🔴 前端拿它给"已实测"打标。写死一份的话,迟早与 providers/ 目录对不上
  assert.deepEqual(ids, onDisk);
  // 用户数据根里的模板也要算进去(用户可以自己放一份)
  assert.ok(templateIds(REPO, dataRoot({ mygw: {} })).includes("mygw"));
  for (const id of onDisk) {
    const c = code(() => resolveRuntimeProvider(REPO, DATA, { provider: id, apiKey: "k", model: "m" }, BASE_ENV));
    assert.ok(c === "(没抛)" || c === "needs_base_url", `产品模板 ${id} 解析失败:${c}`);
  }
});
