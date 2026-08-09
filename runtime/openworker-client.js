const crypto = require("crypto");
const WebSocket = require("ws");

const OPENWORKER_PROTOCOL_VERSION = "openworker-v1";
const DEFAULT_OPENWORKER_SETTINGS = Object.freeze({
  enabled: false,
  deployment: "embedded",
  baseUrl: "http://127.0.0.1:7360",
  apiToken: "",
  defaultAgent: "cowork",
  defaultMode: "interactive",
  defaultWorkspace: "",
  turnTimeoutMs: 15 * 60 * 1000
});

function normalizeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_OPENWORKER_SETTINGS.baseUrl));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("OpenWorker URL must use http or https.");
  if (url.username || url.password) throw new Error("OpenWorker URL must not contain credentials.");
  return url.toString().replace(/\/$/, "");
}

function normalizeOpenWorkerSettings(value = {}, env = process.env) {
  const envUrl = env.OPENWORKER_URL || env.TONA_OPENWORKER_URL;
  const envToken = env.OPENWORKER_API_TOKEN || env.COWORKER_API_TOKEN || env.TONA_OPENWORKER_TOKEN;
  const deployment = String(env.OPENWORKER_MODE || value.deployment || DEFAULT_OPENWORKER_SETTINGS.deployment);
  return {
    enabled: env.OPENWORKER_ENABLED != null ? env.OPENWORKER_ENABLED !== "false" : value.enabled === true,
    deployment: ["embedded", "remote"].includes(deployment) ? deployment : "remote",
    baseUrl: normalizeBaseUrl(envUrl || value.baseUrl || DEFAULT_OPENWORKER_SETTINGS.baseUrl),
    apiToken: String(envToken || value.apiToken || ""),
    defaultAgent: String(value.defaultAgent || env.OPENWORKER_DEFAULT_AGENT || DEFAULT_OPENWORKER_SETTINGS.defaultAgent).slice(0, 80),
    defaultMode: ["discuss", "plan", "interactive", "auto"].includes(value.defaultMode) ? value.defaultMode : DEFAULT_OPENWORKER_SETTINGS.defaultMode,
    defaultWorkspace: String(value.defaultWorkspace || env.OPENWORKER_WORKSPACE || DEFAULT_OPENWORKER_SETTINGS.defaultWorkspace).slice(0, 1000),
    syncProviders: env.OPENWORKER_SYNC_PROVIDERS != null ? env.OPENWORKER_SYNC_PROVIDERS === "true" : value.syncProviders != null ? value.syncProviders === true || value.syncProviders === "true" : deployment === "embedded",
    turnTimeoutMs: Math.max(30_000, Math.min(60 * 60 * 1000, Number(value.turnTimeoutMs) || DEFAULT_OPENWORKER_SETTINGS.turnTimeoutMs))
  };
}

function publicOpenWorkerSettings(value = {}, mask = (secret) => secret ? "********" : "") {
  const settings = normalizeOpenWorkerSettings(value);
  return { ...settings, apiToken: mask(settings.apiToken), tokenConfigured: Boolean(settings.apiToken) };
}

function wsUrl(settings, sessionId, workspace, agent) {
  const url = new URL(settings.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/session/${encodeURIComponent(sessionId)}`;
  url.search = new URLSearchParams({ workspace: workspace || "", agent: agent || settings.defaultAgent }).toString();
  return url.toString();
}

function eventText(data = {}) {
  return String(data.text || data.content || data.message || "");
}

function statusForInbox(item) {
  if (!item) return "running";
  if (item.kind === "approval" || item.kind === "directory" || item.kind === "plan") return "waiting_confirmation";
  if (item.kind === "question") return "waiting_input";
  return "waiting_confirmation";
}

class OpenWorkerClient {
  constructor(settings = {}, options = {}) {
    this.settings = normalizeOpenWorkerSettings(settings, options.env || process.env);
    this.fetch = options.fetch || globalThis.fetch;
    this.WebSocket = options.WebSocket || WebSocket;
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 20_000);
    try {
      const response = await this.fetch(this.settings.baseUrl + pathname, {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(this.settings.apiToken ? { "X-OpenWorker-Token": this.settings.apiToken } : {}),
          ...(options.headers || {})
        },
        signal: options.signal || controller.signal
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) throw Object.assign(new Error(data.error || data.detail || `OpenWorker HTTP ${response.status}`), { statusCode: response.status, data });
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  health() { return this.request("/v1/health", { timeoutMs: 5000 }); }
  agents() { return this.request("/v1/agents"); }
  personas() { return this.request("/v1/personas"); }
  skills(workspace = "") { return this.request(`/v1/skills${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`); }
  providers() { return this.request("/v1/providers"); }
  setProvider(name, fields) { return this.request("/v1/providers", { method: "POST", body: JSON.stringify({ name, fields }) }); }
  addModel(model) { return this.request("/v1/settings/models/add", { method: "POST", body: JSON.stringify({ model }) }); }
  sessions(workspace = "") { return this.request(`/v1/sessions${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""}`); }
  messages(sessionId) { return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`); }
  artifacts(sessionId) { return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`); }
  inbox(sessionId, state = "pending") { return this.request(`/v1/inbox?session_id=${encodeURIComponent(sessionId)}&state=${encodeURIComponent(state)}`); }
  setUnattended(sessionId, unattended = true) { return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/unattended`, { method: "POST", body: JSON.stringify({ unattended }) }); }
  resolveInbox(itemId, resolution) { return this.request(`/v1/inbox/${encodeURIComponent(itemId)}/resolve`, { method: "POST", body: JSON.stringify({ resolution }) }); }
  interrupt(sessionId) { return this.connectAndSend(sessionId, { type: "interrupt" }); }

  async syncProvider(provider, model = "") {
    if (!provider?.apiKey) throw new Error("TONA provider has no API key to sync.");
    const id = String(provider.id || "openai").toLowerCase();
    const native = new Set(["openai", "anthropic", "gemini", "deepseek", "kimi", "minimax", "qwen", "xai", "mistral", "zai", "meta", "ollama"]);
    const name = native.has(id) ? id : "openai";
    const fields = { api_key: provider.apiKey };
    const baseUrl = String(provider.baseUrl || "").replace(/\/+$/, "");
    if (baseUrl && !(name === "openai" && /^https://api.openai.com/v1$/i.test(baseUrl))) fields.base_url = baseUrl;
    const saved = await this.setProvider(name, fields);
    if (saved?.ok === false) throw new Error(saved.error || ("OpenWorker rejected provider " + name + "."));
    const bareModel = String(model || provider.defaultModel || "").replace(new RegExp("^" + name + ":"), "");
    const workerModel = bareModel ? (name === "openai" ? bareModel : name + ":" + bareModel) : "";
    if (workerModel) await this.addModel(workerModel).catch(() => ({}));
    return { ok: true, provider: name, model: workerModel };
  }

  async syncSkill(workflow, workspace = "") {
    const name = String(workflow.id || workflow.name || "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    if (!name) throw new Error("Skill name is required.");
    const description = String(workflow.description || workflow.name || name).slice(0, 500);
    const instructions = [
      workflow.inputGuide ? `## Input\n${workflow.inputGuide}` : "",
      ...(workflow.steps || []).map((step, index) => `## Step ${index + 1}\n${step.task || step.prompt || ""}`),
      workflow.outputContract ? `## Output contract\n${workflow.outputContract}` : "",
      workflow.qualityChecklist?.length ? `## Quality checks\n${workflow.qualityChecklist.map((item) => `- ${item}`).join("\n")}` : ""
    ].filter(Boolean).join("\n\n") || String(workflow.prompt || description);
    const existing = await this.skills(workspace);
    const payload = { name, description, instructions, scope: workspace ? "project" : "global", ...(workspace ? { workspace } : {}) };
    const found = (existing.skills || []).some((skill) => skill.name === name);
    return this.request(found ? `/v1/skills/${encodeURIComponent(name)}` : "/v1/skills", { method: found ? "PATCH" : "POST", body: JSON.stringify(payload) });
  }

  connectAndSend(sessionId, payload, { workspace = "", agent = "" } = {}) {
    return new Promise((resolve, reject) => {
      const protocols = this.settings.apiToken ? ["openworker", this.settings.apiToken] : undefined;
      const socket = new this.WebSocket(wsUrl(this.settings, sessionId, workspace, agent), protocols);
      const timer = setTimeout(() => { socket.terminate?.(); reject(new Error("OpenWorker WebSocket connection timed out.")); }, 10_000);
      socket.once("open", () => { clearTimeout(timer); socket.send(JSON.stringify(payload)); setTimeout(() => { socket.close(); resolve({ ok: true }); }, 100); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  }

  async runTurn(input = {}) {
    const sessionId = String(input.sessionId || `tona_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
    const workspace = String(input.workspace || this.settings.defaultWorkspace || "");
    const agent = String(input.agent || this.settings.defaultAgent || "cowork");
    await this.setUnattended(sessionId, input.unattended !== false).catch(() => ({}));
    return new Promise((resolve, reject) => {
      const protocols = this.settings.apiToken ? ["openworker", this.settings.apiToken] : undefined;
      const socket = new this.WebSocket(wsUrl(this.settings, sessionId, workspace, agent), protocols);
      const events = [];
      const tools = [];
      let assistant = "";
      let stream = "";
      let settled = false;
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch {}
        let pending = result.pending || null;
        if (!pending && result.status?.startsWith("waiting_")) {
          try { pending = (await this.inbox(sessionId)).items?.[0] || null; } catch {}
        }
        resolve({
          protocol: OPENWORKER_PROTOCOL_VERSION,
          sessionId, workspace, agent,
          status: pending ? statusForInbox(pending) : result.status,
          message: assistant || stream || result.message || "",
          pending,
          events,
          tools,
          usage: events.filter((event) => event.type === "assistant_message").map((event) => event.data?.usage).filter(Boolean).at(-1) || null
        });
      };
      const timer = setTimeout(() => finish({ status: "running", message: "OpenWorker 仍在后台执行，可在任务中心继续查看。" }), Number(input.timeoutMs) || this.settings.turnTimeoutMs);
      socket.on("open", () => {
        if (input.mode || this.settings.defaultMode) socket.send(JSON.stringify({ type: "set_mode", mode: input.mode || this.settings.defaultMode }));
        if (input.resumeOnly !== true) socket.send(JSON.stringify({ type: "user_message", text: String(input.text || ""), ...(input.model ? { model: input.model } : {}), ...(input.skill ? { skill: input.skill } : {}) }));
      });
      socket.on("message", async (raw) => {
        let event;
        try { event = JSON.parse(String(raw)); } catch { return; }
        events.push(event); if (events.length > 200) events.shift();
        input.onEvent?.(event);
        const data = event.data || {};
        if (event.type === "assistant_delta") stream += eventText(data);
        if (event.type === "assistant_message") { assistant = eventText(data) || stream; stream = ""; }
        if (event.type === "tool_started" || event.type === "tool_proposed") tools.push({ name: data.name || "tool", status: "running", arguments: data.arguments || {} });
        if (event.type === "tool_finished") {
          const row = [...tools].reverse().find((item) => item.name === data.name && item.status === "running");
          if (row) Object.assign(row, { status: data.status || "completed", preview: data.result_preview || data.reason || "" });
          else tools.push({ name: data.name || "tool", status: data.status || "completed", preview: data.result_preview || data.reason || "" });
        }
        if (["permission_required", "directory_requested", "plan_proposed"].includes(event.type)) await finish({ status: "waiting_confirmation" });
        else if (event.type === "question_requested") await finish({ status: "waiting_input" });
        else if (event.type === "error" || event.type === "input_rejected") await finish({ status: "failed", message: data.error || "OpenWorker task failed." });
        else if (event.type === "interrupted") await finish({ status: "cancelled", message: "任务已终止。" });
        else if (event.type === "turn_done") await finish({ status: "completed" });
      });
      socket.on("error", (error) => { if (!settled) { clearTimeout(timer); settled = true; reject(error); } });
      socket.on("close", () => { if (!settled) finish({ status: assistant || stream ? "completed" : "failed", message: assistant || stream || "OpenWorker connection closed before a result was returned." }); });
    });
  }
}

module.exports = {
  OPENWORKER_PROTOCOL_VERSION,
  DEFAULT_OPENWORKER_SETTINGS,
  normalizeOpenWorkerSettings,
  publicOpenWorkerSettings,
  OpenWorkerClient,
  statusForInbox
};
