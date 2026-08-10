const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const installRoot = path.join(root, ".openworker");
const commit = "01b6f83b3927e02912dda84bb392942c13ca70d1";
const packageSpec = `coworker @ git+https://github.com/andrewyng/openworker.git@${commit}`;
const shouldInstall = process.env.RENDER === "true" || process.env.OPENWORKER_INSTALL === "true";

function moduleFile() {
  return path.join(installRoot, "coworker", "server", "run.py");
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function findPython() {
  const candidates = process.platform === "win32" ? ["py", "python"] : ["python3", "python"];
  for (const candidate of candidates) {
    const args = candidate === "py" ? ["-3", "--version"] : ["--version"];
    const result = spawnSync(candidate, args, { stdio: "ignore", shell: false });
    if (result.status === 0) return { command: candidate, prefix: candidate === "py" ? ["-3"] : [] };
  }
  throw new Error("Python 3 is required to install OpenWorker.");
}

if (!shouldInstall || process.env.OPENWORKER_ENABLED === "false") {
  console.log("[openworker-install] skipped outside Render; set OPENWORKER_INSTALL=true to install locally.");
  process.exit(0);
}

if (fs.existsSync(moduleFile())) {
  console.log(`[openworker-install] already installed at ${installRoot}`);
  process.exit(0);
}

const python = findPython();
console.log(`[openworker-install] installing Python packages into ${installRoot}`);
run(python.command, [...python.prefix, "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "--upgrade", "--target", installRoot, packageSpec]);

if (!fs.existsSync(moduleFile())) throw new Error("OpenWorker installed without the coworker.server.run module.");
console.log(`[openworker-install] ready: ${moduleFile()}`);
