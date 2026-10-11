import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import "../src/finance/register.ts";   // 测试文件也是入口:凭据设置项由金融插件声明
import { SEC_CONTACT_FILE, SecContactError, maskSecContact, normalizeSecContact, readSavedSecContact, saveSecContact, secContactStatus, secContactValue } from "../src/finance/sec_contact.ts";
import { authEnvValue } from "../src/saved_credentials.ts";
import { ServiceError, setCredential } from "../src/service.ts";

const setSecContact = (ctx: { dataRoot: string }, input: unknown, env: NodeJS.ProcessEnv) => setCredential(ctx, "sec-contact", { contact: input }, env) as { source: string };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vra-sec-"));
const noEnv: NodeJS.ProcessEnv = {};

test("SEC 联系方式:整理空白、只收「英文姓名 邮箱」", () => {
  assert.equal(normalizeSecContact("  Zhang   San\tzhangsan@example.com \n"), "Zhang San zhangsan@example.com");
  assert.equal(normalizeSecContact("Zhang\r\nSan zhang.san+vr@mail.example.co"), "Zhang San zhang.san+vr@mail.example.co", "换行并成空格,请求头里不会出现换行");
  assert.equal(normalizeSecContact("Acme Research Ltd. admin@acme.io"), "Acme Research Ltd. admin@acme.io");
  for (const [bad, why] of [
    ["", "空"], ["   ", "空"],
    ["张三 zhangsan@example.com", "英文或拼音"], ["Zhang San zhangsän@example.com", "英文或拼音"],
    ["Zhang San", "格式"], ["zhangsan@example.com", "格式"], ["zhangsan@example.com Zhang San", "格式"],
    ["Zhang San zhangsan@example", "格式"], ["Zhang San zhangsan@.com", "格式"], ["123 456@example.com", "格式"],
    ["Zhang San a@b@example.com", "格式"], [`${"a".repeat(190)} z@example.com`, "太长"],
  ] as const) {
    assert.throws(() => normalizeSecContact(bad), (e: unknown) => e instanceof SecContactError && e.code === "bad_sec_contact" && e.message.includes(why), bad);
  }
});

test("SEC 联系方式:打码后不露全名和邮箱", () => {
  assert.equal(maskSecContact("Zhang San zhangsan@example.com"), "Z*** S*** z***@example.com");
  assert.equal(maskSecContact("not-a-contact"), "n***");
  assert.equal(maskSecContact(""), "***");
});

test("SEC 联系方式:保存 0600、清除、环境变量优先且锁定页面", () => {
  const root = tmp();
  try {
    assert.deepEqual(secContactStatus(root, noEnv), { source: "none", masked: null, valid: false });
    assert.equal(secContactValue(root, noEnv), null);
    const st = saveSecContact(root, " Zhang  San zhangsan@example.com ", noEnv);
    assert.deepEqual(st, { source: "saved", masked: "Z*** S*** z***@example.com", valid: true });
    const file = path.join(root, SEC_CONTACT_FILE);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).contact, "Zhang San zhangsan@example.com");
    assert.deepEqual(fs.readdirSync(root), [SEC_CONTACT_FILE], "不留临时文件");
    assert.equal(secContactValue(root, noEnv), "Zhang San zhangsan@example.com");

    const env = { VRA_SEC_CONTACT: " Ops Team ops@corp.example " };
    assert.equal(secContactValue(root, env), "Ops Team ops@corp.example", "环境变量优先");
    assert.deepEqual(secContactStatus(root, env), { source: "env", masked: "O*** T*** o***@corp.example", valid: true });
    assert.deepEqual(secContactStatus(root, { VRA_SEC_CONTACT: "just-a-name" }), { source: "env", masked: "j***", valid: false });
    assert.throws(() => saveSecContact(root, "A B a@b.co", env), (e: unknown) => e instanceof SecContactError && e.code === "sec_contact_env_locked");
    assert.throws(() => saveSecContact(root, null, env), (e: unknown) => e instanceof SecContactError && e.code === "sec_contact_env_locked");
    assert.equal(secContactValue(root, { VRA_SEC_CONTACT: "  " }), "Zhang San zhangsan@example.com", "空白的环境变量当没设");

    assert.throws(() => saveSecContact(root, "张三 z@example.com", noEnv), SecContactError);
    assert.equal(readSavedSecContact(root), "Zhang San zhangsan@example.com", "填错不覆盖原来的");
    assert.deepEqual(saveSecContact(root, "  ", noEnv), { source: "none", masked: null, valid: false });
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(saveSecContact(root, null, noEnv), { source: "none", masked: null, valid: false }, "没有文件时清除也不报错");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SEC 联系方式:坏文件当没填,不拖垮取数", () => {
  const root = tmp();
  const file = path.join(root, SEC_CONTACT_FILE);
  try {
    for (const body of ["{oops", "null", "[]", JSON.stringify({ contact: 42 }), JSON.stringify({ contact: "Zhang San\r\nX-Evil: 1 z@example.com" }).replace("\\r\\n", "\\u0000"),
      JSON.stringify({ contact: "张三 z@example.com" }), JSON.stringify({ other: "Zhang San z@example.com" })]) {
      fs.writeFileSync(file, body);
      assert.equal(readSavedSecContact(root), null, body);
      assert.deepEqual(secContactStatus(root, noEnv), { source: "none", masked: null, valid: false });
    }
    // 手改文件塞进换行:读出来已并成空格,不会把换行带进请求头
    fs.writeFileSync(file, JSON.stringify({ contact: "Zhang San\r\nzhangsan@example.com" }));
    assert.equal(readSavedSecContact(root), "Zhang San zhangsan@example.com");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("环境变量里的联系方式也整理、校验:夹换行的并成空格,格式不对的当没填(不退回设置页存的那份)", () => {
  const root = tmp();
  try {
    saveSecContact(root, "Zhang San zhangsan@example.com", noEnv);
    const messy = { VRA_SEC_CONTACT: " Ops\r\nTeam\tops@corp.example " };
    assert.equal(secContactValue(root, messy), "Ops Team ops@corp.example");
    assert.equal(authEnvValue("VRA_SEC_CONTACT", root, messy), "Ops Team ops@corp.example");
    assert.deepEqual(secContactStatus(root, messy), { source: "env", masked: "O*** T*** o***@corp.example", valid: true });
    for (const bad of ["运维 ops@corp.example", "Ops Team", "Ops Team ops@corp"]) {
      const env = { VRA_SEC_CONTACT: bad };
      assert.equal(secContactValue(root, env), null, bad);
      assert.equal(authEnvValue("VRA_SEC_CONTACT", root, env), undefined, bad);
      assert.equal(secContactStatus(root, env).valid, false, bad);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("凭据变量取值:只有 SEC 联系方式多认设置页保存的,其余只认环境变量", () => {
  const root = tmp();
  try {
    saveSecContact(root, "Zhang San zhangsan@example.com", noEnv);
    assert.equal(authEnvValue("VRA_SEC_CONTACT", root, noEnv), "Zhang San zhangsan@example.com");
    assert.equal(authEnvValue("VRA_SEC_CONTACT", root, { VRA_SEC_CONTACT: "Ops ops@x.io" }), "Ops ops@x.io");
    assert.equal(authEnvValue("IWENCAI_API_KEY", root, noEnv), undefined);
    assert.equal(authEnvValue("IWENCAI_API_KEY", root, { IWENCAI_API_KEY: "" }), undefined);
    assert.equal(authEnvValue("IWENCAI_API_KEY", root, { IWENCAI_API_KEY: "k" }), "k");
    fs.rmSync(path.join(root, SEC_CONTACT_FILE));
    assert.equal(authEnvValue("VRA_SEC_CONTACT", root, noEnv), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("设置页入口:远程模式不许改、类型不对按原因拒、错误码原样带出", () => {
  const root = tmp();
  const ctx = { dataRoot: root };
  try {
    assert.throws(() => setSecContact(ctx, "Zhang San z@example.com", { VRA_REMOTE: "1" }), (e: unknown) => e instanceof ServiceError && e.code === "remote_forbidden");
    assert.equal(fs.existsSync(path.join(root, SEC_CONTACT_FILE)), false);
    for (const bad of [undefined, 42, ["Zhang San z@example.com"], { contact: "x" }]) {
      assert.throws(() => setSecContact(ctx, bad, noEnv), (e: unknown) => e instanceof ServiceError && e.code === "bad_sec_contact", JSON.stringify(bad));
    }
    assert.throws(() => setSecContact(ctx, "Zhang San", noEnv), (e: unknown) => e instanceof ServiceError && e.code === "bad_sec_contact" && e.message.includes("例如"));
    assert.throws(() => setSecContact(ctx, "A B a@b.co", { VRA_SEC_CONTACT: "Ops ops@x.io" }), (e: unknown) => e instanceof ServiceError && e.code === "sec_contact_env_locked");
    assert.equal(setSecContact(ctx, "Zhang San z@example.com", noEnv).source, "saved");
    assert.equal(setSecContact(ctx, null, noEnv).source, "none");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
