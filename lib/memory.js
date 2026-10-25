// lib/memory.js
// 记忆存储：把每条 QQ 消息追加写入本地 JSONL 文件（默认 $DSH_HOME/napcat-bot/memory），
// 同时在内存中保存每个会话最近的若干条，供回复生成时作为上下文。
// 仅使用 Node 内置模块（fs / path / os），无外部依赖。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function memoryRoot() {
  const base = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'napcat-bot', 'memory')
    : path.join(os.homedir(), '.dsh', 'napcat-bot', 'memory');
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {
    /* 目录不可写时降级为不落盘，但内存缓冲仍可用 */
  }
  return base;
}

function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
}

export function createMemory(config, log) {
  const root = memoryRoot();
  const buffers = new Map(); // chatId -> [{time, role, name, text}]
  const loaded = new Set();
  const MAX_BUF = 30;

  function fileOf(chatId) { return path.join(root, `${sanitize(chatId)}.jsonl`); }

  function append(chatId, record) {
    if (!config.memoryEnabled) return;
    try {
      fs.appendFileSync(fileOf(chatId), JSON.stringify(record) + '\n');
    } catch (e) {
      log.warn(`记忆落盘失败(已忽略): ${e}`);
    }
  }

  /** 首次访问某会话时，从 JSONL 尾部读回最近记录（重启后记忆不丢）。 */
  function ensureLoaded(chatId) {
    if (loaded.has(chatId)) return;
    loaded.add(chatId);
    let buf = buffers.get(chatId);
    if (!buf) { buf = []; buffers.set(chatId, buf); }
    if (buf.length) return;
    try {
      const txt = fs.readFileSync(fileOf(chatId), 'utf8');
      const lines = txt.split(/\r?\n/).filter(Boolean).slice(-MAX_BUF);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (rec && typeof rec === 'object' && rec.text !== undefined) buf.push(rec);
        } catch { /* 跳过坏行 */ }
      }
    } catch { /* 没有历史文件 */ }
  }

  return {
    /** 记录一条消息。role: 'user' | 'assistant' */
    remember(chatId, role, name, text) {
      const rec = {
        time: Date.now(),
        role,
        name: name || '',
        text: text || '',
      };
      ensureLoaded(chatId);
      append(chatId, rec);
      let buf = buffers.get(chatId);
      if (!buf) {
        buf = [];
        buffers.set(chatId, buf);
      }
      buf.push(rec);
      if (buf.length > MAX_BUF) buf.shift();
    },

    /** 取某会话最近的 n 条（用于回复上下文）。 */
    recent(chatId, n = 10) {
      ensureLoaded(chatId);
      const buf = buffers.get(chatId) || [];
      return buf.slice(-n);
    },
  };
}

