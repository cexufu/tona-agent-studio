const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { recordProductEvent, productMetrics } = require("../runtime/product-metrics");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tona-metrics-"));
const file = path.join(directory, "events.jsonl");
assert.strictEqual(recordProductEvent(file, "unknown_event", {}), false);
recordProductEvent(file, "provider_configured", { provider_type: "openai", nested: { secret: true } });
recordProductEvent(file, "agent_saved", { enabled: true });
recordProductEvent(file, "skill_saved", { status: "published" });
recordProductEvent(file, "connector_saved", { connector_type: "feishu" });
recordProductEvent(file, "run_completed", { status: "completed" });
const metrics = productMetrics(file);
assert.strictEqual(metrics.activation.score, 5);
assert.strictEqual(metrics.totals.run_completed, 1);
assert.strictEqual(metrics.recent[0].properties.status, "completed");
assert.strictEqual(metrics.recent.some(item => Object.hasOwn(item.properties, "nested")), false);
fs.rmSync(directory, { recursive: true, force: true });

console.log("product metrics tests passed");
