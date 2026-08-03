const { RuntimeToolError } = require("./runtime-v2");

function executorConfig(env = process.env) {
  const baseUrl = String(env.TONA_EXECUTOR_URL || "").trim().replace(/\/+$/, "");
  const token = String(env.TONA_EXECUTOR_TOKEN || "").trim();
  let ready = false;
  try {
    const parsed = new URL(baseUrl);
    ready = parsed.protocol === "https:" && Boolean(token);
  } catch {}
  return { baseUrl, token, ready };
}

async function callExecutor(route, payload, context = {}) {
  const config = context.executorConfig || executorConfig(context.env || process.env);
  if (!config.ready) throw new RuntimeToolError("EXECUTOR_NOT_CONFIGURED", "The isolated executor is not configured for this deployment.", { category: "configuration", status: 503 });
  const fetchImpl = context.fetch || fetch;
  const response = await fetchImpl(`${config.baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
      "X-TONA-Workspace": context.workspaceId,
      "X-TONA-Trace": String(context.traceId || "")
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(context.executorTimeoutMs) || 65000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new RuntimeToolError("EXECUTOR_REQUEST_FAILED", String(result.message || `Executor failed with HTTP ${response.status}.`), { category: response.status === 429 ? "rate_limit" : "provider", retryable: response.status >= 500 || response.status === 429, status: response.status >= 400 ? response.status : 502 });
  return result;
}

const object = { type: "object", additionalProperties: false };
const executionOutput = {
  type: "object",
  required: ["execution_id", "status", "stdout", "stderr", "result", "provenance"],
  properties: {
    execution_id: { type: "string" },
    status: { enum: ["completed", "failed"] },
    stdout: { type: "string" },
    stderr: { type: "string" },
    result: {},
    provenance: { type: "object" }
  }
};

function buildIsolatedExecutorTools(env = process.env) {
  const status = executorConfig(env).ready ? "ready" : "configuration_required";
  const executePolicy = { operationRisk: "compute", sideEffectScope: "none", confirmation: "never", network: "allow", timeoutMs: 70000, retries: 0, idempotent: false, rateLimit: { maxCalls: 10, windowMs: 60000 } };
  const codeTool = (id, name, language) => ({
    id, name, category: "compute", risk: "execute", status,
    description: `Run ${name} in a disposable, resource-limited external sandbox.`, policy: executePolicy,
    inputSchema: { ...object, required: ["code"], properties: { code: { type: "string", minLength: 1, maxLength: 50000 }, files: { type: "array", maxItems: 20, items: { type: "string" } }, timeout_seconds: { type: "integer", minimum: 1, maximum: 60 } } },
    outputSchema: executionOutput,
    qualityGates: [({ data }) => ({ id: "executor_provenance", ok: Boolean(data.provenance?.sandbox_id && data.provenance?.image_digest), message: "Executor result lacks sandbox provenance." })],
    handler: (input, context) => callExecutor("/v1/execute", { language, ...input }, context)
  });
  return [
    codeTool("python_repl", "Python REPL", "python"),
    codeTool("r_repl", "R REPL", "r"),
    {
      id: "sql_query", name: "SQL Query", category: "data", risk: "execute", status,
      description: "Run read-only SQL against an explicitly configured workspace data source in the isolated executor.", policy: executePolicy,
      inputSchema: { ...object, required: ["connection_id", "query"], properties: { connection_id: { type: "string", minLength: 1, maxLength: 120 }, query: { type: "string", minLength: 1, maxLength: 50000 }, parameters: { type: "object" }, row_limit: { type: "integer", minimum: 1, maximum: 10000 } } },
      outputSchema: executionOutput,
      qualityGates: [({ data }) => ({ id: "executor_provenance", ok: Boolean(data.provenance?.sandbox_id), message: "SQL result lacks executor provenance." })],
      handler: (input, context) => callExecutor("/v1/sql", input, context)
    },
    {
      id: "document_parse", name: "Unstructured Document Parse", category: "files", risk: "read", status,
      description: "Parse a workspace PDF, Word, or PowerPoint file with layout and provenance through an isolated Unstructured-compatible service.",
      policy: { ...executePolicy, idempotent: true, rateLimit: { maxCalls: 30, windowMs: 60000 } },
      inputSchema: { ...object, required: ["file_id"], properties: { file_id: { type: "string", pattern: "^file_[A-Za-z0-9_-]{12,80}$" }, strategy: { enum: ["auto", "fast", "hi_res", "ocr_only"] }, languages: { type: "array", maxItems: 10, items: { type: "string" } } } },
      outputSchema: { type: "object", required: ["document_id", "elements", "provenance"], properties: { document_id: { type: "string" }, elements: { type: "array", items: { type: "object" } }, provenance: { type: "object" } } },
      qualityGates: [({ data }) => ({ id: "document_provenance", ok: Boolean(data.provenance?.parser_version && data.provenance?.source_checksum), message: "Parsed document lacks parser version or source checksum." })],
      handler: (input, context) => callExecutor("/v1/documents/parse", input, context)
    },
    {
      id: "browser_automation", name: "Browser Automation", category: "browser", risk: "execute", status,
      description: "Run a bounded browser workflow in a remote disposable browser with an allowlisted network policy.", policy: { ...executePolicy, operationRisk: "write", sideEffectScope: "external", confirmation: "before_execute" },
      inputSchema: { ...object, required: ["start_url", "steps"], properties: { start_url: { type: "string", minLength: 8, maxLength: 2048 }, steps: { type: "array", minItems: 1, maxItems: 30, items: { type: "object" } }, credential_id: { type: "string", maxLength: 120 } } },
      outputSchema: executionOutput,
      qualityGates: [({ data }) => ({ id: "browser_trace", ok: Boolean(data.provenance?.session_id), message: "Browser result lacks session trace provenance." })],
      handler: (input, context) => callExecutor("/v1/browser", input, context)
    },
    {
      id: "mcp_call", name: "Model Context Protocol", category: "integration", risk: "execute", status,
      description: "Call one allowlisted MCP server and tool by configured server ID; arbitrary MCP URLs are never accepted from prompts.", policy: { ...executePolicy, operationRisk: "write", sideEffectScope: "external", confirmation: "before_execute" },
      inputSchema: { ...object, required: ["server_id", "tool_name", "arguments"], properties: { server_id: { type: "string", minLength: 1, maxLength: 120 }, tool_name: { type: "string", minLength: 1, maxLength: 200 }, arguments: { type: "object" } } },
      outputSchema: { type: "object", required: ["server_id", "tool_name", "content", "provenance"], properties: { server_id: { type: "string" }, tool_name: { type: "string" }, content: { type: "array" }, provenance: { type: "object" } } },
      qualityGates: [({ input, data }) => ({ id: "mcp_target_match", ok: input.server_id === data.server_id && input.tool_name === data.tool_name, message: "MCP response target does not match the requested allowlisted tool." })],
      handler: (input, context) => callExecutor("/v1/mcp/call", input, context)
    }
  ];
}

module.exports = { executorConfig, callExecutor, buildIsolatedExecutorTools };
