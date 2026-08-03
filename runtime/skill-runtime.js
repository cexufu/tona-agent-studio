const FEISHU_SYSTEM_SKILLS = [
  {
    id: "feishu_document_operator",
    name: "飞书文档操作",
    description: "判断何时读取、创建或更新飞书文档，并使用原生标题、列表、待办、代码块与表格交付。",
    system: true,
    builtIn: true,
    templateVersion: 1,
    enabled: true,
    activationKeywords: ["飞书文档", "云文档", "创建文档", "读取文档", "修改文档", "写入文档", "整理成文档"],
    triggerExamples: ["创建一份飞书文档", "读取这个云文档并总结", "把结论整理成飞书文档"],
    requiredCapabilities: ["read_feishu_docs", "write_feishu_docs"],
    runtimeInstructions: "只有用户明确要求读取或交付文档，或任务确实需要可复用长文产物时才使用。读取必须有明确文档目标；写入必须先确认。若缺权限，暂停原任务并申请对应权限，授权后从断点继续。",
    inputType: "text",
    steps: [{ agentId: "daily_assistant", task: "Clarify the document goal, select read or write, preserve evidence boundaries, and use native Feishu document structure." }]
  },
  {
    id: "feishu_calendar_meeting",
    name: "飞书日历与会议",
    description: "读取日历、规划会议，并在用户确认和个人 OAuth 授权后创建、调整或取消日程。",
    system: true,
    builtIn: true,
    templateVersion: 1,
    enabled: true,
    activationKeywords: ["日历", "日程", "会议", "预约", "改期", "参会人", "空闲时间"],
    triggerExamples: ["帮我安排会议", "看看我的日历", "把会议改到下周", "邀请参会人"],
    requiredCapabilities: ["read_calendar", "write_calendar", "contacts_directory"],
    runtimeInstructions: "先解析时间、时区、持续时间、参会人和目标。缺少关键字段时只问最重要的问题。读取需要个人授权；创建、修改、取消和邀请必须展示变更并确认。缺权限时申请权限并保留原任务。",
    inputType: "text",
    steps: [{ agentId: "daily_assistant", task: "Resolve meeting intent and required fields, then plan the minimum confirmed calendar action." }]
  },
  {
    id: "feishu_reminder_messaging",
    name: "飞书提醒与主动消息",
    description: "创建一次性或周期提醒，并在约定时间向原会话主动发送信息。",
    system: true,
    builtIn: true,
    templateVersion: 1,
    enabled: true,
    activationKeywords: ["提醒", "闹钟", "倒计时", "定时", "稍后告诉我", "主动发送", "每天", "每周"],
    triggerExamples: ["半小时后提醒我", "每天九点发日报提醒", "周五提醒我提交材料"],
    requiredCapabilities: ["proactive_message"],
    runtimeInstructions: "必须得到具体时间或可解析延迟、时区、接收会话和提醒内容。发送或创建定时任务前必须确认；到期后只发送一次，除非用户明确要求周期任务。",
    inputType: "text",
    steps: [{ agentId: "daily_assistant", task: "Resolve schedule and delivery target, confirm the reminder, and preserve an idempotent task receipt." }]
  },
  {
    id: "feishu_tables_tasks",
    name: "飞书表格与任务",
    description: "读取或更新电子表格、多维表格和飞书任务，并保留目标范围与变更摘要。",
    system: true,
    builtIn: true,
    templateVersion: 1,
    enabled: true,
    activationKeywords: ["飞书表格", "电子表格", "多维表格", "飞书任务", "待办", "负责人", "写入表格", "更新表格"],
    triggerExamples: ["把结果写入飞书表格", "创建飞书任务", "更新多维表格记录"],
    requiredCapabilities: ["sheets_data", "bitable_data", "task_management"],
    runtimeInstructions: "读取只访问用户明确指定的资源。写入前展示目标文件、工作表或数据表、范围、字段和变更摘要；创建或指派任务前确认负责人和截止时间。执行器或权限不可用时申请能力，不得声称已经完成。",
    inputType: "text",
    steps: [{ agentId: "daily_assistant", task: "Identify the exact Feishu resource, requested mutation, owner and confirmation boundary." }]
  },
  {
    id: "feishu_permission_recovery",
    name: "飞书权限申请与任务恢复",
    description: "工具缺少权限时生成申请卡片，保留原任务，并在批准或授权完成后继续执行。",
    system: true,
    builtIn: true,
    templateVersion: 1,
    enabled: true,
    activationKeywords: ["权限", "授权", "没有权限", "开通能力", "申请权限"],
    triggerExamples: ["申请文档权限", "没有日历权限怎么办", "授权后继续任务"],
    requiredCapabilities: [],
    runtimeInstructions: "权限不足不是任务失败。记录原任务、目标工具、所需权限、请求人、机器人和会话，向任务所有人发送权限申请卡片。不得把用户确认等同于飞书后台已经授权；批准后重试原任务，真实权限仍不足则继续阻塞并说明下一步。",
    inputType: "text",
    steps: [{ agentId: "daily_assistant", task: "Explain the minimum permission, preserve the suspended task, and resume only after approval or verified authorization." }]
  }
];

function normalize(value) { return String(value || "").toLowerCase().replace(/\s+/g, ""); }

function skillEligible(skill, agent) {
  if (!skill || skill.enabled === false) return false;
  if (skill.system === true) return true;
  if ((skill.steps || []).some((step) => step.agentId === agent?.id)) return true;
  return (agent?.skills || []).some((tag) => tag === skill.id || normalize(skill.name).includes(normalize(tag)));
}

function skillScore(skill, text) {
  const source = normalize(text);
  if (!source) return 0;
  const candidates = [...(skill.activationKeywords || []), ...(skill.triggerExamples || []), skill.name]
    .map(normalize).filter((item) => item.length >= 2);
  let score = 0;
  for (const candidate of candidates) {
    if (source.includes(candidate)) score += Math.max(2, Math.min(8, candidate.length));
    else for (const token of candidate.split(/[，。；、:：/|]/).filter((item) => item.length >= 2)) if (source.includes(token)) score += 1;
  }
  return score;
}

function selectApplicableSkills({ workflows = [], agent, text, limit = 3 }) {
  return workflows
    .filter((skill) => skillEligible(skill, agent))
    .map((skill) => ({ skill, score: skillScore(skill, text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.skill.id).localeCompare(String(b.skill.id)))
    .slice(0, limit)
    .map((item) => item.skill);
}

function skillContext(skills = []) {
  if (!skills.length) return "";
  const rows = skills.map((skill) => {
    const capabilities = (skill.requiredCapabilities || []).join(", ") || "none";
    return `Skill ${skill.id} (${skill.name})\nPurpose: ${skill.description}\nRequired capabilities: ${capabilities}\nRules: ${skill.runtimeInstructions || "Follow the configured workflow and quality contract."}`;
  });
  return [
    "Selected Skills for this request:",
    ...rows,
    "Skills guide decisions but never prove that a tool exists or an action succeeded. Use only Runtime-provided tools. If a required capability or permission is unavailable, preserve the task and request it instead of improvising."
  ].join("\n\n");
}

module.exports = { FEISHU_SYSTEM_SKILLS, selectApplicableSkills, skillContext, skillScore };
