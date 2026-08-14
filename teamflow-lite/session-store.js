const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function digest(token) { return crypto.createHash("sha256").update(String(token || "")).digest("hex"); }

class SessionStore {
  constructor(file) { this.file = file; this.values = new Map(); this.load(); }
  load() {
    try {
      const payload = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [key, value] of Object.entries(payload.sessions || {})) if (value.expiresAt > Date.now()) this.values.set(key, value);
    } catch {}
    this.persist();
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions: Object.fromEntries(this.values) }));
    fs.renameSync(temporary, this.file);
  }
  set(token, value) { this.values.set(digest(token), value); this.persist(); return this; }
  get(token) { const key = digest(token); const value = this.values.get(key); if (value && value.expiresAt > Date.now()) return value; if (value) { this.values.delete(key); this.persist(); } return undefined; }
  delete(token) { const removed = this.values.delete(digest(token)); if (removed) this.persist(); return removed; }
  entries() { return this.values.entries(); }
  deleteDigest(key) { const removed = this.values.delete(key); if (removed) this.persist(); return removed; }
  update() { this.persist(); }
}

module.exports = { SessionStore };
