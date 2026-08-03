const assert = require("assert");
const { normalizeToolContract, plannerToolDescription } = require("../runtime/tool-contract");
const { compileToolPolicy, assertPolicyDecision } = require("../runtime/policy-kernel");

const readTool = normalizeToolContract({
  id: "web.search", status: "ready", lifecycle: "stable", executable: true, risk: "read",
  description: { summary: "搜索网页", whenToUse: ["需要最新信息"], whenNotToUse: ["已有可靠材料"] },
  policy: { network: "allow", requiredScopes: ["web:read"] }
});
assert.match(plannerToolDescription(readTool), /Use when/);
const allowed = compileToolPolicy({ tool: readTool, platform: { network: "allow" }, workspace: { network: "allow", grantedScopes: ["web:read"] }, agent: { allowedToolIds: ["web.search"], network: "allow" }, task: { network: "allow" } });
assert.equal(allowed.decision, "allow");
assert.equal(allowed.effectiveLimits.network, "allow");

const denied = compileToolPolicy({ tool: readTool, platform: { network: "allow" }, workspace: { network: "allow", grantedScopes: ["web:read"] }, agent: { allowedToolIds: ["file.read"], network: "allow" }, task: { network: "allow" } });
assert.equal(denied.decision, "deny");
assert.equal(denied.reasonCode, "AGENT_TOOL_NOT_GRANTED");
assert.throws(() => assertPolicyDecision(denied), /未获授权/);

const writeTool = normalizeToolContract({ id: "feishu.docs.create", status: "ready", risk: "write", policy: { operationRisk: "write", sideEffectScope: "external", requiredScopes: ["docs:create"] } });
const confirmation = compileToolPolicy({ tool: writeTool, platform: { externalWrites: "confirm" }, workspace: { externalWrites: "allow", grantedScopes: ["docs:create"] }, agent: { allowedToolIds: ["feishu.docs.create"], externalWrites: "allow" }, task: { externalWrites: "allow" } });
assert.equal(confirmation.decision, "confirm");
assert.doesNotThrow(() => assertPolicyDecision(confirmation, { confirmed: true }));

const missingScope = compileToolPolicy({ tool: writeTool, platform: { externalWrites: "allow" }, workspace: { externalWrites: "allow" }, agent: { allowedToolIds: ["feishu.docs.create"], externalWrites: "allow" }, task: { externalWrites: "allow" } });
assert.equal(missingScope.reasonCode, "TOOL_SCOPE_MISSING");
console.log("Policy Kernel test passed: contracts, layered allowlists, scopes, network limits, confirmation, and denial reasons.");
