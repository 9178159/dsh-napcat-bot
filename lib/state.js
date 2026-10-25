// lib/state.js
// 统一持久化状态：人格库 / 自定义规则 / 定时任务 / 管理员。
// 全部落在插件本地目录（<DSH_HOME>/napcat-bot/state.json），零依赖、无外部数据库。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function dataDir() {
  const base = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'napcat-bot')
    : path.join(os.homedir(), '.dsh', 'napcat-bot');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
  return base;
}

const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function createState(log) {
  const file = path.join(dataDir(), 'state.json');
  let db = null;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = null; }
  if (!db || typeof db !== 'object') db = {};
  db.personas = Array.isArray(db.personas) ? db.personas : [];
  db.rules = Array.isArray(db.rules) ? db.rules : [];
  db.tasks = Array.isArray(db.tasks) ? db.tasks : [];
  db.admins = Array.isArray(db.admins) ? db.admins : [];
  db.globalPersonaId = db.globalPersonaId || '';

  let timer = null;
  let dirty = false;
  function persist() {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (e) { try { log && log.warn && log.warn(`[state] 落盘失败: ${e}`); } catch { /* ignore */ } }
  }
  function touch() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; if (dirty) persist(); }, 600);
    try { if (timer.unref) timer.unref(); } catch { /* ignore */ }
  }

  // ── 人格 ──────────────────────────────────────────────────────────────
  const personaApi = {
    list() { return db.personas.map((p) => ({ ...p })); },
    get(id) { return db.personas.find((p) => p.id === id) || null; },
    /** 新建或更新人格（id 为空则新建）。 */
    upsert(input) {
      const data = input && typeof input === 'object' ? input : {};
      const id = String(data.id || '').trim();
      const name = String(data.name || '').trim() || '未命名人格';
      const prompt = String(data.prompt || '');
      if (id) {
        const p = db.personas.find((x) => x.id === id);
        if (p) { p.name = name; p.prompt = prompt; p.updatedAt = Date.now(); touch(); return { ...p }; }
      }
      const created = { id: uid('per'), name, prompt, createdAt: Date.now(), updatedAt: Date.now() };
      db.personas.push(created);
      if (!db.globalPersonaId) db.globalPersonaId = created.id;
      touch();
      return { ...created };
    },
    remove(id) {
      const i = db.personas.findIndex((p) => p.id === id);
      if (i < 0) return false;
      db.personas.splice(i, 1);
      if (db.globalPersonaId === id) db.globalPersonaId = (db.personas[0] || {}).id || '';
      for (const r of db.rules) if (r.personaId === id) r.personaId = '';
      touch();
      return true;
    },
    getGlobalId() { return db.globalPersonaId || ''; },
    setGlobal(id) {
      if (id && !db.personas.some((p) => p.id === id)) return false;
      db.globalPersonaId = id || '';
      touch();
      return true;
    },
    /** 变量占位符替换：{{bot_name}} {{group_id}} {{user_id}} {{time}} */
    render(text, vars) {
      return String(text || '').replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (m, k) => {
        const v = vars && vars[k];
        return v == null ? m : String(v);
      });
    },
  };

  // ── 自定义规则（按会话绑定，优先级高于全局）───────────────────────────
  const ruleApi = {
    list() { return db.rules.map((r) => ({ ...r })); },
    /**
     * 匹配规则：scope 形如 `group:777` / `group:*` / `private:12345` / `*`。
     * 越精确越优先。
     */
    match(sessionKey, gid, uidStr) {
      const cands = [`private:${uidStr}`, `group:${gid}:${uidStr}`, `group:${gid}`, 'group:*', `private:*`, '*'];
      const hit = db.rules.filter((r) => r.enabled !== false && cands.includes(String(r.scope || '')));
      if (!hit.length) return null;
      hit.sort((a, b) => cands.indexOf(String(a.scope)) - cands.indexOf(String(b.scope)));
      return { ...hit[0] };
    },
    upsert(input) {
      const data = input && typeof input === 'object' ? input : {};
      const id = String(data.id || '').trim();
      const rec = {
        scope: String(data.scope || '*').trim() || '*',
        llmEnabled: data.llmEnabled !== false,
        ttsEnabled: !!data.ttsEnabled,
        // 识图按会话覆盖：null = 跟随全局；true 强制开；false 强制关
        visionEnabled: data.visionEnabled === true ? true : (data.visionEnabled === false ? false : null),
        // 主动发言按会话覆盖：null = 跟随全局（群聊默认关）；true/false = 本会话强制
        proactiveEnabled: data.proactiveEnabled === true ? true : (data.proactiveEnabled === false ? false : null),
        // 联网搜索按会话覆盖：null = 跟随全局；false = 本会话不搜（手动/自动都关）
        searchEnabled: data.searchEnabled === true ? true : (data.searchEnabled === false ? false : null),
        searchAutoEnabled: data.searchAutoEnabled === true ? true : (data.searchAutoEnabled === false ? false : null),
        // 语音按会话覆盖：ttsMode 为空 = 跟随全局；否则 off/all/keyword/random
        ttsMode: ['off', 'all', 'keyword', 'random'].includes(String(data.ttsMode || '')) ? String(data.ttsMode) : '',
        // -1 或空 = 跟随全局概率
        ttsProbability: data.ttsProbability === '' || data.ttsProbability == null
          ? -1
          : Math.min(100, Math.max(0, Number(data.ttsProbability) || 0)),
        // null = 跟随全局；true/false = 本会话强制
        ttsVoiceRandom: data.ttsVoiceRandom === true ? true : (data.ttsVoiceRandom === false ? false : null),
        personaId: String(data.personaId || ''),
        personaText: String(data.personaText || ''),
        provider: String(data.provider || ''),
        model: String(data.model || ''),
        kbEnabled: data.kbEnabled !== false,
        kbIds: Array.isArray(data.kbIds) ? data.kbIds.map(String) : [],
        enabled: data.enabled !== false,
        note: String(data.note || ''),
      };
      if (id) {
        const r = db.rules.find((x) => x.id === id);
        if (r) { Object.assign(r, rec, { updatedAt: Date.now() }); touch(); return { ...r }; }
      }
      const created = { id: uid('rule'), createdAt: Date.now(), updatedAt: Date.now(), ...rec };
      db.rules.push(created);
      touch();
      return { ...created };
    },
    remove(id) {
      const i = db.rules.findIndex((r) => r.id === id);
      if (i < 0) return false;
      db.rules.splice(i, 1); touch(); return true;
    },
  };

  // ── 定时任务 ──────────────────────────────────────────────────────────
  const taskApi = {
    list() { return db.tasks.map((t) => ({ ...t })); },
    add(input) {
      const d = input && typeof input === 'object' ? input : {};
      const target = String(d.target || '').trim(); // group:777 / private:12345
      if (!target) return null;
      const everySec = Math.max(30, Number(d.everySec) || 0);
      const at = Number(d.at) || 0;
      const t = {
        id: uid('task'),
        name: String(d.name || '').trim() || (everySec ? `每 ${everySec}s` : '一次性'),
        target,
        prompt: String(d.prompt || '').trim(),
        everySec: everySec || 0,
        at: at || 0,
        nextRunAt: everySec ? Date.now() + everySec * 1000 : (at || 0),
        enabled: d.enabled !== false,
        createdAt: Date.now(),
        lastRunAt: 0,
        lastError: '',
      };
      db.tasks.push(t); touch(); return { ...t };
    },
    update(id, patch) {
      const t = db.tasks.find((x) => x.id === id);
      if (!t) return null;
      Object.assign(t, patch || {});
      if (patch && patch.resetNext !== undefined) delete t.resetNext;
      touch();
      return { ...t };
    },
    remove(id) {
      const i = db.tasks.findIndex((t) => t.id === id);
      if (i < 0) return false;
      db.tasks.splice(i, 1); touch(); return true;
    },
    /** 返回到期任务并推进 nextRunAt（一次性任务执行后自动禁用）。 */
    due(now = Date.now()) {
      const out = [];
      for (const t of db.tasks) {
        if (t.enabled === false) continue;
        if (!t.nextRunAt || t.nextRunAt > now) continue;
        out.push({ ...t });
        t.lastRunAt = now;
        if (t.everySec) t.nextRunAt = now + t.everySec * 1000;
        else { t.nextRunAt = 0; t.enabled = false; }
      }
      if (out.length) touch();
      return out;
    },
  };

  // ── 管理员 ────────────────────────────────────────────────────────────
  const adminApi = {
    list() { return db.admins.slice(); },
    add(qq) { const s = String(qq || '').trim(); if (s && !db.admins.includes(s)) { db.admins.push(s); touch(); } return db.admins.slice(); },
    remove(qq) { const s = String(qq || '').trim(); const i = db.admins.indexOf(s); if (i >= 0) { db.admins.splice(i, 1); touch(); } return db.admins.slice(); },
    has(qq) { return db.admins.includes(String(qq || '').trim()); },
  };

  return {
    file,
    personas: personaApi,
    rules: ruleApi,
    tasks: taskApi,
    admins: adminApi,
    flush() { if (timer) { clearTimeout(timer); timer = null; } persist(); },
  };
}
