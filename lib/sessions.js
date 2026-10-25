// lib/sessions.js
// 会话持久化（零依赖）。
//
// 存储：<DSH_HOME>/napcat-bot/sessions.json
//   {
//     version: 2,
//     sessions: {
//       "private:123": { key, title, createdAt, updatedAt, summary, tokens,
//                         messages: [...], archives: [...] }
//     },
//     wakes: { "group:9:123": ts },
//     bans:  { "123": { at, reason } }
//   }
//
// 写入：内存改完标脏，800ms 防抖落盘（tmp + rename 原子替换），flush() 强制写。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_MESSAGES = 80;
const MAX_ARCHIVES = 5;

function dataDir() {
  const base = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'napcat-bot')
    : path.join(os.homedir(), '.dsh', 'napcat-bot');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
  return base;
}

/** 粗估 token：中文约 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token。 */
export function estimateTokens(text) {
  const s = String(text || '');
  const han = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = s.length - han;
  return Math.ceil(han + rest / 4);
}

export function createSessions(log) {
  const file = path.join(dataDir(), 'sessions.json');
  let db = null;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = null; }
  if (!db || typeof db !== 'object') db = {};
  db.version = 2;
  db.sessions = db.sessions && typeof db.sessions === 'object' ? db.sessions : {};
  db.wakes = db.wakes && typeof db.wakes === 'object' ? db.wakes : {};
  db.bans = db.bans && typeof db.bans === 'object' ? db.bans : {};

  let timer = null;
  let dirty = false;

  function persistNow() {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (e) {
      try { log && log.warn && log.warn(`[sessions] 落盘失败（已忽略）: ${e}`); } catch { /* ignore */ }
    }
  }
  function touch() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; if (dirty) persistNow(); }, 800);
    try { if (timer.unref) timer.unref(); } catch { /* ignore */ }
  }

  function ensure(key) {
    let s = db.sessions[key];
    if (!s) {
      s = { key, title: '', createdAt: Date.now(), updatedAt: Date.now(), summary: '', tokens: 0, messages: [], archives: [] };
      db.sessions[key] = s;
      touch();
    }
    if (!Array.isArray(s.messages)) s.messages = [];
    if (!Array.isArray(s.archives)) s.archives = [];
    if (typeof s.tokens !== 'number') s.tokens = 0;
    if (!s.title) s.title = autoTitle(s);
    return s;
  }

  /** 会话标题：用第一条用户消息生成，够直观且不花模型调用。 */
  function autoTitle(s) {
    const first = (s.messages || []).find((m) => m.role === 'user' && m.text);
    if (!first) return s.key;
    const t = String(first.text).replace(/\s+/g, ' ').trim().slice(0, 18);
    return t || s.key;
  }

  return {
    file,
    get(key) { return ensure(key); },
    autoTitle,

    append(key, msg) {
      const s = ensure(key);
      const rec = { at: Date.now(), ...msg };
      s.messages.push(rec);
      if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(-MAX_MESSAGES);
      s.tokens = (s.tokens || 0) + estimateTokens(`${rec.text || ''}`) + 4;
      if (msg.role === 'user') s.title = autoTitle(s);
      s.updatedAt = Date.now();
      touch();
      return s;
    },

    reset(key) {
      const s = ensure(key);
      s.summary = '';
      s.messages = [];
      s.updatedAt = Date.now();
      touch();
      return s;
    },

    newSession(key) {
      const s = ensure(key);
      if (s.messages.length || s.summary) {
        s.archives.push({ at: Date.now(), title: s.title, summary: s.summary || '', messages: s.messages.slice(-20) });
        if (s.archives.length > MAX_ARCHIVES) s.archives = s.archives.slice(-MAX_ARCHIVES);
      }
      s.summary = '';
      s.messages = [];
      s.title = key;
      s.updatedAt = Date.now();
      touch();
      return s;
    },

    setSummary(key, summary) {
      const s = ensure(key);
      s.summary = String(summary || '');
      s.updatedAt = Date.now();
      touch();
      return s;
    },

    rename(key, title) {
      const s = ensure(key);
      s.title = String(title || '').trim().slice(0, 40) || autoTitle(s);
      s.updatedAt = Date.now();
      touch();
      return s;
    },

    remove(key) {
      if (!(key in db.sessions)) return false;
      delete db.sessions[key];
      touch();
      return true;
    },

    list() {
      return Object.keys(db.sessions).map((k) => {
        const s = db.sessions[k];
        return {
          key: k,
          title: s.title || autoTitle(s),
          messages: (s.messages || []).length,
          tokens: s.tokens || 0,
          archives: (s.archives || []).length,
          updatedAt: s.updatedAt || 0,
        };
      }).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    stats() {
      const list = this.list();
      return {
        sessions: list.length,
        messages: list.reduce((n, s) => n + s.messages, 0),
        tokens: list.reduce((n, s) => n + s.tokens, 0),
      };
    },

    history(key, n = 20) {
      const s = db.sessions[key];
      return s ? (s.messages || []).slice(-n) : [];
    },

    // 群聊免 @ 唤醒
    wakeSet(wakeKey) { db.wakes[wakeKey] = Date.now(); touch(); },
    wakeAt(wakeKey) { return Number(db.wakes[wakeKey] || 0); },
    wakeClear(wakeKey) { if (wakeKey in db.wakes) { delete db.wakes[wakeKey]; touch(); } },

    // 黑名单
    isBanned(uid) { return !!(uid && db.bans[String(uid)]); },
    ban(uid, reason) { if (uid) { db.bans[String(uid)] = { at: Date.now(), reason: reason || '' }; touch(); } },
    unban(uid) { if (uid && db.bans[String(uid)]) { delete db.bans[String(uid)]; touch(); } },
    bans() { return Object.keys(db.bans); },

    flush() { if (timer) { clearTimeout(timer); timer = null; } persistNow(); },
  };
}
