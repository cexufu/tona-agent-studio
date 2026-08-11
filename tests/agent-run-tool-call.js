const assert = require("assert");
const { createPaovrdTask, runPaovrd, resumeWithUserInput } = require("../runtime/agent-runtime-v3");
const { RuntimeToolError } = require("../runtime/runtime-v2");

function model(responses) {
  let index = 0;
  return async () => responses[Math.min(index++, responses.length - 1)];
}

(async () => {
  const readTool = { id: "probe", name: "Probe", description: "probe", status: "ready", executable: true, risk: "read", inputSchema: { type: "object" }, policy: { operationRisk: "read", sideEffectScope: "none" } };
  const task = createPaovrdTask({ goal: "probe once", workspaceId: "ws_test" });
  let calls = 0;
  const result = await runPaovrd(task, {
    tools: [readTool], persist: () => {},
    callModel: model([
      '{"summary":"probe","steps":["probe"],"completionCriteria":["evidence"]}',
      '{"type":"tool","toolId":"probe","input":{},"rationale":"need evidence"}',
      '{"type":"finish","rationale":"done"}',
      '{"passed":true,"summary":"verified","gaps":[],"next":"deliver","question":""}',
      "done"
    ]),
    executeTool: async (_toolId, _input, execution) => {
      calls += 1;
      assert.match(execution.traceId, /^trc_/);
      assert.match(execution.stepId, /_step_001$/);
      return { invocationId: "inv_probe", traceId: execution.traceId, artifactIds: [], quality: [{ id: "shape", ok: true }], meta: { attempts: 1, durationMs: 4, cached: false }, data: { ok: true } };
    }
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
  assert.match(task.run.runId, /^run_/);
  assert.equal(task.checkpoint.status, "completed");
  assert.equal(task.steps[0].receipt.attempts, 1);
  assert.equal(task.observations[0].quality[0].ok, true);

  const denied = createPaovrdTask({ goal: "denied", workspaceId: "ws_test" });
  let deniedCalls = 0;
  const deniedResult = await runPaovrd(denied, {
    tools: [readTool], persist: () => {},
    callModel: model([
      '{"summary":"probe","steps":["probe"],"completionCriteria":["evidence"]}',
      '{"type":"tool","toolId":"probe","input":{},"rationale":"need evidence"}',
      '{"type":"tool","toolId":"probe","input":{},"rationale":"retry"}',
      '{"type":"finish","rationale":"blocked"}',
      '{"passed":false,"summary":"blocked","gaps":["permission"],"next":"ask_user","question":"grant access"}'
    ]),
    executeTool: async () => {
      deniedCalls += 1;
      throw new RuntimeToolError("TOOL_PERMISSION_DENIED", "denied", { category: "permission", retryable: false, status: 403 });
    }
  });
  assert.equal(deniedCalls, 1, "non-retryable errors must not be executed twice");
  assert.equal(deniedResult.status, "waiting_input");
  assert.equal(denied.checkpoint.stoppedAt, "verify");
  assert.match(denied.checkpoint.resume, /回复/);
  assert.equal(resumeWithUserInput(denied, "granted"), true);
  assert.equal(denied.run.checkpoint, null);

  console.log("Agent Run and Tool Call test passed: run/step trace, receipts, retry discipline, checkpoints, and resume.");
})().catch((error) => { console.error(error); process.exit(1); });
