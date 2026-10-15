'use strict';
// 세션 로그 — SSH·로컬 터미널에서 화면에 나온 모든 출력(셸이 되돌려 찍는 입력한 명령어 포함)을 파일로 자동 기록한다.
// 감사(Audit)·문제 해결용이라 앱 UI에서는 읽기와 폴더 열기만 가능하고 수정·삭제는 없다(보관 기간이 지나면 자동 삭제).
//
// 보안(F-601): 키보드 입력을 따로 기록하지 않고 "화면에 출력된 것"만 남긴다. 비밀번호 프롬프트는 입력이 화면에
// 에코되지 않으므로 비밀번호가 로그에 들어가지 않는다. 파일은 소유자만 읽고 쓸 수 있게(0600) 만든다.
//
// 저장 위치: <userData>/session-logs/YYYY-MM-DD/HHmmss_<이름>_<세션>.log — 줄마다 "[YYYY-MM-DD HH:mm:ss]" 시각을 붙인다.
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, shell } = require('electron');

const DEFAULT_CONFIG = { enabled: true, retentionDays: 90 };
const MAX_VIEW_BYTES = 2 * 1024 * 1024; // 로그 보기에서 한 번에 읽는 최대 크기(끝부분)
const IDLE_FLUSH_MS = 700; // 줄이 끝나지 않아도(예: "$ " 프롬프트) 이 시간 동안 출력이 없으면 지금까지를 파일에 쓴다

let config = null;
const logs = new Map(); // sessionId -> LogSession

function baseDir() { return path.join(app.getPath('userData'), 'session-logs'); }
function configPath() { return path.join(app.getPath('userData'), 'session-log-config.json'); }

function loadConfig() {
  if (config) return config;
  config = { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
    if (Number.isFinite(raw.retentionDays)) config.retentionDays = Math.min(3650, Math.max(1, Math.floor(raw.retentionDays)));
  } catch (_e) { /* 처음이거나 손상 — 기본값 */ }
  return config;
}

function saveConfig(next) {
  const cur = loadConfig();
  if (typeof next.enabled === 'boolean') cur.enabled = next.enabled;
  if (Number.isFinite(next.retentionDays)) cur.retentionDays = Math.min(3650, Math.max(1, Math.floor(next.retentionDays)));
  try { fs.writeFileSync(configPath(), JSON.stringify(cur), { mode: 0o600 }); } catch (_e) { /* 저장 실패해도 이번 실행에는 적용 */ }
  return cur;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function safeName(s) { return String(s || 'session').replace(/[^\p{L}\p{N}_.-]+/gu, '_').slice(0, 40) || 'session'; }

// 터미널 출력(이스케이프 시퀀스 포함)을 읽을 수 있는 글자로 바꾸는 상태 기계. 조각으로 나뉘어 들어와도 이어서 처리한다.
// 줄 편집은 "덮어쓰기" 모델 — \r은 줄 맨 앞으로, \b는 한 칸 뒤로(진행 표시줄·비밀번호 지우기 등이 깨끗하게 남는다).
class LogSession {
  constructor(file, meta) {
    this.file = file;
    this.meta = meta;
    this.fd = fs.openSync(file, 'a', 0o600);
    this.state = 'text'; // text | esc | escParam | csi | osc | oscEsc | str
    this.csi = ''; // 처리 중인 CSI 시퀀스의 매개변수
    this.line = []; // 지금 줄의 글자들
    this.pos = 0;
    this.flushedLen = 0; // 이 줄에서 이미 파일에 쓴 글자 수
    this.lineTime = null;
    this.timer = null;
    this.closed = false;
    this.write('===== 세션 시작 ' + stamp(new Date()) + ' · ' + meta.title + (meta.detail ? ' (' + meta.detail + ')' : '') + ' =====\n');
  }
  write(s) { if (!this.closed) { try { fs.writeSync(this.fd, s); } catch (_e) { /* 디스크 오류 — 세션은 계속 */ } } }

  put(ch) {
    if (this.pos === 0 && this.line.length === 0) this.lineTime = new Date();
    while (this.line.length < this.pos) this.line.push(' ');
    if (this.pos < this.line.length) this.line[this.pos] = ch; else this.line.push(ch);
    this.pos++;
  }
  // 커서 이동·지우기 제어 시퀀스(zsh/bash가 입력 줄을 다시 그릴 때 쓴다)를 줄 편집에 반영한다.
  csiEnd(final) {
    const n = Math.max(1, parseInt(this.csi.replace(/[^0-9;]/g, '').split(';')[0], 10) || 1);
    const raw = parseInt(this.csi.replace(/[^0-9;]/g, '').split(';')[0], 10);
    switch (final) {
      case 'C': this.pos += n; break;
      case 'D': this.pos = Math.max(0, this.pos - n); break;
      case 'G': this.pos = Math.max(0, n - 1); break;
      case 'K': {
        const mode = Number.isNaN(raw) ? 0 : raw;
        if (mode === 0) this.line.length = Math.min(this.line.length, this.pos);
        else if (mode === 2) { this.line = []; this.pos = 0; }
        else for (let i = 0; i < this.pos && i < this.line.length; i++) this.line[i] = ' ';
        break;
      }
      case 'P': this.line.splice(this.pos, n); break;
      case '@': this.line.splice(this.pos, 0, ...Array(n).fill(' ')); break;
      case 'X': for (let i = this.pos; i < this.pos + n && i < this.line.length; i++) this.line[i] = ' '; break;
      default: break; // 위·아래 이동, 색상(m) 등은 무시
    }
  }
  header() { return '[' + stamp(this.lineTime || new Date()) + '] '; }
  endLine() {
    const text = this.line.join('').replace(/\s+$/, '');
    if (this.flushedLen === 0) this.write(this.header() + text + '\n');
    else this.write(text.slice(this.flushedLen) + '\n');
    this.line = []; this.pos = 0; this.flushedLen = 0; this.lineTime = null;
  }
  flushPartial() {
    this.timer = null;
    if (this.closed || this.line.length === 0) return;
    const text = this.line.join('').replace(/\s+$/, ''); // 끝의 공백(오른쪽 프롬프트용 여백 등)은 쓰지 않고, 뒤에 글자가 오면 그때 함께 쓴다
    if (text.length <= this.flushedLen) return;
    if (this.flushedLen === 0) this.write(this.header() + text); else this.write(text.slice(this.flushedLen));
    this.flushedLen = text.length;
  }

  feed(chunk) {
    if (this.closed) return;
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    for (const ch of s) {
      const c = ch.codePointAt(0);
      switch (this.state) {
        case 'esc':
          if (ch === '[') { this.state = 'csi'; this.csi = ''; }
          else if (ch === ']') this.state = 'osc';
          else if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') this.state = 'str';
          else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#') this.state = 'escParam'; // 다음 글자 하나까지 버림
          else this.state = 'text';
          break;
        case 'escParam': this.state = 'text'; break;
        case 'csi':
          if (c >= 0x40 && c <= 0x7e) { this.state = 'text'; this.csiEnd(ch); } else this.csi += ch;
          break;
        case 'osc': if (c === 7) this.state = 'text'; else if (c === 0x1b) this.state = 'oscEsc'; break;
        case 'oscEsc': this.state = ch === '\\' ? 'text' : 'osc'; break;
        case 'str': if (c === 0x1b) this.state = 'oscEsc'; else if (c === 7) this.state = 'text'; break;
        default:
          if (c === 0x1b) this.state = 'esc';
          else if (ch === '\n') this.endLine();
          else if (ch === '\r') this.pos = 0;
          else if (c === 8) { if (this.pos > 0) this.pos--; }
          else if (c >= 0xe000 && c <= 0xf8ff) { /* 프롬프트 아이콘(Powerline/Nerd Font) 글리프 — 로그에는 의미가 없어 건너뛴다 */ }
          else if (c === 9 || (c >= 32 && c !== 127)) {
            this.put(c === 9 ? '\t' : ch);
          }
      }
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushPartial(), IDLE_FLUSH_MS);
  }

  close(reason) {
    if (this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.line.length) this.endLine();
    this.write('===== 세션 종료 ' + stamp(new Date()) + (reason ? ' · ' + reason : '') + ' =====\n');
    this.closed = true;
    try { fs.closeSync(this.fd); } catch (_e) { /* noop */ }
  }
}

// 세션 시작 — 로그를 꺼 두었으면 아무것도 하지 않는다. meta: { title, detail }
function start(sessionId, meta) {
  if (!loadConfig().enabled) return null;
  stop(sessionId, '재시작');
  try {
    const now = new Date();
    const dir = path.join(baseDir(), now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '_' + safeName(meta.title) + '_' + safeName(sessionId).slice(-8) + '.log';
    const log = new LogSession(path.join(dir, name), meta);
    logs.set(sessionId, log);
    return log.file;
  } catch (_e) { return null; } // 로그를 못 만들어도 접속 자체는 막지 않는다
}
function append(sessionId, chunk) { const l = logs.get(sessionId); if (l) l.feed(chunk); }
function stop(sessionId, reason) { const l = logs.get(sessionId); if (l) { l.close(reason); logs.delete(sessionId); } }
function stopAll(reason) { Array.from(logs.keys()).forEach((id) => stop(id, reason)); }
function fileOf(sessionId) { const l = logs.get(sessionId); return l ? l.file : null; }

// 보관 기간이 지난 날짜 폴더를 지운다(앱 시작 시 1회). 로그는 날짜 폴더 단위로 보관한다.
function pruneOld() {
  const days = loadConfig().retentionDays;
  const cutoff = Date.now() - days * 86400000;
  let dirs = [];
  try { dirs = fs.readdirSync(baseDir()); } catch (_e) { return; }
  dirs.forEach((d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) return;
    const t = new Date(+m[1], +m[2] - 1, +m[3] + 1).getTime(); // 그날이 끝나는 시각
    if (t < cutoff) { try { fs.rmSync(path.join(baseDir(), d), { recursive: true, force: true }); } catch (_e) { /* 사용 중이면 다음에 */ } }
  });
}

function list(limit = 200) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(baseDir()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch (_e) { return out; }
  const active = new Set(Array.from(logs.values()).map((l) => l.file));
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(baseDir(), d)).filter((f) => f.endsWith('.log')).sort().reverse(); } catch (_e) { continue; }
    for (const f of files) {
      const full = path.join(baseDir(), d, f);
      let st; try { st = fs.statSync(full); } catch (_e) { continue; }
      out.push({ id: d + '/' + f, date: d, name: f, size: st.size, mtime: st.mtimeMs, active: active.has(full) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// 렌더러가 준 id("날짜/파일명")를 로그 폴더 안의 실제 경로로만 바꾼다 — 경로 탈출 방지.
function resolveId(id) {
  const m = /^(\d{4}-\d{2}-\d{2})\/([^/\\]+\.log)$/.exec(String(id));
  if (!m) return null;
  const full = path.join(baseDir(), m[1], m[2]);
  return full.startsWith(baseDir() + path.sep) ? full : null;
}

function read(id) {
  const full = resolveId(id);
  if (!full) return { ok: false, error: '잘못된 로그 경로' };
  try {
    const st = fs.statSync(full);
    const len = Math.min(st.size, MAX_VIEW_BYTES);
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return { ok: true, text: buf.toString('utf8'), truncated: st.size > len, size: st.size };
    } finally { fs.closeSync(fd); }
  } catch (err) { return { ok: false, error: err.message }; }
}

function wire() {
  ipcMain.handle('log:get-config', () => ({ ...loadConfig(), dir: baseDir() }));
  ipcMain.handle('log:set-config', (_e, next) => ({ ...saveConfig(next || {}), dir: baseDir() }));
  ipcMain.handle('log:list', () => list());
  ipcMain.handle('log:read', (_e, id) => read(id));
  ipcMain.handle('log:open-folder', async (_e, id) => {
    const full = id ? resolveId(id) : null;
    if (full) { shell.showItemInFolder(full); return { ok: true }; }
    try { fs.mkdirSync(baseDir(), { recursive: true, mode: 0o700 }); } catch (_e2) { /* noop */ }
    const err = await shell.openPath(baseDir());
    return { ok: !err, error: err || undefined };
  });
  ipcMain.handle('log:session-file', (_e, sessionId) => {
    const f = fileOf(sessionId);
    if (!f) return null;
    return path.basename(path.dirname(f)) + '/' + path.basename(f);
  });
  pruneOld();
}

module.exports = { wire, start, append, stop, stopAll, fileOf };
