// lib/responder.js
// 模型调用层（零外部依赖）。
//
// 引擎优先级：
//   1) dsh   —— 默认。调用 **DSH 当前选择的大模型**（ctx.get('llm') +
//               ctx.get('agentDefaultModel').currentSelection()），走宿主自己的
//               provider / 凭据 / 路由，用户不用另外填 API Key。
//   2) llm   —— 可选的 OpenAI 兼容直连（自带 endpoint + key）。
//   3) local —— 仅在显式选择 local 时使用，且**不再有固定套话**。
//
// ── 人格（重要）─────────────────────────────────────────────────────────
// system 提示词的**唯一来源**就是面板里的 `personaPrompt`：
//   · 面板填了 → system 原样等于面板文本，一个字符都不改写/不追加；
//   · 面板留空 → 不发送 system（而不是塞一段默认人设）。
// 代码里不存在任何硬编码的默认人格或默认兜底话术。
//
// system 以标准 `role:'system'` 消息随 messages 一起发送（DSH 的 llm 服务
// 会把首条 system 消息转成请求里的 system；`system` 这个顶层参数并非所有
// provider 适配器都认，用消息形式才通用）。

import { randomUUID } from 'node:crypto';

/** 单次回复的默认 token 上限：给足预算，避免思维链把预算吃光后没有任何可见文本。 */
const DEFAULT_MAX_TOKENS = 2000;

/** 身份类提问（问名字 / 问是谁 / 问会什么）。 */
const IDENTITY_RE = new RegExp([
  '你叫什么', '你叫啥', '你叫什', '你的名字', '你名字', '你贵姓',
  '你是谁', '你是什么', '你是哪位', '你是干什么的', '你干啥的', '你是做什么的',
  '自我介绍', '介绍(一下|下)?你自己', '介绍(一下|下)?自己',
  '你会(什么|啥|做什么|干什么|点啥)', '你能(做|干)(什么|啥)', '你有什么(能力|功能|本事)',
].join('|'));

/** 旧版硬编码兜底话术的特征词——一旦模型仍然这样敷衍，强制重试一次。 */
const EVASIVE_RE = /看具体情况|说说细节|给你个靠谱的答复|靠谱的答复/;

const NAME_PATTERNS = [
  /(?:名\s*字|昵称|称呼|姓名|代号)\s*[：:]\s*[“"'「『]?([^\s，,。、；;：:“"'」』\n]{1,12})/,
  /(?:你|我)(?:的名字)?(?:叫做|叫|名字是|名字叫)\s*[“"'「『]?([^\s，,。、；;：:“"'」』\n]{1,12})/,
  /叫做\s*[“"'「『]?([^\s，,。、；;：:“"'」』\n]{1,12})/,
];

function firstLine(s) {
  return String(s || '').split('\n')[0].trim().slice(0, 40);
}

/** 从人设文本里提取名字（提不到就返回空串，绝不编一个）。 */
export function personaName(text) {
  const s = String(text || '');
  if (!s) return '';
  for (const re of NAME_PATTERNS) {
    const m = s.match(re);
    const v = m && m[1] ? String(m[1]).trim() : '';
    if (v && !/^(我|你|他|她|它|名字|人设|机器人)$/.test(v)) return v.slice(0, 12);
  }
  return '';
}

/** 从人设文本里取一句“我是谁”的描述（用于离线兜底，不编造）。 */
function personaDesc(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(?:人设|身份|定位|设定|角色)\s*[：:]\s*(.+)$/);
    if (m && m[1]) return m[1].slice(0, 48);
  }
  for (const line of lines) {
    if (/^(?:名\s*字|昵称|称呼|姓名|代号)\s*[：:]/.test(line)) continue;
    if (line.length >= 6) return line.replace(/[：:].*$/, '').slice(0, 48);
  }
  return '';
}

/** 上一轮模型/引擎失败的原因，供面板展示与排障。 */
function errText(e) {
  if (!e) return '';
  const msg = String((e && e.message) || e);
  const code = e && e.code ? `[${e.code}] ` : '';
  return (code + msg).replace(/\s+/g, ' ').slice(0, 300);
}

export function createResponder(config, log, ctx, hooks) {
  const record = (hooks && typeof hooks.record === 'function')
    ? hooks.record
    : (entry) => { try { log && log.info && log.info(`[napcat] engine: ${JSON.stringify(entry)}`); } catch { /* ignore */ } };

  /**
   * 生效中的人设：每次现读配置（不做闭包快照），面板一保存立刻生效。
   * 这是 system 提示词的唯一来源。
   */
  function persona() {
    return String((config && config.personaPrompt) || '').trim();
  }

  /** 组装 system：**只**返回面板人格原文；面板为空时返回空串（不补任何文字）。 */
  function buildSystem(personaText) {
    const p = personaText != null ? String(personaText) : persona();
    return p.trim();
  }

  /** 把最近若干轮记忆折成一段可读上下文（放在 user 消息里，不进 system）。 */
  function historyBlock(history, limit = 12) {
    const rows = (history || []).slice(-limit);
    if (!rows.length) return '';
    const lines = rows.map((h) => {
      const who = h.role === 'user' ? (h.name || '对方') : (h.self || '我');
      const text = String(h.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return text ? `${who}：${text}` : '';
    }).filter(Boolean);
    if (!lines.length) return '';
    return `【最近的对话记录，供你接话参考，不要逐字复述】\n${lines.join('\n')}`;
  }

  /**
   * 组装 user 消息：历史 + 摘要 + 知识库 + （必要时）身份问答定向指令 + 对方原话。
   * 这里只放「上下文」和「排版要求」，身份设定始终只来自 system。
   */
  function buildUser(userText, history, summary, kbBlock, opts) {
    const o = opts || {};
    const blocks = [];
    const hist = historyBlock(history);
    if (hist) blocks.push(hist);
    if (summary) blocks.push('【更早对话的摘要，供你保持连贯】\n' + String(summary).slice(0, 1200));
    if (kbBlock) blocks.push(String(kbBlock).slice(0, 2000));
    if (o.identity) {
      blocks.push('【本轮是身份类提问：请直接用第一人称按你的身份设定回答（如“我叫…”“我是…”“我会…”），'
        + '不要反问，也不要让对方先补充细节。】');
    }
    if (o.hardIdentity) {
      blocks.push('【必须直接回答：你就是你设定里的那个人，用第一人称说出自己的名字/身份/能做什么。'
        + '禁止回答“看具体情况”“你先说说细节”这类回避话术。】');
    }
    blocks.push('【输出格式（只约束排版，不改变你的身份设定）】像 QQ 聊天一样口语化、简短，一般 1~3 句；'
      + '不用 Markdown 标题/列表/代码块；不要说明你的回复过程。');
    blocks.push('【对方刚发来的消息】\n' + String(userText || ''));
    return blocks.join('\n\n');
  }

  // ── 模型路由 ─────────────────────────────────────────────────────────
  function dshRoute() {
    try {
      const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
      const sel = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined;
      if (!sel || !sel.provider || !sel.model) return null;
      return { provider: String(sel.provider), model: String(sel.model) };
    } catch { return null; }
  }

  function dshLlm() {
    try {
      const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
      return llm && typeof llm.stream === 'function' ? llm : null;
    } catch { return null; }
  }

  function mkMessage(role, content, sourceKind) {
    return { id: randomUUID(), role, content, source: { kind: sourceKind || (role === 'user' ? 'plugin:dsh-napcat-bot' : 'system-prompt') } };
  }

  /**
   * 单次流式调用 DSH 模型。
   * @param {{system:string, user:string, images?:string[], model?:object, maxTokens?:number,
   *          reasoningEffort?:string, withImages?:boolean, onDelta?:Function}} o
   * @returns {Promise<string>}
   */
  async function dshAttempt(o) {
    const llm = dshLlm();
    const base = dshRoute();
    if (!llm || !base) throw new Error('DSH 模型服务不可用（宿主 llm / 默认模型未就绪）');
    const route = {
      provider: (o.model && o.model.provider) || base.provider,
      model: (o.model && o.model.model) || base.model,
    };

    const messages = [];
    const sys = String(o.system == null ? '' : o.system).trim();
    // system 只来自面板人格；为空则整条不发送，绝不用默认文字填空。
    if (sys) messages.push(mkMessage('system', [{ type: 'text', text: sys }], 'system-prompt'));

    const content = [{ type: 'text', text: String(o.user || '') }];
    if (o.withImages !== false && Array.isArray(o.imageRefs) && o.imageRefs.length) {
      // 原生多模态：图片以 DSH 附件引用进入同一条 user 消息，宿主适配器会把它
      // 转成 base64 图片块发给当前主模型（DeepSeek-V4.1-Flash 自带视觉）。
      for (const ref of o.imageRefs) {
        if (ref && ref.attachmentId) content.push({ type: 'image', attachment: ref });
      }
    } else if (Array.isArray(o.images) && o.images.length) {
      // 只有 URL、没有附件句柄时（极少见），退化成一句提示，保证请求不整条失败。
      const urls = o.images.filter((u) => /^https?:\/\//i.test(String(u || ''))).slice(0, 3);
      if (urls.length) content.push({ type: 'text', text: `（对方同时发来图片：${urls.join(' | ')}）` });
    }
    messages.push(mkMessage('user', content));

    const params = {
      provider: route.provider,
      model: route.model,
      messages,
      maxTokens: Number(o.maxTokens) || DEFAULT_MAX_TOKENS,
    };
    if (o.reasoningEffort) params.reasoningEffort = o.reasoningEffort;

    let text = '';
    let failure = null;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, 60000) : null;
    if (controller) params.signal = controller.signal;

    try {
      const stream = llm.stream(params);
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          text += chunk.text;
        } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && !text) {
          text = String(chunk.block.text || '');
        } else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind
          && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'length' && chunk.reason.kind !== 'tool-calls') {
          failure = chunk.reason.failure || chunk.reason;
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    const out = String(text || '').trim();
    if (!out) {
      const why = failure ? ((failure.code ? `[${failure.code}] ` : '') + (failure.message || failure.code || '未知')) : '模型未返回可见文本';
      const err = new Error('模型返回空内容：' + why);
      if (failure && failure.code) err.code = failure.code;
      throw err;
    }
    return out;
  }

  /**
   * 带兜底重试的调用：
   *   ① 原样（不给 reasoningEffort 覆盖，maxTokens 给足）
   *   ② 关掉思维链（reasoningEffort:'off'）—— 思维链把 token 预算吃光时会返回空内容
   *   ③ 不带图片再试一次（图片处理出错时救回来）
   * 每次失败都会写一条 engine 记录，面板能看到具体原因。
   */
  async function dshStream(o) {
    const maxTokens = Number(o.maxTokens) || DEFAULT_MAX_TOKENS;
    const hasImages = Array.isArray(o.imageRefs) && o.imageRefs.length > 0;
    // 带图时不降级成「不带图」：那会退化成看不见图的瞎猜，不如交给上层走人设兜底台词。
    const plans = hasImages
      ? [
        { label: 'default', maxTokens },
        { label: 'reasoning-off', maxTokens, reasoningEffort: 'off' },
      ]
      : [
        { label: 'default', maxTokens },
        { label: 'reasoning-off', maxTokens, reasoningEffort: 'off' },
        // 有些 provider 不支持 'off'，也不认图片块：最后再用「原样 + 不带图片」兜一次
        { label: 'no-images', maxTokens, withImages: false },
      ];
    const errors = [];
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i];
      try {
        const out = await dshAttempt({ ...o, ...plan });
        if (o.onDelta) { try { o.onDelta(out); } catch { /* ignore */ } }
        record({
          at: Date.now(), ok: true, engine: 'dsh', plan: plan.label, chars: out.length,
          personaChars: String(o.system || '').length,
          ...(errors.length ? { recovered: errors.slice() } : {}),
        });
        return out;
      } catch (e) {
        const msg = errText(e);
        errors.push(`${plan.label}: ${msg}`);
        // 每次失败都单独记一条，排障时能看到「先失败后重试成功」的完整链路
        record({
          at: Date.now(), ok: false, engine: 'dsh', plan: plan.label, errors: [msg],
          personaChars: String(o.system || '').length,
        });
        // 思维链关闭不被支持、或配置非法时，后续重试没意义
        const code = String((e && e.code) || '');
        if (code === 'UNSUPPORTED_REASONING_EFFORT' && plan.reasoningEffort) continue;
        if (i === plans.length - 1) break;
      }
    }
    throw new Error(errors[errors.length - 1] || 'DSH 模型调用失败');
  }

  /** OpenAI 兼容直连（非流式，够用且更稳）。system 同样只放面板人格。 */
  async function llmReply(userText, history, summary, personaText, opts) {
    const o = opts || {};
    const sys = buildSystem(personaText);
    const user = buildUser(userText, history, summary, o.kbBlock, { identity: o.identity });
    const msgs = [];
    if (sys) msgs.push({ role: 'system', content: sys });
    msgs.push({ role: 'user', content: user });
    const res = await fetch(config.llmEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llmApiKey}` },
      body: JSON.stringify({
        model: config.llmModel || 'deepseek-chat',
        messages: msgs,
        temperature: 0.8,
        max_tokens: DEFAULT_MAX_TOKENS,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    if (!text) throw new Error('empty completion');
    return String(text).trim();
  }

  /**
   * 离线应答：**没有**任何固定套话。
   * 唯一能生成的，是从面板人设里读出来的「我是谁」（名字 + 一句身份描述）。
   * 其余情况返回空串 → 上层不发消息（宁可不回，也不敷衍）。
   */
  function offlineReply(userText) {
    const p = persona();
    if (!p) return '';
    if (!IDENTITY_RE.test(String(userText || ''))) return '';
    const name = personaName(p);
    if (!name) return '';
    const desc = personaDesc(p);
    return desc ? `我是${name}呀～${desc}。` : `我是${name}呀～`;
  }

  /** 显式 local 模式的轻量接话（不回答任何问题，只表示在听）。 */
  function localAck(userText) {
    const q = String(userText || '');
    if (IDENTITY_RE.test(q)) return offlineReply(q);
    if (/[?？]$|吗[?？]?$|怎么|为什么|为何|如何|啥|什么|哪位|谁|多少|哪里/.test(q)) return '';
    const name = personaName(persona());
    const acks = name ? ['嗯嗯，在呢。', '收到啦～', '好哦。'] : ['嗯嗯，在呢。', '收到。', '好。'];
    return acks[Math.floor(Math.random() * acks.length)];
  }

  return {
    persona,
    buildSystem,

    /**
     * 生成回复（非流式，内部仍走流式接口）。任何失败都降级，绝不抛。
     */
    async reply(chatId, userText, history = [], summary = '', personaText) {
      const mode = String(config.replyMode || 'dsh');
      const personaForCall = personaText != null ? String(personaText) : persona();
      const o = { identity: IDENTITY_RE.test(String(userText || '')) };
      if (mode !== 'local') {
        if (mode === 'llm' && config.llmApiKey) {
          try { return await llmReply(userText, history, summary, personaForCall, o); }
          catch (e) { log.warn(`[napcat] 直连 LLM 失败，改用 DSH 模型: ${errText(e)}`); }
        }
        try {
          return await dshStream({
            system: buildSystem(personaForCall),
            user: buildUser(userText, history, summary, '', o),
          });
        } catch (e) { log.warn(`[napcat] DSH 模型调用失败: ${errText(e)}`); }
      }
      return mode === 'local' ? localAck(userText) : offlineReply(userText);
    },

    /**
     * 流式生成（面板/测试用）。system 只来自面板人格。
     * 模型不可用时不会返回固定套话，最多返回由人设推导出的一句身份回答。
     */
    async replyStream(opts) {
      const o = typeof opts === 'object' && opts !== null
        ? opts
        : { userText: String(opts || '') };
      const userText = String(o.userText || '');
      const history = o.history || [];
      const summary = o.summary || '';
      const onDelta = typeof o.onDelta === 'function' ? o.onDelta : () => {};
      const personaForCall = o.persona != null ? String(o.persona) : persona();
      const identity = IDENTITY_RE.test(userText);
      const system = buildSystem(personaForCall);
      const mode = String(config.replyMode || 'dsh');
      const ctxOpts = { identity, kbBlock: o.kbBlock };

      if (mode !== 'local') {
        if (mode === 'llm' && config.llmApiKey) {
          try {
            const t = await llmReply(userText, history, summary, personaForCall, ctxOpts);
            onDelta(t);
            return t;
          } catch (e) { log.warn(`[napcat] 直连 LLM 失败，改用 DSH 模型: ${errText(e)}`); }
        }
        let out = '';
        try {
          out = await dshStream({
            system,
            user: buildUser(userText, history, summary, o.kbBlock, ctxOpts),
            images: Array.isArray(o.images) ? o.images : [],
            imageRefs: Array.isArray(o.imageRefs) ? o.imageRefs : [],
            model: o.model || null,
            // 轻量判定（搜索判定 / 看图提词）可以点名要一个很小的 maxTokens
            ...(o.maxTokens ? { maxTokens: Number(o.maxTokens) } : {}),
          });
        } catch (e) {
          log.warn(`[napcat] DSH 模型调用失败: ${errText(e)}`);
          out = '';
        }
        // 模型仍然用「看具体情况 / 你先说说细节」敷衍时，带硬指令重试一次
        if (out && identity && EVASIVE_RE.test(out) && String(personaForCall || '').trim()) {
          try {
            const retry = await dshStream({
              system,
              user: buildUser(userText, history, summary, o.kbBlock, { identity: true, hardIdentity: true }),
              images: [],
              model: o.model || null,
            });
            if (retry) out = retry;
          } catch (e) { log.warn(`[napcat] 身份问答重试失败: ${errText(e)}`); }
        }
        if (out) {
          try { onDelta(out); } catch { /* ignore */ }
          return out;
        }
        const fb = offlineReply(userText);
        if (fb) { try { onDelta(fb); } catch { /* ignore */ } }
        else log.warn('[napcat] 模型不可用且无离线应答，本轮不发送（不再输出固定套话）');
        return fb;
      }

      const t = localAck(userText);
      if (t) { try { onDelta(t); } catch { /* ignore */ } }
      return t;
    },

    /**
     * 上下文压缩：把较早的对话折成一段摘要。
     * 失败时退化为「截断拼接」，保证永远能返回东西。
     */
    async summarize(prevSummary, messages) {
      const body = (messages || [])
        .map((m) => `${m.role === 'user' ? (m.name || '对方') : '我'}：${String(m.text || '').slice(0, 200)}`)
        .join('\n');
      if (!body) return String(prevSummary || '');
      const sys = '你是一个对话摘要器。把给定的聊天记录压缩成不超过 300 字的中文摘要，'
        + '保留人物关系、关键事实、约定和情绪基调；不要编造，不要评论，直接输出摘要正文。';
      const user = (prevSummary ? `【已有摘要】\n${prevSummary}\n\n` : '') + `【新增对话】\n${body}`;
      try {
        const mode = String(config.replyMode || 'dsh');
        if (mode === 'local') throw new Error('local 模式不调用模型');
        return await dshStream({ system: sys, user, maxTokens: 600 });
      } catch (e) {
        log.warn(`[napcat] 摘要生成失败，改用截断兜底: ${errText(e)}`);
        const flat = (prevSummary ? prevSummary + '\n' : '') + body;
        return flat.slice(-1000);
      }
    },

    /** 供面板显示当前实际使用的链路。 */
    describe() {
      const mode = String(config.replyMode || 'dsh');
      const route = dshRoute();
      const hasLlm = !!(mode === 'llm' && config.llmApiKey);
      const hasDsh = !!(dshLlm() && route);
      const p = persona();
      return {
        mode,
        dshAvailable: hasDsh,
        route: route || null,
        directLlm: hasLlm,
        effective: hasLlm ? 'llm' : (hasDsh && mode !== 'local' ? 'dsh' : 'local'),
        personaChars: p.length,
        personaName: personaName(p),
        systemIsPanel: true,
      };
    },
  };
}
