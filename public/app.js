const state = {
  db: null,
  selectedProviderId: null,
  selectedAgentId: null,
  selectedWorkflowId: null,
  selectedLarkBotId: null,
  modelUsage: null,
  latestFinalOutput: ""
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json();
  if (response.status === 401) { window.location.href = "/teamflow/"; throw new Error("Sign in required."); }
  if (!response.ok || payload.error) throw new Error(payload.error || "Request failed.");
  return payload;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  window.setTimeout(() => element.classList.remove("show"), 2800);
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setForm(form, values) {
  Object.entries(values || {}).forEach(([key, value]) => {
    const field = form.elements[key];
    if (!field) return;
    if (Array.isArray(value)) field.value = value.join(", ");
    else if (typeof value === "boolean") field.value = String(value);
    else field.value = value ?? "";
  });
}

function setActiveView(view) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `view-${view}`));
  if (view === "runs") loadRuns();
}
function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderNextAction() {
  const box = document.querySelector("#nextActionBox");
  if (!box || !state.db) return;
  const enabledProviders = state.db.providers.filter((provider) => provider.enabled && provider.apiKey);
  if (!enabledProviders.length) {
    box.innerHTML = "<strong>下一步：</strong><span>先去“模型”页，选择一个供应商，填 API Key，保存后会自动启用。</span>";
    return;
  }
  const workflow = currentWorkflow();
  box.innerHTML = `<strong>可以运行了：</strong><span>当前有 ${enabledProviders.length} 个可用模型。选择“${escapeHtml(workflow?.name || "Skill")}”，粘贴材料后点击右上角“开始运行”。</span>`;
}
function currentWorkflow() {
  return state.db.workflows.find((workflow) => workflow.id === $("#workflowSelect").value) || state.db.workflows[0];
}

async function loadState() {
  const [db, modelUsage] = await Promise.all([api("/api/state"), api("/api/model-usage")]);
  state.db = db;
  state.modelUsage = modelUsage;
  state.selectedProviderId ||= state.db.providers[0]?.id;
  state.selectedAgentId ||= state.db.agents[0]?.id;
  state.selectedWorkflowId ||= state.db.workflows[0]?.id;
  renderAll();
}

function renderAll() {
  renderNextAction();
  renderWorkflowSelect();
  renderStudioSteps();
  renderProviders();
  renderModelUsage();
  renderProviderForm();
  renderAgentProviderSelect();
  renderAgents();
  renderAgentForm();
  renderWorkflows();
  renderWorkflowForm();
  renderLarkForm();
  renderLarkAppForm();
  renderLarkBotAgentSelect();
  renderLarkBots();
  renderLarkBotForm();
  renderLarkAppDiagnosis();
  refreshAssistantHealth();
}

async function refreshAssistantHealth() {
  const box = document.querySelector('#assistantHealthBox');
  if (!box) return;
  try {
    const health = await api('/api/assistant-health');
    const labels = { ready: '\u8fd0\u884c\u6b63\u5e38', attention: '\u9700\u8981\u5904\u7406', setup_needed: '\u5c1a\u672a\u5c31\u7eea' };
    const stateClass = health.status === 'ready' ? 'enabled' : health.status === 'attention' ? 'error' : 'disabled';
    const taskRows = (health.pendingTasks || []).map((task) => '<li><strong>' + escapeHtml(task.title) + '</strong><span>' + escapeHtml(task.status === 'awaiting_calendar_oauth' ? '\u7b49\u5f85\u65e5\u5386\u6388\u6743' : '\u7b49\u5f85\u4f60\u786e\u8ba4') + '</span></li>').join('');
    const failure = health.replyFailures?.[0];
    box.innerHTML = '<div class="panel-heading"><h3>\u5728\u7ebf\u52a9\u7406\u72b6\u6001</h3><button id="refreshAssistantHealthButton" type="button">\u5237\u65b0\u72b6\u6001</button></div>' +
      '<div class="health-grid"><div><span class="pill ' + stateClass + '">' + labels[health.status] + '</span><p>\u5df2\u5c31\u7eea\u673a\u5668\u4eba\uff1a' + Number(health.botsReady || 0) + '</p><p>\u53ef\u7528\u6a21\u578b\uff1a' + escapeHtml((health.providersReady || []).join(' / ') || '\u65e0') + '</p></div>' +
      '<div><p>\u6700\u8fd1\u98de\u4e66\u4e8b\u4ef6\uff1a' + escapeHtml(health.latestEventAt || '\u5c1a\u672a\u6536\u5230') + '</p><p>' + escapeHtml(health.latestEventSummary || '\u7528 @ \u673a\u5668\u4eba\u53d1\u9001\u4e00\u6761\u6d88\u606f\u5373\u53ef\u9a8c\u8bc1') + '</p></div></div>' +
      (failure ? '<div class="health-error">\u6700\u8fd1\u5f02\u5e38\uff1a' + escapeHtml(failure.replyError || failure.decryptError) + '</div>' : '') +
      (taskRows ? '<div class="health-tasks"><strong>\u5f85\u5904\u7406\u4e8b\u9879</strong><ul>' + taskRows + '</ul></div>' : '<div class="meta">\u5f53\u524d\u6ca1\u6709\u5f85\u786e\u8ba4\u7684\u65e5\u7a0b\u6216\u5916\u90e8\u64cd\u4f5c\u3002</div>');
    document.querySelector('#refreshAssistantHealthButton')?.addEventListener('click', refreshAssistantHealth);
  } catch (error) {
    box.innerHTML = '<div class="panel-heading"><h3>\u5728\u7ebf\u52a9\u7406\u72b6\u6001</h3></div><div class="health-error">' + escapeHtml(error.message) + '</div>';
  }
}

async function refreshDiagnosis() {
  const box = document.querySelector("#setupStatusBox");
  if (!box) return;
  try {
    const diagnosis = await api("/api/diagnose");
    const status = diagnosis.ready ? "已准备好：" : "还差一步：";
    const providerText = diagnosis.providersReady.length ? "<span class=\"pill enabled\">" + diagnosis.providersReady.map((provider) => escapeHtml(provider.name)).join(" / ") + "</span>" : "";
    const larkText = diagnosis.larkReady ? "<span class=\"pill enabled\">飞书已连接</span>" : "<span class=\"pill\">飞书可选</span>";
    box.innerHTML = "<strong>" + status + "</strong><span>" + diagnosis.nextSteps.map(escapeHtml).join(" ") + "</span>" + providerText + larkText;
  } catch (error) {
    box.innerHTML = "<strong>诊断失败：</strong><span>" + escapeHtml(error.message) + "</span>";
  }
}

function renderQuickStart() {
  const providerSelect = document.querySelector("#quickProviderSelect");
  if (!providerSelect || !state.db) return;
  providerSelect.innerHTML = state.db.providers.map((provider) => '<option value="' + provider.id + '">' + escapeHtml(provider.name) + '</option>').join('');
  const preferred = state.db.providers.find((provider) => provider.enabled && provider.apiKey) || state.db.providers.find((provider) => provider.id === "deepseek") || state.db.providers[0];
  providerSelect.value = preferred?.id || "";
  fillQuickProviderFields();
  const form = document.querySelector("#quickSetupForm");
  if (form) {
    form.elements.larkWebhookUrl.value = state.db.settings?.larkWebhookUrl || "";
    form.elements.larkWebhookSecret.value = state.db.settings?.larkWebhookSecret || "";
  }
  refreshDiagnosis();
}

function fillQuickProviderFields() {
  if (!state.db) return;
  const providerId = document.querySelector("#quickProviderSelect")?.value;
  const provider = state.db.providers.find((item) => item.id === providerId);
  if (!provider) return;
  const baseInput = document.querySelector("#quickBaseUrlInput");
  const modelInput = document.querySelector("#quickModelInput");
  if (baseInput) baseInput.value = provider.baseUrl || "";
  if (modelInput) modelInput.value = provider.defaultModel || "";
}

function selectedQuickWorkflowId() {
  return document.querySelector('input[name="quickWorkflow"]:checked')?.value || "research_intel_brief";
}

async function saveQuickSetup() {
  const form = document.querySelector("#quickSetupForm");
  const data = formData(form);
  const result = await api("/api/quick-setup", { method: "POST", body: JSON.stringify(data) });
  state.db = await api("/api/state");
  renderAll();
  toast(result.diagnosis.ready ? "配置已保存，可以运行" : "配置已保存，还需要补 key");
  return result;
}

async function quickRun() {
  const input = document.querySelector("#quickInput").value.trim();
  if (!input) return toast("先粘贴一段科研材料");
  document.querySelector("#quickRunButton").disabled = true;
  document.querySelector("#quickRunMeta").textContent = "正在保存配置并运行";
  document.querySelector("#quickOutput").innerHTML = "";
  try {
    await saveQuickSetup();
    const run = await api("/api/run", { method: "POST", body: JSON.stringify({ workflowId: selectedQuickWorkflowId(), input }) });
    state.latestFinalOutput = run.finalOutput || "";
    document.querySelector("#quickRunMeta").textContent = run.workflowName + " / " + run.status;
    document.querySelector("#quickOutput").innerHTML = '<div class="final-output panel"><div class="panel-heading"><h3>最终输出</h3><span>' + escapeHtml(run.id) + '</span></div><pre>' + escapeHtml(run.finalOutput) + '</pre></div>';
    toast("一键运行完成");
  } catch (error) {
    document.querySelector("#quickRunMeta").textContent = error.message;
    toast(error.message);
  } finally {
    document.querySelector("#quickRunButton").disabled = false;
  }
}
function renderLarkForm() {
  const form = document.querySelector("#larkForm");
  if (!form || !state.db?.settings) return;
  setForm(form, {
    larkWebhookUrl: state.db.settings.larkWebhookUrl || "",
    larkWebhookSecret: state.db.settings.larkWebhookSecret || ""
  });
}

function renderLarkAppForm() {
  const form = document.querySelector("#larkAppForm");
  if (!form || !state.db?.settings) return;
  setForm(form, {
    larkAppId: state.db.settings.larkAppId || "",
    larkAppSecret: state.db.settings.larkAppSecret || "",
    larkPublicCallbackUrl: state.db.settings.larkPublicCallbackUrl || "",
    larkVerificationToken: state.db.settings.larkVerificationToken || "",
    larkEncryptKey: state.db.settings.larkEncryptKey || ""
  });
}

function renderLarkBotAgentSelect() {
  const select = document.querySelector("#larkBotAgentSelect");
  if (!select || !state.db) return;
  select.innerHTML = state.db.agents.map((agent) => `<option value="${agent.id}">${escapeHtml(agent.name)} (${escapeHtml(agent.id)})</option>`).join("");
}

function renderLarkBots() {
  const list = document.querySelector("#larkBotList");
  if (!list || !state.db) return;
  const bots = state.db.settings?.larkBots || [];
  if (!state.selectedLarkBotId && bots.length) state.selectedLarkBotId = bots[0].id;
  list.innerHTML = bots.length ? bots.map((bot) => {
    const agent = state.db.agents.find((item) => item.id === bot.agentId);
    return `
      <div class="card ${bot.id === state.selectedLarkBotId ? "selected" : ""}" data-lark-bot-id="${bot.id}">
        <strong>${escapeHtml(bot.name)}</strong>
        <div class="meta">${escapeHtml(agent?.name || bot.agentId || "未绑定角色")}</div>
        <div class="pill-row">
          <span class="pill ${bot.enabled === false ? "disabled" : "enabled"}">${bot.enabled === false ? "禁用" : "启用"}</span>
          <span class="pill">${escapeHtml(bot.appId || "未填 App ID")}</span>
          <span class="pill">${bot.appSecret ? "Secret 已设置" : "未设置 Secret"}</span>
        </div>
      </div>
    `;
  }).join("") : '<div class="meta">还没有角色机器人。先选择一个角色，填 App ID / Secret 保存。</div>';
  document.querySelectorAll("[data-lark-bot-id]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedLarkBotId = card.dataset.larkBotId;
      renderLarkBots();
      renderLarkBotForm();
    });
  });
}

function renderLarkBotForm() {
  const form = document.querySelector("#larkBotForm");
  if (!form || !state.db) return;
  const bot = (state.db.settings?.larkBots || []).find((item) => item.id === state.selectedLarkBotId) || {};
  setForm(form, {
    id: bot.id || "",
    name: bot.name || "",
    agentId: bot.agentId || "daily_assistant",
    appId: bot.appId || "",
    appSecret: bot.appSecret || "",
    publicCallbackUrl: bot.publicCallbackUrl || state.db.settings?.larkPublicCallbackUrl || "",
    verificationToken: bot.verificationToken || "",
    encryptKey: bot.encryptKey || "",
    enabled: String(bot.enabled !== false)
  });
}

function newLarkBot() {
  state.selectedLarkBotId = null;
  const form = document.querySelector("#larkBotForm");
  if (!form) return;
  setForm(form, {
    id: "",
    name: "",
    agentId: "daily_assistant",
    appId: "",
    appSecret: "",
    publicCallbackUrl: state.db?.settings?.larkPublicCallbackUrl || "",
    verificationToken: "",
    encryptKey: "",
    enabled: "true"
  });
  renderLarkBots();
}

async function saveLarkBot(event) {
  event.preventDefault();
  const data = formData(event.currentTarget);
  data.enabled = data.enabled === "true";
  const result = await api("/api/lark-bots", { method: "POST", body: JSON.stringify(data) });
  state.db.settings = result.settings;
  state.selectedLarkBotId = result.bot.id;
  renderLarkBotAgentSelect();
  renderLarkBots();
  renderLarkBotForm();
  setActiveView("lark");
  toast("角色机器人已保存");
}

async function testLarkBot() {
  const id = document.querySelector("#larkBotForm")?.elements.id.value;
  if (!id) return toast("请先保存这个角色机器人");
  try {
    await api("/api/lark-bot-test", { method: "POST", body: JSON.stringify({ id }) });
    toast("当前角色机器人凭证测试通过");
  } catch (error) {
    toast(error.message);
  }
}
async function renderLarkAppDiagnosis() {
  const box = document.querySelector("#larkAppDiagnosis");
  if (!box) return;
  try {
    const diagnosis = await api("/api/lark-app-diagnose");
    const permissionHtml = diagnosis.permissions.map((item) => '<li><strong>' + escapeHtml(item.name) + '</strong><span>' + escapeHtml(item.why) + '</span></li>').join('');
    const stepHtml = diagnosis.steps.map((step, index) => '<li>' + (index + 1) + '. ' + escapeHtml(step) + '</li>').join('');
    const capabilityHtml = (diagnosis.capabilities || []).map((item) => '<li><strong>' + escapeHtml(item.group + ' · ' + item.title) + '</strong><span>' + escapeHtml(item.availability) + '</span><span>' + escapeHtml(item.purpose) + '</span><code>申请权限：' + escapeHtml(item.title) + '</code></li>').join('');
    box.innerHTML = [
      '<div class="copy-row"><label>本地回调 URL</label><code>' + escapeHtml(diagnosis.localCallbackUrl) + '</code><button data-copy="' + escapeHtml(diagnosis.localCallbackUrl) + '">复制</button></div>',
      '<div class="copy-row"><label>飞书后台应填写</label><code>' + escapeHtml(diagnosis.effectiveCallbackUrl) + '</code><button data-copy="' + escapeHtml(diagnosis.effectiveCallbackUrl) + '">复制</button></div>',
      '<div class="mode-note"><strong>关键提醒</strong><p>飞书后台不能访问 localhost。要做可 @ 的应用机器人，你需要公网 URL，比如 ngrok、Cloudflare Tunnel、Render/Railway 部署地址。</p></div>',
      '<h4>建议权限</h4><ul>' + permissionHtml + '</ul><h4>飞书能力目录</h4><p class="meta">在飞书中 @ 机器人并发送“申请权限：能力名称”，即可收到对应授权卡。显示“待接入执行器”的能力会先完成权限申请，再进入功能开发。</p><ul class="capability-list">' + capabilityHtml + '</ul><h4>安装步骤</h4><ol>' + stepHtml + '</ol>'
    ].join('');
    box.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        await navigator.clipboard.writeText(button.dataset.copy);
        toast('已复制');
      });
    });
  } catch (error) {
    box.innerHTML = '<div class="mode-note"><strong>诊断失败</strong><p>' + escapeHtml(error.message) + '</p></div>';
  }
}
function renderWorkflowSelect() {
  const select = $("#workflowSelect");
  select.innerHTML = state.db.workflows.map((workflow) => (
    `<option value="${workflow.id}">${escapeHtml(workflow.name)}</option>`
  )).join("");
  select.value = state.selectedWorkflowId || state.db.workflows[0]?.id;
}

function renderStudioSteps() {
  const workflow = currentWorkflow();
  if (!workflow) return;
  state.selectedWorkflowId = workflow.id;
  $("#workflowDescription").textContent = workflow.description || "";
  $("#workflowSteps").innerHTML = workflow.steps.map((step, index) => {
    const agent = state.db.agents.find((item) => item.id === step.agentId);
    const provider = state.db.providers.find((item) => item.id === agent?.providerId);
    const statusClass = provider?.enabled ? "enabled" : "disabled";
    return `
      <div class="step-item">
        <strong>${index + 1}. ${escapeHtml(agent?.name || step.agentId)}</strong>
        <div class="meta">${escapeHtml(step.task)}</div>
        <div class="pill-row">
          <span class="pill ${statusClass}">${escapeHtml(provider?.name || "No provider")}</span>
          <span class="pill">${escapeHtml(agent?.model || provider?.defaultModel || "No model")}</span>
        </div>
      </div>
    `;
  }).join("");
}

function renderProviders() {
  $("#providerList").innerHTML = state.db.providers.map((provider) => `
    <div class="card ${provider.id === state.selectedProviderId ? "selected" : ""}" data-provider-id="${provider.id}">
      <strong>${escapeHtml(provider.name)}</strong>
      <div class="meta">${escapeHtml(provider.baseUrl)}</div>
      <div class="pill-row">
        <span class="pill ${provider.enabled ? "enabled" : "disabled"}">${provider.enabled ? "启用" : "禁用"}</span>
        <span class="pill">${escapeHtml(provider.defaultModel)}</span>
        <span class="pill">${provider.apiKey ? "Key " + escapeHtml(provider.apiKey) : "未设置 key"}</span>
      </div>
    </div>
  `).join("");

  $$("[data-provider-id]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedProviderId = card.dataset.providerId;
      renderProviders();
      renderProviderForm();
    });
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
}

function formatCost(value, currency) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: currency || "USD", maximumFractionDigits: 6 }).format(Number(value) || 0);
}

function renderModelUsage() {
  const usage = state.modelUsage || { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costs: {}, byModel: [] };
  const costText = Object.entries(usage.costs || {}).map(([currency, cost]) => formatCost(cost, currency)).join(" + ") || "$0";
  $("#modelUsageStats").innerHTML = [
    [formatNumber(usage.requests), "模型请求"],
    [formatNumber(usage.inputTokens), "输入 Token"],
    [formatNumber(usage.outputTokens), "输出 Token"],
    [costText, "累计估算消费"]
  ].map(([value, label]) => `<div class="usage-metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
  $("#modelUsageModels").innerHTML = (usage.byModel || []).length
    ? usage.byModel.map((item) => `<div class="usage-metric"><strong>${escapeHtml(item.providerName)} / ${escapeHtml(item.model)}</strong><span>${formatNumber(item.requests)} 次 · ${formatNumber(item.totalTokens)} Token · ${escapeHtml(formatCost(item.cost, item.currency))}${item.unpricedRequests ? ` · ${item.unpricedRequests} 次未配置价格` : ""}</span></div>`).join("")
    : '<div class="meta">还没有模型调用记录。配置价格并调用模型后，这里会自动累计。</div>';
}

function renderProviderForm() {
  const provider = state.db.providers.find((item) => item.id === state.selectedProviderId) || {};
  const price = provider.pricing?.[provider.defaultModel] || {};
  setForm($("#providerForm"), { ...provider, inputPerMillion: price.inputPerMillion || 0, outputPerMillion: price.outputPerMillion || 0, currency: price.currency || "USD" });
  $("#providerForm").elements.apiKey.value = "";
}

function renderAgentProviderSelect() {
  $("#agentProviderSelect").innerHTML = state.db.providers.map((provider) => (
    `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`
  )).join("");
}

function renderAgents() {
  $("#agentList").innerHTML = state.db.agents.map((agent) => {
    const provider = state.db.providers.find((item) => item.id === agent.providerId);
    return `
      <div class="card ${agent.id === state.selectedAgentId ? "selected" : ""}" data-agent-id="${agent.id}">
        <strong>${escapeHtml(agent.name)}</strong>
        <div class="meta">${escapeHtml(agent.role)}</div>
        <div class="pill-row">
          <span class="pill">${escapeHtml(provider?.name || "No provider")}</span>
          <span class="pill">${escapeHtml(agent.model)}</span>
        </div>
      </div>
    `;
  }).join("");

  $$("[data-agent-id]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedAgentId = card.dataset.agentId;
      renderAgents();
      renderAgentForm();
    });
  });
}

function renderAgentForm() {
  const agent = state.db.agents.find((item) => item.id === state.selectedAgentId) || {};
  setForm($("#agentForm"), agent);
}

function renderWorkflows() {
  $("#workflowList").innerHTML = state.db.workflows.map((workflow) => `
    <div class="card ${workflow.id === state.selectedWorkflowId ? "selected" : ""}" data-workflow-id="${workflow.id}">
      <strong>${escapeHtml(workflow.name)}</strong>
      <div class="meta">${escapeHtml(workflow.description)}</div>
      <div class="pill-row">
        <span class="pill">${workflow.steps.length} steps</span>
        <span class="pill">${escapeHtml(workflow.inputType)}</span>
        <span class="pill">${workflow.builtIn ? "\u5185\u7f6e\u6a21\u677f" : "\u81ea\u5b9a\u4e49"}</span>
        ${workflow.system ? `<span class="pill">\u7cfb\u7edf\u80fd\u529b</span>` : ""}
      </div>
    </div>
  `).join("");

  $$("[data-workflow-id]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedWorkflowId = card.dataset.workflowId;
      renderWorkflowSelect();
      renderStudioSteps();
      renderWorkflows();
      renderWorkflowForm();
    });
  });
}

function workflowStepsToText(workflow) {
  return (workflow.steps || []).map((step) => `${step.agentId} | ${step.task}`).join("\\n");
}

function textToWorkflowSteps(text) {
  return String(text || "")
    .split("\\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [agentId, ...taskParts] = line.split("|");
      return {
        agentId: agentId.trim(),
        task: taskParts.join("|").trim() || "Complete this workflow step."
      };
    });
}

function renderWorkflowForm() {
  const workflow = state.db.workflows.find((item) => item.id === state.selectedWorkflowId) || {};
  const testMeta = $("#skillTestMeta");
  const testResult = $("#skillTestResult");
  if (testMeta) testMeta.textContent = "";
  if (testResult) testResult.innerHTML = "";
  setForm($("#workflowForm"), {
    ...workflow,
    triggerExamples: (workflow.triggerExamples || []).join("\n"),
    qualityChecklist: (workflow.qualityChecklist || []).join("\n"),
    enabled: String(workflow.enabled !== false),
    steps: workflowStepsToText(workflow)
  });
}

async function saveProvider(event) {
  event.preventDefault();
  const data = formData(event.currentTarget);
  const hasNewKey = Boolean(data.apiKey && !data.apiKey.includes("*"));
  data.enabled = hasNewKey ? true : data.enabled === "true";
  data.models = data.models.split(",").map((item) => item.trim()).filter(Boolean);
  const result = await api("/api/providers", { method: "POST", body: JSON.stringify(data) });
  state.selectedProviderId = result.provider.id;
  await loadState();
  toast(data.enabled ? "模型已保存并启用" : "模型已保存，但仍处于禁用状态");
}

async function saveAgent(event) {
  event.preventDefault();
  const data = formData(event.currentTarget);
  data.temperature = Number(data.temperature || 0.3);
  data.skills = data.skills.split(",").map((item) => item.trim()).filter(Boolean);
  const result = await api("/api/agents", { method: "POST", body: JSON.stringify(data) });
  state.selectedAgentId = result.agent.id;
  await loadState();
  toast("角色已保存");
}

async function deleteSelectedAgent() {
  const agent = state.db.agents.find((item) => item.id === state.selectedAgentId);
  if (!agent) return toast("请先选择要删除的角色");
  if (!window.confirm(`确定删除角色“${agent.name}”吗？此操作不能撤销。`)) return;
  try {
    await api(`/api/agents/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
    state.selectedAgentId = null;
    await loadState();
    state.selectedAgentId = state.db.agents[0]?.id || null;
    renderAll();
    toast("角色已删除");
  } catch (error) {
    toast(error.message);
  }
}

async function createSkillDraft() { const request=window.prompt('\u7528\u4e00\u53e5\u8bdd\u8bf4\u660e\u4f60\u60f3\u91cd\u590d\u4f7f\u7528\u7684\u5de5\u4f5c\u6d41\u7a0b\u3002'); if(!request?.trim())return; const button=document.querySelector('#createSkillDraftButton');button.disabled=true;try{const result=await api('/api/skills/draft',{method:'POST',body:JSON.stringify({request})});state.selectedWorkflowId=null;setForm(document.querySelector('#workflowForm'),{...result.skill,triggerExamples:(result.skill.triggerExamples||[]).join('\\n'),steps:workflowStepsToText(result.skill),enabled:'true'});document.querySelector('#skillTestInput').value=request;toast('\u5df2\u751f\u6210 Skill \u8349\u6848\uff0c\u4fee\u6539\u540e\u4fdd\u5b58\u5373\u53ef\u3002');}catch(error){toast(error.message);}finally{button.disabled=false;} }
async function testSkill() { const skillId=document.querySelector('#workflowForm').elements.id.value||state.selectedWorkflowId;const input=document.querySelector('#skillTestInput').value.trim();if(!skillId)return toast('\u8bf7\u5148\u4fdd\u5b58\u8fd9\u4e2a Skill\uff0c\u518d\u6d4b\u8bd5\u3002');if(!input)return toast('\u8bf7\u8f93\u5165\u6d4b\u8bd5\u6750\u6599\u3002');const button=document.querySelector('#testSkillButton'),meta=document.querySelector('#skillTestMeta'),box=document.querySelector('#skillTestResult');button.disabled=true;meta.textContent='\u6b63\u5728 Studio \u6c99\u76d2\u8fd0\u884c\uff0c\u4e0d\u4f1a\u53d1\u9001\u98de\u4e66\u6d88\u606f\u2026';box.innerHTML='';try{const run=await api('/api/skills/test',{method:'POST',body:JSON.stringify({skillId,input})});meta.textContent='\u6d4b\u8bd5\u5b8c\u6210\uff1a'+run.status+' / '+(run.steps||[]).length+' \u6b65';box.innerHTML='<pre>'+escapeHtml(run.finalOutput||'\u6ca1\u6709\u4ea7\u51fa\u5185\u5bb9\u3002')+'</pre>';}catch(error){meta.textContent=error.message;toast(error.message);}finally{button.disabled=false;} }
async function saveWorkflow(event) {
  event.preventDefault();
  const data = formData(event.currentTarget);
  data.steps = textToWorkflowSteps(data.steps);
  data.qualityChecklist = String(data.qualityChecklist || "").split("\n").map((item) => item.trim()).filter(Boolean);
  data.triggerExamples = data.triggerExamples.split("\n").map((item) => item.trim()).filter(Boolean);
  data.enabled = data.enabled === "true";
  data.outputMode = "markdown";
  const result = await api("/api/skills", { method: "POST", body: JSON.stringify(data) });
  state.selectedWorkflowId = result.skill.id;
  await loadState();
  toast("Skill 已保存");
}

async function deleteSelectedWorkflow() {
  const workflow = state.db.workflows.find((item) => item.id === state.selectedWorkflowId);
  if (!workflow) return toast("\u8bf7\u5148\u9009\u62e9\u8981\u5220\u9664\u7684 Skill");
  if (!window.confirm("\u786e\u5b9a\u5220\u9664 Skill \u201c" + workflow.name + "\u201d\u5417\uff1f\u4fdd\u7559\u5386\u53f2\u8fd0\u884c\u8bb0\u5f55\uff0c\u4f46\u4e0d\u80fd\u64a4\u9500\u5220\u9664\u3002")) return;
  try {
    await api("/api/skills/" + encodeURIComponent(workflow.id), { method: "DELETE" });
    state.selectedWorkflowId = null;
    await loadState();
    state.selectedWorkflowId = state.db.workflows[0]?.id || null;
    renderAll();
    toast("Skill \u5df2\u5220\u9664");
  } catch (error) {
    toast(error.message);
  }
}

async function runWorkflow() {
  const workflow = currentWorkflow();
  const input = $("#workflowInput").value.trim();
  if (!input) return toast("请先输入材料");
  $("#runWorkflowButton").disabled = true;
  $("#runStatus").textContent = "正在运行。每个角色会按 Skill 步骤顺序处理材料。";
  $("#runOutput").innerHTML = "";
  try {
    const run = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({ workflowId: workflow.id, input })
    });
    state.latestFinalOutput = run.finalOutput || "";
    $("#runStatus").textContent = `${run.workflowName} 完成：${run.status}`;
    $("#runOutput").innerHTML = `
      ${run.steps.map((step, index) => `
        <div class="agent-output panel">
          <div class="panel-heading">
            <h3>${index + 1}. ${escapeHtml(step.agentName)}</h3>
            <span>${escapeHtml(step.providerName)} / ${escapeHtml(step.model || "")} / ${step.durationMs}ms</span>
          </div>
          ${step.error ? `<div class="pill error">${escapeHtml(step.error)}</div>` : ""}
          <pre>${escapeHtml(step.content)}</pre>
        </div>
      `).join("")}
      <div class="final-output panel">
        <div class="panel-heading"><h3>最终输出</h3><span>${escapeHtml(run.id)}</span></div>
        <pre>${escapeHtml(run.finalOutput)}</pre>
      </div>
    `;
    state.modelUsage = await api("/api/model-usage");
    renderModelUsage();
    toast("Skill 已完成");
  } catch (error) {
    $("#runStatus").textContent = error.message;
    toast(error.message);
  } finally {
    $("#runWorkflowButton").disabled = false;
  }
}

async function saveLarkAppSettings(event) {
  event.preventDefault();
  const data = formData(event.currentTarget);
  const result = await api("/api/lark-settings", { method: "POST", body: JSON.stringify(data) });
  state.db.settings = result.settings;
  renderAll();
  setActiveView("lark");
  await renderLarkAppDiagnosis();
  toast("飞书 App 配置已保存");
}

async function testLarkApp() {
  try {
    await api("/api/lark-app-test", { method: "POST", body: JSON.stringify({}) });
    toast("App ID / Secret 测试通过");
  } catch (error) {
    toast(error.message);
  }
}

async function saveLarkSettings(event) {
  event.preventDefault();
  const data = formData(event.currentTarget);
  const result = await api("/api/lark-settings", { method: "POST", body: JSON.stringify(data) });
  state.db.settings = result.settings;
  renderLarkForm();
  toast("飞书连接已保存");
}

async function testLark() {
  try {
    await api("/api/lark-test", { method: "POST", body: JSON.stringify({}) });
    toast("测试消息已发送到飞书");
  } catch (error) {
    toast(error.message);
  }
}

async function sendToLark() {
  if (!state.latestFinalOutput) return toast("还没有最终输出，先运行一个 Skill");
  try {
    await api("/api/lark-send", {
      method: "POST",
      body: JSON.stringify({ text: state.latestFinalOutput })
    });
    toast("最终稿已发送到飞书");
  } catch (error) {
    toast(error.message);
  }
}

async function testProvider() {
  const providerId = $("#providerForm").elements.id.value;
  if (!providerId) return toast("请先选择模型");
  try {
    const result = await api("/api/test-provider", {
      method: "POST",
      body: JSON.stringify({ providerId })
    });
    toast(`连接成功：${result.message}`);
  } catch (error) {
    toast(error.message);
  }
}


async function runCollaborationPilot() {
  const button = document.querySelector("#runCollaborationPilotButton");
  const box = document.querySelector("#pilotResult");
  if (!button) return;
  button.disabled = true;
  button.textContent = "\u5b9e\u9a8c\u8fd0\u884c\u4e2d...";
  if (box) box.textContent = "\u6b63\u5728\u4f7f\u7528\u5f53\u524d\u8d26\u53f7\u5df2\u542f\u7528\u7684\u6a21\u578b\u8fd0\u884c\u4e24\u7c7b\u4efb\u52a1\u5bf9\u7167\uff0c\u8bf7\u52ff\u5173\u95ed\u9875\u9762\u3002";
  try {
    const result = await api("/api/collaboration-pilot", { method: "POST", body: JSON.stringify({}) });
    const lines = (result.experiments || []).map((item) => {
      const score = item.evaluation || {};
      return item.task.title + "\uff1a\u5355\u667a\u80fd\u4f53 " + (score.single?.overall || "-") + "/5\uff1b\u56fa\u5b9a\u534f\u4f5c " + (score.fixed?.overall || "-") + "/5\uff1b\u81ea\u9002\u5e94\u534f\u4f5c " + (score.adaptive?.overall || "-") + "/5\u3002";
    });
    if (box) box.textContent = "\u5df2\u5b8c\u6210\uff1a" + (result.model?.provider || "") + " / " + (result.model?.defaultModel || "") + "\u3002\u672a\u5411\u98de\u4e66\u53d1\u9001\u6d88\u606f\u3002\n" + lines.join("\n");
    await loadRuns();
    state.modelUsage = await api("/api/model-usage");
    renderModelUsage();
    toast("\u534f\u4f5c\u5b9e\u9a8c\u5b8c\u6210\uff0c\u672a\u5411\u98de\u4e66\u53d1\u9001\u4efb\u4f55\u6d88\u606f");
  } catch (error) {
    if (box) box.textContent = "\u5b9e\u9a8c\u672a\u5b8c\u6210\uff1a" + error.message;
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "\u8fd0\u884c\u534f\u4f5c\u5b9e\u9a8c";
  }
}

async function loadRuns() {
  const runs = await api("/api/runs");
  $("#runList").innerHTML = runs.length ? runs.map((run) => `
    <div class="run-item">
      <strong>${escapeHtml(run.workflowName)}</strong>
      <div class="meta">${escapeHtml(run.startedAt)} · ${escapeHtml(run.status)}</div>
      <p>${escapeHtml(run.finalPreview)}</p>
    </div>
  `).join("") : `<div class="meta">还没有运行记录。</div>`;
}

function bindIfPresent(selector, event, handler) {
  const element = document.querySelector(selector);
  if (element) element.addEventListener(event, handler);
}

function bindEvents() {
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveView(button.dataset.view);
    });
  });

  $("#workflowSelect").addEventListener("change", () => {
    state.selectedWorkflowId = $("#workflowSelect").value;
    renderStudioSteps();
  });
  $("#runWorkflowButton").addEventListener("click", runWorkflow);
  $("#quickSetupForm").addEventListener("submit", async (event) => { event.preventDefault(); await saveQuickSetup(); });
  $("#quickProviderSelect").addEventListener("change", fillQuickProviderFields);
  $("#quickRunButton").addEventListener("click", quickRun);
  $("#quickSaveButton").addEventListener("click", async () => { await saveQuickSetup(); });
  $("#quickSampleButton").addEventListener("click", () => { $("#quickInput").value = "一篇新论文声称 AI agents 可以提升文献综述流程，但评估主要依赖定性访谈，缺少可复现的基准测试。作者认为 agent 可以帮助研究者发现相关文献、提取研究问题、生成初步综述结构。"; });
  $("#quickSendLarkButton").addEventListener("click", sendToLark);
  $("#loadSampleButton").addEventListener("click", () => {
    $("#workflowInput").value = "我想做一个个人 AI agent 工作台。它需要支持多个模型供应商，比如 OpenAI、DeepSeek、豆包和 Kimi；用户可以用页面创建角色、配置技能、编排工作流，并在未来接入飞书文档和群聊。第一版应该尽可能非代码化，让用户通过互动页面完成配置。";
  });
  $("#clearInputButton").addEventListener("click", () => { $("#workflowInput").value = ""; });
  $("#copyOutputButton").addEventListener("click", async () => {
    if (!state.latestFinalOutput) return toast("还没有最终输出");
    await navigator.clipboard.writeText(state.latestFinalOutput);
    toast("最终稿已复制");
  });
  $("#sendToLarkButton").addEventListener("click", sendToLark);
  bindIfPresent("#providerForm", "submit", saveProvider);
  bindIfPresent("#agentForm", "submit", saveAgent);
  bindIfPresent("#deleteAgentButton", "click", deleteSelectedAgent);
  bindIfPresent("#workflowForm", "submit", saveWorkflow);
  bindIfPresent("#deleteWorkflowButton", "click", deleteSelectedWorkflow);
  bindIfPresent("#createSkillDraftButton", "click", createSkillDraft);
  bindIfPresent("#testSkillButton", "click", testSkill);
  bindIfPresent("#larkForm", "submit", saveLarkSettings);
  bindIfPresent("#larkAppForm", "submit", saveLarkAppSettings);
  bindIfPresent("#larkBotForm", "submit", saveLarkBot);
  bindIfPresent("#newLarkBotButton", "click", newLarkBot);
  bindIfPresent("#testLarkAppButton", "click", testLarkApp);
  bindIfPresent("#testLarkBotButton", "click", testLarkBot);
  bindIfPresent("#testLarkButton", "click", testLark);
  bindIfPresent("#testProviderButton", "click", testProvider);
  bindIfPresent("#refreshAssistantHealthButton", "click", refreshAssistantHealth);
  bindIfPresent("#refreshRunsButton", "click", loadRuns);
  bindIfPresent("#runCollaborationPilotButton", "click", runCollaborationPilot);

  $$(`[data-jump]`).forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.jump;
      const nav = document.querySelector(`.nav-item[data-view="${target}"]`);
      if (nav) nav.click();
    });
  });

  $("#newProviderButton").addEventListener("click", () => {
    state.selectedProviderId = null;
    setForm($("#providerForm"), {
      id: "",
      name: "",
      type: "openai_compatible",
      baseUrl: "",
      apiKey: "",
      defaultModel: "",
      enabled: "true",
      inputPerMillion: 0,
      outputPerMillion: 0,
      currency: "USD",
      models: "",
      notes: ""
    });
  });
  $("#newAgentButton").addEventListener("click", () => {
    state.selectedAgentId = null;
    setForm($("#agentForm"), {
      id: "",
      name: "",
      providerId: state.db.providers[0]?.id || "",
      model: state.db.providers[0]?.defaultModel || "",
      temperature: 0.3,
      role: "",
      style: "",
      goals: "",
      guardrails: "",
      outputFormat: "",
      skills: ""
    });
  });
  $("#newWorkflowButton").addEventListener("click", () => {
    state.selectedWorkflowId = null;
    setForm($("#workflowForm"), {
      id: "",
      name: "",
      inputType: "text",
      enabled: "true",
      description: "",
      triggerExamples: "",
      steps: `researcher | Analyze the source material.` + "\\n" + `editor | Produce the final output.`
    });
  });
}

bindEvents();
loadState().catch((error) => toast(error.message));
