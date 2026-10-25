// lib/vision.js
// 识图（原生多模态）：不再单独配置识图接口 / API Key / 识图模型。
//
// 原理：当前主模型 DeepSeek-V4.1-Flash 自带视觉能力（DSH 的模型目录里
// `inputModalities: ['text','image']`），所以图片和文本走**同一次请求**：
//
//   NapCat 推来图片 → 拿直链 → 下载字节 → 存进 DSH 附件库拿 ImageAttachmentRef
//   → 组进 user 消息 [{type:'text'}, {type:'image', attachment}] → 主模型
//
// 图片进入 DSH 的唯一正确姿势就是附件引用：宿主适配器会对每个
// `{type:'image', attachment}` 调 `attachments.readImageRequest()` 生成请求版本，
// 再把 base64 发给 provider。直接塞 url 会被适配器判为不支持的块导致整条请求失败。
//
// 这里只负责「把 QQ 的图片变成可用的附件引用」，不负责说话：
// 说话仍由主模型 + 面板人设完成。
//
// 兜底：关闭 / 下载失败 / 入库失败 / 类型不支持 / 模型请求失败 → 返回空 refs，
// 由上层换成人设台词（VISION_FALLBACK），插件绝不崩、绝不刷屏报错。

/** 看不清时的固定人设台词（需求指定，不要改）。 */
export const VISION_FALLBACK = '呜…有点糊糊的，鱼鱼眼睛小，得凑很近才看得清一点点。要不你讲讲图里是啥？我慢慢听～';

/**
 * 默认模式（没下指令）：**只解读梗和意图，禁止报画面**。
 * 图在模型眼前，但它要做的是「接梗互动」，不是「看图汇报」。
 */
export const DEFAULT_VISION_PROMPT = '看懂这张图的梗和情绪，顺着对方的话接梗互动，不要描述画面';

/** 明确要求「描述画面」时才用的提示词：客观、具体。 */
export const DESCRIBE_PROMPT = '客观描述图片里的元素、角色、文字细节';

/**
 * 命中这些说法 = 对方要你**描述画面**（否则一律当表情包接梗）。
 * 只收「明确针对图片内容」的说法，避免「你长啥样」这种误伤。
 */
export const DESCRIBE_KEYWORDS = [
  '描述一下这张图', '描述下这张图', '描述一下这图', '描述下这图',
  '描述一下图片', '描述下图片', '描述一下这个图', '描述图片',
  '说说图片里面有什么', '说说图片里有什么', '说说图里有什么', '说说图里面有什么',
  '图片里面有什么', '图片里有什么', '图里面有什么', '图里有什么',
  '图里都有什么', '图里都有啥', '图片里有啥', '图里有啥', '图里是什么',
  '图里长啥样', '图片长啥样', '画面长啥样', '这图长啥样',
  '详细讲讲画面', '讲讲画面', '说说画面', '描述画面', '画面细节', '画面里有啥',
];

/**
 * 这一轮是不是「明确要求描述画面」。
 * 优先级最高：命中才允许输出画面细节，否则只解读意图、玩梗互动。
 * @param {string} text 用户这一轮说的话
 * @returns {{hit:boolean, keyword:string}}
 */
export function detectDescribeIntent(text) {
  const s = String(text || '');
  if (!s) return { hit: false, keyword: '' };
  const hit = DESCRIBE_KEYWORDS.find((k) => s.includes(k));
  return { hit: !!hit, keyword: hit || '' };
}

/** 历史版本的默认提示词（迁移时用来判断「用户没改过」）。 */
export const LEGACY_VISION_PROMPTS = ['简单描述', '简短描述这张图片内容', '简短描述图片内容，不要冗长', '描述这张图片，简短一点'];

/** 单轮最多带几张图（多了浪费上下文，QQ 常见是一张）。 */
const MAX_IMAGES = 2;
/** 单张图片字节上限。 */
const MAX_BYTES = 8 * 1024 * 1024;
/** 下载超时。 */
const DL_TIMEOUT_MS = 12000;
/** 同类失败日志最小间隔，避免刷屏。 */
const LOG_THROTTLE_MS = 30000;

/** 宿主附件库接受的图片类型。 */
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const isHttp = (s) => /^https?:\/\//i.test(String(s || ''));

/**
 * 按文件头嗅探图片类型（宿主附件库要求 mediaType 与字节一致）。
 * @param {Uint8Array} buf
 * @returns {string} 形如 image/png；认不出来返回空串
 */
export function sniffImageType(buf) {
  const b = buf || new Uint8Array(0);
  if (b.length < 12) return '';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  // WEBP: "RIFF"...."WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return '';
}

/** data:image/png;base64,xxx → { mediaType, data } */
function parseDataUri(s) {
  const m = String(s || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!m) return null;
  const mediaType = String(m[1] || '').toLowerCase();
  const body = m[3] || '';
  const buf = m[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'binary');
  return { mediaType, data: new Uint8Array(buf) };
}

export function createVision(config, log, nap, ctx) {
  const warned = new Map();
  let last = null;
  const counts = { ok: 0, fail: 0 };

  function cfg() { return config || {}; }

  /** 同类原因 30 秒内只写一条日志（不刷屏）。 */
  function logOnce(reason, detail) {
    const k = String(reason || 'unknown');
    const now = Date.now();
    const prev = warned.get(k) || 0;
    if (now - prev < LOG_THROTTLE_MS) return;
    warned.set(k, now);
    try { log.warn(`[napcat] 识图 ${k}${detail ? '：' + detail : ''}`); } catch { /* ignore */ }
  }

  /** 宿主附件库（ctx.attachments）；不可用时返回 null。 */
  function attachments() {
    try {
      const a = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
      return a && typeof a.saveImage === 'function' ? a : null;
    } catch { return null; }
  }

  /** 本会话是否启用识图：规则覆盖 > 全局开关。 */
  function enabledFor(rule) {
    if (rule && rule.visionEnabled === true) return true;
    if (rule && rule.visionEnabled === false) return false;
    return cfg().visionEnabled !== false;
  }

  /** 取图片直链：消息里自带 http 直链优先；只有 file 时问 NapCat 要。 */
  async function resolveUrl(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return { url: '', base64: '' };
    if (isHttp(raw)) return { url: raw, base64: '' };
    if (/^data:/i.test(raw)) return { url: '', base64: raw };
    if (!nap || typeof nap.callAction !== 'function') return { url: '', base64: '' };
    const r = await nap.callAction('get_image', { file: raw });
    const d = (r && r.data) || r || {};
    const url = String(d.url || '').trim();
    const b64 = String(d.base64 || '').trim();
    return {
      url: isHttp(url) ? url : '',
      base64: b64 ? (b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`) : '',
    };
  }

  /** 下载（或解码 data URI）成一坨字节，带超时与大小上限。 */
  async function load(source) {
    if (source.base64) {
      const p = parseDataUri(source.base64);
      if (!p) throw Object.assign(new Error('图片 base64 无法解析'), { reason: 'bad-image' });
      if (p.data.byteLength > MAX_BYTES) throw Object.assign(new Error('图片过大'), { reason: 'too-large' });
      return p.data;
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, DL_TIMEOUT_MS) : null;
    try {
      const res = await fetch(source.url, {
        signal: controller ? controller.signal : undefined,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NapCat/DSH' },
      });
      if (!res || !res.ok) throw Object.assign(new Error(`HTTP ${res && res.status}`), { reason: 'download' });
      const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
      if (len > MAX_BYTES) throw Object.assign(new Error('图片过大'), { reason: 'too-large' });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.byteLength) throw Object.assign(new Error('图片为空'), { reason: 'download' });
      if (buf.byteLength > MAX_BYTES) throw Object.assign(new Error('图片过大'), { reason: 'too-large' });
      return buf;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 把 QQ 图片变成 DSH 附件引用（主模型请求时宿主自动转成 base64 图片块）。
   * 永不抛：失败返回 { refs: [], reason }。
   * @param {string[]} images 图片直链 / file id / data URI
   * @returns {Promise<{refs:Array, reason:string, count:number, bytes:number}>}
   */
  async function ingest(images) {
    const list = (images || []).filter(Boolean).slice(0, MAX_IMAGES);
    if (!list.length) return { refs: [], reason: 'no-image', count: 0, bytes: 0 };

    const store = attachments();
    if (!store) {
      logOnce('no-attachment-service', '宿主未提供 ctx.attachments，无法把图片交给模型');
      counts.fail += 1;
      last = { state: 'fail', reason: 'no-attachment-service', at: Date.now(), count: 0, bytes: 0 };
      return { refs: [], reason: 'no-attachment-service', count: 0, bytes: 0 };
    }

    const refs = [];
    let bytes = 0;
    let reason = '';
    for (const item of list) {
      try {
        const src = await resolveUrl(item);
        if (!src.url && !src.base64) { reason = 'no-url'; break; }
        let buf;
        try {
          buf = await load(src);
        } catch (e) {
          // 直链失败（反盗链 / 链接过期）→ 让 NapCat 自己把图取回来（它持有登录态）
          if (!nap || typeof nap.callAction !== 'function') throw e;
          const r = await nap.callAction('get_image', { file: src.url || item });
          const d = (r && r.data) || r || {};
          const b64 = String(d.base64 || '').trim();
          if (!b64) throw e;
          buf = await load({ base64: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}` });
        }
        const mediaType = sniffImageType(buf);
        if (!mediaType || !MEDIA_TYPES.includes(mediaType)) { reason = 'unsupported-type'; break; }
        const ext = mediaType === 'image/png' ? '.png'
          : mediaType === 'image/gif' ? '.gif'
            : mediaType === 'image/webp' ? '.webp' : '.jpg';
        const ref = await store.saveImage({ data: buf, mediaType, name: 'qq-image' + ext });
        if (!ref || !ref.attachmentId) { reason = 'attach-failed'; break; }
        refs.push(ref);
        bytes += buf.byteLength;
      } catch (e) {
        reason = (e && e.reason) || 'error';
        logOnce(reason, (e && e.message) || String(e));
        break;
      }
    }

    if (!refs.length) {
      counts.fail += 1;
      last = { state: 'fail', reason: reason || 'unknown', at: Date.now(), count: 0, bytes: 0 };
      return { refs: [], reason: reason || 'unknown', count: 0, bytes: 0 };
    }
    counts.ok += 1;
    last = { state: 'ok', reason: reason || 'ok', at: Date.now(), count: refs.length, bytes };
    return { refs, reason: reason || 'ok', count: refs.length, bytes };
  }

  /** 面板展示用。 */
  function stats() {
    return {
      available: !!attachments(),
      okCount: counts.ok,
      failCount: counts.fail,
      last,
    };
  }

  return { enabledFor, ingest, stats, attachments, resolveUrl };
}
