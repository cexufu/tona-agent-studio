const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  TOOL_CATALOG,
  normalizeRuntimeSettings,
  publicRuntimeSettings,
  needsWebResearch,
  assertSafePublicUrl,
  executeTool,
  evidenceContext,
  sourceAppendix
} = require("../runtime/tool-runtime");
const {
  runtimeUsageSummary,
  prepareRuntimeResearch
} = require("../runtime/server-support");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tona-runtime-tools-"));
  const usagePath = path.join(tempDir, "tool-usage.jsonl");
  try {
    assert(TOOL_CATALOG.some((tool) => tool.id === "web_search" && tool.status === "ready"));
    assert(TOOL_CATALOG.some((tool) => tool.id === "web_read" && tool.status === "ready"));
    assert(needsWebResearch("请联网搜索今天的科研新闻"));
    assert(needsWebResearch("读取 https://example.com/report"));
    assert(!needsWebResearch("帮我整理一下这段会议记录"));

    const normalized = normalizeRuntimeSettings({ search: { maxResults: 99, dailyLimit: 0 } });
    assert.equal(normalized.search.maxResults, 8);
    assert.equal(normalized.search.dailyLimit, 30);
    const publicSettings = publicRuntimeSettings(normalized, (value) => value.slice(0, 2) + "***", { TAVILY_API_KEY: "platform-key" });
    assert.equal(publicSettings.search.ready, true);
    assert.equal(publicSettings.search.credentialSource, "platform");
    assert.equal(publicSettings.search.apiKey, "");

    await assert.rejects(
      () => assertSafePublicUrl("http://localhost/private"),
      /blocked/
    );
    await assert.rejects(
      () => assertSafePublicUrl("https://internal.example", async () => [{ address: "10.1.2.3", family: 4 }]),
      /private network/
    );

    const fetchSearch = async (url, options) => {
      assert.equal(String(url), "https://api.tavily.com/search");
      assert.equal(options.headers.Authorization, "Bearer workspace-key");
      return jsonResponse({
        results: [
          { title: "Runtime source", url: "https://example.com/runtime", content: "Current runtime evidence.", score: 0.9 }
        ]
      });
    };
    const search = await executeTool(
      "web_search",
      { query: "latest runtime" },
      { settings: { search: { provider: "tavily", apiKey: "workspace-key" } }, fetch: fetchSearch }
    );
    assert.equal(search.sources.length, 1);
    assert.match(evidenceContext(search), /\[1\] Runtime source/);
    assert.match(sourceAppendix(search), /https:\/\/example.com\/runtime/);

    const prepared = await prepareRuntimeResearch({
      settings: { search: { provider: "tavily", apiKey: "workspace-key", dailyLimit: 2 } },
      text: "请联网搜索最新 runtime",
      usagePath,
      workspaceId: "usr_test",
      feature: "test",
      fetch: fetchSearch
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.sources.length, 1);
    const usage = runtimeUsageSummary({ search: { dailyLimit: 2 } }, usagePath);
    assert.equal(usage.todaySearches, 1);
    assert.equal(usage.remainingSearches, 1);

    const read = await executeTool(
      "web_read",
      { url: "https://example.com/page" },
      {
        settings: { webReader: { enabled: true, maxCharacters: 5000 } },
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        fetch: async () => new Response("<html><title>Example</title><body><script>bad()</script><h1>Useful evidence</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      }
    );
    assert.equal(read.title, "Example");
    assert.match(read.content, /Useful evidence/);
    assert(!read.content.includes("bad()"));

    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    assert(html.includes('data-view="runtime"'));
    assert(html.includes('id="runtimeForm"'));
    console.log("Runtime tools test passed: registry, workspace/platform credentials, Tavily adapter, safe web reader, evidence citations, audit usage, and Studio UI.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
