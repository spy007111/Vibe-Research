import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { apiCapabilityOf, apiVerificationOf, listProviderIds, loadProviderProfile, renamedProviderHint, validateProfile, withOutputSchema, type ProviderProfileFile } from "../src/providers.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 把模板里留给用户填的占位符换成一个合法值 —— 只用于"模板本身是否自洽"的校验 */
const fillPlaceholders = (raw: string): string => raw.replace(/[{<][A-Za-z_][A-Za-z0-9_]*[}>]/g, "filled-by-user");

/** v1 为旧引擎(Responses 协议)写的字段:用户旧覆盖模板里允许出现,产品自带模板里不该再有 */
const LEGACY_KEYS = ["wire_api", "auth_modes", "requires_openai_auth", "responses_support", "stream_format", "tool_calls", "reasoning",
  "retryable_errors", "query_params", "http_headers", "env_http_headers", "request_max_retries", "stream_max_retries",
  "stream_idle_timeout_ms", "structured_output", "matrix"];

const base = (extra: Record<string, unknown> = {}) => ({
  id: "x", name: "X", base_url: "https://x.example/v1", env_key: "X_API_KEY", default_model: "m", ...extra,
});

test("产品模板:全部过 v2 契约,只描述 Chat Completions 端点,不残留旧引擎字段,不含密钥", () => {
  const ids = listProviderIds(REPO, path.join(REPO, ".local"));
  for (const must of ["openai-api", "deepseek", "qwen", "glm", "kimi", "mimo"]) assert.ok(ids.includes(must), `缺模板 ${must}:${ids.join(",")}`);
  for (const id of ids) {
    const raw = fs.readFileSync(path.join(REPO, "providers", `${id}.json`), "utf8");
    // 带占位符的模板 loadProviderProfile 会按设计拒绝(下一条验),这里补上占位再校验模板本身是否自洽
    const profile = validateProfile(JSON.parse(fillPlaceholders(raw)), `模板 ${id}`);
    assert.equal(profile.id, id);
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(raw) && !/Bearer\s+\S{8,}/.test(raw), `${id} 模板含密钥样式`);
    const legacy = Object.keys(JSON.parse(raw) as object).filter((k) => LEGACY_KEYS.includes(k));
    assert.deepEqual(legacy, [], `${id} 还留着旧引擎字段`);
    assert.doesNotMatch(profile.name, /Responses|Codex/i, `${id} 的名字还在讲旧协议`);
    assert.ok(profile.base_url, `${id} 必须给出端点地址(或带占位符的地址),不能留空`);
    assert.match(profile.base_url!, id === "selfhosted" ? /^http:\/\/localhost:\d+\// : /^https:\/\//);
    assert.doesNotMatch(profile.base_url!, /\/chat\/completions\/?$/, `${id}:base_url 是根地址,请求会自己拼 /chat/completions`);
    assert.ok(profile.verified_at === null || /^\d{4}-\d{2}-\d{2}$/.test(profile.verified_at ?? ""), id);
    if (profile.direct) assert.ok(profile.direct.verified_at, `${id} 声称实测过就必须写实测日期`);
  }
  assert.throws(() => loadProviderProfile(REPO, path.join(REPO, ".local"), "nope"), /未知 provider/);
  assert.throws(() => loadProviderProfile(REPO, path.join(REPO, ".local"), "../x"), /非法 provider id/);
});

test("带占位符的模板不能直接用 —— 选用时当场拒;界面填的地址在校验之前替换(连同实测段里的地址)", () => {
  const dataRoot = tmp("vra-ph-");
  fs.mkdirSync(path.join(dataRoot, "providers"));
  fs.writeFileSync(path.join(dataRoot, "providers", "ws.json"), JSON.stringify(base({ id: "ws",
    base_url: "https://{WorkspaceId}.cloud.example/v1",
    direct: { supported: true, base_url: "https://{WorkspaceId}.cloud.example/v1", structured_output: "prompt", verified_at: "2026-10-01" } })));
  assert.throws(() => loadProviderProfile(REPO, dataRoot, "ws"), /占位符 \{WorkspaceId\}/);
  const p = loadProviderProfile(REPO, dataRoot, "ws", "https://ws-1.cloud.example/v1").profile;
  assert.equal(p.base_url, "https://ws-1.cloud.example/v1");
  assert.equal(p.direct?.base_url, "https://ws-1.cloud.example/v1", "实测段里的旧地址不替换的话,请求仍会发往占位符地址");
  // 产品自带模板里带占位符的,也一律在选用时拒
  for (const f of fs.readdirSync(path.join(REPO, "providers")).filter((x) => x.endsWith(".json"))) {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, "providers", f), "utf8")) as { base_url: string | null };
    if (raw.base_url && /[{<][A-Za-z_]/.test(raw.base_url)) {
      assert.throws(() => loadProviderProfile(REPO, path.join(REPO, ".local"), path.basename(f, ".json")), /占位符/, f);
    }
  }
});

test("#34 用户覆盖模板优先于产品模板;远程 HTTPS / 本机 HTTP 边界不因覆盖放宽", () => {
  const dataRoot = tmp("vra-selfhosted-");
  try {
    const tpl = JSON.parse(fs.readFileSync(path.join(REPO, "providers/selfhosted.json"), "utf8")) as ProviderProfileFile;
    assert.equal(tpl.default_model, null, "自托管没有通用的默认模型,必须由用户填");
    assert.equal(apiVerificationOf(tpl), "untested", "自托管不可能有产品实测记录");
    fs.mkdirSync(path.join(dataRoot, "providers"));
    fs.writeFileSync(path.join(dataRoot, "providers/selfhosted.json"), JSON.stringify({ ...tpl, base_url: "http://127.0.0.1:11434/v1", default_model: "test-model" }));
    const { profile, source } = loadProviderProfile(REPO, dataRoot, "selfhosted");
    assert.equal(source, path.join(dataRoot, "providers", "selfhosted.json"));
    assert.equal(profile.base_url, "http://127.0.0.1:11434/v1");
    assert.equal(profile.default_model, "test-model");
    assert.throws(() => validateProfile({ ...profile, base_url: "http://192.168.1.10:8000/v1" }, "t"), /HTTPS/);
    assert.throws(() => validateProfile({ ...profile, base_url: "ftp://example.com/v1" }, "t"), /schema/);
    assert.doesNotThrow(() => validateProfile({ ...profile, base_url: "https://model.example.com/v1" }, "t"));
    // 用户覆盖模板的 id 必须与文件名一致,不能借名
    fs.writeFileSync(path.join(dataRoot, "providers/selfhosted.json"), JSON.stringify({ ...tpl, id: "openai", base_url: "http://127.0.0.1:11434/v1" }));
    assert.throws(() => loadProviderProfile(REPO, dataRoot, "selfhosted"), /与文件名不符/);
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("停用的来源 id openai:读模板直接报错指路(数据根里留着 v1 复制的同名文件也不读),模板清单里不列出", () => {
  const dataRoot = tmp("vra-renamed-");
  try {
    fs.mkdirSync(path.join(dataRoot, "providers"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "providers", "openai.json"), JSON.stringify(base({ id: "openai", env_key: "OPENAI_API_KEY" })));
    assert.throws(() => loadProviderProfile(REPO, dataRoot, "openai"), /cli-codex[\s\S]*openai-api/);
    const ids = listProviderIds(REPO, dataRoot);
    assert.ok(!ids.includes("openai") && ids.includes("openai-api"), ids.join(","));
    assert.equal(loadProviderProfile(REPO, dataRoot, "openai-api").profile.base_url, "https://api.openai.com/v1");
    assert.equal(renamedProviderHint("openai-api"), null);
    assert.equal(renamedProviderHint("constructor"), null, "原型链上的名字不算停用 id");
  } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
});

test("validateProfile:拒非法 env_key / 非 HTTPS / URL 内凭据 / 未知字段 / 乱写的实测段;v1 旧字段读得懂、不报错", () => {
  assert.equal(validateProfile(base(), "t").id, "x");
  for (const [patch, re] of [
    [{ env_key: "PATH" }, /schema/],
    [{ env_key: "lower_case" }, /schema/],
    [{ base_url: "http://insecure.example/v1" }, /HTTPS/],
    [{ base_url: "https://u:p@x.example/v1" }, /用户名密码/],
    [{ base_url: "https://x.example/v1?key=abc" }, /查询参数/],
    [{ extra: 1 }, /schema/],
    [{ api_key: "sk-abcdefghijklmnop" }, /schema/],
    [{ context_limit_tokens: 0 }, /schema/],
    [{ verified_at: "yesterday" }, /schema/],
    [{ direct: { supported: true } }, /schema/],
    [{ direct: { supported: true, structured_output: "json_schema" } }, /schema/],
    [{ direct: { supported: true, structured_output: "prompt", base_url: "http://evil.example/v1" } }, /HTTPS|schema/],
  ] as const) {
    assert.throws(() => validateProfile(base(patch), "t"), re, JSON.stringify(patch));
  }
  const { default_model: _d, ...noModel } = base();
  assert.throws(() => validateProfile(noModel, "t"), /schema/, "default_model 必须显式写(可以是 null)");
  // 用户数据根里留着的 v1 覆盖模板照样能加载:旧字段不校验、也不使用
  assert.doesNotThrow(() => validateProfile(base({ wire_api: "responses", auth_modes: ["api_key"], requires_openai_auth: false,
    responses_support: "native", structured_output: "json_schema", matrix: { status: "untested" }, http_headers: { "X-Org": "o" } }), "t"));
});

test("能力判定:没有实测记录 = 没测过(照样能用但如实标出);实测段覆盖顶层地址与模型;实测不可用直接拒;没地址就要用户填", () => {
  const untested = apiCapabilityOf(validateProfile(base(), "t"));
  assert.deepEqual(untested.usable && [untested.verified, untested.structuredOutput, untested.baseURL, untested.model], [false, "prompt", "https://x.example/v1", "m"]);
  const ok = apiCapabilityOf(validateProfile(base({ direct: { supported: true, structured_output: "server_schema", base_url: "https://cc.example/v1", default_model: "m2", verified_at: "2026-10-01" } }), "t"));
  assert.deepEqual(ok.usable && [ok.verified, ok.structuredOutput, ok.baseURL, ok.model], [true, "server_schema", "https://cc.example/v1", "m2"]);
  const no = apiCapabilityOf(validateProfile(base({ direct: { supported: false, structured_output: "prompt", verified_at: "2026-10-01" } }), "t"));
  assert.equal(!no.usable && no.code, "api_unsupported");
  // 🔴 没地址的模板绝不回落到某个默认端点(v1 的旧引擎会回落到 OpenAI 官方,key 发错主机)
  const nobase = apiCapabilityOf(validateProfile(base({ base_url: null }), "t"));
  assert.equal(!nobase.usable && nobase.code, "needs_base_url");
  assert.equal(apiVerificationOf({ direct: { supported: true } }), "verified");
  assert.equal(apiVerificationOf({ direct: { supported: false } }), "unsupported");
  assert.equal(apiVerificationOf({ matrix: { status: "baseline" } }), "untested", "v1 的旧引擎矩阵不算 Chat Completions 实测");
  assert.equal(apiVerificationOf(null), "untested");
});

test("用户覆盖模板是符号链接 / 目录 / JSON null → 报错,不悄悄改用产品模板;没有覆盖才用产品模板", () => {
  const dataRoot = tmp("vra-override-");
  fs.mkdirSync(path.join(dataRoot, "providers"));
  const own = path.join(dataRoot, "providers", "deepseek.json");
  const product = path.join(REPO, "providers", "deepseek.json");
  assert.equal(loadProviderProfile(REPO, dataRoot, "deepseek").source, product, "没有覆盖 → 产品模板");
  // 指向一份合法模板的符号链接:以前被当成「不存在」,悄悄回落到产品模板,使用者以为自己的覆盖生效了
  const target = path.join(tmp("vra-override-target-"), "deepseek.json");
  fs.writeFileSync(target, fs.readFileSync(product));
  fs.symlinkSync(target, own);
  assert.throws(() => loadProviderProfile(REPO, dataRoot, "deepseek"), /不是普通文件/);
  fs.rmSync(own);
  fs.symlinkSync(path.join(dataRoot, "nowhere.json"), own);
  assert.throws(() => loadProviderProfile(REPO, dataRoot, "deepseek"), /不是普通文件/, "悬空符号链接同样报错");
  fs.rmSync(own);
  fs.mkdirSync(own);
  assert.throws(() => loadProviderProfile(REPO, dataRoot, "deepseek"), /不是普通文件/, "同名目录");
  fs.rmSync(own, { recursive: true });
  fs.writeFileSync(own, "null");
  assert.throws(() => loadProviderProfile(REPO, dataRoot, "deepseek"), /schema/, "内容是 JSON null:交给校验报错,不当成没有覆盖");
  fs.rmSync(own);
  assert.equal(loadProviderProfile(REPO, dataRoot, "deepseek").source, product, "删掉覆盖后回到产品模板");
  // 数据根的 providers 本身是个普通文件(没有覆盖目录):当成没有覆盖,照常用产品模板
  const dataRoot2 = tmp("vra-override-file-");
  fs.writeFileSync(path.join(dataRoot2, "providers"), "");
  assert.equal(loadProviderProfile(REPO, dataRoot2, "deepseek").source, product);
});

test("providers 目录是符号链接 / 解析到根之外 → 拒绝(即使 id 合法)", () => {
  const outside = tmp("vra-outside-");
  fs.writeFileSync(path.join(outside, "fixture.json"), JSON.stringify(base({ id: "fixture" })));
  const repo = tmp("vra-plink-");
  fs.symlinkSync(outside, path.join(repo, "providers"));
  assert.throws(() => loadProviderProfile(repo, path.join(repo, ".local"), "fixture"), /符号链接|根目录之外/);
  // 用户目录 .local/providers 同样受限
  const repo2 = tmp("vra-plink2-");
  fs.mkdirSync(path.join(repo2, ".local"), { recursive: true });
  fs.symlinkSync(outside, path.join(repo2, ".local", "providers"));
  assert.throws(() => loadProviderProfile(repo2, path.join(repo2, ".local"), "fixture"), /符号链接|根目录之外/);
  // 正常目录照常
  fs.cpSync(outside, path.join(repo2, "providers"), { recursive: true });
  fs.rmSync(path.join(repo2, ".local", "providers"));
  assert.equal(loadProviderProfile(repo2, path.join(repo2, ".local"), "fixture").profile.id, "fixture");
  // 枚举也不穿过符号链接目录:repo 的 providers 是 symlink → 列表为空,报错如实说没有模板
  assert.deepEqual(listProviderIds(repo, path.join(repo, ".local")), []);
  assert.throws(() => loadProviderProfile(repo, path.join(repo, ".local"), "nope"), /可用:\(没有模板\)$/);
});

test("🔴 服务端不认 schema 时降级到提示词 —— 损失的是命中率,不是校验(产物照样过产品自己的校验)", () => {
  const schema = { type: "object", required: ["a"], properties: { a: { type: "integer" } } };
  const a = withOutputSchema("原提示词", schema, "server_schema");
  assert.equal(a.prompt, "原提示词", "服务端能强制 schema 时提示词一个字不动");
  assert.deepEqual(a.outputSchema, schema);
  const b = withOutputSchema("原提示词", schema, "prompt");
  assert.equal(b.outputSchema, undefined, "不能再硬传 —— 不认 schema 的服务端会整轮拒掉");
  assert.ok(b.prompt.startsWith("原提示词"), "原提示词要留在前面");
  assert.ok(b.prompt.includes('"integer"'), "schema 本体要进提示词,不能只说一句'请输出 JSON'");
  for (const m of ["server_schema", "prompt"] as const) {
    assert.deepEqual(withOutputSchema("x", undefined, m), { prompt: "x" });
    assert.deepEqual(withOutputSchema("x", null, m), { prompt: "x" });
  }
});
