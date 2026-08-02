const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "public", "files.js"), "utf8");
for (const marker of ['data-view="files"', 'id="view-files"', 'id="fileUploadForm"', 'id="artifactGenerateForm"', 'id="workspaceFileList"', 'src="/files.js"']) assert(html.includes(marker), `Missing file UI marker: ${marker}`);
for (const route of ["/api/files", "/api/files/generate", "/content"]) assert(script.includes(route), `Missing file UI route: ${route}`);
assert(script.includes('isPdf ? "parse" : "read"'), "PDF read action must route to the parser");
assert(script.includes("window.confirm"), "Delete UI must require explicit confirmation");
assert(html.indexOf('src="/files.js"') < html.indexOf("</body>"), "File UI script must be inside the HTML body");
assert(script.includes("10 * 1024 * 1024"), "Upload UI must enforce the 10MB limit");
console.log("Files UI test passed: navigation, upload, generation, list, read, download, and confirmed deletion controls.");
