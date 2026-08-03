const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual(duplicates, [], `Duplicate HTML ids: ${duplicates.join(", ")}`);

for (const id of [
  "view-agents", "agentRosterCount", "agentForm", "agentSkillBindings", "agentToolBindings",
  "agentChannelStatus", "agentChannelAppId", "agentUsagePanel", "view-tasks", "assistantTaskList"
]) assert(ids.includes(id), `Missing P0/P1 UI element: ${id}`);

for (const label of ["问剑台", "布阵台", "内功堂", "群侠谱", "武学阁", "神兵坊", "藏经阁", "飞鸽驿", "江湖令", "行迹录"]) {
  assert(html.includes(label), `Missing navigation label: ${label}`);
}
assert(app.includes("data.skillBindings"));
assert(app.includes("data.toolPolicy"));
assert(app.includes("data.memoryPolicy"));
assert(app.includes("data.runtimePolicy"));
assert(app.includes("/api/assistant-tasks/"));
assert(app.includes("/api/feishu/oauth/config?botId="), "Agent UI must read bot-scoped OAuth status");
assert(app.includes("/api/feishu/oauth/start"), "Agent UI must start bot-scoped OAuth");
assert(html.includes("startFeishuOauthButton"), "Feishu workspace must expose the OAuth action");
assert(html.includes("oauthAgentChannelButton"), "Agent channel tab must expose the OAuth action");
assert(!app.includes("个人 OAuth 执行器尚未接通"), "UI must not show the retired OAuth placeholder");
assert(css.includes(".agent-studio-layout"));
assert(css.includes(".task-list"));

const staticSelectors = [...app.matchAll(/(?:\$|querySelector)\(\s*["']#([A-Za-z][\w-]*)/g)].map((match) => match[1]);
const generatedIds = new Set(["agentOauthStatus", "larkAppForm"]);
const missing = [...new Set(staticSelectors)].filter((id) => !ids.includes(id) && !generatedIds.has(id));
assert.deepEqual(missing, [], `App references missing static ids: ${missing.join(", ")}`);

console.log("Agent Studio UI test passed: navigation, Agent tabs, capability forms, task center, selectors, and OAuth truthfulness.");
