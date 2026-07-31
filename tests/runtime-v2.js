const assert = require("assert");
const { TOOL_CATALOG, executeTool } = require("../runtime/tool-runtime");

const workspaceContext = { workspaceId: "ws_runtime_v2", authorizedWorkspaceId: "ws_runtime_v2" };

(async () => {
  assert(TOOL_CATALOG.length >= 8);
  for (const tool of TOOL_CATALOG) {
    assert(tool.inputSchema, `${tool.id} must publish an input schema`);
    assert(tool.outputSchema, `${tool.id} must publish an output schema`);
    assert(["read", "write", "execute"].includes(tool.risk), `${tool.id} must publish a risk level`);
    assert(tool.policy?.timeoutMs > 0, `${tool.id} must publish timeout policy`);
    assert(tool.policy?.rateLimit?.maxCalls > 0, `${tool.id} must publish rate policy`);
  }

  await assert.rejects(
    () => executeTool("math_calculate", { expression: "2 + 2" }, {}),
    (error) => error.code === "TOOL_WORKSPACE_REQUIRED" && error.category === "permission"
  );
  await assert.rejects(
    () => executeTool("math_calculate", { expression: "2 + 2" }, { workspaceId: "ws_one", authorizedWorkspaceId: "ws_two" }),
    (error) => error.code === "TOOL_WORKSPACE_DENIED"
  );
  await assert.rejects(
    () => executeTool("math_calculate", { expression: "" }, workspaceContext),
    (error) => error.code === "TOOL_SCHEMA_INVALID" && error.category === "validation"
  );

  const audit = [];
  const math = await executeTool("math_calculate", { expression: "2 + 3 * (4 + 1)" }, { ...workspaceContext, idempotencyKey: "math-1", audit: (event) => audit.push(event) });
  assert.equal(math.protocolVersion, "2.0");
  assert.equal(math.resultType, "tool_result");
  assert.equal(math.data.value, 17);
  assert.equal(math.workspaceId, "ws_runtime_v2");
  assert.deepEqual(math.artifactIds, []);
  assert.equal(audit.at(-1).status, "success");
  assert(!JSON.stringify(audit).includes("2 + 3"), "audit events must not persist tool input");

  const cached = await executeTool("math_calculate", { expression: "999" }, { ...workspaceContext, idempotencyKey: "math-1" });
  assert.equal(cached.meta.cached, true);
  assert.equal(cached.data.value, 17);

  const now = await executeTool("datetime_now", { timeZone: "Asia/Shanghai" }, { ...workspaceContext, clock: () => Date.parse("2026-07-31T12:34:56Z") });
  assert.equal(now.data.local, "2026-07-31T20:34:56");
  assert.equal(now.data.offset, "+08:00");

  const difference = await executeTool("datetime_calculate", { operation: "difference", date: "2026-07-01T00:00:00Z", otherDate: "2026-07-31T12:00:00Z", unit: "day" }, workspaceContext);
  assert.equal(difference.data.value, 30.5);

  const converted = await executeTool("unit_convert", { value: 1, from: "mi", to: "km" }, workspaceContext);
  assert.equal(converted.data.value, 1.609344);

  const statistics = await executeTool("statistics_basic", { values: [1, 2, 3, 4] }, workspaceContext);
  assert.equal(statistics.data.mean, 2.5);
  assert.equal(statistics.data.median, 2.5);

  const table = await executeTool("table_transform", {
    format: "csv",
    data: "team,score\nA,10\nB,7\nA,5",
    operations: [
      { type: "filter", field: "team", operator: "eq", value: "A" },
      { type: "aggregate", groupBy: "team", metrics: [{ field: "score", op: "sum", as: "total" }] }
    ]
  }, workspaceContext);
  assert.deepEqual(table.data.rows, [{ team: "A", total: 15 }]);
  assert.equal(table.data.valid, true);

  const validation = await executeTool("table_transform", {
    format: "rows",
    data: [{ id: 1 }, { id: 2, owner: "Lin" }],
    operations: [{ type: "validate", required: ["owner"] }]
  }, workspaceContext);
  assert.equal(validation.data.valid, false);
  assert.deepEqual(validation.data.validationErrors[0], { row: 0, field: "owner", code: "required" });

  await assert.rejects(
    () => executeTool("table_transform", { format: "rows", data: [{ id: 1 }], operations: [{ type: "unknown" }] }, workspaceContext),
    (error) => error.code === "INVALID_TABLE_OPERATION" && error.category === "validation"
  );

  console.log("Runtime v2 test passed: schemas, workspace permissions, result envelopes, audit safety, idempotency, date/math/unit/statistics/table tools.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
