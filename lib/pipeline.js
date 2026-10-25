// lib/pipeline.js
// 消息管道（对齐 AstrBot 本体处理顺序，零外部依赖）。
//
//   ① 预处理：组件解析 → 过滤（自身/系统/红包闪照/空）→ 黑白名单 → message_id 去重
//   ② 分支：私聊直达；群聊「@ 唤醒 / 免@ 超时」
//   ③ 会话等待器（多轮流程接管，不走普通 LLM）
//   ④ 指令拦截（/help /reset /new /stop /stats /sid /history /ls /rename /del + 管理员指令）
//   ⑤ 上下文：session 历史 + 摘要压缩 + 知识库检索 + 人格/规则解析
//   ⑥ 推理：DSH 或直连模型，流式
//   ⑦ 发送：分段（模拟真人节奏）+ 失败捕获；可选 TTS 语音

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VISION_FALLBACK, DEFAULT_VISION_PROMPT, DESCRIBE_PROMPT, LEGACY_VISION_PROMPTS, detectDescribeIntent } from './vision.js';
import { detectForceVoice, extractForceSay } from './tts.js';
import { createProactive } from './proactive.js';
import { SEARCH_FALLBACK, buildSearchBlock } from './search.js';

function dataDir() {
  const base = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'napcat-bot')
    : path.join(os.homedir(), '.dsh', 'napcat-bot');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
  return base;
}

/** CQ 里的 url 常带 HTML 转义，清洗一下再用。 */
function cleanUrl(v) {
  return String(v || '').trim().replace(/&amp;/g, '&').replace(/^["']|["']$/g, '');
}

/** 模型爱说的「我不会发语音 / 按不了按钮」这类推脱话术（命中就重试 + 清洗）。 */
/** 默认模式（表情包接梗）下，模型仍在「看图汇报」的特征表达。 */
const VISION_REPORT_RE = /(这张|该|这个|图片|配图|画面)(图|图片)?(里|中|上)(有|是|显示|可以看|能看)|图中(有|是|画着)|画面上(有|是)|这张图(展示|显示|描绘|呈现)|图片(展示|显示|描绘)|图中显示|可以看到(一|两|几)/;

const VOICE_DENY_RE = /(不会|不能|没法|无法|没办法|不方便)(发|说|录制?|生成)?(个|句|条|段)?语音|按(不|没)(了|来|动)|小短鳍|(发|说)不(了|出)来?|开不了口|没有(这个)?按钮|不支持(发)?语音|鱼鱼(不会|按不了)/;
const VOICE_DENY_SENT = /[^。！？!?~～]*((不会|不能|没法|无法|没办法|不方便)(发|说|录制?|生成)?(个|句|条|段)?语音|按(不|没)(了|来|动)|小短鳍|(发|说)不(了|出)来?|开不了口|没有(这个)?按钮|不支持(发)?语音)[^。！？!?~～]*[。！？!?~～]?/g;

const SEG_DROP = new Set(['json', 'xml', 'forward', 'markdown', 'music', 'share', 'contact', 'location', 'file']);

export function parseMessage(message, raw) {
  // 组件解析 → { text, images: [url], ats: [qq], hasCard }
  const out = { text: '', images: [], ats: [], voice: '', card: '' };
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue;
      const t = String(seg.type || '');
      const d = seg.data || {};
      if (t === 'text') out.text += String(d.text || '');
      else if (t === 'at') { out.ats.push(String(d.qq || '')); out.text += `@${d.qq || ''} `; }
      else if (t === 'image') out.images.push(cleanUrl(d.url || d.file || ''));
      else if (t === 'record') out.voice = String(d.url || d.file || '');
      else if (SEG_DROP.has(t)) out.card = t;
    }
  } else if (typeof message === 'string') {
    out.text = message;
    const imgs = message.match(/\[CQ:image,[^\]]*?(?:url|file)=([^,\]]+)/g) || [];
    for (const m of imgs) {
      const v = cleanUrl(m.split('=').slice(1).join('='));
      if (v) out.images.push(v);
    }
    const ats = message.match(/\[CQ:at,qq=(\d+)\]/g) || [];
    for (const a of ats) out.ats.push(a.replace(/\D/g, ''));
    if (/\[CQ:(json|xml|forward)/i.test(message)) out.card = 'cq-card';
    if (/\[CQ:record/i.test(message)) out.voice = 'cq-record';
  }
  return out;
}

function isMeaningless(text) {
  const s = String(text || '').replace(/@\d+\s*/g, '').trim();
  if (!s) return true;
  return !/[\p{L}\p{N}]/u.test(s);
}

export function splitSegments(text, maxLen = 60, limit = 4) {
  const s = String(text || '').trim();
  if (!s) return [];
  const sentences = (s.match(/[。！？!?~～…]/g) || []).length;
  if (s.length <= 50 && sentences < 3) return [s];
  const parts = [];
  let buf = '';
  for (const ch of s) {
    buf += ch;
    const boundary = /[。！？!?~～…\n]/.test(ch);
    if (boundary && buf.trim().length >= 12) { parts.push(buf.trim()); buf = ''; }
    else if (buf.length >= maxLen) { parts.push(buf.trim()); buf = ''; }
    if (parts.length >= limit) break;
  }
  if (parts.length < limit && buf.trim()) parts.push(buf.trim());
  const out = parts.filter(Boolean);
  if (out.length >= limit) {
    const used = out.join('').length;
    if (used < s.replace(/\s+/g, '').length) out[out.length - 1] = s.slice(-s.length + used).trim() || out[out.length - 1];
  }
  return out.length ? out : [s];
}

const HELP_BASIC = [
  '可用指令：',
  '/help 查看可用指令',
  '/reset 清空当前会话上下文',
  '/new 新建一条对话（旧会话保留存档）',
  '/stop 终止当前正在生成的任务',
  '/stats 查看当前会话 token 统计',
  '/sid 获取当前会话标识（群号 / QQ）',
  '/history 查看最近对话历史',
  '/ls 列出全部会话',
  '/rename <标题> 重命名当前会话',
  '/del 删除当前会话',
  '/switch <序号> 切换到某个存档会话',
  '/idiom 成语接龙（多轮交互示例）',
].join('\n');

const HELP_ADMIN = [
  '管理员指令：',
  '/op <QQ> 添加管理员　/deop <QQ> 移除管理员',
  '/provider 查看服务商　/provider <名称> 切换默认服务商',
  '/model 查看模型　/model <名称> 覆盖当前会话模型',
  '/groupnew <群号> 为指定群新建会话',
  '/ban <QQ>　/unban <QQ> 黑名单管理',
].join('\n');

export function createPipeline(deps) {
  const { config, log, nap, responder, sessions, limiter, state, kb, tts, vision, search } = deps;
  const msgLogFile = path.join(dataDir(), 'messages.log');
  const inflight = new Set();       // sessionKey → 正在生成
  const stopped = new Set();        // 被 /stop 终止的会话
  const awaiters = new Map();       // sessionKey → { id, prompt, onInput }

  // ── 空闲主动发言调度（只决定「什么时候开口」，说什么交给模型 + 人设）──
  const proactive = createProactive({
    config,
    log,
    getRule: (meta) => state.rules.match(meta.sessionKey, meta.gid || '', meta.uid || ''),
    isBusy: (key) => inflight.has(key),
    onFire: (meta) => fireProactive(meta),
  });

  function logMsg(kind, sessionKey, who, text) {
    const line = `${new Date().toISOString()} [${kind}] ${sessionKey} ${who}: ${String(text || '').replace(/\s+/g, ' ').slice(0, 200)}`;
    try { fs.appendFileSync(msgLogFile, line + '\n'); } catch { /* ignore */ }
    try { log && log.info && log.info(`[msg] ${kind} ${sessionKey} ${who}: ${String(text || '').slice(0, 100)}`); } catch { /* ignore */ }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sessionKeyOf(ev, uid, gid) {
    if (ev.message_type === 'private') return `private:${uid}`;
    return config.groupUniqueSession !== false ? `group:${gid}:${uid}` : `group:${gid}`;
  }

  function isAdmin(uid) {
    if (state.admins.has(uid)) return true;
    const list = String(config.superUsers || '').split(/[\s,，]+/).filter(Boolean);
    return list.includes(String(uid));
  }

  /**
   * 解析生效人格。
   * 优先级：**AI 配置面板的人格** > 规则绑定人格 > 人格库全局人格。
   * 面板里填了就以面板为唯一来源（用户明确要求：面板人格最高优先级）；
   * 面板留空时才轮到规则/人格库；都没有就返回空串（system 留空，不补默认文字）。
   */
  function resolvePersona(rule, vars) {
    const render = (t) => state.personas.render(t, vars);
    const panel = String(config.personaPrompt || '').trim();
    if (panel) return { text: panel, source: 'panel' };
    if (rule && rule.personaText) return { text: render(rule.personaText), source: 'rule-text' };
    if (rule && rule.personaId) {
      const p = state.personas.get(rule.personaId);
      if (p) return { text: render(p.prompt), source: 'rule-persona:' + p.name };
    }
    const gid = state.personas.getGlobalId();
    if (gid) {
      const p = state.personas.get(gid);
      if (p) return { text: render(p.prompt), source: 'global:' + p.name };
    }
    return { text: '', source: 'none' };
  }

  function resolveModel(rule) {
    const provider = (rule && rule.provider) || String(config.providerOverride || '').trim();
    const model = (rule && rule.model) || String(config.modelOverride || '').trim();
    return { provider, model };
  }

  async function sendText(channel, text) {
    try {
      if (channel.type === 'group') await nap.sendGroup(channel.id, text);
      else await nap.sendPrivate(channel.id, text);
      return true;
    } catch (e) {
      const msg = `发送失败：${(e && e.message) || e}`;
      try { log && log.warn && log.warn(`[napcat] ${msg}`); } catch { /* ignore */ }
      try { deps.onError && deps.onError(msg); } catch { /* ignore */ }
      return false;
    }
  }

  async function handle(ev) {
    const isGroup = ev.message_type === 'group';
    const uid = String(ev.user_id != null ? ev.user_id : (ev.sender && ev.sender.user_id) || '');
    const gid = ev.group_id != null ? String(ev.group_id) : '';
    const senderName = (ev.sender && (ev.sender.card || ev.sender.nickname)) || uid;

    // ── ① 预处理 ──
    if (sessions.isBanned(uid)) return;
    if (config.blacklist) {
      const banned = String(config.blacklist).split(/[\s,，]+/).filter(Boolean);
      if (banned.includes(uid)) return;
    }
    if (config.whitelist) {
      const allow = String(config.whitelist).split(/[\s,，]+/).filter(Boolean);
      if (allow.length && !allow.includes(uid)) return;
    }
    if (config.groupWhitelist && isGroup) {
      const allow = String(config.groupWhitelist).split(/[\s,，]+/).filter(Boolean);
      if (allow.length && !allow.includes(gid)) return;
    }
    if (config.groupBlacklist && isGroup) {
      const deny = String(config.groupBlacklist).split(/[\s,，]+/).filter(Boolean);
      if (deny.includes(gid)) return;
    }

    const parsed = parseMessage(ev.message, ev.raw_message);
    if (parsed.card) { log.info(`[napcat] 丢弃 ${parsed.card} 类型消息`); return; }

    const myQQ = String(nap.selfQQ || config.selfQQ || '');
    const strippedText = String(parsed.text || '')
      .replace(new RegExp(`@${myQQ}\\s*`, 'g'), '')
      .trim();
    if (isMeaningless(strippedText) && !parsed.images.length) return;

    const sessionKey = sessionKeyOf(ev, uid, gid);
    const channel = isGroup ? { type: 'group', id: gid } : { type: 'private', id: uid };
    const vars = {
      bot_name: config.botName || '机器人',
      group_id: gid || '',
      user_id: uid,
      user_name: senderName,
      time: new Date().toLocaleString('zh-CN'),
    };

    // ── ② 群聊唤醒判定 ──
    if (isGroup) {
      const at = parsed.ats.includes(myQQ) || new RegExp(`\\[CQ:at,qq=${myQQ}\\]`).test(String(ev.raw_message || ''));
      const wakeKey = `group:${gid}:${uid}`;
      const timeoutSec = Math.max(5, Number(config.groupWakeTimeoutSec) || 120);
      if (at) sessions.wakeSet(wakeKey);
      else if (sessions.wakeAt(wakeKey) && Date.now() - sessions.wakeAt(wakeKey) < timeoutSec * 1000) sessions.wakeSet(wakeKey);
      else if (config.groupReplyOnlyAt !== false) return;
    }

    logMsg('RECV', sessionKey, senderName, strippedText || '[图片]');

    // 用户说话了 → 重新计时；收尾语句（再见/晚安/先不聊）直接停表
    proactive.noteUser({
      sessionKey, channel, gid, uid, text: strippedText || '[图片]', name: senderName,
      rule: state.rules.match(sessionKey, gid, uid),
    });

    // ── ③ 会话等待器 ──
    const waiter = awaiters.get(sessionKey);
    if (waiter && !strippedText.startsWith('/')) {
      try {
        const done = await waiter.onInput(strippedText, { channel, uid, gid, sessionKey });
        if (done) awaiters.delete(sessionKey);
        return;
      } catch (e) {
        awaiters.delete(sessionKey);
        log.warn(`[napcat] 等待器异常已退出: ${e}`);
      }
    }

    // ── ④ 指令 ──
    if (strippedText.startsWith('/')) {
      await handleCommand({
        cmdText: strippedText, sessionKey, channel, uid, gid, isGroup,
      });
      return;
    }

    // 规则（会话级覆盖：语音 / 识图 / 模型都靠它）
    const rule = state.rules.match(sessionKey, gid, uid);

    // ── ④b 强制语音预处理拦截（最高优先级，绕过 LLM）──
    // 「发个语音说你好」这类指令直接抠出朗读文本 → 合成 → 发语音，
    // 完全不经过模型，所以不可能再冒出「鱼鱼不会按按钮」这种推脱。
    const forcePre = extractForceSay(strippedText);
    const hasImage = parsed.images.length > 0;
    if (forcePre.hit) {
      const bypass = !!forcePre.say && !hasImage;   // 有图时不抠文本：图要走识图+人设描述
      logMsg('FORCE', sessionKey, bypass ? 'hit' : 'hit-no-text',
        `${forcePre.keyword}${bypass ? ' → 朗读：' + forcePre.say : (hasImage ? '（带图，走识图+模型起稿）' : '（没指定内容，交给模型起稿）')}`);
      if (bypass) {
        if (limiter && !limiter.canSend(sessionKey)) {
          log.info(`[napcat] 冷却中，跳过强制语音: ${sessionKey}`);
          return;
        }
        sessions.append(sessionKey, { role: 'user', name: senderName, text: strippedText });
        await deliver({
          channel, sessionKey, rule, full: forcePre.say,
          userText: strippedText, persona: '', single: true,
        });
        return;
      }
    }

    if (rule && rule.llmEnabled === false) {
      log.info(`[napcat] 规则命中且关闭了 LLM，跳过回复: ${sessionKey}`);
      return;
    }
    const persona = resolvePersona(rule, vars);
    const modelSel = resolveModel(rule);
    if (persona.source === 'none') {
      log.info('[napcat] 面板人格为空，本轮不发送 system（不会自动补默认人设）');
    }

    // 上下文
    const session = sessions.get(sessionKey);
    let history = session.messages || [];
    let summary = session.summary || '';

    if (config.contextCompress !== false) {
      const chars = history.reduce((n, m) => n + String(m.text || '').length, 0);
      const maxChars = Math.max(800, Number(config.contextMaxChars) || 2400);
      if (history.length > 10 && chars > maxChars) {
        const keep = history.slice(-6);
        const older = history.slice(0, -6);
        try {
          const s = await responder.summarize(summary, older);
          if (s) { sessions.setSummary(sessionKey, s); summary = s; }
          history = keep;
          sessions.get(sessionKey).messages = keep;
          log.info(`[napcat] 上下文已压缩：${older.length} 条 → 摘要 ${String(s || '').length} 字`);
        } catch (e) { log.warn(`[napcat] 上下文压缩失败: ${e}`); }
      }
    }

    // 知识库检索
    let kbBlock = '';
    let citations = [];
    if (kb && config.kbEnabled !== false && rule && rule.kbEnabled !== false) {
      const kbIds = (rule && rule.kbIds && rule.kbIds.length) ? rule.kbIds : [];
      try {
        const hits = kb.search(strippedText, kbIds, 4);
        if (hits.length) {
          kbBlock = '【知识库检索结果，回答时优先采用；不确定就说不确定】\n'
            + hits.map((h, i) => `[${i + 1}] ${h.title}：${h.text.slice(0, 400)}`).join('\n');
          citations = hits.map((h) => h.title);
        }
      } catch (e) { log.warn(`[napcat] 知识库检索失败: ${e}`); }
    }

    if (limiter && !limiter.canSend(sessionKey)) {
      log.warn(`[napcat] 冷却中，跳过回复: ${sessionKey}`);
      return;
    }

    // ── ⑤b 识图：图片直链 → DSH 附件引用 → 和文本一起交给**当前主模型** ──
    // 主模型就是 DeepSeek-V4.1-Flash，自带视觉：同一条 user 消息里既有 text 也有
    // image 块，模型看完图直接按人设说话。不再有独立的识图接口/密钥。
    const imgList = parsed.images.filter(Boolean).slice(0, 2);
    let imageRefs = [];
    let visionState = 'none';   // none / ok / off / fail
    let visionReason = '';
    if (imgList.length) {
      if (!vision || !vision.enabledFor(rule)) {
        visionState = 'off';
        visionReason = vision ? 'disabled' : 'no-vision-module';
      } else {
        const v = await vision.ingest(imgList);
        if (v && v.refs && v.refs.length) {
          imageRefs = v.refs;
          visionState = 'ok';
          visionReason = v.reason || 'ok';
        } else {
          visionState = 'fail';
          visionReason = (v && v.reason) || 'unknown';
        }
      }
      if (deps.onVision) {
        try { deps.onVision({ state: visionState, reason: visionReason, count: imageRefs.length }); } catch { /* ignore */ }
      }
      if (visionState === 'ok') {
        logMsg('VISION', sessionKey, 'ok',
          `原生多模态 · 图 ${imageRefs.length} 张 · ${visionReason}`);
      } else {
        logMsg('VISION', sessionKey, 'fallback', `原生多模态未启用/失败（${visionReason}）`);
      }
    }

    sessions.append(sessionKey, { role: 'user', name: senderName, text: strippedText || '[图片]' });

    // 识图关闭 / 图片取不到 / 主模型报错 → 直接用人设台词兜底，不再问模型
    if (imgList.length && visionState !== 'ok') {
      log.info(`[napcat] 识图不可用（${visionReason}），用人设兜底台词回复`);
      const full = VISION_FALLBACK;
      if (stopped.has(sessionKey)) { stopped.delete(sessionKey); return; }
      // 兜底台词是一条完整情绪话，不拆段，避免「一图两刷」
      await deliver({ channel, sessionKey, rule, full, userText: strippedText, persona: persona.text, single: true });
      return;
    }

    // 强制语音指令（发语音 / 说出来 / 语音说xxx）：优先级最高，跳过随机概率
    const forceVoice = detectForceVoice(strippedText);

    // ── ⑤c 联网搜索判定（优先级：强制语音 > 手动搜索 > 自动搜索 > 识图解读 > 闲聊）──
    // 判定分两层：本地关键词/启发式先筛，拿不准时才多花一次很轻的模型判定。
    let searchBlock = '';
    let searchPlan = { mode: 'off', query: '', reason: 'disabled' };
    if (search && typeof search.decide === 'function') {
      const judge = async (prompt) => {
        try {
          const t = await Promise.race([
            responder.replyStream({ userText: prompt, history: [], summary: '', persona: '', model: modelSel, maxTokens: 24 }),
            sleep(4500).then(() => ''),
          ]);
          return String(t || '');
        } catch { return ''; }
      };
      try {
        searchPlan = await search.decide({
          text: strippedText,
          hasImage: imageRefs.length > 0,
          rule,
          judge,
        });
      } catch (e) {
        log.warn(`[napcat] 搜索判定失败: ${e}`);
        searchPlan = { mode: 'off', query: '', reason: 'decide-error' };
      }

      if (searchPlan.mode !== 'off') {
        logMsg('SEARCH', sessionKey, searchPlan.mode,
          `${searchPlan.reason} · q=${String(searchPlan.query || '').slice(0, 60) || '(空)'}`);
        // 发图提问：先让主模型用一句话点出「图里是啥」，再拿这句话去搜
        let q = String(searchPlan.query || '').trim();
        if (imageRefs.length) {
          try {
            const cap = await Promise.race([
              responder.replyStream({
                userText: '用不超过 18 个字说清这张图里的主体是什么（只要名词短语，不要句子、不要标点结尾）。',
                history: [], summary: '', persona: '', imageRefs, model: modelSel, maxTokens: 40,
              }),
              sleep(8000).then(() => ''),
            ]);
            const hint = String(cap || '').replace(/\s+/g, ' ').trim().slice(0, 40);
            if (hint) {
              q = (hint + ' ' + q).trim();
              logMsg('SEARCH', sessionKey, 'image-hint', hint);
            }
          } catch { /* 提词失败就只用文字搜 */ }
        }
        if (!q) q = strippedText;

        const r = await search.run(q);
        if (r && r.ok) {
          searchBlock = buildSearchBlock(r.sources, q);
          logMsg('SEARCH', sessionKey, 'ok',
            `${r.provider} · ${r.sources.length} 条 · ${r.ms}ms${r.cached ? ' · 缓存' : ''}`);
        } else {
          logMsg('SEARCH', sessionKey, 'fail',
            `${(r && r.provider) || 'none'} · ${(r && r.error) || 'unknown'}`);
          // 搜不到 → 用人设兜底台词（手动搜失败必兜；自动搜失败同样兜，保证不瞎编）
          if (!stopped.has(sessionKey)) {
            await deliver({
              channel, sessionKey, rule, full: SEARCH_FALLBACK,
              userText: strippedText, persona: persona.text, single: true,
            });
            return;
          }
        }
      } else if (searchPlan.reason) {
        logMsg('SEARCH', sessionKey, 'skip', searchPlan.reason);
      }
    }

    // ── ⑥ 推理（流式）──
    // 带图时分两种模式，优先级由用户这句话决定：
    //   ① 命中「描述一下这张图 / 图里长啥样…」→ 客观描述画面
    //   ② 没命中 → 只解读意图、接梗玩梗，严禁看图汇报
    const describeIntent = detectDescribeIntent(strippedText);
    const customPrompt = String(config.visionPrompt || '').trim();
    // 用户自己改过的提示词才用他的；历史默认值一律视为「没改过」
    const userPrompt = customPrompt && !LEGACY_VISION_PROMPTS.includes(customPrompt) ? customPrompt : '';
    const visionPrompt = describeIntent.hit
      ? DESCRIBE_PROMPT
      : (userPrompt || DEFAULT_VISION_PROMPT);
    let userText;
    if (imageRefs.length) {
      if (describeIntent.hit) {
        userText = `${strippedText}\n\n`
          + '【这一轮对方明确要求你描述图片，图片就在你眼前】\n'
          + `【看图侧重：${visionPrompt}】\n`
          + '硬规则：先把画面讲清楚 —— 图里有什么元素、什么角色、有没有文字（有就念出来）、大概什么构图；'
          + '讲完可以用你的语气收一句，但绝不能跳过画面只聊别的，也不要说“看不清”。';
      } else {
        userText = `${strippedText || '（对方发来一张表情包，没配文字）'}\n\n`
          + '【这张图就在你眼前，你看得见。但这一轮不要描述画面】\n'
          + `【看图侧重：${visionPrompt}】\n`
          + '硬规则：\n'
          + '1) 禁止描述画面里的物体、角色、文字、构图，禁止“图片里是…”“这张图显示…”这类汇报式表达；\n'
          + '2) 只判断对方发这张图的意图，读懂它的梗和情绪，顺着接梗互动；\n'
          + '3) 用你的身份和语气，短句、软软的、有点懒，最多两句，可以带表情；\n'
          + '4) 不要解释你在看图，也不要说“我看不清”。';
      }
      logMsg('VISION', sessionKey, 'mode',
        describeIntent.hit ? `describe:${describeIntent.keyword}` : 'meme（默认接梗，不报画面）');
    } else {
      userText = strippedText || '（我发了一张图片）';
    }
    if (searchBlock) userText += '\n\n' + searchBlock;
    if (forceVoice.force) {
      userText += '\n\n【本轮对方明确要求用语音回答（' + forceVoice.keyword + '）。'
        + '你本来就能直接说话发出语音，绝对不许回答“不会发语音 / 按不了按钮 / 没法发”这类推脱话术。'
        + '直接把要念出来的内容说出来即可，不要解释你怎么发语音。】';
    }

    inflight.add(sessionKey);
    let full = '';
    try {
      full = await responder.replyStream({
        userText,
        history,
        summary,
        persona: persona.text,
        personaSource: persona.source,
        kbBlock,
        // 图片走附件引用，和文本同一次请求进主模型（原生视觉）
        imageRefs,
        model: modelSel,
        onDelta: () => {},
      });
    } catch (e) {
      log.warn(`[napcat] 生成失败: ${e}`);
    } finally {
      inflight.delete(sessionKey);
    }

    if (stopped.has(sessionKey)) { stopped.delete(sessionKey); log.info('[napcat] 已被 /stop 终止，丢弃本次回复'); return; }
    if (full && imageRefs.length) {
      logMsg('MODEL', sessionKey, 'multimodal',
        `带图 ${imageRefs.length} 张请求主模型 · 返回 ${full.length} 字`);
      // 默认模式（没让描述）却还在汇报画面 → 带更硬的指令重试一次，把「看图汇报」掰回来
      if (!describeIntent.hit && VISION_REPORT_RE.test(full)) {
        logMsg('VISION', sessionKey, 'report-retry', '模型在报画面，按接梗模式重试一次');
        try {
          const retry = await responder.replyStream({
            userText: userText + '\n\n【再强调：对方只是发了张图，没让你描述画面。'
              + '把刚才那句“图里有什么”全部删掉，只回一句接梗互动的话，不要提画面内容。】',
            history,
            summary,
            persona: persona.text,
            personaSource: persona.source,
            kbBlock,
            imageRefs,
            model: modelSel,
            onDelta: () => {},
          });
          if (retry && !VISION_REPORT_RE.test(retry)) full = retry;
        } catch (e) { log.warn(`[napcat] 接梗模式重试失败: ${e}`); }
      }
    }
    if (!full) {
      // 带图却一句都没生成（模型超时/报错）→ 用人设兜底台词，保证不冷场、不刷屏
      if (imageRefs.length) {
        logMsg('VISION', sessionKey, 'fallback', '模型未返回内容，改用兜底台词');
        if (!stopped.has(sessionKey)) {
          await deliver({ channel, sessionKey, rule, full: VISION_FALLBACK, userText: strippedText, persona: persona.text, single: true });
        }
      }
      return;
    }

    // 命中强制语音却还在「我不会发语音/按不了按钮」→ 硬指令重试一次，再不行就清洗掉推脱句
    if (forceVoice.force && VOICE_DENY_RE.test(full)) {
      const stricter = userText + '\n\n【再强调一次：你这句话会被直接合成语音播给对方听。'
        + '禁止出现「不会 / 发不了 / 按不了 / 没法 / 没办法」等字眼，只输出要念的内容本身。】';
      try {
        const retry = await responder.replyStream({
          userText: stricter,
          history,
          summary,
          persona: persona.text,
          personaSource: persona.source,
          kbBlock,
          images: [],
          model: modelSel,
          onDelta: () => {},
        });
        if (retry) full = retry;
      } catch (e) { log.warn(`[napcat] 强制语音重试失败: ${e}`); }
      if (VOICE_DENY_RE.test(full)) {
        const cleaned = stripVoiceDeny(full);
        if (cleaned) full = cleaned;
        logMsg('TTS', sessionKey, 'retry', '模型推脱发语音，已按强制指令纠正');
      }
    }

    if (citations.length) full += `\n\n（参考：${citations.slice(0, 3).join('、')}）`;
    await deliver({ channel, sessionKey, rule, full, userText: strippedText, persona: persona.text });
  }

  /** 去掉模型推脱「不会发语音」的句子；只剩这些时返回空串。 */
  function stripVoiceDeny(text) {
    const cleaned = String(text || '').replace(VOICE_DENY_SENT, ' ').replace(/\s+/g, ' ').trim();
    return cleaned;
  }

  /** 把模型给的主动发言收拾干净：去标签、去角色前缀、太长就截到一句话。 */
  function tidyProactive(text) {
    let t = String(text || '').trim();
    if (!t) return '';
    t = t.replace(/^【[^】]{0,30}】\s*/, '');                       // 模型自己加的【主动开口】之类
    const name = String(config.botName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (name) t = t.replace(new RegExp('^' + name + '\\s*[：:]\\s*'), '');
    t = t.replace(/^["“'「『]([\s\S]*)["”'」』]$/, '$1').trim();
    t = t.replace(/^\s*[-—·]\s*/, '');
    if (t.length > 80) {
      const cut = t.slice(0, 80);
      const p = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('~'), cut.lastIndexOf('～'));
      t = p >= 12 ? cut.slice(0, p + 1) : cut + '…';
    }
    return t;
  }

  /**
   * 到点主动开口：把「刚刚聊过什么」交给主模型，让它按人设写一句短话。
   * 生成失败 / 空内容 → 什么都不发（宁可不吭声，也不发套话）。
   */
  async function fireProactive(meta) {
    const { sessionKey, channel } = meta;
    const rule = meta.rule || state.rules.match(sessionKey, meta.gid || '', meta.uid || '');
    const session = sessions.get(sessionKey);
    const history = (session.messages || []).slice(-12);
    const hasTalk = history.some((m) => m.role === 'assistant' && String(m.text || '').trim());
    if (!hasTalk) {
      log.info(`[napcat] 主动发言跳过（${sessionKey}）：还没聊出内容，不硬开口`);
      return false;
    }
    if (rule && rule.llmEnabled === false) {
      log.info(`[napcat] 主动发言跳过（${sessionKey}）：规则关闭了 LLM`);
      return false;
    }
    const vars = {
      bot_name: config.botName || '机器人',
      group_id: meta.gid || '',
      user_id: meta.uid || '',
      user_name: meta.name || '',
      time: new Date().toLocaleString('zh-CN'),
    };
    const persona = resolvePersona(rule, vars);
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    const idleSec = Math.max(0, Math.round(Number(meta.idleFor) / 1000) || 0);
    const idleText = idleSec >= 60 ? `${Math.round(idleSec / 60)} 分钟` : `${idleSec} 秒`;
    const prompt = [
      `【你自己忽然想找对方说话（安静了 ${idleText} 了）】`,
      lastUser ? `对方最后一句：「${String(lastUser.text || '').replace(/\s+/g, ' ').slice(0, 120)}」` : '',
      '请你主动跟对方说一句，要求：',
      '1) 只输出你要说的那句话本身，不要解释、不要旁白、不要提到「系统/提示/主动发言」；',
      '2) 优先接着刚才聊的具体话题（点出细节，顺着问一句）；没什么话题就随口念叨一句或问一句；',
      '3) 短句为主，最多两句，别长篇大论，别像客服；',
      '4) 语气随性、懒懒软软，符合你的人设。',
      '方向可选（挑最自然的一个，别生硬照抄）：',
      '· 想念：呜，突然想你啦～ / 有没有惦记鱼鱼呀',
      '· 关心：还在吗？怎么不回啦',
      '· 接旧话题：刚刚聊的那个东西，你还有想说的吗',
      '· 小鱼碎碎念：泡着温水好舒服呀',
    ].filter(Boolean).join('\n');

    let raw = '';
    try {
      raw = await responder.replyStream({
        userText: prompt,
        history,
        summary: session.summary || '',
        persona: persona.text,
        personaSource: persona.source,
        model: resolveModel(rule),
        onDelta: () => {},
      });
    } catch (e) {
      log.warn(`[napcat] 主动发言生成失败: ${e}`);
      return false;
    }
    const full = tidyProactive(raw);
    if (!full) {
      log.info(`[napcat] 主动发言生成空内容，本轮不发送（不刷屏）`);
      return false;
    }
    if (stopped.has(sessionKey)) { stopped.delete(sessionKey); return false; }
    try {
      log.info(`[napcat] 主动发言 内容 · ${sessionKey} · 空闲 ${idleSec}s · p=${Number(meta.chance || 0).toFixed(2)} roll=${Number(meta.roll || 0).toFixed(2)} → ${full.slice(0, 40)}`);
    } catch { /* ignore */ }
    logMsg('PROACTIVE', sessionKey, 'bot', full);
    // 走统一投递 → 照样进「想发就发」随机语音判定（userText 传空，避免误触强制语音）
    await deliver({ channel, sessionKey, rule, full, userText: '', persona: persona.text, single: true });
    return true;
  }

  /**
   * 统一投递：文字 / TTS 语音（全部·关键词·性格随机 / 强制语音）。
   * 识图兜底台词与模型回复都走这里，所以「图片回复」同样会进入随机语音判定。
   */
  async function deliver({ channel, sessionKey, rule, full, userText, persona, single }) {
    // ── ⑦ 发送（文字 / 语音；语音三种模式：全部 / 关键词 / 性格随机）──
    const ttsPlan = tts ? tts.plan(rule, { text: full, userText, persona }) : { send: false, mode: 'off' };
    let audio = '';
    if (ttsPlan.send) {
      const t0 = Date.now();
      audio = await tts.synth(full, ttsPlan.voice);
      if (audio) {
        logMsg('TTS', sessionKey, 'synth-ok',
          `${ttsPlan.mode} · 引擎 ${ttsPlan.engine || 'http'} · 音色 ${ttsPlan.voice || '-'} · ${Date.now() - t0}ms`);
      } else {
        // 兜底：合成失败只发文字，日志留痕，不影响插件运行
        logMsg('TTS', sessionKey, 'fail', `${ttsPlan.mode} 合成失败（引擎 ${ttsPlan.engine || 'http'}），已降级为纯文字`);
        if (deps.onTts) { try { deps.onTts({ ok: false, plan: ttsPlan }); } catch { /* ignore */ } }
      }
    } else if (ttsPlan.mode && ttsPlan.mode !== 'off' && tts && tts.noteSkip) {
      tts.noteSkip();
      // 命中但发不出去（没接口也没本地引擎）也要留痕，方便排查「为什么只有文字」
      logMsg('TTS', sessionKey, 'skip', `${ttsPlan.mode} · ${ttsPlan.reason || 'no-engine'} · 引擎 ${ttsPlan.engine || 'none'}`);
      if (deps.onTts) { try { deps.onTts({ ok: true, skipped: true, plan: ttsPlan }); } catch { /* ignore */ } }
    }

    // 命中语音时默认「只发语音」；但回复过长（超过接口可合成字数）时补发文字，避免信息丢失
    const voiceOnly = !!audio && ttsPlan.replaceText !== false && full.length <= (ttsPlan.maxChars || 300);
    const cut = () => (single ? [full] : splitSegments(full, 60, 4));
    let ok = 0;
    if (!voiceOnly) {
      const parts = cut();
      for (let i = 0; i < parts.length; i += 1) {
        if (i > 0) await sleep(240 + Math.min(800, parts[i].length * 10));
        if (await sendText(channel, parts[i])) { ok += 1; logMsg('SEND', sessionKey, 'bot', parts[i]); }
        else break;
      }
    }

    let voiceOk = false;
    if (audio) {
      voiceOk = await tts.send(channel, audio, ttsPlan.voice);
      if (voiceOk) logMsg('TTS', sessionKey, ttsPlan.voice || '语音', `${ttsPlan.mode} p=${ttsPlan.probability}% · ${audio.length} b64 字符`);
      else logMsg('TTS', sessionKey, 'fail', '语音发送失败，已降级为纯文字');
      if (deps.onTts) { try { deps.onTts({ ok: voiceOk, sent: voiceOk, plan: ttsPlan, degraded: !voiceOk }); } catch { /* ignore */ } }
      // 语音发送失败且刚才没发文字（voiceOnly）→ 补发文字，保证用户至少收到内容
      if (!voiceOk && voiceOnly) {
        const parts = cut();
        for (let i = 0; i < parts.length; i += 1) {
          if (i > 0) await sleep(240 + Math.min(800, parts[i].length * 10));
          if (await sendText(channel, parts[i])) { ok += 1; logMsg('SEND', sessionKey, 'bot', parts[i]); }
          else break;
        }
      }
    }

    if (ok > 0 || voiceOk) {
      try { limiter && limiter.markSent(sessionKey); } catch { /* ignore */ }
      sessions.append(sessionKey, { role: 'assistant', self: config.botName || '我', text: full });
      // 说完这句话，对话重新安静下来 → 重新开始空闲计时
      proactive.noteBot(sessionKey);
    }
  }

  // ── 指令实现 ─────────────────────────────────────────────────────────
  async function handleCommand(ctx) {
    const { cmdText, sessionKey, channel, uid, gid, isGroup } = ctx;
    const parts = cmdText.split(/\s+/);
    const cmd = String(parts[0] || '').toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
    const admin = isAdmin(uid);
    let out = '';

    if (cmd === '/help') {
      out = HELP_BASIC + (admin ? '\n\n' + HELP_ADMIN : '');
    } else if (cmd === '/reset') {
      sessions.reset(sessionKey);
      awaiters.delete(sessionKey);
      out = '已经清空咱们的对话记忆咯';
    } else if (cmd === '/new') {
      sessions.newSession(sessionKey);
      awaiters.delete(sessionKey);
      out = '开新对话啦';
    } else if (cmd === '/stop') {
      stopped.add(sessionKey);
      awaiters.delete(sessionKey);
      out = inflight.has(sessionKey) ? '停，正在终止这次生成。' : '当前没有正在执行的任务。';
    } else if (cmd === '/stats') {
      const s = sessions.get(sessionKey);
      const eng = responder.describe();
      out = [
        `会话：${s.title || sessionKey}`,
        `消息数：${s.messages.length}　累计 token（估算）：${s.tokens || 0}`,
        `摘要：${s.summary ? '已有（' + s.summary.length + ' 字）' : '无'}`,
        `模型：${eng.route ? eng.route.provider + ' / ' + eng.route.model : '未就绪'}（${eng.effective}）`,
      ].join('\n');
    } else if (cmd === '/sid') {
      out = [
        `UMO：${sessionKey}`,
        `类型：${isGroup ? '群聊' : '私聊'}`,
        `群号：${gid || '-'}`,
        `QQ：${uid}`,
        `群聊独立会话：${config.groupUniqueSession !== false ? '开启' : '关闭'}`,
      ].join('\n');
    } else if (cmd === '/history') {
      const h = sessions.history(sessionKey, 10);
      out = h.length
        ? h.map((m) => `${m.role === 'user' ? (m.name || '对方') : '我'}：${String(m.text || '').slice(0, 80)}`).join('\n')
        : '还没有对话历史。';
    } else if (cmd === '/ls') {
      const list = sessions.list().slice(0, 12);
      out = list.length
        ? '会话列表：\n' + list.map((s, i) => `${i + 1}. ${s.title}（${s.messages} 条 / ${s.tokens} token）`).join('\n')
        : '还没有任何会话。';
    } else if (cmd === '/rename') {
      if (!arg) out = '用法：/rename <新标题>';
      else { const s = sessions.rename(sessionKey, arg); out = `已重命名为「${s.title}」`; }
    } else if (cmd === '/del') {
      sessions.remove(sessionKey);
      out = '当前会话已删除，下次说话会开一条新的。';
    } else if (cmd === '/switch') {
      const idx = Number(arg);
      const s = sessions.get(sessionKey);
      const archives = s.archives || [];
      if (!idx || idx < 1 || idx > archives.length) {
        out = archives.length ? `用法：/switch <1-${archives.length}>，当前有 ${archives.length} 个存档会话。` : '当前没有存档会话。';
      } else {
        const a = archives[idx - 1];
        s.messages = a.messages || [];
        s.summary = a.summary || '';
        archives.splice(idx - 1, 1);
        out = `已切换回「${a.title || '存档会话'}」`;
      }
    } else if (cmd === '/idiom') {
      awaiters.set(sessionKey, {
        id: 'idiom',
        prompt: '成语接龙',
        onInput: async (text) => {
          const last = await handoffLastIdiom(sessionKey);
          if (!last) { await sendText(channel, '那咱重新开始：一心一意'); return false; }
          const tail = last.slice(-1);
          if (String(text).trim().startsWith(tail)) {
            await sendText(channel, `接得不错！${String(text).trim()}。我再接：${autoIdiom(String(text).trim().slice(-1))}`);
            return false;
          }
          await sendText(channel, `哎呀，要接「${tail}」开头的成语，再试一次～`);
          return false;
        },
      });
      out = '成语接龙开始！我说一个：一心一意（回复 /stop 可退出）';
    } else if (cmd === '/op' || cmd === '/deop' || cmd === '/ban' || cmd === '/unban' || cmd === '/model' || cmd === '/provider' || cmd === '/groupnew') {
      if (!admin) { out = '你没有权限执行这个指令。'; }
      else if (cmd === '/op') { if (!arg) out = '用法：/op <QQ>'; else { state.admins.add(arg); out = `已添加管理员 ${arg}`; } }
      else if (cmd === '/deop') { if (!arg) out = '用法：/deop <QQ>'; else { state.admins.remove(arg); out = `已移除管理员 ${arg}`; } }
      else if (cmd === '/ban') { if (!arg) out = '用法：/ban <QQ>'; else { sessions.ban(arg, `by ${uid}`); out = `已拉黑 ${arg}`; } }
      else if (cmd === '/unban') { if (!arg) out = '用法：/unban <QQ>'; else { sessions.unban(arg); out = `已解除拉黑 ${arg}`; } }
      else if (cmd === '/model') {
        if (!arg) {
          const eng = responder.describe();
          out = `当前模型：${eng.route ? eng.route.provider + ' / ' + eng.route.model : '未就绪'}\n用法：/model <模型名> 覆盖当前会话`;
        } else {
          const scope = isGroup ? `group:${gid}` : `private:${uid}`;
          state.rules.upsert({ scope, model: arg });
          out = `本会话模型已覆盖为 ${arg}`;
        }
      } else if (cmd === '/provider') {
        const providers = String(config.providers || '').split(/[\s,，]+/).filter(Boolean);
        if (!arg) out = '可用服务商：' + (providers.join('、') || '（未配置，使用 DSH 当前模型）') + '\n用法：/provider <名称>';
        else if (providers.length && !providers.includes(arg)) out = '未知服务商，可选：' + providers.join('、');
        else { config.providerOverride = arg; out = `默认服务商已切换为 ${arg}`; }
      } else if (cmd === '/groupnew') {
        if (!arg) out = '用法：/groupnew <群号>';
        else { sessions.newSession(`group:${arg}`); out = `已为群 ${arg} 新建会话`; }
      }
    } else {
      out = '不认识的指令，发 /help 看看能做什么。';
    }

    if (out) {
      for (const seg of splitSegments(out, 200, 3)) { await sendText(channel, seg); logMsg('SEND', sessionKey, 'bot', seg); }
      proactive.noteBot(sessionKey);
    }
  }

  async function handoffLastIdiom(sessionKey) {
    const h = sessions.history(sessionKey, 6);
    for (let i = h.length - 1; i >= 0; i -= 1) {
      const m = String(h[i].text || '');
      const hit = m.match(/([\u4e00-\u9fa5]{4})/);
      if (hit) return hit[1];
    }
    return '';
  }
  function autoIdiom(tail) {
    const bank = ['一鸣惊人', '人山人海', '海阔天空', '空前绝后', '后来居上', '上善若水', '水到渠成', '成事在天'];
    return bank.find((x) => x.startsWith(tail)) || '心想事成';
  }

  return {
    handle, splitSegments, sessionKeyOf, awaiters, proactive,
    /** 供定时任务 / 工具调用：主动给某个目标发消息 */
    async push(target, text) {
      const channel = String(target || '').startsWith('group:')
        ? { type: 'group', id: String(target).slice(6) }
        : { type: 'private', id: String(target).replace(/^private:/, '') };
      const parts = splitSegments(text, 60, 3);
      let ok = 0;
      for (const p of parts) { if (await sendText(channel, p)) ok += 1; else break; }
      return ok > 0;
    },
  };
}
