const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SENSITIVE_KEY = /(?:password|secret|token|api[_-]?key|authorization|cookie|encrypt[_-]?key)/i;
const SENSITIVE_TEXT = /\b(?:sk|sess|token|key)-[A-Za-z0-9_-]{12,}\b/g;

function registrationMode(env = process.env) {
  return String(env.TONA_REGISTRATION_MODE || (env.NODE_ENV === "production" ? "invite" : "open")).toLowerCase();
}

function validateProductionEnvironment(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const issues = [];
  if (String(env.TEAMFLOW_INITIAL_ADMIN_PASSWORD || "").length < 12) issues.push("TEAMFLOW_INITIAL_ADMIN_PASSWORD must be at least 12 characters.");
  if (String(env.TONA_SECRETS_KEY || "").length < 24) issues.push("TONA_SECRETS_KEY must be at least 24 characters so credentials are encrypted at rest.");
  const mode = registrationMode(env);
  if (!["closed", "invite", "open"].includes(mode)) issues.push("TONA_REGISTRATION_MODE must be closed, invite, or open.");
  if (mode === "invite" && String(env.TONA_REGISTRATION_INVITE_CODE || "").length < 12) issues.push("TONA_REGISTRATION_INVITE_CODE must be at least 12 characters in invite mode.");
  return issues;
}

function assertProductionEnvironment(env = process.env) {
  const issues = validateProductionEnvironment(env);
  if (issues.length) throw new Error("Production configuration is unsafe:\n- " + issues.join("\n- "));
}

function securityHeaders(env = process.env) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self' https://open.feishu.cn https://open.larksuite.com",
    ...(env.NODE_ENV === "production" ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {})
  };
}

function clientAddress(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

function createRateLimiter({ windowMs = 15 * 60_000, max = 10 } = {}) {
  const attempts = new Map();
  return {
    consume(key) {
      const now = Date.now();
      const current = attempts.get(key);
      if (!current || current.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: max - 1, retryAfter: 0 };
      }
      current.count += 1;
      const allowed = current.count <= max;
      return { allowed, remaining: Math.max(0, max - current.count), retryAfter: allowed ? 0 : Math.ceil((current.resetAt - now) / 1000) };
    },
    clear(key) { attempts.delete(key); }
  };
}

function redactSensitive(value, depth = 0) {
  if (depth > 12) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactSensitive(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(item, depth + 1)]));
  }
  return typeof value === "string" ? value.replace(SENSITIVE_TEXT, "[REDACTED]").slice(0, 20_000) : value;
}

function pruneLogDirectory(directory, { retentionDays = 14, maxFiles = 1000 } = {}) {
  if (!fs.existsSync(directory)) return { removed: 0, kept: 0 };
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86_400_000;
  const entries = fs.readdirSync(directory).map(name => {
    const file = path.join(directory, name);
    try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  const expired = entries.filter((entry, index) => entry.mtime < cutoff || index >= maxFiles);
  for (const entry of expired) { try { fs.unlinkSync(entry.file); } catch {} }
  return { removed: expired.length, kept: entries.length - expired.length };
}

function probeWritableDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `.health-${process.pid}-${crypto.randomUUID()}`);
    fs.writeFileSync(file, "ok");
    fs.unlinkSync(file);
    return true;
  } catch { return false; }
}

module.exports = {
  assertProductionEnvironment,
  validateProductionEnvironment,
  registrationMode,
  securityHeaders,
  clientAddress,
  createRateLimiter,
  redactSensitive,
  pruneLogDirectory,
  probeWritableDirectory
};
