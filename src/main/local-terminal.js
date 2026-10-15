'use strict';
// 로컬 터미널 — 이 PC의 셸(macOS: 로그인 셸, Windows: cmd.exe)을 가상 터미널(PTY)로 띄운다. git 같은 로컬 명령어를
// SSH 터미널과 같은 화면(xterm)에서 그대로 쓸 수 있다. 원격 접속이 아니라 이 PC에서 실행되는 셸이라 인증이 없다.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let pty = null;
function loadPty() {
  if (pty) return pty;
  // asar 안에서는 .node/spawn-helper를 실행할 수 없어 package.json의 asarUnpack으로 풀어 둔다 — node-pty가 경로를 알아서 바꿔 읽는다.
  pty = require('node-pty');
  return pty;
}

/** @type {Map<string, import('node-pty').IPty>} */
const sessions = new Map();

function defaultShell() {
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: [] };
  const file = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  return { file, args: ['-l'] }; // 로그인 셸 — Finder로 연 앱은 PATH가 짧아서 git 등이 안 보일 수 있다
}

function open(sessionId, params, onData, onStatus) {
  if (sessions.has(sessionId)) throw new Error('이미 열린 세션입니다');
  const { file, args } = defaultShell();
  const cwd = (params.cwd && fs.existsSync(params.cwd)) ? params.cwd : os.homedir();
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.ELECTRON_RUN_AS_NODE;
  const term = loadPty().spawn(file, args, {
    name: 'xterm-256color', cols: params.cols || 80, rows: params.rows || 24, cwd, env,
  });
  sessions.set(sessionId, term);
  term.onData((data) => onData(data));
  term.onExit(() => {
    if (sessions.get(sessionId) === term) sessions.delete(sessionId);
    onStatus({ state: 'disconnected' });
  });
  onStatus({ state: 'connected' });
  return { shell: path.basename(file), cwd };
}

const has = (sessionId) => sessions.has(sessionId);
function write(sessionId, data) { const t = sessions.get(sessionId); if (t) t.write(data); }
function resize(sessionId, cols, rows) {
  const t = sessions.get(sessionId);
  if (t && cols > 0 && rows > 0) { try { t.resize(cols, rows); } catch (_e) { /* 이미 종료 */ } }
}
function close(sessionId) {
  const t = sessions.get(sessionId);
  if (!t) return;
  sessions.delete(sessionId);
  try { t.kill(); } catch (_e) { /* noop */ }
}
function closeAll() { Array.from(sessions.keys()).forEach(close); }

module.exports = { open, has, write, resize, close, closeAll };
