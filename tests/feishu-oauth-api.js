const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-oauth-api-"));
const port = 17437;
const fakeApiPort = 17438;
let child;
let fakeApi;

async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  return { status: response.status, body: await response.json() };
}
async function ready() {
  for (let index = 0; index < 50; index += 1) {
    try { if ((await request("/api/health")).body.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("OAuth API server did not start.");
}

(async () => {
  fakeApi = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/authen/v2/oauth/token" && req.method === "POST") return res.end(JSON.stringify({ code: 0, access_token: "uat_callback_secret", refresh_token: "urt_callback_secret", expires_in: 7200, refresh_expires_in: 2592000, scope: "calendar:calendar calendar:calendar:readonly offline_access" }));
    if (req.url === "/authen/v1/user_info") return res.end(JSON.stringify({ code: 0, data: { open_id: "ou_callback_user", union_id: "on_callback_user", name: "OAuth Tester" } }));
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 404, msg: "not found" }));
  });
  await new Promise((resolve) => fakeApi.listen(fakeApiPort, "127.0.0.1", resolve));
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir, TONA_HUB_AUTH_REQUIRED: "false",
      TONA_SECRETS_KEY: "oauth-api-test-encryption-key-32-bytes",
      FEISHU_OPEN_API_BASE: `http://127.0.0.1:${fakeApiPort}`
    },
    stdio: "ignore"
  });
  try {
    await ready();
    const saved = await request("/api/lark-bots", { method: "POST", body: JSON.stringify({ name: "OAuth bot", appId: "cli_oauth_test", appSecret: "feishu-oauth-test-secret", agentId: "daily_assistant", enabled: true }) });
    assert.equal(saved.status, 200);
    const started = await request("/api/feishu/oauth/start", { method: "POST", headers: { "X-Forwarded-Host": "tona.example", "X-Forwarded-Proto": "https" }, body: JSON.stringify({ toolId: "feishu_calendar_plan" }) });
    assert.equal(started.status, 200);
    assert.equal(started.body.redirectUri, "https://tona.example/feishu/oauth/callback/usr_owner");
    assert(started.body.scopes.includes("calendar:calendar"));
    assert(started.body.scopes.includes("offline_access"));
    const url = new URL(started.body.authorizationUrl);
    assert.equal(url.hostname, "accounts.feishu.cn");
    assert.equal(url.searchParams.get("client_id"), "cli_oauth_test");
    const state = url.searchParams.get("state");
    assert(state);

    const callback = await fetch(`http://127.0.0.1:${port}/feishu/oauth/callback/usr_owner?code=oauth-code&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /authorization complete/i);

    const status = await request("/api/feishu/oauth/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.connected, true);
    assert.equal(status.body.authorizations[0].userOpenId, "ou_callback_user");
    assert(!JSON.stringify(status.body).includes("uat_callback_secret"));
    assert(!JSON.stringify(status.body).includes("urt_callback_secret"));

    const runtime = await request("/api/runtime");
    const calendar = runtime.body.tools.find((tool) => tool.id === "feishu_calendar_plan");
    assert.equal(calendar.status, "authorized");
    assert.equal(calendar.action.type, "feishu_oauth");

    const stored = fs.readFileSync(path.join(dataDir, "studio.json"), "utf8");
    assert(!stored.includes("uat_callback_secret"));
    assert(!stored.includes("urt_callback_secret"));
    assert.match(stored, /enc:v1:/);
    console.log("Feishu OAuth API test passed: consent URL, signed callback, token exchange, encrypted storage, safe status, and authorized Runtime state.");
  } finally {
    child?.kill();
    await new Promise((resolve) => fakeApi?.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
