const assert = require("assert");
const {
  createPaovrdTask,
  shouldUsePaovrd,
  runPaovrd,
  approvePendingAction,
  resumeWithUserInput
} = require("../runtime/agent-runtime-v3");

const readTool = { id: "web_search", name: "Web search", description: "Search current public information.", status: "ready", executable: true, risk: "read", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } };
const writeTool = { id: "artifact_generate", name: "Generate artifact", description: "Create a workspace artifact.", status: "ready", executable: true, risk: "write", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } };

function scriptedModel(script) {
  const calls = [];
  return {
    calls,
    callModel: async ({ phase }) => {
      calls.push(phase);
      const values = script[phase];
      if (!values?.length) throw new Error("Unexpected model phase: " + phase);
      return values.shift();
    }
  };
}

(async () => {
  assert(shouldUsePaovrd("请联网搜索今天的公开资料"));
  assert(!shouldUsePaovrd("你好，在吗"));

  const persistence = [];
  const firstModel = scriptedModel({
    plan: [JSON.stringify({ summary: "检索并核实", steps: ["搜索", "验证"], completionCriteria: ["有公开来源"] })],
    act: [JSON.stringify({ type: "tool", toolId: "web_search", input: { query: "TONA runtime" }, rationale: "需要当前公开资料" }), JSON.stringify({ type: "finish", rationale: "已有来源" })],
    verify: [JSON.stringify({ passed: true, summary: "有来源", gaps: [], next: "deliver", question: "" })],
    deliver: ["结论：已根据公开资料完成。\n来源：https://example.com/source"]
  });
  const task = createPaovrdTask({ goal: "搜索 TONA runtime 的公开资料", workspaceId: "ws_test" });
  const result = await runPaovrd(task, {
    tools: [readTool], callModel: firstModel.callModel,
    executeTool: async (toolId, input) => ({ invocationId: "inv_search", toolId, data: { query: input.query, sources: [{ title: "Source", url: "https://example.com/source" }] }, artifactIds: [] }),
    persist: (value) => persistence.push(JSON.parse(JSON.stringify(value)))
  });
  assert.equal(result.status, "completed");
  assert.equal(task.observations[0].status, "success");
  assert(task.finalAnswer.includes("https://example.com/source"));
  assert.deepEqual(firstModel.calls, ["plan", "act", "act", "verify", "deliver"]);
  assert(persistence.some((item) => item.phase === "observe"));

  const writeModel = scriptedModel({
    plan: [JSON.stringify({ summary: "生成产物", steps: ["创建文件", "验证"], completionCriteria: ["返回 artifact id"] })],
    act: [JSON.stringify({ type: "tool", toolId: "artifact_generate", input: { name: "report" }, rationale: "用户要求可下载产物" }), JSON.stringify({ type: "finish", rationale: "产物已创建" })],
    verify: [JSON.stringify({ passed: true, summary: "产物存在", gaps: [], next: "deliver", question: "" })],
    deliver: ["文件已创建：art_report1234"]
  });
  const writeTask = createPaovrdTask({ goal: "生成报告文件", workspaceId: "ws_test" });
  const paused = await runPaovrd(writeTask, { tools: [writeTool], callModel: writeModel.callModel, executeTool: async () => { throw new Error("must not execute before approval"); }, persist: () => {} });
  assert.equal(paused.status, "waiting_confirmation");
  assert.equal(writeTask.metrics.toolCalls, 0);
  assert(approvePendingAction(writeTask));
  const resumed = await runPaovrd(writeTask, {
    tools: [writeTool], callModel: writeModel.callModel,
    executeTool: async () => ({ invocationId: "inv_write", data: { file: { file_id: "file_report1234" } }, artifactIds: ["art_report1234"] }), persist: () => {}
  });
  assert.equal(resumed.status, "completed");
  assert.equal(writeTask.metrics.toolCalls, 1);
  assert.equal(writeTask.observations[0].artifactIds[0], "art_report1234");

  const questionModel = scriptedModel({
    plan: [JSON.stringify({ summary: "需要范围", steps: ["确认范围"], completionCriteria: ["范围明确"] })],
    act: [JSON.stringify({ type: "ask_user", question: "请提供需要分析的文件。", rationale: "缺少输入" }), JSON.stringify({ type: "finish", rationale: "用户已补充" })],
    verify: [JSON.stringify({ passed: true, summary: "输入完整", gaps: [], next: "deliver", question: "" })],
    deliver: ["已收到并完成。"]
  });
  const questionTask = createPaovrdTask({ goal: "分析文件" });
  const waiting = await runPaovrd(questionTask, { tools: [readTool], callModel: questionModel.callModel, executeTool: async () => ({}), persist: () => {} });
  assert.equal(waiting.status, "waiting_input");
  assert(resumeWithUserInput(questionTask, "文件是 file_123456789012"));
  const afterInput = await runPaovrd(questionTask, { tools: [readTool], callModel: questionModel.callModel, executeTool: async () => ({}), persist: () => {} });
  assert.equal(afterInput.status, "completed");
  assert.equal(questionTask.userInputs.length, 1);

  console.log("PAOVRD Runtime v3 test passed: planning, action, observation, verification, delivery, write confirmation, persistence, and user-input resume.");
})().catch((error) => { console.error(error); process.exit(1); });
