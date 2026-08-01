const crypto = require("crypto");
const { executeTool } = require("./tool-runtime");

const UNIT_ALIASES = {
  "米": "m", "公里": "km", "千米": "km", "厘米": "cm", "毫米": "mm", "英里": "mi", "英尺": "ft", "英寸": "in",
  "千克": "kg", "公斤": "kg", "克": "g", "磅": "lb", "升": "l", "毫升": "ml",
  "摄氏度": "c", "华氏度": "f", "开尔文": "k", "字节": "b"
};

function deterministicToolRequest(text) {
  const value = String(text || "").trim();
  const fileId = value.match(/\bfile_[A-Za-z0-9_-]{12,80}\b/)?.[0];
  if (fileId && /(读取|总结|分析|查看|read|summari[sz]e|analy[sz]e)/i.test(value)) return { toolId: "file_read", input: { file_id: fileId } };
  const timeZone = value.match(/\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?\b/)?.[0];
  if (/(现在几点|当前时间|今天几号|当前日期|what time|current date|current time)/i.test(value)) return { toolId: "datetime_now", input: { timeZone: timeZone || "UTC" } };
  const expression = value.match(/^(?:请)?(?:帮我)?(?:计算|算一下|calculate)\s*[:：]?\s*([0-9eEpiPI+\-*/%^().,\sA-Za-z_]+)[。？?]?$/i)?.[1]?.trim();
  if (expression) return { toolId: "math_calculate", input: { expression } };
  const chineseConversion = value.match(/(?:^|[\s，。；：:])(?:把|将)\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z0-9_]+|[\u4e00-\u9fa5]{1,8})\s*(?:换算|转换)\s*(?:成|为)\s*([A-Za-z0-9_]+|[\u4e00-\u9fa5]{1,8})(?=$|[\s，。；！？!?])/i);
  const englishConversion = value.match(/(?:^|\s)convert\s+(-?\d+(?:\.\d+)?)\s*([A-Za-z0-9_]+)\s+to\s+([A-Za-z0-9_]+)(?=$|\s|[,.!?])/i);
  const conversion = chineseConversion || englishConversion;
  if (conversion) return { toolId: "unit_convert", input: { value: Number(conversion[1]), from: UNIT_ALIASES[conversion[2]] || conversion[2], to: UNIT_ALIASES[conversion[3]] || conversion[3] } };
  return null;
}

async function prepareAgentToolResult({ text, workspaceId, fileStore, audit, timeZone = "UTC" }) {
  const request = deterministicToolRequest(text);
  if (!request) return null;
  if (request.toolId === "datetime_now" && request.input.timeZone === "UTC" && timeZone) request.input.timeZone = timeZone;
  const resolvedFileStore = request.toolId === "file_read" ? (typeof fileStore === "function" ? fileStore() : fileStore) : undefined;
  const execution = await executeTool(request.toolId, request.input, {
    workspaceId, authorizedWorkspaceId: workspaceId, fileStore: resolvedFileStore, audit,
    idempotencyKey: `agent:${crypto.createHash("sha256").update(request.toolId + JSON.stringify(request.input)).digest("hex").slice(0, 24)}`
  });
  return {
    toolId: request.toolId,
    execution,
    evidence: [
      "TONA Runtime verified tool result. This is structured tool data, not model-authored text.",
      `Tool: ${execution.toolId}`,
      `Invocation: ${execution.invocationId}`,
      `Result JSON: ${JSON.stringify(execution.data)}`,
      "Use this result directly. Do not claim any tool, file, time zone, or calculation beyond this result."
    ].join("\n")
  };
}

module.exports = { deterministicToolRequest, prepareAgentToolResult };
