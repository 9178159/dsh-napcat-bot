// lib/proactive.js
// 空闲「随缘」主动发言调度（零依赖）。
//
// 和上一版的区别：**没有固定倒计时，也没有每日次数上限**。
// 对话安静下来之后，每隔一小段时间（20~45 秒，带抖动）做一次「心情判定」：
//   · 冷却没过 / 正在回复 / 你刚说完晚安 → 直接跳过，不打扰；
//   · 过了冷却 → 掷骰子：命中就来找你，没命中就过一会儿再想（概率每次不同，模拟心情）。
// 发出去一条之后强制进入冷却，冷却期内绝对不会再触发；冷却过完如果还是没人说话，
// 它会继续随缘判定 —— 所以可能一晚上找你两三次，也可能一整天都懒得开口。
//
// 只负责「什么时候开口」，不负责说什么：到点回调 onFire(meta)，由 pipeline
// 用主模型 + 面板人设 + 上下文记忆生成那句话。

/** 收尾语句：命中就暂停随机触发（直到你重新开口）。 */
export const FAREWELL_RE = new RegExp([
  '再见', '拜拜', 'byebye', 'bye bye', '\\bbye\\b', '886', 'see you',
  '晚安', '睡了', '睡觉了', '去睡', '先睡', '要睡了', '困了先去睡',
  '不聊了', '不说了', '先不聊', '回头聊', '改天聊', '下次聊', '明天聊',
  '去忙了', '忙去了', '我去忙', '先这样', '我走了', '下线了', '溜了', '撤了',
  '晚点再说', '稍后聊', '先撤', '先走了',
].join('|'), 'i');

/** 纯表情/标点不当作「聊完了」。 */
const ONLY_EMOJI_RE = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}~～…\.。!！?？、,，]+$/u;

/**
 * 是否属于「收尾语句」。
 * 判定收紧，避免误伤：
 *   · 疑问句（…吗 / …呢 / 带问号）不算告别（「你睡了吗」不是「我睡了」）；
 *   · 告别词要出现在结尾附近（长段落中间提一句「再见」不算）。
 * @param {string} text
 * @returns {boolean}
 */
export function isFarewell(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (s.length > 60) return false;
  if (/[?？]\s*$/.test(s)) return false;
  if (/(吗|呢|么|嘛)\s*$/.test(s)) return false;
  const tail = s.length <= 12 ? s : s.slice(-12);
  return FAREWELL_RE.test(tail);
}

const MIN_SEC = 60;
const MAX_SEC = 1800;
const DEFAULT_SEC = 180;

/** 冷却秒数：夹在 60~1800，非法值回默认 180。 */
export function clampCooldownSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SEC;
  return Math.round(Math.min(MAX_SEC, Math.max(MIN_SEC, n)));
}

/** 两次「心情判定」之间的间隔（带抖动，别像打卡）。 */
const CHECK_MIN_MS = 20000;
const CHECK_MAX_MS = 45000;

/**
 * 每次判定的命中概率：多数时候淡淡的，偶尔特别想说话。
 * 先抽档位再抽是否命中 —— 所以节奏天然不均匀。
 */
const MOOD_TIERS = [
  { w: 0.12, p: 0.45 },   // 忽然很想你
  { w: 0.43, p: 0.18 },   // 一般般
  { w: 0.45, p: 0.07 },   // 懒得开口
];

export function createProactive(opts) {
  const { config, log, getRule, onFire, isBusy } = opts;
  let rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  let nowFn = typeof opts.now === 'function' ? opts.now : Date.now;

  const timers = new Map();     // key -> timeout id
  const metas = new Map();      // key -> meta（最后一次消息上下文）
  const lastFireAt = new Map(); // key -> 上次主动发言时间（冷却起点）
  const counters = { fired: 0, skipped: 0, paused: 0, checks: 0 };
  let last = null;

  const now = () => Number(nowFn());

  function cooldownMs() { return clampCooldownSec(config && config.proactiveCooldownSec) * 1000; }

  /** 该会话要不要主动：规则 > 群聊开关 > 总开关。 */
  function enabledFor(rule, isGroup) {
    if (rule && rule.proactiveEnabled === true) return true;
    if (rule && rule.proactiveEnabled === false) return false;
    if (isGroup) return !!(config && config.proactiveInGroup === true);
    return !(config && config.proactiveEnabled === false);
  }

  function logLine(evt, key, detail) {
    try {
      log && log.info && log.info(`[napcat] 主动发言 ${evt} · ${key}${detail ? ' · ' + detail : ''}`);
    } catch { /* ignore */ }
  }

  function clearTimer(key) {
    const t = timers.get(key);
    if (t) { try { clearTimeout(t); } catch { /* ignore */ } }
    timers.delete(key);
  }

  function schedule(key, ms) {
    const meta = metas.get(key);
    if (!meta || meta.paused) return false;
    const rule = getRule ? getRule(meta) : null;
    if (!enabledFor(rule, meta.channel && meta.channel.type === 'group')) return false;
    clearTimer(key);
    const delay = Math.max(3000, Number(ms) || (CHECK_MIN_MS + rng() * (CHECK_MAX_MS - CHECK_MIN_MS)));
    const timer = setTimeout(() => { timers.delete(key); return check(key, false); }, delay);
    try { if (timer.unref) timer.unref(); } catch { /* ignore */ }
    timers.set(key, timer);
    return true;
  }

  /** 距离「可以开始随缘判定」还差多久（0 = 已经过冷却）。 */
  function waitLeft(meta) {
    const cd = cooldownMs();
    const lastMsg = Math.max(Number(meta.at) || 0, Number(meta.lastBotAt) || 0);
    const lastFire = Number(lastFireAt.get(meta.sessionKey)) || 0;
    const need = Math.max(lastMsg, lastFire) + cd;
    return Math.max(0, need - now());
  }

  /** 用户发言：记录上下文，解除「告别暂停」，重新开始随缘判定。 */
  function noteUser(meta) {
    const key = meta && meta.sessionKey;
    if (!key) return;
    const text = String(meta.text || '');
    const prev = metas.get(key) || {};
    metas.set(key, { ...prev, ...meta, at: now(), paused: false });
    clearTimer(key);

    if (text.startsWith('/')) { logLine('暂停', key, '指令消息，暂不判定'); return; }
    if (ONLY_EMOJI_RE.test(text)) return;
    if (isFarewell(text)) {
      metas.get(key).paused = true;
      counters.paused += 1;
      logLine('停表', key, `收尾语句「${text.slice(0, 20)}」，暂停主动，等你再开口`);
      return;
    }
    const left = waitLeft(metas.get(key));
    schedule(key, left > 0 ? left + 500 : undefined);
    logLine('待机', key, `冷却 ${Math.round(cooldownMs() / 1000)} 秒后开始随缘判定`);
  }

  /** 机器人说完话：对话重新安静下来，从这一刻开始计冷却。 */
  function noteBot(key) {
    const meta = metas.get(key);
    if (!meta) return false;
    meta.lastBotAt = now();
    if (meta.paused) return false;
    const left = waitLeft(meta);
    return schedule(key, left > 0 ? left + 500 : undefined);
  }

  /** 抽一个「心情命中概率」。 */
  function moodChance() {
    const r = rng();
    let acc = 0;
    for (const tier of MOOD_TIERS) {
      acc += tier.w;
      if (r <= acc) return tier.p;
    }
    return MOOD_TIERS[MOOD_TIERS.length - 1].p;
  }

  /**
   * 一次判定（定时器到点会调它；也可以手动调用调试 / 测试）。
   * 注意：**冷却永远生效**，没有任何调试后门能绕过它，避免线上被误触发。
   * @param {string} key
   */
  async function check(key) {
    const meta = metas.get(key);
    if (!meta) return;
    if (meta.paused) return;                       // 告别后暂停，等你重新开口
    const rule = getRule ? getRule(meta) : null;
    if (!enabledFor(rule, meta.channel && meta.channel.type === 'group')) return;
    if (typeof isBusy === 'function' && isBusy(key)) {
      schedule(key, CHECK_MIN_MS);
      return;
    }

    counters.checks += 1;
    const left = waitLeft(meta);
    if (left > 0) {
      schedule(key, Math.min(CHECK_MAX_MS, left + 500));
      return;
    }

    const chance = moodChance();
    const roll = rng();
    if (roll >= chance) {
      counters.skipped += 1;
      schedule(key);                                // 没心情，过一会儿再想
      return;
    }

    const idleFor = now() - Math.max(Number(meta.at) || 0, Number(meta.lastBotAt) || 0);
    let sent = false;
    try {
      sent = await onFire({
        ...meta,
        rule,
        idleFor,
        cooldownSec: Math.round(cooldownMs() / 1000),
        chance,
        roll,
      });
    } catch (e) {
      counters.skipped += 1;
      logLine('失败', key, `生成/发送异常：${(e && e.message) || e}`);
      schedule(key);
      return;
    }
    last = {
      at: now(), sessionKey: key, sent: !!sent, idleFor,
      chance: Number(chance.toFixed(2)), roll: Number(roll.toFixed(2)),
    };
    if (sent) {
      lastFireAt.set(key, now());                   // 强制进入冷却
      counters.fired += 1;
      logLine('触发', key,
        `空闲 ${fmt(idleFor)} · 心情命中 p=${chance.toFixed(2)} roll=${roll.toFixed(2)} · 已进入 ${Math.round(cooldownMs() / 1000)} 秒冷却`);
      schedule(key);                                // 冷却过完继续随缘判定（不设次数上限）
    } else {
      counters.skipped += 1;
      logLine('跳过', key, '本轮没有可说的内容（保持安静，不刷屏）');
      schedule(key);
    }
  }

  function fmt(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}秒`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}分${r}秒` : `${m}分钟`;
  }

  function cancel(key, reason) {
    clearTimer(key);
    const meta = metas.get(key);
    if (meta) meta.paused = true;
    logLine('取消', key, reason || '手动取消');
  }

  function stopAll() {
    for (const key of Array.from(timers.keys())) clearTimer(key);
    metas.clear();
    lastFireAt.clear();
  }

  /** 调试 / 测试：替换随机源与时钟。 */
  function setRng(fn) { if (typeof fn === 'function') rng = fn; }
  function setNow(fn) { if (typeof fn === 'function') nowFn = fn; }

  /** 面板展示。 */
  function status() {
    let nextAt = 0;
    for (const key of timers.keys()) {
      const meta = metas.get(key);
      if (!meta) continue;
      const due = now() + waitLeft(meta);
      if (!nextAt || due < nextAt) nextAt = due;
    }
    return {
      enabled: !(config && config.proactiveEnabled === false),
      groupEnabled: !!(config && config.proactiveInGroup === true),
      cooldownSec: Math.round(cooldownMs() / 1000),
      pending: timers.size,
      nextInSec: nextAt ? Math.max(0, Math.round((nextAt - now()) / 1000)) : 0,
      firedCount: counters.fired,
      skippedCount: counters.skipped,
      pausedCount: counters.paused,
      checks: counters.checks,
      last,
    };
  }

  return {
    noteUser, noteBot, check, cancel, stopAll, status,
    enabledFor, cooldownSeconds: () => Math.round(cooldownMs() / 1000),
    setRng, setNow, timers,
  };
}
