const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { RuntimeToolError } = require("./runtime-v2");

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_ID_PATTERN = /^file_[A-Za-z0-9_-]{12,80}$/;
const MIME_BY_EXTENSION = {
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".html": "text/html", ".htm": "text/html", ".json": "application/json",
  ".csv": "text/csv", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"
};
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/html", "application/json", "text/csv"]);

function safeFilename(value) {
  const name = path.basename(String(value || "file")).replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_").trim();
  return (name || "file").slice(0, 180);
}

function mimeForName(name, requested = "") {
  const expected = MIME_BY_EXTENSION[path.extname(name).toLowerCase()];
  if (!expected) throw new RuntimeToolError("FILE_TYPE_UNSUPPORTED", `Unsupported file type: ${path.extname(name) || "missing extension"}`, { category: "validation", status: 415 });
  if (requested && String(requested).split(";")[0].trim().toLowerCase() !== expected) throw new RuntimeToolError("FILE_MIME_MISMATCH", "File extension and MIME type do not match.", { category: "validation", status: 415 });
  return expected;
}

function checksum(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}

function stripHtml(value) {
  return String(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(rows) {
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new RuntimeToolError("ARTIFACT_DATA_INVALID", "CSV generation requires an array of objects.", { category: "validation" });
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [headers.map(csvEscape).join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\r\n");
}

class WorkspaceFileStore {
  constructor(rootDirectory, workspaceId) {
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(String(workspaceId || ""))) throw new RuntimeToolError("FILE_WORKSPACE_REQUIRED", "A valid workspace is required for file access.", { category: "permission", status: 403 });
    this.workspaceId = workspaceId;
    this.root = path.resolve(rootDirectory);
    this.blobRoot = path.join(this.root, "blobs");
    this.indexPath = path.join(this.root, "index.json");
    fs.mkdirSync(this.blobRoot, { recursive: true });
    if (!fs.existsSync(this.indexPath)) atomicJson(this.indexPath, { schemaVersion: 1, files: [] });
  }

  readIndex() {
    const value = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
    value.files ||= [];
    return value;
  }

  writeIndex(index) { atomicJson(this.indexPath, index); }

  publicRecord(record) {
    return {
      file_id: record.file_id, artifact_id: record.artifact_id || "", workspaceId: record.workspaceId,
      name: record.name, mime: record.mime, size: record.size, checksum: record.checksum,
      version: record.version, source: record.source, sourceTaskId: record.sourceTaskId || "",
      createdBy: record.createdBy || "", createdAt: record.createdAt, updatedAt: record.updatedAt,
      versions: (record.versions || []).map(({ blob, ...version }) => version)
    };
  }

  list() { return this.readIndex().files.filter((record) => !record.deletedAt).map((record) => this.publicRecord(record)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

  find(fileId, includeDeleted = false) {
    if (!FILE_ID_PATTERN.test(String(fileId || ""))) throw new RuntimeToolError("FILE_ID_INVALID", "Invalid file_id.", { category: "validation" });
    const record = this.readIndex().files.find((item) => item.file_id === fileId);
    if (!record || (!includeDeleted && record.deletedAt)) throw new RuntimeToolError("FILE_NOT_FOUND", "File not found in this workspace.", { category: "not_found", status: 404 });
    if (record.workspaceId !== this.workspaceId) throw new RuntimeToolError("FILE_WORKSPACE_DENIED", "File does not belong to this workspace.", { category: "permission", status: 403 });
    return record;
  }

  save({ name, mime = "", buffer, source = "studio_upload", sourceTaskId = "", createdBy = "", fileId = "", artifact = false }) {
    const filename = safeFilename(name);
    const resolvedMime = mimeForName(filename, mime);
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    if (!bytes.length) throw new RuntimeToolError("FILE_EMPTY", "File content is empty.", { category: "validation" });
    if (bytes.length > MAX_FILE_BYTES) throw new RuntimeToolError("FILE_TOO_LARGE", `File exceeds the ${MAX_FILE_BYTES / 1024 / 1024}MB limit.`, { category: "validation", status: 413 });
    if (TEXT_MIMES.has(resolvedMime)) new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const index = this.readIndex();
    let record = fileId ? index.files.find((item) => item.file_id === fileId && !item.deletedAt) : null;
    if (fileId && !record) throw new RuntimeToolError("FILE_NOT_FOUND", "Cannot add a version to a missing file.", { category: "not_found", status: 404 });
    const now = new Date().toISOString();
    const id = record?.file_id || `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const version = (record?.version || 0) + 1;
    const extension = path.extname(filename).toLowerCase();
    const relativeBlob = path.join(id, `v${version}${extension}`);
    const absoluteBlob = path.resolve(this.blobRoot, relativeBlob);
    if (!absoluteBlob.startsWith(this.blobRoot + path.sep)) throw new RuntimeToolError("FILE_PATH_INVALID", "Unsafe file path.", { category: "permission", status: 403 });
    fs.mkdirSync(path.dirname(absoluteBlob), { recursive: true });
    fs.writeFileSync(absoluteBlob, bytes, { flag: "wx" });
    const versionRecord = { version, name: filename, mime: resolvedMime, size: bytes.length, checksum: checksum(bytes), createdAt: now, createdBy, blob: relativeBlob };
    if (record) {
      Object.assign(record, versionRecord, { source, sourceTaskId, updatedAt: now });
      record.versions.push(versionRecord);
    } else {
      record = { file_id: id, artifact_id: artifact ? `art_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}` : "", workspaceId: this.workspaceId, ...versionRecord, source, sourceTaskId, createdBy, createdAt: now, updatedAt: now, versions: [versionRecord] };
      index.files.push(record);
    }
    this.writeIndex(index);
    return this.publicRecord(record);
  }

  readBuffer(fileId, version) {
    const record = this.find(fileId);
    const selected = version ? record.versions.find((item) => item.version === Number(version)) : record.versions.at(-1);
    if (!selected) throw new RuntimeToolError("FILE_VERSION_NOT_FOUND", "File version not found.", { category: "not_found", status: 404 });
    const absoluteBlob = path.resolve(this.blobRoot, selected.blob);
    if (!absoluteBlob.startsWith(this.blobRoot + path.sep)) throw new RuntimeToolError("FILE_PATH_INVALID", "Unsafe file path.", { category: "permission", status: 403 });
    const buffer = fs.readFileSync(absoluteBlob);
    if (checksum(buffer) !== selected.checksum) throw new RuntimeToolError("FILE_INTEGRITY_FAILED", "File checksum verification failed.", { category: "artifact", status: 500 });
    return { record: this.publicRecord(record), selected: { ...selected, blob: undefined }, buffer };
  }

  readText(fileId, options = {}) {
    const { record, selected, buffer } = this.readBuffer(fileId, options.version);
    if (!TEXT_MIMES.has(selected.mime)) throw new RuntimeToolError("FILE_READER_UNAVAILABLE", `Text extraction for ${selected.mime} is not installed yet.`, { category: "unsupported", status: 415 });
    let text = buffer.toString("utf8");
    if (selected.mime === "application/json") {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { throw new RuntimeToolError("FILE_CONTENT_INVALID", "Stored JSON is invalid.", { category: "validation" }); }
    }
    if (selected.mime === "text/html") text = stripHtml(text);
    const maxCharacters = Math.min(100000, Math.max(1000, Number(options.maxCharacters) || 50000));
    return { file: record, version: selected.version, content: text.slice(0, maxCharacters), truncated: text.length > maxCharacters };
  }

  rename(fileId, name) {
    const filename = safeFilename(name);
    const index = this.readIndex();
    const record = index.files.find((item) => item.file_id === fileId && !item.deletedAt);
    if (!record || record.workspaceId !== this.workspaceId) throw new RuntimeToolError("FILE_NOT_FOUND", "File not found in this workspace.", { category: "not_found", status: 404 });
    mimeForName(filename, record.mime);
    record.name = filename;
    record.updatedAt = new Date().toISOString();
    this.writeIndex(index);
    return this.publicRecord(record);
  }

  delete(fileId) {
    const index = this.readIndex();
    const record = index.files.find((item) => item.file_id === fileId && !item.deletedAt);
    if (!record || record.workspaceId !== this.workspaceId) throw new RuntimeToolError("FILE_NOT_FOUND", "File not found in this workspace.", { category: "not_found", status: 404 });
    record.deletedAt = new Date().toISOString();
    record.updatedAt = record.deletedAt;
    this.writeIndex(index);
    return { file_id: fileId, deletedAt: record.deletedAt };
  }

  generate({ name, format, content, data, sourceTaskId = "", createdBy = "" }) {
    const normalized = String(format || path.extname(name).slice(1)).toLowerCase();
    const formats = { txt: [".txt", "text/plain"], markdown: [".md", "text/markdown"], md: [".md", "text/markdown"], html: [".html", "text/html"], json: [".json", "application/json"], csv: [".csv", "text/csv"] };
    const target = formats[normalized];
    if (!target) throw new RuntimeToolError("ARTIFACT_FORMAT_UNSUPPORTED", `Artifact generation for '${normalized}' is not available yet.`, { category: "unsupported", status: 415 });
    let value;
    if (normalized === "json") value = JSON.stringify(data !== undefined ? data : JSON.parse(String(content || "null")), null, 2);
    else if (normalized === "csv") value = rowsToCsv(data);
    else value = String(content || "");
    const requestedName = safeFilename(name || `artifact${target[0]}`);
    const filename = path.extname(requestedName) ? requestedName : requestedName + target[0];
    return this.save({ name: filename, mime: target[1], buffer: Buffer.from(value, "utf8"), source: "runtime_generated", sourceTaskId, createdBy, artifact: true });
  }
}

const fileTools = [
  {
    id: "file_read", name: "工作区文件读取", category: "files", risk: "read", status: "ready", description: "按 file_id 读取当前工作区内已授权的文本、Markdown、HTML、JSON 或 CSV。",
    policy: { timeoutMs: 10000, retries: 0, idempotent: true, rateLimit: { maxCalls: 60, windowMs: 60000 } },
    inputSchema: { type: "object", additionalProperties: false, required: ["file_id"], properties: { file_id: { type: "string", pattern: "^file_[A-Za-z0-9_-]{12,80}$" }, version: { type: "integer", minimum: 1 }, maxCharacters: { type: "integer", minimum: 1000, maximum: 100000 } } },
    outputSchema: { type: "object", required: ["file", "version", "content", "truncated"], properties: { file: { type: "object" }, version: { type: "integer" }, content: { type: "string" }, truncated: { type: "boolean" } } },
    handler(input, context) { if (!context.fileStore) throw new RuntimeToolError("FILE_STORE_UNAVAILABLE", "Workspace file store is unavailable.", { category: "internal", status: 500 }); return context.fileStore.readText(input.file_id, input); }
  },
  {
    id: "artifact_generate", name: "工作区产物生成", category: "files", risk: "write", status: "ready", description: "生成 TXT、Markdown、HTML、JSON 或 CSV，并返回可追溯 artifact_id。",
    policy: { timeoutMs: 10000, retries: 0, idempotent: true, rateLimit: { maxCalls: 30, windowMs: 60000 } },
    inputSchema: { type: "object", additionalProperties: false, required: ["name", "format"], properties: { name: { type: "string", minLength: 1, maxLength: 180 }, format: { enum: ["txt", "markdown", "md", "html", "json", "csv"] }, content: { type: "string", maxLength: 2000000 }, data: { type: ["array", "object", "string", "number", "boolean", "null"] }, sourceTaskId: { type: "string", maxLength: 120 }, createdBy: { type: "string", maxLength: 120 } } },
    outputSchema: {
      type: "object", required: ["file", "artifacts"],
      properties: {
        file: { type: "object" },
        artifacts: {
          type: "array",
          items: { type: "object", required: ["artifact_id", "file_id"], properties: { artifact_id: { type: "string" }, file_id: { type: "string" } } }
        }
      }
    },
    handler(input, context) { if (!context.fileStore) throw new RuntimeToolError("FILE_STORE_UNAVAILABLE", "Workspace file store is unavailable.", { category: "internal", status: 500 }); const file = context.fileStore.generate(input); return { file, artifacts: [{ artifact_id: file.artifact_id, file_id: file.file_id }] }; }
  }
];

module.exports = { MAX_FILE_BYTES, MIME_BY_EXTENSION, TEXT_MIMES, WorkspaceFileStore, fileTools, safeFilename, rowsToCsv };
