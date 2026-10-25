// lib/dedupe.js
// 消息去重（零依赖、跨实例共享）。
//
// 为什么会重复：
//   · NapCat 在适配器热重载 / 重新登录后，会把同一批未确认事件再推一遍；
//   · 插件若被宿主重复加载（apply 跑两次），会有两条 WS 连接各回一次，
//     于是用户收到两条**一模一样**的回复；
//   · 某些版本 `enableForcePushEvent` 下同一 message_id 会带两个上报。
//
// 策略（双保险）：
//   1. 主键：`message_id`（+ group_id / user_id），命中即丢弃；
//   2. 副键：内容指纹 `message_type|user_id|group_id|原文`，只用于 1.5s 内的
//      「同一个人、同样内容」二次投递（防止 message_id 变了但其实是同一条）。
//
// 状态挂在 globalThis 上，这样即使插件被加载两次，也只有一份 seen 集合。

const GLOBAL_KEY = Symbol.for('dsh-napcat-bot.dedupe');

function store() {
  let s = globalThis[GLOBAL_KEY];
  if (!s) {
    s = { ids: new Map(), prints: new Map() };
    globalThis[GLOBAL_KEY] = s;
  }
  return s;
}

function prune(map, ttlMs, maxSize) {
  const now = Date.now();
  for (const [k, t] of map) {
    if (now - t > ttlMs) map.delete(k);
  }
  // 兜底：TTL 内也不要无限增长
  if (map.size > maxSize) {
    const over = map.size - maxSize;
    let i = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++i >= over) break;
    }
  }
}

export function resetDedupe() {
  try { const s = store(); s.ids.clear(); s.prints.clear(); } catch { /* ignore */ }
}

/**
 * 判断一条事件是否应当被丢弃（重复投递）。
 * @param {object} ev OneBot 事件
 * @param {{ttlMs?:number, printWindowMs?:number}} opts
 * @returns {{duplicate:boolean, reason?:string, key?:string}}
 */
export function isDuplicateEvent(ev, opts = {}) {
  if (!ev || typeof ev !== 'object') return { duplicate: false };
  const ttlMs = Number(opts.ttlMs) || 120000;      // message_id 记忆 2 分钟
  const printWindowMs = Number(opts.printWindowMs) || 1500;
  const s = store();
  const now = Date.now();

  const rawId = ev.message_id != null ? String(ev.message_id)
    : (ev.message_seq != null ? 'seq' + String(ev.message_seq) : '');
  const scope = `${ev.message_type || ''}|${ev.group_id != null ? ev.group_id : ''}|${ev.user_id != null ? ev.user_id : ''}`;

  if (rawId) {
    const key = `${scope}#${rawId}`;
    if (s.ids.has(key)) return { duplicate: true, reason: 'message_id', key };
    s.ids.set(key, now);
    prune(s.ids, ttlMs, 3000);
  }

  // 内容指纹（仅在短窗口内生效）
  const text = typeof ev.raw_message === 'string'
    ? ev.raw_message
    : (typeof ev.message === 'string' ? ev.message : JSON.stringify(ev.message || ''));
  if (text) {
    const print = `${scope}|${text}`;
    const seenAt = s.prints.get(print);
    if (seenAt && now - seenAt < printWindowMs) {
      return { duplicate: true, reason: 'same-content', key: print };
    }
    s.prints.set(print, now);
    prune(s.prints, Math.max(printWindowMs * 4, 6000), 2000);
  }

  return { duplicate: false, key: rawId ? `${scope}#${rawId}` : undefined };
}
