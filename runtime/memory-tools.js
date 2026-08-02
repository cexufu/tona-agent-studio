const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { RuntimeToolError } = require("./runtime-v2");

const MAX_MEMORIES = 5000;
const MEMORY_ID_PATTERN = /^mem_[A-Za-z0-9_-]{12,80}$/;

function terms(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])];
}

function lexicalScore(query, item) {
  const queryTerms = terms(query);
  if (!queryTerms.length) return 0;
  const content = `${item.title || ""} ${item.content || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
  const itemTerms = new Set(terms(content));
  const overlap = queryTerms.filter((term) => itemTerms.has(term)).length / queryTerms.length;
  const phrase = content.includes(String(query).toLowerCase()) ? 1 : 0;
  return Math.min(1, overlap * 0.75 + phrase * 0.25);
}

function recencyScore(createdAt, now = Date.now()) {
  const ageDays = Math.max(0, now - Date.parse(createdAt || 0)) / 86400000;
  return Math.exp(-ageDays / 90);
}

class HybridMemoryStore {
  constructor(root, workspaceId) {
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(String(workspaceId || ""))) throw new RuntimeToolError("MEMORY_WORKSPACE_REQUIRED", "A valid workspace is required for memory.", { category: "permission", status: 403 });
    this.root = path.resolve(root);
    this.workspaceId = workspaceId;
    this.file = path.join(this.root, "memories.json");
  }

  readAll() {
    if (!fs.existsSync(this.file)) return [];
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch {
      throw new RuntimeToolError("MEMORY_STORE_CORRUPT", "The workspace memory store could not be read.", { category: "storage", status: 500 });
    }
  }

  writeAll(items) {
    fs.mkdirSync(this.root, { recursive: true });
    const temporary = path.join(this.root, `.memories-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(items.slice(-MAX_MEMORIES), null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  remember(input, context = {}) {
    const now = new Date(Number(context.now?.() ?? Date.now())).toISOString();
    const item = {
      memory_id: `mem_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
      title: String(input.title || "").trim().slice(0, 200),
      content: String(input.content || "").trim().slice(0, 8000),
      tags: [...new Set((input.tags || []).map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 20),
      importance: Math.min(1, Math.max(0, Number(input.importance ?? 0.5))),
      source: String(input.source || "agent").slice(0, 80),
      createdAt: now,
      updatedAt: now
    };
    if (!item.content) throw new RuntimeToolError("MEMORY_CONTENT_REQUIRED", "Memory content is required.", { category: "validation" });
    const items = this.readAll();
    items.push(item);
    this.writeAll(items);
    return item;
  }

  async search(input, context = {}) {
    const query = String(input.query || "").trim();
    const limit = Math.min(20, Math.max(1, Number(input.limit) || 5));
    const items = this.readAll();
    const semantic = typeof context.semanticMemorySearch === "function" ? await context.semanticMemorySearch({ query, items, limit }) : [];
    const semanticScores = new Map((semantic || []).map((item) => [item.memory_id, Math.min(1, Math.max(0, Number(item.score) || 0))]));
    const matches = items.map((item) => {
      const lexical = lexicalScore(query, item);
      const vector = semanticScores.get(item.memory_id) || 0;
      const recency = recencyScore(item.createdAt, Number(context.now?.() ?? Date.now()));
      const score = lexical * 0.55 + vector * 0.25 + recency * 0.1 + Number(item.importance || 0) * 0.1;
      return { ...item, score: Number(score.toFixed(6)), scoreBreakdown: { lexical: Number(lexical.toFixed(6)), semantic: vector, recency: Number(recency.toFixed(6)), importance: item.importance } };
    }).filter((item) => item.score > 0.08).sort((a, b) => b.score - a.score).slice(0, limit);
    return { query, matches, totalMemories: items.length, mode: semanticScores.size ? "hybrid_vector_lexical" : "hybrid_lexical_recency" };
  }

  forget(memoryId) {
    if (!MEMORY_ID_PATTERN.test(String(memoryId || ""))) throw new RuntimeToolError("MEMORY_ID_INVALID", "A valid memory_id is required.", { category: "validation" });
    const items = this.readAll();
    const remaining = items.filter((item) => item.memory_id !== memoryId);
    if (remaining.length === items.length) throw new RuntimeToolError("MEMORY_NOT_FOUND", "Memory not found in this workspace.", { category: "not_found", status: 404 });
    this.writeAll(remaining);
    return { memory_id: memoryId, deleted: true };
  }
}

const object = { type: "object", additionalProperties: false };
const memoryTools = [
  {
    id: "memory_remember", name: "跨会话记忆写入", category: "memory", risk: "write", status: "ready", description: "经确认后把稳定事实、偏好或决策写入当前 workspace 的长期记忆。",
    policy: { timeoutMs: 5000, retries: 0, idempotent: true, rateLimit: { maxCalls: 60, windowMs: 60000 } },
    inputSchema: { ...object, required: ["content"], properties: { title: { type: "string", maxLength: 200 }, content: { type: "string", minLength: 1, maxLength: 8000 }, tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 80 } }, importance: { type: "number", minimum: 0, maximum: 1 }, source: { type: "string", maxLength: 80 } } },
    outputSchema: { type: "object", required: ["memory_id", "content", "tags", "importance", "source", "createdAt", "updatedAt"], properties: { memory_id: { type: "string" }, title: { type: "string" }, content: { type: "string" }, tags: { type: "array", items: { type: "string" } }, importance: { type: "number" }, source: { type: "string" }, createdAt: { type: "string" }, updatedAt: { type: "string" } } },
    handler(input, context) { if (!context.memoryStore) throw new RuntimeToolError("MEMORY_STORE_REQUIRED", "Memory storage is not configured.", { category: "configuration", status: 503 }); return context.memoryStore.remember(input, context); }
  },
  {
    id: "memory_search", name: "混合记忆检索", category: "memory", risk: "read", status: "ready", description: "在当前 workspace 中按词法相关性、语义得分、时间和重要性混合检索跨会话记忆。",
    policy: { timeoutMs: 5000, retries: 0, idempotent: false, rateLimit: { maxCalls: 120, windowMs: 60000 } },
    inputSchema: { ...object, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 1000 }, limit: { type: "integer", minimum: 1, maximum: 20 } } },
    outputSchema: { type: "object", required: ["query", "matches", "totalMemories", "mode"], properties: { query: { type: "string" }, matches: { type: "array", items: { type: "object" } }, totalMemories: { type: "integer" }, mode: { type: "string" } } },
    handler(input, context) { if (!context.memoryStore) throw new RuntimeToolError("MEMORY_STORE_REQUIRED", "Memory storage is not configured.", { category: "configuration", status: 503 }); return context.memoryStore.search(input, context); }
  },
  {
    id: "memory_forget", name: "删除跨会话记忆", category: "memory", risk: "write", status: "ready", description: "经确认后删除当前 workspace 中的一条长期记忆。",
    policy: { timeoutMs: 5000, retries: 0, idempotent: true, rateLimit: { maxCalls: 30, windowMs: 60000 } },
    inputSchema: { ...object, required: ["memory_id"], properties: { memory_id: { type: "string", pattern: "^mem_[A-Za-z0-9_-]{12,80}$" } } },
    outputSchema: { ...object, required: ["memory_id", "deleted"], properties: { memory_id: { type: "string" }, deleted: { type: "boolean" } } },
    handler(input, context) { if (!context.memoryStore) throw new RuntimeToolError("MEMORY_STORE_REQUIRED", "Memory storage is not configured.", { category: "configuration", status: 503 }); return context.memoryStore.forget(input.memory_id); }
  }
];

module.exports = { HybridMemoryStore, memoryTools, lexicalScore, recencyScore };
