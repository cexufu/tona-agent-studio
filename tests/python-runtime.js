const assert = require("assert");
const { pythonToolDefinition, executePythonSandbox } = require("../runtime/python-runtime");

(async () => {
  assert.equal(pythonToolDefinition.policy.network, "deny");
  assert.equal(pythonToolDefinition.policy.sideEffectScope, "workspace");
  let request;
  const result = await executePythonSandbox({ code: "print(2 + 2)", inputArtifactIds: [] }, {
    runnerUrl: "https://runner.invalid",
    runnerToken: "secret",
    limits: { timeoutMs: 5000, maxMemoryMb: 512 },
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ status: "ok", exitCode: 0, stdout: "4\n", stderr: "", artifacts: [], metrics: { durationMs: 10 }, truncated: false }) };
    }
  });
  assert.equal(result.stdout, "4\n");
  assert.equal(request.url, "https://runner.invalid/v1/execute");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.equal(JSON.parse(request.options.body).limits.maxMemoryMb, 512);
  await assert.rejects(executePythonSandbox({ code: "print(1)" }, { runnerUrl: "https://runner.invalid", fetch: async () => ({ ok: false, json: async () => ({ code: "PYTHON_BLOCKED", error: "blocked" }) }) }), (error) => error.code === "PYTHON_BLOCKED");
  console.log("Python Runtime test passed: isolated runner contract, token routing, limits, structured output, and errors.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
