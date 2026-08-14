(function bootstrapTonaCore(global) {
  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : { error: await response.text() };
    if (response.status === 401) {
      global.location.href = "/teamflow/";
      throw new Error("Sign in required.");
    }
    if (!response.ok || payload.error) throw new Error(payload.error || "Request failed.");
    return payload;
  }

  global.TonaCore = Object.freeze({ api });
})(window);
