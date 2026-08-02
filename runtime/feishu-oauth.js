const crypto = require("crypto");

const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const OPEN_API_BASE = "https://open.feishu.cn/open-apis";

function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromBase64url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - normalized.length % 4) % 4), "base64");
}
function requireStateSecret(secret) {
  const value = String(secret || "");
  if (value.length < 24) throw Object.assign(new Error("Configure TONA_OAUTH_STATE_KEY or a strong TONA_SECRETS_KEY before starting Feishu OAuth."), { code: "FEISHU_OAUTH_STATE_KEY_REQUIRED", statusCode: 503 });
  return value;
}
function signOauthState(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(crypto.createHmac("sha256", requireStateSecret(secret)).update(body).digest());
  return body + "." + signature;
}
function verifyOauthState(state, secret, now = Date.now()) {
  const [body, signature, extra] = String(state || "").split(".");
  if (!body || !signature || extra) throw Object.assign(new Error("Invalid Feishu OAuth state."), { code: "FEISHU_OAUTH_STATE_INVALID", statusCode: 400 });
  const expected = crypto.createHmac("sha256", requireStateSecret(secret)).update(body).digest();
  const actual = fromBase64url(signature);
  if (base64url(actual) !== signature || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw Object.assign(new Error("Feishu OAuth state signature mismatch."), { code: "FEISHU_OAUTH_STATE_INVALID", statusCode: 400 });
  let payload;
  try { payload = JSON.parse(fromBase64url(body).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid Feishu OAuth state payload."), { code: "FEISHU_OAUTH_STATE_INVALID", statusCode: 400 }); }
  if (!Number.isFinite(payload.exp) || payload.exp < now) throw Object.assign(new Error("Feishu OAuth request expired. Start authorization again."), { code: "FEISHU_OAUTH_STATE_EXPIRED", statusCode: 400 });
  return payload;
}
function createAuthorizationUrl({ appId, redirectUri, scopes = [], state }) {
  if (!appId || !redirectUri || !state) throw new Error("appId, redirectUri and state are required.");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (scopes.length) url.searchParams.set("scope", [...new Set(scopes)].join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}
async function tokenRequest(body, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const apiBase = String(options.apiBase || OPEN_API_BASE).replace(/\/+$/, "");
  const response = await fetchImpl(apiBase + "/authen/v2/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: options.signal || AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload.code && payload.code !== 0)) {
    const error = new Error(payload.error_description || payload.msg || payload.message || `Feishu OAuth failed with HTTP ${response.status}.`);
    error.code = payload.error || payload.code || "FEISHU_OAUTH_TOKEN_FAILED";
    error.statusCode = 502;
    throw error;
  }
  return payload.data && typeof payload.data === "object" ? payload.data : payload;
}
function exchangeAuthorizationCode({ appId, appSecret, code, redirectUri }, options = {}) {
  return tokenRequest({ grant_type: "authorization_code", client_id: appId, client_secret: appSecret, code, redirect_uri: redirectUri }, options);
}
function refreshUserAccessToken({ appId, appSecret, refreshToken }, options = {}) {
  return tokenRequest({ grant_type: "refresh_token", client_id: appId, client_secret: appSecret, refresh_token: refreshToken }, options);
}
async function getFeishuUserInfo(accessToken, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const apiBase = String(options.apiBase || OPEN_API_BASE).replace(/\/+$/, "");
  const response = await fetchImpl(apiBase + "/authen/v1/user_info", { headers: { Authorization: "Bearer " + accessToken }, signal: options.signal || AbortSignal.timeout(10000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || (payload.code && payload.code !== 0)) {
    const error = new Error(payload.msg || payload.message || `Feishu user info failed with HTTP ${response.status}.`);
    error.code = payload.code || "FEISHU_USER_INFO_FAILED";
    error.statusCode = 502;
    throw error;
  }
  return payload.data || payload;
}
function publicAuthorization(record) {
  return {
    id: record.id, botId: record.botId, userOpenId: record.userOpenId, name: record.name,
    scopes: record.scopes || [], status: record.status, expiresAt: record.expiresAt,
    refreshExpiresAt: record.refreshExpiresAt, updatedAt: record.updatedAt
  };
}

module.exports = { AUTHORIZE_URL, OPEN_API_BASE, signOauthState, verifyOauthState, createAuthorizationUrl, exchangeAuthorizationCode, refreshUserAccessToken, getFeishuUserInfo, publicAuthorization };
