// lib/risk.js
// 简单风控：同一会话最小发送间隔 + 每分钟最大回复数，防止机器人刷屏。
// 纯内存状态，零依赖、零外部包。

export function createRateLimiter(config) {
  const lastSent = new Map(); // chatId -> 上次成功发送的时间戳(ms)
  const perMin = new Map(); // chatId -> { windowStart, count }

  const rawInterval = Number(config.messageIntervalLimit);
  const interval = Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : 3000;
  const rawMax = Number(config.maxReplyPerMin);
  const maxPerMin = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 20;

  function rollWindow(rec) {
    const now = Date.now();
    if (now - rec.windowStart > 60000) {
      rec.windowStart = now;
      rec.count = 0;
    }
  }

  return {
    /** 是否允许向该会话发送一条消息（受间隔 + 每分钟上限约束）。 */
    canSend(chatId) {
      const now = Date.now();
      const last = lastSent.get(chatId) || 0;
      if (now - last < interval) return false;
      let rec = perMin.get(chatId);
      if (!rec) {
        rec = { windowStart: now, count: 0 };
        perMin.set(chatId, rec);
      }
      rollWindow(rec);
      return rec.count < maxPerMin;
    },

    /** 发送成功后调用，记录计数（真正放行时再计数，避免误吞）。 */
    markSent(chatId) {
      const now = Date.now();
      lastSent.set(chatId, now);
      let rec = perMin.get(chatId);
      if (!rec) {
        rec = { windowStart: now, count: 0 };
        perMin.set(chatId, rec);
      }
      rollWindow(rec);
      rec.count += 1;
    },
  };
}
