const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const gateway = fs.readFileSync(path.join(root, "gateway.js"), "utf8");
const installer = fs.readFileSync(path.join(root, "scripts", "install-openworker.js"), "utf8");

assert.equal(packageJson.scripts.postinstall, "node scripts/install-openworker.js");
assert(gateway.includes("path.join(ROOT, '.openworker', 'coworker', 'server', 'run.py')"));
assert(gateway.includes("['-m', 'coworker.server.run']"));
assert(gateway.includes("PYTHONPATH"));
assert(gateway.includes("'/opt/openworker/bin/openworker-server'"));
assert(installer.includes('process.env.RENDER === "true"'));
assert(installer.includes('"--target", installRoot'));
assert(!installer.includes('"-m", "venv"'));
assert(installer.includes("01b6f83b3927e02912dda84bb392942c13ca70d1"));

const env = { ...process.env };
delete env.RENDER;
delete env.OPENWORKER_INSTALL;
const skipped = spawnSync(process.execPath, ["scripts/install-openworker.js"], { cwd: root, env, encoding: "utf8" });
assert.equal(skipped.status, 0);
assert(skipped.stdout.includes("skipped outside Render"));

console.log("OpenWorker Render install test passed: safe local skip, pinned package, native-runtime pip target, and Docker executable fallback.");
