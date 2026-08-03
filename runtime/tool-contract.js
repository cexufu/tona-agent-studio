const TOOL_CONTRACT_VERSION = "1.0";
const TOOL_LIFECYCLE = new Set(["experimental", "beta", "stable", "deprecated", "removed"]);
const OPERATION_RISKS = new Set(["read", "compute", "write", "send", "destructive"]);
const SIDE_EFFECT_SCOPES = new Set(["none", "workspace", "external"]);
const CONCURRENCY_MODES = new Set(["parallel_safe", "serial_per_task", "serial_per_user", "global_singleton"]);

function descriptionContract(value, fallback = "") {
  if (value && typeof value === "object") {
    return {
      summary: String(value.summary || fallback).trim(),
      whenToUse: (value.whenToUse || []).map(String).filter(Boolean),
      whenNotToUse: (value.whenNotToUse || []).map(String).filter(Boolean)
    };
  }
  return { summary: String(value || fallback).trim(), whenToUse: [], whenNotToUse: [] };
}

function normalizeToolContract(definition = {}) {
  const legacyRisk = definition.risk || "read";
  const operationRisk = OPERATION_RISKS.has(definition.policy?.operationRisk)
    ? definition.policy.operationRisk
    : legacyRisk === "read" ? "read" : legacyRisk === "write" ? "write" : "compute";
  const sideEffectScope = SIDE_EFFECT_SCOPES.has(definition.policy?.sideEffectScope)
    ? definition.policy.sideEffectScope
    : operationRisk === "read" || operationRisk === "compute" ? "none" : "external";
  const lifecycle = TOOL_LIFECYCLE.has(definition.lifecycle) ? definition.lifecycle : definition.status === "ready" ? "stable" : "experimental";
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    id: String(definition.id || "").trim(),
    version: String(definition.version || "0.1.0"),
    owner: String(definition.owner || "tona-runtime"),
    lifecycle,
    status: definition.status || "experimental",
    kind: definition.kind === "capability" ? "capability" : "tool",
    plugin: definition.plugin ? { id: String(definition.plugin.id || ""), version: String(definition.plugin.version || ""), scope: String(definition.plugin.scope || "") } : null,
    name: String(definition.name || definition.id || ""),
    category: String(definition.category || "general"),
    description: descriptionContract(definition.description, definition.name || definition.id),
    inputSchema: definition.inputSchema || { type: "object" },
    outputSchema: definition.outputSchema || { type: "object" },
    policy: {
      operationRisk,
      sideEffectScope,
      requiredScopes: [...new Set((definition.policy?.requiredScopes || []).map(String))],
      confirmation: definition.policy?.confirmation || (sideEffectScope === "external" ? "before_execute" : "never"),
      network: definition.policy?.network || "deny",
      concurrency: CONCURRENCY_MODES.has(definition.policy?.concurrency) ? definition.policy.concurrency : "parallel_safe",
      timeoutMs: Math.max(1000, Number(definition.policy?.timeoutMs) || 10000),
      retries: Math.max(0, Math.min(3, Number(definition.policy?.retries) || 0)),
      idempotent: definition.policy?.idempotent !== false,
      rateLimit: {
        maxCalls: Math.max(1, Number(definition.policy?.rateLimit?.maxCalls) || 120),
        windowMs: Math.max(1000, Number(definition.policy?.rateLimit?.windowMs) || 60000)
      }
    },
    executable: definition.executable === true
  };
}

function plannerToolDescription(definition) {
  const tool = normalizeToolContract(definition);
  return [
    tool.description.summary,
    tool.description.whenToUse.length ? `Use when: ${tool.description.whenToUse.join("; ")}.` : "",
    tool.description.whenNotToUse.length ? `Do not use when: ${tool.description.whenNotToUse.join("; ")}.` : ""
  ].filter(Boolean).join(" ");
}

module.exports = { TOOL_CONTRACT_VERSION, normalizeToolContract, plannerToolDescription };
