const assert = require("assert");
const { signOauthState, verifyOauthState, createAuthorizationUrl, exchangeAuthorizationCode, refreshUserAccessToken, getFeishuUserInfo } = require("../runtime/feishu-oauth");

(async () => {
  const secret = "test-state-secret-with-at-least-24-characters";
  const payload = { workspaceId: "usr_test", botId: "bot_test", scopes: ["calendar:calendar:readonly", "offline_access"], redirectUri: "https://tona.example/feishu/oauth/callback/usr_test", exp: Date.now() + 60000, nonce: "n1" };
  const state = signOauthState(payload, secret);
  assert.deepEqual(verifyOauthState(state, secret), payload);
  await assert.rejects(async () => verifyOauthState(state.slice(0, -1) + (state.endsWith("A") ? "B" : "A"), secret), (error) => error.code === "FEISHU_OAUTH_STATE_INVALID");
  assert.throws(() => verifyOauthState(signOauthState({ ...payload, exp: Date.now() - 1 }, secret), secret), (error) => error.code === "FEISHU_OAUTH_STATE_EXPIRED");

  const authorizationUrl = new URL(createAuthorizationUrl({ appId: "cli_test", redirectUri: payload.redirectUri, scopes: payload.scopes, state }));
  assert.equal(authorizationUrl.hostname, "accounts.feishu.cn");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "cli_test");
  assert.match(authorizationUrl.searchParams.get("scope"), /offline_access/);
  assert.equal(authorizationUrl.searchParams.get("state"), state);

  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/authen/v1/user_info")) return { ok: true, status: 200, json: async () => ({ code: 0, data: { open_id: "ou_test", name: "OAuth Tester" } }) };
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ code: 0, access_token: body.grant_type === "refresh_token" ? "uat_refreshed" : "uat_initial", refresh_token: "urt_replacement", expires_in: 7200, refresh_expires_in: 2592000, scope: "calendar:calendar:readonly offline_access" }) };
  };
  const exchanged = await exchangeAuthorizationCode({ appId: "cli_test", appSecret: "secret", code: "code", redirectUri: payload.redirectUri }, { fetch: fakeFetch });
  assert.equal(exchanged.access_token, "uat_initial");
  const refreshed = await refreshUserAccessToken({ appId: "cli_test", appSecret: "secret", refreshToken: exchanged.refresh_token }, { fetch: fakeFetch });
  assert.equal(refreshed.access_token, "uat_refreshed");
  assert.equal(refreshed.refresh_token, "urt_replacement");
  const user = await getFeishuUserInfo(exchanged.access_token, { fetch: fakeFetch });
  assert.equal(user.open_id, "ou_test");
  assert.equal(calls.length, 3);
  const html = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "index.html"), "utf8");
  const appScript = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "app.js"), "utf8");
  assert(html.includes('id="feishuOauthPanel"'));
  assert(html.includes('id="startFeishuOauthButton"'));
  assert(appScript.includes('/api/feishu/oauth/config?botId='));
  assert(!appScript.includes('data-runtime-oauth'), "Tools must not own the Feishu OAuth callback flow");
  console.log("Feishu OAuth unit test passed: signed state, tamper/expiry rejection, consent URL, code exchange, refresh rotation, and user identity.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
