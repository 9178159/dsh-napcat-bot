// lib/napcat-webui-api.js
// NapCat WebUI HTTP API 客户端（零外部依赖，仅用 Node 内置 fetch / crypto）。
//
// 为什么需要它：
//   直接改 config/onebot11_<uin>.json 之后，NapCat **不保证**会热加载（实测经常不生效，
//   或者它自己保存时把 WS 条目丢掉），结果就是「QQ 登录了但 3001 没在监听」。
//   NapCat 自己的 WebUI 设置页走的是 POST /api/OB11Config/SetConfig —— 它内部会
//   `configLoader.save()` + `reloadNetwork()`，**真正把网络适配器重启**。
//   所以启用 OneBot 正向 HTTP/WS 的可靠做法是走这个官方接口。
//
// 鉴权：WebUI 管理 Token 先做 sha256(token + '.napcat') 得到 hash，
//      POST /api/auth/login {hash} → data.Credential（JWT 风格串，之后放 Authorization: Bearer）。

import { createHash } from 'node:crypto';

const API_PREFIX = '/api';

function baseOf(port) {
  return `http://127.0.0.1:${Number(port) || 6099}`;
}

async function postJson(url, body, credential, timeoutMs = 8000) {
  const headers = { 'Content-Type': 'application/json' };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** sha256(token + '.napcat')，与 NapCat 的 generatePasswordHash 完全一致。 */
export async function passwordHash(token) {
  return createHash('sha256').update(String(token) + '.napcat').digest('hex');
}

/** 用 WebUI 管理 Token 换一个 Credential。失败返回 ''。 */
export async function login(port, token) {
  if (!token) return '';
  try {
    const hash = await passwordHash(token);
    const r = await postJson(`${baseOf(port)}${API_PREFIX}/auth/login`, { hash });
    const data = r.json && r.json.data;
    if (data && data.Credential) return String(data.Credential);
    return '';
  } catch { return ''; }
}

/** 读取当前 OneBot 配置对象（失败返回 null）。 */
export async function getOneBotConfig(port, credential) {
  try {
    const r = await postJson(`${baseOf(port)}${API_PREFIX}/OB11Config/GetConfig`, {}, credential);
    if (r.json && r.json.code === 0 && r.json.data) return r.json.data;
    return null;
  } catch { return null; }
}

/**
 * 应用 OneBot 配置（NapCat 内部会保存并重启网络适配器）。
 * @returns {{ok:boolean, error?:string}}
 */
export async function setOneBotConfig(port, credential, configObj) {
  try {
    // 接口要的是「配置文件文本」：JSON 本身是合法 YAML，直接给 JSON 字符串即可。
    const payload = { config: JSON.stringify(configObj, null, 2) };
    const r = await postJson(`${baseOf(port)}${API_PREFIX}/OB11Config/SetConfig`, payload, credential);
    if (r.json && r.json.code === 0) return { ok: true };
    const msg = (r.json && (r.json.message || r.json.error)) || r.text || `HTTP ${r.status}`;
    return { ok: false, error: String(msg) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 一步到位：登录 + 写入配置。credential 可复用，过期自动重登一次。 */
export async function applyOneBotConfig(port, token, configObj, credential) {
  let cred = credential || (await login(port, token));
  if (!cred) return { ok: false, error: 'WebUI 登录失败（Token 不匹配或 WebUI 未就绪）' };
  let r = await setOneBotConfig(port, cred, configObj);
  if (!r.ok && /unauthor|token|401/i.test(String(r.error || ''))) {
    cred = await login(port, token);
    if (cred) r = await setOneBotConfig(port, cred, configObj);
  }
  return Object.assign({ credential: cred }, r);
}
