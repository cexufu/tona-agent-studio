const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WorkspaceFileStore } = require("../runtime/workspace-files");
const { executeTool, TOOL_CATALOG } = require("../runtime/tool-runtime");

function minimalPdf(text) {
  const escaped = String(text).replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) pdf += String(offsets[index]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tona-pdf-"));
  try {
    const store = new WorkspaceFileStore(root, "ws_pdf");
    const saved = store.save({ name: "sample.pdf", mime: "application/pdf", buffer: minimalPdf("TONA PDF parser ready"), createdBy: "test" });
    const result = await executeTool("pdf_parse", { file_id: saved.file_id }, { workspaceId: "ws_pdf", authorizedWorkspaceId: "ws_pdf", fileStore: store });
    assert.equal(result.resultType, "tool_result");
    assert.equal(result.data.pageCount, 1);
    assert.match(result.data.content, /TONA PDF parser ready/);
    assert.equal(result.data.parser.name, "pdf-parse");
    assert.deepEqual(result.quality, [{ id: "pdf_source_trace", ok: true }]);
    assert.equal(result.data.file.checksum.length, 64);
    assert(TOOL_CATALOG.some((tool) => tool.id === "pdf_parse" && tool.status === "ready"));
    console.log("PDF tool test passed: local extraction, page count, checksum traceability, quality gate, and ready catalog status.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
