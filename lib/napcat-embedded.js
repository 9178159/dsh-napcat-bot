// lib/napcat-embedded.js
// 内置 NapCat 生命周期管理器（零外部依赖，仅 Node 内置模块）。
//
// 目标：插件自带 NapCat（vendor/napcat），启用即自动拉起，不需要用户单独下载/启动 NapCat。
//
// 工作方式与 NapCat 官方 launcher 完全一致（照抄 vendor/napcat/launcher-user.bat）：
//   1. 设置 5 个 NAPCAT_* 环境变量指向 vendor 目录里的补丁包/注入器；
//   2. 用 NapCatWinBootMain.exe 注入已安装的 QQ NT（QQ 本体是 NapCat 的运行宿主，必须存在）；
//   3. WebUI 监听 6099，OneBot11 走 HTTP 3000 / 正向 WS 3001。
//
// 两个 Token，互不相干（面板里也分开显示）：
//   · WebUI 管理 Token —— 登录 http://127.0.0.1:6099/webui 用。NapCat 每次启动都会打印
//     「[WebUi] WebUi Token: xxxx」。本管理器会从**启动日志**里自动读出来（readLogToken），
//     所以面板可以自动填进 WebUI，用户不用手抄。
//   · OneBot access_token —— 插件与 NapCat 通信（HTTP Bearer / WS query）用，来自面板配置。
//
// 进程去重（防止多开 NapCat / QQ）三层保护：
//   a. 我们的 pid 文件 + 日志里的「Main Process ID」指向的进程仍存活 → 直接复用；
//   b. WebUI 端口已被占用 → 视为已有 NapCat 在跑（外部实例），绝不再启动第二个；
//   c. run/napcat.lock 短期互斥，防止同一时刻多个 DSH 实例同时拉起。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyOneBotConfig } from './napcat-webui-api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 插件内置 NapCat 的默认目录：<包根>/vendor/napcat */
export const VENDOR_DIR = path.resolve(HERE, '..', 'vendor', 'napcat');

/** 运行期数据目录（pid / lock / 日志 / WebUI token）。 */
export function runDir() {
  const base = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'napcat-bot')
    : path.join(os.homedir(), '.dsh', 'napcat-bot');
  const dir = path.join(base, 'run');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

const isWin = process.platform === 'win32';

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readJson(p, fb = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); return true; } catch { return false; }
}

// ── 端口探测 ─────────────────────────────────────────────────────────────
export function probePort(port, host = '127.0.0.1', timeout = 900) {
  return new Promise((resolve) => {
    let done = false;
    const sock = new net.Socket();
    const finish = (v) => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch { finish(false); }
  });
}

function pidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// ── QQ 安装位置探测（不依赖 reg.exe，直接扫常见路径 + 各盘符） ────────────
const QQ_REL = [
  path.join('Tencent', 'QQNT', 'QQ.exe'),
  path.join('Tencent', 'QQ', 'QQ.exe'),
  path.join('Program Files', 'Tencent', 'QQNT', 'QQ.exe'),
];

export function findQQ(config = {}) {
  const explicit = String(config.qqPath || '').trim();
  if (explicit) {
    const p = path.normalize(explicit);
    if (exists(p)) return p;
  }
  const env = process.env;
  const dirs = [
    path.join(env['ProgramFiles'] || 'C:\\Program Files'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'),
    path.join(env['ProgramW6432'] || 'C:\\Program Files'),
    path.join(env['LOCALAPPDATA'] || '', 'Programs'),
  ].filter(Boolean);

  const cands = [];
  for (const d of dirs) cands.push(path.join(d, 'Tencent', 'QQNT', 'QQ.exe'), path.join(d, 'Tencent', 'QQ', 'QQ.exe'));
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    for (const rel of QQ_REL) cands.push(path.join(drive + path.sep, rel));
  }
  for (const c of cands) { if (exists(c)) return c; }
  return '';
}

// ── WebUI Token（重点：从 NapCat 启动日志里自动读取） ─────────────────────
const TOKEN_PATTERNS = [
  /\[WebUi\]\s*WebUi Token:\s*([0-9A-Za-z._~-]{6,})/g,
  /WebUi Token:\s*([0-9A-Za-z._~-]{6,})/g,
  /webui\?token=([0-9A-Za-z._~-]{6,})/g,
];

/** 从日志文本里取**最后一次**打印的 WebUI Token（重启后旧 token 会被新的一行覆盖）。 */
export function parseTokenFromLog(text) {
  const src = String(text || '');
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    let m; let last = '';
    while ((m = re.exec(src)) !== null) last = m[1];
    if (last) return last;
  }
  return '';
}

/** 从日志文本里取 NapCat 注入后 QQ 的真实主进程号（launcher 自己会退出，不能拿它当 pid）。 */
export function parseMainPidFromLog(text) {
  const re = /\[NapCat Backend\]\s*Main Process ID:\s*(\d+)/g;
  const src = String(text || '');
  let m; let last = 0;
  while ((m = re.exec(src)) !== null) last = Number(m[1]);
  return last;
}

function readText(p, limit) {
  try {
    const txt = fs.readFileSync(p, 'utf8');
    return limit ? txt.slice(-limit) : txt;
  } catch { return ''; }
}

// ── 配置引导：WebUI(6099) 与 OneBot11 ────────────────────────────────────
function newToken() {
  const chars = 'abcdef0123456789';
  let t = '';
  for (let i = 0; i < 24; i += 1) t += chars[Math.floor(Math.random() * 16)];
  return t;
}

function tokenFile() { return path.join(runDir(), 'webui-token'); }

function readTokenFile() {
  try { return fs.readFileSync(tokenFile(), 'utf8').trim(); } catch { return ''; }
}

function writeTokenFile(token) {
  try { fs.writeFileSync(tokenFile(), token); return true; } catch { return false; }
}

function seedToken() {
  const cur = readTokenFile();
  if (cur) return cur;
  const t = newToken();
  writeTokenFile(t);
  return t;
}

/** 写入 NapCat WebUI 配置（端口固定 6099，token 由我们掌控，便于面板一键跳转）。 */
function ensureWebuiConfig(home, port, forceToken) {
  const file = path.join(home, 'config', 'webui.json');
  const cur = readJson(file, {}) || {};
  const token = String(forceToken || '').trim() || String(cur.token || '').trim() || seedToken();
  const next = Object.assign({
    host: '127.0.0.1',
    port,
    token,
    loginRate: 10,
    autoLoginAccount: '',
    disableWebUI: false,
    accessControlMode: 'none',
  }, cur, { host: '127.0.0.1', port, token, disableWebUI: false });
  writeJson(file, next);
  if (!readTokenFile()) writeTokenFile(token);
  return token;
}

/**
 * OneBot11 网络配置（开箱即用的关键）：
 *   · 正向 HTTP  —— 插件用它发消息 / 查登录态（默认 3000）
 *   · 正向 WS    —— 插件用它收消息（默认 3001）
 *   两处 token 统一使用插件自动生成的 OneBot access_token；
 *   reportSelfMessage 必须 false，否则机器人会收到自己发的消息形成自问自答。
 */
function onebotBody(config, token) {
  const tk = String(token || '');
  return {
    network: {
      httpServers: [{
        name: 'dsh-http',
        enable: true,
        port: Number(config.napcatHttpPort) || 3000,
        host: '127.0.0.1',
        enableCors: true,
        enableWebsocket: false,
        messagePostFormat: 'array',
        token: tk,
        debug: false,
      }],
      httpSseServers: [],
      httpClients: [],
      websocketServers: [{
        name: 'dsh-ws',
        enable: true,
        host: '127.0.0.1',
        port: Number(config.napcatWsPort) || 3001,
        messagePostFormat: 'array',
        reportSelfMessage: false,
        token: tk,
        enableForcePushEvent: true,
        debug: false,
        heartInterval: 30000,
      }],
      websocketClients: [],
      plugins: [],
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false,
    imageDownloadProxy: '',
    timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
  };
}

/**
 * 确保某个 QQ 号的 onebot11 配置就是我们要的样子（HTTP + WS + 统一 token）。
 * 返回 true 表示文件被改写了（改完需要重启 NapCat 或等下次登录才生效）。
 */
export function ensureOneBotConfig(home, uin, config, token) {
  if (!uin) return false;
  const file = path.join(home, 'config', `onebot11_${uin}.json`);
  const body = onebotBody(config, token);
  const cur = readJson(file, null);
  // 已完全一致就不动文件，避免无意义的重启
  const same = cur
    && cur.network
    && JSON.stringify(cur.network.httpServers) === JSON.stringify(body.network.httpServers)
    && JSON.stringify(cur.network.websocketServers) === JSON.stringify(body.network.websocketServers);
  if (same) return false;
  writeJson(file, body);
  return true;
}

/** 列出 config 目录里已有的 onebot11_<uin>.json 对应的 QQ 号（历史登录过的账号）。 */
export function knownUins(home) {
  const dir = path.join(home, 'config');
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = /^onebot11_(\d{5,12})\.json$/.exec(name);
      if (m) out.push(m[1]);
    }
  } catch { /* ignore */ }
  return out;
}

// ── 管理器 ───────────────────────────────────────────────────────────────
export function createEmbeddedNapcat(config, log) {
  const port = Number(config.webuiPort) || 6099;
  const home = String(config.napcatHome || '').trim() ? path.resolve(String(config.napcatHome).trim()) : VENDOR_DIR;
  const run = runDir();
  const pidFile = path.join(run, 'napcat.pid');
  const lockFile = path.join(run, 'napcat.lock');
  const logFile = path.join(run, 'napcat.log');
  const stateFile = path.join(run, 'state.json');
  const onebotTokenFile = path.join(run, 'onebot-token');

  /** 插件自己生成的 OneBot access_token（用户完全不用填）。 */
  function onebotToken() {
    const configured = String(config.napcatToken || '').trim();
    if (configured) {
      if (readText(onebotTokenFile) !== configured) {
        try { fs.writeFileSync(onebotTokenFile, configured); } catch { /* ignore */ }
      }
      return configured;
    }
    const saved = readText(onebotTokenFile).trim();
    if (saved) return saved;
    const t = newToken();
    try { fs.writeFileSync(onebotTokenFile, t); } catch { /* ignore */ }
    return t;
  }

  function readState() { return readJson(stateFile, {}) || {}; }
  function patchState(patch) {
    try { writeJson(stateFile, Object.assign(readState(), patch)); } catch { /* ignore */ }
  }
  function lastUin() { return String(readState().uin || '').trim(); }

  // ── OneBot 网络服务的「真正生效」路径（走 NapCat 官方 WebUI API）─────────
  // 直接改配置文件并不保证热加载，所以封装一层：登录 WebUI → SetConfig →
  // NapCat 内部 save + reloadNetwork，立即把 3001 拉起来，不需要重启 QQ。
  let webCredential = '';
  const onebot = { applied: false, wsListening: false, error: '', at: 0, attempts: 0, lastTryAt: 0 };

  /** 探测 WS 端口是否真的在监听（每 30s 最多探一次，避免频繁 socket）。 */
  async function onebotWsListening(force) {
    const now = Date.now();
    if (!force && now - onebot.lastTryAt < 1200) return onebot.wsListening;
    onebot.lastTryAt = now;
    try { onebot.wsListening = await probePort(Number(config.napcatWsPort) || 3001); } catch { onebot.wsListening = false; }
    return onebot.wsListening;
  }

  /**
   * 确保 NapCat 里的 OneBot 网络配置就是我们要的样子，并且**真的生效**。
   * 注意：NapCat 的 SetConfig 需要账号已登录，未登录时会失败，由调用方重试。
   */
  async function ensureOneBotNetwork(options) {
    const force = !options || options.force !== false;
    onebot.attempts += 1;
    // WebUI 必须先起来
    if (!(await probePort(port))) {
      onebot.error = 'WebUI 尚未就绪';
      return { ok: false, error: onebot.error };
    }
    const tk = onebotToken();
    const body = onebotBody(config, tk);
    const wtoken = readToken().token;
    if (!wtoken) {
      onebot.error = '尚未拿到 WebUI 管理 Token';
      return { ok: false, error: onebot.error };
    }
    const r = await applyOneBotConfig(port, wtoken, body, webCredential);
    if (r.credential) webCredential = r.credential;
    if (!r.ok) {
      onebot.error = r.error || 'SetConfig 失败';
      onebot.applied = false;
      return { ok: false, error: onebot.error };
    }
    // 配置提交成功 → 立刻验证 3001 是否真的起来
    let wsUp = false;
    for (let i = 0; i < 6; i += 1) {
      wsUp = await probePort(Number(config.napcatWsPort) || 3001);
      if (wsUp) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    onebot.applied = true;
    onebot.wsListening = wsUp;
    onebot.at = Date.now();
    onebot.error = wsUp ? '' : '配置已提交，但 3001 仍未监听（NapCat 可能尚未登录账号）';
    if (wsUp) {
      appendLog(`[onebot] 已通过 WebUI API 应用 OneBot 配置：HTTP ${Number(config.napcatHttpPort) || 3000} / WS ${Number(config.napcatWsPort) || 3001}（已监听）`);
      log.info(`[napcat-embedded] OneBot 网络已生效（HTTP ${Number(config.napcatHttpPort) || 3000} / WS ${Number(config.napcatWsPort) || 3001} 监听中）`);
    }
    return { ok: true, wsListening: wsUp, error: onebot.error };
  }

  function onebotStatus() {
    return {
      applied: onebot.applied,
      wsListening: onebot.wsListening,
      error: onebot.error,
      at: onebot.at,
      attempts: onebot.attempts,
      httpPort: Number(config.napcatHttpPort) || 3000,
      wsPort: Number(config.napcatWsPort) || 3001,
    };
  }

  /**
   * 把已知 QQ 号（config 目录里已有的 onebot11_*.json + 上次登录记录 + 用户手填）
   * 的 OneBot 网络配置统一刷成「HTTP + 正向 WS + 同一 token」。
   * @returns 实际被改写的 QQ 号列表
   */
  function preseedOneBot(token) {
    const uins = new Set(knownUins(home));
    const last = lastUin();
    if (last) uins.add(last);
    const explicit = String(config.selfQQ || '').trim();
    if (explicit) uins.add(explicit);
    const wrote = [];
    for (const uin of uins) {
      try { if (ensureOneBotConfig(home, uin, config, token)) wrote.push(uin); } catch { /* ignore */ }
    }
    return wrote;
  }

  /** @type {{state:string, reason:string, pid:number, port:number, home:string, log:string, since:number, owned:boolean}} */
  const st = {
    state: 'idle',
    reason: '',
    pid: 0,
    port,
    home,
    log: logFile,
    since: 0,
    owned: false,
    qq: '',
    version: '',
    token: '',
    tokenFrom: '',
    // 活性缓存：由 watch() / start() 每 3s 刷新，供 status() 判定「真的还活着吗」
    portUp: false,
    probeKnown: false,
    lastUpAt: 0,
    lastStartAt: 0,
    launcherExitAt: 0,
    restarts: [], // 自动重启时间戳（用于限流，避免无限重启打爆 QQ）
  };

  let child = null;
  let timer = null;
  let starting = false;
  let stopped = false;
  let tokenPoll = null;

  function set(state, reason) {
    if (st.state !== state || st.reason !== reason) {
      st.state = state;
      st.reason = reason || '';
      st.since = Date.now();
      if (log && log.info) log.info(`[napcat-embedded] ${state}${reason ? ' — ' + reason : ''}`);
    }
  }

  function logTail(n = 40) {
    try {
      const txt = fs.readFileSync(logFile, 'utf8');
      const lines = txt.split(/\r?\n/);
      return lines.slice(-n);
    } catch { return []; }
  }

  function appendLog(line) {
    try { fs.appendFileSync(logFile, line.endsWith('\n') ? line : line + '\n'); } catch { /* ignore */ }
  }

  /**
   * 自动读取 WebUI 管理 Token。
   * 优先顺序：NapCat 启动日志（最权威，与正在运行的实例严格一致）
   *          → vendor/napcat/config/webui.json（NapCat 自己的落盘配置）
   *          → run/webui-token（我们托管的种子 token）
   */
  function readToken() {
    const fromLog = parseTokenFromLog(readText(logFile, 200000));
    if (fromLog) { st.token = fromLog; st.tokenFrom = 'log'; return { token: fromLog, from: 'log' }; }
    const cfg = readJson(path.join(home, 'config', 'webui.json'), null);
    if (cfg && cfg.token) { st.token = String(cfg.token); st.tokenFrom = 'config'; return { token: String(cfg.token), from: 'config' }; }
    const seeded = readTokenFile();
    if (seeded) { st.token = seeded; st.tokenFrom = 'seed'; return { token: seeded, from: 'seed' }; }
    st.token = ''; st.tokenFrom = '';
    return { token: '', from: '' };
  }

  /** QQ 的真实主进程（NapCat 注入后，launcher 会退出，所以 pid 要从日志里拿）。 */
  function mainPid() {
    const fromLog = parseMainPidFromLog(readText(logFile, 200000));
    if (fromLog && pidAlive(fromLog)) return fromLog;
    const rec = readJson(pidFile, {}) || {};
    const p = Number(rec.pid || 0);
    if (p && pidAlive(p)) return p;
    return 0;
  }

  /** 基本自检：vendor 目录、启动器、注入器、QQ 宿主是否齐全。 */
  function inspect() {
    const launcher = path.join(home, 'NapCatWinBootMain.exe');
    const hook = path.join(home, 'NapCatWinBootHook.dll');
    const main = path.join(home, 'napcat.mjs');
    const hasVendor = exists(path.join(home, 'napcat.mjs'));
    const qq = findQQ(config);
    return {
      hasVendor, launcher: exists(launcher), hook: exists(hook), main: exists(main),
      qq, ready: hasVendor && exists(launcher) && exists(hook) && !!qq,
    };
  }

  /** WebUI 端口已存在别的 NapCat（外部实例）时，复用而不多开。 */
  async function detectExisting() {
    const pid = mainPid();
    if (pid) return { by: 'pid', pid };
    if (await probePort(port)) return { by: 'port', pid: 0 };
    return null;
  }

  async function waitReady(deadlineMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs) {
      if (await probePort(port)) return true;
      if (child && child.exitCode !== null && child.exitCode !== 0) return false;
      // launcher 已退出 15s 仍没有 6099 → 注入的 QQ 宿主也挂了，没必要干等满 60s
      if (st.launcherExitAt && Date.now() - st.launcherExitAt > 15000) return false;
      await new Promise((r) => setTimeout(r, 1200));
    }
    return false;
  }

  /** 启动后持续盯日志，第一时间把 WebUI token 抓出来（NapCat 打印后就自动可用）。 */
  function watchToken() {
    if (tokenPoll) return;
    tokenPoll = setInterval(() => {
      try {
        if (stopped) return;
        const got = readToken();
        if (got.token && log && log.info && st.tokenFrom === 'log') {
          // 只在首次从日志拿到 token 时打一条，避免刷屏
          if (!watchToken.reported || watchToken.reported !== got.token) {
            watchToken.reported = got.token;
            log.info(`[napcat-embedded] 已自动读取 WebUI Token（来源：启动日志）`);
          }
        }
      } catch { /* ignore */ }
    }, 3000);
    try { if (tokenPoll.unref) tokenPoll.unref(); } catch { /* ignore */ }
  }

  async function start() {
    if (starting) return st;
    starting = true;
    try {
      // ⓪ 先把 WebUI 配置准备好（端口 6099 + token），这个写文件是安全的
      const token = ensureWebuiConfig(home, port);

      // ① 进程检测：已经在跑就别再开一个
      const running = await detectExisting();
      if (running) {
        st.pid = running.pid || 0;
        // 只有 pid 是我们自己写下的才算「我们拉起的」，外部实例绝不碰
        st.owned = running.by === 'pid';
        readToken();
        set('running', running.by === 'pid'
          ? '内置 NapCat 已在运行（复用已有进程）'
          : `端口 ${port} 已有 NapCat 在监听（外部实例，未重复启动）`);
        // 已在运行：**不去改它的配置文件**（实测 NapCat 保存时会丢 websocketServers），
        // 也不重启（重启会踢掉 QQ 登录），改用 WebUI API 让 OneBot 网络立即生效。
        ensureOneBotNetwork({ force: true }).catch(() => {});
        return st;
      }

      // ② 文件自检
      const info = inspect();
      st.qq = info.qq;
      if (!info.hasVendor) { set('failed', '未找到内置 NapCat 文件（vendor/napcat 缺失），请重新安装完整插件包'); return st; }
      if (!isWin) { set('failed', '内置 NapCat 仅支持 Windows（当前系统 ' + process.platform + '）'); return st; }
      if (!info.qq) {
        set('no-qq', '未检测到 QQ NT 客户端。NapCat 的工作原理是注入已安装的 QQ，请先安装官方 QQ 后再启用，或在面板填写 QQ.exe 路径');
        return st;
      }
      if (!info.launcher || !info.hook) { set('failed', '内置 NapCat 启动器缺失（NapCatWinBootMain.exe / NapCatWinBootHook.dll）'); return st; }

      // ③ 互斥锁，避免多实例同时拉起
      try {
        const lockAge = exists(lockFile) ? Date.now() - fs.statSync(lockFile).mtimeMs : Infinity;
        if (lockAge < 45000) { set('starting', '另一个 DSH 实例正在启动内置 NapCat，稍候自动复用'); return st; }
      } catch { /* ignore */ }
      try { fs.writeFileSync(lockFile, String(Date.now())); } catch { /* ignore */ }

      // ④ 拉起前预置 OneBot11 网络配置（NapCat 还没运行，此时写文件最安全）。
      //    历史登录过的 QQ 号全部刷成「正向 HTTP + 正向 WS + 统一 token」，
      //    这样扫码登录后 3001 立刻就在监听；万一没生效，运行期还会用 WebUI API 兜底。
      const obToken = onebotToken();
      const seeded = preseedOneBot(obToken);
      if (seeded.length) {
        log.info(`[napcat-embedded] 已预置 OneBot11 网络配置（HTTP ${Number(config.napcatHttpPort) || 3000} / WS ${Number(config.napcatWsPort) || 3001}）：QQ ${seeded.join(', ')}`);
      }
      if (config.selfQQ) ensureOneBotConfig(home, String(config.selfQQ).trim(), config, obToken);

      // ⑤ 拉起（与 launcher-user.bat 完全相同的环境变量与参数）
      const env = Object.assign({}, process.env, {
        NAPCAT_PATCH_PACKAGE: path.join(home, 'qqnt.json'),
        NAPCAT_LOAD_PATH: path.join(home, 'loadNapCat.js'),
        NAPCAT_INJECT_PATH: path.join(home, 'NapCatWinBootHook.dll'),
        NAPCAT_LAUNCHER_PATH: path.join(home, 'NapCatWinBootMain.exe'),
        NAPCAT_MAIN_PATH: path.join(home, 'napcat.mjs'),
      });
      appendLog(`\n===== ${new Date().toISOString()} 启动内置 NapCat · QQ=${info.qq} · WebUI=${port} · token=${token.slice(0, 4)}**** =====`);
      let out = null;
      try { out = fs.openSync(logFile, 'a'); } catch { /* ignore */ }
      const args = [info.qq, path.join(home, 'NapCatWinBootHook.dll')];
      const quick = String(config.selfQQ || '').trim();
      if (quick) { args.push('-q', quick); }

      child = spawn(path.join(home, 'NapCatWinBootMain.exe'), args, {
        cwd: home,
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out === null ? 'ignore' : out, out === null ? 'ignore' : out],
      });
      child.on('error', (e) => {
        appendLog('[spawn error] ' + (e && e.message));
        set('failed', '启动失败：' + ((e && e.message) || e));
      });
      child.on('exit', (code) => {
        // launcher（NapCatWinBootMain.exe）注入完成后会自己退出，这是正常的；
        // 但注入进去的 QQ 宿主若同时消失，6099 就永远起不来，waitReady 会据此提前失败。
        st.launcherExitAt = Date.now();
        appendLog(`[launcher exit] code=${code}`);
      });
      try { child.unref(); } catch { /* ignore */ }

      st.pid = child.pid || 0;
      st.owned = true;
      st.lastStartAt = Date.now();
      st.launcherExitAt = 0;
      try { writeJson(pidFile, { pid: st.pid, at: Date.now(), qq: info.qq }); } catch { /* ignore */ }
      set('starting', '内置 NapCat 正在启动（首次启动需要 10–30 秒，随后在 WebUI 扫码登录）');
      watchToken();

      // ⑥ 等待 WebUI 就绪
      const ok = await waitReady(Math.max(15000, Number(config.napcatStartTimeout) || 60000));
      if (ok) {
        const pid = mainPid();
        if (pid) { st.pid = pid; try { writeJson(pidFile, { pid, at: Date.now(), qq: info.qq }); } catch { /* ignore */ } }
        readToken();
        set('webui', `内置 NapCat 已启动，WebUI 监听 127.0.0.1:${port}`);
        // WebUI 一就绪就尝试把 OneBot 网络应用上去（此时可能还没登录，失败也无所谓，
        // 登录成功后 index.js 会继续重试）。
        ensureOneBotNetwork({ force: true }).catch(() => {});
      } else {
        const hostGone = !!st.launcherExitAt;
        set('failed', hostGone
          ? `内置 NapCat 启动失败：注入的 QQ 宿主已退出（端口 ${port} 未监听）。请确认没有用同一个 QQ 号重复登录，或点「重新启动」再试`
          : `内置 NapCat 启动超时：请查看运行日志（可能是 QQ 未登录、需要管理员权限，或端口 ${port} 被占用）`);
      }
      return st;
    } catch (e) {
      set('failed', '启动内置 NapCat 异常：' + ((e && e.message) || e));
      return st;
    } finally {
      starting = false;
      try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    }
  }

  function killTree(pid) {
    if (!pid) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        p.on('exit', () => resolve(true));
        p.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
  }

  async function stop() {
    // 优先杀掉 NapCat 注入的 QQ 主进程（只有我们自己拉起来的才杀，避免误伤用户手动开的 QQ）
    if (st.owned) {
      const pid = mainPid() || st.pid;
      if (pid) {
        await killTree(pid);
        appendLog(`[stop] 已结束内置 NapCat 进程树 pid=${pid}`);
      }
    }
    try { fs.rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    st.owned = false; st.pid = 0;
    set('stopped', '已停止内置 NapCat');
    return st;
  }

  async function restart() {
    await stop();
    await new Promise((r) => setTimeout(r, 800));
    return start();
  }

  /** 重新生成 WebUI 管理 Token（写回 webui.json + token 文件，需重启 NapCat 生效）。 */
  async function rotateToken(nextToken) {
    const token = String(nextToken || '').trim() || newToken();
    writeTokenFile(token);
    ensureWebuiConfig(home, port, token);
    readToken();
    return token;
  }

  function status() {
    const t = readToken();
    // ── 活性校验（关键）──
    // 只看内部状态会骗人：NapCat 的 launcher 退出后 QQ 进程可能已死，
    // 端口全掉，但状态还停在 'webui'，面板就显示「已启动」而 WS 永远连不上。
    // 这里用巡检缓存（watch 每 3s 更新一次）交叉验证，掉了就如实回落成 stopped。
    let state = st.state;
    let reason = st.reason;
    const claimsUp = state === 'webui' || state === 'running';
    if (claimsUp && st.probeKnown && st.portUp === false) {
      state = 'stopped';
      reason = `内置 NapCat 已退出（WebUI 端口 ${port} 无监听，QQ 进程可能已关闭）`;
    }
    return {
      state,
      reason,
      rawState: st.state,
      alive: !!st.portUp,
      pid: mainPid() || st.pid,
      port: st.port,
      home: st.home,
      log: st.log,
      since: st.since,
      owned: st.owned,
      qqPath: st.qq || findQQ(config),
      webui: `http://127.0.0.1:${port}/webui`,
      webuiUrl: t.token ? `http://127.0.0.1:${port}/webui?token=${encodeURIComponent(t.token)}` : `http://127.0.0.1:${port}/webui`,
      token: t.token,
      tokenFrom: t.from,
      onebotToken: onebotToken(),
      onebotHttpPort: Number(config.napcatHttpPort) || 3000,
      onebotWsPort: Number(config.napcatWsPort) || 3001,
      endpoints: {
        webui: `http://127.0.0.1:${port}/webui`,
        ws: `ws://127.0.0.1:${Number(config.napcatWsPort) || 3001}`,
        http: `http://127.0.0.1:${Number(config.napcatHttpPort) || 3000}`,
      },
      onebot: onebotStatus(),
      platform: process.platform,
      logTail: logTail(30),
    };
  }

  /**
   * 持续巡检（面板三灯的第二、三盏能否变绿，全靠这里）：
   *   1) 每 3s 探一次 6099，把「端口是否真的在监听」写进 st.portUp；
   *   2) 端口掉了但状态还写着 webui/running → 说明 NapCat 悄悄死了，回落成 stopped；
   *   3) 是**我们自己拉起来的**且开了自动启动 → 自动重启（限流：10 分钟内最多 3 次）。
   */
  function watch() {
    if (timer) return;
    timer = setInterval(async () => {
      if (stopped) return;
      let up = false;
      try { up = await probePort(port); } catch { up = false; }
      st.portUp = up;
      st.probeKnown = true;
      if (up) {
        st.lastUpAt = Date.now();
        if (st.state === 'starting' || st.state === 'failed' || st.state === 'stopped') {
          readToken();
          set('webui', `内置 NapCat 已就绪，WebUI 监听 127.0.0.1:${port}`);
        }
        return;
      }
      // —— 端口掉了 ——
      if (st.state === 'webui' || st.state === 'running') {
        set('stopped', '内置 NapCat 已退出（端口无监听，QQ 可能被关闭）');
        appendLog('[watch] 检测到 WebUI 端口无监听，判定内置 NapCat 已退出');
      }
      if (starting) return;
      if (config.autoStartNapCat === false) return;
      if (!st.owned) return; // 外部实例不碰
      // 限流：10 分钟窗口内最多 3 次自动拉起，避免把 QQ 拉成重启风暴
      const now = Date.now();
      st.restarts = st.restarts.filter((t) => now - t < 10 * 60 * 1000);
      if (st.restarts.length >= 3) {
        if (st.state !== 'failed') {
          set('failed', '内置 NapCat 反复退出（10 分钟内已自动重试 3 次），请点「重新启动」或查看运行日志');
        }
        return;
      }
      if (now - (st.lastStartAt || 0) < 12000) return;
      st.restarts.push(now);
      appendLog(`[watch] 内置 NapCat 已退出，自动重新拉起（10 分钟内第 ${st.restarts.length} 次）`);
      log.info('[napcat-embedded] 检测到进程退出，自动重新拉起…');
      start().catch(() => {});
    }, 3000);
    try { if (timer.unref) timer.unref(); } catch { /* ignore */ }
  }

  /**
   * 插件被禁用 / 卸载 / DSH 退出：停掉由本插件拉起的 NapCat（连带 QQ 主进程）。
   * 用户明确要求「关闭插件自动停 NapCat」，所以这里真的会结束进程，而不只是解绑监听。
   */
  function shutdown(options) {
    if (stopped) return;
    stopped = true;
    const kill = !options || options.kill !== false;
    if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; }
    if (tokenPoll) { try { clearInterval(tokenPoll); } catch { /* ignore */ } tokenPoll = null; }
    if (kill && st.owned) {
      const pid = mainPid() || st.pid;
      if (pid) {
        appendLog(`[shutdown] 插件已停用，结束内置 NapCat 进程树 pid=${pid}`);
        try {
          const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          p.on('error', () => {}); p.unref?.();
        } catch { /* ignore */ }
      }
    }
  }

  return {
    start, stop, restart, status, watch, shutdown, inspect, rotateToken,
    readToken,
    onebotToken,
    preseedOneBot,
    ensureOneBotNetwork,
    onebotWsListening,
    onebotStatus,
    lastUin,
    rememberUin: (uin) => { if (uin) patchState({ uin: String(uin) }); },
    ensureOneBotConfig: (uin) => ensureOneBotConfig(home, uin, config, onebotToken()),
    paths: { home, run, logFile, pidFile },
  };
}
