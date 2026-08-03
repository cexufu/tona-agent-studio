const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PYTHON_TOOL_ID = "code.python.run";
const pythonToolDefinition = {
  id: PYTHON_TOOL_ID,
  version: "0.1.0",
  owner: "tona-runtime",
  lifecycle: "experimental",
  name: "Python 隔离计算",
  category: "compute",
  risk: "execute",
  status: process.env.TONA_PYTHON_RUNNER_URL || process.env.TONA_PYTHON_DOCKER_IMAGE ? "ready" : "setup_required",
  description: {
    summary: "在隔离环境中执行 Python 数据分析代码，并将文件作为工作区产物返回。",
    whenToUse: ["需要数据清洗、统计、绘图、批量转换或可复现计算"],
    whenNotToUse: ["简单计算应使用确定性数学工具", "不得用于访问外网、密钥或宿主文件"]
  },
  policy: {
    operationRisk: "compute", sideEffectScope: "workspace", confirmation: "never", network: "deny",
    timeoutMs: 60000, retries: 0, idempotent: true, concurrency: "parallel_safe", rateLimit: { maxCalls: 6, windowMs: 60000 }
  },
  inputSchema: {
    type: "object", additionalProperties: false, required: ["code"],
    properties: {
      code: { type: "string", minLength: 1, maxLength: 30000 },
      inputArtifactIds: { type: "array", maxItems: 10, items: { type: "string" } }
    }
  },
  outputSchema: {
    type: "object", additionalProperties: false, required: ["status", "exitCode", "stdout", "stderr", "artifacts", "metrics", "truncated"],
    properties: {
      status: { type: "string", enum: ["ok", "error", "timeout", "blocked"] }, exitCode: { type: "integer" },
      stdout: { type: "string" }, stderr: { type: "string" }, artifacts: { type: "array" }, metrics: { type: "object" }, truncated: { type: "boolean" }
    }
  }
};

async function runRemote(input, context) {
  const base = String(context.runnerUrl || process.env.TONA_PYTHON_RUNNER_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const response = await (context.fetch || fetch)(`${base}/v1/execute`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(context.runnerToken || process.env.TONA_PYTHON_RUNNER_TOKEN ? { Authorization: `Bearer ${context.runnerToken || process.env.TONA_PYTHON_RUNNER_TOKEN}` } : {}) },
    body: JSON.stringify({ code: input.code, inputArtifacts: context.inputArtifacts || [], limits: context.limits || {} }),
    signal: AbortSignal.timeout(Math.max(5000, Number(context.limits?.timeoutMs) || 65000))
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || "Python runner failed."), { code: payload.code || "PYTHON_RUNNER_ERROR" });
  return payload;
}

function runDocker(input, context) {
  const image = String(context.dockerImage || process.env.TONA_PYTHON_DOCKER_IMAGE || "");
  if (!image) return Promise.resolve(null);
  const jobRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tona-python-"));
  const inputDir = path.join(jobRoot, "input"); const outputDir = path.join(jobRoot, "output");
  fs.mkdirSync(inputDir); fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(jobRoot, "main.py"), input.code, "utf8");
  for (const artifact of context.inputArtifacts || []) {
    const target = path.join(inputDir, path.basename(artifact.name || artifact.path || "input"));
    if (artifact.path && fs.existsSync(artifact.path)) fs.copyFileSync(artifact.path, target);
    else if (artifact.bytesBase64) fs.writeFileSync(target, Buffer.from(artifact.bytesBase64, "base64"));
  }
  const timeoutMs = Math.max(5000, Math.min(120000, Number(context.limits?.timeoutMs) || 60000));
  const args = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", `${Math.max(128, Number(context.limits?.maxMemoryMb) || 512)}m`, "--cpus", "1", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "-e", "MPLCONFIGDIR=/tmp/matplotlib", "-v", `${path.join(jobRoot, "main.py")}:/job/main.py:ro`, "-v", `${inputDir}:/job/input:ro`, "-v", `${outputDir}:/job/output:rw`, image];
  return new Promise((resolve, reject) => {
    const started = Date.now(); const child = spawn("docker", args, { windowsHide: true }); let stdout = "", stderr = "", timedOut = false;
    const append = (current, chunk) => (current + chunk).slice(-102400);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); }); child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); fs.rmSync(jobRoot, { recursive: true, force: true }); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const artifacts = fs.readdirSync(outputDir).filter((name) => fs.statSync(path.join(outputDir, name)).isFile()).slice(0, 20).map((name) => {
          const filePath = path.join(outputDir, name); const buffer = fs.readFileSync(filePath);
          return { name, mime: "application/octet-stream", bytesBase64: buffer.toString("base64"), sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
        });
        resolve({ status: timedOut ? "timeout" : code === 0 ? "ok" : "error", exitCode: Number(code ?? -1), stdout, stderr, artifacts, metrics: { durationMs: Date.now() - started }, truncated: stdout.length >= 102400 || stderr.length >= 102400 });
      } finally { fs.rmSync(jobRoot, { recursive: true, force: true }); }
    });
  });
}

async function executePythonSandbox(input, context = {}) {
  const result = await runRemote(input, context) || await runDocker(input, context);
  if (!result) throw Object.assign(new Error("Python 隔离执行器尚未配置。请设置 TONA_PYTHON_RUNNER_URL 或 TONA_PYTHON_DOCKER_IMAGE。"), { code: "PYTHON_RUNNER_NOT_CONFIGURED" });
  return result;
}

module.exports = { PYTHON_TOOL_ID, pythonToolDefinition, executePythonSandbox };
