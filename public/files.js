(() => {
  const fileState = { files: [] };
  const byId = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

  async function request(route, options = {}) {
    const response = await fetch(route, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const type = response.headers.get("content-type") || "";
    const body = type.includes("application/json") ? await response.json() : { error: await response.text() };
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function notify(message) {
    const box = byId("toast");
    if (!box) return;
    box.textContent = message;
    box.classList.add("show");
    setTimeout(() => box.classList.remove("show"), 2400);
  }

  function sizeLabel(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function render() {
    const list = byId("workspaceFileList");
    if (!list) return;
    byId("workspaceFileCount").textContent = String(fileState.files.length);
    if (!fileState.files.length) {
      list.innerHTML = '<p class="meta">当前工作区还没有文件。</p>';
      return;
    }
    list.innerHTML = fileState.files.map((file) => `
      <div class="tool-item">
        <div><strong>${escape(file.name)}</strong><p>${escape(file.mime)} · ${sizeLabel(file.size)} · v${file.version} · ${escape(file.file_id)}${file.artifact_id ? ` · ${escape(file.artifact_id)}` : ""}</p></div>
        <div class="button-row">
          <button type="button" data-file-action="read" data-file-id="${escape(file.file_id)}">读取</button>
          <a class="button-link" href="/api/files/${encodeURIComponent(file.file_id)}/content">下载</a>
          <button type="button" data-file-action="rename" data-file-id="${escape(file.file_id)}">重命名</button>
          <button type="button" data-file-action="delete" data-file-id="${escape(file.file_id)}">删除</button>
        </div>
      </div>`).join("");
  }

  async function loadFiles() {
    const result = await request("/api/files");
    fileState.files = result.files || [];
    render();
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function upload(event) {
    event.preventDefault();
    const file = byId("workspaceFileInput").files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return notify("文件不能超过 10MB");
    const contentBase64 = await readAsBase64(file);
    await request("/api/files", { method: "POST", body: JSON.stringify({ name: file.name, mime: file.type, contentBase64 }) });
    event.target.reset();
    await loadFiles();
    notify("文件已上传到当前工作区");
  }

  async function generate(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    const format = String(form.get("format"));
    const content = String(form.get("content") || "");
    const payload = { name: String(form.get("name") || "artifact"), format, content, createdBy: "studio" };
    if (format === "csv") {
      try { payload.data = JSON.parse(content); } catch { throw new Error("CSV 生成内容请填写 JSON 对象数组。"); }
      delete payload.content;
    }
    await request("/api/files/generate", { method: "POST", headers: { "Idempotency-Key": `studio-${Date.now()}` }, body: JSON.stringify(payload) });
    await loadFiles();
    notify("工作区产物已生成");
  }

  async function fileAction(event) {
    const button = event.target.closest("[data-file-action]");
    if (!button) return;
    const fileId = button.dataset.fileId;
    const action = button.dataset.fileAction;
    if (action === "read") {
      const result = await request(`/api/files/${encodeURIComponent(fileId)}/read`);
      byId("workspaceFilePreview").textContent = `${result.data.file.name} · v${result.data.version}${result.data.truncated ? " · 已截断" : ""}\n\n${result.data.content}`;
    }
    if (action === "rename") {
      const current = fileState.files.find((file) => file.file_id === fileId);
      const name = window.prompt("新文件名（扩展名必须保持一致）", current?.name || "");
      if (!name) return;
      await request(`/api/files/${encodeURIComponent(fileId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
      await loadFiles();
    }
    if (action === "delete") {
      if (!window.confirm("确认从当前工作区删除这个文件？元数据会保留软删除记录。")) return;
      await request(`/api/files/${encodeURIComponent(fileId)}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) });
      await loadFiles();
      byId("workspaceFilePreview").textContent = "文件已删除。";
    }
  }

  function handle(promise) { promise.catch((error) => notify(error.message)); }
  document.addEventListener("DOMContentLoaded", () => {
    byId("fileUploadForm")?.addEventListener("submit", (event) => handle(upload(event)));
    byId("artifactGenerateForm")?.addEventListener("submit", (event) => handle(generate(event)));
    byId("refreshFilesButton")?.addEventListener("click", () => handle(loadFiles()));
    byId("workspaceFileList")?.addEventListener("click", (event) => handle(fileAction(event)));
    document.querySelector('[data-view="files"]')?.addEventListener("click", () => handle(loadFiles()));
  });
})();
