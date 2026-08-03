const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPluginHost, PluginValidationError } = require("../runtime/plugin-runtime");
const { HybridMemoryStore, memoryTools } = require("../runtime/memory-tools");
const { createToolRegistry, executeRegisteredTool } = require("../runtime/runtime-v2");
const { PLUGIN_CATALOG, TOOL_CATALOG, executeTool } = require("../runtime/tool-runtime");

(async () => {
  assert(PLUGIN_CATALOG.some((plugin) => plugin.id === "tona.memory" && plugin.scope === "universal"));
  assert(TOOL_CATALOG.some((tool) => tool.id === "memory_search" && tool.plugin?.id === "tona.memory"));
  assert.throws(() => createPluginHost([{ id: "bad", version: "1", scope: "workspace", tools: [] }]), PluginValidationError);

  const hooks = [];
  const host = createPluginHost([{
    id: "test.quality",
    name: "Quality test",
    version: "1.0.0",
    scope: "universal",
    hooks: { beforeTool: () => hooks.push("before"), afterTool: () => hooks.push("after") },
    tools: [{
      id: "quality_echo", name: "Quality echo", category: "test", risk: "read", status: "ready",
      description: "Test quality gates.", policy: { timeoutMs: 1000 },
      inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
      outputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
      qualityGates: [({ data }) => ({ id: "non_empty", ok: Boolean(data.value), message: "Value must not be empty." })],
      handler: (input) => input
    }]
  }]);
  const trace = await executeRegisteredTool(createToolRegistry(host.tools), "quality_echo", { value: "ok" }, { workspaceId: "ws_plugins" });
  assert.match(trace.traceId, /^trc_/);
  assert.equal(trace.pluginId, "test.quality");
  assert.deepEqual(trace.quality, [{ id: "non_empty", ok: true }]);
  assert.deepEqual(hooks, ["before", "after"]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tona-memory-"));
  try {
    const first = new HybridMemoryStore(path.join(root, "one"), "ws_one");
    const second = new HybridMemoryStore(path.join(root, "two"), "ws_two");
    const remembered = await executeTool("memory_remember", { title: "偏好", content: "用户偏好中文简洁答复", tags: ["preference"], importance: 0.9 }, { workspaceId: "ws_one", authorizedWorkspaceId: "ws_one", allowedRisks: ["read", "write"], memoryStore: first });
    const restarted = new HybridMemoryStore(path.join(root, "one"), "ws_one");
    const found = await executeTool("memory_search", { query: "中文答复" }, { workspaceId: "ws_one", authorizedWorkspaceId: "ws_one", memoryStore: restarted });
    assert.equal(found.data.matches[0].memory_id, remembered.data.memory_id);
    assert.equal(found.data.mode, "hybrid_lexical_recency");
    const isolated = await executeTool("memory_search", { query: "中文答复" }, { workspaceId: "ws_two", authorizedWorkspaceId: "ws_two", memoryStore: second });
    assert.equal(isolated.data.matches.length, 0);
    await executeTool("memory_forget", { memory_id: remembered.data.memory_id }, { workspaceId: "ws_one", authorizedWorkspaceId: "ws_one", allowedRisks: ["read", "write"], memoryStore: restarted });
    assert.equal(restarted.readAll().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Plugin and memory test passed: universal manifests, hooks, quality gates, trace IDs, persistence, hybrid retrieval, confirmation risk, and workspace isolation.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
