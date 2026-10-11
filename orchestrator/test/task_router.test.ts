import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskRouteError, TaskRouter, makeResearchTask, parseResearchTask,
  type DeterministicOperation, type ResearchTask, type TaskInputRef,
} from "../src/task_router.ts";

function defaultOperation(kind: ResearchTask["kind"]): DeterministicOperation | null {
  if (kind === "browse_data") return { kind, queryId: "overview", args: { symbol: "300308" } };
  if (kind === "refresh_registered_data") return { kind, endpointIds: ["quote"], args: { symbol: "300308" } };
  if (kind === "calculate") return { kind, functionId: "pe_ttm", args: { price: 100, eps: 2 } };
  return null;
}

function task(overrides: Partial<ResearchTask> = {}): ResearchTask {
  const kind = overrides.kind ?? "locate_passages";
  const { schemaVersion: _schemaVersion, ...draftOverrides } = overrides;
  return makeResearchTask({
    id: "task-20260904-001", kind, requestedMode: "auto",
    objective: "总结本周已归档证据的变化",
    evidenceScope: kind === "refresh_registered_data" ? "registered_refresh" : "existing",
    workflow: "single_step", inputRefs: [{ kind: "evidence", id: "bundle-current" }],
    outputFormat: "text", operation: defaultOperation(kind), ...draftOverrides,
  });
}

const ALLOWED_OPERATIONS = new Set(["browse_data:overview", "refresh_registered_data:quote", "calculate:pe_ttm"]);

function operationKey(operation: DeterministicOperation): string {
  if (operation.kind === "browse_data") return `${operation.kind}:${operation.queryId}`;
  if (operation.kind === "calculate") return `${operation.kind}:${operation.functionId}`;
  return `${operation.kind}:${operation.endpointIds.join(",")}`;
}

function validateOperationArgs(operation: DeterministicOperation): void {
  const keys = Object.keys(operation.args).sort();
  if (operation.kind === "calculate") {
    if (keys.join(",") !== "eps,price" || typeof operation.args.price !== "number" ||
        typeof operation.args.eps !== "number") throw new Error("invalid calculate args");
    return;
  }
  if (keys.join(",") !== "symbol" || typeof operation.args.symbol !== "string" ||
      !/^\d{6}$/.test(operation.args.symbol)) throw new Error("invalid data args");
}

function router(options: {
  statuses?: Readonly<Record<string, "ready" | "missing">>;
  contentModes?: Readonly<Record<string, "text" | "non_text">>;
  seenTasks?: ResearchTask[];
} = {}): TaskRouter {
  return new TaskRouter({
    materials: {
      async resolve(value, ref) {
        options.seenTasks?.push(value);
        const key = `${ref.kind}:${ref.id}`;
        const status = options.statuses?.[key] ?? "ready";
        return status === "ready" ? {
          ...ref, status, revision: `rev-${ref.id}`, contentMode: options.contentModes?.[key] ?? "text",
          contentChars: options.contentModes?.[key] === "non_text" ? 0 : 2_000,
        } : { ...ref, status };
      },
    },
    operations: {
      async validate(_value, operation) {
        if (!ALLOWED_OPERATIONS.has(operationKey(operation))) throw new Error("unknown operation");
        validateOperationArgs(operation);
      },
    },
  });
}

async function route(overrides: Partial<ResearchTask> = {}, statuses?: Readonly<Record<string, "ready" | "missing">>,
  contentModes?: Readonly<Record<string, "text" | "non_text">>) {
  return router({ statuses, contentModes }).route(task(overrides));
}

test("Auto：三种确定性任务经注册表验证且一律不调模型", async () => {
  for (const kind of ["browse_data", "refresh_registered_data", "calculate"] as const) {
    const result = await route({ kind, operation: defaultOperation(kind) });
    assert.equal(result.target, "deterministic", kind);
    assert.equal(result.engineFamily, "none", kind);
    assert.equal(result.reasonCode, "deterministic_task", kind);
    assert.equal(result.materialState, "not_needed", kind);
    assert.equal(result.task.operation?.kind, kind);
  }
});

test("Auto：服务端确认材料完备的有界任务走 Quick，默认由 Agent 执行", async () => {
  const result = await route({ kind: "locate_passages" });
  assert.equal(result.target, "quick");
  assert.equal(result.engineFamily, "api_agent", "没指明来源家族时按模型 API 的 Agent 循环记");
  assert.equal(result.reasonCode, "prepared_bounded_task");
  assert.equal(result.materialState, "ready");
  assert.match(result.materials.inputs[0]?.revision ?? "", /^rev-/);
});

test("直连模式的有界任务才使用 direct_api", async () => {
  const result = await router().route(task({ kind: "locate_passages" }), undefined, "direct");
  assert.equal(result.target, "quick");
  assert.equal(result.engineFamily, "direct_api");
  assert.equal(result.executionMode, "direct");
});

test("本机订阅 Agent 的 Quick / Deep 路由如实标记 local_agent，并绑定进路由指纹", async () => {
  const fingerprint = "a".repeat(64);
  const quick = await router().route(task({ kind: "locate_passages" }), undefined, "agent", fingerprint, "local_agent");
  const deep = await router().route(task({ kind: "deep_research", requestedMode: "deep",
    evidenceScope: "open_discovery", workflow: "multi_step", outputFormat: "document" }),
  undefined, "agent", fingerprint, "local_agent");
  assert.equal(quick.engineFamily, "local_agent");
  assert.equal(deep.engineFamily, "local_agent");
  const api = await router().route(task({ kind: "locate_passages" }), undefined, "agent", fingerprint, "api_agent");
  assert.equal(api.engineFamily, "api_agent");
  assert.notEqual(quick.routeFingerprint, api.routeFingerprint, "执行保障家族变化必须让两段式路由失效");
});

test("Auto 深研意图由服务端判定，不被普通子串误触发", async () => {
  const deep = await route({ kind: "locate_passages", objective: "深入分析并核验最新数据" });
  assert.equal(deep.target, "deep");
  assert.equal(deep.reasonCode, "explicit_deep");

  const locate = await route({ kind: "locate_passages", objective: "找出报告中对完整六阶段研究的描述" });
  assert.equal(locate.target, "quick");
  assert.equal(locate.reasonCode, "prepared_bounded_task");
});

test("尚未接入 Quick 执行器的通用任务先走 Deep，显式 Quick 则拒绝", async () => {
  for (const kind of [
    "summarize_materials", "compare_entities", "answer_from_materials",
    "explain_metric", "extract_fields", "translate_material",
  ] as const) {
    const automatic = await route({ kind });
    assert.equal(automatic.target, "deep", kind);
    await assert.rejects(() => route({ kind, requestedMode: "quick" }),
      (error: unknown) => error instanceof TaskRouteError && error.code === "quick_not_eligible");
  }
});

test("Quick 的文本格式与 16 份材料上限在路由阶段统一执行", async () => {
  const seventeenRefs: TaskInputRef[] = Array.from({ length: 17 }, (_, index) => ({
    kind: "document", id: `doc-${index + 1}`,
  }));
  for (const overrides of [
    { kind: "locate_passages" as const, outputFormat: "table" as const },
    { kind: "locate_passages" as const, inputRefs: seventeenRefs },
  ]) {
    assert.equal((await route(overrides)).target, "deep");
    await assert.rejects(() => route({ ...overrides, requestedMode: "quick" }),
      (error: unknown) => error instanceof TaskRouteError && error.code === "quick_not_eligible");
  }
  assert.equal((await route({
    kind: "locate_passages",
    inputRefs: seventeenRefs.slice(0, 16),
  })).target, "quick");
});

test("Quick 的 4 万字符总量上限在路由阶段执行并进入指纹", async () => {
  const makeRouter = (contentChars: number) => new TaskRouter({
    materials: {
      async resolve(_task, ref) {
        return { ...ref, status: "ready" as const, revision: "rev-fixed", contentMode: "text" as const, contentChars };
      },
    },
    operations: { async validate() { throw new Error("模型任务不应验证 operation"); } },
  });
  const input = task({ kind: "locate_passages" });
  const eligible = await makeRouter(40_000).route(input);
  const oversized = await makeRouter(40_001).route(input);
  assert.equal(eligible.target, "quick");
  assert.equal(oversized.target, "deep");
  assert.notEqual(eligible.routeFingerprint, oversized.routeFingerprint);
  await assert.rejects(
    () => makeRouter(40_001).route({ ...input, requestedMode: "quick" }),
    (error: unknown) => error instanceof TaskRouteError && error.code === "quick_not_eligible",
  );
});

test("非文本材料在路由阶段不能进入 Quick", async () => {
  const contentModes = { "evidence:bundle-current": "non_text" as const };
  assert.equal((await route({ kind: "locate_passages" }, undefined, contentModes)).target, "deep");
  await assert.rejects(
    () => route({ kind: "locate_passages", requestedMode: "quick" }, undefined, contentModes),
    (error: unknown) => error instanceof TaskRouteError && error.code === "quick_not_eligible",
  );
});

test("Auto：材料缺失/部分、开放取证或多步调查走 Deep", async () => {
  const twoRefs: TaskInputRef[] = [
    { kind: "evidence", id: "bundle-current" }, { kind: "report", id: "report-prior" },
  ];
  const cases: Array<[Partial<ResearchTask>, Readonly<Record<string, "ready" | "missing">> | undefined, string]> = [
    [{ inputRefs: twoRefs }, { "report:report-prior": "missing" }, "materials_not_ready"],
    [{}, { "evidence:bundle-current": "missing" }, "materials_not_ready"],
    [{ evidenceScope: "open_discovery" }, undefined, "open_evidence_discovery"],
    [{ workflow: "multi_step" }, undefined, "multi_step_investigation"],
    [{ kind: "deep_research", operation: null }, undefined, "deep_research_task"],
  ];
  for (const [overrides, statuses, reasonCode] of cases) {
    const result = await route(overrides, statuses);
    assert.equal(result.target, "deep");
    assert.equal(result.reasonCode, reasonCode);
  }
});

test("显式 Deep 可以升级；显式 Quick 不适用时拒绝且不静默升级", async () => {
  assert.equal((await route({ requestedMode: "deep" })).reasonCode, "explicit_deep");
  const cases: Array<[Partial<ResearchTask>, Readonly<Record<string, "ready" | "missing">> | undefined]> = [
    [{ requestedMode: "quick" }, { "evidence:bundle-current": "missing" }],
    [{ requestedMode: "quick", evidenceScope: "open_discovery" }, undefined],
    [{ requestedMode: "quick", workflow: "multi_step" }, undefined],
    [{ requestedMode: "quick", kind: "deep_research", operation: null }, undefined],
  ];
  for (const [overrides, statuses] of cases) {
    await assert.rejects(() => route(overrides, statuses),
      (error: unknown) => error instanceof TaskRouteError && error.code === "quick_not_eligible");
  }
});

test("HTTP 原始任务会重新解析，不能绕构造器或夹带敏感配置", async () => {
  const value = task();
  for (const forged of [
    { ...value, schemaVersion: 2 }, { ...value, provider: "evil" },
    { ...value, requestedMode: "turbo" },
  ]) {
    await assert.rejects(() => router().route(forged),
      (error: unknown) => error instanceof TaskRouteError && error.code === "invalid_task");
  }
});

test("每次路由都按完整任务重新解析材料，不复用同 id 的旧授权结果", async () => {
  const seen: ResearchTask[] = [];
  const instance = router({ seenTasks: seen });
  const first = task({ objective: "只做摘要" });
  const firstDecision = await instance.route(first);
  const secondDecision = await instance.route({ ...first, objective: "改成比较并重新核权", kind: "compare_entities" });
  assert.deepEqual(seen.map((item) => item.objective), ["只做摘要", "改成比较并重新核权"]);
  assert.notEqual(seen[0], seen[1]);
  assert.match(firstDecision.routeFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(firstDecision.routeFingerprint, secondDecision.routeFingerprint);
});

test("材料解析器不能改引用、伪造 ready 版本或泄露额外字段", async () => {
  const base = task();
  const badResolvers = [
    async () => ({ kind: "report" as const, id: "other", status: "ready" as const, revision: "rev-1" }),
    async (value: ResearchTask, ref: TaskInputRef) => ({ ...ref, status: "ready" as const }),
    async (value: ResearchTask, ref: TaskInputRef) => ({ ...ref, status: "missing" as const, revision: "rev-secret" }),
    async (value: ResearchTask, ref: TaskInputRef) => ({ ...ref, status: "ready" as const, revision: "rev-1", path: "/secret" }),
  ];
  for (const resolve of badResolvers) {
    const instance = new TaskRouter({ materials: { resolve }, operations: { async validate() {} } });
    await assert.rejects(() => instance.route(base),
      (error: unknown) => error instanceof TaskRouteError && error.code === "invalid_material_resolution");
  }
});

test("确定性 operation 必须匹配 kind、JSON 安全并被服务端注册表端口接受", async () => {
  const base = task({ kind: "calculate", operation: defaultOperation("calculate") });
  for (const forged of [
    { ...base, operation: null },
    { ...base, operation: { kind: "browse_data", queryId: "overview", args: {} } },
    { ...base, operation: { kind: "calculate", functionId: "../../escape", args: {} } },
    { ...base, operation: { kind: "calculate", functionId: "pe_ttm", args: { value: Infinity } } },
  ]) assert.throws(() => parseResearchTask(forged), /operation/);
  const unknown = task({ kind: "calculate", operation: { kind: "calculate", functionId: "unknown", args: {} } });
  await assert.rejects(() => router().route(unknown),
    (error: unknown) => error instanceof TaskRouteError && error.code === "operation_not_available");
  const badKnownArgs = task({
    kind: "calculate", operation: { kind: "calculate", functionId: "pe_ttm", args: { price: 100 } },
  });
  await assert.rejects(() => router().route(badKnownArgs),
    (error: unknown) => error instanceof TaskRouteError && error.code === "operation_not_available");
  assert.throws(() => parseResearchTask({ ...task(), operation: defaultOperation("calculate") }), /模型任务/);
});

test("任务与操作深冻结，协议不夹带 provider / model / apiKey / engine", () => {
  const value = task({ kind: "calculate", operation: defaultOperation("calculate") });
  for (const forbidden of ["provider", "model", "apiKey", "engine", "materialState"]) {
    assert.ok(!(forbidden in (value as unknown as Record<string, unknown>)), forbidden);
  }
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.inputRefs));
  assert.ok(Object.isFrozen(value.operation));
  assert.ok(Object.isFrozen(value.operation?.args));
});

test("构造器拒绝空目标、不安全引用、重复引用和契约外字段", () => {
  assert.throws(() => task({ objective: "   " }), /objective/);
  assert.throws(() => task({ id: "../../escape" }), /id/);
  assert.throws(() => task({ inputRefs: [{ kind: "document", id: "../../secret" }] }), /inputRefs/);
  assert.throws(() => task({ inputRefs: [
    { kind: "report", id: "weekly" }, { kind: "report", id: "weekly" },
  ] }), /重复引用/);
  assert.throws(() => parseResearchTask({ ...task(), model: "gpt-hidden" }), /契约外字段/);
});
