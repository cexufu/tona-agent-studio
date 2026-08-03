const ACTION_TYPES = new Set([
  "reply",
  "web_search",
  "feishu_document_create",
  "feishu_calendar_plan",
  "schedule_reminder",
  "multi_agent_collaboration",
  "request_capability"
]);

const UNIVERSAL_CAPABILITIES = [
  { id: "web_search", name: "联网搜索", status: "ready", risk: "read", description: "Search the public web and return traceable sources." },
  { id: "feishu_document_read", name: "读取飞书文档", status: "authorization_required", risk: "read", description: "Read one explicitly provided Feishu document after the required authorization is available." },
  { id: "feishu_document_create", name: "创建飞书文档", status: "ready", risk: "write_confirm", description: "Create a new Feishu document after requester confirmation." },
  { id: "feishu_calendar_plan", name: "日历与日程", status: "authorization_required", risk: "write_confirm", description: "Prepare a calendar action and request confirmation; actual personal calendar writing requires OAuth." },
  { id: "schedule_reminder", name: "定时提醒与主动消息", status: "ready", risk: "send_confirm", description: "Schedule one proactive reminder to the current Feishu chat." },
  { id: "multi_agent_collaboration", name: "多机器人协作与原生 @", status: "ready", risk: "controlled_send", description: "Select relevant configured agents for a bounded Feishu collaboration." },
  { id: "sheets_data", name: "飞书电子表格", status: "permission_required", risk: "write_confirm", description: "Read or update a specified Feishu spreadsheet after permission and change confirmation." },
  { id: "task_management", name: "飞书任务", status: "permission_required", risk: "write_confirm", description: "Create or update Feishu tasks after permission and confirmation." }
];

function needsCapabilityPlanning(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return /(提醒|闹钟|倒计时|定时|稍后|每天|每周|日历|日程|会议|预约|安排|创建|生成|写入|修改|更新|发送|通知|转告|文档|报告|表格|多维表格|任务|计划|规划|分工|协作|协同|讨论|会商|@|联网|搜索|查找|调研|权限|授权)/i.test(value);
}

function relativeReminderAction(text, now = Date.now()) {
  const value = String(text || "");
  const match = value.match(/(\d{1,4})\s*(秒钟?|分钟?|小时|天)后/u);
  if (!match) return null;
  const amount = Number(match[1]);
  const scale = match[2].startsWith("秒") ? 1000 : match[2].startsWith("分") ? 60_000 : match[2] === "小时" ? 3_600_000 : 86_400_000;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const runAt = new Date(now + amount * scale).toISOString();
  const reminderText = value
    .replace(/^(?:请)?(?:帮我)?/u, "")
    .replace(match[0], "")
    .replace(/^(?:提醒我|提醒|闹钟|定时)[：:\s]*/u, "")
    .trim() || "你设置的提醒时间到了。";
  return { type: "schedule_reminder", reason: "用户明确要求在相对时间后提醒。", runAt, reminderText: reminderText.slice(0, 500) };
}

function fallbackCapabilityPlan({ text, agents = [], currentAgentId = "", now = Date.now() }) {
  const value = String(text || "");
  const actions = [];
  const reminder = relativeReminderAction(value, now);
  if (reminder) actions.push(reminder);
  if (/(?:生成|创建|新建|产出).{0,8}(?:飞书)?文档|(?:飞书)?文档.{0,8}(?:生成|创建|新建|产出)/u.test(value)) {
    actions.push({ type: "feishu_document_create", reason: "用户明确要求创建飞书文档。", task: value.slice(0, 1200) });
  }
  if (/(?:安排|预约|创建|加入|修改|改期|取消).{0,12}(?:会议|日程|日历)|(?:会议|日程|日历).{0,12}(?:安排|预约|创建|修改|改期|取消)/u.test(value)) {
    actions.push({ type: "feishu_calendar_plan", reason: "用户明确要求处理日程或会议。", task: value.slice(0, 1200) });
  }
  if (/(?:协作|协同|多机器人|多AI|讨论|会商|分工)/i.test(value)) {
    const relevant = agents.filter((agent) => agent.id !== currentAgentId && (value.includes(agent.name) || value.includes(agent.id))).map((agent) => agent.id);
    actions.push({ type: "multi_agent_collaboration", reason: "用户要求多个角色共同推进任务。", targetAgentIds: relevant.slice(0, 4), rounds: 2 });
  }
  if (/(?:写入|更新|修改|调整).{0,10}(?:多维)?表格/u.test(value)) {
    actions.push({ type: "request_capability", reason: "表格写入执行器尚需权限与目标范围。", capabilityId: /多维表格/u.test(value) ? "bitable_data" : "sheets_data" });
  }
  if (/(?:创建|更新|指派|安排).{0,10}(?:飞书)?任务/u.test(value) && !reminder) {
    actions.push({ type: "request_capability", reason: "飞书任务执行器尚需权限。", capabilityId: "task_management" });
  }
  return { intent: actions.length ? "action" : "reply", presentation: actions.some((item) => item.type.includes("document")) ? "document" : actions.length ? "card" : "chat", summary: "", actions: actions.slice(0, 3), source: "fallback" };
}

function plannerPrompt({ text, agents = [], currentAgentId = "", timeZone = "UTC", now = new Date().toISOString() }) {
  const roster = agents.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role, hasFeishuBot: Boolean(agent.hasFeishuBot) }));
  return [
    "You are TONA's universal capability planner. You do not answer the user and you never claim an action succeeded.",
    "Return one JSON object only, without Markdown or commentary.",
    `Current time: ${now}. User time zone: ${timeZone}. Current agent: ${currentAgentId}.`,
    `Configured agent roster: ${JSON.stringify(roster)}.`,
    `Universal capabilities: ${JSON.stringify(UNIVERSAL_CAPABILITIES)}.`,
    "Output schema: {intent:'reply|action',presentation:'chat|card|document|table',summary:string,actions:Array<{type:string,reason:string,task?:string,query?:string,runAt?:string,reminderText?:string,targetAgentIds?:string[],rounds?:number,capabilityId?:string}>}.",
    "Rules: use at most 3 actions. Select an action only when it materially advances the explicit request. Read-only tools may run automatically. Any write, send, schedule, invite, modify or delete action must go through platform confirmation. Use feishu_document_create only for an explicitly requested or clearly reusable long-form deliverable. Use schedule_reminder only when a concrete time or delay is present; runAt must be an ISO timestamp. Use multi_agent_collaboration only when distinct configured roles add value; select only relevant agents that have a Feishu bot, never every agent by default. Use request_capability for sheets_data, bitable_data or task_management because those executors are not ready. If a person cannot be resolved from the roster or explicit Feishu mentions, leave the action out and let the agent ask for clarification. Never invent tool availability, targets, permissions, URLs or completion.",
    `User request: ${String(text || "").slice(0, 5000)}`
  ].join("\n\n");
}

function extractJsonObject(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Capability planner returned no JSON object.");
  return JSON.parse(text.slice(start, end + 1));
}

function parseCapabilityPlan(value, { validAgentIds = [], now = Date.now() } = {}) {
  const raw = typeof value === "string" ? extractJsonObject(value) : value;
  const validIds = new Set(validAgentIds);
  const actions = [];
  for (const candidate of Array.isArray(raw?.actions) ? raw.actions : []) {
    const type = String(candidate?.type || "").trim();
    if (!ACTION_TYPES.has(type) || type === "reply") continue;
    const action = { type, reason: String(candidate.reason || "").slice(0, 300) };
    if (candidate.task) action.task = String(candidate.task).slice(0, 2000);
    if (candidate.query) action.query = String(candidate.query).slice(0, 1000);
    if (candidate.reminderText) action.reminderText = String(candidate.reminderText).slice(0, 500);
    if (candidate.capabilityId) action.capabilityId = String(candidate.capabilityId).slice(0, 80);
    if (Array.isArray(candidate.targetAgentIds)) action.targetAgentIds = [...new Set(candidate.targetAgentIds.map(String).filter((id) => validIds.has(id)))].slice(0, 4);
    if (type === "multi_agent_collaboration") action.rounds = Math.min(3, Math.max(1, Number(candidate.rounds) || 2));
    if (type === "schedule_reminder") {
      const runAtMs = Date.parse(candidate.runAt);
      if (!Number.isFinite(runAtMs) || runAtMs < now + 5_000 || runAtMs > now + 366 * 86_400_000) continue;
      action.runAt = new Date(runAtMs).toISOString();
      if (!action.reminderText) action.reminderText = action.task || "你设置的提醒时间到了。";
    }
    actions.push(action);
    if (actions.length >= 3) break;
  }
  return {
    intent: actions.length ? "action" : "reply",
    presentation: ["chat", "card", "document", "table"].includes(raw?.presentation) ? raw.presentation : actions.length ? "card" : "chat",
    summary: String(raw?.summary || "").slice(0, 500),
    actions,
    source: "model"
  };
}

module.exports = {
  UNIVERSAL_CAPABILITIES,
  needsCapabilityPlanning,
  relativeReminderAction,
  fallbackCapabilityPlan,
  plannerPrompt,
  parseCapabilityPlan
};
