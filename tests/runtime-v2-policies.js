const assert = require("assert");
const { createToolRegistry, executeRegisteredTool } = require("../runtime/runtime-v2");

(async () => {
  let attempts = 0;
  const registry = createToolRegistry([
    {
      id: "retry_probe", risk: "read", status: "ready",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      policy: { timeoutMs: 100, retries: 1, rateLimit: { maxCalls: 10, windowMs: 60000 } },
      handler() { attempts += 1; if (attempts === 1) throw new Error("HTTP 503 temporary failure"); return { ok: true }; }
    },
    {
      id: "slow_probe", risk: "read", status: "ready",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
      policy: { timeoutMs: 10, retries: 0, rateLimit: { maxCalls: 10, windowMs: 60000 } },
      handler: () => new Promise((resolve) => setTimeout(() => resolve({}), 50))
    },
    {
      id: "rate_probe", risk: "read", status: "ready",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
      policy: { timeoutMs: 100, retries: 0, rateLimit: { maxCalls: 1, windowMs: 60000 } }, handler: () => ({})
    },
    {
      id: "execute_probe", risk: "execute", status: "ready",
      inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: () => ({})
    },
    {
      id: "artifact_probe", risk: "read", status: "ready",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", required: ["artifacts"], properties: { artifacts: { type: "array", items: { type: "object" } } } },
      handler: () => ({ artifacts: [{ artifact_id: "art_12345678" }] })
    }
  ]);
  const context = { workspaceId: "ws_policy", authorizedWorkspaceId: "ws_policy" };
  const retried = await executeRegisteredTool(registry, "retry_probe", {}, context);
  assert.equal(retried.meta.attempts, 2);
  await assert.rejects(() => executeRegisteredTool(registry, "slow_probe", {}, context), (error) => error.code === "TOOL_TIMEOUT" && error.category === "timeout");
  await executeRegisteredTool(registry, "rate_probe", {}, { ...context, idempotencyKey: "rate-one" });
  const cachedRate = await executeRegisteredTool(registry, "rate_probe", {}, { ...context, idempotencyKey: "rate-one" });
  assert.equal(cachedRate.meta.cached, true);
  await assert.rejects(() => executeRegisteredTool(registry, "rate_probe", {}, { ...context, idempotencyKey: "rate-two" }), (error) => error.code === "TOOL_RATE_LIMITED" && error.statusCode === 429);
  await assert.rejects(() => executeRegisteredTool(registry, "execute_probe", {}, context), (error) => error.code === "TOOL_RISK_NOT_APPROVED");
  const executed = await executeRegisteredTool(registry, "execute_probe", {}, { ...context, allowedRisks: ["read", "execute"] });
  assert.equal(executed.risk, "execute");
  const artifact = await executeRegisteredTool(registry, "artifact_probe", {}, context);
  assert.deepEqual(artifact.artifactIds, ["art_12345678"]);
  console.log("Runtime v2 policy test passed: retry, timeout, rate limit, risk approval, and artifact_id envelope.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
