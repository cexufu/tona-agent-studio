const assert = require("assert");
const { buildIsolatedExecutorTools, executorConfig } = require("../runtime/isolated-executor-tools");
const { createPluginHost } = require("../runtime/plugin-runtime");
const { createToolRegistry, executeRegisteredTool } = require("../runtime/runtime-v2");

(async () => {
  assert.equal(executorConfig({}).ready, false);
  const config = executorConfig({ TONA_EXECUTOR_URL: "https://executor.example.test/", TONA_EXECUTOR_TOKEN: "secret" });
  assert.equal(config.ready, true);
  const tools = buildIsolatedExecutorTools({ TONA_EXECUTOR_URL: config.baseUrl, TONA_EXECUTOR_TOKEN: config.token });
  for (const id of ["python_repl", "r_repl", "sql_query", "document_parse", "browser_automation", "mcp_call"]) assert(tools.some((tool) => tool.id === id && tool.status === "ready"));
  const mcp = tools.find((tool) => tool.id === "mcp_call");
  assert(!mcp.inputSchema.properties.url, "MCP prompts must not supply arbitrary server URLs");
  const host = createPluginHost([{ id: "test.executor", name: "Executor", version: "1.0.0", scope: "universal", tools }]);
  let request;
  const result = await executeRegisteredTool(createToolRegistry(host.tools), "python_repl", { code: "print(2 + 2)" }, {
    workspaceId: "ws_executor",
    authorizedWorkspaceId: "ws_executor",
    allowedRisks: ["read", "execute"],
    executorConfig: config,
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ execution_id: "exec_123", status: "completed", stdout: "4\n", stderr: "", result: 4, provenance: { sandbox_id: "sandbox_123", image_digest: "sha256:abc" } }) };
    }
  });
  assert.equal(result.data.result, 4);
  assert.equal(request.url, "https://executor.example.test/v1/execute");
  assert.equal(request.options.headers["X-TONA-Workspace"], "ws_executor");
  assert.deepEqual(result.quality, [{ id: "executor_provenance", ok: true }]);
  console.log("Isolated executor test passed: configuration gate, six adapters, allowlisted MCP target, workspace trace headers, and provenance quality gate.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
