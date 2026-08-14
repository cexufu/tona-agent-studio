const fs = require("fs");
const path = require("path");

const ALLOWED_EVENTS = new Set(["workspace_created", "provider_configured", "agent_saved", "skill_saved", "connector_saved", "run_started", "run_completed", "run_failed", "file_uploaded"]);

function recordProductEvent(file, event, properties = {}) {
  if (!ALLOWED_EVENTS.has(event)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const safeProperties = Object.fromEntries(Object.entries(properties).filter(([key, value]) => /^[a-z][a-z0-9_]{0,40}$/i.test(key) && ["string", "number", "boolean"].includes(typeof value)).slice(0, 20));
  fs.appendFileSync(file, JSON.stringify({ event, at: new Date().toISOString(), properties: safeProperties }) + "\n");
  return true;
}

function productMetrics(file, limit = 5000) {
  if (!fs.existsSync(file)) return { totals: {}, activation: { configuredProvider: false, createdAgent: false, createdSkill: false, connectedChannel: false, completedRun: false, score: 0 } };
  const events = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-limit).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const totals = {};
  for (const item of events) totals[item.event] = (totals[item.event] || 0) + 1;
  const activation = { configuredProvider: Boolean(totals.provider_configured), createdAgent: Boolean(totals.agent_saved), createdSkill: Boolean(totals.skill_saved), connectedChannel: Boolean(totals.connector_saved), completedRun: Boolean(totals.run_completed) };
  activation.score = Object.values(activation).filter(Boolean).length;
  return { totals, activation, recent: events.slice(-20).reverse() };
}

module.exports = { recordProductEvent, productMetrics, ALLOWED_EVENTS };
