const crypto = require("crypto");
const { OpenWorkerClient, normalizeOpenWorkerSettings } = require("./openworker-client");

function openWorkerSettings(db = {}, env = process.env) {
  return normalizeOpenWorkerSettings(db.settings?.openWorker || {}, env);
}

function openWorkerReady(db = {}, env = process.env) {
  const settings = openWorkerSettings(db, env);
  return settings.enabled && Boolean(settings.baseUrl);
}

function conversationSessionId({ workspaceId = "", botId = "", chatId = "", threadId = "", requestedBy = "" } = {}) {
  const key = [workspaceId, botId, threadId || chatId, requestedBy].join(":");
  return `tona_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

function createOpenWorkerTask(input = {}) {
  const now = new Date().toISOString();
  const sessionId = input.sessionId || (input.chatId || input.threadId || input.requestedBy ? conversationSessionId(input) : `tona_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
  return {
    id: input.id || `ow_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    type: "openworker",
    runtimeVersion: "openworker-v1",
    status: "queued",
    phase: "queued",
    title: String(input.title || input.goal || "OpenWorker 任务").slice(0, 120),
    goal: String(input.goal || "").slice(0, 8000),
    sessionId,
    workspaceId: String(input.workspaceId || ""),
    workspace: String(input.workspace || ""),
    agentId: String(input.agentId || ""),
    workerAgent: String(input.workerAgent || "cowork"),
    mode: String(input.mode || "interactive"),
    model: String(input.model || ""),
    skill: String(input.skill || ""),
    botId: String(input.botId || ""),
    botAppId: String(input.botAppId || ""),
    chatId: String(input.chatId || ""),
    chatType: String(input.chatType || ""),
    messageId: String(input.messageId || ""),
    requestedBy: String(input.requestedBy || ""),
    trace: [{ at: now, phase: "queued", status: "queued" }],
    tools: [],
    output: null,
    pendingAction: null,
    error: "",
    createdAt: now,
    updatedAt: now
  };
}

function eventSummary(event = {}) {
  const data = event.data || {};
  return {
    at: new Date().toISOString(),
    phase: String(event.type || "event"),
    status: String(data.status || (event.type === "error" ? "failed" : "running")),
    tool: String(data.name || ""),
    preview: String(data.result_preview || data.reason || data.error || data.plan || data.question || "").slice(0, 500)
  };
}

function taskCheckpoint(task, outcome = {}) {
  const tools = Array.isArray(task.tools) ? task.tools : [];
  const completedItems = tools.filter((item) => !["running", "proposed"].includes(item.status)).map((item) => `${item.name}: ${item.status || "completed"}`);
  const remainingItems = tools.filter((item) => ["running", "proposed"].includes(item.status)).map((item) => item.name);
  const status = outcome.status || task.status;
  const reasons = {
    completed: "任务已完成。",
    waiting_confirmation: "等待你确认计划或高风险操作。",
    waiting_input: "等待你补充信息。",
    running: "本次线上等待已结束，OpenWorker session 仍可能在后台运行。",
    cancelled: "任务已由用户或运行时中断。",
    failed: task.error || outcome.message || "OpenWorker 执行失败。"
  };
  const resumeHints = {
    waiting_confirmation: "在飞书卡片或江湖令中允许/拒绝后，会从同一个 session 继续。",
    waiting_input: "直接回复问题，或在江湖令填写答案后继续。",
    running: "无需重复创建任务；在行走台打开该 session 查看进度，必要时再继续执行。",
    cancelled: "在江湖令点击“继续执行”，将沿用原 session 和上下文。",
    failed: "检查错误与最后一个工具后，在江湖令点击“继续执行”；若环境已失效，再新建任务。"
  };
  return {
    reason: reasons[status] || `任务停在 ${status || "unknown"} 状态。`,
    stoppedAt: String(task.phase || "unknown"),
    completedItems,
    remainingItems,
    resumeHint: resumeHints[status] || ""
  };
}
async function executeOpenWorkerTask(task, { settings, env = process.env, persist = () => {}, fetch, WebSocket } = {}) {
  const client = new OpenWorkerClient(settings || {}, { env, fetch, WebSocket });
  task.status = "running";
  task.phase = "connecting";
  task.updatedAt = new Date().toISOString();
  persist(task);
  try {
    const outcome = await client.runTurn({
      sessionId: task.sessionId,
      workspace: task.workspace,
      agent: task.workerAgent,
      mode: task.mode,
      model: task.model,
      skill: task.skill,
      text: task.continuationPrompt || task.goal,
      unattended: true,
      onEvent(event) {
        const summary = eventSummary(event);
        task.phase = summary.phase;
        task.updatedAt = summary.at;
        task.trace.push(summary);
        task.trace = task.trace.slice(-120);
        if (["tool_started", "tool_proposed"].includes(event.type)) task.tools.push({ name: summary.tool, status: "running", preview: summary.preview });
        if (event.type === "tool_finished") {
          const row = [...task.tools].reverse().find((item) => item.name === summary.tool && item.status === "running");
          if (row) Object.assign(row, { status: summary.status, preview: summary.preview });
        }
        persist(task);
      }
    });
    task.status = outcome.status;
    task.phase = outcome.status === "completed" ? "done" : outcome.status;
    task.output = { summary: outcome.message || "", sessionId: outcome.sessionId, usage: outcome.usage || null, checkpoint: taskCheckpoint(task, outcome) };
    task.continuationPrompt = "";
    task.pendingAction = outcome.pending ? {
      itemId: outcome.pending.id,
      kind: outcome.pending.kind,
      title: outcome.pending.title,
      body: outcome.pending.body || "",
      data: outcome.pending.data || {},
      options: outcome.pending.options || []
    } : null;
    task.tools = outcome.tools || task.tools;
    task.updatedAt = new Date().toISOString();
    persist(task);
    return { ...outcome, task };
  } catch (error) {
    task.status = "failed";
    task.phase = "failed";
    task.error = String(error?.message || error).slice(0, 1200);
    task.updatedAt = new Date().toISOString();
    task.trace.push({ at: task.updatedAt, phase: "failed", status: "failed", preview: task.error });
    task.output = { summary: task.error, sessionId: task.sessionId, usage: null, checkpoint: taskCheckpoint(task, { status: "failed", message: task.error }) };
    persist(task);
    return { status: "failed", message: `OpenWorker 执行失败：${task.error}`, task };
  }
}

async function continueOpenWorkerTask(task, { settings, env = process.env, persist = () => {}, fetch, WebSocket } = {}) {
  const client = new OpenWorkerClient(settings || {}, { env, fetch, WebSocket });
  const outcome = await client.runTurn({ sessionId: task.sessionId, workspace: task.workspace, agent: task.workerAgent, mode: task.mode, resumeOnly: true, unattended: true });
  task.status = outcome.status;
  task.phase = outcome.status === "completed" ? "done" : outcome.status;
  task.output = { summary: outcome.message || "", sessionId: outcome.sessionId, usage: outcome.usage || null, checkpoint: taskCheckpoint(task, outcome) };
    task.continuationPrompt = "";
  task.pendingAction = outcome.pending ? { itemId: outcome.pending.id, kind: outcome.pending.kind, title: outcome.pending.title, body: outcome.pending.body || "", data: outcome.pending.data || {}, options: outcome.pending.options || [] } : null;
  task.tools = outcome.tools || task.tools;
  task.updatedAt = new Date().toISOString();
  persist(task);
  return { ...outcome, task };
}
async function resolveOpenWorkerTask(task, resolution, { settings, env = process.env, fetch } = {}) {
  if (!task?.pendingAction?.itemId) throw new Error("OpenWorker task has no pending Inbox item.");
  const client = new OpenWorkerClient(settings || {}, { env, fetch });
  const result = await client.resolveInbox(task.pendingAction.itemId, resolution);
  if (!result.ok) throw new Error("This OpenWorker prompt was already resolved or expired.");
  task.status = "running";
  task.phase = "resuming";
  task.pendingAction = null;
  task.updatedAt = new Date().toISOString();
  return task;
}

function publicOpenWorkerTask(task) {
  return {
    id: task.id,
    type: task.type,
    runtimeVersion: task.runtimeVersion,
    title: task.title,
    goal: task.goal,
    status: task.status,
    phase: task.phase,
    agentId: task.agentId,
    workerAgent: task.workerAgent,
    sessionId: task.sessionId,
    output: task.output,
    pendingAction: task.pendingAction ? { kind: task.pendingAction.kind, title: task.pendingAction.title, body: task.pendingAction.body, options: task.pendingAction.options } : null,
    tools: task.tools,
    error: task.error,
    trace: task.trace,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

module.exports = {
  openWorkerSettings,
  openWorkerReady,
  conversationSessionId,
  createOpenWorkerTask,
  executeOpenWorkerTask,
  resolveOpenWorkerTask,
  continueOpenWorkerTask,
  publicOpenWorkerTask,
  taskCheckpoint
};
