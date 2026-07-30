const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  normalizeRuntimeSettings,
  runtimeCredential,
  needsWebResearch,
  extractUrls,
  executeTool,
  evidenceContext,
  sourceAppendix
} = require("./tool-runtime");

function readToolEvents(usagePath) {
  if (!usagePath || !fs.existsSync(usagePath)) return [];
  return fs.readFileSync(usagePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function writeToolEvent(usagePath, event) {
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.appendFileSync(usagePath, JSON.stringify(event) + "\n");
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function queryHash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

function runtimeUsageSummary(settings, usagePath, env = process.env) {
  const normalized = normalizeRuntimeSettings(settings);
  const events = readToolEvents(usagePath);
  const today = todayKey();
  const todayEvents = events.filter((event) => String(event.at || "").startsWith(today));
  const searchEvents = todayEvents.filter((event) => event.tool === "web_search" && event.status === "success");
  const credential = runtimeCredential(normalized, env);
  return {
    todayCalls: todayEvents.length,
    todaySearches: searchEvents.length,
    dailyLimit: normalized.search.dailyLimit,
    remainingSearches: Math.max(0, normalized.search.dailyLimit - searchEvents.length),
    lastRun: events.at(-1) || null,
    credentialSource: credential.source
  };
}

async function prepareRuntimeResearch({ settings, text, usagePath, workspaceId, feature, env = process.env, fetch, lookup }) {
  const normalized = normalizeRuntimeSettings(settings);
  if (!needsWebResearch(text)) return null;
  const started = Date.now();
  const urls = extractUrls(text);
  let result;
  let tool = urls.length ? "web_read" : "web_search";
  try {
    if (tool === "web_search") {
      const usage = runtimeUsageSummary(normalized, usagePath, env);
      if (usage.todaySearches >= normalized.search.dailyLimit) throw new Error(`Today's web search limit (${normalized.search.dailyLimit}) has been reached.`);
      result = await executeTool("web_search", { query: String(text).slice(0, 1000) }, { settings: normalized, env, fetch, lookup });
    } else {
      const pages = [];
      for (const url of urls.slice(0, 2)) {
        const page = await executeTool("web_read", { url }, { settings: normalized, env, fetch, lookup });
        pages.push({
          title: page.title,
          url: page.url,
          excerpt: page.content,
          publishedAt: "",
          retrievedAt: page.retrievedAt
        });
      }
      result = { query: String(text).slice(0, 1000), provider: "tona_web_reader", credentialSource: "none", sources: pages };
    }
    const event = {
      at: new Date().toISOString(),
      workspaceId,
      feature,
      tool,
      provider: result.provider,
      status: "success",
      durationMs: Date.now() - started,
      sourceCount: result.sources.length,
      queryHash: queryHash(text)
    };
    writeToolEvent(usagePath, event);
    return {
      requested: true,
      ok: true,
      tool,
      provider: result.provider,
      evidence: evidenceContext(result),
      appendix: sourceAppendix(result),
      sources: result.sources
    };
  } catch (error) {
    writeToolEvent(usagePath, {
      at: new Date().toISOString(),
      workspaceId,
      feature,
      tool,
      status: "error",
      durationMs: Date.now() - started,
      error: String(error.message || error).slice(0, 300),
      queryHash: queryHash(text)
    });
    return { requested: true, ok: false, tool, error: error.message, sources: [] };
  }
}

module.exports = {
  readToolEvents,
  runtimeUsageSummary,
  prepareRuntimeResearch
};
