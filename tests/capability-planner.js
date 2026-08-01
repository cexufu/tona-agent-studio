const assert = require("assert");
const {
  UNIVERSAL_CAPABILITIES,
  needsCapabilityPlanning,
  relativeReminderAction,
  fallbackCapabilityPlan,
  plannerPrompt,
  parseCapabilityPlan
} = require("../runtime/capability-planner");
const { deterministicToolRequest } = require("../runtime/agent-tools");

const now = Date.parse("2026-08-01T10:00:00Z");
assert.equal(needsCapabilityPlanning("你好"), false);
assert.equal(needsCapabilityPlanning("请在4分钟后提醒我开会"), true);

const reminder = relativeReminderAction("请在4分钟后提醒我开会", now);
assert.equal(reminder.type, "schedule_reminder");
assert.equal(reminder.runAt, "2026-08-01T10:04:00.000Z");
assert(reminder.reminderText.includes("开会"));

const agents = [
  { id: "daily", name: "日常助理", role: "协调与日程", hasFeishuBot: true },
  { id: "research", name: "科研助理", role: "研究分析", hasFeishuBot: true },
  { id: "code", name: "代码助理", role: "代码实现", hasFeishuBot: false }
];
const fallback = fallbackCapabilityPlan({ text: "请让科研助理一起协作讨论，并生成飞书文档", agents, currentAgentId: "daily", now });
assert(fallback.actions.some((item) => item.type === "multi_agent_collaboration" && item.targetAgentIds.includes("research")));
assert(fallback.actions.some((item) => item.type === "feishu_document_create"));

const parsed = parseCapabilityPlan(JSON.stringify({
  intent: "action",
  presentation: "card",
  actions: [
    { type: "multi_agent_collaboration", reason: "需要研究与代码复核", targetAgentIds: ["research", "code", "unknown"], rounds: 99 },
    { type: "schedule_reminder", reason: "稍后提醒", runAt: "2026-08-01T10:10:00Z", reminderText: "提交报告" },
    { type: "delete_everything", reason: "invalid" }
  ]
}), { validAgentIds: ["research"], now });
assert.deepEqual(parsed.actions[0].targetAgentIds, ["research"]);
assert.equal(parsed.actions[0].rounds, 3);
assert.equal(parsed.actions[1].runAt, "2026-08-01T10:10:00.000Z");
assert.equal(parsed.actions.length, 2);

const prompt = plannerPrompt({ text: "分析后决定是否创建文档", agents, currentAgentId: "daily", timeZone: "Asia/Shanghai", now: "2026-08-01T10:00:00Z" });
assert(prompt.includes("Universal capabilities"));
assert(prompt.includes("科研助理"));
assert(UNIVERSAL_CAPABILITIES.some((item) => item.id === "schedule_reminder"));

assert.equal(deterministicToolRequest("我让你写的文档主题是怎么让 TONA 为我设置闹钟和日历"), null);
assert.deepEqual(deterministicToolRequest("把 10 公里换算为 mi"), { toolId: "unit_convert", input: { value: 10, from: "km", to: "mi" } });
assert.deepEqual(deterministicToolRequest("convert 5 km to mi"), { toolId: "unit_convert", input: { value: 5, from: "km", to: "mi" } });

console.log("Capability planner test passed: universal catalog, bounded plans, reminders, collaboration targets, and strict deterministic routing.");
