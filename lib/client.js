// lib/client.js
// dsh-napcat-bot 客户端半边（浏览器 / renderer）。
//
// 注册方式 100% 照搬官方「插件市场」dshmarket 的 Cordis 写法（其 src/client/index.ts 可读）：
//   window.__ModuleLoader__.load({ id, factory })
//   factory 里 require('react')，导出 name / inject / apply
//   apply(ctx):
//     ctx.effect(() => ctx.locale.register(ns, {en,zh}))
//     ctx.effect(() => 注入 <style>)
//     ctx.slots.inject('settings.section', () => ctx.slots.register(
//         { name:'settings.section', id, order, label:()=>t('nav'), locale:ns }, Section))
//
// 关于「集成」分组：设置页左侧导航是 settings.section 账本的投影。
//   · 原生设置壳（ui-settings-general）是扁平投影，按 order 升序；
//   · 分组式设置壳（@michengai/dsh-codex-ui）用 settingsGroup(id) 归类，未知 id 一律落到
//     integrations（集成），并把它渲染进 settings.codex.section（由 mirrorSlot 从
//     settings.section 镜像过去）。
// 因此本插件同时做两件事：
//   1) 标准注册 settings.section（带失败重试 + 去重 + 兜底直注册）；
//   2) 若 15 秒后账本里仍然没有我们这条（说明当前壳的镜像没生效），再直接注册到
//      settings.codex.section 兜底 —— 两条路径都不会重复出现。
//
// 面板：两个标签页
//   ① AI 配置    —— NapCat 连接、双 Token、人设、主动回复、记忆、风控、内置进程控制
//   ② NapCat WebUI —— 内嵌 WebUI（自动带 WebUI 管理 Token 登录）、Token 一键复制/重生成、
//                      NapCat 控制台日志实时预览（自动高亮 Token 行）
//
// 数据流：自托管 HTTP 接口（与 dshmarket 的设置卡片一致）
//   GET  /napcat-bot/api/config
//   GET  /napcat-bot/api/status
//   GET  /napcat-bot/api/webui             WebUI 地址 + 自动读取的 Token
//   POST /napcat-bot/api/webui/token       重生成 / 指定 Token
//   POST /napcat-bot/api/napcat/{start|stop|restart}
//   GET  /napcat-bot/api/napcat/log?tail=N
//   POST /napcat-bot/api/client-report     UI 注册自检回执（排障）
// 零额外依赖、离线可用。

window.__ModuleLoader__.load({
  id: 'dsh-napcat-bot',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const { createElement: h, Fragment, useEffect, useState, useRef } = require('react');

    // ── 文案字典（与 dshmarket/dsh-ops 一样通过 ctx.locale.register 注册）──
    const NS = 'dshNapcat';
    const en = {
      nav: 'NapCat QQ Bot',
      summary: 'NapCat QQ Bot',
      desc: 'Ships its own NapCat (bundled): enabling the plugin starts it on port 6099 and reads its WebUI token from the startup log automatically.',
      saved: 'Saved. The new settings are live.',
      rejected: 'The host refused this save.',
      tabAi: 'AI settings',
      tabWebui: 'NapCat WebUI',
    };
    const zh = {
      nav: 'NapCat QQ 机器人',
      summary: 'NapCat QQ 机器人',
      desc: '开箱即用：插件启用后自动拉起内置 NapCat 并监听 6099，自动写入 OneBot 正向 HTTP / 正向 WS 配置、自动生成并同步 access_token、自动读取 WebUI 管理 Token。你只需要在「NapCat WebUI」标签页扫码登录 QQ，私聊与群内 @ 就会由 DSH 当前选中的大模型带着人设和记忆回复。',
      saved: '已保存，配置已立即生效。',
      rejected: '保存失败，请重试。',
      tabAi: 'AI 配置',
      tabWebui: 'NapCat WebUI',
      start: '启动内置 NapCat',
      stop: '停止',
      restart: '重新启动',
      openWebui: '在浏览器打开',
      copy: '复制',
      copied: '已复制',
      refresh: '刷新',
    };

    // ── 样式（语义 token，与 dsh-ops 的 ops-settings 同款）──
    const STYLES = [
      '.napcat-page{display:grid;gap:16px;max-width:56rem;min-width:0;}',
      '.napcat-page > h2{font-size:1.25rem;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,inherit);}',
      '.napcat-page > p.napcat-desc{margin:0;line-height:1.6;max-width:74ch;color:var(--dsw-alias-label-secondary,inherit);}',
      '.napcat-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1,#8884);}',
      '.napcat-tab{font:inherit;color:var(--dsw-alias-label-secondary,inherit);background:transparent;border:0;border-bottom:2px solid transparent;padding:8px 12px;cursor:pointer;border-radius:var(--dsw-radius-sm,8px) var(--dsw-radius-sm,8px) 0 0;}',
      '.napcat-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#8882);}',
      '.napcat-tab.on{color:var(--dsw-alias-label-primary,inherit);border-bottom-color:var(--dsw-alias-button-primary-fill,#356be8);font-weight:600;}',
      '.napcat-settings{color:var(--dsw-alias-label-primary,inherit);font:inherit;max-width:56rem;display:grid;gap:16px;}',
      '.napcat-settings h3{font-size:1rem;margin:0;font-weight:600;}',
      '.napcat-settings h4{font-size:.95rem;margin:0;font-weight:600;}',
      '.napcat-settings p{margin:0;line-height:1.55;max-width:74ch;overflow-wrap:anywhere;}',
      '.napcat-section{display:grid;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,#8884);border-radius:var(--dsw-radius-md,12px);}',
      '.napcat-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px;}',
      '.napcat-field{display:grid;gap:6px;}',
      '.napcat-field > span:first-child{font-weight:600;}',
      '.napcat-hint{color:var(--dsw-alias-label-secondary,inherit);font-size:.85em;line-height:1.5;}',
      '.napcat-settings input[type=text],.napcat-settings input[type=password],.napcat-settings input[type=number],.napcat-settings select,.napcat-settings textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l3,#888);background:transparent;color:inherit;border-radius:var(--dsw-radius-sm,8px);padding:8px 10px;font:inherit;}',
      '.napcat-settings select{background-color:var(--dsw-alias-bg-l1,transparent);color:var(--dsw-alias-label-primary,inherit);}',
      '.napcat-settings select option{background-color:var(--dsw-alias-bg-l1,#fff);color:var(--dsw-alias-label-primary,#222);}',
      '.napcat-settings textarea{min-height:96px;resize:vertical;}',
      '.napcat-choice{display:flex;align-items:center;gap:10px;min-height:34px;cursor:pointer;}',
      '.napcat-choice input{width:16px;height:16px;accent-color:var(--dsw-alias-button-primary-fill,#356be8);}',
      '.napcat-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;}',
      '.napcat-settings button{font:inherit;color:inherit;background:transparent;padding:8px 14px;border:1px solid var(--dsw-alias-border-l3,#888);border-radius:var(--dsw-radius-md,12px);cursor:pointer;min-height:36px;}',
      '.napcat-settings button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#8882);}',
      '.napcat-settings button.napcat-primary{background:var(--dsw-alias-button-primary-fill,#356be8);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent;}',
      '.napcat-settings :is(button,input,textarea):focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#356be8);outline-offset:3px;}',
      '.napcat-settings :disabled{opacity:.5;cursor:not-allowed;}',
      '.napcat-note{color:var(--dsw-alias-label-secondary,inherit);font-size:.9em;}',
      '.napcat-note.ok{color:var(--dsw-alias-state-success-primary,#2a9d5c);}',
      '.napcat-note.err{color:var(--dsw-alias-state-danger-primary,#d4574e);}',
      '.napcat-status{display:grid;gap:10px;padding:12px 14px;border-radius:var(--dsw-radius-md,12px);border:1px solid var(--dsw-alias-border-l1,#8884);}',
      '.napcat-status-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.napcat-dot{width:10px;height:10px;border-radius:50%;flex:none;}',
      '.napcat-dot.online{background:var(--dsw-alias-state-success-primary,#2a9d5c);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#2a9d5c) 25%,transparent);}',
      '.napcat-dot.offline{background:var(--dsw-alias-state-danger-primary,#d4574e);}',
      '.napcat-dot.busy{background:var(--dsw-alias-state-warning-primary,#d99b2b);}',
      '.napcat-dot.unknown{background:var(--dsw-alias-label-secondary,#999);}',
      '.napcat-status .meta{font-size:.85em;color:var(--dsw-alias-label-secondary,inherit);}',
      '.napcat-lights{display:grid;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);border:1px solid var(--dsw-alias-border-l1,#8884);}',
      '.napcat-endpoints{display:grid;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);border:1px solid var(--dsw-alias-border-l1,#8884);}',
      '.napcat-endpoint-row{display:grid;grid-template-columns:auto 1fr auto;grid-template-areas:"k v d" "h h h";align-items:center;gap:2px 8px;}',
      '.napcat-endpoint-k{grid-area:k;font-size:.85em;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;}',
      '.napcat-endpoint-v{grid-area:v;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;}',
      '.napcat-endpoint-row .napcat-dot{grid-area:d;}',
      '.napcat-endpoint-row .napcat-hint{grid-area:h;margin:0;}',
      '.napcat-light-row{display:flex;align-items:center;gap:10px;line-height:1.4;}',
      '.napcat-light-mark{font:600 12px/1 ui-monospace,monospace;width:1em;text-align:center;color:var(--dsw-alias-label-secondary,inherit);}',
      '.napcat-title{font-weight:600;}',
      '.napcat-pre{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,currentColor 6%,transparent);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;}',
      '.napcat-token{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,currentColor 6%,transparent);}',
      '.napcat-token code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;}',
      '.napcat-token .tag{font-size:.75em;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,#888);color:var(--dsw-alias-label-secondary,inherit);}',
      '.napcat-frame-wrap{position:relative;display:grid;gap:8px;}',
      '.napcat-frame{border:1px solid var(--dsw-alias-border-l1,#8884);border-radius:var(--dsw-radius-md,12px);width:100%;height:min(70vh,720px);background:#fff;}',
      '.napcat-frame-fallback{display:grid;gap:10px;padding:14px 16px;border:1px dashed var(--dsw-alias-border-l3,#888);border-radius:var(--dsw-radius-md,12px);}',
      '.napcat-logline{display:block;}',
      '.napcat-logline.hit{color:var(--dsw-alias-state-warning-primary,#d99b2b);}',
      '@media(max-width:640px){.napcat-columns{grid-template-columns:1fr;gap:14px;}}',
    ].join('\n');

    // ── 字段：与 lib/index.js 的 Config 一一对应 ──
    const FIELDS = [
      { sec: '内置 NapCat（随插件自带）', key: 'autoStartNapCat', label: '启用时自动启动内置 NapCat', type: 'checkbox', hint: '插件启用即自动拉起内置 NapCat，并做进程检测防止重复多开。' },
      { sec: '内置 NapCat（随插件自带）', key: 'stopNapCatOnDisable', label: '禁用插件时停止内置 NapCat', type: 'checkbox', hint: '关闭插件（或退出 DSH）时自动结束由本插件启动的 NapCat 进程，避免残留。' },
      { sec: '内置 NapCat（随插件自带）', key: 'webuiPort', label: 'WebUI 端口', type: 'number', hint: '默认 6099；启动前会自动写入 NapCat 的 WebUI 配置。' },
      { sec: '内置 NapCat（随插件自带）', key: 'webuiToken', label: 'WebUI 管理 Token（可留空）', type: 'password', hint: '登录 WebUI 用。留空即自动生成并从启动日志读取，无需手填。' },
      { sec: '内置 NapCat（随插件自带）', key: 'qqPath', label: 'QQ.exe 路径（可留空）', type: 'text', hint: '留空自动探测。NapCat 通过注入已安装的 QQ NT 运行，所以系统需装有官方 QQ。' },
      { sec: '内置 NapCat（随插件自带）', key: 'napcatHome', label: '内置 NapCat 目录（可留空）', type: 'text', hint: '留空使用插件自带 vendor/napcat。' },
      { sec: '内置 NapCat（随插件自带）', key: 'napcatStartTimeout', label: '启动等待超时（毫秒）', type: 'number', hint: '默认 60000。' },

      { sec: '连接（全部自动维护，无需手改）', key: 'napcatHttpUrl', label: 'OneBot HTTP 地址', type: 'text', hint: '插件自动写入 NapCat 配置；一般不用改。' },
      { sec: '连接（全部自动维护，无需手改）', key: 'napcatWsUrl', label: 'OneBot 正向 WS 地址', type: 'text', hint: '必须是 OneBot 的 ws 端口（默认 ws://127.0.0.1:3001）。填成 6099（WebUI 管理端口）会被插件自动纠正，因为那是管理面、不承载 OneBot。' },
      { sec: '连接（全部自动维护，无需手改）', key: 'napcatToken', label: 'OneBot access_token', type: 'password', hint: '首次启用自动随机生成并同步给 NapCat，你不需要填。清空后下次启用会重新生成。' },
      { sec: '连接（全部自动维护，无需手改）', key: 'napcatConsoleUrl', label: 'WebUI 地址', type: 'text', hint: '「NapCat WebUI」标签页内嵌此地址（会自动附加 token）。' },
      { sec: '连接（全部自动维护，无需手改）', key: 'selfQQ', label: '机器人自身 QQ（可留空）', type: 'text', hint: '留空会在登录后自动获取并记住，用于群内 @ 判定。' },
      { sec: '连接（全部自动维护，无需手改）', key: 'receiveMode', label: '接收模式', type: 'select', options: [['ws', 'ws（推荐，正向 WebSocket）'], ['webhook', 'webhook（HTTP 上报）']], hint: '默认 ws，最省事。' },
      { sec: '连接（全部自动维护，无需手改）', key: 'webhookPath', label: 'Webhook 路径', type: 'text', hint: 'webhook 模式下的上报路径。' },

      { sec: 'WS 重连策略', key: 'wsRetryInterval', label: '首次重连间隔（毫秒）', type: 'number', hint: '默认 2000，之后按 2→4→8→15 秒指数退避。' },
      { sec: 'WS 重连策略', key: 'wsRetryMaxInterval', label: '重连间隔上限（毫秒）', type: 'number', hint: '默认 15000。' },
      { sec: 'WS 重连策略', key: 'wsMaxRetries', label: '最大连续重试次数', type: 'number', hint: '0 = 一直重试（推荐，QQ 掉线重连后能自动恢复）。' },
      { sec: 'WS 重连策略', key: 'wsHeartbeatTimeout', label: '心跳超时（毫秒）', type: 'number', hint: '多久收不到任何数据（含心跳）就强制重连，默认 100000。' },

      { sec: '人格与回复', key: 'personaPrompt', label: '系统人格提示词（唯一 system，最高优先级）', type: 'textarea', hint: '这里填的文本会原样作为模型唯一的 system 提示词；留空则完全不发 system（不会自动补任何默认人设或兜底话术）。改完点保存立即生效，无需重启。' },
      { sec: '人格与回复', key: 'replyMode', label: '回复引擎', type: 'select', options: [['dsh', 'DSH 当前大模型（推荐，无需填 Key）'], ['llm', '自填 OpenAI 兼容接口'], ['local', '离线兜底应答']], hint: '默认用你在 DSH 里选中的大模型，自动带上人设与记忆。' },
      { sec: '人格与回复', key: 'llmEndpoint', label: '直连 LLM 接口地址', type: 'text', hint: '仅 replyMode=llm 时生效。' },
      { sec: '人格与回复', key: 'llmApiKey', label: '直连 LLM API Key', type: 'password', hint: '仅 replyMode=llm 时生效；失败自动改用 DSH 模型。' },
      { sec: '人格与回复', key: 'llmModel', label: '直连 LLM 模型名', type: 'text', hint: '如 deepseek-chat。' },
      { sec: '人格与回复', key: 'botName', label: '机器人自称', type: 'text', hint: '写进对话记忆的署名，只影响上下文展示，一般填「我」。' },

      { sec: '会话策略', key: 'groupUniqueSession', label: '群聊独立会话（unique_session）', type: 'checkbox', hint: '开启：群内每个 QQ 用户各自一套上下文，互不串记忆；关闭：整个群共用一套。私聊永远按 QQ 独立，不受此开关影响。' },
      { sec: '会话策略', key: 'groupWakeTimeoutSec', label: '连续对话免 @ 超时（秒）', type: 'number', hint: '在群里 @ 过一次后，这段时间内继续发言不需要再 @，默认 120 秒。超时后需重新 @。' },
      { sec: '会话策略', key: 'contextCompress', label: '上下文自动压缩', type: 'checkbox', hint: '历史过长时自动总结成摘要，减少 token 消耗并保持连贯。' },
      { sec: '会话策略', key: 'contextMaxChars', label: '压缩触发字符数', type: 'number', hint: '历史累计超过这个字符数就触发压缩，默认 2400。' },
      { sec: '会话策略', key: 'superUsers', label: '超级管理员 QQ（逗号分隔）', type: 'text', hint: '这些 QQ 可以使用 /op /ban /model 等管理指令。' },
      { sec: '会话策略', key: 'blacklist', label: '黑名单 QQ（逗号分隔）', type: 'text', hint: '这些人的消息一律丢弃，不回复。' },
      { sec: '会话策略', key: 'whitelist', label: '用户白名单（逗号分隔）', type: 'text', hint: '留空表示不限制；填了则只响应名单内的人。' },
      { sec: '会话策略', key: 'groupBlacklist', label: '群黑名单（群号，逗号分隔）', type: 'text', hint: '这些群的消息一律丢弃。' },
      { sec: '会话策略', key: 'groupWhitelist', label: '群白名单（群号，逗号分隔）', type: 'text', hint: '留空表示不限制；填了则只响应这些群。' },

      { sec: '模型与多媒体', key: 'providers', label: '可用服务商（逗号分隔）', type: 'text', hint: '供 /provider 切换用；留空则只跟随 DSH 当前模型。' },
      { sec: '模型与多媒体', key: 'providerOverride', label: '默认服务商覆盖', type: 'text', hint: '留空 = 跟随 DSH 当前选择。' },
      { sec: '模型与多媒体', key: 'modelOverride', label: '默认模型覆盖', type: 'text', hint: '留空 = 跟随 DSH 当前选择。' },
      // ── 识图（多模态）：看图 → 拿描述 → 交给人设组织语言 ──
      { sec: '识图（多模态）', key: 'visionEnabled', label: '识图功能总开关', type: 'checkbox', hint: '开启后，QQ 图片会直接随对话发给当前主模型（V4.1-Flash 自带视觉），不用另填识图接口；关闭则只回人设兜底台词。' },
      { sec: '识图（多模态）', key: 'visionPrompt', label: '识图提示词（默认模式）', type: 'textarea', hint: '默认「看懂这张图的梗和情绪，顺着对方的话接梗互动，不要描述画面」。默认只接梗不报画面；对方说「描述一下这张图 / 图里长啥样 / 详细讲讲画面」时自动切换成描述画面（不受这里影响）。' },

      // ── 联网搜索：手动指令 + 不懂自动查证 ──
      { sec: '联网搜索', key: 'searchEnabled', label: '联网搜索总开关', type: 'checkbox', hint: '关闭后「帮我搜 / 搜一下 / 查一下 / 上网查」也不会去搜，自动查证同时停用。' },
      { sec: '联网搜索', key: 'searchAutoEnabled', label: '不懂自动搜索（推荐开）', type: 'checkbox', hint: '遇到时效信息（新闻/价格/时刻/发售）、现实实体资料（地点/参数/教程/冷门知识）、自己拿不准的事实，自动联网查证，不用你说「搜一下」。闲聊、情绪、玩梗、人设对话不会搜。' },
      { sec: '联网搜索', key: 'searchAutoJudge', label: '自动搜索前用模型二次确认', type: 'checkbox', hint: '本地关键词拿不准时多问模型一句「要不要查」，判定更准（每轮多一次很轻的调用，约 1 秒）。关掉就纯按关键词判断，更快但可能漏判。' },
      { sec: '联网搜索', key: 'searchEndpoint', label: '自定义搜索接口（可留空）', type: 'text', hint: '留空 = 用 DSH 自带的 DeepSeek 原生搜索（推荐，无需配置）。也可填 SearXNG 之类兼容接口，支持 {q} 占位或自动追加 ?q=，返回 JSON（results/items/data）或纯文本。' },
      { sec: '联网搜索', key: 'searchApiKey', label: '搜索接口 API Key（可留空）', type: 'password', hint: '填了会以 Bearer 方式带上；宿主原生搜索不需要填。' },
      { sec: '联网搜索', key: 'searchMaxResults', label: '每次取几条结果', type: 'number', hint: '1~8，默认 5。条数越多上下文越长，5 条一般够用。' },

      { sec: '模型与多媒体', key: 'kbEnabled', label: '启用人格/知识库检索', type: 'checkbox', hint: '总开关；具体挂哪个知识库在「管理 → 知识库」的规则里绑定。' },

      // ── 语音（TTS）：四种模式三选一 + 性格随机模式 ──
      { sec: '语音（TTS）', key: 'ttsMode', label: '语音模式（四选一）', type: 'select', options: [
        ['off', '关闭（只发文字）'],
        ['all', '全部消息转语音'],
        ['keyword', '关键词触发（说了才出声）'],
        ['random', '性格随机模式（想发就发）'],
      ], hint: '性格随机模式：每轮先掷骰子，命中才发语音，没命中只发文字——模拟“想发就发/懒得开口”的随性。' },
      { sec: '语音（TTS）', key: 'ttsProbability', label: '语音概率（仅性格随机模式）', type: 'range', min: 0, max: 100, step: 5, unit: '%', hint: '拖动调节 0~100%，默认 40%。0 = 永不发，100 = 次次发。' },
      { sec: '语音（TTS）', key: 'ttsSmartWeight', label: '人设智能权重（推荐开）', type: 'checkbox', hint: '短句、情绪活泼的内容更容易触发语音；长段解释、安静 emo 的内容自动降低概率，贴合大肥鱼懒懒的性格。' },
      { sec: '语音（TTS）', key: 'ttsVoiceRandom', label: '随机音色（开 = 每次音色都可能不一样）', type: 'checkbox', hint: '开启后每次发语音都从下面的音色池里随机挑一个；关闭则固定用「固定音色」。' },
      { sec: '语音（TTS）', key: 'ttsVoicePool', label: '音色池（逗号分隔）', type: 'text', hint: '软萌音色池，随机音色从这里挑。请填你的 TTS 服务认识的音色名/ID。' },
      { sec: '语音（TTS）', key: 'ttsVoice', label: '固定音色（关闭随机音色时用）', type: 'text', hint: '留空则用音色池第一个。' },
      { sec: '语音（TTS）', key: 'ttsUrl', label: 'TTS 接口地址', type: 'text', hint: 'POST {text, voice} → 返回音频二进制，或 {audio_base64}；失败自动只发文字，不会崩。OpenAI 兼容接口（/v1/audio/speech）也能直接用。' },
      { sec: '语音（TTS）', key: 'ttsLocalEngine', label: '接口没填时用系统内置语音（推荐开）', type: 'checkbox', hint: '没填 TTS 接口地址时，用 Windows 自带语音离线合成，开箱即用、不用联网；接口填了则以接口为准。' },
      { sec: '语音（TTS）', key: 'ttsLocalVoice', label: '内置语音音色（可选）', type: 'text', hint: '填系统语音名的一部分即可，如 Huihui / Xiaoxiao / Yaoyao；留空用系统默认中文语音。' },
      { sec: '语音（TTS）', key: 'ttsModel', label: 'TTS 模型名（可选）', type: 'text', hint: '仅 OpenAI 兼容 /v1/audio/speech 需要，如 tts-1 / gpt-4o-mini-tts；自建接口留空即可。' },
      { sec: '语音（TTS）', key: 'ttsKeywords', label: '关键词触发词（逗号分隔）', type: 'text', hint: '仅「关键词触发」模式用：用户或回复里出现这些词就发语音。' },
      { sec: '语音（TTS）', key: 'ttsReplaceText', label: '命中语音时只发语音', type: 'checkbox', hint: '开启：命中就只发语音（更像真人）；关闭：文字+语音都发。回复超长时会自动补发文字。' },
      { sec: '语音（TTS）', key: 'ttsMaxChars', label: '单条语音最长字数', type: 'number', hint: '默认 300，超出部分不合成，此时会自动补发文字。' },

      { sec: '模型与多媒体', key: 'kbEnabled', label: '启用人格/知识库检索', type: 'checkbox', hint: '总开关；具体挂哪个知识库在「管理 → 知识库」的规则里绑定。' },

      { sec: '主动发言', key: 'proactiveEnabled', label: '主动找我（随缘）', type: 'checkbox', hint: '安静下来后持续做随机判定，想起你了就来找你；没有每日次数上限，只受冷却限制。默认开启，仅私聊生效。' },
      { sec: '主动发言', key: 'proactiveCooldownSec', label: '冷却间隔（最小间隔）', type: 'range', min: 60, max: 1800, step: 30, unit: ' 秒', hint: '60~1800 秒，默认 180。发出一条主动消息后，至少隔这么久才可能再来一条（防刷屏）；冷却过完如果还没人说话，会继续随缘判定。' },
      { sec: '主动发言', key: 'proactiveInGroup', label: '群聊也允许主动找我', type: 'checkbox', hint: '默认关闭，只在私聊主动；群聊里容易打扰，除非你确实想要（规则面板也能单独开）。' },
      { sec: '行为与风控', key: 'memoryEnabled', label: '记忆存储', type: 'checkbox', hint: '把 QQ 对话自动记录到本地，并在回复时作为上下文带入。' },
      { sec: '行为与风控', key: 'groupReplyOnlyAt', label: '群内仅 @ 时回复', type: 'checkbox', hint: '默认开启；关闭则对群内所有消息都回复（注意配合风控）。' },
      { sec: '行为与风控', key: 'messageIntervalLimit', label: '消息冷却间隔（毫秒）', type: 'number', hint: '同一会话两次发送的最小间隔，防刷屏。' },
      { sec: '行为与风控', key: 'maxReplyPerMin', label: '每分钟最大回复数', type: 'number', hint: '风控上限。' },
    ];

    const clone = (o) => (o ? Object.assign({}, o) : {});
    const toStr = (v) => (v == null ? '' : String(v));

    // 语音模式的可读名（配置区与规则区共用）
    const TTS_MODE_TEXT = { off: '关闭', all: '全部转语音', keyword: '关键词触发', random: '性格随机模式', force: '强制语音' };

    function api(pathName, opts) {
      return fetch('/napcat-bot/api' + pathName, Object.assign({ cache: 'no-store' }, opts || {}))
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }

    function copyText(text) {
      try {
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
      } catch (e) { /* ignore */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch (e) { /* ignore */ }
      return Promise.resolve();
    }

    // ── 实时状态轮询（OneBot 登录态 + 内置 NapCat 进程态 + WebUI token）──
    function useStatusPoll(intervalMs) {
      const [status, setStatus] = useState({ state: 'loading' });
      useEffect(() => {
        let alive = true;
        function poll() {
          api('/status')
            .then((j) => { if (alive) setStatus(j && typeof j === 'object' ? j : { state: 'unknown' }); })
            .catch((e) => { if (alive) setStatus({ state: 'error', error: String((e && e.message) || e) }); });
        }
        poll();
        const timer = setInterval(poll, intervalMs || 3000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      return status;
    }

    // ── 内置 NapCat 状态文案 ──
    function napcatView(nap) {
      const s = (nap && nap.state) || 'idle';
      const map = {
        idle: ['unknown', '内置 NapCat 尚未启动', ''],
        starting: ['busy', '内置 NapCat 正在启动…', '首次启动约 10–30 秒，随后在「NapCat WebUI」标签页扫码登录。'],
        webui: ['online', '内置 NapCat 已启动', ''],
        running: ['online', '内置 NapCat 已在运行', ''],
        'no-qq': ['offline', '未检测到 QQ NT', 'NapCat 需要注入已安装的 QQ，请先安装官方 QQ，或在上方填写 QQ.exe 路径。'],
        failed: ['offline', '内置 NapCat 启动失败', ''],
        stopped: ['offline', '内置 NapCat 未运行', '内置 NapCat 进程已退出，可点「启动内置 NapCat」重新拉起。'],
        unsupported: ['offline', '当前系统不支持内置 NapCat', '内置 NapCat 仅支持 Windows。'],
      };
      const hit = map[s] || ['unknown', '状态未知', ''];
      return { dot: hit[0], title: hit[1], tip: (nap && nap.reason) || hit[2] || '' };
    }

    // ── 状态灯（语义与用户要求一致）──
    //   process 绿：NapCat 进程已启动
    //   ws 黄：WS 正在尝试连接；ws 绿勾：WS 连接成功
    //   ready 绿勾：可以收发消息
    function Lights(props) {
      const { lights, ws } = props;
      const L = lights || {};
      const proc = L.process || {};
      const w = L.ws || {};
      const ready = L.ready || {};
      const wsDot = w.ok ? 'online' : w.busy ? 'busy' : 'offline';
      const wsText = (w.text || 'WS 状态未知')
        + (w.ok ? '（客户端数 ' + (w.clients != null ? w.clients : 1) + '）' : '')
        + (ws && ws.attempts ? `（第 ${ws.attempts} 次重试）` : '');
      const rows = [
        [proc.ok ? 'online' : 'offline', proc.text || 'NapCat 进程状态未知', proc.ok ? '✓' : '×'],
        [wsDot, wsText, w.ok ? '✓' : w.busy ? '…' : '×'],
        [ready.ok ? 'online' : 'unknown', ready.text || '尚未就绪', ready.ok ? '✓' : '…'],
      ];
      return h('div', { className: 'napcat-lights' },
        rows.map((row, i) => h('div', { className: 'napcat-light-row', key: i },
          h('span', { className: 'napcat-dot ' + row[0] }),
          h('span', { className: 'napcat-light-mark' }, row[2]),
          h('span', null, row[1])
        )),
        w.url ? h('p', { className: 'napcat-hint' }, 'WS 目标：' + w.url + (w.port ? '（端口 ' + w.port + '）' : '')) : null,
        ws && ws.lastError ? h('p', { className: 'napcat-note err' }, ws.lastError) : null,
        ws && ws.nextRetryAt
          ? h('p', { className: 'napcat-hint' }, '下次重连约 ' + Math.max(1, Math.round((ws.nextRetryAt - Date.now()) / 1000)) + ' 秒后')
          : null
      );
    }

    // ── 生效中的人设 + 会话概况（用来确认「填的到底有没有被用上」）──
    function PersonaLine(props) {
      const st = props.status || {};
      const p = st.persona || {};
      const cf = st.config || {};
      const se = st.sessions || {};
      const chars = (p.text || '').length;
      const empty = chars === 0;
      return h('div', { className: 'napcat-status' },
        h('div', { className: 'napcat-status-row' },
          h('span', { className: 'napcat-dot ' + (empty ? 'unknown' : 'online') }),
          h('span', { className: 'napcat-title' }, empty ? '当前未设置人设（模型按默认风格说话）' : '人设已生效'),
          h('span', { className: 'meta' }, chars + ' 字 · 来源：' + (p.source === 'host' ? 'DSH 插件设置' : '本面板'))
        ),
        empty ? null : h('p', { className: 'meta' }, '预览：' + String(p.preview || '').slice(0, 80) + (chars > 80 ? '…' : '')),
        h('p', { className: 'meta' },
          '群聊独立会话：' + (cf.groupUniqueSession === false ? '关闭（全群共用上下文）' : '开启（每人独立）')
          + '　·　免@超时：' + (cf.groupWakeTimeoutSec || 120) + ' 秒'
          + '　·　会话数：' + (se.sessions || 0)),
        EngineLine(st),
        TtsLine(st),
        VisionLine(st),
        SearchLine(st),
        ProactiveLine(st)
      );
    }

    // ── 联网搜索状态：开关 / 自动查证 / 提供方 / 命中与失败 ──
    function SearchLine(st) {
      const s2 = (st && st.search) || {};
      if (!s2.enabled) {
        return h('p', { className: 'meta' }, '联网搜索：关闭（手动「搜一下」也不会执行）');
      }
      const parts = [];
      parts.push(s2.auto ? '不懂自动查（' + (s2.judge ? '模型二次确认' : '仅关键词') + '）' : '仅手动指令');
      const prov = s2.provider === 'dsh-web' ? '宿主 DeepSeek 原生搜索'
        : (s2.provider === 'custom' ? '自定义接口' : '未就绪');
      parts.push(prov);
      if (s2.available === false) parts.push('没有可用搜索后端 → 自动查证会跳过');
      if (s2.ok) parts.push('搜到 ' + s2.ok);
      if (s2.fail) parts.push('失败 ' + s2.fail);
      if (s2.manual) parts.push('手动 ' + s2.manual);
      if (s2.autoCount) parts.push('自动 ' + s2.autoCount);
      const lastQ = s2.last && s2.last.q ? String(s2.last.q).slice(0, 24) : '';
      return h('div', null,
        h('p', { className: 'meta' }, '联网搜索：' + parts.join(' · ')),
        lastQ ? h('p', { className: 'napcat-hint' }, '上次检索：' + lastQ + (s2.last.ok ? '' : '（无结果）')) : null
      );
    }

    // ── 主动发言状态：开关 / 冷却 / 待机会话 / 已开口次数 / 收尾暂停 ──
    function ProactiveLine(st) {
      const p = (st && st.proactive) || {};
      if (!p.enabled && !p.firedCount && !p.pending) return null;
      const parts = [];
      parts.push(p.enabled ? '开启（随缘）' : '关闭');
      parts.push('冷却 ' + (p.cooldownSec || 180) + ' 秒');
      if (p.groupEnabled) parts.push('群聊也允许');
      if (p.pending) parts.push('待机 ' + p.pending + ' 个会话');
      if (p.firedCount) parts.push('已主动 ' + p.firedCount);
      if (p.skippedCount) parts.push('没心情 ' + p.skippedCount);
      if (p.pausedCount) parts.push('收尾暂停 ' + p.pausedCount);
      const lastAt = p.last && p.last.sent ? new Date(p.last.at).toLocaleTimeString('zh-CN') : '';
      return h('div', null,
        h('p', { className: 'meta' }, '主动发言：' + parts.join(' · ')),
        lastAt ? h('p', { className: 'napcat-hint' }, '上次主动开口：' + lastAt) : null
      );
    }

    // ── 识图状态：开关 / 原生多模态（图片随对话进主模型）/ 成功失败计数 ──
    function VisionLine(st) {
      const v = (st && st.vision) || {};
      if (!v.enabled && !v.okCount && !v.failCount) return null;
      const parts = [];
      parts.push(v.enabled ? '开启' : '关闭');
      parts.push(v.enabled ? '图片随对话进主模型（V4.1-Flash 原生视觉）' : '关闭 → 走人设兜底台词');
      if (v.enabled) parts.push('默认接梗不报画面（说「描述一下这张图」才讲画面）');
      if (v.available === false) parts.push('宿主附件服务不可用');
      if (v.okCount) parts.push('识图成功 ' + v.okCount);
      if (v.failCount) parts.push('失败 ' + v.failCount);
      if (v.offCount) parts.push('关闭 ' + v.offCount);
      const lastText = v.last && v.last.state === 'ok'
        ? ('图 ' + (v.last.count || 1) + ' 张 · ' + Math.round((v.last.bytes || 0) / 1024) + 'KB')
        : '';
      return h('div', null,
        h('p', { className: 'meta' }, '识图：' + parts.join(' · ')),
        lastText ? h('p', { className: 'napcat-hint' }, '最近一次：' + lastText) : null
      );
    }

    // ── 语音（TTS）状态：模式 / 概率 / 已发与跳过次数（验收「想发就发」用）──
    function TtsLine(st) {
      const t = (st && st.tts) || {};
      const mode = String(t.mode || 'off');
      const label = TTS_MODE_TEXT[mode] || mode;
      if (mode === 'off' && !t.url) return null;
      const extra = [];
      const eng = t.engine === 'local' ? '内置语音' : (t.engine === 'http' ? 'TTS接口' : '无引擎');
      extra.push(eng);
      if (mode === 'random') extra.push('概率 ' + (t.probability == null ? 40 : t.probability) + '%');
      if (t.voiceRandom) extra.push('随机音色');
      extra.push('已发 ' + (t.sent || 0));
      extra.push('跳过 ' + (t.skipped || 0));
      if (t.force) extra.push('强制 ' + t.force);
      if (t.failed) extra.push('失败 ' + t.failed);
      if (!t.url && t.engine !== 'local') extra.push('未填接口地址');
      const last = t.last && t.last.ok;
      return h('p', { className: 'meta' }, '语音：' + label + '　·　' + extra.join(' · ')
        + (last && t.last.voice ? '　·　上一句音色：' + t.last.voice : ''));
    }

    // ── 上一次模型生成的结果（失败原因直接显示，不用翻日志）──
    function EngineLine(st) {
      const el = (st && st.engineLast) || {};
      const eg = (st && st.engine) || {};
      if (!el.at) {
        return h('p', { className: 'meta' },
          '回复引擎：' + (eg.effective || eg.mode || 'dsh') + (eg.route ? '（' + eg.route.provider + ' / ' + eg.route.model + '）' : '')
          + '　·　尚无生成记录');
      }
      const ok = el.ok === true;
      const first = Array.isArray(el.errors) && el.errors.length ? String(el.errors[0]) : '';
      return h('div', null,
        h('p', { className: 'meta' },
          '回复引擎：' + (eg.effective || eg.mode || 'dsh') + (eg.route ? '（' + eg.route.provider + ' / ' + eg.route.model + '）' : '')
          + '　·　上次生成：' + (ok ? '成功' : '失败') + (el.plan ? '（' + el.plan + '）' : '')),
        ok ? null : h('p', { className: 'napcat-hint' }, '模型报错：' + (first || '未知'))
      );
    }


    // ── 管理标签页：人格 / 会话 / 规则 / 知识库 / 任务 ──
    // 数据全部来自 /napcat-bot/api/manage?res=xxx，本地目录持久化。
    function ManageTab() {
      const [sub, setSub] = useState('personas');
      const [items, setItems] = useState([]);
      const [extra, setExtra] = useState({});
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);

      function load() {
        setBusy(true);
        api('/manage?res=' + sub + '&t=' + Date.now())
          .then((j) => setItems((j && j.items) || []))
          .catch((e) => setMsg({ kind: 'err', text: '加载失败：' + ((e && e.message) || e) }))
          .then(() => setBusy(false));
      }
      useEffect(() => { load(); }, [sub]);

      function post(payload) {
        setBusy(true);
        api('/manage?res=' + sub, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
          .then((j) => {
            setMsg({ kind: j && j.ok ? 'ok' : 'err', text: j && j.ok ? '已保存' : ('失败：' + ((j && j.error) || '')) });
            if (j && j.extra) setExtra(j.extra);
            load();
          })
          .catch((e) => setMsg({ kind: 'err', text: '失败：' + ((e && e.message) || e) }))
          .then(() => setBusy(false));
      }

      const SUBS = [['personas', '人格'], ['sessions', '会话'], ['rules', '规则'], ['kb', '知识库'], ['tasks', '任务']];

      function row(children, key) {
        return h('div', { className: 'napcat-status', key }, children);
      }

      let body = null;
      if (sub === 'personas') {
        body = h('div', { className: 'napcat-settings' },
          items.map((p) => row([
            h('div', { className: 'napcat-status-row' },
              h('span', { className: 'napcat-title' }, p.name),
              h('span', { className: 'meta' }, (p.prompt || '').length + ' 字'),
              h('button', { type: 'button', disabled: busy, onClick: () => post({ action: 'global', id: p.id }) }, '设为全局'),
              h('button', { type: 'button', disabled: busy, onClick: () => post({ action: 'remove', id: p.id }) }, '删除')
            ),
            h('p', { className: 'meta' }, String(p.prompt || '').replace(/\s+/g, ' ').slice(0, 90)),
          ], p.id)),
          h('form', {
            className: 'napcat-settings',
            onSubmit: (e) => {
              e.preventDefault();
              const f = e.target;
              post({ action: 'save', name: f.pname.value, prompt: f.pprompt.value });
              f.pprompt.value = '';
            },
          },
          h('h4', null, '新建人格'),
          h('label', { className: 'napcat-field' }, h('span', null, '名称'), h('input', { name: 'pname', type: 'text', placeholder: '如：大肥鱼' })),
          h('label', { className: 'napcat-field' }, h('span', null, 'Prompt'), h('textarea', { name: 'pprompt', placeholder: '你是一只叫“大肥鱼”的咸鱼…\n支持变量：{{bot_name}} {{group_id}} {{user_id}} {{time}}' })),
          h('button', { type: 'submit', className: 'napcat-primary', disabled: busy }, '保存人格'))
        );
      } else if (sub === 'sessions') {
        body = h('div', { className: 'napcat-settings' },
          items.length ? items.map((s) => row([
            h('div', { className: 'napcat-status-row' },
              h('span', { className: 'napcat-title' }, s.title || s.key),
              h('span', { className: 'meta' }, `${s.messages} 条 · ${s.tokens} token`),
              h('button', { type: 'button', disabled: busy, onClick: () => {
                const t = window.prompt('新的会话标题', s.title || '');
                if (t) post({ action: 'rename', key: s.key, title: t });
              } }, '重命名'),
              h('button', { type: 'button', disabled: busy, onClick: () => post({ action: 'reset', key: s.key }) }, '清空'),
              h('button', { type: 'button', disabled: busy, onClick: () => post({ action: 'remove', key: s.key }) }, '删除')
            ),
            h('p', { className: 'meta' }, s.key),
          ], s.key)) : h('p', { className: 'meta' }, '还没有任何会话，聊一句就会自动创建。')
        );
      } else if (sub === 'rules') {
        body = h('div', { className: 'napcat-settings' },
          items.map((r) => row([
            h('div', { className: 'napcat-status-row' },
              h('span', { className: 'napcat-title' }, r.scope),
              h('span', { className: 'meta' }, [r.llmEnabled === false ? '关闭LLM' : 'LLM', r.personaId ? '人格' : '', r.model || '',
                r.ttsMode ? ('语音:' + (TTS_MODE_TEXT[r.ttsMode] || r.ttsMode)) : '',
                Number(r.ttsProbability) >= 0 ? (r.ttsProbability + '%') : '',
                r.visionEnabled === false ? '关闭识图' : (r.visionEnabled === true ? '开启识图' : ''),
                r.proactiveEnabled === true ? '主动发言' : (r.proactiveEnabled === false ? '不主动' : ''),
                r.searchEnabled === false ? '不联网' : '',
                r.searchAutoEnabled === false ? '不自动搜' : ''].filter(Boolean).join(' · ')),
              h('button', { type: 'button', disabled: busy, onClick: () => post({ action: 'remove', id: r.id }) }, '删除')
            ),
          ], r.id)),
          h('form', {
            className: 'napcat-settings',
            onSubmit: (e) => {
              e.preventDefault();
              const f = e.target;
              post({
                action: 'save', scope: f.scope.value,
                personaId: f.personaId.value, provider: f.provider.value, model: f.model.value,
                llmEnabled: f.llm.checked,
                // 语音覆盖：留空/跟随 = 继承全局
                ttsMode: f.ttsmode.value,
                ttsProbability: f.ttsprob.value === '' ? -1 : Number(f.ttsprob.value),
                ttsVoiceRandom: f.ttsvoice.value === 'inherit' ? null : (f.ttsvoice.value === 'on'),
                // 识图覆盖：跟随/开/关
                visionEnabled: f.vision.value === 'inherit' ? null : (f.vision.value === 'on'),
                // 主动发言覆盖：跟随/开/关
                proactiveEnabled: f.proactive.value === 'inherit' ? null : (f.proactive.value === 'on'),
                // 联网搜索覆盖：跟随/开/关；自动查证单独一档
                searchEnabled: f.search.value === 'inherit' ? null : (f.search.value === 'on'),
                searchAutoEnabled: f.searchauto.value === 'inherit' ? null : (f.searchauto.value === 'on'),
              });
            },
          },
          h('h4', null, '新增规则'),
          h('label', { className: 'napcat-field' }, h('span', null, '作用域'), h('input', { name: 'scope', type: 'text', placeholder: 'group:123456 或 private:10001 或 *' })),
          h('label', { className: 'napcat-field' }, h('span', null, '绑定人格 ID'), h('input', { name: 'personaId', type: 'text', placeholder: '留空 = 用全局人格' })),
          h('label', { className: 'napcat-field' }, h('span', null, '服务商'), h('input', { name: 'provider', type: 'text', placeholder: '留空 = 跟随默认' })),
          h('label', { className: 'napcat-field' }, h('span', null, '模型'), h('input', { name: 'model', type: 'text', placeholder: '留空 = 跟随默认' })),
          h('label', { className: 'napcat-field' }, h('span', null, '语音模式（本会话覆盖）'),
            h('select', { name: 'ttsmode', defaultValue: '' },
              h('option', { value: '' }, '跟随全局'),
              h('option', { value: 'off' }, '关闭'),
              h('option', { value: 'all' }, '全部转语音'),
              h('option', { value: 'keyword' }, '关键词触发'),
              h('option', { value: 'random' }, '性格随机模式'))),
          h('label', { className: 'napcat-field' }, h('span', null, '语音概率 %（留空 = 跟随全局）'),
            h('input', { name: 'ttsprob', type: 'number', min: 0, max: 100, placeholder: '如 70' })),
          h('label', { className: 'napcat-field' }, h('span', null, '随机音色（本会话覆盖）'),
            h('select', { name: 'ttsvoice', defaultValue: 'inherit' },
              h('option', { value: 'inherit' }, '跟随全局'),
              h('option', { value: 'on' }, '开启随机音色'),
              h('option', { value: 'off' }, '关掉随机音色'))),
          h('label', { className: 'napcat-field' }, h('span', null, '识图（本会话覆盖）'),
            h('select', { name: 'vision', defaultValue: 'inherit' },
              h('option', { value: 'inherit' }, '跟随全局'),
              h('option', { value: 'on' }, '开启识图'),
              h('option', { value: 'off' }, '关闭识图（图片只走兜底台词）'))),
          h('label', { className: 'napcat-field' }, h('span', null, '联网搜索（本会话覆盖）'),
            h('select', { name: 'search', defaultValue: 'inherit' },
              h('option', { value: 'inherit' }, '跟随全局'),
              h('option', { value: 'on' }, '允许联网'),
              h('option', { value: 'off' }, '本会话不联网'))),
          h('label', { className: 'napcat-field' }, h('span', null, '自动搜索（本会话覆盖）'),
            h('select', { name: 'searchauto', defaultValue: 'inherit' },
              h('option', { value: 'inherit' }, '跟随全局'),
              h('option', { value: 'on' }, '允许自动查证'),
              h('option', { value: 'off' }, '只手动搜'))),
          h('label', { className: 'napcat-field' }, h('span', null, '主动发言（本会话覆盖）'),
            h('select', { name: 'proactive', defaultValue: 'inherit' },
              h('option', { value: 'inherit' }, '跟随全局（群聊默认关）'),
              h('option', { value: 'on' }, '允许主动发言'),
              h('option', { value: 'off' }, '本会话不主动'))),
          h('label', { className: 'napcat-choice' }, h('input', { name: 'llm', type: 'checkbox', defaultChecked: true }), h('span', null, '启用 LLM（关闭则只走指令）')),
          h('button', { type: 'submit', className: 'napcat-primary', disabled: busy }, '保存规则'))
        );
      } else if (sub === 'kb') {
        body = h('div', { className: 'napcat-settings' },
          items.map((k) => row([
            h('div', { className: 'napcat-status-row' },
              h('span', { className: 'napcat-title' }, k.name),
              h('span', { className: 'meta' }, k.docs + ' 个片段'),
              h('button', { type: 'button', disabled: busy, onClick: () => post({ action: 'remove', id: k.id }) }, '删除')
            ),
            h('p', { className: 'meta' }, 'kbId: ' + k.id),
          ], k.id)),
          h('form', {
            className: 'napcat-settings',
            onSubmit: (e) => { e.preventDefault(); post({ action: 'create', name: e.target.kbname.value }); },
          },
          h('h4', null, '新建知识库'),
          h('label', { className: 'napcat-field' }, h('span', null, '名称'), h('input', { name: 'kbname', type: 'text', placeholder: '如：产品手册' })),
          h('button', { type: 'submit', className: 'napcat-primary', disabled: busy }, '创建')),
          h('form', {
            className: 'napcat-settings',
            onSubmit: (e) => {
              e.preventDefault();
              const f = e.target;
              post({ action: 'addDoc', id: f.docKb.value, title: f.docTitle.value, text: f.docText.value });
              f.docText.value = '';
            },
          },
          h('h4', null, '上传文本片段'),
          h('label', { className: 'napcat-field' }, h('span', null, '知识库 ID'), h('input', { name: 'docKb', type: 'text', placeholder: '上方 kbId' })),
          h('label', { className: 'napcat-field' }, h('span', null, '标题'), h('input', { name: 'docTitle', type: 'text', placeholder: '片段标题' })),
          h('label', { className: 'napcat-field' }, h('span', null, '正文'), h('textarea', { name: 'docText', placeholder: '把 txt / md 内容粘贴进来（PDF/DOCX 请先转文本）' })),
          h('button', { type: 'submit', className: 'napcat-primary', disabled: busy }, '加入知识库'))
        );
      } else {
        body = h('div', { className: 'napcat-settings' },
          items.map((t) => row([
            h('div', { className: 'napcat-status-row' },
              h('span', { className: 'napcat-title' }, t.name),
              h('span', { className: 'meta' }, t.target + (t.everySec ? ` · 每 ${t.everySec}s` : ' · 一次性') + (t.enabled ? '' : ' · 已停用')),
              h('button', { type: 'button', disabled: busy, onClick: () => post({ action: 'run', id: t.id }) }, '立即执行'),
              h('button', { type: 'button', disabled: busy, onClick: () => post({ action: 'remove', id: t.id }) }, '删除')
            ),
            h('p', { className: 'meta' }, String(t.prompt || '').slice(0, 80)),
          ], t.id)),
          h('form', {
            className: 'napcat-settings',
            onSubmit: (e) => {
              e.preventDefault();
              const f = e.target;
              post({
                action: 'add',
                name: f.tname.value,
                target: f.target.value,
                prompt: f.prompt.value,
                everySec: Number(f.every.value) || 0,
              });
            },
          },
          h('h4', null, '新增定时任务'),
          h('label', { className: 'napcat-field' }, h('span', null, '名称'), h('input', { name: 'tname', type: 'text', placeholder: '早安播报' })),
          h('label', { className: 'napcat-field' }, h('span', null, '目标'), h('input', { name: 'target', type: 'text', placeholder: 'group:123456 或 private:10001' })),
          h('label', { className: 'napcat-field' }, h('span', null, '内容（gen: 开头表示先用模型生成）'), h('textarea', { name: 'prompt', placeholder: 'gen:写一句早安问候' })),
          h('label', { className: 'napcat-field' }, h('span', null, '间隔秒（0 = 一次性）'), h('input', { name: 'every', type: 'number', defaultValue: 3600 })),
          h('button', { type: 'submit', className: 'napcat-primary', disabled: busy }, '创建任务'))
        );
      }

      return h('div', { className: 'napcat-settings' },
        h('div', { className: 'napcat-tabs' },
          SUBS.map(([k, label]) => h('button', {
            type: 'button', key: k,
            className: 'napcat-tab' + (sub === k ? ' on' : ''),
            onClick: () => setSub(k),
          }, label))),
        msg ? h('p', { className: 'napcat-note' + (msg.kind === 'err' ? ' err' : '') }, msg.text) : null,
        body
      );
    }

    // ── 端点明细：排障时一眼看出「连的到底是哪个端口」──
    // 重点是把 OneBot WS（3001）和 WebUI（6099）分开显示，避免再被误认为连了 6099。
    function Endpoints(props) {
      const st = props.status || {};
      const ep = st.endpoints || {};
      const cfg = st.config || {};
      const wsObj = st.ws || {};
      const wsUrl = ep.ws || cfg.napcatWsUrl || 'ws://127.0.0.1:3001';
      const httpUrl = ep.http || cfg.napcatHttpUrl || 'http://127.0.0.1:3000';
      const webuiUrl = ep.webui || (st.webui && st.webui.url) || 'http://127.0.0.1:6099/webui';
      const wsOpen = wsObj.state === 'open';
      const rows = [
        ['NapCat WebUI', webuiUrl, '管理面（扫码登录 QQ）', ''],
        ['OneBot 正向 WS', wsUrl, wsOpen ? '已连接 · 客户端 1' : '未连接 · 客户端 0', wsOpen ? 'online' : wsObj.state === 'connecting' ? 'busy' : 'offline'],
        ['OneBot HTTP', httpUrl, '发送通道（不可用时自动走 WS）', ''],
      ];
      return h('div', { className: 'napcat-endpoints' },
        rows.map((r, i) => h('div', { className: 'napcat-endpoint-row', key: i },
          h('span', { className: 'napcat-endpoint-k' }, r[0]),
          h('code', { className: 'napcat-endpoint-v' }, r[1]),
          r[3] ? h('span', { className: 'napcat-dot ' + r[3] }) : h('span', { className: 'napcat-dot unknown' }),
          h('span', { className: 'napcat-hint' }, r[2])
        ))
      );
    }

    function tokenTag(from) {
      if (from === 'log') return '来自启动日志';
      if (from === 'config') return '来自 webui.json';
      if (from === 'seed') return '来自插件托管';
      return '未读到';
    }

    // ── 状态卡片（内置 NapCat）──
    function statusCard(props) {
      const { nap, busy, onStart, onStop, onRestart, onOpenWebui } = props;
      const v = napcatView(nap);
      const meta = [];
      if (nap) {
        if (nap.pid) meta.push('PID ' + nap.pid);
        if (nap.port) meta.push('WebUI 端口 ' + nap.port);
        if (nap.qqPath) meta.push('QQ: ' + nap.qqPath);
      }
      return h('div', { className: 'napcat-status' },
        h('div', { className: 'napcat-status-row' },
          h('span', { className: 'napcat-dot ' + v.dot }),
          h('span', { className: 'napcat-title' }, v.title)
        ),
        v.tip ? h('p', { className: 'meta' }, v.tip) : null,
        meta.length ? h('p', { className: 'meta' }, meta.join('  ·  ')) : null,
        h('div', { className: 'napcat-actions' },
          h('button', { type: 'button', className: 'napcat-primary', disabled: busy, onClick: onStart }, zh.start),
          h('button', { type: 'button', disabled: busy, onClick: onRestart }, zh.restart),
          h('button', { type: 'button', disabled: busy, onClick: onStop }, zh.stop),
          h('button', { type: 'button', disabled: busy, onClick: onOpenWebui }, zh.openWebui)
        )
      );
    }

    // ── 日志预览（自动刷新 + Token 行高亮 + 复制）──
    function LogCard(props) {
      const { autoRefresh } = props;
      const source = props.source === 'messages' ? 'messages' : 'napcat';
      const isMsg = source === 'messages';
      const title = props.title || (isMsg ? '消息收发记录' : 'NapCat 控制台日志');
      const [lines, setLines] = useState([]);
      const [info, setInfo] = useState(null);
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState(false);
      const [live, setLive] = useState(autoRefresh !== false);
      const [onlyToken, setOnlyToken] = useState(false);
      const timer = useRef(0);

      function load() {
        setBusy(true);
        api(isMsg ? '/napcat/log?source=messages&tail=200' : '/napcat/log?tail=300')
          .then((j) => { setLines((j && j.lines) || []); setInfo(j || null); setErr(''); })
          .catch((e) => setErr('读取日志失败：' + ((e && e.message) || e)))
          .then(() => setBusy(false));
      }

      useEffect(() => {
        load();
        if (!live) return undefined;
        timer.current = setInterval(load, 4000);
        return () => clearInterval(timer.current);
      }, [live]);

      const shown = onlyToken ? lines.filter((l) => /token/i.test(l)) : lines;
      const token = (info && info.token) || '';

      return h('div', { className: 'napcat-status' },
        h('div', { className: 'napcat-status-row' },
          h('span', { className: 'napcat-title' }, title),
          h('span', { className: 'meta' }, live ? '实时刷新中（4s）' : '已暂停'),
          h('button', { type: 'button', disabled: busy, onClick: load }, zh.refresh),
          h('button', { type: 'button', onClick: () => setLive(!live) }, live ? '暂停' : '继续'),
          isMsg ? null : h('button', { type: 'button', onClick: () => setOnlyToken(!onlyToken) }, onlyToken ? '显示全部' : '只看 Token 行'),
          isMsg ? null : h('button', { type: 'button', disabled: !token, onClick: () => copyText(token) }, '复制日志里的 Token'),
          h('button', { type: 'button', disabled: !shown.length, onClick: () => copyText(shown.join('\n')) }, '复制日志')
        ),
        token && !isMsg ? h('p', { className: 'meta' }, '日志中解析到的 WebUI Token: ', h('code', null, token)) : null,
        err ? h('p', { className: 'napcat-note err' }, err) : null,
        h('pre', { className: 'napcat-pre' },
          shown.length
            ? shown.map((l, i) => h('span', {
              key: i,
              className: 'napcat-logline' + (/token|二维码|扫码|登录|error|错误/i.test(l) ? ' hit' : ''),
            }, l))
            : h('span', { className: 'meta' }, isMsg ? '（暂无消息记录；收到或发出 QQ 消息后会出现在这里）' : '（暂无日志；内置 NapCat 启动后会在这里实时输出）')
        ),
        info && info.path ? h('p', { className: 'meta' }, '日志文件: ' + info.path) : null
      );
    }

    // ── AI 配置面板（自托管：GET/POST /napcat-bot/api/config）──
    function NapcatPanel() {
      const [draft, setDraft] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState(null);
      const status = useStatusPoll(3000);

      useEffect(() => {
        let alive = true;
        api('/config')
          .then((j) => { if (alive) { setDraft(clone(j && typeof j === 'object' ? j : {})); setLoading(false); } })
          .catch((e) => { if (alive) { setDraft({}); setLoading(false); setMsg({ kind: 'err', text: '加载配置失败：' + ((e && e.message) || e) }); } });
        return () => { alive = false; };
      }, []);

      const d = draft || {};
      const nap = status.napcat || {};
      function edit(patch) { setDraft((prev) => Object.assign({}, prev || {}, patch)); setMsg(null); }

      function save() {
        if (busy) return;
        setBusy(true); setMsg(null);
        const body = {};
        for (const f of FIELDS) {
          let v = d[f.key];
          if (f.type === 'number' || f.type === 'range') v = Number(v) || 0;
          else if (f.type === 'checkbox') v = !!v;
          else v = toStr(v);
          body[f.key] = v;
        }
        // 旧版兼容字段：模式不是 off 就等于「曾经打开过 TTS」
        body.ttsEnabled = !!(body.ttsMode && body.ttsMode !== 'off');
        api('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
          .then((j) => setMsg({ kind: j && j.ok ? 'ok' : 'err', text: j && j.ok ? zh.saved : zh.rejected }))
          .catch((e) => setMsg({ kind: 'err', text: '保存失败：' + ((e && e.message) || e) }))
          .then(() => setBusy(false));
      }

      function napcatAction(action) {
        if (busy) return;
        setBusy(true); setMsg(null);
        api('/napcat/' + action, { method: 'POST' })
          .then(() => { setMsg({ kind: 'ok', text: action === 'stop' ? '已发送停止指令。' : '指令已下发，状态稍候刷新。' }); })
          .catch((e) => setMsg({ kind: 'err', text: '操作失败：' + ((e && e.message) || e) }))
          .then(() => setBusy(false));
      }

      function openWebui() {
        const base = toStr(nap.webuiUrl || nap.webui || d.napcatConsoleUrl || 'http://127.0.0.1:6099/webui');
        try { window.open(base, '_blank', 'noopener'); } catch (e) { /* ignore */ }
      }

      // 连接指示灯（未连接 / 连接中 / 已就绪）
      const engine = status.engine || {};
      const engineText = engine.effective === 'dsh'
        ? ('回复引擎：DSH 当前大模型' + (engine.route ? `（${engine.route.provider} / ${engine.route.model}）` : ''))
        : engine.effective === 'llm'
          ? '回复引擎：自填的直连接口'
          : '回复引擎：离线兜底应答（未接上 DSH 模型）';
      const meta = [];
      const rt = status.runtime || {};
      if (status.qq) meta.push('QQ: ' + status.qq);
      if (status.nickname) meta.push('昵称: ' + status.nickname);
      if (rt.counts) meta.push(`收 ${rt.counts.recv || 0} / 回 ${rt.counts.reply || 0}${rt.counts.error ? ` / 失败 ${rt.counts.error}` : ''}`);
      if (rt.lastRecvAt) { try { meta.push('最近收到: ' + new Date(rt.lastRecvAt).toLocaleTimeString()); } catch (e) { /* ignore */ } }
      if (status.time) { try { meta.push('状态更新: ' + new Date(status.time).toLocaleTimeString()); } catch (e) { /* ignore */ } }

      function field(f) {
        const val = d[f.key];
        if (f.type === 'checkbox') {
          return h('label', { className: 'napcat-choice', key: f.key },
            h('input', { type: 'checkbox', checked: !!val, disabled: busy, onChange: (e) => { const o = {}; o[f.key] = e.target.checked; edit(o); } }),
            h('span', null, f.label)
          );
        }
        if (f.type === 'textarea') {
          return h('label', { className: 'napcat-field', key: f.key },
            h('span', null, f.label),
            h('textarea', { value: toStr(val), disabled: busy, onChange: (e) => { const o = {}; o[f.key] = e.target.value; edit(o); } }),
            f.hint ? h('span', { className: 'napcat-hint' }, f.hint) : null
          );
        }
        if (f.type === 'range') {
          const num = Number(val);
          const cur = Number.isFinite(num) ? num : (f.min || 0);
          return h('label', { className: 'napcat-field', key: f.key },
            h('span', null, f.label + '：' + cur + (f.unit || '')),
            h('input', {
              type: 'range',
              min: f.min == null ? 0 : f.min,
              max: f.max == null ? 100 : f.max,
              step: f.step || 1,
              value: toStr(cur),
              disabled: busy,
              style: { width: '100%' },
              onChange: (e) => { const o = {}; o[f.key] = Number(e.target.value) || 0; edit(o); },
            }),
            f.hint ? h('span', { className: 'napcat-hint' }, f.hint) : null
          );
        }
        if (f.type === 'select') {
          return h('label', { className: 'napcat-field', key: f.key },
            h('span', null, f.label),
            h('select', {
              value: toStr(val), disabled: busy,
              onChange: (e) => { const o = {}; o[f.key] = e.target.value; edit(o); },
            }, (f.options || []).map((pair) => h('option', { key: pair[0], value: pair[0] }, pair[1]))),
            f.hint ? h('span', { className: 'napcat-hint' }, f.hint) : null
          );
        }
        return h('label', { className: 'napcat-field', key: f.key },
          h('span', null, f.label),
          h('input', {
            type: f.type === 'number' ? 'number' : (f.type === 'password' ? 'password' : 'text'),
            value: toStr(val), disabled: busy,
            onChange: (e) => {
              const o = {};
              o[f.key] = f.type === 'number' ? (e.target.value === '' ? 0 : Number(e.target.value)) : e.target.value;
              edit(o);
            },
          }),
          f.hint ? h('span', { className: 'napcat-hint' }, f.hint) : null
        );
      }

      const sections = [];
      let cur = null;
      for (const f of FIELDS) {
        if (cur !== f.sec) { cur = f.sec; sections.push({ title: f.sec, items: [] }); }
        sections[sections.length - 1].items.push(f);
      }

      if (loading) return h('div', { className: 'napcat-settings' }, h('p', null, '正在加载配置…'));

      return h('div', { className: 'napcat-settings' },
        statusCard({
          nap, busy,
          onStart: () => napcatAction('start'),
          onStop: () => napcatAction('stop'),
          onRestart: () => napcatAction('restart'),
          onOpenWebui: openWebui,
        }),

        // 三个状态灯：NapCat 进程 / WS 连接 / 是否可收发
        h(Lights, { lights: status.lights, ws: status.ws }),
        h(Endpoints, { status }),
        h(PersonaLine, { status }),
        h(LogCard, { source: 'messages', autoRefresh: true, title: '消息收发记录（最近 200 条）' }),
        status.hint ? h('p', { className: 'napcat-note' }, status.hint) : null,
        h('div', { className: 'napcat-actions' },
          h('button', { type: 'button', disabled: busy, onClick: () => napcatAction('reconnect') }, '重新连接 WS'),
          h('button', { type: 'button', disabled: busy, onClick: () => napcatAction('apply-onebot') }, '重新应用 OneBot 配置')
        ),

        // 运行统计
        h('div', { className: 'napcat-status' },
          h('p', { className: 'napcat-title' }, engineText),
          meta.length ? h('p', { className: 'meta' }, meta.join('  ·  ')) : null,
          rt.lastError ? h('p', { className: 'napcat-note err' }, rt.lastError) : null
        ),

        h('form', { className: 'napcat-settings', onSubmit: (e) => { e.preventDefault(); save(); } },
          sections.map((sec) =>
            h('div', { className: 'napcat-section', key: sec.title },
              h('h4', null, sec.title),
              h('div', { className: 'napcat-columns' }, sec.items.map((f) => field(f)))
            )
          ),
          h('div', { className: 'napcat-actions' },
            h('button', { type: 'submit', className: 'napcat-primary', disabled: busy }, busy ? '保存中…' : '保存更改'),
            h('button', { type: 'button', disabled: busy, onClick: () => { setDraft(null); setLoading(true); setMsg(null); api('/config').then((j) => { setDraft(clone(j)); setLoading(false); }).catch(() => setLoading(false)); } }, '恢复已保存值')
          ),
          msg ? h('p', { className: 'napcat-note ' + (msg.kind === 'ok' ? 'ok' : 'err') }, msg.text) : null
        )
      );
    }

    // ── NapCat WebUI 面板：自动填 Token + 内嵌 WebUI + 日志预览 ──
    function WebuiPanel() {
      const [info, setInfo] = useState(null);
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState(false);
      const [copied, setCopied] = useState('');
      const [showFrame, setShowFrame] = useState(true);
      const [forceFrame, setForceFrame] = useState(false);
      const status = useStatusPoll(3000);
      const nap = status.napcat || {};

      function load() {
        api('/webui')
          .then((j) => { setInfo(j || null); setErr(''); })
          .catch((e) => setErr('读取 WebUI 信息失败（面板接口未就绪？）：' + ((e && e.message) || e)));
      }

      useEffect(() => {
        load();
        const timer = setInterval(load, 4000);
        return () => clearInterval(timer);
      }, []);

      const token = (info && info.token) || (nap && nap.token) || '';
      const from = (info && info.tokenFrom) || (nap && nap.tokenFrom) || '';
      const port = (info && info.port) || nap.port || 6099;
      const baseUrl = (info && info.url) || ('http://127.0.0.1:' + port + '/webui');
      const urlWithToken = token
        ? baseUrl + (baseUrl.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(token)
        : baseUrl;

      function regen() {
        if (busy) return;
        setBusy(true);
        api('/webui/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
          .then(() => { setCopied('token'); load(); })
          .catch((e) => setErr('重生成 Token 失败：' + ((e && e.message) || e)))
          .then(() => setBusy(false));
      }

      function doCopy(text, what) {
        copyText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 1500); });
      }

      return h('div', { className: 'napcat-settings' },
        statusCard({
          nap, busy,
          onStart: () => { setBusy(true); api('/napcat/start', { method: 'POST' }).then(load).catch(() => {}).then(() => setBusy(false)); },
          onStop: () => { setBusy(true); api('/napcat/stop', { method: 'POST' }).then(load).catch(() => {}).then(() => setBusy(false)); },
          onRestart: () => { setBusy(true); api('/napcat/restart', { method: 'POST' }).then(load).catch(() => {}).then(() => setBusy(false)); },
          onOpenWebui: () => { try { window.open(urlWithToken, '_blank', 'noopener'); } catch (e) { /* ignore */ } },
        }),
        h(Lights, { lights: status.lights, ws: status.ws }),
        status.hint ? h('p', { className: 'napcat-note' }, status.hint) : null,
        h('div', { className: 'napcat-actions' },
          h('button', { type: 'button', disabled: busy, onClick: () => { setBusy(true); api('/napcat/reconnect', { method: 'POST' }).then(load).catch(() => {}).then(() => setBusy(false)); } }, '重新连接 WS'),
          h('button', { type: 'button', disabled: busy, onClick: () => { setBusy(true); api('/napcat/apply-onebot', { method: 'POST' }).then(load).catch(() => {}).then(() => setBusy(false)); } }, '重新应用 OneBot 配置')
        ),

        // Token 卡片：两个 token 严格区分
        h('div', { className: 'napcat-section' },
          h('h4', null, 'Token（两个用途不同，别混用）'),
          h('div', { className: 'napcat-token' },
            h('span', { className: 'napcat-title' }, 'WebUI 管理 Token'),
            h('code', null, token || '（等待 NapCat 打印…）'),
            h('span', { className: 'tag' }, tokenTag(from)),
            h('button', { type: 'button', disabled: !token, onClick: () => doCopy(token, 'token') }, copied === 'token' ? zh.copied : zh.copy),
            h('button', { type: 'button', disabled: busy, onClick: regen }, '重新生成'),
            h('button', { type: 'button', onClick: () => doCopy(urlWithToken, 'url') }, copied === 'url' ? zh.copied : '复制带 Token 的链接')
          ),
          h('p', { className: 'napcat-hint' }, '这个 token 只用于登录下面的 NapCat WebUI 页面，插件会自动从 NapCat 启动日志读取并自动填进 iframe，你不需要手抄。'),
          h('div', { className: 'napcat-token' },
            h('span', { className: 'napcat-title' }, 'OneBot access_token'),
            h('code', null, (info && info.onebotToken) || '（未设置，表示不校验）'),
            h('span', { className: 'tag' }, '插件↔NapCat 通信用'),
            h('button', { type: 'button', disabled: !(info && info.onebotToken), onClick: () => doCopy((info && info.onebotToken) || '', 'ob') }, copied === 'ob' ? zh.copied : zh.copy)
          ),
          h('p', { className: 'napcat-hint' }, '这个 token 写在「AI 配置」里，用于插件调用 OneBot HTTP/WS 发消息，和 WebUI 登录无关。')
        ),

        err ? h('p', { className: 'napcat-note err' }, err) : null,

        // 内嵌 WebUI
        h('div', { className: 'napcat-section' },
          h('div', { className: 'napcat-status-row' },
            h('span', { className: 'napcat-title' }, 'NapCat WebUI'),
            h('span', { className: 'meta' }, baseUrl),
            h('button', { type: 'button', onClick: () => setShowFrame(!showFrame) }, showFrame ? '收起内嵌' : '展开内嵌'),
            h('button', { type: 'button', onClick: () => { setShowFrame(true); load(); } }, zh.refresh),
            h('button', { type: 'button', onClick: () => { try { window.open(urlWithToken, '_blank', 'noopener'); } catch (e) { /* ignore */ } } }, zh.openWebui)
          ),
          !token ? h('p', { className: 'napcat-hint' }, '正在等待内置 NapCat 打印 WebUI Token（启动后约 10–30 秒）…') : null,
          showFrame && !token && !forceFrame
            ? h('div', { className: 'napcat-frame-fallback' },
              h('p', { className: 'napcat-hint' }, '拿到 Token 后会自动把带 Token 的 WebUI 嵌进来，不需要你手动输入。'),
              h('div', { className: 'napcat-actions' },
                h('button', { type: 'button', onClick: load }, zh.refresh),
                h('button', { type: 'button', onClick: () => setForceFrame(true) }, '不等 Token，先打开（手动登录）'),
                h('button', { type: 'button', onClick: () => { try { window.open(urlWithToken, '_blank', 'noopener'); } catch (e) { /* ignore */ } } }, zh.openWebui)
              )
            )
            : null,
          showFrame && (token || forceFrame)
            ? h('div', { className: 'napcat-frame-wrap' },
              h('iframe', {
                key: token || ('notoken-' + port),
                className: 'napcat-frame',
                src: urlWithToken,
                title: 'NapCat WebUI',
                allow: 'clipboard-read; clipboard-write',
                referrerPolicy: 'no-referrer',
              })
            )
            : null,
          h('p', { className: 'napcat-hint' }, '如果内嵌页面空白（个别版本 WebUI 禁止被 iframe 嵌套），点「在浏览器打开」即可，链接里已经带上 Token，不需要手动输入。')
        ),

        h(LogCard, { autoRefresh: true })
      );
    }

    // ── 设置页左侧导航「集成」里的整页内容 ──
    function NapcatSection() {
      const [tab, setTab] = useState('ai');
      return h('div', { className: 'napcat-page' },
        h('h2', null, zh.nav),
        h('p', { className: 'napcat-desc' }, zh.desc),
        h('div', { className: 'napcat-tabs', role: 'tablist' },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': tab === 'ai',
            className: 'napcat-tab' + (tab === 'ai' ? ' on' : ''), onClick: () => setTab('ai'),
          }, zh.tabAi),
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': tab === 'webui',
            className: 'napcat-tab' + (tab === 'webui' ? ' on' : ''), onClick: () => setTab('webui'),
          }, zh.tabWebui),
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': tab === 'manage',
            className: 'napcat-tab' + (tab === 'manage' ? ' on' : ''), onClick: () => setTab('manage'),
          }, '管理')
        ),
        tab === 'ai' ? h(NapcatPanel) : tab === 'webui' ? h(WebuiPanel) : h(ManageTab)
      );
    }

    // ── 注册（settings.section 为主入口，插件详情页保留配置表单）──
    function apply(ctx) {
      const registered = [];
      const errors = [];
      const SECTION_ID = 'dsh-napcat-bot';

      // 文案字典
      try { ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-napcat: dictionaries'); } catch (e) { errors.push('locale: ' + e); }

      // 宿主词典绑定（照搬 dshmarket 的 `const t = ctx.locale.bind(NS)`）
      let t = (key) => (zh[key] !== undefined ? zh[key] : key);
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') {
          const bound = ctx.locale.bind(NS);
          t = (key, params) => {
            try {
              const out = bound(key, params);
              return out === undefined || out === null ? (zh[key] !== undefined ? zh[key] : key) : out;
            } catch (e) { return zh[key] !== undefined ? zh[key] : key; }
          };
        }
      } catch (e) { /* ignore */ }

      // 样式
      try {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.dshNapcat = 'true';
          style.textContent = STYLES;
          document.head.append(style);
          return () => style.remove();
        }, 'dsh-napcat: styles');
      } catch (e) { errors.push('styles: ' + e); }

      // 账本查询（去重用）
      function entriesOf(slot) {
        try {
          const s = ctx.slots;
          if (!s) return null;
          if (typeof s.entriesOfSlot === 'function') return s.entriesOfSlot(slot) || [];
          if (typeof s.entries === 'function') return s.entries(slot) || [];
        } catch (e) { /* ignore */ }
        return null;
      }
      function hasEntry(slot, id) {
        const rows = entriesOf(slot);
        if (!rows) return false;
        return rows.some((row) => {
          const o = (row && (row.options || row)) || {};
          return o.id === id;
        });
      }

      // ── 主入口：设置页左侧【集成】分组里的「NapCat QQ 机器人」 ──
      // 设置页（含 @michengai/dsh-codex-ui 的分组壳）的导航数据源就是
      // settings.section 这个 slot 的条目，所以注册到这里即可出现在【集成】里。
      const sectionOpts = {
        name: 'settings.section',
        id: SECTION_ID,
        order: 17,
        label: () => t('nav'),
        locale: NS,
      };

      let sectionDone = false;
      function registerSection(via) {
        if (sectionDone) return true;
        if (hasEntry('settings.section', SECTION_ID)) { sectionDone = true; return true; }
        try {
          ctx.slots.register(sectionOpts, NapcatSection);
          sectionDone = true;
          if (registered.indexOf('settings.section') < 0) registered.push('settings.section');
          return true;
        } catch (e) {
          const msg = (e && e.message) || String(e);
          const row = 'settings.section@' + via + ': ' + msg;
          if (errors.indexOf(row) < 0) errors.push(row);
          return false;
        }
      }

      // 标准写法：等 slot 声明后注册（dshmarket / dsh-codex-ui 都是这个套路）
      try {
        ctx.slots.inject('settings.section', () => { registerSection('inject'); });
      } catch (e) {
        errors.push('inject:settings.section: ' + ((e && e.message) || e));
      }

      // 兜底：slot 声明得晚或被清空时再试几次（已注册过就跳过，不会出现重复入口）
      [800, 2500, 6000, 12000].forEach((ms) => {
        setTimeout(() => { try { registerSection('retry' + ms); } catch (e) { /* ignore */ } }, ms);
      });

      // 插件详情页里的配置表单也保留（两个入口共存）
      function attach(slot, make, label) {
        try {
          ctx.slots.inject(slot, make);
          if (registered.indexOf(label || slot) < 0) registered.push(label || slot);
        } catch (e) {
          errors.push(slot + ': ' + ((e && e.message) || e));
        }
      }

      attach('plugins.bundle.config', () => ctx.slots.register(
        { name: 'plugins.bundle.config', key: 'dsh-napcat-bot', locale: NS },
        (ownerProps) => (ownerProps && ownerProps.view === 'summary' ? null : h(NapcatSection))
      ), 'plugins.bundle.config#dsh-napcat-bot');

      attach('settings.plugins.tab', () => ctx.slots.register(
        { name: 'settings.plugins.tab', id: 'dsh-napcat-bot', order: 60, label: () => t('nav'), locale: NS },
        () => h(NapcatSection)
      ), 'settings.plugins.tab#dsh-napcat-bot');

      attach('plugins.row.config', () => ctx.slots.register(
        { name: 'plugins.row.config', key: 'dsh-napcat-bot#dsh-napcat-bot', locale: NS },
        (props) => (props && props.view === 'summary' ? h(Fragment, null, zh.summary) : h(NapcatSection))
      ), 'plugins.row.config#dsh-napcat-bot');

      // 自检回执：万一侧边入口没出现，这个文件能定位 client 半边是否真的跑了
      function report(stage) {
        try {
          fetch('/napcat-bot/api/client-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              version: '2.0.0',
              stage,
              registered,
              errors,
              sectionDone,
              ledger: {
                settingsSection: (entriesOf('settings.section') || []).map((r) => ((r && r.options) || r || {}).id),
              },
              slotsApi: !!(ctx.slots && ctx.slots.register && ctx.slots.inject),
              hasEntriesOfSlot: !!(ctx.slots && typeof ctx.slots.entriesOfSlot === 'function'),
              at: Date.now(),
            }),
          }).catch(() => {});
        } catch (e) { /* ignore */ }
      }
      report('apply');
      setTimeout(() => report('after-3s'), 3000);
      setTimeout(() => report('after-13s'), 13000);
    }

    exports.name = 'dsh-napcat-bot';
    exports.inject = ['slots', 'locale'];
    exports.apply = apply;

    return module.exports;
  },
});
