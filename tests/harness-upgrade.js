const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeToolContract } = require("../runtime/tool-contract");
const { pythonToolDefinition } = require("../runtime/python-runtime");
const { WorkspaceFileStore } = require("../runtime/workspace-files");
const { skillScore, selectApplicableSkills } = require("../runtime/skill-runtime");
const { createPaovrdTask, runPaovrd } = require("../runtime/agent-runtime-v3");

(async () => {
  const manifest = normalizeToolContract(pythonToolDefinition);
  assert.equal(manifest.id, "code.python.run");
  assert.equal(manifest.policy.operationRisk, "compute");
  assert.equal(manifest.policy.sideEffectScope, "workspace");
  assert.equal(manifest.policy.network, "deny");
  assert.equal(manifest.policy.confirmation, "never");
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert(serverSource.includes("[A-Za-z0-9_.-]{1,80}"), "Runtime route must accept dotted stable Tool IDs.");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tona-harness-test-"));
  try {
    const store = new WorkspaceFileStore(root, "workspace_test");
    const saved = store.save({ name: "input.csv", buffer: Buffer.from("a\n1\n"), artifact: true });
    assert.equal(store.findArtifact(saved.artifact_id).file_id, saved.file_id);
    assert.throws(() => store.findArtifact("art_missing_artifact"), /not found/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const skill = {
    id: "analysis",
    name: "数据分析",
    status: "published",
    enabled: true,
    whenToUse: ["分析 CSV"],
    whenNotToUse: ["只做简单加法"],
    triggerExamples: [],
    steps: [{ agentId: "parent", task: "analyze" }]
  };
  const agent = { id: "parent", skillBindings: [{ skillId: "analysis", enabled: true }] };
  assert(skillScore(skill, "请分析 CSV 文件") > 0);
  assert.equal(skillScore(skill, "只做简单加法"), 0);
  assert.equal(selectApplicableSkills({ workflows: [{ ...skill, status: "draft" }], agent, text: "分析 CSV" }).length, 0);

  const task = createPaovrdTask({ goal: "委派分析并交付", agentId: "parent", workspaceId: "workspace_test" });
  const modelResponses = [
    { summary: "delegate", steps: ["delegate", "deliver"], completionCriteria: ["child completed"] },
    { type: "delegate", agentId: "child", goal: "分析输入", payload: { input: "x" }, outputSchema: { type: "object" }, rationale: "specialist" },
    { type: "finish", rationale: "child result received" },
    { passed: true, summary: "done", gaps: [], next: "deliver", question: "" },
    "已完成委派分析。"
  ];
  let delegated = 0;
  const outcome = await runPaovrd(task, {
    tools: [],
    agents: [{ id: "child", name: "分析侠", role: "analysis", toolPolicy: { allowedToolIds: [] } }],
    callModel: async () => ({ content: typeof modelResponses[0] === "string" ? modelResponses.shift() : JSON.stringify(modelResponses.shift()) }),
    delegate: async (action) => {
      delegated += 1;
      assert.equal(action.agentId, "child");
      return { id: "subrun_test", type: "subagent", status: "completed", output: { summary: "analysis done" } };
    },
    persist() {}
  });
  assert.equal(outcome.status, "completed");
  assert.equal(delegated, 1);
  assert.equal(task.metrics.subagents, 1);
  assert(task.observations.some((item) => item.toolId === "subagent.run" && item.status === "success"));

  console.log("Harness upgrade test passed: Tool contract, artifact lookup, Skill lifecycle, and PAOVRD Subagent delegation.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});