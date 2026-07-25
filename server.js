const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { AsyncLocalStorage } = require("async_hooks");

const PORT = Number(process.env.PORT || 7357);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const ROOT_RUNS_DIR = path.join(DATA_DIR, "runs");
const ROOT_DB_PATH = path.join(DATA_DIR, "studio.json");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const workspaceContext = new AsyncLocalStorage();
const collaborationPilotLocks = new Set();
const HUB_AUTH_REQUIRED = process.env.TONA_HUB_AUTH_REQUIRED === "true";
const TEAMFLOW_INTERNAL_PORT = Number(process.env.TEAMFLOW_INTERNAL_PORT || 7359);
const LEGACY_OWNER_ID = process.env.TONA_LEGACY_OWNER_ID || "usr_owner";
const ERROR_LOG_PATH = path.join(DATA_DIR, "tona-server-error.log");
const FEISHU_OPEN_API_BASE = String(process.env.FEISHU_OPEN_API_BASE || "https://open.feishu.cn/open-apis").replace(/\/+$/, "");
function logServerError(error) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const message = error && error.stack ? error.stack : String(error);
    fs.appendFileSync(ERROR_LOG_PATH, `[${new Date().toISOString()}] ${message}\n\n`);
  } catch {}
}
process.on("uncaughtException", (error) => {
  logServerError(error);
  console.error(error);
});
process.on("unhandledRejection", (error) => {
  logServerError(error);
  console.error(error);
});

const DEFAULT_DB = {
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      type: "openai_compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      defaultModel: "gpt-4.1-mini",
      models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
      enabled: false,
      notes: "Paste your OpenAI key to enable."
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      type: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      apiKey: "",
      defaultModel: "deepseek-chat",
      models: ["deepseek-chat", "deepseek-reasoner"],
      enabled: false,
      notes: "OpenAI-compatible endpoint."
    },
    {
      id: "kimi",
      name: "Kimi / Moonshot",
      type: "openai_compatible",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "",
      defaultModel: "kimi-k3",
      models: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
      enabled: false,
      notes: "Kimi K2 legacy names are retired. Use kimi-k3 for general work or kimi-k2.7-code for code work when your key has access."
    },
    {
      id: "doubao",
      name: "Doubao / Volcengine Ark",
      type: "openai_compatible",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "",
      defaultModel: "doubao-seed-1-6",
      models: ["doubao-seed-1-6", "doubao-seed-1-6-thinking"],
      enabled: false,
      notes: "Use your Ark endpoint model name if different."
    }
  ],
  agents: [
    {
      id: "researcher",
      name: "Researcher",
      role: "Academic and strategic research assistant.",
      style: "Clear, structured, evidence-aware, careful with uncertainty.",
      goals: "Summarize complex material, extract key claims, identify concepts, and find implications.",
      guardrails: "Do not invent citations. Mark uncertainty. Avoid vague advice.",
      outputFormat: "# Research Memo\n## 1. Core Question\n## 2. Main Points\n## 3. Key Concepts\n## 4. Important Evidence\n## 5. Implications\n## 6. Open Questions",
      providerId: "openai",
      model: "gpt-4.1-mini",
      temperature: 0.3,
      skills: ["read_text", "summarize", "save_output"]
    },
    {
      id: "critic",
      name: "Critic",
      role: "Reviewer and red-team critic.",
      style: "Precise, direct, constructive, minimal drama.",
      goals: "Identify weak logic, unsupported claims, vague concepts, and execution risks.",
      guardrails: "Do not rewrite everything. Suggest minimal corrections.",
      outputFormat: "# Critical Review\n## 1. Biggest Weakness\n## 2. Unsupported Claims\n## 3. Conceptual Confusion\n## 4. Execution Risks\n## 5. Suggested Fixes",
      providerId: "deepseek",
      model: "deepseek-chat",
      temperature: 0.2,
      skills: ["critique", "save_output"]
    },
    {
      id: "editor",
      name: "Editor",
      role: "Editor for polished final output.",
      style: "Concise, coherent, useful, polished.",
      goals: "Rewrite for clarity, convert notes into structured writing, and produce final memos or content drafts.",
      guardrails: "Preserve important nuance. Do not over-market the result.",
      outputFormat: "# Final Memo\n## Summary\n## Key Takeaways\n## Recommended Next Steps",
      providerId: "openai",
      model: "gpt-4.1-mini",
      temperature: 0.4,
      skills: ["rewrite", "finalize", "save_output"]
    }
  ],
  workflows: [
    {
      id: "material_to_memo",
      name: "Material to Memo",
      description: "Convert raw material into a structured research or strategy memo.",
      inputType: "text",
      steps: [
        { agentId: "researcher", task: "Summarize the material and extract the core argument." },
        { agentId: "critic", task: "Review the previous output and identify weak logic, unsupported claims, and risks." },
        { agentId: "editor", task: "Produce a polished final memo using the source material and previous agent outputs." }
      ],
      outputMode: "markdown"
    },
    {
      id: "material_to_content",
      name: "Material to Content",
      description: "Convert notes into title options, a short post, and a long-form outline.",
      inputType: "text",
      steps: [
        { agentId: "researcher", task: "Extract the strongest ideas and angles from the material." },
        { agentId: "critic", task: "Evaluate whether each angle is too vague, obvious, risky, or unsupported." },
        { agentId: "editor", task: "Generate 5 title options, 1 short post, and 1 long post outline." }
      ],
      outputMode: "markdown"
    }
  ],
  settings: {
    defaultProviderId: "openai",
    modelStrategy: "agent_default",
    saveInputs: false,
    requireWriteConfirmation: true
  }
};


const PERSONAL_AGENT_TEMPLATES = [
  {
    id: "daily_assistant",
    name: "日常助理",
    role: "你的日常主力助理，负责会议安排、日程协调、日历提醒、信息互动、任务拆解，并帮助协调和管理其他专业机器人。",
    style: "中文为主，自然、可靠、轻量、主动澄清。像一个长期协作的私人助理，不端着，不输出无谓报告。",
    goals: "快速理解用户意图；把模糊事项变成下一步行动；需要科研、数据、代码、职业、传播等专业能力时，建议交给对应角色。",
    guardrails: "不要编造日历或外部事实；没有接入真实日历时要说明只能帮用户整理和生成日程建议；涉及重要安排要复述确认。",
    outputFormat: "默认 1-3 段中文短回复；需要时给简短清单。",
    providerId: "deepseek",
    model: "deepseek-chat",
    temperature: 0.45,
    skills: ["daily", "chat"]
  },
  {
    id: "research_assistant",
    name: "科研助理",
    role: "你的科研讨论与研究分析助理，支持科学问题探讨、文献理解、研究设计、理论分析、论文想法打磨。",
    style: "中文为主，严谨、启发式、证据意识强，区分事实、推断和猜想。",
    goals: "帮助提出研究问题、拆解机制、比较理论、评估方法、识别创新点与风险，并生成可继续推进的研究计划。",
    guardrails: "不伪造文献和引用；信息不足时主动说明不确定性；不要把闲聊硬写成科研报告。",
    outputFormat: "日常讨论用自然中文；明确要求分析时使用：核心判断、依据、可能反例、下一步。",
    providerId: "deepseek",
    model: "deepseek-chat",
    temperature: 0.45,
    skills: ["research", "chat"]
  },
  {
    id: "data_assistant",
    name: "数据助理",
    role: "你的数据分析、数学计算、统计解释和建模助理。",
    style: "中文为主，步骤清楚，重视可复现和单位、假设、边界条件。",
    goals: "帮助做数学题、统计推断、数据清洗思路、可视化方案、指标设计、结果解释。",
    guardrails: "不能真实运行数据时要说明；计算题要展示关键步骤；不要把近似值说成精确事实。",
    outputFormat: "先给结论，再给关键步骤；复杂问题给公式/伪代码/表格。",
    providerId: "deepseek",
    model: "deepseek-chat",
    temperature: 0.25,
    skills: ["data", "chat"]
  },
  {
    id: "coding_assistant",
    name: "代码助理",
    role: "你的代码写作与编程学习助理，支持 debug、架构讨论、代码解释、编程教学和项目推进。",
    style: "中文为主，工程化、耐心、具体，能用例子教学。",
    goals: "帮助写代码、解释代码、定位 bug、设计模块、规划学习路径，并把复杂概念讲清楚。",
    guardrails: "不要假装看过未提供的代码；高风险命令要提醒；优先给可运行、可验证的方案。",
    outputFormat: "默认简洁说明 + 必要代码块；教学时按步骤解释。",
    providerId: "deepseek",
    model: "deepseek-chat",
    temperature: 0.25,
    skills: ["coding", "chat"]
  },
  {
    id: "fortune_assistant",
    name: "算命助理",
    role: "你的轻娱乐式命理、占星、八字、塔罗和人生叙事助理。",
    style: "中文为主，温和、有趣、富有象征感，但不制造恐惧。",
    goals: "用命理/占卜语言帮助用户做自我反思、情绪梳理和选择观察。",
    guardrails: "明确这是娱乐和反思，不作为医疗、法律、投资等重大决策依据；不做恐吓式断言。",
    outputFormat: "先给一句总体感觉，再给 3-5 点解读和一个现实建议。",
    providerId: "deepseek",
    model: "deepseek-chat",
    temperature: 0.65,
    skills: ["fortune", "chat"]
  },
  {
    id: "career_assistant",
    name: "职业助理",
    role: "你的创业、学业、职业发展和人生战略助理。",
    style: "中文为主，务实、战略性、鼓励但不鸡血。",
    goals: "支持博士规划、职业路径、创业想法、简历/申请材料、机会判断、长期定位和短期行动。",
    guardrails: "不做过度承诺；涉及重大选择时呈现权衡；区分事实、判断和建议。",
    outputFormat: "默认：判断、机会、风险、下一步行动。",
    providerId: "deepseek",
    model: "deepseek-chat",
    temperature: 0.45,
    skills: ["career", "chat"]
  },
  {
    id: "media_assistant",
    name: "传播助理",
    role: "你的小红书、公众号、短内容和个人 IP 传播助理。",
    style: "中文为主，有网感但不油腻，重视真实表达、标题张力和读者视角。",
    goals: "帮助做选题、标题、开头、结构、改写、系列内容规划和发布策略。",
    guardrails: "不编造经历；避免低质标题党；保留用户个人气质和学术可信度。",
    outputFormat: "默认给：选题角度、标题备选、开头、正文结构、发布建议。",
    providerId: "deepseek",
    model: "deepseek-chat",
    temperature: 0.65,
    skills: ["media", "chat"]
  }
];

const CUSTOMER_DEFAULT_AGENT_IDS = new Set(["daily_assistant", "research_assistant", "coding_assistant"]);
function createInitialDb() {
  const db = JSON.parse(JSON.stringify(DEFAULT_DB));
  const workspaceId = activeWorkspaceId();
  const isCustomerWorkspace = Boolean(workspaceId && workspaceId !== LEGACY_OWNER_ID);
  if (isCustomerWorkspace) {
    db.agents = PERSONAL_AGENT_TEMPLATES.filter((agent) => CUSTOMER_DEFAULT_AGENT_IDS.has(agent.id));
    db.workflows = [];
  } else {
    const existingIds = new Set(PERSONAL_AGENT_TEMPLATES.map((agent) => agent.id));
    db.agents = [...PERSONAL_AGENT_TEMPLATES, ...db.agents.filter((agent) => !existingIds.has(agent.id))];
  }
  db.settings = { ...db.settings, defaultProviderId: "deepseek", botConversationMaxRounds: 10, larkBots: [], collaborationPolicy: defaultCollaborationPolicy(db.agents), collaborationTasks: [] };
  return db;
}

function activeWorkspaceId() {
  const workspaceId = workspaceContext.getStore()?.workspaceId || "";
  return /^[a-zA-Z0-9_-]{3,80}$/.test(workspaceId) ? workspaceId : "";
}

function storagePaths() {
  const workspaceId = activeWorkspaceId();
  if (!workspaceId) return { dbPath: ROOT_DB_PATH, runsDir: ROOT_RUNS_DIR, usagePath: path.join(DATA_DIR, "model-usage.jsonl") };
  const directory = path.join(WORKSPACES_DIR, workspaceId);
  return { dbPath: path.join(directory, "studio.json"), runsDir: path.join(directory, "runs"), usagePath: path.join(directory, "model-usage.jsonl") };
}

function ensureStore() {
  const { dbPath, runsDir } = storagePaths();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    const workspaceId = activeWorkspaceId();
    if (workspaceId === LEGACY_OWNER_ID && fs.existsSync(ROOT_DB_PATH)) {
      fs.copyFileSync(ROOT_DB_PATH, dbPath);
    } else {
      fs.writeFileSync(dbPath, JSON.stringify(createInitialDb(), null, 2));
    }
  }
}

// TONA_SECRETS_ENCRYPTION_V1: encrypt credentials at rest when the Render master key is configured.
const SECRET_FIELDS = new Set(['apiKey', 'larkWebhookSecret', 'larkAppSecret', 'larkVerificationToken', 'larkEncryptKey', 'appSecret', 'verificationToken', 'encryptKey']);
function secretsKey() {
  const source = String(process.env.TONA_SECRETS_KEY || '');
  return source.length >= 24 ? crypto.createHash('sha256').update(source).digest() : null;
}
function encryptSecretAtRest(value) {
  if (!value || String(value).startsWith('enc:v1:')) return value;
  const key = secretsKey(); if (!key) return value;
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]); const tag = cipher.getAuthTag();
  return 'enc:v1:' + Buffer.concat([iv, tag, data]).toString('base64');
}
function decryptSecretAtRest(value) {
  if (!String(value || '').startsWith('enc:v1:')) return value;
  const key = secretsKey(); if (!key) throw new Error('Encrypted credentials require TONA_SECRETS_KEY on this server.');
  const raw = Buffer.from(String(value).slice(7), 'base64'); const iv = raw.subarray(0, 12); const tag = raw.subarray(12, 28); const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
function transformSecrets(value, transform) {
  if (Array.isArray(value)) return value.map(item => transformSecrets(item, transform));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = SECRET_FIELDS.has(key) ? transform(item) : transformSecrets(item, transform);
  return copy;
}
const KIMI_RETIRED_MODEL_IDS = new Set(["kimi-k2", "kimi-k2-0905-preview", "kimi-k2-0711-preview", "kimi-k2-turbo-preview", "kimi-k2-thinking", "kimi-k2-thinking-turbo"]);
const KIMI_RECOMMENDED_MODELS = ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"];
function migrateRetiredKimiModels(db) {
  const provider = (db.providers || []).find((item) => item.id === "kimi");
  if (!provider) return false;
  let changed = false;
  if (KIMI_RETIRED_MODEL_IDS.has(String(provider.defaultModel || ""))) { provider.defaultModel = "kimi-k3"; changed = true; }
  const mergedModels = [...new Set([...(provider.models || []).filter((model) => !KIMI_RETIRED_MODEL_IDS.has(String(model))), ...KIMI_RECOMMENDED_MODELS])];
  if (JSON.stringify(mergedModels) !== JSON.stringify(provider.models || [])) { provider.models = mergedModels; changed = true; }
  for (const agent of db.agents || []) {
    if (agent.providerId === "kimi" && KIMI_RETIRED_MODEL_IDS.has(String(agent.model || ""))) { agent.model = "kimi-k3"; changed = true; }
  }
  return changed;
}
function readDb() {
  ensureStore();
  const db = transformSecrets(JSON.parse(fs.readFileSync(storagePaths().dbPath, "utf8")), decryptSecretAtRest);
  if (migrateRetiredKimiModels(db)) writeDb(db);
  return db;
}
function writeDb(db) {
  ensureStore();
  fs.writeFileSync(storagePaths().dbPath, JSON.stringify(transformSecrets(db, encryptSecretAtRest), null, 2));
}

function publicDb(db) {
  const settings = db.settings || {};
  const { collaborationTasks, groupKnowledge, skillRequests, ...safeSettings } = settings;
  return {
    ...db,
    providers: db.providers.map((provider) => ({
      ...provider,
      apiKey: provider.apiKey ? maskKey(provider.apiKey) : ""
    })),
    settings: {
      ...safeSettings,
      collaborationPolicy: normalizeCollaborationPolicy(settings.collaborationPolicy, db.agents),
      larkWebhookSecret: settings.larkWebhookSecret ? maskSecret(settings.larkWebhookSecret) : "",
      larkAppSecret: settings.larkAppSecret ? maskSecret(settings.larkAppSecret) : "",
      larkVerificationToken: settings.larkVerificationToken ? maskSecret(settings.larkVerificationToken) : "",
      larkEncryptKey: settings.larkEncryptKey ? maskSecret(settings.larkEncryptKey) : "",
      larkBots: (settings.larkBots || []).map((bot) => ({
        ...bot,
        appSecret: bot.appSecret ? maskSecret(bot.appSecret) : "",
        verificationToken: bot.verificationToken ? maskSecret(bot.verificationToken) : "",
        encryptKey: bot.encryptKey ? maskSecret(bot.encryptKey) : ""
      }))
    }
  };
}

function maskSecret(secret) {
  if (!secret) return "";
  if (secret.length <= 8) return "********";
  return secret.slice(0, 3) + "..." + secret.slice(-3);
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

// Public API values are masked (for example, abc...xyz). Never save a mask back over the real credential.
function isMaskedSecretValue(value) {
  const text = String(value || "").trim();
  return !text || /^\*+$/.test(text) || /^.{3}\.\.\..{3}$/.test(text);
}
function incomingSecretValue(value, existing) {
  return isMaskedSecretValue(value) ? (existing || "") : String(value).trim();
}

const COLLABORATION_MAX_PARTICIPANTS = 5;
const COLLABORATION_MAX_MESSAGES = 10;
const GROUP_KNOWLEDGE_MAX_PER_CHAT = 500;
const GROUP_KNOWLEDGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function groupKnowledgeEntries(db) {
  db.settings ||= {};
  db.settings.groupKnowledge = Array.isArray(db.settings.groupKnowledge) ? db.settings.groupKnowledge : [];
  return db.settings.groupKnowledge;
}

function rememberGroupKnowledge(db, message) {
  if (message.chatType !== "group" || !message.messageId || !message.text) return false;
  const now = Date.now();
  const entries = groupKnowledgeEntries(db).filter((item) => Date.parse(item.at || 0) >= now - GROUP_KNOWLEDGE_MAX_AGE_MS);
  if (entries.some((item) => item.chatId === message.chatId && item.messageId === message.messageId)) return false;
  entries.push({ chatId: message.chatId, messageId: message.messageId, senderId: message.senderId || "", text: String(message.text).slice(0, 4000), at: new Date().toISOString() });
  const perChat = new Map();
  db.settings.groupKnowledge = entries.slice().reverse().filter((item) => {
    const count = perChat.get(item.chatId) || 0;
    if (count >= GROUP_KNOWLEDGE_MAX_PER_CHAT) return false;
    perChat.set(item.chatId, count + 1);
    return true;
  }).reverse().slice(-5000);
  writeDb(db);
  return true;
}

function groupKnowledgeContext(db, message) {
  if (message.chatType !== "group" || !message.chatId) return "";
  return groupKnowledgeEntries(db).filter((item) => item.chatId === message.chatId && item.messageId !== message.messageId).slice(-20).map((item) => "[Group context] " + item.text).join("\n").slice(-10000);
}

function defaultCollaborationPolicy(agents = []) {
  const ids = agents.map((agent) => agent.id);
  const coordinatorAgentId = ids.includes("daily_assistant") ? "daily_assistant" : (ids[0] || "");
  const writerAgentId = ids.includes("research_assistant") ? "research_assistant" : (coordinatorAgentId || ids[0] || "");
  const participantAgentIds = [coordinatorAgentId, ...ids.filter((id) => id !== coordinatorAgentId)].filter(Boolean).slice(0, COLLABORATION_MAX_PARTICIPANTS);
  if (writerAgentId && !participantAgentIds.includes(writerAgentId) && participantAgentIds.length < COLLABORATION_MAX_PARTICIPANTS) participantAgentIds.push(writerAgentId);
  return { enabled: true, coordinatorAgentId, writerAgentId, participantAgentIds, maxMessages: COLLABORATION_MAX_MESSAGES, decisionMakerOpenIds: [], requireCollaborationKeyword: true, allowBotHandoffs: true, requireWriteConfirmation: true };
}

function normalizeCollaborationPolicy(value, agents = []) {
  const fallback = defaultCollaborationPolicy(agents);
  const validIds = new Set(agents.map((agent) => agent.id));
  const raw = value && typeof value === "object" ? value : {};
  const selected = Array.isArray(raw.participantAgentIds) ? raw.participantAgentIds : fallback.participantAgentIds;
  const participantAgentIds = [...new Set(selected.map((id) => String(id || "").trim()).filter((id) => validIds.has(id)))].slice(0, COLLABORATION_MAX_PARTICIPANTS);
  const coordinatorAgentId = validIds.has(raw.coordinatorAgentId) ? raw.coordinatorAgentId : (participantAgentIds.includes(fallback.coordinatorAgentId) ? fallback.coordinatorAgentId : participantAgentIds[0] || "");
  if (coordinatorAgentId && !participantAgentIds.includes(coordinatorAgentId)) participantAgentIds.unshift(coordinatorAgentId);
  const writerAgentId = validIds.has(raw.writerAgentId) ? raw.writerAgentId : (participantAgentIds.includes(fallback.writerAgentId) ? fallback.writerAgentId : participantAgentIds[participantAgentIds.length - 1] || coordinatorAgentId);
  if (writerAgentId && !participantAgentIds.includes(writerAgentId) && participantAgentIds.length < COLLABORATION_MAX_PARTICIPANTS) participantAgentIds.push(writerAgentId);
  return {
    enabled: coerceBoolean(raw.enabled, fallback.enabled),
    coordinatorAgentId,
    writerAgentId,
    participantAgentIds: participantAgentIds.slice(0, COLLABORATION_MAX_PARTICIPANTS),
    maxMessages: COLLABORATION_MAX_MESSAGES,
    decisionMakerOpenIds: [...new Set((Array.isArray(raw.decisionMakerOpenIds) ? raw.decisionMakerOpenIds : String(raw.decisionMakerOpenIds || "").split(",")).map((id) => String(id || "").trim()).filter(Boolean))].slice(0, 20),
    requireCollaborationKeyword: coerceBoolean(raw.requireCollaborationKeyword, true),
    allowBotHandoffs: coerceBoolean(raw.allowBotHandoffs, true),
    requireWriteConfirmation: coerceBoolean(raw.requireWriteConfirmation, true)
  };
}

function collaborationTasks(db) {
  db.settings ||= {};
  db.settings.collaborationTasks = Array.isArray(db.settings.collaborationTasks) ? db.settings.collaborationTasks.slice(-100) : [];
  return db.settings.collaborationTasks;
}

function collaborationTaskSequence(plan) {
  const writer = plan.writerAgentId;
  // Every participant may contribute during the discussion; the writer still owns the final synthesis.
  const contributors = [plan.coordinatorAgentId, ...plan.participantAgentIds.filter((id) => id !== plan.coordinatorAgentId)].filter(Boolean);
  const sequence = [];
  const contributionLimit = Math.max(0, COLLABORATION_MAX_MESSAGES - (writer ? 1 : 0));
  for (let round = 0; round < plan.rounds && sequence.length < contributionLimit; round += 1) {
    for (const agentId of contributors) {
      if (sequence.length >= contributionLimit) break;
      sequence.push(agentId);
    }
  }
  if (writer) sequence.push(writer);
  return sequence.slice(0, COLLABORATION_MAX_MESSAGES);
}

function startsCollaborationTask(text) { return /\u534f\u4f5c|\u534f\u540c|\u591a\u673a\u5668\u4eba|\u591aAI|multi[ -]?agent/i.test(String(text || "")); }

function collaborationDirectiveValue(text, labels) {
  const pattern = new RegExp("(?:^|[\\n\\u3002\\uff1b;]|(?:\\u534f\\u4f5c(?:\\u4efb\\u52a1)?|\\u534f\\u540c)\\s*[:\\uff1a])\\s*(?:" + labels + ")\\s*[:\\uff1a]\\s*([^\\n\\u3002\\uff1b;]+)", "i");
  const match = String(text || "").match(pattern);
  return match ? match[1].trim() : "";
}

function collaborationAgentIdsFromText(db, value) {
  const agents = db.agents || [];
  const tokens = String(value || "").split(new RegExp("[,\\uFF0C\\u3001/]" )).map((item) => item.trim()).filter(Boolean);
  const ids = [];
  for (const token of tokens) {
    const agent = agents.find((item) => item.id === token || item.name === token);
    if (agent && !ids.includes(agent.id)) ids.push(agent.id);
  }
  if (ids.length) return ids;
  return agents.filter((item) => item.name && String(value || "").includes(item.name)).map((item) => item.id);
}

function collaborationAgentIdFromText(db, value) { return collaborationAgentIdsFromText(db, value)[0] || ""; }

function collaborationPlanFromMessage(db, message, bot) {
  const taskText = String(message.text || "");
  const coordinatorLabel = collaborationDirectiveValue(taskText, "\\u534f\\u8c03|\\u4e3b\\u5bfc");
  const requestedCoordinator = collaborationAgentIdFromText(db, coordinatorLabel);
  if (requestedCoordinator && requestedCoordinator !== bot.agentId) return null;
  const participantLabel = collaborationDirectiveValue(taskText, "\\u53c2\\u4e0e|\\u89d2\\u8272|\\u6210\\u5458");
  const mentioned = collaborationAgentIdsFromText(db, participantLabel || taskText);
  const participantAgentIds = [...new Set([bot.agentId, ...mentioned])].slice(0, COLLABORATION_MAX_PARTICIPANTS);
  const writerLabel = collaborationDirectiveValue(taskText, "\\u6267\\u7b14|\\u4e3b\\u7b14|\\u6c47\\u603b|\\u7ed3\\u8bba");
  const writerAgentId = collaborationAgentIdFromText(db, writerLabel) || participantAgentIds[participantAgentIds.length - 1] || bot.agentId;
  if (!participantAgentIds.includes(writerAgentId) && participantAgentIds.length < COLLABORATION_MAX_PARTICIPANTS) participantAgentIds.push(writerAgentId);
  const roundsLabel = collaborationDirectiveValue(taskText, "\\u8f6e\\u6b21|\\u56de\\u5408|\\u8ba8\\u8bba\\u8f6e");
  const parsedRounds = Number.parseInt(roundsLabel, 10);
  // No explicit round count keeps discussion lively without consuming the full safety budget by default.
  const rounds = Number.isFinite(parsedRounds) ? Math.min(COLLABORATION_MAX_MESSAGES, Math.max(1, parsedRounds)) : 3;
  return { coordinatorAgentId: bot.agentId, participantAgentIds, writerAgentId, rounds };
}

function collaborationTaskAlreadyStarted(db, messageId) {
  return collaborationTasks(db).some((task) => task.sourceMessageId === messageId);
}

function createCollaborationTask(db, message, bot, plan) {
  const task = { id: crypto.randomUUID().slice(0, 8), sourceMessageId: message.messageId, chatId: message.chatId || "", startedBy: message.senderId || "", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "active", maxMessages: COLLABORATION_MAX_MESSAGES, messageCount: 0, coordinatorAgentId: plan.coordinatorAgentId, writerAgentId: plan.writerAgentId, participantAgentIds: plan.participantAgentIds, rounds: plan.rounds, sequence: collaborationTaskSequence(plan), nextAgentId: bot.agentId, contributions: [] };
  collaborationTasks(db).push(task);
  return task;
}

function findCollaborationTask(db, taskId) { return collaborationTasks(db).find((task) => task.id === taskId && task.status === "active") || null; }
function collaborationAgentName(db, agentId) { return db.agents.find((agent) => agent.id === agentId)?.name || agentId; }

function coerceBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  if (value == null || value === "") return fallback;
  return Boolean(value);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function upsertById(list, item) {
  const id = item.id || slug(item.name) || crypto.randomUUID();
  const normalized = { ...item, id };
  const index = list.findIndex((entry) => entry.id === id);
  if (index >= 0) list[index] = { ...list[index], ...normalized };
  else list.push(normalized);
  return normalized;
}

function normalizeSkill(input) {
  return {
    ...input,
    triggerExamples: Array.isArray(input.triggerExamples)
      ? input.triggerExamples.map((item) => String(item).trim()).filter(Boolean)
      : String(input.triggerExamples || "").split("\n").map((item) => item.trim()).filter(Boolean),
    enabled: coerceBoolean(input.enabled, true),
    steps: Array.isArray(input.steps) ? input.steps : []
  };
}

function agentDependencies(db, agentId) {
  const skillNames = (db.workflows || [])
    .filter((skill) => (skill.steps || []).some((step) => step.agentId === agentId))
    .map((skill) => skill.name || skill.id);
  const botNames = (db.settings?.larkBots || [])
    .filter((bot) => bot.agentId === agentId)
    .map((bot) => bot.name || bot.id);
  return { skills: skillNames, larkBots: botNames };
}

function deleteAgent(db, agentId) {
  const index = db.agents.findIndex((agent) => agent.id === agentId);
  if (index < 0) {
    const error = new Error("Agent not found.");
    error.statusCode = 404;
    throw error;
  }
  const dependencies = agentDependencies(db, agentId);
  if (dependencies.skills.length || dependencies.larkBots.length) {
    const details = [
      dependencies.skills.length ? `Skill Center: ${dependencies.skills.join(", ")}` : "",
      dependencies.larkBots.length ? `Feishu bots: ${dependencies.larkBots.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    const error = new Error(`This agent is still in use. Remove these references first: ${details}.`);
    error.statusCode = 409;
    error.dependencies = dependencies;
    throw error;
  }
  const [agent] = db.agents.splice(index, 1);
  db.settings ||= {};
  db.settings.collaborationPolicy = normalizeCollaborationPolicy(db.settings.collaborationPolicy, db.agents);
  return agent;
}

function agentSystemPrompt(agent) {
  return [
    `You are ${agent.name}.`,
    `Role: ${agent.role}`,
    `Style: ${agent.style}`,
    `Goals: ${agent.goals}`,
    `Guardrails: ${agent.guardrails}`,
    `Default output format:\n${agent.outputFormat}`,
    "Be useful, concrete, and honest about uncertainty."
  ].join("\n\n");
}

function buildStepPrompt({ workflow, step, sourceInput, previousOutputs }) {
  const prior = previousOutputs
    .map((output, index) => `Agent output ${index + 1} (${output.agentName}):\n${output.content}`)
    .join("\n\n---\n\n");

  return [
    `Workflow: ${workflow.name}`,
    `Workflow goal: ${workflow.description}`,
    `Current task: ${step.task}`,
    `Source material:\n${sourceInput}`,
    prior ? `Previous agent outputs:\n${prior}` : "",
    "Return the best possible output for the current task."
  ].filter(Boolean).join("\n\n");
}

async function callOpenAICompatible(provider, agent, messages) {
  if (!provider.apiKey) {
    throw new Error(`${provider.name} is missing an API key.`);
  }
  const childInput = JSON.stringify({ provider, agent, messages, timeoutMs: 45000 });
  const nodeArgs = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const hasProxyEnv = Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY);
  if (hasProxyEnv && nodeMajor >= 24) {
    nodeArgs.push("--use-env-proxy");
  }
  nodeArgs.push(path.join(ROOT, "llm_call.js"));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, nodeArgs, {
      cwd: ROOT,
      timeout: 60000,
      maxBuffer: 2_000_000,
      env: process.env
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || error.message || "LLM call failed").trim();
        reject(new Error(message.split("\n")[0]));
        return;
      }
      try {
        const result = JSON.parse(stdout);
        recordModelUsage(provider, agent, result);
        resolve(result);
      } catch {
        reject(new Error("LLM call returned invalid JSON."));
      }
    });
    child.stdin.end(childInput);
  });
}

function usageTokens(usage) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
  return { inputTokens, outputTokens, totalTokens: Number(usage?.total_tokens) || inputTokens + outputTokens };
}

function modelPrice(provider, model) {
  const price = provider.pricing?.[model] || {};
  return {
    currency: String(price.currency || "USD").toUpperCase(),
    inputPerMillion: Number(price.inputPerMillion) || 0,
    outputPerMillion: Number(price.outputPerMillion) || 0
  };
}

function recordModelUsage(provider, agent, result) {
  if (!result?.usage) return;
  const model = result.model || agent.model || provider.defaultModel;
  const tokens = usageTokens(result.usage);
  const price = modelPrice(provider, model);
  const cost = tokens.inputTokens / 1_000_000 * price.inputPerMillion
    + tokens.outputTokens / 1_000_000 * price.outputPerMillion;
  const event = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    providerId: provider.id,
    providerName: provider.name,
    model,
    agentId: agent.id || "",
    agentName: agent.name || "",
    ...tokens,
    currency: price.currency,
    cost,
    priced: price.inputPerMillion > 0 || price.outputPerMillion > 0
  };
  ensureStore();
  fs.appendFileSync(storagePaths().usagePath, JSON.stringify(event) + "\n");
}

function modelUsageSummary() {
  ensureStore();
  const usagePath = storagePaths().usagePath;
  const events = fs.existsSync(usagePath)
    ? fs.readFileSync(usagePath, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    })
    : [];
  const groups = new Map();
  for (const event of events) {
    const key = `${event.providerId}:${event.model}:${event.currency}`;
    const group = groups.get(key) || { providerId: event.providerId, providerName: event.providerName, model: event.model, currency: event.currency || "USD", requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, unpricedRequests: 0 };
    group.requests += 1;
    group.inputTokens += Number(event.inputTokens) || 0;
    group.outputTokens += Number(event.outputTokens) || 0;
    group.totalTokens += Number(event.totalTokens) || 0;
    group.cost += Number(event.cost) || 0;
    if (!event.priced) group.unpricedRequests += 1;
    groups.set(key, group);
  }
  const byModel = [...groups.values()].sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  return {
    requests: events.length,
    inputTokens: events.reduce((sum, event) => sum + (Number(event.inputTokens) || 0), 0),
    outputTokens: events.reduce((sum, event) => sum + (Number(event.outputTokens) || 0), 0),
    totalTokens: events.reduce((sum, event) => sum + (Number(event.totalTokens) || 0), 0),
    costs: byModel.reduce((totals, item) => ({ ...totals, [item.currency]: (totals[item.currency] || 0) + item.cost }), {}),
    byModel,
    recent: events.slice(-20).reverse()
  };
}
function fallbackOutput(agent, task, input, previousOutputs) {
  const previousText = previousOutputs.map((output) => output.content).join("\n\n");
  const source = previousText || input;
  const excerpt = source.replace(/\s+/g, " ").slice(0, 800);
  return [
    `# ${agent.name} Draft`,
    "",
    `**Task:** ${task}`,
    "",
    "No enabled model with an API key was available for this agent, so TONA created a local draft placeholder.",
    "",
    "## Source Snapshot",
    excerpt || "No source text provided.",
    "",
    "## Next Step",
    "Add an API key in Model Providers, enable the provider, then run this workflow again."
  ].join("\n");
}

function diagnoseSetup(db) {
  const enabledProviders = db.providers.filter((provider) => provider.enabled && provider.apiKey);
  const researchWorkflows = db.workflows.filter((workflow) => ["research_intel_brief", "research_content_pipeline"].includes(workflow.id));
  const larkReady = Boolean(db.settings?.larkWebhookUrl);
  const larkAppReady = Boolean(db.settings?.larkAppId && db.settings?.larkAppSecret);
  const nextSteps = [];
  if (!enabledProviders.length) nextSteps.push("添加至少一个模型 API Key。推荐先用 DeepSeek，成本低，足够跑科研分析。");
  if (!larkReady) nextSteps.push("可选：添加飞书群机器人的 Webhook，这样结果可以一键发到飞书。");
  if (!researchWorkflows.length) nextSteps.push("初始化科研信息分析和研究型内容生产工作流。");
  if (!nextSteps.length) nextSteps.push("配置完成。可以在快速开始里粘贴材料并一键运行。");
  return {
    ready: enabledProviders.length > 0,
    providersReady: enabledProviders.map((provider) => ({ id: provider.id, name: provider.name, model: provider.defaultModel })),
    larkReady,
    larkAppReady,
    researchWorkflows: researchWorkflows.map((workflow) => ({ id: workflow.id, name: workflow.name, steps: workflow.steps.length })),
    nextSteps
  };
}

function applyQuickSetup(db, body) {
  const providerId = body.providerId || "deepseek";
  const provider = db.providers.find((item) => item.id === providerId);
  if (!provider) throw new Error("Selected provider was not found.");
  const apiKey = String(body.apiKey || "").trim();
  if (apiKey && !apiKey.includes("*")) {
    provider.apiKey = apiKey;
    provider.enabled = true;
  }
  if (body.baseUrl) provider.baseUrl = String(body.baseUrl).trim();
  if (body.model) {
    provider.defaultModel = String(body.model).trim();
    if (!provider.models.includes(provider.defaultModel)) provider.models.unshift(provider.defaultModel);
  }
  const researchAgentIds = ["research_intel_analyst", "research_content_producer", "critic", "editor"];
  for (const agent of db.agents) {
    if (researchAgentIds.includes(agent.id)) {
      agent.providerId = provider.id;
      agent.model = provider.defaultModel;
    }
  }
  db.settings ||= {};
  const webhookUrl = String(body.larkWebhookUrl || "").trim();
  if (webhookUrl) db.settings.larkWebhookUrl = webhookUrl;
  const webhookSecret = String(body.larkWebhookSecret || "").trim();
  if (webhookSecret && !webhookSecret.includes("*")) db.settings.larkWebhookSecret = webhookSecret;
  const appId = String(body.larkAppId || "").trim();
  if (appId) db.settings.larkAppId = appId;
  const appSecret = String(body.larkAppSecret || "").trim();
  if (appSecret && !appSecret.includes("*")) db.settings.larkAppSecret = appSecret;
  return provider;
}

async function runWorkflow(body) {
  const db = readDb();
  const requestedId = body.skillId || body.workflowId;
  const workflow = db.workflows.find((item) => item.id === requestedId);
  if (!workflow) throw new Error("Skill not found.");
  if (workflow.enabled === false) throw new Error("This skill is disabled.");
  const sourceInput = String(body.input || "").trim();
  if (!sourceInput) throw new Error("Input text is required.");

  const startedAt = new Date();
  const previousOutputs = [];
  const stepResults = [];
  const errors = [];

  for (const step of workflow.steps) {
    const agent = db.agents.find((item) => item.id === step.agentId);
    if (!agent) {
      errors.push(`Agent not found: ${step.agentId}`);
      continue;
    }
    const provider = db.providers.find((item) => item.id === agent.providerId);
    const started = Date.now();
    let content;
    let model = agent.model;
    let status = "success";
    let usage = null;
    let error = null;

    try {
      if (!provider || !provider.enabled || !provider.apiKey) {
        content = fallbackOutput(agent, step.task, sourceInput, previousOutputs);
        status = "fallback";
      } else if (provider.type !== "openai_compatible") {
        throw new Error(`Provider type ${provider.type} is not implemented yet.`);
      } else {
        const result = await callOpenAICompatible(provider, agent, [
          { role: "system", content: agentSystemPrompt(agent) },
          { role: "user", content: buildStepPrompt({ workflow, step, sourceInput, previousOutputs }) }
        ]);
        content = result.content;
        model = result.model;
        usage = result.usage;
      }
    } catch (err) {
      status = "error";
      error = err.message;
      errors.push(`${agent.name}: ${err.message}`);
      content = fallbackOutput(agent, step.task, sourceInput, previousOutputs);
    }

    const stepResult = {
      agentId: agent.id,
      agentName: agent.name,
      providerId: provider?.id || null,
      providerName: provider?.name || "Not configured",
      model,
      task: step.task,
      status,
      durationMs: Date.now() - started,
      usage,
      error,
      content
    };
    stepResults.push(stepResult);
    previousOutputs.push({ agentName: agent.name, content });
  }

  const finalOutput = previousOutputs.at(-1)?.content || "";
  const runId = `${startedAt.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${workflow.id}_${crypto.randomUUID().slice(0, 8)}`;
  const run = {
    id: runId,
    workflowId: workflow.id,
    skillId: workflow.id,
    workflowName: workflow.name,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    status: errors.length ? "completed_with_errors" : "success",
    inputPreview: sourceInput.slice(0, 300),
    input: db.settings.saveInputs ? sourceInput : null,
    steps: stepResults,
    finalOutput,
    errors
  };
  fs.writeFileSync(path.join(storagePaths().runsDir, `${runId}.json`), JSON.stringify(run, null, 2));
  return run;
}


async function runCollaborationPilot(db) {
  const workspaceId = activeWorkspaceId() || LEGACY_OWNER_ID;
  if (collaborationPilotLocks.has(workspaceId)) {
    const error = new Error('\u8fd9\u4e2a\u5de5\u4f5c\u533a\u5df2\u6709\u4e00\u4e2a\u534f\u4f5c\u5b9e\u9a8c\u5728\u8fd0\u884c\u3002');
    error.statusCode = 409;
    throw error;
  }
  collaborationPilotLocks.add(workspaceId);
  const startedAt = new Date();
  try {
    const provider = firstReadyProvider(db);
    if (!provider) throw new Error('\u6ca1\u6709\u5df2\u542f\u7528\u4e14\u5df2\u914d\u7f6e Key \u7684\u6a21\u578b\uff0c\u65e0\u6cd5\u542f\u52a8\u534f\u4f5c\u5b9e\u9a8c\u3002');
    const find = (ids, name, role) => ids.map((id) => db.agents.find((item) => item.id === id)).find(Boolean) || { id: ids[0], name, role, style: 'Concise, concrete, and honest.', goals: 'Complete the assigned task and state uncertainty.', guardrails: 'Do not invent evidence or tool use.', outputFormat: 'Short paragraphs or bullets.' };
    const coordinator = find(['daily_assistant'], '\u65e5\u5e38\u52a9\u7406', 'Coordinates, integrates, and delivers the final answer.');
    const researcher = find(['research_assistant', 'research_intel_analyst'], '\u79d1\u7814\u52a9\u7406', 'Reviews research design, evidence boundaries, and risks.');
    const data = find(['data_assistant'], '\u6570\u636e\u52a9\u7406', 'Reviews variables, methods, validation, and reproducibility.');
    const coding = find(['coding_assistant'], '\u4ee3\u7801\u52a9\u7406', 'Reviews implementation feasibility and execution paths.');
    const specialists = [researcher, data, coding];
    const ask = async (agent, prompt, context = '') => {
      const result = await callOpenAICompatible(provider, { ...agent, model: provider.defaultModel, temperature: 0.2 }, [
        { role: 'system', content: agentSystemPrompt(agent) + '\n\nThis is an internal collaboration experiment. Reply in Chinese. Be concise, concrete, and honest. Do not claim browsing, tool use, code execution, or data access you did not perform. Keep the answer below 350 Chinese characters unless asked for JSON.' },
        { role: 'user', content: prompt + (context ? '\n\nCollaboration context:\n' + context : '') }
      ]);
      return { agentId: agent.id, agentName: agent.name, content: result.content, model: result.model, usage: result.usage || null };
    };
    const context = (items) => items.map((item, index) => 'Step ' + (index + 1) + ', ' + item.agentName + ':\n' + item.content).join('\n\n---\n\n');
    const chooseSpecialist = (value, fallback) => {
      const text = String(value || '').toLowerCase();
      return specialists.find((item) => text.includes(item.id.toLowerCase())) || fallback;
    };
    await ask(coordinator, 'Connection preflight. Reply with exactly: READY');
    const tasks = [
      { id: 'research_design', title: '\u7814\u7a76\u8bbe\u8ba1', prompt: 'Design a one-week pilot study on how AI assistants affect PhD students\' deep-work quality. Deliver the research question, testable hypotheses, minimum method, confounders, and week-one checklist.', fallback: researcher },
      { id: 'analysis_delivery', title: '\u6570\u636e\u5206\u6790\u4ea4\u4ed8', prompt: 'Design a reliable analysis plan for 300 survey responses about AI-tool use and work efficiency. Deliver cleaning, variable construction, analysis path, robustness checks, and reproducible outputs.', fallback: data }
    ];
    const experiments = [];
    for (const task of tasks) {
      const single = await ask(coordinator, task.prompt);
      const fixed = [await ask(coordinator, 'Create a collaboration plan and name the largest risk. Task: ' + task.prompt)];
      fixed.push(await ask(researcher, 'Review evidence boundaries and research risks. Task: ' + task.prompt, context(fixed)));
      fixed.push(await ask(data, 'Review methods, measurements, and validation. Task: ' + task.prompt, context(fixed)));
      const fixedFinal = await ask(coordinator, 'Synthesize the material. Remove repetition and deliver a concrete final answer with next steps. Task: ' + task.prompt, context(fixed));
      const adaptive = [await ask(coordinator, 'State the objective, deliverable standard, and the most important unknown. Task: ' + task.prompt)];
      const selection = await ask(coordinator, 'Choose exactly one specialist for the next contribution from these IDs: research_assistant, research_intel_analyst, data_assistant, coding_assistant. Return strict JSON only: {"agentId":"...","reason":"..."}. Choose based on the plan and avoid redundant work.', context(adaptive));
      const selected = chooseSpecialist(selection.content, task.fallback);
      adaptive.push(await ask(selected, 'Contribute only the most missing, decision-changing insight. Do not repeat the plan. Task: ' + task.prompt, context(adaptive)));
      const adaptiveFinal = await ask(coordinator, 'Synthesize the material. Keep only high-value content, state evidence boundaries, and end with immediate next steps. Task: ' + task.prompt, context(adaptive));
      const judge = await ask(researcher, 'Blindly compare the three candidate answers below. Score each 1-5 for task fulfillment, actionability, evidence awareness, integration, and non-redundancy. Do not favor length. Return strict JSON only: {"single":{"overall":1,"notes":"..."},"fixed":{"overall":1,"notes":"..."},"adaptive":{"overall":1,"notes":"..."},"ranking":["...","...","..."],"diagnosis":"..."}.\n\nTask:\n' + task.prompt + '\n\nCandidate single:\n' + single.content + '\n\nCandidate fixed:\n' + fixedFinal.content + '\n\nCandidate adaptive:\n' + adaptiveFinal.content);
      let evaluation;
      try { evaluation = JSON.parse((judge.content.match(/\{[\s\S]*\}/) || [])[0] || ''); } catch { evaluation = { raw: judge.content }; }
      experiments.push({ task: { id: task.id, title: task.title }, protocols: { single: { final: single.content }, fixed: { contributions: fixed, final: fixedFinal.content }, adaptive: { contributions: adaptive, selectedAgent: selected.id, selector: selection.content, final: adaptiveFinal.content } }, evaluation });
    }
    const result = {
      id: 'pilot_' + startedAt.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '_' + crypto.randomUUID().slice(0, 8),
      workflowName: '\u591a\u667a\u80fd\u4f53\u534f\u4f5c\u5b9e\u9a8c',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'success',
      inputPreview: '\u4e24\u7c7b\u4efb\u52a1 \u00d7 \u5355\u667a\u80fd\u4f53 / \u56fa\u5b9a\u534f\u4f5c / \u81ea\u9002\u5e94\u9009\u4eba\u534f\u4f5c\uff1b\u4ec5\u8c03\u7528\u5f53\u524d\u5de5\u4f5c\u533a\u6a21\u578b\uff0c\u4e0d\u53d1\u9001\u98de\u4e66\u6d88\u606f\u3002',
      model: { provider: provider.name, defaultModel: provider.defaultModel },
      experimentDesign: { tasks: tasks.map((item) => item.id), protocols: ['single', 'fixed', 'adaptive'], visibleContributions: { single: 1, fixed: 3, adaptive: 3 }, finalSynthesis: true, preflight: true, maxOnePilotPerWorkspace: true },
      durationMs: Date.now() - startedAt.getTime(),
      experiments
    };
    fs.writeFileSync(path.join(storagePaths().runsDir, result.id + '.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    collaborationPilotLocks.delete(workspaceId);
  }
}

function normalizeLarkBot(bot = {}) {
  return {
    id: bot.id || `bot_${crypto.randomUUID().slice(0, 8)}`,
    name: String(bot.name || "未命名机器人").trim(),
    agentId: String(bot.agentId || "daily_assistant").trim(),
    appId: String(bot.appId || "").trim(),
    appSecret: String(bot.appSecret || "").trim(),
    verificationToken: String(bot.verificationToken || "").trim(),
    encryptKey: String(bot.encryptKey || "").trim(),
    publicCallbackUrl: String(bot.publicCallbackUrl || "").trim(),
    callbackWorkspaceId: String(bot.callbackWorkspaceId || "").trim(),
    openId: String(bot.openId || "").trim(),
    enabled: coerceBoolean(bot.enabled, true)
  };
}

function publicFeishuCallbackUrl(req) {
  const workspaceId = activeWorkspaceId();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  if (!workspaceId || !host) return "";
  const proto = req.headers["x-forwarded-proto"] || (process.env.NODE_ENV === "production" ? "https" : "http");
  return proto + "://" + host + "/feishu/events/" + encodeURIComponent(workspaceId);
}

function larkEventLogDir() {
  return path.join(path.dirname(storagePaths().dbPath), "lark_events");
}

function larkBotToAppSettings(bot) {
  return {
    larkAppId: bot.appId,
    larkAppSecret: bot.appSecret,
    larkVerificationToken: bot.verificationToken,
    larkEncryptKey: bot.encryptKey,
    larkPublicCallbackUrl: bot.publicCallbackUrl
  };
}

function findLarkBotByAppId(db, appId) {
  return (db.settings?.larkBots || []).find((bot) => bot.enabled !== false && bot.appId && bot.appId === appId) || null;
}

function legacyLarkBot(db) {
  const settings = db.settings || {};
  if (!settings.larkAppId) return null;
  return {
    id: "legacy_lark_app",
    name: "默认飞书机器人",
    agentId: settings.larkAgentId || "daily_assistant",
    appId: settings.larkAppId,
    appSecret: settings.larkAppSecret || "",
    verificationToken: settings.larkVerificationToken || "",
    encryptKey: settings.larkEncryptKey || "",
    publicCallbackUrl: settings.larkPublicCallbackUrl || "",
    enabled: true
  };
}

function findLarkBotByVerificationToken(db, token) {
  if (!token) return null;
  return allLarkBots(db).find((bot) => bot.verificationToken && bot.verificationToken === token) || null;
}
function allLarkBots(db) {
  const bots = [...(db.settings?.larkBots || [])];
  const legacy = legacyLarkBot(db);
  if (legacy && !bots.some((bot) => bot.appId === legacy.appId)) bots.push(legacy);
  return bots.filter((bot) => bot.enabled !== false);
}

function decryptFeishuPayloadForAnyBot(encrypt, db) {
  const candidates = allLarkBots(db).filter((bot) => bot.encryptKey);
  let lastError = null;
  for (const bot of candidates) {
    try {
      return { eventBody: decryptFeishuPayload(encrypt, bot.encryptKey), bot };
    } catch (error) {
      lastError = error;
    }
  }
  if (!candidates.length) throw new Error("Encrypted Feishu event received, but no bot Encrypt Key is configured in TONA.");
  throw lastError || new Error("Failed to decrypt Feishu event with configured bot keys.");
}

async function runAgentReply(db, agentId, text) {
  const agent = db.agents.find((item) => item.id === agentId) || db.agents.find((item) => item.id === "daily_assistant") || db.agents[0];
  if (!agent) return "我还没有配置角色。请先在 TONA 的“角色”页创建一个角色。";
  const provider = db.providers.find((item) => item.id === agent.providerId) || firstReadyProvider(db);
  if (!provider || !provider.enabled || !provider.apiKey) return "我在，但这个角色还没有可用模型。请先在 TONA 的“模型”页启用一个模型，并在“角色”页绑定给我。";
  const result = await callOpenAICompatible(provider, agent, [
    { role: "system", content: agentSystemPrompt(agent) + "\n\nYou are speaking in a Feishu chat. Unless the user explicitly asks otherwise, use Chinese. Start with the answer, then use 2-5 short lines or bullets. Do not use Markdown headings, tables, report templates, or long preambles in normal chat. Only give long-form detail when the user asks to expand, draft, or write a plan. In a collaboration, directly engage with the previous contribution rather than repeating it." },
    { role: "user", content: text }
  ]);
  return result.content;
}
function firstReadyProvider(db) {
  return db.providers.find((provider) => provider.enabled && provider.apiKey && provider.type === "openai_compatible");
}

function classifyFeishuIntent(text) {
  const value = String(text || "").trim();
  if (/^(你好|在吗|hi|hello|hey|测试|收到|ping|现在呢|你是谁|你能做什么)[。！？!?.\s]*$/i.test(value)) return "daily";
  if (/写|内容|文章|标题|小红书|公众号|推文|帖子|润色|改写|大纲|选题|文案|开头|结尾/.test(value)) return "content";
  if (/论文|文献|摘要|abstract|paper|科研|研究|方法|实验|结果|趋势|情报|基金|课题|会议|征稿|call for papers|cfp|项目申请|综述|分析/.test(value)) return "research";
  return value.length < 80 ? "daily" : "research";
}

async function runDailyAssistant(db, text) {
  const provider = firstReadyProvider(db);
  if (!provider) return "我在，但现在还没有可用模型。先在 TONA 的“模型”页启用一个模型，我就能正常工作。";
  const agent = {
    name: "TONA 日常主力助手",
    role: "你是用户在飞书里的日常主力 AI 助手，同时兼具科研信息分析和研究型内容生产能力。",
    style: "中文、自然、简洁、可靠。像一个可以长期协作的个人助手，不要把普通聊天写成报告。",
    goals: "先理解用户真实意图。普通问候要自然回应；日常任务给出直接帮助；科研材料才进入结构化分析；内容创作请求才进入写作支持。",
    guardrails: "不要编造来源。不要对空输入做过度分析。信息不足时先问一个最关键的问题。",
    outputFormat: "默认用 1-3 段中文短回复。只有用户明确要求报告、清单或长文时才使用结构化格式。",
    model: provider.defaultModel,
    temperature: 0.5
  };
  const result = await callOpenAICompatible(provider, agent, [
    { role: "system", content: agentSystemPrompt(agent) },
    { role: "user", content: `用户在飞书里发来：${text}\n\n请作为日常主力助手直接回复。` }
  ]);
  return result.content;
}
async function testLarkApp(settings) {
  const appId = settings?.appId || settings?.larkAppId;
  const appSecret = settings?.appSecret || settings?.larkAppSecret;
  if (!appId || !appSecret) {
    throw new Error("Feishu App ID and App Secret are required.");
  }
  const response = await fetch(FEISHU_OPEN_API_BASE + "/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || payload.message || "Feishu app token test failed.");
  }
  return { ok: true, expire: payload.expire };
}

async function sendLarkWebhook(settings, text) {
  const webhookUrl = settings?.larkWebhookUrl;
  if (!webhookUrl) throw new Error("Feishu webhook is not configured.");
  const body = { msg_type: "text", content: { text } };
  const secret = settings?.larkWebhookSecret;
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signString = timestamp + "\n" + secret;
    body.timestamp = timestamp;
    body.sign = crypto.createHmac("sha256", signString).update("").digest("base64");
  }
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payloadText = await response.text();
  let payload;
  try { payload = JSON.parse(payloadText); } catch { payload = { raw: payloadText }; }
  if (!response.ok || (payload.code && payload.code !== 0)) {
    throw new Error(payload.msg || payload.message || payloadText || "Feishu webhook failed: " + response.status);
  }
  return payload;
}

function listRuns() {
  ensureStore();
  return fs.readdirSync(storagePaths().runsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const run = JSON.parse(fs.readFileSync(path.join(storagePaths().runsDir, file), "utf8"));
      return {
        id: run.id,
        workflowName: run.workflowName,
        startedAt: run.startedAt,
        status: run.status,
        finalPreview: (run.finalOutput || "").replace(/\s+/g, " ").slice(0, 180)
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function serveStatic(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendText(res, 404, "Not found");
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  sendText(res, 200, fs.readFileSync(filePath), contentTypes[ext] || "application/octet-stream");
}

function parseFeishuDecryptedBuffer(buffer) {
  const candidates = [buffer, buffer.subarray(16)];
  for (const candidate of candidates) {
    const text = candidate.toString("utf8").trim();
    try { return JSON.parse(text); } catch {}
    const jsonStart = text.indexOf('{"schema"');
    if (jsonStart >= 0) {
      try { return JSON.parse(text.slice(jsonStart)); } catch {}
    }
  }
  throw new Error("Decrypted Feishu event is not valid JSON.");
}

function decryptFeishuPayload(encrypt, encryptKey) {
  if (!encryptKey) throw new Error("Encrypted Feishu event received, but Encrypt Key is not configured in TONA.");
  const key = crypto.createHash("sha256").update(encryptKey).digest();
  const encrypted = Buffer.from(encrypt, "base64");
  if (encrypted.length <= 16) throw new Error("Encrypted Feishu event payload is too short.");
  const iv = encrypted.subarray(0, 16);
  const ciphertext = encrypted.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return parseFeishuDecryptedBuffer(decrypted);
}

async function getFeishuTenantToken(settings) {
  const appId = settings?.appId || settings?.larkAppId;
  const appSecret = settings?.appSecret || settings?.larkAppSecret;
  if (!appId || !appSecret) {
    throw new Error("Feishu App ID / App Secret are not configured in TONA.");
  }
  const response = await fetch(FEISHU_OPEN_API_BASE + "/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg || payload.message || "Failed to get Feishu tenant access token.");
  }
  return payload.tenant_access_token;
}

async function hydrateLarkBotIdentity(db, bot) {
  if (!bot || bot.openId || !bot.appId || !bot.appSecret) return bot;
  try {
    const token = await getFeishuTenantToken(larkBotToAppSettings(bot));
    const response = await fetch(FEISHU_OPEN_API_BASE + "/bot/v3/info", { headers: { Authorization: "Bearer " + token } });
    const payload = await response.json().catch(() => ({}));
    const identity = payload.bot || payload.data?.bot || payload.data || {};
    const openId = identity.open_id || identity.openId || "";
    if (!response.ok || payload.code !== 0 || !openId) return bot;
    bot.openId = String(openId);
    if (!bot.name && (identity.app_name || identity.bot_name)) bot.name = String(identity.app_name || identity.bot_name);
    writeDb(db);
  } catch (error) {
    logServerError(error);
  }
  return bot;
}

const DEFAULT_BOT_CONVERSATION_MAX_ROUNDS = 10;

function botConversationMaxRounds(db) {
  const value = Number(db.settings?.botConversationMaxRounds || DEFAULT_BOT_CONVERSATION_MAX_ROUNDS);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 12) : DEFAULT_BOT_CONVERSATION_MAX_ROUNDS;
}

function parseBotConversationMarker(text) {
  const match = String(text || "").match(/\[TONA-COLLAB:task=([A-Za-z0-9_-]+);step=(\d+)\/(\d+);next=([A-Za-z0-9_-]+)\]/);
  if (!match) return null;
  return { taskId: match[1], step: Number(match[2]), maxMessages: Number(match[3]), nextAgentId: match[4] };
}

function stripBotConversationMarker(text) { return String(text || "").replace(/\n?\s*\[TONA-COLLAB:[^\]]+\]\s*/g, "").trim(); }
function appendBotConversationMarker(text, context) {
  if (!context?.taskId) return String(text || "").trim();
  return String(text || "").trim() + "\n\n[TONA-COLLAB:task=" + context.taskId + ";step=" + context.step + "/" + context.maxMessages + ";next=" + (context.nextAgentId || "closed") + "]";
}

function makeConversationThreadId(message) {
  const seed = message.messageId || `${message.chatId || "chat"}:${message.rawText || message.text || Date.now()}`;
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);
}
function extractFeishuMessage(eventBody) {
  const event = eventBody.event || eventBody;
  const message = event.message || {};
  const eventType = eventBody.header?.event_type || eventBody.event_type || "";
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const chatType = message.chat_type || "";
  const senderType = event.sender?.sender_type || "";
  let rawText = "";
  let text = "";
  if (message.content) {
    try {
      const content = typeof message.content === "string" ? JSON.parse(message.content) : message.content;
      rawText = content.text || content.content || "";
      text = rawText;
    } catch {
      rawText = String(message.content || "");
      text = rawText;
    }
  }
  const isAtAll = /@_all|<at[^>]*(?:all|all_user)[^>]*>/i.test(rawText);
  const hasDirectMention = !isAtAll && (/<at[^>]*>.*?<\/at>/i.test(rawText) || /@_user_\d+/i.test(rawText) || Array.isArray(message.mentions) && message.mentions.length > 0);
  text = text.replace(/<at[^>]*>.*?<\/at>/g, "").replace(/@_user_\d+/g, "").replace(/@_all/g, "").trim();
  const botConversation = parseBotConversationMarker(rawText);
  text = stripBotConversationMarker(text);
  const senderId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || event.sender?.open_id || event.sender?.user_id || "";
  const mentionLabels = [];
  for (const mention of Array.isArray(message.mentions) ? message.mentions : []) {
    for (const value of [mention.name, mention.user_name, mention.display_name, mention.id?.open_id, mention.id?.user_id, mention.open_id, mention.user_id]) {
      if (value) mentionLabels.push(String(value));
    }
  }
  for (const match of rawText.matchAll(/<at[^>]*>(.*?)<\/at>/gi)) if (match[1]) mentionLabels.push(match[1]);
  return { eventType, messageId, chatId, chatType, senderType, senderId, rawText, text, isAtAll, hasDirectMention, mentionLabels, botConversation, messageType: message.message_type };
}

function normalizeMentionLabel(value) { return String(value || "").replace(/^@/, "").replace(/\s+/g, "").trim().toLowerCase(); }
function messageMentionsBot(db, message, bot) {
  if (message.isAtAll) return false;
  const agent = (db.agents || []).find((item) => item.id === bot.agentId);
  const aliases = [bot.name, agent?.name, bot.openId, bot.userId].map(normalizeMentionLabel).filter(Boolean);
  const labels = (message.mentionLabels || []).map(normalizeMentionLabel).filter(Boolean);
  return aliases.some((alias) => labels.includes(alias));
}


function feishuChatText(text) {
  const raw = stripBotConversationMarker(String(text || "")).replace(/\r/g, "").replace(/\*\*/g, "").replace(new RegExp(String.fromCharCode(96), "g"), "");
  const lines = raw.split("\n").map((line) => line.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/^>\s?/, "").trim()).filter(Boolean);
  const compact = [];
  for (const line of lines) {
    if (compact.at(-1) === line) continue;
    compact.push(line);
  }
  const joined = compact.join("\n");
  return joined.length > 4800 ? joined.slice(0, 4770) + "\n…（内容较长，可 @我要求展开）" : joined;
}
function feishuPostContent(text, title = "") {
  const rows = feishuChatText(text).split("\n").filter(Boolean).slice(0, 24).map((line) => [{ tag: "text", text: line }]);
  return { zh_cn: { title: String(title || "").slice(0, 80), content: rows.length ? rows : [[{ tag: "text", text: "已收到。" }]] } };
}
function groupMessageRequestsCollaboration(db, message, bot) {
  if (startsCollaborationTask(message.text)) return true;
  const otherAgents = collaborationAgentIdsFromText(db, message.text).filter((agentId) => agentId !== bot.agentId);
  return otherAgents.length > 0 && /(请|一起|帮我|帮忙|讨论|分析|评估|协同|协调|邀请|问问|看看)/.test(String(message.text || ""));
}


async function replyFeishuMessage(settings, messageId, text) {
  return replyFeishuMessagePayload(settings, messageId, "post", feishuPostContent(text));
}
async function replyFeishuInteractiveCard(settings, messageId, card) {
  return replyFeishuMessagePayload(settings, messageId, "interactive", card);
}
async function replyFeishuMessagePayload(settings, messageId, messageType, content) {
  if (!messageId) throw new Error("Cannot reply: missing Feishu message_id.");
  const token = await getFeishuTenantToken(settings);
  const response = await fetch(FEISHU_OPEN_API_BASE + "/im/v1/messages/" + encodeURIComponent(messageId) + "/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ msg_type: messageType, content: JSON.stringify(content) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) throw new Error(payload.msg || payload.message || "Failed to reply to Feishu message.");
  return payload;
}


function larkBotForAgent(db, agentId) {
  return (db.settings?.larkBots || []).find((bot) => bot.enabled !== false && bot.agentId === agentId && bot.appId && bot.appSecret) || null;
}

async function sendFeishuMessageToChat(settings, chatId, messageType, content) {
  if (!chatId) throw new Error("Cannot send: missing Feishu chat_id.");
  const token = await getFeishuTenantToken(settings);
  const response = await fetch(FEISHU_OPEN_API_BASE + "/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ receive_id: chatId, msg_type: messageType, content: JSON.stringify(content) })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) throw new Error(payload.msg || payload.message || "Failed to send a Feishu group message.");
  return payload;
}

function collaborationPrompt(task, message, db, agentId, groupContext) {
  const prior = task.contributions.map((item) => item.agentName + ": " + item.content).join("\n\n");
  const position = task.messageCount;
  const isFinal = position >= task.sequence.length || agentId === task.writerAgentId && position === task.sequence.length;
  return [
    "This is a system-managed Feishu multi-agent collaboration.",
    "Task id: " + task.id + ". You are contribution " + position + " of " + task.sequence.length + ".",
    isFinal
      ? "You are the final writer. Synthesize the discussion into a concrete, decision-ready deliverable. Do not mention this internal orchestration."
      : "Respond naturally to the prior discussion: build on it, question it, resolve a disagreement, or add the next missing decision. You are already invited into this collaboration, so do not wait for a new @ mention. Keep the contribution focused; do not greet, repeat previous work, or claim access to missing context.",
    "Task: " + message.text,
    "Relevant group context: " + (groupContext || "none"),
    "Prior contributions: " + (prior || "none")
  ].join("\n\n");
}

async function collaborationHandoffTarget(db, task, message) {
  if (!task.nextAgentId) {
    return message.senderId ? { id: message.senderId, name: "任务发起人", final: true } : null;
  }
  const nextBot = larkBotForAgent(db, task.nextAgentId);
  if (!nextBot) return null;
  await hydrateLarkBotIdentity(db, nextBot);
  return nextBot.openId ? { id: nextBot.openId, name: nextBot.name || collaborationAgentName(db, task.nextAgentId), final: false } : null;
}

function collaborationVisibleMessage(task, db, agentId, content, handoffTarget) {
  const role = collaborationAgentName(db, agentId);
  const isFinal = task.messageCount >= task.sequence.length || agentId === task.writerAgentId && task.messageCount === task.sequence.length;
  const title = isFinal
    ? "协作交付｜" + role
    : "协作第 " + task.messageCount + "/" + task.sequence.length + " 步｜" + role;
  const handoffText = handoffTarget?.final ? " 请确认本次交付，并决定下一步。" : " 请接续讨论，回应并推进上一轮的结论。";
  const post = feishuPostContent(content, title);
  post.zh_cn.content.push([{ tag: "at", user_id: handoffTarget.id, user_name: handoffTarget.name }, { tag: "text", text: handoffText }]);
  return post;
}

async function runServerManagedCollaboration(db, task, message, sourceBot) {
  const groupContext = groupKnowledgeContext(db, message);
  task.status = "active";
  task.deliveryErrors = Array.isArray(task.deliveryErrors) ? task.deliveryErrors : [];
  writeDb(db);

  for (let index = 0; index < task.sequence.length && index < COLLABORATION_MAX_MESSAGES; index += 1) {
    const agentId = task.sequence[index];
    const outputBot = larkBotForAgent(db, agentId);
    task.messageCount = index + 1;
    task.nextAgentId = task.sequence[index + 1] || "";
    task.updatedAt = new Date().toISOString();

    if (!outputBot) {
      const detail = "该角色还没有连接一个可用的飞书应用机器人，无法加入本轮协作。";
      task.contributions.push({ agentId, agentName: collaborationAgentName(db, agentId), content: detail, at: new Date().toISOString(), status: "skipped" });
      task.deliveryErrors.push({ agentId, at: new Date().toISOString(), error: detail });
      writeDb(db);
      continue;
    }

    const handoffTarget = await collaborationHandoffTarget(db, task, message);
    if (!handoffTarget?.id) {
      const detail = "无法获取下一位协作对象的飞书 Open ID，因此不能进行必须 @ 的交接。";
      task.contributions.push({ agentId, agentName: collaborationAgentName(db, agentId), content: detail, at: new Date().toISOString(), status: "blocked" });
      task.deliveryErrors.push({ agentId, at: new Date().toISOString(), error: detail });
      task.status = "blocked";
      writeDb(db);
      return;
    }
    let content = "";
    try {
      content = await runAgentReply(db, agentId, collaborationPrompt(task, message, db, agentId, groupContext));
    } catch (error) {
      content = "本轮模型调用失败：" + error.message;
    }
    const contribution = { agentId, agentName: collaborationAgentName(db, agentId), content: String(content).slice(0, 3000), at: new Date().toISOString(), status: "completed" };
    task.contributions.push(contribution);
    task.contributions = task.contributions.slice(-COLLABORATION_MAX_MESSAGES);
    const visible = collaborationVisibleMessage(task, db, agentId, content, handoffTarget);
    try {
      if (index === 0 && sourceBot?.id === outputBot.id) await replyFeishuMessagePayload(larkBotToAppSettings(outputBot), message.messageId, "post", visible);
      else await sendFeishuMessageToChat(larkBotToAppSettings(outputBot), message.chatId, "post", visible);
    } catch (error) {
      contribution.deliveryError = error.message;
      task.deliveryErrors.push({ agentId, at: new Date().toISOString(), error: error.message });
      task.deliveryErrors = task.deliveryErrors.slice(-20);
    }
    writeDb(db);
  }

  task.status = "completed";
  task.nextAgentId = "";
  task.updatedAt = new Date().toISOString();
  writeDb(db);
}

const FEISHU_CAPABILITY_REQUESTS = [
  { id: "read_feishu_docs", title: "读取飞书文档", kind: "user_oauth", scopes: ["docx:document:readonly", "drive:drive.metadata:readonly"], purpose: "读取你明确授权的文档，用于总结、问答或研究分析。", risk: "仅在你完成飞书个人授权后可读取；不会自动读取所有文档。", keywords: ["读取飞书文档", "读飞书文档", "读取文档", "读文档", "文档阅读"] },
  { id: "write_feishu_docs", title: "创建或写入飞书文档", kind: "app_permission", scopes: ["docx:document:write_only"], purpose: "根据你确认的内容创建或更新飞书文档。", risk: "会产生或修改云端文档；每次写入前仍应由你确认。", keywords: ["写飞书文档", "创建飞书文档", "写入文档", "生成飞书文档", "修改文档"] },
  { id: "read_calendar", title: "读取飞书日历", kind: "user_oauth", scopes: ["calendar:calendar:readonly"], purpose: "读取你授权的日历，用于会议安排和日程建议。", risk: "仅使用你个人授权范围内的日历；不会自行创建会议。", keywords: ["读取日历", "读日历", "查看日程", "读取日程", "日历权限"] },
  { id: "write_calendar", title: "创建或修改飞书日程", kind: "user_oauth", scopes: ["calendar:calendar"], purpose: "根据你的确认创建、调整或取消日程。", risk: "会影响日历安排；每次实际变更前必须再次确认。", keywords: ["创建日程", "写入日历", "修改日程", "安排会议", "日程权限"] },
  { id: "group_knowledge", title: "读取群内未 @ 消息作为知识上下文", kind: "app_permission", scopes: ["im:message.group_msg"], purpose: "让机器人静默学习群内讨论，在被 @ 时结合上下文回答。", risk: "机器人会收到该群的用户消息，但未经 @ 不会主动回复。", keywords: ["读取群消息", "群消息权限", "群知识", "群上下文", "群聊知识"] }
];
function skillRequestEntries(db) {
  db.settings ||= {};
  db.settings.skillRequests = Array.isArray(db.settings.skillRequests) ? db.settings.skillRequests : [];
  return db.settings.skillRequests;
}
function findFeishuCapabilityRequest(text) {
  const normalized = String(text || "").replace(/\s+/g, "").toLowerCase();
  return FEISHU_CAPABILITY_REQUESTS.find((item) => item.keywords.some((keyword) => normalized.includes(keyword.replace(/\s+/g, "").toLowerCase()))) || null;
}
function parseFeishuCapabilityRequest(text) {
  const source = String(text || "").trim();
  if (!/(申请|开通|需要|想要|启用).{0,12}(技能|能力|权限)|(?:技能|能力|权限).{0,8}(申请|开通|需要|启用)/.test(source)) return null;
  return findFeishuCapabilityRequest(source) || { id: "custom_skill", title: source.replace(/^(?:申请|开通|需要|想要|启用)(?:技能|能力|权限)[：:\s]*/u, "").slice(0, 80) || "自定义能力", kind: "implementation_required", scopes: [], purpose: "记录你希望机器人获得的能力，待 TONA 安装对应技能执行器后再启用。", risk: "当前不会自动安装第三方技能、调用外部服务或授予任何权限。" };
}
function createFeishuSkillRequest(db, capability, message, bot) {
  const request = { id: "skill_" + crypto.randomUUID().slice(0, 12), capabilityId: capability.id, title: capability.title, kind: capability.kind, scopes: capability.scopes || [], purpose: capability.purpose, risk: capability.risk, status: "pending", requestedBy: message.senderId || "", requestedInChatId: message.chatId || "", requestedMessageId: message.messageId || "", botId: bot?.id || "", agentId: bot?.agentId || "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const requests = skillRequestEntries(db); requests.push(request); db.settings.skillRequests = requests.slice(-300); writeDb(db); return request;
}
function capabilityCard(request) {
  const scopeText = request.scopes.length ? request.scopes.join("、") : "当前没有可直接开通的飞书权限";
  const actionLabel = request.kind === "app_permission" ? "确认提交申请" : request.kind === "user_oauth" ? "确认授权意图" : "确认记录申请";
  return { config: { wide_screen_mode: true }, header: { title: { tag: "plain_text", content: "TONA 能力与权限申请" }, template: "orange" }, elements: [
    { tag: "div", text: { tag: "lark_md", content: "**申请能力：** " + request.title + "\n\n**用途：** " + request.purpose + "\n\n**涉及权限：** " + scopeText + "\n\n**边界：** " + request.risk } },
    { tag: "note", elements: [{ tag: "plain_text", content: "确认只会记录或发起下一步，不会绕过飞书权限审核，也不会立即执行写入、发送或删除操作。" }] },
    { tag: "action", actions: [
      { tag: "button", text: { tag: "plain_text", content: actionLabel }, type: "primary", value: { source: "tona_skill_request", requestId: request.id, action: "approve" } },
      { tag: "button", text: { tag: "plain_text", content: "暂不授权" }, type: "default", value: { source: "tona_skill_request", requestId: request.id, action: "reject" } }
    ] }
  ] };
}
function cardActionValue(eventBody) {
  const event = eventBody?.event || eventBody || {}; const raw = event.action?.value || event.action?.form_value || event.value || {};
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return {}; } } return raw && typeof raw === "object" ? raw : {};
}
function cardOperatorId(eventBody) {
  const event = eventBody?.event || eventBody || {}; return event.operator?.open_id || event.operator?.user_id || event.operator?.id?.open_id || event.operator?.id?.user_id || "";
}
function skillRequestToast(type, content) { return { toast: { type, content } }; }
function handleFeishuCardAction(eventBody) {
  const db = readDb(); const value = cardActionValue(eventBody);
  if (value.source !== "tona_skill_request" || !value.requestId) return skillRequestToast("warning", "这不是 TONA 的能力申请卡片。");
  const request = skillRequestEntries(db).find((item) => item.id === value.requestId);
  if (!request) return skillRequestToast("warning", "该申请已过期或不属于当前工作区。");
  const operatorId = cardOperatorId(eventBody);
  if (request.requestedBy && operatorId && request.requestedBy !== operatorId) return skillRequestToast("warning", "只有发起该申请的用户可以确认。");
  if (request.status !== "pending") return skillRequestToast("info", "该申请已处理：" + request.status + "。");
  request.approvedBy = operatorId || request.requestedBy || ""; request.updatedAt = new Date().toISOString();
  if (value.action === "reject") { request.status = "rejected"; writeDb(db); return skillRequestToast("info", "已保留现状，机器人不会启用这项能力。"); }
  if (request.kind === "app_permission") { request.status = "needs_admin"; writeDb(db); return skillRequestToast("warning", "申请已记录：请在飞书开放平台开通对应权限、发布应用后才会生效。"); }
  if (request.kind === "user_oauth") { request.status = "oauth_requested"; writeDb(db); return skillRequestToast("success", "授权意图已确认。需要先为该飞书应用配置 OAuth 回调和权限范围，TONA 才会打开个人授权页。"); }
  request.status = "implementation_requested"; writeDb(db); return skillRequestToast("info", "技能申请已记录；当前版本尚未安装该技能执行器，因此不会自动执行。");
}


async function processFeishuMessageEvent(eventBody, botConfig = null) {
  const db = readDb();
  const appId = eventBody.header?.app_id || eventBody.app_id || "";
  const bot = botConfig || findLarkBotByAppId(db, appId) || legacyLarkBot(db);
  const message = extractFeishuMessage(eventBody);
  if (!bot || !message.messageId || !message.text) return;
  if (!(message.eventType.includes("im.message") || message.eventType.includes("message"))) return;

  const policy = normalizeCollaborationPolicy(db.settings?.collaborationPolicy, db.agents);
  const isHumanSender = !message.senderType || message.senderType === "user";
  if (isHumanSender && message.chatType === "group") rememberGroupKnowledge(db, message);
  let task = null;
  let conversation = null;
  if (message.senderType === "bot") {
    conversation = message.botConversation;
    if (!policy.enabled || !policy.allowBotHandoffs || !conversation) return;
    task = findCollaborationTask(db, conversation.taskId);
    if (!task || task.nextAgentId !== bot.agentId || task.messageCount >= task.maxMessages) return;
  } else if (message.senderType && message.senderType !== "user") {
    return;
  } else {
    if (message.chatType === "group") {
      await hydrateLarkBotIdentity(db, bot);
      if (!messageMentionsBot(db, message, bot)) return;
    }
    const capability = parseFeishuCapabilityRequest(message.text);
    if (capability) {
      const request = createFeishuSkillRequest(db, capability, message, bot);
      await replyFeishuInteractiveCard(larkBotToAppSettings(bot), message.messageId, capabilityCard(request));
      return;
    }
    const decisionMakerAllowed = !policy.decisionMakerOpenIds.length || policy.decisionMakerOpenIds.includes(message.senderId);
    const plan = message.chatType === "group" && groupMessageRequestsCollaboration(db, message, bot) ? collaborationPlanFromMessage(db, message, bot) : null;
    const canStart = message.chatType === "group" && policy.enabled && decisionMakerAllowed && Boolean(plan) && !collaborationTaskAlreadyStarted(db, message.messageId);
    if (canStart) {
      task = createCollaborationTask(db, message, bot, plan);
      writeDb(db);
      await runServerManagedCollaboration(db, task, message, bot);
      return;
    }
  }

  if (task) {
    task.messageCount += 1;
    task.updatedAt = new Date().toISOString();
    const nextAgentId = task.sequence[task.messageCount] || "";
    if (task.messageCount >= task.maxMessages || !nextAgentId) { task.status = "completed"; task.nextAgentId = ""; }
    else task.nextAgentId = nextAgentId;
    conversation = { taskId: task.id, step: task.messageCount, maxMessages: task.maxMessages, nextAgentId: task.nextAgentId || "closed" };
    writeDb(db);
  }

  let replyText = "";
  try {
    const groupContext = groupKnowledgeContext(db, message);
    let promptText = message.text;
    if (task) {
      const prior = task.contributions.map((item) => item.agentName + ": " + item.content).join("\n\n");
      const nextLabel = task.nextAgentId ? collaborationAgentName(db, task.nextAgentId) : "none; close with a concise decision-ready summary";
      promptText = [
        "This is a system-managed Feishu group collaboration task.",
        "Task id: " + task.id + ". You are contribution " + task.messageCount + " of " + task.maxMessages + ".",
        "Give only your professional contribution. Do not add greetings. Do not claim access to missing context. Do not perform write, delete, external-send, or configuration actions.",
        "Task: " + message.text,
        "Relevant group context: " + (groupContext || "none"),
        "Prior contributions: " + (prior || "none"),
        "Next scheduled role: " + nextLabel
      ].join("\n\n");
    } else if (groupContext) {
      promptText = "Recent group context (use it only when relevant):\n" + groupContext + "\n\nCurrent user request:\n" + message.text;
    }
    replyText = await runAgentReply(db, bot.agentId || "daily_assistant", promptText);
  } catch (error) {
    replyText = "Processing failed: " + error.message;
  }

  if (task) {
    task.contributions.push({ agentId: bot.agentId, agentName: collaborationAgentName(db, bot.agentId), content: String(replyText).slice(0, 3000), at: new Date().toISOString() });
    task.contributions = task.contributions.slice(-COLLABORATION_MAX_MESSAGES);
    writeDb(db);
    if (task.nextAgentId) replyText += "\n\nSystem handoff: next role is " + collaborationAgentName(db, task.nextAgentId) + ".";
    else replyText += "\n\nCollaboration is complete. Wait for a human decision or a new collaboration task.";
  }
  await replyFeishuMessage(larkBotToAppSettings(bot), message.messageId, appendBotConversationMarker(replyText, conversation));
}

function summarizeFeishuEventLog(entry, errorText = "") {
  const body = entry.body || {};
  const event = body.event || body;
  const message = event.message || {};
  let text = "";
  if (message.content) {
    try {
      const content = typeof message.content === "string" ? JSON.parse(message.content) : message.content;
      text = content.text || content.content || "";
    } catch {
      text = String(message.content || "");
    }
  }
  return {
    receivedAt: entry.receivedAt || "",
    decryptError: entry.decryptError || "",
    botId: entry.botId || "",
    agentId: entry.agentId || "",
    eventType: body.header?.event_type || body.event_type || "",
    appId: body.header?.app_id || body.app_id || "",
    senderType: event.sender?.sender_type || "",
    chatType: message.chat_type || "",
    messageType: message.message_type || "",
    messageId: message.message_id || "",
    textPreview: String(text).replace(/<at[^>]*>.*?<\/at>/g, "@ ").replace(/\s+/g, " ").slice(0, 160),
    replyError: String(errorText || "").split("\n")[0].slice(0, 240)
  };
}

function listLarkEventLogs(limit = 30) {
  const eventLogDir = larkEventLogDir();
  if (!fs.existsSync(eventLogDir)) return [];
  return fs.readdirSync(eventLogDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(Number(limit) || 30, 100)))
    .map((file) => {
      const id = file.replace(/\.json$/, "");
      let entry = {};
      try { entry = JSON.parse(fs.readFileSync(path.join(eventLogDir, file), "utf8")); } catch {}
      let errorText = "";
      const errorPath = path.join(eventLogDir, id + ".reply-error.txt");
      if (fs.existsSync(errorPath)) errorText = fs.readFileSync(errorPath, "utf8");
      return { id, ...summarizeFeishuEventLog(entry, errorText) };
    });
}

function larkAppDiagnosis(db, req) {
  const settings = db.settings || {};
  const host = req.headers.host || `localhost:${PORT}`;
  const workspaceId = activeWorkspaceId() || "workspace-id";
  const localCallbackUrl = `http://${host}/feishu/events/${encodeURIComponent(workspaceId)}`;
  const publicCallbackUrl = publicFeishuCallbackUrl(req) || localCallbackUrl;
  const permissions = [
    { id: "im:message", name: "接收消息事件", why: "让机器人收到群里的 @ 消息。" },
    { id: "im:message:send_as_bot", name: "以机器人身份发送消息", why: "让机器人回复群消息。" },
    { id: "im:chat", name: "读取群聊基础信息", why: "用于判断消息来自哪个群。" }
  ];
  const steps = [
    "在飞书开放平台创建企业自建应用，并启用机器人能力。",
    "把 App ID / App Secret 填到本页并保存，点测试 App 凭证。",
    "在事件订阅里填写公网回调 URL。localhost 只能本机访问，飞书后台不能访问。",
    "把 Verification Token 和 Encrypt Key 填回本页。",
    "订阅消息事件，例如接收群聊消息 / 机器人被 @。",
    "申请并开通消息发送权限，然后安装应用到你的个人飞书群。"
  ];
  return {
    appConfigured: Boolean(settings.larkAppId && settings.larkAppSecret),
    tokenConfigured: Boolean(settings.larkVerificationToken),
    encryptKeyConfigured: Boolean(settings.larkEncryptKey),
    localCallbackUrl,
    publicCallbackUrl,
    effectiveCallbackUrl: publicCallbackUrl || localCallbackUrl,
    permissions,
    steps
  };
}

async function handleFeishuEvent(req, res, receivedBody = null) {
  let logId = null;
  try {
    const body = receivedBody || await readBody(req);
    const db = readDb();
    const settings = db.settings || {};
    let eventBody = body;
    let botConfig = null;
    let decryptError = null;
    if (body.encrypt) {
      try {
        const decrypted = decryptFeishuPayloadForAnyBot(body.encrypt, db);
        eventBody = decrypted.eventBody;
        botConfig = decrypted.bot;
      }
      catch (error) { decryptError = error.message; }
    } else {
      botConfig = findLarkBotByAppId(db, body.header?.app_id || body.app_id || "") || legacyLarkBot(db);
    }
    if (!decryptError && (eventBody.type === "url_verification" || eventBody.challenge)) {
      const tokenBot = findLarkBotByVerificationToken(db, eventBody.token);
      const expectedToken = tokenBot?.verificationToken || botConfig?.verificationToken || settings.larkVerificationToken;
      if (expectedToken && eventBody.token && eventBody.token !== expectedToken) {
        return sendJson(res, 403, { error: "Verification token mismatch." });
      }
      return sendJson(res, 200, { challenge: eventBody.challenge });
    }
    if (!decryptError && (eventBody.header?.event_type || eventBody.event_type) === "card.action.trigger") {
      return sendJson(res, 200, handleFeishuCardAction(eventBody));
    }
    const eventLogDir = larkEventLogDir();
    fs.mkdirSync(eventLogDir, { recursive: true });
    logId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "_" + crypto.randomUUID().slice(0, 8);
    fs.writeFileSync(path.join(eventLogDir, logId + ".json"), JSON.stringify({
      receivedAt: new Date().toISOString(),
      decryptError,
      botId: botConfig?.id || null,
      agentId: botConfig?.agentId || null,
      body: decryptError ? body : eventBody
    }, null, 2));
    sendJson(res, 200, { ok: true });
    if (!decryptError) {
      processFeishuMessageEvent(eventBody, botConfig).catch((error) => {
        logServerError(error);
        if (logId) fs.writeFileSync(path.join(eventLogDir, logId + ".reply-error.txt"), error.stack || error.message || String(error));
      });
    }
  } catch (error) {
    logServerError(error);
    return sendJson(res, 400, { error: error.message });
  }
}

async function resolveHubUser(req) {
  if (!HUB_AUTH_REQUIRED) return null;
  const cookie = String(req.headers.cookie || "");
  if (!cookie) return null;
  try {
    const response = await fetch("http://127.0.0.1:" + TEAMFLOW_INTERNAL_PORT + "/api/me", { headers: { Cookie: cookie } });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.user || null;
  } catch {
    return null;
  }
}

async function handleApi(req, res, pathname) {
  const hubUser = await resolveHubUser(req);
  if (HUB_AUTH_REQUIRED && !hubUser) return sendJson(res, 401, { error: "Sign in to Tona AI Hub first." });
  const workspaceId = hubUser?.id || "";
  return workspaceContext.run({ workspaceId }, () => handleApiInWorkspace(req, res, pathname));
}

async function handleApiInWorkspace(req, res, pathname) {
  try {

    if (req.method === "GET" && pathname === "/api/diagnose") {
      return sendJson(res, 200, diagnoseSetup(readDb()));
    }
    if (req.method === "POST" && pathname === "/api/quick-setup") {
      const body = await readBody(req);
      const db = readDb();
      const provider = applyQuickSetup(db, body);
      writeDb(db);
      return sendJson(res, 200, {
        provider: { ...provider, apiKey: maskKey(provider.apiKey) },
        settings: publicDb(db).settings,
        diagnosis: diagnoseSetup(db)
      });
    }
    if (req.method === "GET" && pathname === "/api/state") {
      return sendJson(res, 200, publicDb(readDb()));
    }
    if (req.method === "GET" && pathname === "/api/runs") {
      return sendJson(res, 200, listRuns());
    }
    if (req.method === "GET" && pathname === "/api/model-usage") {
      return sendJson(res, 200, modelUsageSummary());
    }
    if (req.method === "POST" && pathname === "/api/providers") {
      const body = await readBody(req);
      const db = readDb();
      const existing = db.providers.find((item) => item.id === body.id);
      const hasNewApiKey = Boolean(body.apiKey && !body.apiKey.includes("*"));
      const provider = upsertById(db.providers, {
        ...body,
        enabled: hasNewApiKey ? true : coerceBoolean(body.enabled, existing?.enabled || false),
        apiKey: hasNewApiKey ? body.apiKey : existing?.apiKey || "",
        models: Array.isArray(body.models) ? body.models : String(body.models || "").split(",").map((m) => m.trim()).filter(Boolean),
        pricing: {
          ...(existing?.pricing || {}),
          [String(body.defaultModel || existing?.defaultModel || "")]: {
            currency: String(body.currency || existing?.pricing?.[body.defaultModel]?.currency || "USD").toUpperCase(),
            inputPerMillion: Number(body.inputPerMillion) || 0,
            outputPerMillion: Number(body.outputPerMillion) || 0
          }
        }
      });
      writeDb(db);
      return sendJson(res, 200, { provider: { ...provider, apiKey: maskKey(provider.apiKey) } });
    }
    if (req.method === "POST" && pathname === "/api/collaboration-policy") {
      const body = await readBody(req);
      const db = readDb();
      db.settings ||= {};
      db.settings.collaborationPolicy = normalizeCollaborationPolicy(body, db.agents);
      writeDb(db);
      return sendJson(res, 200, { collaborationPolicy: db.settings.collaborationPolicy });
    }
    if (req.method === "POST" && pathname === "/api/agents") {
      const body = await readBody(req);
      const db = readDb();
      const agent = upsertById(db.agents, body);
      writeDb(db);
      return sendJson(res, 200, { agent });
    }
    const deleteAgentMatch = pathname.match(/^\/api\/agents\/([A-Za-z0-9_-]{1,80})$/);
    if (req.method === "DELETE" && deleteAgentMatch) {
      const db = readDb();
      const agent = deleteAgent(db, deleteAgentMatch[1]);
      writeDb(db);
      return sendJson(res, 200, { ok: true, agent });
    }
    if (req.method === "GET" && pathname === "/api/skills") {
      return sendJson(res, 200, { skills: (readDb().workflows || []).map(normalizeSkill) });
    }
    if (req.method === "POST" && pathname === "/api/skills") {
      const body = normalizeSkill(await readBody(req));
      const db = readDb();
      const skill = upsertById(db.workflows, body);
      writeDb(db);
      return sendJson(res, 200, { skill });
    }
    if (req.method === "POST" && pathname === "/api/workflows") {
      const body = await readBody(req);
      const db = readDb();
      const workflow = upsertById(db.workflows, normalizeSkill(body));
      writeDb(db);
      return sendJson(res, 200, { workflow });
    }
    if (req.method === "POST" && pathname === "/api/run") {
      const body = await readBody(req);
      const run = await runWorkflow(body);
      return sendJson(res, 200, run);
    }

    if (req.method === "POST" && pathname === "/api/lark-bots") {
      const body = await readBody(req);
      const db = readDb();
      db.settings ||= {};
      db.settings.larkBots ||= [];
      const incomingAppId = String(body.appId || "").trim();
      const existingByApp = incomingAppId ? db.settings.larkBots.find((item) => item.appId === incomingAppId) : null;
      const existingById = body.id ? db.settings.larkBots.find((item) => item.id === body.id) : null;
      const existing = existingByApp || (existingById && (!incomingAppId || existingById.appId === incomingAppId) ? existingById : null);
      const source = existing ? { ...existing, ...body } : { ...body, id: "" };
      const bot = normalizeLarkBot({
        ...source,
        callbackWorkspaceId: activeWorkspaceId(),
        publicCallbackUrl: (() => { const submitted = String(body.publicCallbackUrl || existing?.publicCallbackUrl || "").trim(); const generated = publicFeishuCallbackUrl(req); return generated && /\/feishu\/events\/?$/.test(submitted) ? generated : (submitted || generated); })(),
        appSecret: incomingSecretValue(body.appSecret, existing?.appSecret),
        verificationToken: incomingSecretValue(body.verificationToken, existing?.verificationToken),
        encryptKey: incomingSecretValue(body.encryptKey, existing?.encryptKey)
      });
      if (!bot.appId) throw new Error("App ID is required.");
      if (!bot.agentId) throw new Error("Agent is required.");
      if (existing) Object.assign(existing, bot);
      else db.settings.larkBots.push(bot);
      writeDb(db);
      return sendJson(res, 200, { bot: publicDb(db).settings.larkBots.find((item) => item.id === bot.id), settings: publicDb(db).settings });
    }
    if (req.method === "POST" && pathname === "/api/lark-bot-test") {
      const body = await readBody(req);
      const db = readDb();
      const bot = (db.settings?.larkBots || []).find((item) => item.id === body.id || item.appId === body.appId);
      if (!bot) throw new Error("Bot config was not found.");
      const result = await testLarkApp(larkBotToAppSettings(bot));
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && pathname === "/api/lark-settings") {
      const body = await readBody(req);
      const db = readDb();
      db.settings ||= {};
      db.settings.larkWebhookUrl = body.larkWebhookUrl || "";
      db.settings.larkAppId = body.larkAppId || db.settings.larkAppId || "";
      db.settings.larkPublicCallbackUrl = body.larkPublicCallbackUrl || db.settings.larkPublicCallbackUrl || "";
      db.settings.larkVerificationToken = incomingSecretValue(body.larkVerificationToken, db.settings.larkVerificationToken);
      db.settings.larkEncryptKey = incomingSecretValue(body.larkEncryptKey, db.settings.larkEncryptKey);
      if (!isMaskedSecretValue(body.larkAppSecret)) {
        db.settings.larkAppSecret = String(body.larkAppSecret).trim();
      } else if (!body.larkAppSecret && body.clearLarkAppSecret) {
        db.settings.larkAppSecret = "";
      }
      if (!isMaskedSecretValue(body.larkWebhookSecret)) {
        db.settings.larkWebhookSecret = String(body.larkWebhookSecret).trim();
      } else if (!body.larkWebhookSecret) {
        db.settings.larkWebhookSecret = "";
      }
      writeDb(db);
      return sendJson(res, 200, { settings: publicDb(db).settings });
    }


    if (req.method === "GET" && pathname === "/api/lark-events") {
      const limit = new URL(req.url, `http://${req.headers.host}`).searchParams.get("limit") || 30;
      return sendJson(res, 200, { events: listLarkEventLogs(limit) });
    }
    if (req.method === "GET" && pathname === "/api/lark-app-diagnose") {
      return sendJson(res, 200, larkAppDiagnosis(readDb(), req));
    }
    if (req.method === "POST" && pathname === "/api/lark-app-test") {
      const db = readDb();
      const result = await testLarkApp(db.settings);
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && pathname === "/api/lark-test") {
      const db = readDb();
      await sendLarkWebhook(db.settings, "TONA Agent Studio 飞书连接测试成功。");
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/api/lark-send") {
      const body = await readBody(req);
      const db = readDb();
      const text = String(body.text || "").trim();
      if (!text) throw new Error("Text is required.");
      await sendLarkWebhook(db.settings, text.slice(0, 18000));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && pathname === "/api/collaboration-pilot") {
      const result = await runCollaborationPilot(readDb());
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && pathname === "/api/test-provider") {
      const body = await readBody(req);
      const db = readDb();
      const provider = db.providers.find((item) => item.id === body.providerId);
      if (!provider) throw new Error("Provider not found.");
      const agent = { model: provider.defaultModel, temperature: 0 };
      const result = await callOpenAICompatible(provider, agent, [
        { role: "system", content: "You are a connection test. Reply with one short sentence." },
        { role: "user", content: "Say TONA connection OK." }
      ]);
      return sendJson(res, 200, { ok: true, message: result.content, model: result.model });
    }
    sendJson(res, 404, { error: "API route not found." });
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message, dependencies: error.dependencies });
  }
}

ensureStore();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && (url.pathname === "/gateway/health" || url.pathname === "/api/health")) {
    return sendJson(res, 200, { ok: true, service: "tona-agent-studio" });
  }
  const scopedEvent = url.pathname.match(/^\/feishu\/events\/([A-Za-z0-9_-]{3,80})$/);
  if (scopedEvent) {
    return workspaceContext.run({ workspaceId: scopedEvent[1] }, () => handleFeishuEvent(req, res));
  }
  // Every Feishu bot uses its generated workspace callback URL: /feishu/events/:workspaceId.
  if (url.pathname === "/feishu/events") {
    return sendJson(res, 410, { error: "This shared callback URL is retired. Save the bot in TONA and use its generated workspace callback URL." });
  } else if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`TONA Agent Studio is running at http://localhost:${PORT}`);
});
