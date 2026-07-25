const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-admin-test-"));
const port = 17421;
const modelPort = 17422;
const modelServer = http.createServer((req, res) => {
  if (req.url !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ model: "test-model", choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } }));
});

let child;
async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const body = await response.json();
  return { status: response.status, body };
}

async function waitUntilReady() {
  for (let index = 0; index < 50; index += 1) {
    try { if ((await request("/api/health")).body.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TONA did not become ready");
}

(async () => {
  await new Promise((resolve) => modelServer.listen(modelPort, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["server.js"], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, TONA_HUB_AUTH_REQUIRED: "false" }, stdio: "ignore" });
  try {
    await waitUntilReady();
    await request("/api/providers", { method: "POST", body: JSON.stringify({ id: "test", name: "Test", type: "openai_compatible", baseUrl: `http://127.0.0.1:${modelPort}/v1`, apiKey: "test-key", defaultModel: "test-model", models: ["test-model"], enabled: true, currency: "USD", inputPerMillion: 2, outputPerMillion: 4 }) });
    await request("/api/agents", { method: "POST", body: JSON.stringify({ id: "temporary_agent", name: "Temporary", providerId: "test", model: "test-model", role: "test", style: "test", goals: "test", guardrails: "test", outputFormat: "text", temperature: 0 }) });
    await request("/api/skills", { method: "POST", body: JSON.stringify({ id: "test_skill", name: "Test Skill", description: "test", enabled: true, triggerExamples: ["run test"], inputType: "text", steps: [{ agentId: "temporary_agent", task: "complete" }] }) });

    const run = await request("/api/run", { method: "POST", body: JSON.stringify({ skillId: "test_skill", input: "input" }) });
    if (run.status !== 200 || run.body.finalOutput !== "done") throw new Error("Skill execution failed");
    const usage = (await request("/api/model-usage")).body;
    if (usage.requests !== 1 || Math.abs(usage.costs.USD - 0.004) > 1e-9) throw new Error("Model cost calculation failed");

    const pilot = await request("/api/collaboration-pilot", { method: "POST", body: JSON.stringify({}) });
    if (pilot.status !== 200 || pilot.body.experiments?.length !== 2) throw new Error("Collaboration pilot failed");
    if (pilot.body.experimentDesign?.preflight !== true || pilot.body.experimentDesign?.maxOnePilotPerWorkspace !== true) throw new Error("Collaboration pilot safeguards missing");
    if (!pilot.body.experiments.every((item) => item.protocols?.adaptive?.selectedAgent)) throw new Error("Adaptive specialist selection was not recorded");
    const usageAfterPilot = (await request("/api/model-usage")).body;
    if (usageAfterPilot.requests <= usage.requests) throw new Error("Pilot model usage was not recorded");

    const blocked = await request("/api/agents/temporary_agent", { method: "DELETE" });
    if (blocked.status !== 409 || !blocked.body.dependencies.skills.includes("Test Skill")) throw new Error("Referenced agent deletion was not blocked");
    await request("/api/skills", { method: "POST", body: JSON.stringify({ id: "test_skill", name: "Test Skill", description: "test", enabled: true, steps: [{ agentId: "daily_assistant", task: "complete" }] }) });
    const deleted = await request("/api/agents/temporary_agent", { method: "DELETE" });
    if (deleted.status !== 200 || !deleted.body.ok) throw new Error("Unreferenced agent was not deleted");
    const deletedSkill = await request("/api/skills/test_skill", { method: "DELETE" });
    if (deletedSkill.status !== 200 || !deletedSkill.body.ok) throw new Error("Skill deletion endpoint failed");
    const skillsAfterDelete = await request("/api/skills");
    if (skillsAfterDelete.body.skills.some((skill) => skill.id === "test_skill")) throw new Error("Deleted Skill remained in registry");

    console.log("Studio admin features passed: Skill Center, safe agent deletion, and model cost tracking.");
  } finally {
    child?.kill();
    modelServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
