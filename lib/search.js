// lib/search.js
// 联网搜索：**零依赖**，优先复用宿主 `ctx.web.search()`（DeepSeek 原生搜索，
// 已由 dsh-base 组合挂载），否则用面板里填的自定义搜索接口。
//
// 触发分两类：
//   ① 手动：「帮我搜 / 搜一下 / 查一下 / 上网查 / 搜索」→ 命中即搜，最高优先级（仅次于强制语音）
//   ② 自动：本地启发式打分（时效 / 现实实体 / 拿不准）→ 可疑时再用一次轻量模型判定
//      闲聊、情绪、玩梗、主观感受、人设对话一律不搜
//
// 一切失败都只返回 { ok:false, error }，绝不抛：上层决定是回兜底话术还是照常聊天。

/** 手动搜索关键词（命中即搜）。 */
const MANUAL_KEYWORDS = [
  '帮我搜一下', '帮我搜', '帮忙搜', '帮我查一下', '帮我查', '帮忙查',
  '搜一下', '搜一搜', '搜索一下', '搜搜看', '搜下', '搜索',
  '查一下', '查一查', '查查', '查下',
  '上网查', '上网搜', '网上查', '网上搜', '百度一下', '谷歌一下',
];

/** 明显不需要联网的闲聊 / 情绪 / 玩梗 / 人设话题（命中直接不搜）。 */
const CHAT_WORDS = [
  '哈哈', '嘿嘿', '嘻嘻', '呜呜', '嘤嘤', '啊啊', '笑死', '好家伙', '离谱', '绝了',
  '想你', '抱抱', '亲亲', '摸摸', '么么', '贴贴', '晚安', '早安', '午安', '睡啦',
  '在吗', '在不在', '你叫什么', '你是谁', '你会什么', '你喜欢', '你可爱', '好可爱',
  '开心', '难过', 'emo', '好累', '好困', '饿', '吃饱', '摸鱼', '划水', '发呆',
  '表情包', '这个梗', '什么梗', '玩梗', '好笑', '搞笑', '好耶', '太好了', '谢谢',
  '加油', '随便', '都行', '没事', '算了', '好呀', '好的', '收到', '嗯嗯', '哦哦',
];

/** 强时效信号：命中即判定要搜。 */
const FRESH_RE = /(今天|明天|昨天|今晚|今早|现在|目前|最新|最近|今年|去年|本月|本周|这周|刚才|刚才|实时)/;
const FRESH_WORDS = [
  '新闻', '头条', '热点', '价格', '多少钱', '票价', '售价', '报价', '汇率', '股价', '金价',
  '油价', '房价', '天气', '气温', '下雨', '几点', '时刻表', '班次', '航班', '高铁', '车次',
  '发售', '开售', '开卖', '上市', '发布会', '上映', '定档', '开播', '更新', '版本号',
  '比赛', '比分', '赛程', '冠军', '排名', '榜单', '政策', '新规', '公告', '通知', '营业时间',
  '限行', '放票', '抢票', '预售', '活动时间', '截止',
];

/** 现实实体 / 参数 / 教程类信号：命中即判定要搜。 */
const ENTITY_WORDS = [
  '在哪', '哪里', '地址', '怎么去', '怎么走', '地铁', '公交', '导航',
  '怎么用', '怎么弄', '怎么做', '如何', '教程', '步骤', '说明书',
  '参数', '配置', '规格', '型号', '性能', '续航', '功耗', '分辨率', '接口',
  '客服', '电话', '官网', '下载', '注册', '安装包', '驱动',
  '是哪一年', '什么时候出', '什么牌子', '哪个牌子', '多少钱一斤',
];

/** 教程/操作类（怎么设置、怎么连、怎么做…）：命中即判定要搜。 */
const HOWTO_RE = /怎么(用|弄|做|设置|设定|调|连|接|开|装|改|配|下载|注册|申请|预约|买|退|换|修|清洗|保养)/;

/** 疑问句形态（弱信号，交给模型二次判定）。 */
const QUESTION_RE = /[?？]|(吗|呢|什么|怎么|为什么|为啥|哪个|哪些|谁|哪儿|多少|是不是|能不能|可不可以)\s*[?？]?$/;

/** 手动搜索时从话里剥掉的多余成分。 */
const STRIP_HEAD = /^(?:你|鱼鱼)?(?:能不能|可不可以|可以|帮我|帮忙|给我|麻烦|请|快)?\s*/;
const STRIP_TAIL = /[\s，,。.!！?？~～]*(?:吧|呗|嘛|啦|哦|啊|呀|呗|谢谢|好不好|可以吗)?[\s，,。.!！?？~～]*$/;

/** 搜索结果缓存：同一句话 10 分钟内不重复请求。 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 40;
/** 单次搜索超时（DeepSeek 原生搜索要走一整轮模型，给足 20 秒）。 */
const TIMEOUT_MS = 20000;
/** 模型判定超时（超时按「不搜」处理，不拖慢回复）。 */
const JUDGE_TIMEOUT_MS = 4500;

const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * 命中手动搜索指令了吗？并把要查的内容抠出来。
 * @param {string} text
 * @returns {{hit:boolean, keyword:string, query:string}}
 */
export function detectManualSearch(text) {
  const raw = String(text || '').trim();
  if (!raw) return { hit: false, keyword: '', query: '' };
  // 长关键词优先匹配（「帮我搜一下」先于「帮我搜」）
  const sorted = [...MANUAL_KEYWORDS].sort((a, b) => b.length - a.length);
  const kw = sorted.find((k) => raw.includes(k));
  if (!kw) return { hit: false, keyword: '', query: '' };
  let rest = raw.slice(raw.indexOf(kw) + kw.length);
  rest = rest.replace(/^[\s：:，,、。.!！?？~～]+/, '');
  rest = rest.replace(STRIP_HEAD, '');
  rest = rest.replace(STRIP_TAIL, '').trim();
  return { hit: true, keyword: kw, query: rest };
}

/** 纯闲聊 / 情绪 / 玩梗：不算「需要查证」。 */
export function isSmallTalk(text, hasImage) {
  const s = String(text || '').trim();
  // 只发图 = 表情包互动，不搜
  if (!s) return true;
  // 去掉标点/表情后不到 4 个字，基本是语气词
  const core = s.replace(/[^\p{L}\p{N}]/gu, '');
  if (core.length <= 3) return true;
  if (CHAT_WORDS.some((w) => s.includes(w))) return true;
  return false;
}

/**
 * 本地判断「这句话值不值得联网查」。
 * @returns {{need:boolean, weak:boolean, reason:string}}
 */
export function assessAutoNeed(text) {
  const s = String(text || '').trim();
  if (!s) return { need: false, weak: false, reason: 'empty' };
  if (isSmallTalk(s)) return { need: false, weak: false, reason: 'smalltalk' };

  const fresh = FRESH_WORDS.find((w) => s.includes(w));
  if (fresh) return { need: true, weak: false, reason: 'fresh:' + fresh };
  if (FRESH_RE.test(s) && /[?？吗呢]/.test(s)) return { need: true, weak: false, reason: 'recent' };

  const entity = ENTITY_WORDS.find((w) => s.includes(w));
  if (entity) return { need: true, weak: false, reason: 'entity:' + entity };

  const howto = HOWTO_RE.exec(s);
  if (howto) return { need: true, weak: false, reason: 'howto:' + howto[0] };

  // 明显在问事实，但本地拿不准 → 交给模型判定
  if (QUESTION_RE.test(s)) return { need: false, weak: true, reason: 'question' };
  return { need: false, weak: false, reason: 'chat' };
}

/** 判定用的提示词：让模型只说一个词。 */
const JUDGE_PROMPT = [
  '判断下面这句话要不要联网查证才能靠谱回答。',
  '要查：时效信息（新闻/价格/时刻/活动/发售/比分）、现实实体资料（地点/物品参数/教程/常识/冷门知识）、你没把握的事实。',
  '不用查：闲聊、情绪陪伴、玩梗、主观感受、人设对话、让对方继续说。',
  '只回一个词：SEARCH 或 CHAT。',
  '消息：',
].join('\n');

/** 把搜索结果拼成给主模型的上下文块。 */
export function buildSearchBlock(sources, query) {
  if (!Array.isArray(sources) || !sources.length) return '';
  const lines = sources.slice(0, 5).map((s, i) => {
    const title = String(s.title || s.name || '').replace(/\s+/g, ' ').slice(0, 80);
    const snip = String(s.snippet || s.content || s.description || s.text || '').replace(/\s+/g, ' ').slice(0, 220);
    const url = String(s.url || s.link || '');
    return `[${i + 1}] ${title || url}${snip ? '：' + snip : ''}${url ? `（${url}）` : ''}`;
  });
  return '【联网搜索结果，回答时优先采用；与搜索结果冲突就以搜索结果为准，不确定就说你不太确定】\n'
    + `（检索词：${String(query || '').slice(0, 60)}）\n`
    + lines.join('\n');
}

/** 搜索失败 / 无结果的兜底台词（需求指定，不要改）。 */
export const SEARCH_FALLBACK = '呜，鱼鱼的小鳍划不动搜索引擎，暂时查不到这个哦';

export function createSearch(config, log, ctx) {
  const cache = new Map();   // query -> { at, result }
  const counts = { manual: 0, auto: 0, ok: 0, fail: 0, skip: 0, judge: 0 };
  let lastAt = 0;
  let last = null;
  // 连续失败就歇一会儿：自动搜索暂停 5 分钟，避免每条消息都撞一次坏后端
  let failStreak = 0;
  let breakerUntil = 0;

  const cfg = () => config || {};

  /** 宿主 ctx.web 服务（DeepSeek 原生搜索）。 */
  function hostWeb() {
    try {
      const w = ctx && typeof ctx.get === 'function' ? ctx.get('web') : null;
      return w && typeof w.search === 'function' ? w : null;
    } catch { return null; }
  }

  function endpoint() {
    return String(cfg().searchEndpoint || '').trim();
  }

  function providerName() {
    if (endpoint()) return 'custom';
    if (hostWeb()) return 'dsh-web';
    return 'none';
  }

  function available() {
    return providerName() !== 'none';
  }

  function maxResults() {
    const n = Number(cfg().searchMaxResults);
    return Number.isFinite(n) && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 5;
  }

  /** 这一轮允许搜吗（总开关 + 会话规则覆盖）。 */
  function enabledFor(rule, kind) {
    if (cfg().searchEnabled === false) return false;
    if (rule && rule.searchEnabled === false) return false;
    if (kind === 'auto') {
      if (cfg().searchAutoEnabled === false) return false;
      if (rule && rule.searchAutoEnabled === false) return false;
    }
    return true;
  }

  /** 自定义接口：兼容 SearXNG / 通用 JSON / 纯文本。 */
  async function viaCustom(query, signal) {
    const raw = endpoint();
    if (!raw) throw Object.assign(new Error('未配置搜索接口'), { code: 'no-endpoint' });
    let url;
    if (raw.includes('{q}')) url = raw.replace('{q}', encodeURIComponent(query));
    else url = raw + (raw.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(query);
    const key = String(cfg().searchApiKey || '').trim();
    const headers = { 'User-Agent': 'DSH-NapCat-Bot' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(url, { headers, signal });
    if (!res.ok) throw Object.assign(new Error('搜索接口 HTTP ' + res.status), { code: 'http' });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 纯文本 */ }
    if (!data) {
      return [{ title: '搜索结果', snippet: String(text).replace(/\s+/g, ' ').slice(0, 600) }];
    }
    const list = Array.isArray(data) ? data
      : (data.results || data.data || data.items || (data.web && data.web.results) || []);
    return (Array.isArray(list) ? list : []).slice(0, maxResults()).map((it) => ({
      title: it.title || it.name || '',
      url: it.url || it.link || it.href || '',
      snippet: it.snippet || it.content || it.description || it.body || it.text || '',
    })).filter((x) => x.title || x.snippet);
  }

  /** 宿主 ctx.web.search。 */
  async function viaHost(query, signal) {
    const web = hostWeb();
    if (!web) throw Object.assign(new Error('宿主未挂载 web 服务'), { code: 'no-provider' });
    const r = await web.search({ query, maxResults: maxResults() }, signal);
    const sources = (r && r.sources) || [];
    return sources.map((s) => ({
      title: s.title || '',
      url: s.url || '',
      snippet: s.snippet || '',
      publishedAt: s.publishedAt || '',
    }));
  }

  /**
   * 真正发一次搜索（带缓存 / 超时 / 永不抛）。
   * @returns {Promise<{ok:boolean, sources:Array, error:string, provider:string, cached:boolean, ms:number}>}
   */
  async function run(query) {
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!q) return { ok: false, sources: [], error: 'empty-query', provider: providerName(), cached: false, ms: 0 };
    const hit = cache.get(q);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }

    const provider = providerName();
    if (provider === 'none') {
      return { ok: false, sources: [], error: 'no-provider', provider, cached: false, ms: 0 };
    }

    const t0 = Date.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, TIMEOUT_MS) : null;
    let sources = [];
    let error = '';
    try {
      sources = provider === 'custom'
        ? await viaCustom(q, controller ? controller.signal : undefined)
        : await viaHost(q, controller ? controller.signal : undefined);
    } catch (e) {
      error = String((e && (e.code || e.message)) || 'error');
    } finally {
      if (timer) clearTimeout(timer);
    }
    const ms = Date.now() - t0;
    const result = { ok: sources.length > 0 && !error, sources: sources.slice(0, maxResults()), error, provider, cached: false, ms };
    lastAt = Date.now();
    last = { q, ...result };
    if (result.ok) {
      counts.ok += 1;
      failStreak = 0;
      breakerUntil = 0;
    } else {
      counts.fail += 1;
      failStreak += 1;
      if (failStreak >= 2) breakerUntil = Date.now() + 5 * 60 * 1000;
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(q, { at: Date.now(), result });
    return result;
  }

  /**
   * 这一轮要不要搜、搜什么。
   * @param {{text:string, hasImage:boolean, rule:object, judge?:Function}} input
   * @returns {Promise<{mode:'off'|'manual'|'auto', query:string, reason:string, forced:boolean}>}
   */
  async function decide(input) {
    const text = String((input && input.text) || '').trim();
    const rule = input && input.rule;
    const hasImage = !!(input && input.hasImage);

    if (!available()) return { mode: 'off', query: '', reason: 'no-provider', forced: false };

    // ① 手动指令：只要开了搜索就执行，不看闲聊词表
    const manual = detectManualSearch(text);
    if (manual.hit && enabledFor(rule, 'manual')) {
      counts.manual += 1;
      const q = manual.query || (hasImage ? text.replace(manual.keyword, '').trim() : '') || text.replace(manual.keyword, '').trim();
      return { mode: 'manual', query: q, reason: 'manual:' + manual.keyword, forced: true };
    }

    // ② 自动：先在本地筛，再让模型确认
    if (!enabledFor(rule, 'auto')) return { mode: 'off', query: '', reason: 'auto-disabled', forced: false };
    // 后端连续失败 → 自动搜索先歇 5 分钟（手动指令不受影响，那时候失败会回兜底话术）
    if (breakerUntil && Date.now() < breakerUntil) {
      counts.skip += 1;
      return { mode: 'off', query: '', reason: 'breaker（搜索后端连续失败，稍后再试）', forced: false };
    }
    if (isSmallTalk(text, hasImage) && !hasImage) return { mode: 'off', query: '', reason: 'smalltalk', forced: false };

    const a = assessAutoNeed(text);
    if (a.need) {
      counts.auto += 1;
      return { mode: 'auto', query: text, reason: 'auto:' + a.reason, forced: false };
    }
    // 带图提问：图本身可能就是「这是啥」，可以交给模型判定
    if (!a.weak && !hasImage) {
      counts.skip += 1;
      return { mode: 'off', query: '', reason: a.reason, forced: false };
    }
    if (cfg().searchAutoJudge === false) {
      counts.skip += 1;
      return { mode: 'off', query: '', reason: (a.reason || 'chat') + '/judge-off', forced: false };
    }
    if (typeof input.judge !== 'function') {
      counts.skip += 1;
      return { mode: 'off', query: '', reason: (a.reason || 'chat') + '/no-judge', forced: false };
    }

    counts.judge += 1;
    let verdict = '';
    try {
      verdict = String(await input.judge(JUDGE_PROMPT + '\n' + text) || '').trim();
    } catch { verdict = ''; }
    if (/SEARCH/i.test(verdict)) {
      counts.auto += 1;
      return { mode: 'auto', query: text, reason: 'judge:' + (a.reason || 'question'), forced: false };
    }
    counts.skip += 1;
    return { mode: 'off', query: '', reason: (a.reason || 'chat') + '/judge-chat', forced: false };
  }

  function status() {
    return {
      enabled: cfg().searchEnabled !== false,
      auto: cfg().searchAutoEnabled !== false,
      judge: cfg().searchAutoJudge !== false,
      provider: providerName(),
      available: available(),
      endpoint: endpoint(),
      manual: counts.manual,
      autoCount: counts.auto,
      ok: counts.ok,
      fail: counts.fail,
      skip: counts.skip,
      judgeCount: counts.judge,
      failStreak,
      breaker: !!(breakerUntil && Date.now() < breakerUntil),
      lastAt,
      last,
      cache: cache.size,
    };
  }

  return { available, providerName, enabledFor, decide, run, status, buildBlock: buildSearchBlock };
}
