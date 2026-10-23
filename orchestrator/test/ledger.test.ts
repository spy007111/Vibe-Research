import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import "../src/finance/register.ts"; // 测试文件也是入口:插件要先注册
import { ENVELOPE_KEYS, LedgerError, checkRecord, insertRecords, kinds, listAll, listAllIssues, listRecords, listRecordsChecked, removeRecord, upsertRecord } from "../src/ledger.ts";
import { assertKnownFormats } from "../src/formats.ts";
import { PLUGIN_SCHEMA } from "../src/plugin.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vra-ledger-"));
}

/** 按种类的 required 造一条最小合法记录(不硬编码字段名 —— 那样加字段时这里会假绿) */
function buildMinimal(kind: string): Record<string, unknown> {
  const def = kinds()[kind]!;
  const out: Record<string, unknown> = {};
  for (const r of def.required) {
    const p = def.properties[r] as { type?: string; enum?: unknown[]; pattern?: string } | undefined;
    if (p?.enum) out[r] = p.enum[0];
    else if (p?.type === "number") out[r] = 1;
    else if (r === "symbol") out[r] = "300308";
    else if ((p as { format?: string })?.format === "date") out[r] = "2026-09-01";
    else out[r] = "x";
  }
  return out;
}

const anyKind = (): string => Object.keys(kinds())[0]!;

test("清仓名称备注可选、真实保存重读，旧记录兼容，长备注不截断而明确拒绝", () => {
  const root = tmpRoot();
  const base = { symbol: "600519", closed_at: "2026-09-01", price: 1200, shares: 1, cost: 1000 };
  upsertRecord(root, "closed_position", base);
  const saved = upsertRecord(root, "closed_position", { ...base, name: "贵州茅台", note: "核对中报后复盘" });
  assert.equal(listRecords(root, "closed_position").find(r => r.id === saved.id)?.note, "核对中报后复盘");
  assert.throws(() => upsertRecord(root, "closed_position", { ...base, note: "字".repeat(1001) }), LedgerError);
  assert.equal(listRecords(root, "closed_position").length, 2);
});

test("整批新增:全部写进去、id 各不相同、录入时间按传入顺序递增;信封字段由 Core 定", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T08:21:55.386+08:00") });
  const root = tmpRoot();
  const k = anyKind();
  const one = buildMinimal(k);
  const first = upsertRecord(root, k, one);
  const added = insertRecords(root, k, [{ ...one }, { ...one, kind: "别的", created_at: "1999-01-01T00:00:00.000Z" }, { ...one }]);
  // 单条与批量使用同一种时间写法;不同调用允许同毫秒,严格递增只要求同一批内。
  assert.equal(added[0]!.created_at, first.created_at, "固定时钟覆盖单条与整批调用处于同一毫秒");
  assert.ok(added.every((r) => r.created_at.slice(-6) === first.created_at.slice(-6) && r.created_at >= first.created_at), `${first.created_at} / ${added[0]!.created_at}`);
  assert.equal(added.length, 3);
  assert.equal(new Set(added.map((r) => r.id)).size, 3);
  assert.ok(added.every((r) => r.kind === k && r.created_at === r.updated_at));
  assert.ok(added[0]!.created_at < added[1]!.created_at && added[1]!.created_at < added[2]!.created_at, "同一批按传入顺序逐条晚 1 毫秒");
  assert.deepEqual(added.map((r) => Date.parse(r.created_at) - Date.parse(added[0]!.created_at)), [0, 1, 2], "同一批每条恰好晚 1 毫秒");
  assert.deepEqual(listRecords(root, k).map((r) => r.id), [first.id, ...added.map((r) => r.id)]);
  assert.deepEqual(insertRecords(root, k, []), []);
  assert.equal(listRecords(root, k).length, 4);
});

test("🔴 整批新增要么全写、要么全不写:有一条不对、带 id、不是对象,都一条不写并报第几条", () => {
  const root = tmpRoot();
  const k = anyKind();
  const one = buildMinimal(k);
  upsertRecord(root, k, one);
  const file = path.join(root, "ledger", `${k}.json`);
  const before = fs.readFileSync(file);
  const cases: [unknown[], RegExp][] = [
    [[one, { ...one, 多余字段: 1 }, one], /第 2 条/],
    [[one, { ...one, id: "x" }], /第 2 条带了 id/],
    [[one, null], /第 2 条不是对象/],
    [[[one]], /第 1 条不是对象/],
  ];
  for (const [rows, msg] of cases) {
    assert.throws(() => insertRecords(root, k, rows as Record<string, unknown>[]), (e: unknown) => e instanceof LedgerError && e.code === "bad_record" && msg.test(e.message));
    assert.ok(fs.readFileSync(file).equals(before), `${msg}:文件一字未动`);
  }
  assert.throws(() => insertRecords(root, "不存在的种类", [one]), LedgerError);
});

test("🔴 整批写入后回读复核:落盘后被别人改掉、哪怕只少了这批里的一条,也要报写丢了", () => {
  const root = tmpRoot();
  const k = anyKind();
  const one = buildMinimal(k);
  upsertRecord(root, k, one);
  const file = path.join(root, "ledger", `${k}.json`);
  // 同单条写入的回读测试:钩 rename(atomicWrite 的最后一步),落盘后立刻把这批的最后一条删掉
  const orig = fs.renameSync;
  let armed = true;
  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((from: string, to: string) => {
    orig(from, to);
    if (armed && String(to) === file) {
      armed = false;
      const d = JSON.parse(fs.readFileSync(file, "utf8")) as { records: unknown[] };
      d.records.pop();
      fs.writeFileSync(file, JSON.stringify(d));
    }
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => insertRecords(root, k, [one, one, one]), (e: unknown) => e instanceof LedgerError && e.code === "write_lost");
  } finally {
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
  }
  assert.equal(insertRecords(root, k, [one]).length, 1, "钩子撤掉后照常");
});

test("只校验不写:能存返回 null、不能存返回原因,磁盘上什么都不产生", () => {
  const root = tmpRoot();
  const k = anyKind();
  assert.equal(checkRecord(k, buildMinimal(k)), null);
  assert.equal(checkRecord(k, { ...buildMinimal(k), id: "x", created_at: "y" }), null, "信封字段不算内容");
  assert.match(checkRecord(k, { ...buildMinimal(k), 多余字段: 1 }) ?? "", /\S/);
  assert.equal(fs.existsSync(path.join(root, "ledger")), false);
});

test("契约:ledger 是可选槽位 —— 不声明台账的垂类必须仍然合法", () => {
  // 第二垂类验收装置里的包就没有台账。required 里出现 ledger = 把一个可选能力变成了强制项。
  assert.ok(!(PLUGIN_SCHEMA.required as readonly string[]).includes("ledger"));
});

test("种类表来自插件,不是 Core 写死的", () => {
  const ks = kinds();
  assert.ok(Object.keys(ks).length > 0, "金融包声明了台账种类");
  for (const [k, def] of Object.entries(ks)) {
    assert.match(k, /^[a-z][a-z0-9_]{0,31}$/, `种类名要是安全路径段:${k}`);
    assert.ok(def.label && typeof def.label === "string");
    // 信封字段归 Core,垂类不许重名 —— 注册期就该拦住
    for (const e of ENVELOPE_KEYS) assert.ok(!(e in def.properties), `${k} 不该声明信封字段 ${e}`);
    for (const r of def.required) assert.ok(r in def.properties, `${k}.required 的 ${r} 缺 properties`);
  }
});

test("增改删:id / created_at 由 Core 拥有,更新是整条替换", () => {
  const root = tmpRoot();
  const kind = "position";
  const a = upsertRecord(root, kind, { symbol: "300308", shares: 100, cost: 846, note: "先写一条" });
  assert.ok(a.id.startsWith(`${kind}-`));
  assert.equal(a.kind, kind);
  assert.equal(a.created_at, a.updated_at);

  const b = upsertRecord(root, kind, { id: a.id, symbol: "300308", shares: 200, cost: 846 });
  assert.equal(b.id, a.id);
  assert.equal(b.created_at, a.created_at, "created_at 不因更新而改变");
  assert.equal(b.shares, 200);
  // 🔴 整条替换而非字段合并:否则"我把 note 清空了"与"我这次没提 note"无法区分
  assert.ok(!("note" in b), "更新是整条替换,没提到的字段就该消失");

  assert.equal(listRecords(root, kind).length, 1);
  assert.equal(removeRecord(root, kind, a.id), true);
  assert.equal(removeRecord(root, kind, a.id), false, "删不存在的要返回 false,不能假装删了");
  assert.equal(listRecords(root, kind).length, 0);
});

test("客户端塞信封字段无效:kind / created_at 一律由 Core 定", () => {
  const root = tmpRoot();
  const r = upsertRecord(root, "position", {
    symbol: "300308",
    shares: 1,
    cost: 1,
    kind: "evil",
    created_at: "1999-01-01",
    updated_at: "1999-01-01",
  });
  assert.equal(r.kind, "position");
  assert.notEqual(r.created_at, "1999-01-01");
});

test("未知种类一律拒绝 —— 它会被拼进文件路径,白名单是唯一防线", () => {
  const root = tmpRoot();
  for (const bad of ["nosuch", "../api.token", "position/../../x", "POSITION", ""]) {
    assert.throws(
      () => listRecords(root, bad),
      (e: unknown) => e instanceof LedgerError && e.code === "unknown_kind",
      `应拒绝 ${JSON.stringify(bad)}`,
    );
  }
  // 变异测试用:去掉 fileOf 的白名单,上面 "../api.token" 那条就会写到数据区外
  assert.ok(!fs.existsSync(path.join(root, "api.token")));
});

test("字段校验:必填缺失 / 多余字段 / 类型不对都要当场拒绝", () => {
  const root = tmpRoot();
  const bad: Record<string, unknown>[] = [
    { symbol: "300308" }, // 缺 shares / cost
    { symbol: "300308", shares: 1, cost: 1, typo: 1 }, // 多余字段 = 拼错了名字
    { symbol: "abc", shares: 1, cost: 1 }, // 代码不合模式
    { symbol: "300308", shares: -5, cost: 1 }, // 负数量
    { symbol: "300308", shares: 1, cost: 1, opened_at: "2026/08/25" }, // 日期格式
  ];
  for (const rec of bad) {
    assert.throws(
      () => upsertRecord(root, "position", rec),
      (e: unknown) => e instanceof LedgerError && e.code === "bad_record",
      `应拒绝 ${JSON.stringify(rec)}`,
    );
  }
  assert.equal(listRecords(root, "position").length, 0, "被拒的记录一条都不许落盘");
});

test("更新不存在的 id 要报错,不能悄悄变成新增", () => {
  const root = tmpRoot();
  assert.throws(
    () => upsertRecord(root, "position", { id: "position-nope", symbol: "300308", shares: 1, cost: 1 }),
    (e: unknown) => e instanceof LedgerError && e.code === "not_found",
  );
  assert.equal(listRecords(root, "position").length, 0);
});

test("文件损坏时报错并保留原文件 —— 不许'尽力解析'后丢掉一半记录", () => {
  const root = tmpRoot();
  const f = path.join(root, "ledger", "position.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schema_version: 1, records: { not: "an array" } }));
  assert.throws(
    () => listRecords(root, "position"),
    (e: unknown) => e instanceof LedgerError && e.code === "corrupt",
  );
  assert.ok(fs.existsSync(f), "原文件必须还在");
});

test("锁:持有者进程已死的残留锁要能回收(判据是 pid 活不活,不是 mtime)", () => {
  const root = tmpRoot();
  const f = path.join(root, "ledger", "position.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // 一个几乎不可能存在的 pid;万一真存在,它也不属于当前用户 → alive() 判 EPERM=活着,
  // 那样本用例会超时失败而不是假绿 —— 失败方向是对的。
  // 锁内容格式 = `pid:token`(token 用来确认"回收的还是我刚看到的那把锁")
  fs.writeFileSync(`${f}.lock`, "999999:deadbeef");
  const t0 = Date.now();
  const r = upsertRecord(root, "position", { symbol: "300308", shares: 1, cost: 1 });
  assert.ok(r.id);
  assert.ok(Date.now() - t0 < 4000, "死进程的锁应立刻回收,不该等满超时");
  assert.ok(!fs.existsSync(`${f}.lock`), "用完要把锁删掉");
});

test("锁:活着的持有者不许被抢,超时要报 locked 而不是覆盖写", () => {
  const root = tmpRoot();
  const f = path.join(root, "ledger", "position.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.lock`, `${process.pid}:aliveaaa`); // 当前进程 = 一定活着
  const t0 = Date.now();
  assert.throws(
    () => upsertRecord(root, "position", { symbol: "300308", shares: 1, cost: 1 }),
    (e: unknown) => e instanceof LedgerError && e.code === "locked",
  );
  assert.ok(Date.now() - t0 >= 4500, "应该真的等满超时再放弃");
  fs.rmSync(`${f}.lock`, { force: true });
});

test("listAll 覆盖全部声明的种类(少一种 = 界面上整块静默消失)", () => {
  const root = tmpRoot();
  const k = anyKind();
  upsertRecord(root, k, buildMinimal(k));
  const all = listAll(root);
  assert.deepEqual(Object.keys(all).sort(), Object.keys(kinds()).sort());
  assert.equal(all[k]!.length, 1);
});

test("每种声明的种类都真的能存进去(靠 required 造记录,加字段时不会假绿)", () => {
  const root = tmpRoot();
  for (const k of Object.keys(kinds())) {
    const r = upsertRecord(root, k, buildMinimal(k));
    assert.equal(r.kind, k);
    assert.equal(listRecords(root, k).length, 1, `${k} 应落盘 1 条`);
  }
});

test("损坏记录要逐条查出来 —— 只看'records 是数组'会让坏数据一路走到界面", () => {
  const root = tmpRoot();
  const f = path.join(root, "ledger", "position.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const ok = { id: "position-a", kind: "position", created_at: "t", updated_at: "t", symbol: "300308" };
  const cases: [string, unknown[]][] = [
    ["元素是 null(后面取 r.id 会 TypeError,变成 500)", [null]],
    ["元素是字符串", ["nope"]],
    ["缺 id", [{ kind: "position", created_at: "t", updated_at: "t" }]],
    ["kind 与文件不符", [{ ...ok, kind: "action" }]],
    ["id 重复(更新只改第一条、删除却删全部)", [ok, { ...ok }]],
  ];
  for (const [why, records] of cases) {
    fs.writeFileSync(f, JSON.stringify({ schema_version: 1, records }));
    assert.throws(
      () => listRecords(root, "position"),
      (e: unknown) => e instanceof LedgerError && e.code === "corrupt",
      `应判损坏:${why}`,
    );
  }
});

test("id 用 UUID 且新增前查重(撞 id 会让更新与删除给出不同答案)", () => {
  const root = tmpRoot();
  const ids = new Set<string>();
  for (let i = 0; i < 30; i++) ids.add(upsertRecord(root, "position", { symbol: "300308", shares: 1, cost: 1 }).id);
  assert.equal(ids.size, 30, "30 次新增要有 30 个不同 id");
  for (const id of ids) assert.match(id, /^position-[0-9a-f-]{36}$/, `id 应是 种类-UUID:${id}`);
});

test("🔴 磁盘记录也要按契约复核 —— 台账文件用户能手改,写入路径的校验绕得过去", () => {
  const root = tmpRoot();
  const ok = upsertRecord(root, "position", { symbol: "300308", shares: 100, cost: 8.46 });
  // 手工把文件改成一条**违反契约**的记录(类型错 + 多一个字段),模拟用户直接编辑 JSON
  const file = path.join(root, "ledger", "position.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
  data.records.push({
    id: "position-handmade", kind: "position",
    created_at: "2026-08-26T00:00:00.000Z", updated_at: "2026-08-26T00:00:00.000Z",
    symbol: "not-a-symbol", shares: "很多", cost: -100, unexpected: true,
  });
  fs.writeFileSync(file, JSON.stringify(data));

  const r = listRecordsChecked(root, "position");
  // 不删不改:两条都还在(丢掉用户手写的数据比报告问题更糟)
  assert.equal(r.records.length, 2);
  assert.equal(r.issues.length, 1, "只有那条坏的被报出来");
  assert.equal(r.issues[0]!.id, "position-handmade");
  assert.ok(/symbol|shares|cost|unexpected/.test(r.issues[0]!.why), `问题描述要点到字段:${r.issues[0]!.why}`);
  // 合法那条不该被牵连
  assert.ok(r.records.some((x) => x.id === ok.id));
  assert.deepEqual(listAllIssues(root).position?.map((i) => i.id), ["position-handmade"]);
});

test("🔴 日期必须是真实存在的日历日 —— 只查外形会让 2026-02-31 进到期清单", () => {
  const root = tmpRoot();
  for (const bad of ["2026-99-99", "2026-02-31", "2026-13-01", "2026-00-10", "2026-8-1"]) {
    assert.throws(
      () => upsertRecord(root, "action", { title: "复核", due: bad }),
      (e: unknown) => e instanceof LedgerError && e.code === "bad_record",
      `应拒绝 ${bad}`,
    );
  }
  // 合法的照过:闰年 2 月 29 要能存(不是把日期一律收紧)
  assert.equal(upsertRecord(root, "action", { title: "复核", due: "2028-02-29" }).due, "2028-02-29");
  assert.equal(upsertRecord(root, "action", { title: "没有日期" }).title, "没有日期");
  assert.equal(upsertRecord(root, "action", { title: "留空", due: "" }).due, "");
});

test("写入后回读复核:文件被别人换掉时报错,不返回一个假的成功", () => {
  const root = tmpRoot();
  upsertRecord(root, "thesis", { title: "第一条" });
  const file = path.join(root, "ledger", "thesis.json");
  // 模拟"另一个进程在我们落盘之后立刻把文件覆盖掉"(锁竞态最坏的后果 = 静默丢一条)。
  // ⚠️ 钩 renameSync 而不是 writeFileSync:atomicWrite 是 "写临时文件 → rename",
  //    在临时文件那步覆盖会被随后的 rename 盖回去,测不出东西来(第一版就是这么写的,假绿)。
  const orig = fs.renameSync;
  let armed = true;
  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((from: string, to: string) => {
    orig(from, to);
    if (armed && String(to) === file) {
      armed = false;
      fs.writeFileSync(file, JSON.stringify({ schema_version: 1, kind: "thesis", records: [] }));
    }
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => upsertRecord(root, "thesis", { title: "会被覆盖掉的一条" }),
      (e: unknown) => e instanceof LedgerError && e.code === "write_lost",
      "写丢了必须报出来",
    );
  } finally {
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
  }
  // 钩子撤掉后一切照常(证明上面确实是被钩子干掉的,不是模块被弄坏了)
  assert.ok(upsertRecord(root, "thesis", { title: "第三条" }).id);
});

test("🔴 注册期拒绝 Core 不认识的 format —— 未知 format 会被 ajv 静默忽略,等于那条字段没校验", () => {
  // 直接验守卫本身(注册期那条路要造一整份插件,成本高且测的是同一个函数)
  assertKnownFormats("t", { properties: { d: { type: "string", format: "date" } } });   // 认识 → 放行
  assert.throws(() => assertKnownFormats("t", { properties: { e: { format: "email" } } }), /不认识的 format/);
  // 藏在 anyOf / 数组深处也要找出来(垂类真实写法就是 anyOf)
  assert.throws(
    () => assertKnownFormats("t", { properties: { d: { anyOf: [{ maxLength: 0 }, { format: "uri" }] } } }),
    /不认识的 format/,
  );
  // 真实垂类的字段表必须全部认识(它现在就用了 format: "date")
  for (const [k, def] of Object.entries(kinds())) assertKnownFormats(k, def.properties);
  assert.ok(JSON.stringify(kinds()).includes('"format":"date"'), "前提:垂类确实在用 format(不用了就该删这条测试)");
});

test("🔴 台账文件损坏 ≠ 文件不存在 —— 当成不存在会让下一次新增把原文件覆盖掉", () => {
  const root = tmpRoot();
  upsertRecord(root, "thesis", { title: "本来就有的一条" });
  const file = path.join(root, "ledger", "thesis.json");
  fs.writeFileSync(file, "{ 这不是 JSON");

  // 读:必须报"损坏",不能报成"空台账"(那是伪装成"你本来就没记过东西")
  assert.throws(() => listRecords(root, "thesis"), (e: unknown) => e instanceof LedgerError && e.code === "corrupt");
  // 写:同样要拒,绝不能把只含新记录的文件盖上去
  assert.throws(
    () => upsertRecord(root, "thesis", { title: "新的一条" }),
    (e: unknown) => e instanceof LedgerError && e.code === "corrupt",
  );
  assert.equal(fs.readFileSync(file, "utf8"), "{ 这不是 JSON", "原文件必须原样留着,等人工处理");
});

test("回读复核比的是**整条内容**,不只是 id 与时间戳(并发覆盖会保留同一个 id)", () => {
  const root = tmpRoot();
  const first = upsertRecord(root, "thesis", { title: "甲写的" });
  const file = path.join(root, "ledger", "thesis.json");
  // 模拟:我们写完之后,别人用**同一个 id、同一个 updated_at**把字段换成了自己的版本
  const orig = fs.renameSync;
  let armed = true;
  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((from: string, to: string) => {
    orig(from, to);
    if (armed && String(to) === file) {
      armed = false;
      const d = JSON.parse(fs.readFileSync(file, "utf8")) as { records: Record<string, unknown>[] };
      const hit = d.records.find((r) => r.id === first.id)!;
      hit.title = "乙覆盖的";                    // id 与 updated_at 都不动,只换内容
      fs.writeFileSync(file, JSON.stringify(d));
    }
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => upsertRecord(root, "thesis", { id: first.id, title: "甲的第二版" }),
      (e: unknown) => e instanceof LedgerError && e.code === "write_lost",
      "内容被换掉了就不能报成功",
    );
  } finally {
    (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = orig;
  }
});

test("🔴 持仓成本允许为负 —— 分红 / 送转吃够了之后是真实存在的状态", () => {
  const root = tmpRoot();
  // 上游 Vibe-Research issue #3：用户拿这个来报的。卡 minimum:0 的后果是这类持仓录不进来，
  // 而盈亏本来就按 (现价 − 成本) × 股数 算，成本为负照样算得对。
  const r = upsertRecord(root, "position", { symbol: "600519", name: "负成本", shares: 100, cost: -1.5 });
  assert.equal(r.cost, -1.5);
  // 股数仍不许为负(做空是另一回事,没有证据说要支持,不顺手放开)
  assert.throws(() => upsertRecord(root, "position", { symbol: "600519", shares: -1, cost: 10 }), /shares/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("自选与持仓同时接受 A 股 / 港股 / 美股的规范代码", () => {
  const root = tmpRoot();
  for (const [i, symbol] of ["600519", "00700.HK", "AAPL", "BRK.B", "USB"].entries()) {
    const pos = upsertRecord(root, "position", { symbol, shares: i + 1, cost: 10 });
    const watch = upsertRecord(root, "watch", { symbol });
    assert.equal(pos.symbol, symbol);
    assert.equal(watch.symbol, symbol);
  }
  for (const bad of [
    "hk00700", "700.HK", "aapl", "600519.SH", "../AAPL", "AAPL/../../x",
  ]) {
    assert.throws(() => upsertRecord(root, "watch", { symbol: bad }), /symbol/, `非规范形应拒绝:${bad}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("研究记录能完整保存多阶段回测或辩论报告", () => {
  const root = tmpRoot();
  const body = "完整报告。".repeat(5_000); // 明显超过旧的 2 万字限制
  const saved = upsertRecord(root, "note", { category: "debate", title: "长报告", body });
  assert.equal(saved.body, body);
  fs.rmSync(root, { recursive: true, force: true });
});
