const crypto = require("crypto");
const { assertPolicyDecision } = require("./policy-kernel");

const PROTOCOL_VERSION = "2.0";
const RISK_LEVELS = ["read", "write", "execute"];
const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{8,120}$/;
const rateBuckets = new Map();
const idempotencyCache = new Map();
const MAX_RUNTIME_CACHE_ENTRIES = 5000;

function pruneRuntimeCaches(now, idempotencyTtlMs) {
  for (const [key, values] of rateBuckets) {
    const recent = values.filter((value) => value > now - 60 * 60 * 1000);
    if (recent.length) rateBuckets.set(key, recent);
    else rateBuckets.delete(key);
  }
  for (const [key, value] of idempotencyCache) {
    if (now - value.at > idempotencyTtlMs) idempotencyCache.delete(key);
  }
  while (rateBuckets.size > MAX_RUNTIME_CACHE_ENTRIES) rateBuckets.delete(rateBuckets.keys().next().value);
  while (idempotencyCache.size > MAX_RUNTIME_CACHE_ENTRIES) idempotencyCache.delete(idempotencyCache.keys().next().value);
}

class RuntimeToolError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "RuntimeToolError";
    this.code = code;
    this.category = options.category || "internal";
    this.retryable = options.retryable === true;
    this.status = Number(options.status) || 400;
    this.statusCode = this.status;
    this.details = options.details;
  }
}

function classifyToolError(error) {
  if (error instanceof RuntimeToolError) return error;
  const message = String(error?.message || error || "Tool execution failed.");
  if (/abort|timeout|timed out/i.test(message)) return new RuntimeToolError("TOOL_TIMEOUT", message, { category: "timeout", retryable: true, status: 504 });
  if (/429|rate.?limit|too many requests/i.test(message)) return new RuntimeToolError("TOOL_PROVIDER_RATE_LIMIT", message, { category: "rate_limit", retryable: true, status: 429 });
  if (/HTTP 5\d\d/i.test(message)) return new RuntimeToolError("TOOL_PROVIDER_UNAVAILABLE", message, { category: "provider", retryable: true, status: 502 });
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(message)) return new RuntimeToolError("TOOL_NETWORK_ERROR", message, { category: "network", retryable: true, status: 502 });
  if (/401|403|unauthori[sz]ed|forbidden|permission denied/i.test(message)) return new RuntimeToolError("TOOL_PERMISSION_DENIED", message, { category: "permission", retryable: false, status: 403 });
  return new RuntimeToolError("TOOL_EXECUTION_FAILED", message, { category: "execution", retryable: false, status: 422 });
}

function validateJsonSchema(schema, value, path = "$", errors = []) {
  if (!schema || typeof schema !== "object") return errors;
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = type === "number" && Number.isInteger(value) ? ["integer", "number"] : [type];
    if (!allowed.some((item) => actual.includes(item))) {
      errors.push(`${path} must be ${allowed.join(" or ")}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) errors.push(`${path} has an invalid format`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${path} must be finite`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    value.forEach((item, index) => validateJsonSchema(schema.items, item, `${path}[${index}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validateJsonSchema(schema.properties[key], item, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  return errors;
}

function assertSchema(schema, value, label) {
  const errors = validateJsonSchema(schema, value);
  if (errors.length) throw new RuntimeToolError("TOOL_SCHEMA_INVALID", `${label} schema validation failed: ${errors.slice(0, 5).join("; ")}`, { category: "validation", status: 400, details: errors });
}

function assertWorkspacePermission(definition, context) {
  const workspaceId = String(context.workspaceId || "");
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(workspaceId)) throw new RuntimeToolError("TOOL_WORKSPACE_REQUIRED", "A valid workspace is required to run tools.", { category: "permission", status: 403 });
  if (context.authorizedWorkspaceId && context.authorizedWorkspaceId !== workspaceId) throw new RuntimeToolError("TOOL_WORKSPACE_DENIED", "The tool request does not belong to the authorized workspace.", { category: "permission", status: 403 });
  const allowedRisks = context.allowedRisks || ["read"];
  if (!allowedRisks.includes(definition.risk)) throw new RuntimeToolError("TOOL_RISK_NOT_APPROVED", `Tool risk '${definition.risk}' has not been approved.`, { category: "permission", status: 403 });
  if (context.permissionChecker && context.permissionChecker({ workspaceId, toolId: definition.id, risk: definition.risk }) !== true) throw new RuntimeToolError("TOOL_PERMISSION_DENIED", "Workspace permission denied for this tool.", { category: "permission", status: 403 });
  return workspaceId;
}

function consumeRateLimit(definition, workspaceId, now) {
  const limit = definition.policy.rateLimit;
  const key = `${workspaceId}:${definition.id}`;
  const recent = (rateBuckets.get(key) || []).filter((value) => value > now - limit.windowMs);
  if (recent.length >= limit.maxCalls) throw new RuntimeToolError("TOOL_RATE_LIMITED", "Tool rate protection is active. Please retry shortly.", { category: "rate_limit", status: 429 });
  recent.push(now);
  rateBuckets.set(key, recent);
}

function publicToolDefinition(definition) {
  const { handler, ...value } = definition;
  return JSON.parse(JSON.stringify(value));
}

function createToolRegistry(definitions) {
  const registry = new Map();
  for (const definition of definitions) {
    if (!definition?.id || registry.has(definition.id)) throw new Error(`Invalid or duplicate Runtime tool: ${definition?.id || "unknown"}`);
    if (!RISK_LEVELS.includes(definition.risk)) throw new Error(`Invalid risk level for Runtime tool ${definition.id}.`);
    if (!definition.inputSchema || !definition.outputSchema || typeof definition.handler !== "function") throw new Error(`Runtime tool ${definition.id} is missing its schema or handler.`);
    if (definition.qualityGates !== undefined && (!Array.isArray(definition.qualityGates) || definition.qualityGates.some((gate) => typeof gate !== "function"))) throw new Error(`Runtime tool ${definition.id} has invalid quality gates.`);
    definition.policy = { timeoutMs: 10000, retries: 0, idempotent: true, ...definition.policy, rateLimit: { maxCalls: 120, windowMs: 60000, ...(definition.policy?.rateLimit || {}) } };
    registry.set(definition.id, definition);
  }
  return registry;
}

async function executeRegisteredTool(registry, toolId, input, context = {}) {
  const definition = registry.get(toolId);
  if (context.policyDecision) assertPolicyDecision(context.policyDecision, { confirmed: context.confirmed === true });
  if (!definition || definition.status !== "ready") throw new RuntimeToolError("TOOL_NOT_FOUND", `Unknown or unavailable Runtime tool: ${toolId}`, { category: "not_found", status: 404 });
  const workspaceId = assertWorkspacePermission(definition, context);
  assertSchema(definition.inputSchema, input, "Input");
  const now = Number(context.now?.() ?? Date.now());
  const idempotencyTtlMs = context.idempotencyTtlMs || 10 * 60 * 1000;
  pruneRuntimeCaches(now, idempotencyTtlMs);
  const invocationId = `inv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const traceId = /^[A-Za-z0-9_-]{8,120}$/.test(String(context.traceId || "")) ? String(context.traceId) : `trc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const parentInvocationId = /^[A-Za-z0-9_-]{8,120}$/.test(String(context.parentInvocationId || "")) ? String(context.parentInvocationId) : "";
  const startedAt = new Date(now).toISOString();
  const cacheKey = context.idempotencyKey && definition.policy.idempotent ? `${workspaceId}:${toolId}:${context.idempotencyKey}` : "";
  if (cacheKey && idempotencyCache.has(cacheKey)) {
    const cached = idempotencyCache.get(cacheKey);
    if (now - cached.at <= idempotencyTtlMs) {
      const envelope = { ...cached.envelope, invocationId, traceId, parentInvocationId, meta: { ...cached.envelope.meta, cached: true, idempotencyKey: context.idempotencyKey } };
      context.audit?.({ at: new Date(now).toISOString(), invocationId, traceId, parentInvocationId, workspaceId, toolId, pluginId: definition.plugin?.id || "", risk: definition.risk, status: "cache_hit", durationMs: 0, attempts: 0, artifactIds: envelope.artifactIds });
      return envelope;
    }
    idempotencyCache.delete(cacheKey);
  }
  consumeRateLimit(definition, workspaceId, now);
  context.audit?.({ at: startedAt, invocationId, traceId, parentInvocationId, workspaceId, toolId, pluginId: definition.plugin?.id || "", risk: definition.risk, status: "started" });
  let attempts = 0;
  let lastError;
  while (attempts <= definition.policy.retries) {
    attempts += 1;
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new RuntimeToolError("TOOL_TIMEOUT", `Tool exceeded ${definition.policy.timeoutMs}ms.`, { category: "timeout", retryable: true, status: 504 })), definition.policy.timeoutMs);
        timer.unref?.();
      });
      const data = await Promise.race([Promise.resolve(definition.handler(input, context)), timeout]);
      clearTimeout(timer);
      assertSchema(definition.outputSchema, data, "Output");
      const quality = [];
      for (const gate of definition.qualityGates || []) {
        const check = await gate({ input, data, context, definition });
        if (!check || check.ok !== true) throw new RuntimeToolError("TOOL_QUALITY_GATE_FAILED", String(check?.message || "Tool output failed a quality gate."), { category: "quality", status: 422, details: check?.details });
        quality.push({ id: String(check.id || gate.name || "quality_gate"), ok: true });
      }
      const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
      for (const artifact of artifacts) if (!ARTIFACT_ID_PATTERN.test(String(artifact?.artifact_id || ""))) throw new RuntimeToolError("TOOL_ARTIFACT_INVALID", "Tool returned an invalid artifact_id.", { category: "artifact", status: 500 });
      const completed = Number(context.now?.() ?? Date.now());
      const envelope = { protocolVersion: PROTOCOL_VERSION, invocationId, traceId, parentInvocationId, toolId, pluginId: definition.plugin?.id || "", workspaceId, risk: definition.risk, status: "success", resultType: "tool_result", data, artifactIds: artifacts.map((artifact) => artifact.artifact_id), quality, meta: { startedAt, completedAt: new Date(completed).toISOString(), durationMs: Math.max(0, completed - now), attempts, cached: false, idempotencyKey: context.idempotencyKey || "" } };
      if (cacheKey) idempotencyCache.set(cacheKey, { at: now, envelope });
      context.audit?.({ at: envelope.meta.completedAt, invocationId, traceId, parentInvocationId, workspaceId, toolId, pluginId: definition.plugin?.id || "", risk: definition.risk, status: "success", durationMs: envelope.meta.durationMs, attempts, artifactIds: envelope.artifactIds, quality });
      return envelope;
    } catch (error) {
      clearTimeout(timer);
      lastError = classifyToolError(error);
      context.audit?.({ at: new Date(Number(context.now?.() ?? Date.now())).toISOString(), invocationId, traceId, parentInvocationId, workspaceId, toolId, pluginId: definition.plugin?.id || "", risk: definition.risk, status: lastError.retryable && attempts <= definition.policy.retries ? "retrying" : "attempt_failed", attempt: attempts, error: { code: lastError.code, category: lastError.category, message: lastError.message, retryable: lastError.retryable } });
      if (!lastError.retryable || attempts > definition.policy.retries) break;
    }
  }
  const failedAt = new Date(Number(context.now?.() ?? Date.now())).toISOString();
  context.audit?.({ at: failedAt, invocationId, traceId, parentInvocationId, workspaceId, toolId, pluginId: definition.plugin?.id || "", risk: definition.risk, status: "error", attempts, error: { code: lastError.code, category: lastError.category, message: lastError.message } });
  lastError.invocationId = invocationId;
  lastError.traceId = traceId;
  throw lastError;
}

module.exports = { PROTOCOL_VERSION, RuntimeToolError, classifyToolError, validateJsonSchema, createToolRegistry, publicToolDefinition, executeRegisteredTool };
