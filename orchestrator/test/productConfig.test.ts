import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PRODUCT_CONFIG_FILE, loadProductConfig } from "../src/productConfig.ts";
import { configFromArgs } from "../src/run.ts";


import "../src/finance/register.ts";   // 测试文件也是入口:插件要先注册
function tmpRepo(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "vra-pc-")); }

test("产品配置:无文件 → 内置默认;相对路径相对产品根解析;没有默认大脑", () => {
  const repo = tmpRepo();
  const pc = loadProductConfig(repo, { env: {} });
  assert.deepEqual(pc.sources, ["builtin"]);
  assert.deepEqual(pc.resolved, {
    dataRoot: path.join(repo, ".local"),
    skills: path.join(repo, ".agents", "skills"),
    calcCli: path.join(repo, "calc", "cli.py"),
    scriptsRel: path.join(".agents", "skills", "data-access", "scripts"),
  }, "v2 不再解析引擎二进制 / 引擎 home / 宪法路径");
  assert.equal(pc.provider.profile, null, "v2 不替用户选大脑");
  assert.deepEqual(pc.ignoredLegacy, []);
});

test("产品配置:产品文件 ← 用户文件 ← 环境变量 ← CLI 逐层覆盖;schema 拒绝未知字段、密钥与非法 id", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, PRODUCT_CONFIG_FILE), JSON.stringify({ defaults: { max_retries: 1 }, paths: { data_root: "data" } }));
  fs.mkdirSync(path.join(repo, "data"), { recursive: true });
  const user = (v: unknown) => fs.writeFileSync(path.join(repo, "data", "config.json"), typeof v === "string" ? v : JSON.stringify(v));
  user({ provider: { profile: "cli-claude" }, python: "/v/bin/python" });
  let pc = loadProductConfig(repo, { env: {} });
  assert.equal(pc.resolved.dataRoot, path.join(repo, "data"));
  assert.equal(pc.defaults.max_retries, 1);
  assert.equal(pc.defaults.gate_retries, 2, "未覆盖的字段保留默认");
  assert.equal(pc.provider.profile, "cli-claude");
  assert.equal(pc.python, "/v/bin/python");
  pc = loadProductConfig(repo, { env: { VRA_PROVIDER: "deepseek" } });
  assert.equal(pc.provider.profile, "deepseek", "环境变量盖过用户文件");
  assert.ok(pc.sources.includes("env"));
  pc = loadProductConfig(repo, { env: { VRA_PROVIDER: "deepseek" }, providerOverride: "cli-codex" });
  assert.equal(pc.provider.profile, "cli-codex", "CLI 盖过环境变量");
  assert.ok(pc.sources.includes("cli"));
  assert.throws(() => loadProductConfig(repo, { env: { VRA_PROVIDER: "../evil" } }), /VRA_PROVIDER 不是合法的 AI 来源 id/);
  assert.throws(() => loadProductConfig(repo, { env: {}, providerOverride: "Bad Id" }), /--provider 不是合法的 AI 来源 id/);
  // 用户层不得改 data_root(它决定了用户配置自身的位置)
  user({ paths: { data_root: "elsewhere" } });
  assert.throws(() => loadProductConfig(repo, { env: {} }), /不得修改 paths.data_root/);
  for (const bad of [
    { provider: { api_key: "sk-secret" } },     // 密钥不允许进配置文件(未知字段)
    { provider: { profile: "Bad Id" } },
    { brain: "claude" },
    { defaults: { max_retries: 9 } },
    { defaults: { model: "" } },                // 空模型不等于"不指定"(null 才是),放行会被换成模板默认(R4-1)
    { defaults: { model: "  " } },
  ]) {
    user(bad);
    assert.throws(() => loadProductConfig(repo, { env: {} }), /schema/, JSON.stringify(bad));
  }
  user("{oops");
  assert.throws(() => loadProductConfig(repo, { env: {} }), /JSON/);
});

test("显式给了空的来源覆盖:进校验报错,不按真假值跳过、落回后台默认", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, PRODUCT_CONFIG_FILE), JSON.stringify({ paths: { data_root: "data" } }));
  fs.mkdirSync(path.join(repo, "data"), { recursive: true });
  fs.writeFileSync(path.join(repo, "data", "config.json"), JSON.stringify({ provider: { profile: "cli-claude" } }));
  assert.equal(loadProductConfig(repo, { env: {} }).provider.profile, "cli-claude");
  assert.throws(() => loadProductConfig(repo, { env: {}, providerOverride: "" }), /不是合法的 AI 来源 id/);
});

test("v1 旧配置照样能加载:旧引擎字段与旧环境变量只记进 ignoredLegacy,绝不被当成默认大脑", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, PRODUCT_CONFIG_FILE), JSON.stringify({ engine: { codex_path: "engine/bin/codex", codex_home: "home" } }));
  fs.mkdirSync(path.join(repo, ".local"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".local", "config.json"), JSON.stringify({
    provider: { name: "deepseek", wire_api: "responses", base_url: "http://127.0.0.1:8787/v1", env_key: "DEEPSEEK_API_KEY", auth: "api_key" },
    paths: { constitution: "AGENTS.md" },
    defaults: { reasoning: "high", max_retries: 3 },
  }));
  const pc = loadProductConfig(repo, { env: { VRA_CODEX_PATH: "/x/codex", VRA_CODEX_HOME: "/x/home", VRA_PROVIDER_AUTH: "chatgpt" } });
  assert.deepEqual([...pc.ignoredLegacy].sort(), [
    "VRA_CODEX_HOME", "VRA_CODEX_PATH", "VRA_PROVIDER_AUTH", "defaults.reasoning", "engine",
    "paths.constitution", "provider.auth", "provider.base_url", "provider.env_key", "provider.name", "provider.wire_api",
  ]);
  assert.equal(pc.provider.profile, null, "v1 的 provider.name 不能悄悄变成 v2 的默认大脑");
  assert.equal(pc.defaults.max_retries, 3, "同一层里的 v2 字段照常生效");
  assert.ok(!("reasoning" in pc.defaults) && !("constitution" in pc.paths), "旧字段不混进合并后的配置");
});

test("configFromArgs:产品配置进入 RunConfig;CLI 覆盖配置文件;旧引擎字段不影响干跑", () => {
  const repo = tmpRepo();
  fs.writeFileSync(path.join(repo, PRODUCT_CONFIG_FILE), JSON.stringify({ engine: { codex_path: "engine/bin/codex" }, defaults: { turn_timeout_min: 7, gate_retries: 1 } }));
  let { cfg, sources } = configFromArgs({ symbol: "300308", "repo-root": repo, "no-agent": true }, {});
  assert.equal(cfg.turnTimeoutMs, 7 * 60_000);
  assert.equal(cfg.gateRetries, 1);
  assert.equal(cfg.runDir, path.join(repo, ".local", "runs", cfg.runId));
  assert.equal(cfg.constitutionPath, path.join(repo, "methodology", "constitution.md"));
  assert.equal(cfg.engine, "none");
  assert.ok(sources.some((s) => s.endsWith(PRODUCT_CONFIG_FILE)));
  ({ cfg } = configFromArgs({ symbol: "300308", "repo-root": repo, "no-agent": true, "turn-timeout-min": "3", "gate-retries": "0" }, {}));
  assert.equal(cfg.turnTimeoutMs, 3 * 60_000);
  assert.equal(cfg.gateRetries, 0);
});

/* ===== 数据根:代码与用户数据分离 ===== */

test("VRA_DATA_ROOT 改数据根 —— 用户配置与产物必须同时跟着走", () => {
  const repo = tmpRepo();
  const data = tmpRepo();                        // 一个与产品根完全无关的位置
  // 用户配置放在**新数据根**下:能读到它,才证明"读配置的根"确实换了
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ defaults: { max_retries: 4 }, provider: { profile: "cli-codebuddy" } }));

  const pc = loadProductConfig(repo, { env: { VRA_DATA_ROOT: data } });

  assert.equal(pc.resolved.dataRoot, data, "产物根没跟着换 —— 会继续往旧代码目录写");
  assert.equal(pc.defaults.max_retries, 4, "没读到新数据根下的用户配置 —— 说明读配置的根还是旧的");
  assert.equal(pc.provider.profile, "cli-codebuddy");
  assert.ok(pc.sources.some((s) => s.startsWith(data)), `用户配置来源应指向新数据根:${pc.sources.join(" / ")}`);
  const { cfg } = configFromArgs({ symbol: "300308", "repo-root": repo, "no-agent": true }, { VRA_DATA_ROOT: data });
  assert.equal(cfg.runDir, path.join(data, "runs", cfg.runId), "运行产物要落在新数据根");
});

test("调用方显式 override 优先于 VRA_DATA_ROOT", () => {
  const repo = tmpRepo();
  const viaEnv = tmpRepo();
  const viaOpt = tmpRepo();
  const pc = loadProductConfig(repo, { env: { VRA_DATA_ROOT: viaEnv }, dataRootOverride: viaOpt });
  assert.equal(pc.resolved.dataRoot, viaOpt, "显式 override 应当赢过环境变量");
});
