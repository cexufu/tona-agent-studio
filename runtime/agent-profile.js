const { normalizeDelegationPolicy } = require("./subagent-runtime");

const PROFILE_VERSION = 2;

const DEFAULT_MEMORY_POLICY = Object.freeze({
  scope: "agent",
  core: true,
  semantic: true,
  task: true,
  episodic: true,
  shortTerm: true,
  retentionDays: 90
});

const DEFAULT_RUNTIME_POLICY = Object.freeze({
  maxSteps: 8,
  maxToolCalls: 6,
  maxModelCalls: 10,
  maxReplans: 2,
  maxDurationMs: 120000,
  allowCollaboration: true,
  replyMode: "adaptive"
});

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(String).map((item) => item.trim()).filter(Boolean))];
}

function defaultToolIds(toolCatalog = []) {
  return uniqueStrings(toolCatalog
    .filter((tool) => tool && tool.status !== "planned")
    .map((tool) => tool.id));
}

function normalizeToolPolicy(value = {}, toolCatalog = []) {
  const known = new Set(toolCatalog.map((tool) => tool.id));
  const fallback = defaultToolIds(toolCatalog);
  const requested = Array.isArray(value.allowedToolIds) ? value.allowedToolIds : fallback;
  return {
    mode: "selected",
    allowedToolIds: uniqueStrings(requested).filter((id) => known.has(id))
  };
}

function deriveSkillIds(agent, workflows = []) {
  const legacy = uniqueStrings(agent.skills || []);
  const normalizedLegacy = legacy.map((item) => item.toLowerCase().replace(/\s+/g, ""));
  return uniqueStrings(workflows.filter((skill) => {
    if (skill.system === true) return true;
    if ((skill.steps || []).some((step) => step.agentId === agent.id)) return true;
    const id = String(skill.id || "").toLowerCase().replace(/\s+/g, "");
    const name = String(skill.name || "").toLowerCase().replace(/\s+/g, "");
    return normalizedLegacy.some((tag) => tag === id || (tag.length >= 3 && name.includes(tag)));
  }).map((skill) => skill.id));
}

function normalizeSkillBindings(agent, workflows = []) {
  const known = new Set(workflows.map((skill) => skill.id));
  const source = Array.isArray(agent.skillBindings)
    ? agent.skillBindings
    : deriveSkillIds(agent, workflows).map((skillId) => ({ skillId, enabled: true }));
  const seen = new Set();
  return source.map((binding) => ({
    skillId: String(binding?.skillId || "").trim(),
    enabled: binding?.enabled !== false,
    priority: Math.max(0, Math.min(100, Number(binding?.priority) || 50))
  })).filter((binding) => binding.skillId && known.has(binding.skillId) && !seen.has(binding.skillId) && seen.add(binding.skillId));
}

function normalizeMemoryPolicy(value = {}) {
  const scope = ["agent", "workspace", "conversation"].includes(value.scope) ? value.scope : DEFAULT_MEMORY_POLICY.scope;
  return {
    scope,
    core: value.core !== false,
    semantic: value.semantic !== false,
    task: value.task !== false,
    episodic: value.episodic !== false,
    shortTerm: value.shortTerm !== false,
    retentionDays: Math.max(1, Math.min(3650, Number(value.retentionDays) || DEFAULT_MEMORY_POLICY.retentionDays))
  };
}

function normalizeRuntimePolicy(value = {}) {
  return {
    maxSteps: Math.max(1, Math.min(20, Number(value.maxSteps) || DEFAULT_RUNTIME_POLICY.maxSteps)),
    maxToolCalls: Math.max(1, Math.min(20, Number(value.maxToolCalls) || DEFAULT_RUNTIME_POLICY.maxToolCalls)),
    maxModelCalls: Math.max(2, Math.min(30, Number(value.maxModelCalls) || DEFAULT_RUNTIME_POLICY.maxModelCalls)),
    maxReplans: Math.max(0, Math.min(8, value.maxReplans == null || value.maxReplans === "" ? DEFAULT_RUNTIME_POLICY.maxReplans : Number(value.maxReplans))),
    maxDurationMs: Math.max(10000, Math.min(600000, Number(value.maxDurationMs) || DEFAULT_RUNTIME_POLICY.maxDurationMs)),
    allowCollaboration: value.allowCollaboration !== false,
    replyMode: ["adaptive", "quick", "standard", "detailed"].includes(value.replyMode) ? value.replyMode : DEFAULT_RUNTIME_POLICY.replyMode
  };
}

function channelBindingsForAgent(agentId, bots = []) {
  return bots.filter((bot) => bot.agentId === agentId).map((bot) => ({
    type: "feishu",
    botId: bot.id,
    enabled: bot.enabled !== false
  }));
}

function normalizeAgentProfile(agent, { workflows = [], toolCatalog = [], bots = [] } = {}) {
  return {
    ...agent,
    profileVersion: PROFILE_VERSION,
    skillBindings: normalizeSkillBindings(agent, workflows),
    toolPolicy: normalizeToolPolicy(agent.toolPolicy, toolCatalog),
    channelBindings: channelBindingsForAgent(agent.id, bots),
    memoryPolicy: normalizeMemoryPolicy(agent.memoryPolicy),
    runtimePolicy: normalizeRuntimePolicy(agent.runtimePolicy),
    openWorker: {
      backend: agent.openWorker?.backend === "legacy" ? "legacy" : "openworker",
      agent: ["cowork", "code", "chat"].includes(agent.openWorker?.agent) ? agent.openWorker.agent : (/code|编程|开发/i.test(String(agent.id || "") + String(agent.role || "")) ? "code" : "cowork"),
      mode: ["discuss", "plan", "interactive", "auto"].includes(agent.openWorker?.mode) ? agent.openWorker.mode : "interactive",
      workspace: String(agent.openWorker?.workspace || "").slice(0, 1000),
      model: String(agent.openWorker?.model || "").slice(0, 200)
    },
    delegationPolicy: normalizeDelegationPolicy(agent.delegationPolicy)
  };
}

function syncAgentProfiles(db, toolCatalog = []) {
  const bots = db.settings?.larkBots || [];
  let changed = false;
  db.agents = (db.agents || []).map((agent) => {
    const normalized = normalizeAgentProfile(agent, { workflows: db.workflows || [], toolCatalog, bots });
    if (JSON.stringify(normalized) !== JSON.stringify(agent)) changed = true;
    return normalized;
  });
  return changed;
}

function allowedToolIds(agent) {
  return new Set(uniqueStrings(agent?.toolPolicy?.allowedToolIds || []));
}

function filterToolsForAgent(agent, tools = []) {
  const allowed = allowedToolIds(agent);
  return tools.filter((tool) => allowed.has(tool.id));
}

function capabilityAllowed(agent, action) {
  const allowed = allowedToolIds(agent);
  const type = String(action?.type || "");
  if (type === "reply") return true;
  if (type === "request_capability") {
    const capabilityId = String(action?.capabilityId || "");
    return allowed.has(capabilityId) || (capabilityId === "bitable_data" && allowed.has("sheets_data"));
  }
  if (type === "multi_agent_collaboration" && agent?.runtimePolicy?.allowCollaboration === false) return false;
  return allowed.has(type);
}

function filterCapabilityPlan(agent, plan = {}) {
  const actions = (plan.actions || []).filter((action) => capabilityAllowed(agent, action)).slice(0, 3);
  return { ...plan, intent: actions.length ? "action" : "reply", actions };
}

function runtimeBudget(agent) {
  const policy = normalizeRuntimePolicy(agent?.runtimePolicy);
  return {
    maxSteps: policy.maxSteps,
    maxToolCalls: policy.maxToolCalls,
    maxModelCalls: policy.maxModelCalls,
    maxReplans: policy.maxReplans,
    maxDurationMs: policy.maxDurationMs
  };
}

module.exports = {
  PROFILE_VERSION,
  DEFAULT_MEMORY_POLICY,
  DEFAULT_RUNTIME_POLICY,
  normalizeAgentProfile,
  syncAgentProfiles,
  allowedToolIds,
  filterToolsForAgent,
  capabilityAllowed,
  filterCapabilityPlan,
  runtimeBudget
};
