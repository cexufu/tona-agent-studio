const { normalizeToolContract } = require("./tool-contract");

const POLICY_VERSION = "1.0";
const DECISION_ORDER = { allow: 0, confirm: 1, deny: 2 };

function strings(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))]; }
function minLimit(values, fallback) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return valid.length ? Math.min(...valid) : fallback;
}
function normalizePolicy(value = {}) {
  return {
    deniedToolIds: strings(value.deniedToolIds),
    allowedToolIds: Array.isArray(value.allowedToolIds) ? strings(value.allowedToolIds) : null,
    grantedScopes: strings(value.grantedScopes),
    network: ["allow", "deny"].includes(value.network) ? value.network : null,
    externalWrites: ["allow", "confirm", "deny"].includes(value.externalWrites) ? value.externalWrites : null,
    maxDurationMs: Number(value.maxDurationMs) || 0,
    maxMemoryMb: Number(value.maxMemoryMb) || 0,
    maxOutputBytes: Number(value.maxOutputBytes) || 0,
    maxConcurrent: Number(value.maxConcurrent) || 0
  };
}
function mergeDecision(current, next) { return DECISION_ORDER[next] > DECISION_ORDER[current] ? next : current; }

function compileToolPolicy({ tool, platform = {}, workspace = {}, agent = {}, task = {}, grantedScopes = [] } = {}) {
  const contract = normalizeToolContract(tool);
  const layers = [normalizePolicy(platform), normalizePolicy(workspace), normalizePolicy(agent), normalizePolicy(task)];
  let decision = "allow";
  let reasonCode = "POLICY_ALLOWED";
  let message = "工具调用符合当前策略。";
  const toolId = contract.id;
  const agentAllowed = new Set(agent.allowedToolIds || agent.toolPolicy?.allowedToolIds || []);
  if (!toolId || contract.status !== "ready" || contract.lifecycle === "removed") {
    decision = "deny"; reasonCode = "TOOL_UNAVAILABLE"; message = "工具当前不可执行。";
  }
  if (decision !== "deny" && agentAllowed.size && !agentAllowed.has(toolId)) {
    decision = "deny"; reasonCode = "AGENT_TOOL_NOT_GRANTED"; message = `当前 Agent 未获授权使用工具：${toolId}`;
  }
  for (const layer of layers) {
    if (decision === "deny") break;
    if (layer.deniedToolIds.includes(toolId)) {
      decision = "deny"; reasonCode = "TOOL_EXPLICITLY_DENIED"; message = `策略明确禁止工具：${toolId}`; break;
    }
    if (layer.allowedToolIds && !layer.allowedToolIds.includes(toolId)) {
      decision = "deny"; reasonCode = "TOOL_OUTSIDE_ALLOWLIST"; message = `工具不在当前策略白名单中：${toolId}`; break;
    }
  }
  const scopes = new Set([...grantedScopes, ...layers.flatMap((layer) => layer.grantedScopes)]);
  const missingScopes = contract.policy.requiredScopes.filter((scope) => !scopes.has(scope));
  if (decision !== "deny" && missingScopes.length) {
    decision = "deny"; reasonCode = "TOOL_SCOPE_MISSING"; message = `缺少工具权限：${missingScopes.join(", ")}`;
  }
  const networkAllowed = contract.policy.network === "allow" && layers.every((layer) => layer.network !== "deny");
  if (decision !== "deny" && contract.policy.network === "allow" && !networkAllowed) {
    decision = "deny"; reasonCode = "NETWORK_POLICY_DENIED"; message = "当前策略不允许该工具访问网络。";
  }
  if (decision !== "deny" && contract.policy.sideEffectScope === "external") {
    const externalDecision = layers.reduce((current, layer) => layer.externalWrites ? mergeDecision(current, layer.externalWrites) : current, "allow");
    decision = mergeDecision(decision, externalDecision);
    if (decision === "confirm") { reasonCode = "EXTERNAL_WRITE_CONFIRMATION_REQUIRED"; message = "外部写操作需要用户确认。"; }
    if (decision === "deny") { reasonCode = "EXTERNAL_WRITE_DENIED"; message = "当前策略禁止外部写操作。"; }
  }
  if (decision === "allow" && contract.policy.confirmation === "before_execute") {
    decision = "confirm"; reasonCode = "TOOL_CONFIRMATION_REQUIRED"; message = "该工具执行前需要用户确认。";
  }
  return {
    policyVersion: POLICY_VERSION,
    decision,
    reasonCode,
    message,
    toolId,
    missingScopes,
    effectiveLimits: {
      timeoutMs: minLimit([contract.policy.timeoutMs, ...layers.map((layer) => layer.maxDurationMs)], contract.policy.timeoutMs),
      maxMemoryMb: minLimit(layers.map((layer) => layer.maxMemoryMb), 512),
      maxOutputBytes: minLimit(layers.map((layer) => layer.maxOutputBytes), 100 * 1024 * 1024),
      maxConcurrent: minLimit(layers.map((layer) => layer.maxConcurrent), 2),
      network: networkAllowed ? "allow" : "deny"
    }
  };
}

function assertPolicyDecision(result, { confirmed = false } = {}) {
  if (result.decision === "allow" || result.decision === "confirm" && confirmed) return result;
  const error = new Error(result.message);
  error.code = result.reasonCode;
  error.category = "policy";
  error.statusCode = result.decision === "confirm" ? 409 : 403;
  error.policyDecision = result;
  throw error;
}

module.exports = { POLICY_VERSION, normalizePolicy, compileToolPolicy, assertPolicyDecision };
