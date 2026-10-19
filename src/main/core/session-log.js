// 터미널 세션 로그 — SSH·로컬 터미널에 찍힌 출력(입력한 명령어는 셸이 화면에 되돌려 찍으므로 함께 남는다)을 세션마다 파일로
// 자동 기록한다. 감사(Audit)·문제 해결용으로 나중에 열어 보는 용도라, 색상·커서 이동 같은 제어 문자는 빼고 읽을 수 있는 글자만 남긴다.
// 줄마다 앞에 [YYYY-MM-DD HH:mm:ss] 시각이 붙고, 로그 폴더는 소유자만(0700), 파일은 소유자만 읽고 쓴다(0600).
//
// - 위치: <userData>/session-logs/YYYY-MM-DD/HHMMSS_<서버이름>.log  (메뉴 "도구 > 세션 로그 폴더 열기")
// - 켜고 끄기: 메뉴 "도구 > 터미널 세션 로그 기록"(기본 켬). 설정은 <userData>/settings.json에 저장한다.
// - 화면에 표시되지 않는 입력(비밀번호 프롬프트 등)은 셸이 되돌려 찍지 않으므로 기록되지 않는다 — 키 입력 자체는 기록하지 않는다.
// 특정 프로토콜 소유가 아니라 공용이므로 각 프로토콜(ssh, local)이 직접 require해서 쓴다.
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const logs = new Map(); // sessionId -> LineLog
let enabled = null; // null = 아직 settings.json을 안 읽음

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; } catch (_e) { return {}; }
}

function isEnabled() {
  if (enabled === null) enabled = readSettings().sessionLog !== false;
  return enabled;
}

function setEnabled(on) {
  enabled = !!on;
  const s = readSettings();
  s.sessionLog = enabled;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  } catch (err) {
    console.error('[session-log] 설정 저장 실패:', err.message);
  }
}

function logDir() { return path.join(app.getPath('userData'), 'session-logs'); }

const pad = (n) => String(n).padStart(2, '0');
function stamp(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 세션 로그 파일을 연다(기록이 꺼져 있으면 아무것도 안 함).
 * @param {string} sessionId
 * @param {{protocol: string, name?: string, host?: string, username?: string}} info
 */
function open(sessionId, info) {
  close(sessionId);
  if (!isEnabled()) return;
  const now = new Date();
  const day = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const safeName = String(info.name || info.host || info.protocol).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  const dir = path.join(logDir(), day);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const base = path.join(dir, pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '_' + safeName);
    let file = base + '.log';
    for (let n = 2; fs.existsSync(file); n++) file = base + '(' + n + ').log'; // 같은 초에 같은 서버를 여러 탭으로 열 때
    const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8', mode: 0o600 });
    stream.on('error', (err) => { console.error('[session-log] 기록 실패:', err.message); logs.delete(sessionId); });
    const who = info.username ? info.username + '@' : '';
    stream.write('=== ' + stamp(now) + ' 세션 시작 · ' + info.protocol.toUpperCase() + ' · ' + (info.name || '') +
      (info.host ? ' (' + who + info.host + ')' : '') + ' ===\n');
    logs.set(sessionId, new LineLog(stream));
  } catch (err) {
    console.error('[session-log] 로그 파일을 만들 수 없습니다:', err.message);
  }
}

// 터미널 출력(이스케이프 시퀀스 포함)을 읽을 수 있는 줄로 바꾸는 상태 기계 — 조각으로 나뉘어 들어와도 이어서 처리한다.
// 셸(zsh·bash·PowerShell)은 입력 줄을 한 글자마다 커서를 옮기고 지우며 다시 그리므로, 글자를 그냥 이어 붙이면 "ggit --version"처럼
// 겹친다. 그래서 "현재 줄"을 메모리에 두고 커서 위치에 덮어쓰기·지우기를 그대로 반영한 뒤, 줄이 끝날 때 파일에 쓴다.
//  - \r 줄 맨 앞, \b 한 칸 뒤, CSI C/D/G/K/P/@/X(커서 이동·지우기) 반영. 색상(m) 등 나머지 시퀀스는 버린다.
//  - 커서 위치 지정(CSI 행;열 H, ConPTY·전체 화면 프로그램이 줄바꿈 대신 씀): 다른 행으로 가면 새 줄, 같은 행이면 열만 이동.
//  - 화면 지우기(CSI J)와 \n 뒤에는 현재 행을 모르는 것으로 둔다. 빈 줄은 연속 한 줄까지만 남긴다.
//  - 줄이 끝나지 않아도(예: "$ " 프롬프트) 출력이 잠시 멈추면 지금까지의 글자를 먼저 쓴다(끝 공백 제외).
const IDLE_FLUSH_MS = 700;

class LineLog {
  constructor(stream) {
    this.stream = stream;
    this.state = 'text'; // text | esc | escParam | csi | osc | oscEsc | str
    this.csi = '';
    this.line = [];
    this.pos = 0;
    this.flushedLen = 0; // 현재 줄에서 이미 파일에 쓴 글자 수
    this.lineTime = null;
    this.row = null; // 마지막 커서 위치 지정의 행(모르면 null)
    this.blank = 1; // 직전에 쓴 줄이 빈 줄인지(헤더 다음이라 1로 시작해 처음 빈 줄은 건너뛴다)
    this.timer = null;
  }

  put(ch) {
    if (this.line.length === 0) this.lineTime = new Date();
    while (this.line.length < this.pos) this.line.push(' ');
    if (this.pos < this.line.length) this.line[this.pos] = ch; else this.line.push(ch);
    this.pos++;
  }

  endLine() {
    const text = this.line.join('').replace(/\s+$/, '');
    if (this.flushedLen === 0) {
      if (text === '') { if (!this.blank) this.stream.write('\n'); this.blank = 1; } // 빈 줄은 연속 한 줄까지만
      else { this.stream.write('[' + stamp(this.lineTime || new Date()) + '] ' + text + '\n'); this.blank = 0; }
    } else {
      this.stream.write(text.slice(this.flushedLen) + '\n');
      this.blank = 0;
    }
    this.line = []; this.pos = 0; this.flushedLen = 0; this.lineTime = null;
  }

  flushPartial() {
    this.timer = null;
    const text = this.line.join('').replace(/\s+$/, ''); // 오른쪽 프롬프트용 여백은 쓰지 않고, 뒤에 글자가 오면 그때 함께 쓴다
    if (text.length <= this.flushedLen) return;
    if (this.flushedLen === 0) this.stream.write('[' + stamp(this.lineTime || new Date()) + '] ' + text);
    else this.stream.write(text.slice(this.flushedLen));
    this.flushedLen = text.length;
    this.blank = 0;
  }

  csiEnd(final) {
    const nums = this.csi.replace(/[^0-9;]/g, '').split(';').map((x) => parseInt(x, 10));
    const first = nums[0];
    const n = Math.max(1, first || 1);
    switch (final) {
      case 'C': this.pos += n; break;
      case 'D': this.pos = Math.max(0, this.pos - n); break;
      case 'G': this.pos = Math.max(0, n - 1); break;
      case 'K': {
        const mode = Number.isNaN(first) ? 0 : first;
        if (mode === 0) this.line.length = Math.min(this.line.length, this.pos);
        else if (mode === 2) { this.line = []; this.pos = 0; }
        else for (let i = 0; i < this.pos && i < this.line.length; i++) this.line[i] = ' ';
        break;
      }
      case 'P': this.line.splice(this.pos, n); break;
      case '@': this.line.splice(this.pos, 0, ...Array(n).fill(' ')); break;
      case 'X': for (let i = this.pos; i < this.pos + n && i < this.line.length; i++) this.line[i] = ' '; break;
      case 'H': case 'f': {
        const row = String(nums[0] || 1);
        const col = Math.max(1, nums[1] || 1);
        if (this.row !== null && row !== this.row && this.line.length) this.endLine();
        this.row = row;
        this.pos = col - 1;
        break;
      }
      case 'J':
        if (this.line.length) this.endLine();
        this.row = null;
        break;
      default: break; // 위·아래 이동, 색상(m) 등은 무시
    }
  }

  feed(chunk) {
    for (const ch of chunk) {
      const c = ch.codePointAt(0);
      switch (this.state) {
        case 'esc':
          if (ch === '[') { this.state = 'csi'; this.csi = ''; }
          else if (ch === ']') this.state = 'osc';
          else if (ch === 'P' || ch === '_' || ch === '^' || ch === 'X') this.state = 'str';
          else if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#') this.state = 'escParam';
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
          else if (ch === '\n') { this.row = null; this.endLine(); }
          else if (ch === '\r') this.pos = 0;
          else if (c === 8) { if (this.pos > 0) this.pos--; }
          else if (c >= 0xe000 && c <= 0xf8ff) { /* 프롬프트 아이콘(Powerline/Nerd Font) 글리프 — 로그에는 의미가 없다 */ }
          else if (c === 9 || (c >= 32 && c !== 127)) this.put(c === 9 ? '\t' : ch);
      }
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushPartial(), IDLE_FLUSH_MS);
  }

  finish() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.line.length) this.endLine();
  }
}

function write(sessionId, chunk) {
  const log = logs.get(sessionId);
  if (log) log.feed(typeof chunk === 'string' ? chunk : String(chunk));
}

function close(sessionId) {
  const log = logs.get(sessionId);
  if (!log) return;
  logs.delete(sessionId);
  log.finish();
  log.stream.end('=== ' + stamp(new Date()) + ' 세션 종료 ===\n');
}

function closeAll() { Array.from(logs.keys()).forEach(close); }

module.exports = { open, write, close, closeAll, isEnabled, setEnabled, logDir };
