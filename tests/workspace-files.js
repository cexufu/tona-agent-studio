const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WorkspaceFileStore, rowsToCsv } = require("../runtime/workspace-files");
const { executeTool, TOOL_CATALOG } = require("../runtime/tool-runtime");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tona-files-"));
  try {
    const alpha = new WorkspaceFileStore(path.join(root, "alpha"), "ws_alpha");
    const beta = new WorkspaceFileStore(path.join(root, "beta"), "ws_beta");
    const uploaded = alpha.save({ name: "notes.md", mime: "text/markdown", buffer: Buffer.from("# Notes\nFirst version", "utf8"), createdBy: "tester" });
    assert.match(uploaded.file_id, /^file_/);
    assert.equal(uploaded.version, 1);
    assert.equal(uploaded.checksum.length, 64);
    assert.equal(beta.list().length, 0);
    assert.throws(() => beta.readText(uploaded.file_id), (error) => error.code === "FILE_NOT_FOUND");

    const second = alpha.save({ fileId: uploaded.file_id, name: "notes.md", mime: "text/markdown", buffer: Buffer.from("# Notes\nSecond version", "utf8"), source: "test_version" });
    assert.equal(second.version, 2);
    assert.equal(second.versions.length, 2);
    assert.match(alpha.readText(uploaded.file_id, { version: 1 }).content, /First version/);
    assert.match(alpha.readText(uploaded.file_id).content, /Second version/);

    const html = alpha.save({ name: "page.html", mime: "text/html", buffer: Buffer.from("<h1>Visible</h1><script>secret()</script>") });
    const htmlRead = alpha.readText(html.file_id);
    assert.match(htmlRead.content, /Visible/);
    assert(!htmlRead.content.includes("secret()"));

    const generated = await executeTool("artifact_generate", { name: "summary", format: "markdown", content: "# Summary" }, {
      workspaceId: "ws_alpha", authorizedWorkspaceId: "ws_alpha", allowedRisks: ["read", "write"], fileStore: alpha
    });
    assert.match(generated.data.file.artifact_id, /^art_/);
    assert.deepEqual(generated.artifactIds, [generated.data.file.artifact_id]);
    await assert.rejects(() => executeTool("artifact_generate", { name: "blocked", format: "txt", content: "no" }, {
      workspaceId: "ws_alpha", authorizedWorkspaceId: "ws_alpha", fileStore: alpha
    }), (error) => error.code === "TOOL_RISK_NOT_APPROVED");

    const read = await executeTool("file_read", { file_id: generated.data.file.file_id }, {
      workspaceId: "ws_alpha", authorizedWorkspaceId: "ws_alpha", fileStore: alpha
    });
    assert.equal(read.resultType, "tool_result");
    assert.equal(read.data.content, "# Summary");

    assert.equal(rowsToCsv([{ name: "A, B", value: 3 }]), 'name,value\r\n"A, B",3');
    const renamed = alpha.rename(uploaded.file_id, "research-notes.md");
    assert.equal(renamed.name, "research-notes.md");
    const deleted = alpha.delete(uploaded.file_id);
    assert(deleted.deletedAt);
    assert.throws(() => alpha.readText(uploaded.file_id), (error) => error.code === "FILE_NOT_FOUND");

    assert(TOOL_CATALOG.some((tool) => tool.id === "file_read" && tool.risk === "read"));
    assert(TOOL_CATALOG.some((tool) => tool.id === "artifact_generate" && tool.risk === "write"));
    console.log("Workspace file test passed: isolation, versions, checksums, safe text extraction, Runtime risk, artifact_id, rename, and soft delete.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
