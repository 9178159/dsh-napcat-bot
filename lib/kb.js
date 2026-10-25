// lib/kb.js
// 轻量知识库（零依赖）：BM25 + 向量余弦 混合检索，针对中文做了 bigram 切分。
//
// 说明：不引入外部向量库/embedding 服务。向量部分用「字符 bigram 哈希到固定维度」
// 的稀疏向量做余弦相似度，配合 BM25 分数加权融合，中文短查询效果够用且完全离线。
//
// 存储：<dataDir>/kb.json —— { kbs: [{ id, name, docs: [{ id, title, text, at }] }] }

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIM = 512;
const K1 = 1.5;
const B = 0.75;

function dataDir() {
  const base = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'napcat-bot')
    : path.join(os.homedir(), '.dsh', 'napcat-bot');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
  return base;
}

/** 中英混排分词：英文/数字按词，中文按字符 bigram（单字也保留）。 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  const latin = s.match(/[a-z0-9_]+/g) || [];
  out.push(...latin);
  const han = s.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const seg of han.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) { out.push(seg); continue; }
    for (let i = 0; i < seg.length - 1; i += 1) out.push(seg.slice(i, i + 2));
  }
  return out;
}

function hashToken(t) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i += 1) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % DIM;
}

function vecOf(tokens) {
  const v = new Float32Array(DIM);
  for (const t of tokens) v[hashToken(t)] += 1;
  let norm = 0;
  for (let i = 0; i < DIM; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i += 1) v[i] /= norm;
  return v;
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i += 1) s += a[i] * b[i];
  return s;
}

export function createKb(log) {
  const file = path.join(dataDir(), 'kb.json');
  let db = null;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = null; }
  if (!db || !Array.isArray(db.kbs)) db = { kbs: [] };

  let timer = null;
  function persist() {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file);
    } catch (e) { try { log && log.warn && log.warn(`[kb] 落盘失败: ${e}`); } catch { /* ignore */ } }
  }
  function touch() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; persist(); }, 500);
    try { if (timer.unref) timer.unref(); } catch { /* ignore */ }
  }

  // 索引缓存：kbId → { docs: [{vec, tf, len}], df, avgLen, n }
  const cache = new Map();
  function index(kb) {
    let idx = cache.get(kb.id);
    if (idx) return idx;
    const docs = [];
    const df = new Map();
    let total = 0;
    for (const d of kb.docs) {
      const tokens = tokenize(`${d.title}\n${d.text}`);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      docs.push({ id: d.id, title: d.title, text: d.text, tf, len: tokens.length, vec: vecOf(tokens) });
      total += tokens.length;
    }
    idx = { docs, df, avgLen: docs.length ? total / docs.length : 1, n: docs.length };
    cache.set(kb.id, idx);
    return idx;
  }
  function invalidate(kbId) { cache.delete(kbId); }

  function idOf(p) { return `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

  return {
    list() {
      return db.kbs.map((k) => ({ id: k.id, name: k.name, docs: k.docs.length, at: k.at }));
    },
    create(name) {
      const kb = { id: idOf('kb'), name: String(name || '未命名知识库'), docs: [], at: Date.now() };
      db.kbs.push(kb); touch(); return { id: kb.id, name: kb.name, docs: 0 };
    },
    remove(id) {
      const i = db.kbs.findIndex((k) => k.id === id);
      if (i < 0) return false;
      db.kbs.splice(i, 1); invalidate(id); touch(); return true;
    },
    addDoc(kbId, doc) {
      const kb = db.kbs.find((k) => k.id === kbId);
      if (!kb) return null;
      const text = String((doc && doc.text) || '').trim();
      if (!text) return null;
      const rec = { id: idOf('doc'), title: String((doc && doc.title) || '片段'), text: text.slice(0, 20000), at: Date.now() };
      kb.docs.push(rec);
      if (kb.docs.length > 500) kb.docs = kb.docs.slice(-500);
      invalidate(kbId); touch();
      return { id: rec.id, title: rec.title, chars: rec.text.length };
    },
    removeDoc(kbId, docId) {
      const kb = db.kbs.find((k) => k.id === kbId);
      if (!kb) return false;
      const before = kb.docs.length;
      kb.docs = kb.docs.filter((d) => d.id !== docId);
      invalidate(kbId); touch();
      return kb.docs.length !== before;
    },
    docs(kbId) {
      const kb = db.kbs.find((k) => k.id === kbId);
      return kb ? kb.docs.map((d) => ({ id: d.id, title: d.title, chars: d.text.length, at: d.at })) : [];
    },

    /**
     * 混合检索：score = 0.65 * BM25(归一化) + 0.35 * cosine。
     * @returns [{ title, text, score, kbName }]
     */
    search(query, kbIds, topK = 4) {
      const qTokens = tokenize(query);
      if (!qTokens.length) return [];
      const qv = vecOf(qTokens);
      const targets = (kbIds && kbIds.length ? db.kbs.filter((k) => kbIds.includes(k.id)) : db.kbs);
      const hits = [];
      for (const kb of targets) {
        const idx = index(kb);
        const maxBm = Math.max(1, idx.n);
        for (const d of idx.docs) {
          let bm = 0;
          for (const t of new Set(qTokens)) {
            const f = d.tf.get(t);
            if (!f) continue;
            const df = idx.df.get(t) || 0;
            const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
            bm += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / idx.avgLen)));
          }
          const bmNorm = Math.min(1, bm / maxBm);
          const cos = cosine(qv, d.vec);
          const score = 0.65 * bmNorm + 0.35 * cos;
          if (score > 0.02) hits.push({ title: d.title, text: d.text, score, kbName: kb.name });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, topK);
    },

    flush() { if (timer) { clearTimeout(timer); timer = null; } persist(); },
  };
}
