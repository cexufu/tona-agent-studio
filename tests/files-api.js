const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-files-api-"));
const port = 17432;
let child;

async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const type = response.headers.get("content-type") || "";
  return { status: response.status, headers: response.headers, body: type.includes("application/json") ? await response.json() : await response.text() };
}

async function ready() {
  for (let index = 0; index < 50; index += 1) {
    try { if ((await request("/api/health")).body.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("File API server did not start.");
}

(async () => {
  child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, TONA_HUB_AUTH_REQUIRED: "false", TONA_SECRETS_KEY: "" },
    stdio: "ignore"
  });
  try {
    await ready();
    const uploaded = await request("/api/files", { method: "POST", body: JSON.stringify({ name: "input.json", mime: "application/json", text: '{"answer":42}' }) });
    assert.equal(uploaded.status, 201);
    const fileId = uploaded.body.file.file_id;
    assert.match(fileId, /^file_/);
    const list = await request("/api/files");
    assert.equal(list.body.files.length, 1);
    assert(!JSON.stringify(list.body).includes("blob"));
    const read = await request(`/api/files/${fileId}/read`);
    assert.equal(read.body.resultType, "tool_result");
    assert.match(read.body.data.content, /"answer": 42/);

    const generated = await request("/api/files/generate", { method: "POST", headers: { "Idempotency-Key": "file-api-artifact-1" }, body: JSON.stringify({ name: "report.md", format: "markdown", content: "# Verified report" }) });
    assert.equal(generated.status, 201);
    assert.match(generated.body.data.file.artifact_id, /^art_/);
    assert.deepEqual(generated.body.artifactIds, [generated.body.data.file.artifact_id]);

    const renamed = await request(`/api/files/${fileId}`, { method: "PATCH", body: JSON.stringify({ name: "renamed.json" }) });
    assert.equal(renamed.body.file.name, "renamed.json");
    const invalidVersion = await request(`/api/files/${fileId}/versions`, { method: "POST", body: JSON.stringify({ name: "renamed.json", mime: "application/json", contentBase64: "not-base64!" }) });
    assert.equal(invalidVersion.status, 400);
    const versioned = await request(`/api/files/${fileId}/versions`, { method: "POST", body: JSON.stringify({ name: "renamed.json", mime: "application/json", text: '{"answer":43}' }) });
    assert.equal(versioned.body.file.version, 2);
    assert.equal(versioned.body.file.versions.length, 2);

    const downloaded = await request(`/api/files/${fileId}/content`);
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-disposition"), /attachment/);
    assert.deepEqual(downloaded.body, { answer: 43 });
    const refused = await request(`/api/files/${fileId}`, { method: "DELETE", body: JSON.stringify({}) });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "FILE_DELETE_CONFIRMATION_REQUIRED");
    const deleted = await request(`/api/files/${fileId}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) });
    assert.equal(deleted.status, 200);
    const after = await request("/api/files");
    assert.equal(after.body.files.length, 1, "only generated artifact should remain after deleting upload");

    const usage = fs.readFileSync(path.join(dataDir, "tool-usage.jsonl"), "utf8");
    assert.match(usage, /artifact_generate/);
    assert(!usage.includes("Verified report"), "audit log must not persist generated file content");
    console.log("Files API test passed: upload, list, Runtime read, generation, artifact_id, download, version, rename, confirmation, soft delete, and safe audit.");
  } finally {
    child?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
