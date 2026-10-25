// scripts/build-market-index.mjs
// 生成 DSH 插件市场索引（format 1）：market/index.json
//
//   node scripts/build-market-index.mjs                 # 用 git HEAD 作为固定提交、当前时间作为发布时间
//   node scripts/build-market-index.mjs --commit <sha>  # 手动指定固定提交
//   node scripts/build-market-index.mjs --time 1792951680
//
// 规则（DSH 的 @deepseek-ai/dsh-plugin-market-index 定义）：
//   · git 源必须固定到完整的 40 位小写 commit，不能用移动的分支；
//   · 版本要精确 SemVer，publishTimestamp 是整数 Unix 秒；
//   · 索引里已有的历史版本会被保留，只追加/替换当前 package.json 的版本。
//
// 发版顺序：先提交代码 → 再跑本脚本（固定 HEAD）→ 最后提交 market/index.json。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'market', 'index.json');
const ICON = path.join(ROOT, 'market', 'icon.svg');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? String(process.argv[i + 1] || '').trim() : '';
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const commit = (arg('commit') || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })).trim();
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`commit 必须是 40 位小写 SHA：${commit}`);

const publishTimestamp = Number(arg('time')) || Math.floor(Date.now() / 1000);

const repoUrl = String(pkg.repository?.url || 'https://github.com/9178159/dsh-napcat-bot')
  .replace(/^git\+/u, '').replace(/\.git$/u, '').replace(/\/+$/u, '');
const homepage = String(pkg.homepage || `${repoUrl}#readme`);

const icon = `data:image/svg+xml;base64,${fs.readFileSync(ICON).toString('base64')}`;
if (Buffer.from(icon.split(',')[1], 'base64').length > 32 * 1024) throw new Error('icon 超过 32 KiB');

const metadata = {
  categories: {
    bot: { title: { en: 'Bots & Automation', 'zh': '机器人与自动化' } },
    integration: { title: { en: 'Integrations', 'zh': '集成与连接' } },
  },
  labels: {
    onebot: { title: { en: 'OneBot', 'zh': 'OneBot 协议' } },
    tts: { title: { en: 'Text to speech', 'zh': '语音合成' } },
    vision: { title: { en: 'Image understanding', 'zh': '识图' } },
    'bundled-napcat': { title: { en: 'Bundled NapCat', 'zh': '内置 NapCat' } },
    windows: { title: { en: 'Windows only', 'zh': '仅 Windows' } },
  },
  sortKeys: {
    stars: { title: { en: 'GitHub stars', 'zh': 'GitHub 星标' }, order: 'desc' },
  },
};

const entry = {
  name: pkg.name,
  title: { en: 'DSH NapCat QQ Bot', 'zh': 'NapCat QQ 机器人' },
  description: {
    en: 'QQ bot for DeepSeek Harness with bundled NapCat (shipped in the release tarball): starts NapCat for you and wires OneBot WS/HTTP automatically, plus persona, context memory, image understanding on the main model vision, four TTS modes and forced-voice commands, random proactive messages, and web search.',
    'zh': 'DSH 的 QQ 机器人插件：内置 NapCat（随 Releases 的 tgz 分发），启用即自动启动并自动配置 OneBot 正反向 WS；带人格、上下文记忆、识图（复用主模型原生视觉）、四种语音模式与强制语音指令、随缘主动发言、联网搜索、黑白名单与限流。',
  },
  icon,
  author: repoUrl.split('/')[3] || '9178159',
  homepage,
  repository: { url: repoUrl },
  metadata: {
    category: 'bot',
    keywords: ['qq', 'qqbot', 'napcat', 'onebot', 'tts', 'vision', 'chatbot', 'deepseek-harness', 'dsh-plugin'],
    labels: ['onebot', 'tts', 'vision', 'bundled-napcat', 'windows'],
    sortKeys: { stars: 0 },
  },
  versions: [],
};

// 保留历史版本（同一个版本号以本次生成结果覆盖）
let previous = [];
try {
  previous = JSON.parse(fs.readFileSync(OUT, 'utf8')).plugins?.[0]?.versions ?? [];
} catch { /* 首次生成 */ }

const version = {
  version: pkg.version,
  publishTimestamp,
  source: { type: 'git', url: repoUrl, commit },
  engines: { dsh: '>=0.2.0' },
};

entry.versions = [...previous.filter((v) => v.version !== version.version), version]
  .sort((a, b) => (a.version === b.version ? 0 : a.version < b.version ? 1 : -1));

const index = {
  format: 1,
  title: { en: `${pkg.name} plugin market`, 'zh': 'NapCat QQ 机器人 · 插件市场' },
  description: {
    en: 'Format-1 DSH plugin market index for dsh-napcat-bot.',
    'zh': 'dsh-napcat-bot 的 format-1 插件市场索引，可直接在「插件 → 发现 → 索引源」里添加。',
  },
  metadata,
  plugins: [entry],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(index, null, 2)}\n`);
console.log(`✓ ${path.relative(ROOT, OUT)}：${pkg.name}@${pkg.version} → ${commit.slice(0, 7)}（${entry.versions.length} 个版本）`);
