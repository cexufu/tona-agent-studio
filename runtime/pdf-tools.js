const { PDFParse } = require("pdf-parse");
const { CanvasFactory } = require("pdf-parse/worker");
const { RuntimeToolError } = require("./runtime-v2");

async function parseWorkspacePdf(input, context = {}) {
  if (!context.fileStore) throw new RuntimeToolError("FILE_STORE_UNAVAILABLE", "Workspace file store is unavailable.", { category: "internal", status: 500 });
  const { record, selected, buffer } = context.fileStore.readBuffer(input.file_id, input.version);
  if (selected.mime !== "application/pdf") throw new RuntimeToolError("PDF_FILE_REQUIRED", "The selected workspace file is not a PDF.", { category: "validation", status: 415 });
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new RuntimeToolError("PDF_SIGNATURE_INVALID", "The file does not contain a valid PDF signature.", { category: "validation", status: 415 });
  const parser = new PDFParse({ data: buffer, CanvasFactory });
  try {
    const parseOptions = {};
    if (Array.isArray(input.pages) && input.pages.length) parseOptions.partial = [...new Set(input.pages)].sort((a, b) => a - b);
    const result = await parser.getText(parseOptions);
    const rawText = String(result.text || "").replace(/\u0000/g, "").trim();
    if (!rawText) throw new RuntimeToolError("PDF_OCR_REQUIRED", "No embedded text was found. This PDF is probably scanned and requires the configured OCR/Unstructured document parser.", { category: "unsupported", status: 422, details: { suggestedTool: "document_parse" } });
    const maxCharacters = Math.min(200000, Math.max(1000, Number(input.maxCharacters) || 100000));
    return { file: record, version: selected.version, pageCount: Number(result.total || result.pages?.length || 0), selectedPages: parseOptions.partial || [], content: rawText.slice(0, maxCharacters), truncated: rawText.length > maxCharacters, parser: { name: "pdf-parse", mode: "embedded_text" } };
  } catch (error) {
    if (error instanceof RuntimeToolError) throw error;
    const message = String(error?.message || error);
    if (/password/i.test(message)) throw new RuntimeToolError("PDF_PASSWORD_REQUIRED", "Password-protected PDFs are not supported by this tool.", { category: "validation", status: 422 });
    throw new RuntimeToolError("PDF_PARSE_FAILED", `PDF parsing failed: ${message.slice(0, 300)}`, { category: "execution", status: 422 });
  } finally {
    await parser.destroy().catch(() => {});
  }
}

const pdfTools = [{
  id: "pdf_parse", name: "PDF \u89e3\u6790", category: "files", risk: "read", status: "ready",
  description: "\u89e3\u6790 workspace \u5185 PDF \u7684\u5d4c\u5165\u6587\u672c\uff0c\u5e76\u8fd4\u56de\u9875\u6570\u3001\u5185\u5bb9\u548c\u6765\u6e90\uff1b\u626b\u63cf\u4ef6\u4f1a\u660e\u786e\u8f6c\u4ea4 OCR/Unstructured\u3002",
  policy: { timeoutMs: 60000, retries: 0, idempotent: true, rateLimit: { maxCalls: 20, windowMs: 60000 } },
  inputSchema: { type: "object", additionalProperties: false, required: ["file_id"], properties: { file_id: { type: "string", pattern: "^file_[A-Za-z0-9_-]{12,80}$" }, version: { type: "integer", minimum: 1 }, pages: { type: "array", minItems: 1, maxItems: 100, items: { type: "integer", minimum: 1 } }, maxCharacters: { type: "integer", minimum: 1000, maximum: 200000 } } },
  outputSchema: { type: "object", required: ["file", "version", "pageCount", "selectedPages", "content", "truncated", "parser"], properties: { file: { type: "object" }, version: { type: "integer" }, pageCount: { type: "integer" }, selectedPages: { type: "array", items: { type: "integer" } }, content: { type: "string" }, truncated: { type: "boolean" }, parser: { type: "object" } } },
  qualityGates: [({ data }) => ({ id: "pdf_source_trace", ok: Boolean(data.file?.checksum && data.parser?.name), message: "PDF output lacks source checksum or parser provenance." })],
  handler: parseWorkspacePdf
}];

module.exports = { pdfTools, parseWorkspacePdf };
