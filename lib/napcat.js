// lib/napcat.js
// NapCat OneBot 11 客户端（零外部依赖）。
//
// 发送 / 状态查询：HTTP（Node 全局 fetch）
// 接收消息：正向 WebSocket（Node 全局 WebSocket），或 webhook（DSH webServer）
//
// 事件过滤（只放行「真人发的聊天消息」）：
//   · 只要 post_type === 'message'（自动排除 notice / request / meta_event，
//     如点赞、加好友请求、群成员变动、心跳等）；
//   · message_type 只接受 private / group；
//   · 丢弃机器人自己发的（sender.user_id === 自己 QQ、sub_type === 'self'）；
//   · 丢弃空文本（纯图片/语音等无文字消息跳过，避免瞎回）；
//   · 丢弃系统通知类 sender（user_id 为 0 / 空）。
//
// 连接状态（面板指示灯三态）：'connecting' 连接中 → 'online' 已就绪 → 'offline' 未连接

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isDuplicateEvent, resetDedupe } from './dedupe.js';

function statusFilePath() {
  const base = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'napcat-bot')
    : path.join(os.homedir(), '.dsh', 'napcat-bot');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
  return path.join(base, 'status.json');
}

/**
 * 调用 OneBot HTTP API。
 *
 * ⚠️ 必须 POST 到 `/<action>` 具名路径。NapCat 的 HTTP 适配器**不会**按 body 里的
 * `action` 字段分发：往根路径 `/` POST 只会返回一个桩响应
 * `{"status":"ok","data":{},"message":"NapCat4 Is Running"}`，
 * 于是 get_login_info 永远拿不到 QQ 号、send_*_msg 永远是空操作（消息发不出去）。
 */
async function httpCall(baseUrl, token, action, params = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const url = `${base}/${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, params, echo: String(Date.now()) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json().catch(() => ({}));
  if (json && json.status === 'failed') {
    const err = new Error(json.message || json.wording || 'onebot failed');
    err.code = json.retcode;
    throw err;
  }
  return json?.data;
}

/** 从 OneBot 消息里抽纯文本（兼容 string 与 array 两种上报格式）。 */
export function extractText(message, rawMessage) {
  if (typeof message === 'string' && message) return message;
  if (Array.isArray(message)) {
    const parts = [];
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.type === 'text' && seg.data && typeof seg.data.text === 'string') parts.push(seg.data.text);
      else if (seg.type === 'at' && seg.data && seg.data.qq) parts.push(`[CQ:at,qq=${seg.data.qq}]`);
    }
    if (parts.length) return parts.join('');
  }
  return typeof rawMessage === 'string' ? rawMessage : '';
}

/**
 * 规范化 OneBot 正向 WS 地址。
 *
 * 这里专门防一类真实故障：把 **WebUI 端口 6099** 当成 OneBot WS 端口。
 * 6099 是 NapCat 的管理面（HTTP + 页面），不是 OneBot 适配器，连上去只会
 * 401/无响应，表现就是「WS 客户端数 0、插件收不到消息」。
 *
 * 规则：
 *   1) 补全协议头（历史上可能被写成 http:// 或裸主机:端口）；
 *   2) 去掉尾部斜杠（否则拼 token 查询串会变成 //?access_token=…）；
 *   3) 端口为空、或等于 WebUI 端口 6099、或等于 HTTP 端口 → 一律回落到 OneBot WS 端口 3001。
 */
export function normalizeWsUrl(rawUrl, opts = {}) {
  const webuiPort = Number(opts.webuiPort) || 6099;
  const httpPort = Number(opts.httpPort) || 3000;
  const fallbackPort = Number(opts.wsPort) || 3001;

  let u = String(rawUrl == null ? '' : rawUrl).trim();
  if (!u) return `ws://127.0.0.1:${fallbackPort}`;
  if (/^https?:\/\//i.test(u)) u = u.replace(/^https?:\/\//i, 'ws://');
  if (!/^wss?:\/\//i.test(u)) u = 'ws://' + u.replace(/^\/+/, '');
  u = u.replace(/\/+$/, '');

  const m = u.match(/^(wss?:\/\/)([^/:]+)(?::(\d+))?$/i);
  if (!m) return `ws://127.0.0.1:${fallbackPort}`;
  const scheme = m[1].toLowerCase();
  const host = m[2];
  const port = m[3] ? Number(m[3]) : 80;
  if (!port || port === webuiPort || port === httpPort) {
    return `${scheme}${host}:${fallbackPort}`;
  }
  return `${scheme}${host}:${port}`;
}

export function createNapCat(config, ctx, log) {
  let selfQQ = (config.selfQQ || '').toString().trim();
  const statusFile = statusFilePath();
  let lastState = 'offline';

  // 生效中的 WS 地址：构造时就修正，后续所有连接 / 展示都用它
  const wsUrl = normalizeWsUrl(config.napcatWsUrl, {
    webuiPort: config.webuiPort,
    httpPort: config.napcatHttpPort,
    wsPort: config.napcatWsPort,
  });
  if (String(config.napcatWsUrl || '') && wsUrl !== String(config.napcatWsUrl || '').replace(/\/+$/, '')) {
    log.info(`[napcat] WS 地址已自动校正：${config.napcatWsUrl} → ${wsUrl}（WebUI 端口不能当 OneBot 端口）`);
  }

  // ── WS 通道：既是收消息的入口，也是发送动作的兜底通道 ──
  // 现在多数人的 NapCat 只开了正向 WS、没开 HTTP。此时 HTTP 发送会失败，
  // 但只要 WS 是通的，就可以把 OneBot action 直接走 WS（同一条连接支持 echo 应答）。
  const wsLink = { sock: null, open: false, pending: new Map() };

  function sendOverWs(action, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const sock = wsLink.sock;
      if (!sock || !wsLink.open) { reject(new Error('WS 未连接，无法通过 WS 发送')); return; }
      const echo = `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        wsLink.pending.delete(echo);
        reject(new Error('WS 调用超时：' + action));
      }, timeoutMs);
      try { if (timer.unref) timer.unref(); } catch { /* ignore */ }
      wsLink.pending.set(echo, { resolve, reject, timer });
      try {
        sock.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        clearTimeout(timer);
        wsLink.pending.delete(echo);
        reject(e);
      }
    });
  }

  /** WS 收到的一帧可能是事件，也可能是某个 action 的应答（带 echo）。 */
  function resolveWsReply(data) {
    if (!data || data.echo == null) return false;
    const item = wsLink.pending.get(String(data.echo));
    if (!item) return false;
    wsLink.pending.delete(String(data.echo));
    try { clearTimeout(item.timer); } catch { /* ignore */ }
    if (data.status === 'failed') {
      const err = new Error(data.message || data.wording || 'onebot failed');
      err.code = data.retcode;
      item.reject(err);
    } else {
      item.resolve(data.data);
    }
    return true;
  }

  /**
   * 调 OneBot action：优先 HTTP，失败则走正向 WS。
   * 这样「NapCat 只开了 WS 没开 HTTP」也能正常收发，不用用户去开端口。
   */
  async function callAction(action, params = {}) {
    let httpErr = null;
    try {
      return await httpCall(config.napcatHttpUrl, config.napcatToken, action, params);
    } catch (e) {
      httpErr = e;
    }
    if (wsLink.open) {
      try { return await sendOverWs(action, params); } catch (e) {
        throw new Error(`HTTP 失败(${httpErr && httpErr.message}) 且 WS 通道失败(${e && e.message})`);
      }
    }
    throw httpErr || new Error('OneBot 不可用');
  }

  function writeStatus(state, extra = {}) {
    lastState = state;
    try {
      fs.writeFileSync(statusFile, JSON.stringify({ state, time: Date.now(), ...extra }, null, 2));
    } catch { /* ignore */ }
  }

  /** 读取最近一次连接状态（供面板指示灯使用）。 */
  function getStatus() {
    try {
      const raw = fs.readFileSync(statusFile, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return Object.assign({ qq: selfQQ }, obj);
    } catch { /* ignore */ }
    return { state: lastState, time: Date.now(), qq: selfQQ };
  }

  /**
   * 刷新登录态。
   * 注意：NapCat 的 OneBot 适配器被热重载（SetConfig）后的几秒内，
   * `get_login_info` 可能返回 `data:{}`，但 `get_status.online` 已经是 true。
   * 所以以 get_status 为准，get_login_info 只用来补 QQ 号/昵称，取不到就沿用缓存。
   */
  async function refresh() {
    let online = false;
    let uin = selfQQ;
    let nickname = '';
    let lastError = '';

    try {
      const st = await callAction('get_status', {});
      if (st && typeof st === 'object') online = st.online !== false && st.good !== false;
    } catch (e) {
      lastError = String((e && e.message) || e);
    }

    if (online || !lastError) {
      try {
        const info = await callAction('get_login_info', {});
        if (info && info.user_id) {
          uin = String(info.user_id);
          nickname = info.nickname || '';
          online = true;
        }
      } catch (e) {
        if (!lastError) lastError = String((e && e.message) || e);
      }
    }

    if (uin) selfQQ = uin;
    if (online) {
      writeStatus('online', { qq: uin || '', nickname, error: '' });
      return { online: true, user_id: uin || '', nickname };
    }
    writeStatus('offline', { qq: uin || '', error: lastError || '未登录' });
    return null;
  }

  async function getLoginInfo() {
    return refresh();
  }

  async function sendPrivate(userId, text) {
    return callAction('send_private_msg', { user_id: Number(userId), message: text });
  }

  async function sendGroup(groupId, text) {
    return callAction('send_group_msg', { group_id: Number(groupId), message: text });
  }

  /** 是否 @ 了机器人：既看 CQ 码，也看 array 段落里的 at。 */
  function isAtBot(message, rawMessage) {
    if (!selfQQ) return false;
    return extractText(message, rawMessage).includes(`[CQ:at,qq=${selfQQ}]`);
  }

  /** 去掉消息中的 @ 机器人 片段。 */
  function stripAt(message, rawMessage) {
    const text = extractText(message, rawMessage);
    if (!selfQQ) return text.trim();
    return text.replace(new RegExp(`\\[CQ:at,qq=${selfQQ}\\]`, 'g'), '').replace(/^[\s,，]+/, '').trim();
  }

  /**
   * 判断一条事件是否应该交给业务处理。
   * @returns {{ok:boolean, reason?:string}}
   */
  function classify(ev) {
    if (!ev || typeof ev !== 'object') return { ok: false, reason: 'not-object' };
    if (ev.post_type !== 'message') return { ok: false, reason: 'post_type:' + String(ev.post_type) };
    const type = ev.message_type;
    if (type !== 'private' && type !== 'group') return { ok: false, reason: 'message_type:' + String(type) };
    const rawId = ev.user_id != null ? ev.user_id : (ev.sender && ev.sender.user_id);
    const userId = rawId != null ? String(rawId) : '';
    if (!userId || userId === '0') return { ok: false, reason: 'system-sender' };
    if (selfQQ && userId === selfQQ) return { ok: false, reason: 'self' };
    const sub = String(ev.sub_type || '');
    if (sub === 'self' || sub.endsWith('_self')) return { ok: false, reason: 'self-sub-type' };
    const text = extractText(ev.message, ev.raw_message).trim();
    if (text) return { ok: true };
    // 纯图片消息（没有文字）也要放行：交给识图链路处理，不然「只发一张图」永远没反应
    const hasImage = Array.isArray(ev.message)
      ? ev.message.some((seg) => seg && seg.type === 'image')
      : /\[CQ:image,/i.test(String(ev.raw_message || ev.message || ''));
    if (hasImage) return { ok: true };
    return { ok: false, reason: 'no-text' };
  }

  /**
   * 把一条事件交给上层回调；返回是否放行。
   *
   * 顺序很重要：先过滤（自身/系统/无文本），再去重，最后才回调。
   * 去重放在过滤之后，避免把「点赞」之类也写进 message_id 表里占位。
   */
  function dispatch(data, onEvent) {
    const verdict = classify(data);
    if (!verdict.ok) return false;

    const dup = isDuplicateEvent(data, { ttlMs: 120000, printWindowMs: 1500 });
    if (dup.duplicate) {
      log.warn(`[napcat] 丢弃重复消息（${dup.reason}）：message_id=${data.message_id != null ? data.message_id : '-'} 来自 ${data.user_id}`);
      return false;
    }

    try { onEvent(data); } catch (e) { log.warn(`[napcat] 消息处理回调异常: ${e}`); }
    return true;
  }

  // —— 接收方式 1：正向 WebSocket（带自动重连 / 退避 / 心跳看门狗）——
  function connectWs(onEvent, onStatus) {
    const WS = globalThis.WebSocket;
    const wsState = {
      state: 'idle',        // idle | connecting | open | closed | error | disabled
      attempts: 0,
      maxAttempts: Math.max(0, Number(config.wsMaxRetries) || 0), // 0 = 不限制
      nextRetryAt: 0,
      lastError: '',
      openedAt: 0,
      lastMessageAt: 0,
      // 面板上「WS 客户端数量」：插件自身就是 NapCat 的一个 WS 客户端
      clients: 0,
      url: wsUrl,
      port: Number(config.napcatWsPort) || 3001,
    };
    const report = (patch) => {
      Object.assign(wsState, patch);
      try { onStatus?.(wsState.state, wsState); } catch { /* ignore */ }
    };

    if (!WS) {
      wsState.state = 'disabled';
      wsState.lastError = '当前运行环境缺少全局 WebSocket，请改用 webhook 接收模式';
      log.warn('[napcat] 当前运行环境缺少全局 WebSocket，ws 接收模式不可用；请改用 webhook 模式。');
      return { dispose: () => {}, state: () => Object.assign({}, wsState) };
    }

    let closed = false;
    let ws = null;
    let retryTimer = null;
    let watchdog = null;

    const baseInterval = Math.max(500, Number(config.wsRetryInterval) || 2000);
    const maxInterval = Math.max(baseInterval, Number(config.wsRetryMaxInterval) || 15000);
    const heartbeatTimeout = Math.max(30000, Number(config.wsHeartbeatTimeout) || 100000);

    /** 指数退避：2s, 4s, 8s, 15s, 15s…（上限 maxInterval） */
    function backoffMs() {
      const n = Math.max(1, wsState.attempts);
      return Math.min(maxInterval, baseInterval * Math.pow(2, Math.min(n - 1, 6)));
    }

    function clearWatchdog() {
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
    }

    /** 看门狗：连上后长时间收不到任何东西（含心跳）→ 认为半死连接，强制重连。 */
    function startWatchdog() {
      clearWatchdog();
      watchdog = setInterval(() => {
        if (closed || wsState.state !== 'open') return;
        const last = wsState.lastMessageAt || wsState.openedAt;
        if (last && Date.now() - last > heartbeatTimeout) {
          log.warn(`[napcat] WS ${Math.round(heartbeatTimeout / 1000)}s 无任何数据（含心跳），主动重连`);
          try { ws && ws.close(); } catch { /* ignore */ }
        }
      }, 15000);
      try { if (watchdog.unref) watchdog.unref(); } catch { /* ignore */ }
    }

    function scheduleRetry(reason) {
      if (closed) return;
      retryTimer = null;
      const limit = wsState.maxAttempts;
      if (limit > 0 && wsState.attempts >= limit) {
        report({ state: 'error', lastError: `已重试 ${wsState.attempts} 次仍失败：${reason || wsState.lastError}`, nextRetryAt: 0 });
        log.warn(`[napcat] WS 已达最大重试次数 ${limit}，停止自动重连（可点面板「重新连接」或重启插件）`);
        return;
      }
      const wait = backoffMs();
      report({ state: 'connecting', nextRetryAt: Date.now() + wait, lastError: reason || wsState.lastError });
      retryTimer = setTimeout(open, wait);
      try { if (retryTimer.unref) retryTimer.unref(); } catch { /* ignore */ }
    }

    function open() {
      if (closed) return;
      retryTimer = null;
      const url = config.napcatToken
        ? `${wsUrl}?access_token=${encodeURIComponent(config.napcatToken)}`
        : wsUrl;
      wsState.url = url;
      report({ state: 'connecting' });

      // 本次尝试的结算：'连接失败' 与 '连上后断开' 都要能触达 scheduleRetry
      let opened = false;
      let finished = false;
      let connectTimer = null;
      const fail = (reason, countAttempt) => {
        if (finished || closed) return;
        finished = true;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        clearWatchdog();
        if (countAttempt) wsState.attempts += 1;
        // 连上之后又掉线：从第 1 次算起，保证退避从 baseInterval 开始正常增长
        else if (opened && wsState.attempts < 1) wsState.attempts = 1;
        wsState.lastError = reason;
        // 连接没了 → 撤销发送兜底通道，并让挂起的 action 立刻失败而不是干等超时
        if (wsLink.sock === sock) { wsLink.sock = null; wsLink.open = false; }
        for (const [echo, item] of wsLink.pending) {
          try { clearTimeout(item.timer); } catch { /* ignore */ }
          wsLink.pending.delete(echo);
          try { item.reject(new Error('WS 连接已断开')); } catch { /* ignore */ }
        }
        report({ clients: 0 });
        try { ws && ws.close(); } catch { /* ignore */ }
        log.warn(`[napcat] WS 断开（第 ${wsState.attempts} 次尝试）：${reason}`);
        scheduleRetry(reason);
      };

      let sock;
      try {
        sock = new WS(url);
      } catch (e) {
        fail('WS 创建失败：' + String((e && e.message) || e), true);
        return;
      }
      ws = sock;

      // 连接超时：8s 还没 open 就算这次失败（NapCat 端口没开时全靠它推进重试）
      connectTimer = setTimeout(() => {
        if (!opened && !finished) fail('连接超时（8s 未建立）', true);
      }, 8000);
      try { if (connectTimer.unref) connectTimer.unref(); } catch { /* ignore */ }

      sock.onopen = () => {
        if (finished) { try { sock.close(); } catch { /* ignore */ } return; }
        opened = true;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        wsState.attempts = 0;
        // 注册为发送兜底通道（HTTP 不可用时走这里）
        wsLink.sock = sock;
        wsLink.open = true;
        report({ state: 'open', openedAt: Date.now(), lastMessageAt: Date.now(), lastError: '', nextRetryAt: 0, clients: 1 });
        log.info(`[napcat] WS 已连接 ${wsUrl}（插件已作为 1 个客户端接入 NapCat）`);
        startWatchdog();
        // WS 一连上就确认登录态（此时 HTTP 挂了也能通过 WS 拿到）
        getLoginInfo().catch(() => {});
      };
      sock.onmessage = (ev) => {
        wsState.lastMessageAt = Date.now();
        let data = null;
        try { data = JSON.parse(ev.data); } catch { return; } // 非 JSON 心跳等，忽略
        // action 应答（带 echo）→ 交给等待中的 callAction
        if (resolveWsReply(data)) return;
        try { dispatch(data, onEvent); } catch { /* ignore */ }
      };
      sock.onerror = () => {
        // onerror 之后 onclose 不一定会来，所以这里直接结算并排下一次重试
        fail('WS 连接出错（NapCat 未开启正向 WS，或 access_token 不匹配）', !opened);
      };
      sock.onclose = (ev) => {
        fail(`连接已关闭（code=${ev && ev.code != null ? ev.code : '?'}）`, !opened);
      };
    }

    open();

    return {
      dispose() {
        closed = true;
        clearWatchdog();
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        wsLink.sock = null;
        wsLink.open = false;
        for (const [echo, item] of wsLink.pending) {
          try { clearTimeout(item.timer); } catch { /* ignore */ }
          wsLink.pending.delete(echo);
          try { item.reject(new Error('WS 已关闭')); } catch { /* ignore */ }
        }
        try { ws && ws.close(); } catch { /* ignore */ }
        wsState.state = 'idle';
        wsState.clients = 0;
      },
      /** 手动立即重连（面板按钮 / OneBot 配置刚生效时调用）。 */
      reconnect() {
        if (closed) return;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        try { ws && ws.close(); } catch { /* ignore */ }
        wsState.attempts = 0;
        clearWatchdog();
        // 稍等一拍，避开 close 事件里的排队
        setTimeout(() => { if (!closed) open(); }, 200);
      },
      state: () => Object.assign({}, wsState),
    };
  }

  // —— 接收方式 2：HTTP webhook（DSH 内置 webServer）——
  async function startWebhook(onEvent) {
    const web = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (!web || typeof web.register !== 'function') {
      log.warn('[napcat] webServer 不可用，无法启用 webhook 接收（可改用 ws 模式）。');
      return { dispose: () => {}, state: () => ({ state: 'disabled', lastError: 'webServer 不可用' }) };
    }
    try {
      const dispose = web.register({
        kind: 'prefix',
        path: String(config.webhookPath || '/napcat-bot/onebot').replace(/\/+$/, ''),
        handler: async (req, res) => {
          try {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const raw = Buffer.concat(chunks).toString('utf8');
            const data = raw ? JSON.parse(raw) : null;
            const list = Array.isArray(data) ? data : [data];
            for (const ev of list) dispatch(ev, onEvent);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 500;
            res.end('err');
          }
        },
      });
      log.info(`[napcat] webhook 接收已注册: ${config.webhookPath}`);
      return {
        dispose: typeof dispose === 'function' ? dispose : () => {},
        state: () => ({ state: 'open', mode: 'webhook', url: config.webhookPath }),
      };
    } catch (e) {
      log.warn(`[napcat] webhook 注册失败: ${e}`);
      return { dispose: () => {}, state: () => ({ state: 'error', lastError: String(e) }) };
    }
  }

  return {
    get selfQQ() { return selfQQ; },
    /** 生效中的 OneBot WS 地址（已规范化，不会是 6099）。 */
    wsUrl,
    callAction,
    getLoginInfo,
    sendPrivate,
    sendGroup,
    isAtBot,
    stripAt,
    extractText,
    classify,
    connectWs,
    startWebhook,
    writeStatus,
    getStatus,
    resetDedupe,
  };
}
