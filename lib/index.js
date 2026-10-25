// lib/index.js
// dsh-napcat-bot 主入口（服务端半边，运行在 Node / Electron 主进程）。
//
// 开箱即用目标：装好插件、启用 → 自动拉起内置 NapCat → 侧边面板里扫码登录 QQ →
// 私聊 / 群内 @ 就能收到 AI 回复。中间的地址、端口、两类 token 全部由插件自理。
//
// 设计约束：
//   1. apply() 绝不向外抛错 —— 任何异常都在内部吞掉，保证插件能正常注册。
//   2. 只使用确定存在的能力（ctx.get 取可选服务，缺失则降级）。
//   3. 零外部依赖：仅 Node 内置 + DSH 自带的 schemastery。
//
// 两个 Token 严格分开（面板也分开显示）：
//   · WebUI 管理 Token  —— 登录 http://127.0.0.1:6099/webui 用；插件启动时写入，
//                          再从 NapCat 启动日志自动读取校验。
//   · OneBot access_token —— 插件 ↔ NapCat 通信用；首次启用由插件随机生成，并自动
//                          同步写进插件配置与 NapCat 的 onebot11 配置，用户无需填写。
//
// HTTP 端点（面板使用）。注意 webServer 的 prefix 匹配是
// `pathname === prefix || pathname.startsWith(prefix + '/')`，
// 所以 prefix 路由的 path 结尾**不能**带斜杠，否则永远 404。
//   GET  /napcat-bot/api/status
//   GET  /napcat-bot/api/config        POST /napcat-bot/api/config
//   GET  /napcat-bot/api/webui
//   POST /napcat-bot/api/webui/token
//   POST /napcat-bot/api/napcat/{start|stop|restart}
//   GET  /napcat-bot/api/napcat/log?tail=200
//   POST /napcat-bot/api/client-report

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import z from '@deepseek-ai/schemastery';
import { createNapCat, normalizeWsUrl } from './napcat.js';
import { createMemory } from './memory.js';
import { createResponder } from './responder.js';
import { createRateLimiter } from './risk.js';
import { createPipeline } from './pipeline.js';
import { createSessions } from './sessions.js';
import { createState } from './state.js';
import { createKb } from './kb.js';
import { createTts } from './tts.js';
import { createVision } from './vision.js';
import { createSearch } from './search.js';
import { clampCooldownSec } from './proactive.js';
import { createLocalTts } from './tts-local.js';
import { createEmbeddedNapcat, findQQ, parseTokenFromLog } from './napcat-embedded.js';

export const name = 'dsh-napcat-bot';

// ============================================================================
// 配置项 schema（同时作为面板字段的权威定义）
// ============================================================================
export const Config = z
  .object({
    // —— 内置 NapCat 进程 ——
    autoStartNapCat: z.boolean().default(true).description('插件启用时自动启动插件内置的 NapCat（带进程检测，绝不重复多开）。'),
    stopNapCatOnDisable: z.boolean().default(true).description('禁用插件 / 退出 DSH 时，自动停掉由本插件启动的 NapCat 进程。'),
    webuiPort: z.number().default(6099).description('内置 NapCat WebUI 监听端口（默认 6099）。'),
    webuiToken: z.string().default('').description('WebUI 管理 Token。留空即自动生成并从启动日志读取，无需手填。'),
    qqPath: z.string().default('').description('QQ.exe 路径；留空自动探测（NapCat 通过注入 QQ 运行，需已安装官方 QQ NT）。'),
    napcatHome: z.string().default('').description('内置 NapCat 目录；留空使用插件自带 vendor/napcat。'),
    napcatStartTimeout: z.number().default(60000).description('等待内置 NapCat 就绪的超时（毫秒）。'),

    // —— OneBot 连接（地址与 token 都由插件自动维护）——
    napcatHttpUrl: z.string().default('http://127.0.0.1:3000').description('OneBot HTTP 地址（发送消息）。插件自动写入 NapCat 配置，无需修改。'),
    napcatWsUrl: z.string().default('ws://127.0.0.1:3001').description('OneBot 正向 WS 地址（接收消息）。插件自动写入 NapCat 配置，无需修改。'),
    napcatToken: z.string().default('').description('OneBot access_token（插件↔NapCat 通信）。留空则首次启用自动随机生成并同步到 NapCat，用户无需填写。'),
    napcatConsoleUrl: z.string().default('http://127.0.0.1:6099/webui').description('WebUI 地址，面板「NapCat WebUI」标签页内嵌此地址（自动附加 token）。'),
    receiveMode: z.string().default('ws').description('消息接收方式：ws（默认，正向 WebSocket）或 webhook。'),
    webhookPath: z.string().default('/napcat-bot/onebot').description('webhook 模式下的上报路径。'),
    selfQQ: z.string().default('').description('机器人自己的 QQ 号；留空会在登录后自动获取并记住。'),

    // —— WS 重连策略 ——
    wsRetryInterval: z.number().default(2000).description('WS 首次重连间隔（毫秒），之后指数退避。'),
    wsRetryMaxInterval: z.number().default(15000).description('WS 重连间隔上限（毫秒）。'),
    wsMaxRetries: z.number().default(0).description('WS 最大连续重试次数；0 表示一直重试（推荐，QQ 断线重连后能自动恢复）。'),
    wsHeartbeatTimeout: z.number().default(100000).description('多久收不到任何数据（含心跳）就强制重连（毫秒）。'),

    // —— 人格与回复 ——
    // 注意：默认值是**空字符串**，插件里不再内置任何固定人设（旧版硬编码的“小深”已移除）。
    personaPrompt: z.string().default('').description('系统人格提示词（最高优先级）。留空表示不设定身份，填什么就按什么说话。'),
    replyMode: z.string().default('dsh').description('回复引擎：dsh（默认，用 DSH 当前选中的大模型）/ llm（自填 OpenAI 兼容接口）/ local（离线兜底）。'),
    llmEndpoint: z.string().default('https://api.deepseek.com/v1/chat/completions').description('仅在 replyMode=llm 时使用的直连地址。'),
    llmApiKey: z.string().default('').description('仅在 replyMode=llm 时使用的 API Key。'),
    llmModel: z.string().default('deepseek-chat').description('仅在 replyMode=llm 时使用的模型名。'),
    botName: z.string().default('我').description('机器人自称（写进对话记忆里的署名，仅用于上下文展示）。'),

    // —— 会话策略 ——
    groupUniqueSession: z.boolean().default(true).description('群聊独立会话：开启后群内每个 QQ 用户各有独立上下文、互不串记忆；关闭则全群共用一套。私聊永远按 QQ 独立，不受此开关影响。'),
    groupWakeTimeoutSec: z.number().default(120).description('群聊连续对话免@超时（秒）。在该时间内继续发言不需要再次 @ 机器人。'),
    contextCompress: z.boolean().default(true).description('上下文自动压缩：历史过长时自动总结成摘要，降低 token 消耗。'),
    contextMaxChars: z.number().default(2400).description('触发压缩的历史字符数阈值。'),
    superUsers: z.string().default('').description('超级管理员 QQ 号（逗号分隔），可执行 /op /ban /model 等管理指令。'),
    blacklist: z.string().default('').description('黑名单 QQ 号（逗号分隔），这些人的消息一律丢弃。'),
    whitelist: z.string().default('').description('用户白名单（逗号分隔）。留空表示不限制；填了则只响应名单内的人。'),
    groupBlacklist: z.string().default('').description('群黑名单（群号，逗号分隔），这些群的消息一律丢弃。'),
    groupWhitelist: z.string().default('').description('群白名单（群号，逗号分隔）。留空表示不限制。'),

    // —— 多服务商 / 多模态 / 语音 ——
    providers: z.string().default('').description('可用服务商名称列表（逗号分隔），供 /provider 切换；留空则只用 DSH 当前模型。'),
    providerOverride: z.string().default('').description('全局默认服务商覆盖（留空 = 跟随 DSH 当前选择）。'),
    modelOverride: z.string().default('').description('全局默认模型覆盖（留空 = 跟随 DSH 当前选择）。'),
    visionEnabled: z.boolean().default(true).description('识图总开关：开启后 QQ 图片直接随对话发给当前主模型（V4.1-Flash 自带视觉），再用面板人设的语气说出来。'),
    visionPrompt: z.string().default('看懂这张图的梗和情绪，顺着对方的话接梗互动，不要描述画面').description('识图提示词（默认模式）：默认「看懂这张图的梗和情绪，顺着对方的话接梗互动，不要描述画面」。只有对方说「描述一下这张图 / 图里长啥样」这类话时，才改成描述画面细节。'),
    searchEnabled: z.boolean().default(true).description('联网搜索总开关（手动「搜一下」+ 自动查证都受它控制）。'),
    searchAutoEnabled: z.boolean().default(true).description('不懂自动搜索：遇到时效信息、现实实体资料、拿不准的事实，自动联网查证（默认开启）。闲聊/情绪/玩梗不会搜。'),
    searchAutoJudge: z.boolean().default(true).description('自动搜索前用模型二次判定（更准，每轮多一次很轻的调用）。关闭则只按本地关键词判断。'),
    searchEndpoint: z.string().default('').description('自定义搜索接口（可选）。留空则用宿主 DeepSeek 原生搜索；支持 SearXNG 兼容 JSON（?q= 查询）。'),
    searchApiKey: z.string().default('').description('自定义搜索接口的 API Key（Bearer，可选）。'),
    searchMaxResults: z.number().default(5).description('每次搜索取多少条结果（1~8，默认 5）。'),
    ttsEnabled: z.boolean().default(false).description('语音回复总开关（旧版兼容项；模式以下面的 ttsMode 为准）。'),
    ttsUrl: z.string().default('').description('TTS 接口地址（POST {text, voice} → 返回音频二进制或 {audio_base64}）。'),
    ttsVoice: z.string().default('').description('固定音色（关闭「随机音色」时使用）。'),
    ttsMode: z.string().default('off').description('语音模式：off 不转语音 / all 全部消息转语音 / keyword 关键词触发 / random 性格随机模式（想发就发）。'),
    ttsProbability: z.number().default(40).description('性格随机模式的语音概率（0~100%，默认 40%）。0=永不发，100=次次发。'),
    ttsSmartWeight: z.boolean().default(true).description('人设智能权重：短句/活泼内容更容易出声，长段解释/安静 emo 内容自动降低概率。'),
    ttsVoiceRandom: z.boolean().default(true).description('随机音色：每次发语音都从音色池里随机挑一个；关闭则固定用 ttsVoice。'),
    ttsVoicePool: z.string().default('软萌少女,甜妹,奶音,软糯小助手').description('音色池（逗号分隔）。请填你的 TTS 服务认识的音色名/ID。'),
    ttsKeywords: z.string().default('语音,发语音,说给我听,念一下,用说的,听你声音,朗读').description('关键词触发模式的触发词（逗号分隔）。'),
    ttsModel: z.string().default('').description('TTS 模型名（可选，仅 OpenAI 兼容 /v1/audio/speech 这类接口需要，如 tts-1）。'),
    ttsLocalEngine: z.boolean().default(true).description('内置语音引擎：没填 TTS 接口地址时，用系统自带语音（Windows SAPI）离线合成，开箱即用。'),
    ttsLocalVoice: z.string().default('').description('内置语音音色名（可选，留空=系统默认中文语音）。'),
    ttsReplaceText: z.boolean().default(true).description('命中语音时只发语音、不发文字；关闭则文字+语音都发。回复超过可合成字数时会自动补发文字。'),
    ttsMaxChars: z.number().default(300).description('单条语音最多合成多少字（超出部分不合成，此时会自动补发文字）。'),

    // —— 知识库 ——
    kbEnabled: z.boolean().default(true).description('知识库检索总开关（按规则绑定具体知识库）。'),

    // —— 行为与风控 ——
    proactiveEnabled: z.boolean().default(true).description('空闲主动发言：私聊里长时间没人说话时，主动开口关心/接话（默认开启）。'),
    proactiveCooldownSec: z.number().default(180).description('主动发言最小冷却时间（秒，60~1800，默认 180）：发自后必须等这么久才可能再来一条。'),
    proactiveInGroup: z.boolean().default(false).description('群聊也允许主动发言（默认关闭，只在私聊生效；规则面板可单独开）。'),
    memoryEnabled: z.boolean().default(true).description('记忆存储开关。'),
    groupReplyOnlyAt: z.boolean().default(true).description('群消息仅在 @ 机器人（或免@有效期内）时回复。'),
    messageIntervalLimit: z.number().default(3000).description('同一会话两次发送的最小间隔（毫秒）。'),
    maxReplyPerMin: z.number().default(20).description('同一会话每分钟最大回复数（风控上限）。'),
  })
  .description(
    'DeepSeek Harness · NapCat QQ Bot：内置 NapCat（随插件分发，启用即自动启动并监听 6099），自动配置 OneBot HTTP/WS 与两类 Token，让 AI 通过 QQ 私聊/群聊与真人对话。'
  );

function dataDir() {
  const base = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'napcat-bot')
    : path.join(os.homedir(), '.dsh', 'napcat-bot');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* ignore */ }
  return base;
}

const configPath = () => path.join(dataDir(), 'config.json');

function loadSavedConfig() {
  try {
    const obj = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

function saveConfigFile(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); return true; } catch { return false; }
}

function portOf(url, fallback) {
  try { const u = new URL(String(url)); return Number(u.port) || fallback; } catch { return fallback; }
}

/** 展示用：去掉查询串（access_token 不应该出现在面板的地址里）。 */
function stripQuery(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  return i < 0 ? s : s.slice(0, i);
}

function randomToken(len = 24) {
  const chars = 'abcdef0123456789';
  let t = '';
  for (let i = 0; i < len; i += 1) t += chars[Math.floor(Math.random() * 16)];
  return t;
}

/** 取 schema 里每个字段的默认值（用于判断「用户到底有没有改过这一项」）。 */
function schemaDefaults() {
  const out = {};
  try {
    for (const [key, val] of Object.entries(Config.dict || {})) {
      out[key] = val && val.meta && 'default' in val.meta ? val.meta.default : undefined;
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * 合并配置：**宿主配置优先，但只在用户真的改过时**。
 *
 * 背景（真实 bug）：以前是「本地 config.json 无条件覆盖宿主配置」，
 * 于是只要有过一次默认值落盘，之后在 DSH 的插件设置页里改人格就永远不生效
 * ——面板/模型一直用旧的「小深」。
 *
 * 现在的规则：
 *   · 宿主值 ≠ schema 默认值  → 说明用户是在宿主 UI 里显式改的 → 宿主值赢；
 *   · 否则（宿主还是默认值）  → 用本地保存的值（用户在插件面板里改的）。
 * 两边都改过时以宿主为准，并在日志里说明，避免「到底听谁的」不明确。
 */
function mergeConfig(hostConfig, saved) {
  const host = hostConfig && typeof hostConfig === 'object' ? hostConfig : {};
  const file = saved && typeof saved === 'object' ? saved : null;
  const merged = { ...host };
  if (!file) return merged;

  const defs = schemaDefaults();
  const fromHost = [];
  for (const key of Object.keys(defs)) {
    if (!(key in file)) continue;
    const hasDefault = defs[key] !== undefined;
    const hostVal = host[key];
    const explicitInHost = hasDefault && hostVal !== undefined && hostVal !== defs[key];
    if (explicitInHost) { fromHost.push(key); continue; }
    merged[key] = file[key];
  }
  // 文件里有、schema 里没有的内部字段（__schemaVersion 等）也带过来
  for (const key of Object.keys(file)) {
    if (!(key in merged)) merged[key] = file[key];
  }
  if (fromHost.length) merged.__hostOverrides = fromHost;
  return merged;
}

// ============================================================================
// 插件主体
// ============================================================================
export function apply(ctx, config) {
  let raw = ctx && ctx.logger;
  let logger = console;
  try {
    if (typeof raw === 'function') logger = raw('dsh-napcat-bot') || console;
    else if (raw) logger = raw;
  } catch { logger = console; }
  const log = {
    info: (m) => { try { (logger.info ? logger.info(m) : console.info(m)); } catch { console.info(m); } },
    warn: (m) => { try { (logger.warn ? logger.warn(m) : console.warn(m)); } catch { console.warn(m); } },
    error: (m) => { try { (logger.error ? logger.error(m) : console.error(m)); } catch { console.error(m); } },
  };

  // ── 防重复实例 ────────────────────────────────────────────────────────
  // 宿主有可能把同一个插件加载两次（bundle 配置 + row 配置各一次）。
  // 那样会开两条 OneBot WS 连接，同一条 QQ 消息被两个实例各回一次
  // ——用户看到的就是「连续两条一模一样的回复」。这里让新实例接管并停掉旧的。
  const INSTANCE_KEY = Symbol.for('dsh-napcat-bot.instance');
  try {
    const prev = globalThis[INSTANCE_KEY];
    if (prev && typeof prev.stop === 'function') {
      log.warn('[napcat] 检测到插件被重复加载，正在停用上一个实例（避免同一条消息回复两次）');
      try { prev.stop(); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  // 生效中的配置（可变）：宿主配置与本地保存值按「谁被显式改过」合并。
  // 见 mergeConfig 注释——这一步直接决定面板里填的人格会不会生效。
  const liveConfig = mergeConfig(config, loadSavedConfig());
  try {
    const saved = loadSavedConfig();
    if (saved && JSON.stringify(saved) !== JSON.stringify(liveConfig)) saveConfigFile(liveConfig);
    if (liveConfig.__hostOverrides && liveConfig.__hostOverrides.length) {
      log.info(`[napcat] 以下配置以 DSH 宿主设置为准：${liveConfig.__hostOverrides.join(', ')}`);
    }
  } catch { /* ignore */ }

  // ── 一次性迁移（≤1.2.0 → 1.3.0）──
  // 旧版本默认 replyMode='local'（只会离线套话），且没有 dsh 引擎；
  // 升级后要切到「DSH 当前大模型」，否则用户会以为模型没接上。
  try {
    const saved = loadSavedConfig();
    const ver = Number((saved && saved.__schemaVersion) || 0);
    if (ver < 2) {
      if (!saved || String(saved.replyMode || '') === '' || String(saved.replyMode || '') === 'local') {
        liveConfig.replyMode = 'dsh';
      }
      delete liveConfig.autoRestartOnConfig; // 1.3.0 起改为自动处理
      liveConfig.__schemaVersion = 2;
      saveConfigFile(liveConfig);
      log.info('[napcat] 已迁移旧版本配置（回复引擎切换为 DSH 当前大模型）');
    }

    // ── 1.6.0：清掉旧版硬编码的默认人设 ──
    // 以前 schema 的默认值是「你是一个叫“小深”的亲切 AI 伙伴…」，它会随首次保存落盘，
    // 于是用户改成「大肥鱼」也仍然被旧值盖住（或模型仍按小深说话）。
    // 这里识别出「原封不动的旧默认值」并清空，让面板里填的内容真正成为唯一来源。
    const LEGACY_PERSONA = '你是一个叫“小深”的亲切 AI 伙伴，说话自然、像真人朋友，不啰嗦，偶尔带点幽默。';
    if (ver < 3) {
      if (String(liveConfig.personaPrompt || '').trim() === LEGACY_PERSONA) {
        liveConfig.personaPrompt = '';
        log.info('[napcat] 已清除旧版内置人设（“小深”），人设现在完全以面板填写为准');
      }
      if (liveConfig.groupUniqueSession === undefined) liveConfig.groupUniqueSession = true;
      if (liveConfig.groupWakeTimeoutSec === undefined) liveConfig.groupWakeTimeoutSec = 120;
      if (liveConfig.contextCompress === undefined) liveConfig.contextCompress = true;
      liveConfig.__schemaVersion = 3;
      saveConfigFile(liveConfig);
    }

    // ── 2.0.2：TTS 从「布尔开关」升级为「四模式」──
    // 老配置里 ttsEnabled=true 就是「每条都转语音」，迁移为 ttsMode='all'，行为不变。
    if (ver < 4) {
      const m = String(liveConfig.ttsMode || '').trim();
      if (liveConfig.ttsEnabled && (!m || m === 'off')) liveConfig.ttsMode = 'all';
      else if (!m) liveConfig.ttsMode = 'off';
      if (liveConfig.ttsProbability === undefined) liveConfig.ttsProbability = 40;
      if (liveConfig.ttsSmartWeight === undefined) liveConfig.ttsSmartWeight = true;
      if (liveConfig.ttsVoiceRandom === undefined) liveConfig.ttsVoiceRandom = true;
      if (liveConfig.ttsReplaceText === undefined) liveConfig.ttsReplaceText = true;
      if (!Number(liveConfig.ttsMaxChars)) liveConfig.ttsMaxChars = 300;
      liveConfig.__schemaVersion = 4;
      saveConfigFile(liveConfig);
      log.info(`[napcat] TTS 模式已升级：${liveConfig.ttsMode}（概率 ${liveConfig.ttsProbability}% · 随机音色 ${liveConfig.ttsVoiceRandom ? '开' : '关'}）`);
    }

    // ── 2.3.0：识图默认提示词换成「简短描述图片内容，不要冗长」，并补齐开箱即用默认值 ──
    if (ver < 5) {
      const oldPrompt = '描述这张图片，简短一点';
      if (!String(liveConfig.visionPrompt || '').trim() || String(liveConfig.visionPrompt || '').trim() === oldPrompt) {
        liveConfig.visionPrompt = '简短描述图片内容，不要冗长';
      }
      if (liveConfig.visionEnabled === undefined) liveConfig.visionEnabled = true;
      liveConfig.__schemaVersion = 5;
      saveConfigFile(liveConfig);
      log.info('[napcat] 识图配置已补齐默认值（开关开 · 提示词「简短描述图片内容，不要冗长」）');
    }

    if (ver < 6) {
      if (liveConfig.visionEnabled === undefined) liveConfig.visionEnabled = true;
      if (liveConfig.ttsLocalEngine === undefined) liveConfig.ttsLocalEngine = true;
      liveConfig.__schemaVersion = 6;
      saveConfigFile(liveConfig);
    }

    // ── 2.4.0：识图改用主模型原生视觉（V4.1-Flash），移除独立识图接口配置 ──
    if (ver < 7) {
      const olds = ['描述这张图片，简短一点', '简短描述图片内容，不要冗长', ''];
      const cur = String(liveConfig.visionPrompt || '').trim();
      if (!cur || olds.includes(cur)) liveConfig.visionPrompt = '简短描述这张图片内容';
      for (const k of ['visionEndpoint', 'visionApiKey', 'visionModel']) {
        if (Object.prototype.hasOwnProperty.call(liveConfig, k)) delete liveConfig[k];
      }
      if (liveConfig.visionEnabled === undefined) liveConfig.visionEnabled = true;
      liveConfig.__schemaVersion = 7;
      saveConfigFile(liveConfig);
      log.info('[napcat] 识图已切换为主模型原生视觉（V4.1-Flash），独立识图接口配置已移除');
    }

    // ── 2.5.0：主动发言改为「空闲触发 + 上下文生成」；旧的「每 N 分钟定时问候」下线 ──
    if (ver < 8) {
      if (liveConfig.proactiveEnabled === undefined) liveConfig.proactiveEnabled = true;
      if (liveConfig.proactiveInGroup === undefined) liveConfig.proactiveInGroup = false;
      delete liveConfig.proactiveInterval;
      liveConfig.__schemaVersion = 8;
      saveConfigFile(liveConfig);
    }

    // ── 2.6.0：主动发言改成「随缘随机判定」：取消固定倒计时与次数上限，只保留冷却 ──
    if (ver < 9) {
      liveConfig.proactiveEnabled = true;
      liveConfig.proactiveCooldownSec = 180;
      if (liveConfig.proactiveInGroup === undefined) liveConfig.proactiveInGroup = false;
      delete liveConfig.proactiveIdleSec;
      liveConfig.__schemaVersion = 9;
      saveConfigFile(liveConfig);
      log.info('[napcat] 主动发言已升级为随缘随机触发：冷却 180 秒、不设次数上限、群聊默认关闭');
    }

    // ── 2.7.0：识图默认改为「接梗互动」，只有明确下指令才描述画面 ──
    if (ver < 10) {
      const olds = ['', '简单描述', '简短描述这张图片内容', '简短描述图片内容，不要冗长', '描述这张图片，简短一点'];
      const cur = String(liveConfig.visionPrompt || '').trim();
      if (olds.includes(cur)) {
        liveConfig.visionPrompt = '看懂这张图的梗和情绪，顺着对方的话接梗互动，不要描述画面';
      }
      liveConfig.__schemaVersion = 10;
      saveConfigFile(liveConfig);
      log.info('[napcat] 识图默认改为「读懂梗直接接话」，只有说「描述一下这张图」才输出画面细节');
    }

    // ── 2.8.0：联网搜索（手动指令 + 不懂自动查证）──
    if (ver < 11) {
      if (liveConfig.searchEnabled === undefined) liveConfig.searchEnabled = true;
      if (liveConfig.searchAutoEnabled === undefined) liveConfig.searchAutoEnabled = true;
      if (liveConfig.searchAutoJudge === undefined) liveConfig.searchAutoJudge = true;
      if (!Number(liveConfig.searchMaxResults)) liveConfig.searchMaxResults = 5;
      liveConfig.__schemaVersion = 11;
      saveConfigFile(liveConfig);
      log.info('[napcat] 联网搜索已启用：手动「搜一下」优先，遇到时效/实体/拿不准的问题自动查证');
    }
  } catch { /* ignore */ }

  // ── 开箱即用第 1 步：OneBot access_token 自动生成并落盘 ──
  // 之后 NapCat 的 onebot11 配置、插件 HTTP 调用、正向 WS 查询串都用同一个值，
  // 用户完全不需要看到 / 填写它。
  if (!String(liveConfig.napcatToken || '').trim()) {
    liveConfig.napcatToken = randomToken(32);
    saveConfigFile(liveConfig);
    log.info('[napcat] 已自动生成 OneBot access_token 并写入配置（无需手动填写）');
  }

  // ── 端口自愈（这是「WS 客户端数 0、插件收不到消息」的直接成因）─────────
  // 三个端口各有明确职责，绝不能混用：
  //   · WebUI 管理面   : 6099（HTTP 页面 + WebUI API）
  //   · OneBot 正向 WS : 3001（插件收消息的主通道）
  //   · OneBot HTTP    : 3000（发送动作；没开也不要紧，会自动走 WS 通道）
  // 历史配置里如果 napcatWsUrl 被写成了 6099，WS 就会去连 WebUI 端口，表现是
  // 连上即被拒 / 无应答，NapCat 侧「WS 客户端数」永远是 0。这里一律纠正并落盘。
  (function healEndpoints() {
    const webuiPort = Number(liveConfig.webuiPort) || 6099;
    const rawWs = String(liveConfig.napcatWsUrl || '').trim();
    const rawHttp = String(liveConfig.napcatHttpUrl || '').trim();

    let wsPort = portOf(rawWs, 3001);
    let httpPort = portOf(rawHttp, 3000);
    const badPort = (p) => !p || p === webuiPort;

    if (badPort(wsPort)) wsPort = 3001;
    if (badPort(httpPort) || httpPort === wsPort) httpPort = wsPort === 3000 ? 3001 : 3000;

    const hostOf = (u, fallback) => {
      try { return new URL(u).hostname || fallback; } catch { return fallback; }
    };
    const wsHost = hostOf(rawWs, '127.0.0.1');
    const httpHost = hostOf(rawHttp, '127.0.0.1');

    const nextWs = normalizeWsUrl(rawWs || `ws://${wsHost}:${wsPort}`, { webuiPort, httpPort, wsPort });
    const nextHttp = `http://${httpHost}:${httpPort}`;

    if (nextWs !== rawWs || nextHttp !== rawHttp) {
      liveConfig.napcatWsUrl = nextWs;
      liveConfig.napcatHttpUrl = nextHttp;
      saveConfigFile(liveConfig);
      const diffs = [];
      if (nextWs !== rawWs) diffs.push(`WS ${rawWs || '(空)'} → ${nextWs}`);
      if (nextHttp !== rawHttp) diffs.push(`HTTP ${rawHttp || '(空)'} → ${nextHttp}`);
      log.warn(`[napcat] 已修正 OneBot 端点：${diffs.join('，')}（WebUI 端口 ${webuiPort} 不能当 OneBot 端口用）`);
    } else {
      liveConfig.napcatWsUrl = nextWs;
      liveConfig.napcatHttpUrl = nextHttp;
    }
  })();

  // 管理器需要的派生端口（从 URL 推导，避免重复配置项）
  const withPorts = () => Object.assign({}, liveConfig, {
    napcatHttpPort: portOf(liveConfig.napcatHttpUrl, 3000),
    napcatWsPort: portOf(liveConfig.napcatWsUrl, 3001),
  });

  const manager = createEmbeddedNapcat(withPorts(), log);
  // 上次登录过的 QQ 号先兜底填上，避免适配器刚热重载时 get_login_info 返回空导致误判
  if (!String(liveConfig.selfQQ || '').trim()) {
    try {
      const lu = manager.lastUin();
      if (lu) liveConfig.selfQQ = lu;
    } catch { /* ignore */ }
  }
  let current = null;
  let onebotSyncedUin = String(liveConfig.selfQQ || '');

  // 运行期状态（供面板指示灯：未连接 / 连接中 / 已就绪）
  const rt = {
    lastRecvAt: 0,
    lastSendAt: 0,
    lastReplyAt: 0,
    lastError: '',
    counts: { recv: 0, reply: 0, error: 0, ttsSent: 0, ttsSkip: 0, ttsFail: 0, forceVoice: 0, visionOk: 0, visionFail: 0, visionOff: 0, searchOk: 0, searchFail: 0 },
    lastTtsAt: 0,
    lastTts: null,
    lastVisionAt: 0,
    lastVision: null,
  };
  let conn = { state: 'offline', text: '未连接' };
  function setConn(state, text) { conn = { state, text }; }

  // 最近一次「模型生成」的结果（成功/失败原因都会记在 engine.log，面板可直接看）
  const engineState = { at: 0, ok: null, plan: '', errors: [], personaChars: 0 };
  function writeEngineLog(entry) {
    try {
      const file = path.join(dataDir(), 'engine.log');
      const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
      fs.appendFileSync(file, line);
      // 只保留最近 400 行，避免无限膨胀
      try {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
        if (lines.length > 400) fs.writeFileSync(file, lines.slice(-400).join('\n') + '\n');
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }
  function recordEngine(entry) {
    if (!entry || typeof entry !== 'object') return;
    engineState.at = entry.at || Date.now();
    engineState.ok = !!entry.ok;
    engineState.plan = entry.plan || '';
    engineState.errors = Array.isArray(entry.errors) ? entry.errors : [];
    engineState.personaChars = Number(entry.personaChars) || 0;
    if (!entry.ok && engineState.errors.length) {
      rt.lastError = '模型调用失败：' + engineState.errors[0];
      rt.counts.error += 1;
    }
    writeEngineLog(entry);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { try { const t = Buffer.concat(chunks).toString('utf8'); resolve(t ? JSON.parse(t) : {}); } catch { resolve({}); } });
      req.on('error', () => resolve({}));
    });
  }

  // 会话 / 人格 / 规则 / 任务 / 知识库（全部本地持久化）
  const sessions = createSessions(log);
  const state = createState(log);
  const kb = createKb(log);

  // ── 运行实例（OneBot 收发 + 记忆 + 回复 + 风控）──
  function start(cfg) {
    const memory = createMemory(cfg, log);
    const responder = createResponder(cfg, log, ctx, { record: recordEngine });
    const limiter = createRateLimiter(cfg);
    const nap = createNapCat(cfg, ctx, log);
    // 识图走宿主附件库（ctx.attachments）+ 当前主模型原生视觉，不再单独配接口
    const vision = createVision(cfg, log, nap, ctx);
    // 内置离线语音引擎（Windows SAPI）：没填 TTS 接口时也能真的发出语音
    const localTts = createLocalTts(dataDir(), log);
    const tts = createTts(cfg, log, nap, { local: localTts });
    // 联网搜索：优先宿主 ctx.web（DeepSeek 原生搜索），也可填自定义搜索接口
    const search = createSearch(cfg, log, ctx);
    const activePriv = new Map();
    const STATUS_CMD = /^(状态|!状态|\/status)$/i;

    // ── 消息处理：交给 pipeline（基础过滤 → 分支 → 指令 → 上下文 → 流式推理 → 分段/语音发送）──
    const pipeline = createPipeline({
      config: cfg,
      log,
      nap,
      responder,
      tts,
      vision,
      search,
      onVision: (ev) => {
        const st = (ev && ev.state) || '';
        rt.lastVisionAt = Date.now();
        rt.lastVision = { state: st, reason: (ev && ev.reason) || '', text: String((ev && ev.text) || '').slice(0, 80) };
        if (st === 'ok') rt.counts.visionOk = (rt.counts.visionOk || 0) + 1;
        else if (st === 'fail') rt.counts.visionFail = (rt.counts.visionFail || 0) + 1;
        else if (st === 'off') rt.counts.visionOff = (rt.counts.visionOff || 0) + 1;
      },
      onTts: (ev) => {
        const p = (ev && ev.plan) || {};
        rt.lastTtsAt = Date.now();
        rt.lastTts = {
          ok: !!(ev && ev.ok),
          mode: p.mode || '',
          reason: p.reason || '',
          probability: Number(p.probability) || 0,
          voice: p.voice || '',
          degraded: !!(ev && ev.degraded),
        };
        if (p.force) rt.counts.forceVoice = (rt.counts.forceVoice || 0) + 1;
        if (ev && ev.skipped) rt.counts.ttsSkip = (rt.counts.ttsSkip || 0) + 1;
        else if (ev && ev.ok) rt.counts.ttsSent = (rt.counts.ttsSent || 0) + 1;
        else rt.counts.ttsFail = (rt.counts.ttsFail || 0) + 1;
      },
      sessions,
      limiter,
      state,
      kb,
      onError: (msg) => {
        rt.counts.error += 1;
        rt.lastError = msg;
        try { nap.writeStatus('offline', { error: msg }); } catch { /* ignore */ }
      },
    });

    async function onMessage(ev) {
      rt.lastRecvAt = Date.now();
      rt.counts.recv += 1;
      try {
        const uid = String(ev.user_id != null ? ev.user_id : (ev.sender && ev.sender.user_id) || '');
        if (ev.message_type !== 'group') activePriv.set(uid, { userId: uid, time: Date.now() });
        await pipeline.handle(ev);
        rt.lastReplyAt = Date.now();
        rt.counts.reply += 1;
      } catch (e) {
        rt.counts.error += 1;
        rt.lastError = '处理消息异常：' + String((e && e.message) || e);
        log.warn(`[napcat] 处理消息异常(已忽略): ${e}`);
      }
    }

    let stopRecv = () => {};
    const recvBox = { box: null };
    try {
      if (cfg.receiveMode === 'webhook') {
        setConn('connecting', '连接中（webhook 模式）');
        Promise.resolve(nap.startWebhook(onMessage))
          .then((r) => { recvBox.box = r; })
          .catch(() => {});
      } else {
        setConn('connecting', 'WS 连接中…');
        recvBox.box = nap.connectWs(onMessage, (state, info) => {
          if (state === 'connecting') setConn('connecting', info && info.attempts > 1 ? `WS 重连中（第 ${info.attempts} 次）` : 'WS 连接中…');
          else if (state === 'open') setConn('online', 'WS 已连接');
          else if (state === 'error') setConn('offline', 'WS 重连已停止：' + ((info && info.lastError) || ''));
          else if (state === 'closed') setConn('offline', 'WS 已断开');
        });
      }
    } catch (e) { log.warn(`[napcat] 启动接收失败(已忽略): ${e}`); }

    nap.getLoginInfo();
    const statusTimer = setInterval(() => { try { nap.getLoginInfo(); } catch { /* ignore */ } }, 30000);

    // 主动发言改由 pipeline 里的空闲调度器负责（消息全静下来才开口，一轮最多一条），
    // 不再用「每 N 分钟给最近活跃私聊群发问候」这种生硬定时器。
    return {
      nap,
      responder,
      tts,
      localTts,
      vision,
      search,
      pipeline,
      memory,
      /** 当前接收器的状态快照（WS 状态机 / webhook）。 */
      recv: () => (recvBox.box && typeof recvBox.box.state === 'function' ? recvBox.box.state() : { state: 'idle' }),
      /** 手动立即重连 WS（面板按钮 / OneBot 配置刚生效时）。 */
      reconnect() {
        try {
          if (recvBox.box && typeof recvBox.box.reconnect === 'function') recvBox.box.reconnect();
        } catch { /* ignore */ }
      },
      stop() {
        try { clearInterval(statusTimer); } catch { /* ignore */ }
        try { if (pipeline && pipeline.proactive) pipeline.proactive.stopAll(); } catch { /* ignore */ }
        try {
          if (recvBox.box && typeof recvBox.box.dispose === 'function') recvBox.box.dispose();
          else stopRecv();
        } catch { /* ignore */ }
        setConn('offline', '未连接');
      },
    };
  }

  function stop(instance) { if (instance && typeof instance.stop === 'function') { try { instance.stop(); } catch { /* ignore */ } } }

  /**
   * 执行一条定时任务：prompt 以 `gen:` 开头则先用模型生成文案再发，
   * 否则把 prompt 原样发出去（简单提醒/推送）。
   */
  async function runTask(task) {
    const raw = String(task.prompt || '').trim();
    if (!raw) return;
    let out = raw;
    if (raw.startsWith('gen:')) {
      const q = raw.slice(4).trim();
      try {
        out = current && current.responder
          ? await current.responder.reply('task', q, [], '')
          : q;
      } catch (e) { log.warn(`[napcat] 定时任务生成失败: ${e}`); out = q; }
    }
    if (current && current.pipeline && typeof current.pipeline.push === 'function') {
      const sent = await current.pipeline.push(task.target, out);
      log.info(`[napcat] 定时任务「${task.name || task.id}」→ ${task.target}: ${sent ? '已发送' : '发送失败'}`);
    }
  }

  const taskTimer = setInterval(async () => {
    let due = [];
    try { due = state.tasks.due(); } catch { return; }
    for (const t of due) {
      try { await runTask(t); } catch (e) { log.warn(`[napcat] 定时任务执行异常: ${e}`); }
    }
  }, 15000);
  try { if (taskTimer.unref) taskTimer.unref(); } catch { /* ignore */ }

  try { current = start(liveConfig); }
  catch (e) { log.error(`[napcat] 初始化失败（插件仍保持注册，请检查配置）: ${e}`); }

  // ── 监督循环（这是「QQ 登录后 WS 自动连上」的核心）──────────────────
  //  1) 拿登录态 → 记住 QQ 号
  //  2) 发现 3001 没在监听 → 通过 NapCat WebUI API 重新应用 OneBot 配置（真正生效）
  //  3) OneBot WS 已在监听但插件这边没连上 → 立刻重连
  // 全部带节流，避免刷屏 / 反复重启适配器。
  let lastOnebotTry = 0;
  let lastReconnectAt = 0;
  let lastLoginOk = false;

  const syncTimer = setInterval(async () => {
    try {
      if (!current || !current.nap) return;
      const now = Date.now();
      const napState = manager.status();

      // NapCat 已经不在运行时，别去调 WebUI API（只会刷「WebUI 尚未就绪」）。
      // 拉起/重启由 manager.watch() 负责（带限流），这里只做保底提示。
      if (!napState.alive && napState.state !== 'webui' && napState.state !== 'starting') return;

      const info = await current.nap.getLoginInfo();
      const uin = info && info.user_id ? String(info.user_id) : '';
      lastLoginOk = !!uin;

      if (uin) {
        if (uin !== onebotSyncedUin) {
          onebotSyncedUin = uin;
          manager.rememberUin(uin);
          if (!liveConfig.selfQQ) { liveConfig.selfQQ = uin; saveConfigFile(liveConfig); }
          log.info(`[napcat] 检测到 QQ 登录：${uin}`);
        }
        // 登录后（或发现 3001 不在监听）→ 让 OneBot 网络配置真正生效
        const wsUp = await manager.onebotWsListening();
        if (!wsUp && now - lastOnebotTry > 6000) {
          lastOnebotTry = now;
          const r = await manager.ensureOneBotNetwork({ force: true });
          if (!r.ok) log.warn(`[napcat] 应用 OneBot 配置未成功，稍后重试：${r.error || ''}`);
        }
      } else if (now - lastOnebotTry > 15000) {
        // 未登录时也试一次（某些版本允许先写配置），失败静默
        lastOnebotTry = now;
        manager.ensureOneBotNetwork({ force: true }).catch(() => {});
      }

      // OneBot WS 端口在监听，但我们的 WS 没连上 → 主动重连（NapCat 重启后必备）
      const wsUp2 = manager.onebotWsListening();
      const wsState = current.recv ? current.recv().state : 'idle';
      if (wsUp2 && wsState !== 'open' && wsState !== 'disabled' && now - lastReconnectAt > 4000) {
        lastReconnectAt = now;
        log.info('[napcat] 检测到 OneBot WS 已就绪但未连接，主动重连…');
        try { current.reconnect(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }, 4000);
  try { if (syncTimer.unref) syncTimer.unref(); } catch { /* ignore */ }

  // ── 自动启动内置 NapCat（带进程检测，不阻塞 apply）──
  try { manager.watch(); } catch { /* ignore */ }
  if (liveConfig.autoStartNapCat !== false) {
    Promise.resolve().then(() => manager.start()).catch((e) => log.warn(`[napcat] 自动启动失败: ${e}`));
  } else {
    log.info('[napcat] 已按配置跳过自动启动内置 NapCat（可在面板手动启动）');
  }

  // ==========================================================================
  // HTTP 端点
  // apply 阶段 webServer 通常还没就绪 → 先试一次，再 inject，最后低频轮询兜底。
  // prefix 路由的 path 结尾不带斜杠（见文件头说明，否则必然 404）。
  // ==========================================================================
  let apiMounted = false;
  let apiTries = 0;

  function json(res, code, obj) {
    try {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(obj));
    } catch { /* ignore */ }
  }

  function webuiInfo() {
    const s = manager.status();
    return {
      ok: true,
      url: s.webui,
      urlWithToken: s.webuiUrl,
      token: s.token,
      tokenFrom: s.tokenFrom,
      port: s.port,
      state: s.state,
      onebotToken: s.onebotToken,
    };
  }

  function engineInfo() {
    try {
      return current && current.responder && typeof current.responder.describe === 'function'
        ? current.responder.describe()
        : { mode: liveConfig.replyMode || 'dsh', dshAvailable: false, effective: 'local' };
    } catch { return { mode: liveConfig.replyMode || 'dsh', dshAvailable: false, effective: 'local' }; }
  }

  /** 语音（TTS）当前生效设置 + 运行计数，供面板确认「到底出没出声」。 */
  function ttsInfo() {
    let st = null;
    try {
      st = current && current.tts && typeof current.tts.stats === 'function' ? current.tts.stats() : null;
    } catch { st = null; }
    return Object.assign({
      mode: String(liveConfig.ttsMode || (liveConfig.ttsEnabled ? 'all' : 'off')),
      probability: Number(liveConfig.ttsProbability) || 40,
      voiceRandom: liveConfig.ttsVoiceRandom !== false,
      pool: String(liveConfig.ttsVoicePool || '').split(/[\n,，、;；]+/).map((x) => x.trim()).filter(Boolean),
      smart: liveConfig.ttsSmartWeight !== false,
      url: String(liveConfig.ttsUrl || ''),
      localEnabled: liveConfig.ttsLocalEngine !== false,
      sent: rt.counts.ttsSent || 0,
      skipped: rt.counts.ttsSkip || 0,
      failed: rt.counts.ttsFail || 0,
      force: rt.counts.forceVoice || 0,
      lastAt: rt.lastTtsAt || 0,
      last: rt.lastTts || null,
    }, st || {});
  }

  /** 识图当前生效设置 + 运行计数（面板确认「图到底看没看懂」）。 */
  function visionInfo() {
    let st = null;
    try {
      st = current && current.vision && typeof current.vision.stats === 'function' ? current.vision.stats() : null;
    } catch { st = null; }
    return Object.assign({
      enabled: liveConfig.visionEnabled !== false,
      native: true,   // 图片随对话交给当前主模型（V4.1-Flash 自带视觉），无独立接口
      prompt: String(liveConfig.visionPrompt || ''),
      okCount: rt.counts.visionOk || 0,
      failCount: rt.counts.visionFail || 0,
      offCount: rt.counts.visionOff || 0,
      lastAt: rt.lastVisionAt || 0,
      last: rt.lastVision || null,
    }, st || {});
  }

  /** 主动发言：开关 / 空闲时长 / 待触发会话数 / 触发计数。 */
  function proactiveInfo() {
    let st = null;
    try {
      st = current && current.pipeline && current.pipeline.proactive
        ? current.pipeline.proactive.status() : null;
    } catch { st = null; }
    return Object.assign({
      enabled: liveConfig.proactiveEnabled !== false,
      groupEnabled: liveConfig.proactiveInGroup === true,
      cooldownSec: clampCooldownSec(liveConfig.proactiveCooldownSec),
      pending: 0,
      firedCount: 0,
      skippedCount: 0,
      pausedCount: 0,
      last: null,
    }, st || {});
  }

  /** 联网搜索：开关 / 自动查证 / 用哪个提供方 / 命中与失败计数。 */
  function searchInfo() {
    let st = null;
    try {
      st = current && current.search ? current.search.status() : null;
    } catch { st = null; }
    return Object.assign({
      enabled: liveConfig.searchEnabled !== false,
      auto: liveConfig.searchAutoEnabled !== false,
      judge: liveConfig.searchAutoJudge !== false,
      provider: 'none',
      available: false,
      endpoint: String(liveConfig.searchEndpoint || ''),
      manual: 0, autoCount: 0, ok: 0, fail: 0, skip: 0, judgeCount: 0,
      lastAt: 0, last: null,
    }, st || {});
  }

  function statusPayload() {
    const onebot = current && current.nap ? current.nap.getStatus() : { state: 'unknown' };
    const napcat = manager.status();
    const ws = current && current.recv ? current.recv() : { state: 'idle' };
    const ob = napcat.onebot || {};

    // ── 三个指示灯（面板按这个渲染，语义与用户要求一致）──
    // process: 绿色 = NapCat 进程已启动
    const procUp = napcat.state === 'webui' || napcat.state === 'running'
      || napcat.state === 'starting' || false;
    // ws: 黄色 = 正在尝试连接；open = 连接成功
    const wsOpen = ws.state === 'open';
    const wsBusy = ws.state === 'connecting';
    // ready: 绿色对勾 = WS 连着 + OneBot 端口在监听 + QQ 已登录
    const loginOk = onebot.state === 'online' || lastLoginOk;
    const ready = wsOpen && (ob.wsListening !== false) && loginOk;

    const lights = {
      process: { ok: procUp, text: procUp ? 'NapCat 进程已启动' : 'NapCat 进程未运行' },
      ws: {
        state: ws.state,
        ok: wsOpen,
        busy: wsBusy,
        url: stripQuery((ws && ws.url) || liveConfig.napcatWsUrl),
        port: (ws && ws.port) || Number(napcat.onebotWsPort) || 3001,
        // 插件自己就是一个 WS 客户端：连上即 1，断开即 0
        clients: wsOpen ? 1 : 0,
        text: wsOpen
          ? 'WS 已连接（NapCat 客户端数 1）'
          : wsBusy ? 'WS 正在尝试连接…'
            : ws.state === 'error' ? 'WS 连接失败（重连已停止）'
              : 'WS 未连接',
      },
      ready: { ok: !!ready, text: ready ? '可以收发消息' : '尚不能收发消息' },
    };

    let connection = 'offline';
    let connectionText = '未连接';
    if (ready) { connection = 'online'; connectionText = 'WS 已连接，可以收发消息'; }
    else if (procUp || wsBusy) { connection = 'connecting'; connectionText = wsBusy ? 'WS 正在尝试连接…' : 'NapCat 已启动，等待 WS 连接'; }

    let hint = '';
    if (napcat.state === 'starting') hint = '内置 NapCat 正在启动，请稍候（首次启动约 10–30 秒）…';
    else if (napcat.state === 'no-qq') hint = napcat.reason;
    else if (napcat.state === 'failed') hint = '内置 NapCat 启动失败：' + (napcat.reason || '未知原因');
    else if (napcat.state === 'stopped') hint = '内置 NapCat 未在运行，点击「启动内置 NapCat」';
    else if (ready) hint = '一切就绪：私聊消息与群内 @ 都会自动回复。';
    else if (procUp && !loginOk) hint = 'NapCat 已运行，请在「NapCat WebUI」标签页扫码登录 QQ。';
    else if (procUp && loginOk && !ob.wsListening) hint = 'QQ 已登录，正在为你开启 OneBot 正向 WS（自动，不需要操作）…';
    else if (procUp && loginOk && ob.wsListening && !wsOpen) hint = 'OneBot WS 已就绪，正在建立连接…';
    if (ob.error && !ready) hint = hint || ob.error;

    return Object.assign({}, onebot, {
      onebot,
      napcat,
      ws,
      onebotNet: ob,
      // 三个端点的权威展示（面板直接照着显示，排障时一眼能看出连的是不是 3001）
      endpoints: {
        webui: `http://127.0.0.1:${napcat.port || 6099}/webui`,
        ws: stripQuery((ws && ws.url) || liveConfig.napcatWsUrl),
        http: liveConfig.napcatHttpUrl,
      },
      webui: { url: napcat.webuiUrl, token: napcat.token, tokenFrom: napcat.tokenFrom, port: napcat.port },
      connection,
      connectionText,
      lights,
      hint,
      runtime: {
        lastRecvAt: rt.lastRecvAt,
        lastSendAt: rt.lastSendAt,
        lastReplyAt: rt.lastReplyAt,
        lastError: rt.lastError || onebot.error || '',
        counts: rt.counts,
      },
      engine: engineInfo(),
      // 语音（TTS）：四模式 + 概率 + 随机音色 + 已发/跳过/失败计数
      tts: ttsInfo(),
      // 识图：开关 / 原生多模态 / 成功失败计数 / 最近一张图
      vision: visionInfo(),
      // 主动发言：空闲时长 / 待触发 / 已开口次数 / 最近一次
      proactive: proactiveInfo(),
      // 联网搜索：开关 / 自动查证 / 提供方 / 命中与失败 / 最近一次查询
      search: searchInfo(),
      // 最近一次模型调用：ok/失败原因（失败时面板直接显示，不用翻日志）
      engineLast: {
        at: engineState.at,
        ok: engineState.ok,
        plan: engineState.plan,
        errors: engineState.errors,
        personaChars: engineState.personaChars,
      },
      // 会话统计（面板用来确认「群聊独立会话」是否真的分开了）
      sessions: (() => { try { return sessions.stats(); } catch { return { sessions: 0, messages: 0, tokens: 0 }; } })(),
      manage: {
        personas: (() => { try { return state.personas.list().length; } catch { return 0; } })(),
        globalPersonaId: (() => { try { return state.personas.getGlobalId(); } catch { return ''; } })(),
        rules: (() => { try { return state.rules.list().length; } catch { return 0; } })(),
        tasks: (() => { try { return state.tasks.list().length; } catch { return 0; } })(),
        kbs: (() => { try { return kb.list().length; } catch { return 0; } })(),
      },
      // 当前真正生效的人格（面板顶部会显示，用来确认「填的到底有没有被用上」）
      persona: {
        text: String(liveConfig.personaPrompt || ''),
        preview: String(liveConfig.personaPrompt || '').replace(/\s+/g, ' ').slice(0, 60),
        source: (liveConfig.__hostOverrides || []).includes('personaPrompt') ? 'host' : 'panel',
        isDefault: String(liveConfig.personaPrompt || '') === String((schemaDefaults().personaPrompt) || ''),
      },
      config: {
        napcatConsoleUrl: liveConfig.napcatConsoleUrl,
        napcatHttpUrl: liveConfig.napcatHttpUrl,
        napcatWsUrl: liveConfig.napcatWsUrl,
        webuiPort: liveConfig.webuiPort,
        selfQQ: liveConfig.selfQQ,
        groupReplyOnlyAt: liveConfig.groupReplyOnlyAt !== false,
        groupUniqueSession: liveConfig.groupUniqueSession !== false,
        groupWakeTimeoutSec: Number(liveConfig.groupWakeTimeoutSec) || 120,
        contextCompress: liveConfig.contextCompress !== false,
      },
    });
  }

  function mountApi(web) {
    if (apiMounted) return true;
    if (!web || typeof web.register !== 'function') return false;
    try {
      // ① 状态：连接三态 + OneBot 登录态 + 内置进程态 + WebUI Token + 友好提示
      web.register({
        kind: 'prefix',
        path: '/napcat-bot/api/status',
        handler: (req, res) => {
          try {
            if (req.method && req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
            json(res, 200, statusPayload());
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      });

      // ② WebUI 信息（自动读取的 Token）
      web.register({
        kind: 'prefix',
        path: '/napcat-bot/api/webui',
        handler: (req, res) => {
          try { json(res, 200, webuiInfo()); } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      });

      // ③ 重新生成 / 指定 WebUI 管理 Token
      web.register({
        kind: 'prefix',
        path: '/napcat-bot/api/webui/token',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'use POST' }); return; }
            const body = await readBody(req);
            const token = await manager.rotateToken(body && body.token);
            if (!body || body.restart !== false) manager.restart().catch(() => {});
            json(res, 200, Object.assign({ ok: true, token }, webuiInfo()));
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      });

      // ④ 配置读写（保存即热重载）
      web.register({
        kind: 'prefix',
        path: '/napcat-bot/api/config',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET' || req.method === 'HEAD') { json(res, 200, liveConfig); return; }
            if (req.method === 'POST' || req.method === 'PUT') {
              const body = await readBody(req);
              if (!body || typeof body !== 'object') { json(res, 400, { ok: false, error: 'bad body' }); return; }
              const before = {
                http: liveConfig.napcatHttpUrl,
                ws: liveConfig.napcatWsUrl,
                token: liveConfig.napcatToken,
                auto: liveConfig.autoStartNapCat,
                mode: liveConfig.receiveMode,
                hook: liveConfig.webhookPath,
              };
              const prevPersona = String(liveConfig.personaPrompt || '');
              for (const k of Object.keys(body)) { if (k in liveConfig) liveConfig[k] = body[k]; }
              saveConfigFile(liveConfig);

              // 只有「连接层」参数变了才需要重建接收器。
              // 人格 / 记忆 / 群聊开关 / 风控这类参数是运行期动态读取的，
              // 重建 WS 只会制造「旧连接 + 新连接」的重复接收窗口，反而更容易重复回复。
              const connChanged = before.http !== liveConfig.napcatHttpUrl
                || before.ws !== liveConfig.napcatWsUrl
                || before.token !== liveConfig.napcatToken
                || before.mode !== liveConfig.receiveMode
                || before.hook !== liveConfig.webhookPath;

              if (connChanged) {
                try { stop(current); current = start(liveConfig); }
                catch (e) { log.warn(`[napcat] 配置热重载失败(已保存，下次重启生效): ${e}`); }
                log.info('[napcat] 连接参数已变更，重新应用 OneBot 网络配置…');
                manager.ensureOneBotNetwork({ force: true })
                  .then(() => { try { current && current.reconnect && current.reconnect(); } catch { /* ignore */ } })
                  .catch(() => {});
              } else if (before.auto !== liveConfig.autoStartNapCat && liveConfig.autoStartNapCat) {
                manager.start().catch(() => {});
              }

              const personaChanged = prevPersona !== String(liveConfig.personaPrompt || '');
              if (personaChanged) {
                log.info(`[napcat] 人格已更新并立即生效：${String(liveConfig.personaPrompt || '').slice(0, 40)}…`);
              }
              json(res, 200, { ok: true, personaChanged, connChanged });
              return;
            }
            res.statusCode = 405; res.end();
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      });

      // ⑤ 内置 NapCat 控制 + 日志（path 结尾不带斜杠，否则 /log 会 404）
      web.register({
        kind: 'prefix',
        path: '/napcat-bot/api/napcat',
        handler: async (req, res) => {
          try {
            const pathname = String((req.url || '').split('?')[0]);
            const PREFIX = '/napcat-bot/api/napcat/';
            let action = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : '';
            action = action.replace(/\/+$/, '');

            if (action === 'log' || action === '') {
              const u = new URL('http://x' + (req.url || '/'));
              const n = Math.min(800, Math.max(20, Number(u.searchParams.get('tail')) || 200));
              // ?source=messages → 读消息收发记录（面板「消息记录」用）
              if (u.searchParams.get('source') === 'messages') {
                const file = path.join(dataDir(), 'messages.log');
                let lines = [];
                try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* ignore */ }
                json(res, 200, { ok: true, path: file, lines: lines.slice(-n), state: 'messages' });
                return;
              }
              // ?source=engine → 模型生成诊断（每轮成败与具体报错）
              if (u.searchParams.get('source') === 'engine') {
                const file = path.join(dataDir(), 'engine.log');
                let lines = [];
                try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { /* ignore */ }
                json(res, 200, { ok: true, path: file, lines: lines.slice(-n), state: 'engine', last: engineState });
                return;
              }
              const st = manager.status();
              const lines = (st.logTail || []).slice(-n);
              const token = parseTokenFromLog(lines.join('\n')) || st.token;
              json(res, 200, {
                ok: true,
                path: st.log,
                lines,
                token,
                tokenFrom: st.tokenFrom,
                onebotToken: st.onebotToken,
                state: st.state,
                since: st.since,
              });
              return;
            }

            if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'use POST' }); return; }
            if (action === 'start') json(res, 200, { ok: true, napcat: await manager.start() });
            else if (action === 'stop') json(res, 200, { ok: true, napcat: await manager.stop() });
            else if (action === 'restart') json(res, 200, { ok: true, napcat: await manager.restart() });
            else if (action === 'reconnect') {
              // 只重连插件侧 WS，不动 NapCat（不会踢掉 QQ 登录）
              try { current && current.reconnect && current.reconnect(); } catch { /* ignore */ }
              json(res, 200, { ok: true, ws: current && current.recv ? current.recv() : null });
            } else if (action === 'apply-onebot') {
              // 通过 NapCat WebUI API 重新应用 OneBot 网络配置（HTTP + 正向 WS）
              const r = await manager.ensureOneBotNetwork({ force: true });
              try { current && current.reconnect && current.reconnect(); } catch { /* ignore */ }
              json(res, r.ok ? 200 : 500, { ok: !!r.ok, result: r, onebot: manager.onebotStatus() });
            } else json(res, 404, { ok: false, error: 'unknown action: ' + action });
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      });

      // ⑥ 客户端 UI 自检回执（侧边入口排障用）
      web.register({
        kind: 'prefix',
        path: '/napcat-bot/api/client-report',
        handler: async (req, res) => {
          try {
            const body = await readBody(req);
            const record = { at: new Date().toISOString(), report: body };
            try { fs.writeFileSync(path.join(dataDir(), 'client-report.json'), JSON.stringify(record, null, 2)); } catch { /* ignore */ }
            log.info('[napcat] 客户端 UI 回执: ' + JSON.stringify(body));
            json(res, 200, { ok: true });
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      });

      // ⑦ 管理数据（人格 / 规则 / 会话 / 任务 / 知识库）
      // 统一走 /manage?res=xxx + POST {action}，前端只维护一个请求函数。
      web.register({
        kind: 'prefix',
        path: '/napcat-bot/api/manage',
        handler: async (req, res) => {
          try {
            const u = new URL('http://x' + (req.url || '/'));
            const resource = String(u.searchParams.get('res') || '');
            const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
            const action = String(body.action || (req.method === 'GET' ? 'list' : ''));

            if (resource === 'personas') {
              if (action === 'list') { json(res, 200, { ok: true, items: state.personas.list(), globalId: state.personas.getGlobalId() }); return; }
              if (action === 'save') { json(res, 200, { ok: true, item: state.personas.upsert(body) }); return; }
              if (action === 'remove') { json(res, 200, { ok: state.personas.remove(String(body.id || '')) }); return; }
              if (action === 'global') { json(res, 200, { ok: state.personas.setGlobal(String(body.id || '')) }); return; }
            }
            if (resource === 'rules') {
              if (action === 'list') { json(res, 200, { ok: true, items: state.rules.list() }); return; }
              if (action === 'save') { json(res, 200, { ok: true, item: state.rules.upsert(body) }); return; }
              if (action === 'remove') { json(res, 200, { ok: state.rules.remove(String(body.id || '')) }); return; }
            }
            if (resource === 'sessions') {
              if (action === 'list') { json(res, 200, { ok: true, items: sessions.list() }); return; }
              if (action === 'history') { json(res, 200, { ok: true, items: sessions.history(String(body.key || ''), 30) }); return; }
              if (action === 'rename') { sessions.rename(String(body.key || ''), body.title); json(res, 200, { ok: true }); return; }
              if (action === 'reset') { sessions.reset(String(body.key || '')); json(res, 200, { ok: true }); return; }
              if (action === 'remove') { json(res, 200, { ok: sessions.remove(String(body.key || '')) }); return; }
            }
            if (resource === 'tasks') {
              if (action === 'list') { json(res, 200, { ok: true, items: state.tasks.list() }); return; }
              if (action === 'add') { json(res, 200, { ok: true, item: state.tasks.add(body) }); return; }
              if (action === 'update') { json(res, 200, { ok: true, item: state.tasks.update(String(body.id || ''), body) }); return; }
              if (action === 'remove') { json(res, 200, { ok: state.tasks.remove(String(body.id || '')) }); return; }
              if (action === 'run') {
                const t = state.tasks.list().find((x) => x.id === body.id);
                if (!t) { json(res, 404, { ok: false, error: 'task not found' }); return; }
                try { await runTask(t); json(res, 200, { ok: true }); }
                catch (e) { json(res, 500, { ok: false, error: String(e) }); }
                return;
              }
            }
            if (resource === 'kb') {
              if (action === 'list') { json(res, 200, { ok: true, items: kb.list() }); return; }
              if (action === 'create') { json(res, 200, { ok: true, item: kb.create(body.name) }); return; }
              if (action === 'remove') { json(res, 200, { ok: kb.remove(String(body.id || '')) }); return; }
              if (action === 'docs') { json(res, 200, { ok: true, items: kb.docs(String(body.id || '')) }); return; }
              if (action === 'addDoc') { json(res, 200, { ok: true, item: kb.addDoc(String(body.id || ''), body) }); return; }
              if (action === 'removeDoc') { json(res, 200, { ok: kb.removeDoc(String(body.id || ''), String(body.docId || '')) }); return; }
              if (action === 'search') { json(res, 200, { ok: true, items: kb.search(String(body.q || ''), body.kbIds || [], 6) }); return; }
            }
            if (resource === 'admins') {
              if (action === 'list') { json(res, 200, { ok: true, items: state.admins.list() }); return; }
              if (action === 'add') { json(res, 200, { ok: true, items: state.admins.add(body.qq) }); return; }
              if (action === 'remove') { json(res, 200, { ok: true, items: state.admins.remove(body.qq) }); return; }
            }
            json(res, 400, { ok: false, error: 'unknown resource/action: ' + resource + '/' + action });
          } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
        },
      });

      apiMounted = true;
      log.info('[napcat] HTTP 面板接口已挂载：/napcat-bot/api/{status,config,webui,napcat/log,...}');
      return true;
    } catch (e) {
      log.warn(`[napcat] HTTP 端点注册失败(不影响主功能): ${e}`);
      return false;
    }
  }

  try { mountApi(ctx.get && ctx.get('webServer')); } catch { /* ignore */ }
  try {
    if (!apiMounted && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => {
        try { mountApi(scoped.webServer); } catch (e) { log.warn(`[napcat] webServer 注入后挂载失败: ${e}`); }
      });
    }
  } catch { /* ignore */ }
  const apiTimer = setInterval(() => {
    if (apiMounted || apiTries >= 20) { try { clearInterval(apiTimer); } catch { /* ignore */ } return; }
    apiTries += 1;
    try { mountApi(ctx.get && ctx.get('webServer')); } catch { /* ignore */ }
  }, 1500);
  try { if (apiTimer.unref) apiTimer.unref(); } catch { /* ignore */ }

  // ── 生命周期：禁用 / 卸载 / 退出 DSH 时收尾（含停掉内置 NapCat）──
  try {
    ctx.effect(() => () => {
      try { clearInterval(syncTimer); } catch { /* ignore */ }
      try { clearInterval(apiTimer); } catch { /* ignore */ }
      try { clearInterval(taskTimer); } catch { /* ignore */ }
      try { manager.shutdown({ kill: liveConfig.stopNapCatOnDisable !== false }); } catch { /* ignore */ }
      try { sessions.flush(); } catch { /* ignore */ }
      try { state.flush(); } catch { /* ignore */ }
      try { kb.flush(); } catch { /* ignore */ }
      stop(current);
    });
  } catch { /* effect 不存在也不影响注册 */ }

  // 启动期就把探测结果打进日志，便于排障
  try {
    const qq = findQQ(withPorts());
    log.info(`[napcat] 内置 NapCat 目录: ${manager.paths.home}${fs.existsSync(manager.paths.home) ? '' : '（缺失）'}；QQ: ${qq || '未检测到'}`);
  } catch { /* ignore */ }

  // 登记当前实例，供「重复加载」时被下一个实例停掉（只停接收器，不动 NapCat 进程）
  try {
    globalThis[INSTANCE_KEY] = {
      version: '1.6.0',
      stop() {
        try { clearInterval(syncTimer); } catch { /* ignore */ }
        try { clearInterval(apiTimer); } catch { /* ignore */ }
        try { stop(current); } catch { /* ignore */ }
        try { manager.shutdown({ kill: false }); } catch { /* ignore */ }
      },
    };
  } catch { /* ignore */ }

  return {};
}

export default { name, Config, apply };
