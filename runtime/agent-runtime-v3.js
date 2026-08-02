const crypto = require("crypto");

const RUNTIME_VERSION = "3.0";
const TERMINAL_STATUSES = new Set(["completed", "completed_with_limits", "failed", "cancelled"]);
const DEFAULT_BUDGET = Object.freeze({ maxSteps: 8, maxToolCalls: 6, maxModelCalls: 10, maxReplans: 2, maxDurationMs: 120000 });

function nowIso(now = Date.now()) { return new Date(now).toISOString(); }
function compactText(value, limit = 6000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= limit) return text;
  const edge = Math.max(200, Math.floor((limit - 80) / 2));
  return text.slice(0, edge) + `\n...[${text.length - edge * 2} characters offloaded]...\n` + text.slice(-edge);
}
function parseJsonObject(value) {
  const content = String(value?.content ?? value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = content.indexOf("{"); const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("PAOVRD model response did not contain a JSON object.");
  return JSON.parse(content.slice(start, end + 1));
}
function taskEvent(task, phase, detail = {}) {
  task.trace.push({ at: nowIso(), phase, ...detail });
  task.trace = task.trace.slice(-80);
  task.phase = phase;
  task.updatedAt = nowIso();
}
function createPaovrdTask(input = {}) {
  const createdAt = nowIso(input.now || Date.now());
  return {
    id: input.id || `paovrd_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    type: "paovrd",
    runtimeVersion: RUNTIME_VERSION,
    status: "running",
    phase: "plan",
    goal: String(input.goal || "").slice(0, 5000),
    agentId: String(input.agentId || ""),
    workspaceId: String(input.workspaceId || ""),
    chatId: String(input.chatId || ""),
    chatType: String(input.chatType || ""),
    messageId: String(input.messageId || ""),
    requestedBy: String(input.requestedBy || ""),
    botId: String(input.botId || ""),
    botAppId: String(input.botAppId || ""),
    context: compactText(input.context || "", 5000),
    plan: null,
    steps: [],
    observations: [],
    verification: null,
    pendingAction: null,
    approvedFingerprints: [],
    userInputs: [],
    finalAnswer: "",
    trace: [{ at: createdAt, phase: "created", status: "running" }],
    metrics: { steps: 0, toolCalls: 0, modelCalls: 0, replans: 0, noProgress: 0 },
    budget: { ...DEFAULT_BUDGET, ...(input.budget || {}) },
    createdAt,
    updatedAt: createdAt
  };
}

function shouldUsePaovrd(text, capabilityPlan) {
  if ((capabilityPlan?.actions || []).some((action) => action.type === "web_search")) return true;
  const value = String(text || "");
  return /(联网|搜索|查找|查证|核实|最新|实时|调研|读取.{0,12}(文件|网页|链接)|https?:\/\/|计算|换算|统计|分析.{0,12}(数据|文件|CSV|JSON)|生成.{0,12}(文件|HTML|JSON|CSV)|调用.{0,6}工具|分步骤完成|继续执行|完成这个任务)/i.test(value);
}

function executableTools(tools = []) {
  return tools.filter((tool) => tool?.status === "ready" && tool?.executable === true && tool?.inputSchema && ["read", "write", "execute"].includes(tool.risk));
}
function toolSummary(tools) {
  return tools.map((tool) => ({ id: tool.id, description: tool.description, risk: tool.risk, inputSchema: tool.inputSchema }));
}
function observationSummary(task) {
  return task.observations.slice(-6).map((item) => ({ step: item.step, toolId: item.toolId, status: item.status, data: item.data, error: item.error || "" }));
}
function baseRules() {
  return [
    "Return one JSON object only. Do not use Markdown.",
    "Do not reveal private chain-of-thought. The rationale field must be a short operational reason, not hidden reasoning.",
    "Never invent a tool, permission, target, observation, source, artifact or successful action.",
    "Use only the supplied tool IDs and satisfy their input schemas. Prefer the smallest action that materially advances the goal."
  ].join(" ");
}
function planPrompt(task, tools) {
  return `${baseRules()}\nYou are the Plan phase of TONA PAOVRD. Decompose the goal into a short adaptive plan.\nOutput: {"summary":string,"steps":string[],"completionCriteria":string[]}. Use 1-6 steps and 1-5 objectively checkable criteria.\nGoal: ${task.goal}\nContext: ${task.context || "none"}\nAvailable tools: ${JSON.stringify(toolSummary(tools))}`;
}
function actionPrompt(task, tools) {
  return `${baseRules()}\nYou are the Act phase of TONA PAOVRD. Choose exactly one next move based on the latest observations.\nOutput one of:\n{"type":"tool","toolId":string,"input":object,"rationale":string}\n{"type":"finish","rationale":string}\n{"type":"ask_user","question":string,"rationale":string}.\nDo not finish merely because one tool ran; finish only when the completion criteria can be checked. Ask one concise question only when a required input cannot be obtained with tools.\nGoal: ${task.goal}\nPlan: ${JSON.stringify(task.plan)}\nObservations: ${JSON.stringify(observationSummary(task))}\nUser follow-ups: ${JSON.stringify(task.userInputs.slice(-3))}\nAvailable tools: ${JSON.stringify(toolSummary(tools))}`;
}
function verifyPrompt(task) {
  return `${baseRules()}\nYou are the Verify phase of TONA PAOVRD. Judge the evidence, not confidence or writing quality.\nOutput: {"passed":boolean,"summary":string,"gaps":string[],"next":"deliver|replan|ask_user","question":string}.\nA claim requiring current information needs a successful tool observation and traceable sources. A requested artifact needs an artifact identifier. Failed tool calls are not evidence.\nGoal: ${task.goal}\nCompletion criteria: ${JSON.stringify(task.plan?.completionCriteria || [])}\nObservations: ${JSON.stringify(observationSummary(task))}`;
}
function replanPrompt(task) {
  return `${baseRules()}\nYou are the Replan phase of TONA PAOVRD. Revise only the remaining work in response to verification gaps or tool errors.\nOutput: {"summary":string,"steps":string[],"completionCriteria":string[]}.\nGoal: ${task.goal}\nPrevious plan: ${JSON.stringify(task.plan)}\nVerification: ${JSON.stringify(task.verification)}\nObservations: ${JSON.stringify(observationSummary(task))}`;
}
function deliverPrompt(task, limited = false) {
  return `You are the Deliver phase of TONA PAOVRD. Answer the user in Chinese unless explicitly requested otherwise. Start with the result. Be concise in chat, but include material evidence, source URLs, artifact IDs and limitations. Never claim an action succeeded unless a successful observation proves it. Do not expose hidden reasoning or the internal JSON plan.${limited ? " State clearly that the runtime budget ended and identify unfinished work." : ""}\nGoal: ${task.goal}\nPlan: ${JSON.stringify(task.plan)}\nVerification: ${JSON.stringify(task.verification)}\nObservations: ${JSON.stringify(observationSummary(task))}`;
}

function normalizePlan(raw) {
  const steps = (Array.isArray(raw?.steps) ? raw.steps : []).map(String).map((item) => item.slice(0, 300)).filter(Boolean).slice(0, 6);
  const completionCriteria = (Array.isArray(raw?.completionCriteria) ? raw.completionCriteria : []).map(String).map((item) => item.slice(0, 300)).filter(Boolean).slice(0, 5);
  return { summary: String(raw?.summary || "完成用户目标并以可验证结果交付。").slice(0, 500), steps: steps.length ? steps : ["获取完成目标所需的信息", "验证结果并交付"], completionCriteria: completionCriteria.length ? completionCriteria : ["交付内容直接回应用户目标", "重要事实由工具结果支持"] };
}
function normalizeAction(raw, tools) {
  const type = ["tool", "finish", "ask_user"].includes(raw?.type) ? raw.type : "finish";
  const action = { type, rationale: String(raw?.rationale || "").slice(0, 300) };
  if (type === "tool") {
    action.toolId = String(raw.toolId || "");
    action.input = raw.input && typeof raw.input === "object" && !Array.isArray(raw.input) ? raw.input : {};
    action.tool = tools.find((tool) => tool.id === action.toolId) || null;
    if (!action.tool) throw new Error(`Planner selected unavailable tool: ${action.toolId || "empty"}`);
  }
  if (type === "ask_user") action.question = String(raw.question || "请补充完成任务所需的信息。").slice(0, 500);
  return action;
}
function normalizeVerification(raw) {
  return { passed: raw?.passed === true, summary: String(raw?.summary || "").slice(0, 500), gaps: (Array.isArray(raw?.gaps) ? raw.gaps : []).map(String).map((item) => item.slice(0, 300)).slice(0, 5), next: ["deliver", "replan", "ask_user"].includes(raw?.next) ? raw.next : raw?.passed ? "deliver" : "replan", question: String(raw?.question || "").slice(0, 500) };
}
function actionFingerprint(action) { return crypto.createHash("sha256").update(action.toolId + ":" + JSON.stringify(action.input || {})).digest("hex").slice(0, 24); }
function observationFingerprint(observation) { return crypto.createHash("sha256").update(observation.toolId + ":" + observation.status + ":" + compactText(observation.data || observation.error || "", 2000)).digest("hex").slice(0, 24); }
function safeFallbackAnswer(task, limited) {
  const successful = task.observations.filter((item) => item.status === "success");
  const evidence = successful.map((item) => `${item.toolId}: ${compactText(item.data, 1200)}`).join("\n");
  return `${limited ? "本次执行已达到运行上限。" : "任务执行完成。"}${evidence ? "\n\n已验证结果：\n" + evidence : "\n\n当前没有足够的工具证据可以给出可靠结论。"}`;
}

async function callPhaseModel(task, deps, phase, prompt) {
  task.metrics.modelCalls += 1;
  if (task.metrics.modelCalls > task.budget.maxModelCalls) throw Object.assign(new Error("PAOVRD model-call budget reached."), { code: "PAOVRD_BUDGET" });
  taskEvent(task, phase, { status: "started" }); deps.persist?.(task);
  const result = await deps.callModel({ phase, prompt, task });
  taskEvent(task, phase, { status: "completed" }); deps.persist?.(task);
  return result;
}
function budgetReached(task, startedAt) {
  return task.metrics.steps >= task.budget.maxSteps || task.metrics.toolCalls >= task.budget.maxToolCalls || Date.now() - startedAt >= task.budget.maxDurationMs;
}

async function deliver(task, deps, limited = false) {
  task.status = limited ? "completed_with_limits" : "delivering";
  try {
    const response = await callPhaseModel(task, deps, "deliver", deliverPrompt(task, limited));
    task.finalAnswer = compactText(response?.content ?? response, 12000);
  } catch (error) {
    task.finalAnswer = safeFallbackAnswer(task, limited) + `\n\n交付模型异常：${String(error.message || error).slice(0, 240)}`;
  }
  task.status = limited ? "completed_with_limits" : "completed";
  taskEvent(task, "deliver", { status: task.status }); deps.persist?.(task);
  return { status: task.status, task, message: task.finalAnswer };
}

async function runPaovrd(task, deps) {
  if (!task || task.type !== "paovrd") throw new Error("A valid PAOVRD task is required.");
  if (TERMINAL_STATUSES.has(task.status)) return { status: task.status, task, message: task.finalAnswer };
  const tools = executableTools(deps.tools || []);
  const startedAt = Date.now();
  task.status = "running";
  try {
    if (!task.plan) {
      task.plan = normalizePlan(parseJsonObject(await callPhaseModel(task, deps, "plan", planPrompt(task, tools))));
      taskEvent(task, "plan", { status: "planned", stepCount: task.plan.steps.length }); deps.persist?.(task);
    }
    while (!budgetReached(task, startedAt)) {
      let action;
      if (task.pendingAction?.approved === true) {
        action = { ...task.pendingAction.action, tool: tools.find((tool) => tool.id === task.pendingAction.action.toolId) };
        task.approvedFingerprints.push(task.pendingAction.fingerprint);
        task.pendingAction = null;
      } else {
        action = normalizeAction(parseJsonObject(await callPhaseModel(task, deps, "act", actionPrompt(task, tools))), tools);
      }
      if (action.type === "ask_user") {
        task.status = "waiting_input"; task.pendingQuestion = action.question;
        taskEvent(task, "replan", { status: "waiting_input", rationale: action.rationale }); deps.persist?.(task);
        return { status: task.status, task, message: action.question };
      }
      if (action.type === "finish") {
        task.verification = normalizeVerification(parseJsonObject(await callPhaseModel(task, deps, "verify", verifyPrompt(task))));
        taskEvent(task, "verify", { status: task.verification.passed ? "passed" : "gaps_found", gaps: task.verification.gaps }); deps.persist?.(task);
        if (task.verification.passed || task.verification.next === "deliver") return deliver(task, deps, false);
        if (task.verification.next === "ask_user") {
          task.status = "waiting_input"; task.pendingQuestion = task.verification.question || "请补充完成任务所需的信息。";
          deps.persist?.(task); return { status: task.status, task, message: task.pendingQuestion };
        }
        if (task.metrics.replans >= task.budget.maxReplans) return deliver(task, deps, true);
        task.metrics.replans += 1;
        task.plan = normalizePlan(parseJsonObject(await callPhaseModel(task, deps, "replan", replanPrompt(task))));
        taskEvent(task, "replan", { status: "planned", replan: task.metrics.replans }); deps.persist?.(task);
        continue;
      }
      const fingerprint = actionFingerprint(action);
      const prior = task.steps.slice(-2).filter((step) => step.fingerprint === fingerprint);
      if (prior.length) {
        task.metrics.noProgress += 1;
        task.observations.push({ step: task.metrics.steps, toolId: action.toolId, status: "blocked_duplicate", error: "Identical tool call was already attempted.", at: nowIso() });
        if (task.metrics.noProgress >= 2) {
          task.status = "waiting_input"; task.pendingQuestion = "任务连续两次没有取得新进展。请补充信息，或明确是否允许调整目标。"; deps.persist?.(task);
          return { status: task.status, task, message: task.pendingQuestion };
        }
        continue;
      }
      if (action.tool.risk !== "read" && !task.approvedFingerprints.includes(fingerprint)) {
        task.status = "waiting_confirmation";
        task.pendingAction = { fingerprint, approved: false, action: { type: "tool", toolId: action.toolId, input: action.input, rationale: action.rationale }, risk: action.tool.risk, toolName: action.tool.name || action.toolId };
        taskEvent(task, "act", { status: "waiting_confirmation", toolId: action.toolId, risk: action.tool.risk }); deps.persist?.(task);
        return { status: task.status, task, pendingAction: task.pendingAction };
      }
      task.metrics.steps += 1; task.metrics.toolCalls += 1;
      taskEvent(task, "act", { status: "executing", toolId: action.toolId, rationale: action.rationale }); deps.persist?.(task);
      const step = { index: task.metrics.steps, toolId: action.toolId, input: action.input, fingerprint, risk: action.tool.risk, rationale: action.rationale, startedAt: nowIso() };
      let observation;
      try {
        const execution = await deps.executeTool(action.toolId, action.input, { task, risk: action.tool.risk });
        observation = { step: step.index, toolId: action.toolId, status: "success", invocationId: execution?.invocationId || "", artifactIds: execution?.artifactIds || [], data: compactText(execution?.data ?? execution, 6000), at: nowIso() };
        step.status = "success";
      } catch (error) {
        observation = { step: step.index, toolId: action.toolId, status: "error", error: String(error?.message || error).slice(0, 1000), code: String(error?.code || "TOOL_ERROR"), at: nowIso() };
        step.status = "error";
      }
      step.completedAt = nowIso(); task.steps.push(step); task.observations.push(observation);
      task.steps = task.steps.slice(-20); task.observations = task.observations.slice(-20);
      const currentObservationFingerprint = observationFingerprint(observation);
      task.metrics.noProgress = task.lastObservationFingerprint === currentObservationFingerprint || observation.status !== "success" ? task.metrics.noProgress + 1 : 0;
      task.lastObservationFingerprint = currentObservationFingerprint;
      taskEvent(task, "observe", { status: observation.status, toolId: action.toolId, invocationId: observation.invocationId || "" }); deps.persist?.(task);
    }
    task.verification = { passed: false, summary: "Runtime budget reached before verified completion.", gaps: ["执行步数、工具调用次数或运行时间达到上限"], next: "deliver", question: "" };
    return deliver(task, deps, true);
  } catch (error) {
    if (error.code === "PAOVRD_BUDGET") return deliver(task, deps, true);
    task.status = "failed"; task.error = String(error?.message || error).slice(0, 1000);
    taskEvent(task, task.phase || "failed", { status: "failed", error: task.error }); deps.persist?.(task);
    return { status: task.status, task, message: `任务执行失败：${task.error}` };
  }
}

function approvePendingAction(task) {
  if (!task?.pendingAction || task.status !== "waiting_confirmation") return false;
  task.pendingAction.approved = true; task.status = "running"; task.updatedAt = nowIso(); return true;
}
function rejectPendingAction(task, reason = "用户取消了待执行动作。") {
  if (!task?.pendingAction || task.status !== "waiting_confirmation") return false;
  task.status = "cancelled"; task.error = reason; task.pendingAction = null; taskEvent(task, "act", { status: "cancelled" }); return true;
}
function resumeWithUserInput(task, text) {
  if (!task || task.status !== "waiting_input") return false;
  task.userInputs.push({ at: nowIso(), text: String(text || "").slice(0, 3000) }); task.userInputs = task.userInputs.slice(-10);
  task.pendingQuestion = ""; task.status = "running"; task.phase = "replan"; task.updatedAt = nowIso(); return true;
}

module.exports = { RUNTIME_VERSION, DEFAULT_BUDGET, createPaovrdTask, shouldUsePaovrd, executableTools, runPaovrd, approvePendingAction, rejectPendingAction, resumeWithUserInput, compactText };
