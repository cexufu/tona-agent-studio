const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  validateProductionEnvironment,
  registrationMode,
  redactSensitive,
  pruneLogDirectory,
  probeWritableDirectory
} = require("../runtime/production-guardrails");

assert.strictEqual(registrationMode({ NODE_ENV: "production" }), "invite");
assert.strictEqual(registrationMode({ NODE_ENV: "development" }), "open");
assert(validateProductionEnvironment({ NODE_ENV: "production" }).length >= 2);
assert.deepStrictEqual(validateProductionEnvironment({
  NODE_ENV: "production",
  TEAMFLOW_INITIAL_ADMIN_PASSWORD: "a-long-admin-password",
  TONA_SECRETS_KEY: "a-secret-key-that-is-long-enough",
  TONA_REGISTRATION_MODE: "invite",
  TONA_REGISTRATION_INVITE_CODE: "a-long-invite-code"
}), []);

const redacted = redactSensitive({ password: "hidden", nested: { apiKey: "sk-abcdefghijklmnop", keep: "yes" } });
assert.strictEqual(redacted.password, "[REDACTED]");
assert.strictEqual(redacted.nested.apiKey, "[REDACTED]");
assert.strictEqual(redacted.nested.keep, "yes");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tona-guardrails-"));
assert.strictEqual(probeWritableDirectory(directory), true);
for (let index = 0; index < 4; index += 1) fs.writeFileSync(path.join(directory, `${index}.json`), "{}");
pruneLogDirectory(directory, { retentionDays: 30, maxFiles: 2 });
assert(fs.readdirSync(directory).length <= 2);
fs.rmSync(directory, { recursive: true, force: true });

console.log("production guardrails tests passed");
