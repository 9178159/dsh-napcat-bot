// lib/tts-local.js
// 系统内置语音（Windows SAPI）——**零 npm 依赖、无需联网、无需 API Key**。
//
// 用途：用户没填 TTS 接口地址时，插件也能真的发出语音（开箱即用）。
// 做法：把文本写成 UTF-8 文件 → 调 powershell 用 SAPI.SpFileStream 合成 WAV
//       → 读回来转 base64 → 交给 NapCat 发 record（NapCat 自带 ffmpeg 会转码）。
//
// 任何失败（无 powershell / 无中文语音 / 被安全软件拦 / 超时）都只返回 ''，
// 由上层降级为文字，绝不抛错、绝不刷屏。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const SYNTH_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 20;
const MAX_CHARS = 120;   // 本地引擎限制：太长 WAV 会很大，QQ 语音也不适合念长文

const PS_SCRIPT = [
  'param([string]$TextFile, [string]$OutFile, [string]$VoiceMatch)',
  "$ErrorActionPreference = 'Stop'",
  '$text = [IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)',
  '$v = New-Object -ComObject SAPI.SpVoice',
  'if ($VoiceMatch) {',
  '  foreach ($x in $v.GetVoices()) {',
  '    if ($x.GetDescription() -like "*$VoiceMatch*") { $v.Voice = $x; break }',
  '  }',
  '}',
  '$fs = New-Object -ComObject SAPI.SpFileStream',
  '$fs.Open($OutFile, 3, $false)',
  'try {',
  '  $v.AudioOutputStream = $fs',
  '  $v.Speak($text)',
  '} finally {',
  '  $fs.Close()',
  '}',
  "if (-not (Test-Path $OutFile)) { throw 'no output' }",
].join('\r\n');

function psPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function localEngineAvailable() {
  if (process.platform !== 'win32') return false;
  try { return fs.existsSync(psPath()); } catch { return false; }
}

export function createLocalTts(dataDir, log) {
  const cache = new Map();
  const dir = path.join(dataDir || os.tmpdir(), 'tts');
  let lastResult = { ok: null, reason: '', at: 0, ms: 0 };
  let okCount = 0;
  let failCount = 0;

  function scriptPath() {
    const p = path.join(dir, 'sapi-synth.ps1');
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(p)) fs.writeFileSync(p, PS_SCRIPT, 'utf8');
    } catch { /* ignore */ }
    return p;
  }

  function prune() {
    const now = Date.now();
    for (const [k, v] of cache) if (!v || now - v.at > CACHE_TTL_MS) cache.delete(k);
    while (cache.size > CACHE_MAX) {
      const first = cache.keys().next();
      if (first.done) break;
      cache.delete(first.value);
    }
  }

  function run(cmd, args, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true });
      } catch (e) {
        resolve({ ok: false, err: String((e && e.message) || e) });
        return;
      }
      let stderr = '';
      let done = false;
      const finish = (r) => { if (done) return; done = true; try { child.kill(); } catch { /* ignore */ } resolve(r); };
      const timer = setTimeout(() => finish({ ok: false, err: 'timeout' }), timeoutMs);
      try { child.stderr.on('data', (b) => { stderr += String(b); }); } catch { /* ignore */ }
      child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, err: String((e && e.message) || e) }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0 ? { ok: true } : { ok: false, err: stderr.trim().slice(-300) || ('exit ' + code) });
      });
    });
  }

  /**
   * 用系统语音合成一段 WAV，返回 base64；失败返回 ''。
   * @param {string} text
   * @returns {Promise<string>}
   */
  async function synth(text, voiceMatch) {
    const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (!body) return '';
    prune();
    const hit = cache.get(body);
    if (hit && Date.now() - hit.at <= CACHE_TTL_MS) { hit.at = Date.now(); return hit.b64; }
    if (!localEngineAvailable()) {
      lastResult = { ok: false, reason: 'no-powershell', at: Date.now(), ms: 0 };
      failCount += 1;
      return '';
    }

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const textFile = path.join(dir, `in-${stamp}.txt`);
    const wavFile = path.join(dir, `out-${stamp}.wav`);
    const started = Date.now();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(textFile, body, 'utf8');
      const r = await run(psPath(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath(), textFile, wavFile, String(voiceMatch || ''),
      ], SYNTH_TIMEOUT_MS);
      const ms = Date.now() - started;
      if (!r.ok) throw new Error(r.err || 'powershell failed');
      const buf = fs.readFileSync(wavFile);
      if (!buf.length) throw new Error('空音频');
      const b64 = buf.toString('base64');
      cache.set(body, { at: Date.now(), b64 });
      prune();
      okCount += 1;
      lastResult = { ok: true, reason: 'ok', at: Date.now(), ms };
      return b64;
    } catch (e) {
      failCount += 1;
      const reason = String((e && e.message) || e).slice(0, 160);
      lastResult = { ok: false, reason, at: Date.now(), ms: Date.now() - started };
      try { log && log.warn && log.warn(`[napcat] 本地语音合成失败（已降级为文字）: ${reason}`); } catch { /* ignore */ }
      return '';
    } finally {
      // 自动清理临时文件（不留垃圾）
      try { fs.unlinkSync(textFile); } catch { /* ignore */ }
      try { fs.unlinkSync(wavFile); } catch { /* ignore */ }
    }
  }

  function stats() {
    return {
      available: localEngineAvailable(),
      okCount,
      failCount,
      cache: cache.size,
      last: lastResult,
    };
  }

  return { synth, stats, available: localEngineAvailable };
}
