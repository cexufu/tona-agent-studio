const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deterministicToolRequest, prepareAgentToolResult } = require("../runtime/agent-tools");
const { WorkspaceFileStore } = require("../runtime/workspace-files");

(async () => {
  assert.deepEqual(deterministicToolRequest("请计算 2 + 3 * 4"), { toolId: "math_calculate", input: { expression: "2 + 3 * 4" } });
  assert.deepEqual(deterministicToolRequest("把 10 公里换算为 mi"), { toolId: "unit_convert", input: { value: 10, from: "km", to: "mi" } });
  assert.equal(deterministicToolRequest("帮我写一份计划"), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tona-agent-tools-"));
  try {
    const store = new WorkspaceFileStore(root, "ws_agent_tools");
    const file = store.save({ name: "evidence.md", mime: "text/markdown", buffer: Buffer.from("Verified workspace evidence") });
    const request = deterministicToolRequest(`请读取 ${file.file_id} 并总结`);
    assert.equal(request.toolId, "file_read");
    const audit = [];
    const result = await prepareAgentToolResult({ text: `请读取 ${file.file_id} 并总结`, workspaceId: "ws_agent_tools", fileStore: store, audit: (event) => audit.push(event) });
    assert.equal(result.execution.resultType, "tool_result");
    assert.match(result.evidence, /Verified workspace evidence/);
    assert.match(result.evidence, /not model-authored text/);
    assert(audit.some((event) => event.status === "success"));
    console.log("Agent Runtime tool test passed: deterministic routing, unit aliases, file_id permission path, verified result evidence, and audit.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
