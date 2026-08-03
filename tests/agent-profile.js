const assert = require("assert");
const {
  normalizeAgentProfile,
  filterToolsForAgent,
  filterCapabilityPlan,
  runtimeBudget
} = require("../runtime/agent-profile");
const { prepareAgentToolResult } = require("../runtime/agent-tools");
const { rememberHumanMessage, fiveLayerMemoryContext } = require("../runtime/memory-runtime");

const tools = [
  { id: "math_calculate", status: "ready" },
  { id: "web_search", status: "ready" },
  { id: "feishu_document_create", status: "ready" },
  { id: "python_runtime", status: "planned" }
];
const workflows = [
  { id: "system_skill", system: true, steps: [] },
  { id: "owned_skill", steps: [{ agentId: "agent_a" }] },
  { id: "other_skill", steps: [{ agentId: "agent_b" }] }
];

const migrated = normalizeAgentProfile(
  { id: "agent_a", skills: ["legacy"], runtimePolicy: { maxReplans: 0 } },
  { workflows, toolCatalog: tools, bots: [{ id: "bot_a", agentId: "agent_a", enabled: true }] }
);
assert.deepEqual(migrated.skillBindings.map((item) => item.skillId), ["system_skill", "owned_skill"]);
assert.deepEqual(migrated.toolPolicy.allowedToolIds, ["math_calculate", "web_search", "feishu_document_create"]);
assert.deepEqual(migrated.channelBindings, [{ type: "feishu", botId: "bot_a", enabled: true }]);
assert.equal(migrated.runtimePolicy.maxReplans, 0);

const restricted = normalizeAgentProfile({
  id: "agent_a",
  skillBindings: [],
  toolPolicy: { allowedToolIds: ["web_search"] },
  runtimePolicy: { maxSteps: 4, maxToolCalls: 2, maxModelCalls: 5, maxReplans: 1, maxDurationMs: 30000 }
}, { workflows, toolCatalog: tools });
assert.deepEqual(restricted.skillBindings, []);
assert.deepEqual(filterToolsForAgent(restricted, tools).map((item) => item.id), ["web_search"]);
assert.deepEqual(filterCapabilityPlan(restricted, { actions: [
  { type: "web_search" },
  { type: "feishu_document_create" }
] }).actions, [{ type: "web_search" }]);
assert.deepEqual(runtimeBudget(restricted), { maxSteps: 4, maxToolCalls: 2, maxModelCalls: 5, maxReplans: 1, maxDurationMs: 30000 });

(async () => {
  await assert.rejects(
    prepareAgentToolResult({ text: "请计算 1 + 1", workspaceId: "ws_profile", allowedToolIds: ["web_search"] }),
    (error) => error.code === "AGENT_TOOL_NOT_ALLOWED"
  );

  const db = { settings: { assistantTasks: [], collaborationTasks: [] } };
  rememberHumanMessage(db, { agentId: "agent_a", chatId: "chat", messageId: "a", senderId: "u", text: "我希望以后默认用中文" });
  rememberHumanMessage(db, { agentId: "agent_b", chatId: "chat", messageId: "b", senderId: "u", text: "我希望以后默认用中文" });
  rememberHumanMessage(db, { agentId: "agent_b", chatId: "chat", messageId: "b2", senderId: "u", text: "我希望以后默认使用英文" });
  assert.equal(db.settings.memory.core.filter((item) => item.text === "我希望以后默认用中文").length, 2);
  const context = fiveLayerMemoryContext(db, { agentId: "agent_a", chatId: "chat", text: "继续" }, "", { agentId: "agent_a", policy: { scope: "agent" } });
  assert.match(context, /默认用中文/);
  assert.doesNotMatch(context, /默认使用英文/);
  console.log("Agent profile test passed: migration, grants, budgets, tool denial, channels, and memory isolation.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
