const crypto = require("crypto");

const A2A_VERSION = "tona-a2a/1.0";
const SUBAGENT_STATUSES = new Set(["queued", "running", "waiting_input", "partial", "completed", "failed", "cancelled", "timed_out", "refused"]);

function intersect(...sets) {
  const lists = sets.filter((value) => Array.isArray(value)).map((value) => new Set(value));
  if (!lists.length) return [];
  return [...lists[0]].filter((item) => lists.every((set) => set.has(item)));
}
function normalizeDelegationPolicy(value = {}) {
  return {
    canDelegate: value.canDelegate !== false,
    callableAgentIds: [...new Set((value.callableAgentIds || []).map(String))],
    callableByAgentIds: [...new Set((value.callableByAgentIds || []).map(String))],
    maxDepth: Math.max(0, Math.min(2, Number(value.maxDepth) || 1)),
    maxConcurrentChildren: Math.max(1, Math.min(4, Number(value.maxConcurrentChildren) || 2)),
    maxTotalChildren: Math.max(1, Math.min(8, Number(value.maxTotalChildren) || 4)),
    childToolMode: "intersection",
    externalWrites: "parent_only"
  };
}
function createBudgetPool(value = {}) {
  return {
    maxDurationMs: Math.max(10000, Math.min(600000, Number(value.maxDurationMs) || 300000)),
    maxModelCalls: Math.max(2, Math.min(60, Number(value.maxModelCalls) || 24)),
    maxToolCalls: Math.max(1, Math.min(40, Number(value.maxToolCalls) || 16)),
    maxSubagents: Math.max(1, Math.min(8, Number(value.maxSubagents) || 4)),
    maxConcurrentSubagents: Math.max(1, Math.min(4, Number(value.maxConcurrentSubagents) || 2)),
    usedModelCalls: Number(value.usedModelCalls) || 0,
    usedToolCalls: Number(value.usedToolCalls) || 0,
    usedSubagents: Number(value.usedSubagents) || 0,
    startedAt: value.startedAt || new Date().toISOString()
  };
}
function a2aRequest({ traceId, parentSpanId = "", fromAgentId, toAgentId, intent, payload = {}, outputSchema = {}, deadline, idempotencyKey } = {}) {
  const issuedAt = new Date().toISOString();
  return {
    protocolVersion: A2A_VERSION, traceId: traceId || `trace_${crypto.randomUUID().slice(0, 12)}`, spanId: `span_${crypto.randomUUID().slice(0, 12)}`, parentSpanId,
    fromAgentId: String(fromAgentId || ""), toAgentId: String(toAgentId || ""), type: "request", intent: String(intent || "delegate"), payload, outputSchema,
    issuedAt, deadline: deadline || new Date(Date.now() + 120000).toISOString(), idempotencyKey: idempotencyKey || crypto.createHash("sha256").update(String(toAgentId) + ":" + String(intent) + ":" + JSON.stringify(payload)).digest("hex").slice(0, 24)
  };
}
function publicSubagentTask(task) {
  return { id: task.id, type: "subagent", status: task.status, parentTaskId: task.parentTaskId, traceId: task.traceId, spanId: task.spanId, parentAgentId: task.parentAgentId, agentId: task.agentId, intent: task.intent, output: task.output, artifacts: task.artifacts || [], actionProposals: task.actionProposals || [], metrics: task.metrics || {}, error: task.error || "", createdAt: task.createdAt, updatedAt: task.updatedAt };
}

class SubagentScheduler {
  constructor() { this.activeByWorkspace = new Map(); this.idempotency = new Map(); }
  async run(request, context = {}) {
    const parent = context.parentAgent; const child = context.childAgent;
    if (!parent || !child) throw Object.assign(new Error("父 Agent 和子 Agent 都必须存在。"), { code: "SUBAGENT_AGENT_REQUIRED" });
    const parentPolicy = normalizeDelegationPolicy(parent.delegationPolicy);
    const childPolicy = normalizeDelegationPolicy(child.delegationPolicy);
    if (!parentPolicy.canDelegate) throw Object.assign(new Error("当前 Agent 不允许委派子任务。"), { code: "SUBAGENT_DELEGATION_DENIED" });
    if (parentPolicy.callableAgentIds.length && !parentPolicy.callableAgentIds.includes(child.id)) throw Object.assign(new Error("目标 Agent 不在允许委派名单中。"), { code: "SUBAGENT_TARGET_DENIED" });
    if (childPolicy.callableByAgentIds.length && !childPolicy.callableByAgentIds.includes(parent.id)) throw Object.assign(new Error("目标 Agent 不接受当前 Agent 调用。"), { code: "SUBAGENT_VISIBILITY_DENIED" });
    const depth = Number(context.depth) || 0;
    if (depth >= parentPolicy.maxDepth) throw Object.assign(new Error("子 Agent 深度已达到上限。"), { code: "SUBAGENT_DEPTH_LIMIT" });
    const pool = context.budgetPool || createBudgetPool();
    if (pool.usedSubagents >= Math.min(pool.maxSubagents, parentPolicy.maxTotalChildren)) throw Object.assign(new Error("子 Agent 总预算已用完。"), { code: "SUBAGENT_BUDGET_LIMIT" });
    const workspaceId = String(context.workspaceId || ""); const active = this.activeByWorkspace.get(workspaceId) || 0;
    if (active >= Math.min(pool.maxConcurrentSubagents, parentPolicy.maxConcurrentChildren)) throw Object.assign(new Error("子 Agent 并发已达到上限。"), { code: "SUBAGENT_CONCURRENCY_LIMIT" });
    if (this.idempotency.has(request.idempotencyKey)) return this.idempotency.get(request.idempotencyKey);
    const tools = intersect(parent.toolPolicy?.allowedToolIds || [], child.toolPolicy?.allowedToolIds || [], context.taskToolIds || parent.toolPolicy?.allowedToolIds || []);
    const now = new Date().toISOString();
    const task = { id: `subrun_${crypto.randomUUID().slice(0, 12)}`, parentTaskId: context.parentTaskId || "", traceId: request.traceId, spanId: request.spanId, parentSpanId: request.parentSpanId, parentAgentId: parent.id, agentId: child.id, intent: request.intent, payload: request.payload, outputSchema: request.outputSchema, effectiveToolIds: tools, depth: depth + 1, status: "queued", output: null, artifacts: [], actionProposals: [], metrics: {}, createdAt: now, updatedAt: now };
    context.onTask?.(task); pool.usedSubagents += 1; this.activeByWorkspace.set(workspaceId, active + 1); task.status = "running"; task.updatedAt = new Date().toISOString(); context.onTask?.(task);
    try {
      const result = await context.runChild({ task, request, childAgent: child, effectiveToolIds: tools, budgetPool: pool });
      task.status = SUBAGENT_STATUSES.has(result?.status) ? result.status : "completed"; task.output = result?.output ?? result; task.artifacts = result?.artifacts || []; task.actionProposals = result?.actionProposals || [];
      task.metrics = result?.metrics || {}; task.updatedAt = new Date().toISOString(); this.idempotency.set(request.idempotencyKey, task); context.onTask?.(task); return task;
    } catch (error) {
      task.status = error.code === "SUBAGENT_TIMEOUT" ? "timed_out" : "failed"; task.error = String(error.message || error).slice(0, 1000); task.updatedAt = new Date().toISOString(); context.onTask?.(task); return task;
    } finally { this.activeByWorkspace.set(workspaceId, Math.max(0, (this.activeByWorkspace.get(workspaceId) || 1) - 1)); }
  }
}

module.exports = { A2A_VERSION, SUBAGENT_STATUSES, normalizeDelegationPolicy, createBudgetPool, a2aRequest, publicSubagentTask, SubagentScheduler, intersect };
