const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-runtime-api-"));
const port = 17431;
const apiKey = "tvly-runtime-workspace-secret";
let child;

async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

async function waitUntilReady() {
  for (let index = 0; index < 50; index += 1) {
    try {
      if ((await request("/api/health")).body.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("TONA Runtime API did not become ready.");
}

(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      TONA_HUB_AUTH_REQUIRED: "false",
      TONA_SECRETS_KEY: "runtime-api-test-encryption-key"
    },
    stdio: "ignore"
  });
  try {
    await waitUntilReady();
    const initial = await request("/api/runtime");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.settings.search.ready, false);

    const saved = await request("/api/runtime", {
      method: "POST",
      body: JSON.stringify({
        enabled: true,
        search: { provider: "tavily", apiKey, dailyLimit: 12, maxResults: 4 },
        webReader: { enabled: true, maxCharacters: 12000 }
      })
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.search.ready, true);
    assert.equal(saved.body.settings.search.credentialSource, "workspace");
    assert(!saved.body.settings.search.apiKey.includes("secret"));

    const masked = saved.body.settings.search.apiKey;
    const preserved = await request("/api/runtime", {
      method: "POST",
      body: JSON.stringify({
        enabled: true,
        search: { provider: "tavily", apiKey: masked, dailyLimit: 15, maxResults: 5 },
        webReader: { enabled: true, maxCharacters: 16000 }
      })
    });
    assert.equal(preserved.body.settings.search.ready, true);
    assert.equal(preserved.body.settings.search.dailyLimit, 15);

    const stored = fs.readFileSync(path.join(dataDir, "studio.json"), "utf8");
    assert(!stored.includes(apiKey));
    assert(stored.includes("enc:v1:"));
    console.log("Runtime API test passed: workspace isolation, masked-key preservation, and encrypted storage.");
  } finally {
    child?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
