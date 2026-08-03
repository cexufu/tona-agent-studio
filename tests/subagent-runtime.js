const assert = require("assert");
const { SubagentScheduler, a2aRequest, createBudgetPool, intersect } = require("../runtime/subagent-runtime");

(async () => {
  assert.deepEqual(intersect(["web.search", "code.python.run"], ["code.python.run", "file.read"], ["code.python.run"]), ["code.python.run"]);
  const parent = { id: "orchestrator", toolPolicy: { allowedToolIds: ["web.search", "code.python.run"] }, delegationPolicy: { callableAgentIds: ["data"], maxDepth: 1, maxConcurrentChildren: 2, maxTotalChildren: 4 } };
  const child = { id: "data", toolPolicy: { allowedToolIds: ["code.python.run", "file.read"] }, delegationPolicy: { callableByAgentIds: ["orchestrator"] } };
  const request = a2aRequest({ fromAgentId: parent.id, toAgentId: child.id, intent: "analyze", payload: { artifactIds: ["art_1"] }, outputSchema: { type: "object" } });
  const scheduler = new SubagentScheduler(); const ledger = []; const pool = createBudgetPool({ maxSubagents: 2 });
  const result = await scheduler.run(request, {
    parentAgent: parent, childAgent: child, workspaceId: "ws_test", budgetPool: pool, taskToolIds: ["code.python.run"], onTask: (task) => ledger.push({ status: task.status }),
    runChild: async ({ effectiveToolIds }) => ({ status: "completed", output: { ok: true, tools: effectiveToolIds }, metrics: { modelCalls: 1 } })
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output.tools, ["code.python.run"]);
  assert.equal(pool.usedSubagents, 1);
  assert.deepEqual(ledger.map((item) => item.status), ["queued", "running", "completed"]);
  const cached = await scheduler.run(request, { parentAgent: parent, childAgent: child, workspaceId: "ws_test", budgetPool: pool, runChild: async () => { throw new Error("should not rerun"); } });
  assert.equal(cached.id, result.id);
  const forbidden = a2aRequest({ fromAgentId: parent.id, toAgentId: "writer", intent: "write" });
  await assert.rejects(scheduler.run(forbidden, { parentAgent: parent, childAgent: { ...child, id: "writer" }, workspaceId: "ws_test", budgetPool: pool, runChild: async () => ({}) }), (error) => error.code === "SUBAGENT_TARGET_DENIED");
  console.log("SubAgent Runtime test passed: A2A, visibility, tool intersection, shared budget, lifecycle ledger, and idempotency.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
