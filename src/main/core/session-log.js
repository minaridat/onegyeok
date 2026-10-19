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
 * @param {{protocol: string, name?: string, host?: string, username?: string, rows?: number}} info
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
    logs.set(sessionId, new LineLog(stream, info.rows));
  } catch (err) {
    console.error('[session-log] 로그 파일을 만들 수 없습니다:', err.message);
  }
}

// 터미널 출력(이스케이프 시퀀스 포함)을 읽을 수 있는 줄로 바꾸는 상태 기계 — 조각으로 나뉘어 들어와도 이어서 처리한다.
// 셸(zsh·bash·PowerShell)은 입력 줄을 한 글자마다 커서를 옮기고 지우며 다시 그리므로, 글자를 그냥 이어 붙이면 "ggit --version"처럼
// 겹친다. 그래서 "현재 줄"을 메모리에 두고 커서 위치에 덮어쓰기·지우기를 그대로 반영한 뒤, 줄이 끝날 때 파일에 쓴다.
//  - \r 줄 맨 앞, \b 한 칸 뒤, CSI C/D/G/K/P/@/X(커서 이동·지우기) 반영. 색상(m) 등 나머지 시퀀스는 버린다.
//  - 커서 위치 지정(CSI 행;열 H, ConPTY·전체 화면 프로그램이 줄바꿈 대신 씀): 다른 행으로 가면 새 줄, 같은 행이면 열만 이동.
//    \n은 행을 하나 내린다(터미널 높이를 알면 맨 아래에서 멈춤 — 스크롤). ConPTY(cmd·PowerShell)는 출력 뒤 빈 줄을 건너뛸 때
//    "\n 다음 행;1 H"로 프롬프트를 그리므로, \n 뒤에 행을 잊으면 프롬프트가 방금 찍은 출력 줄을 덮어써 출력이 사라진다.
//  - 화면 지우기(CSI J) 뒤에는 현재 행을 모르는 것으로 둔다. 빈 줄은 연속 한 줄까지만 남긴다.
//  - 줄이 끝나지 않아도(예: "$ " 프롬프트) 출력이 잠시 멈추면 지금까지의 글자를 먼저 쓴다(끝 공백 제외).
const IDLE_FLUSH_MS = 700;

function isWide(c) {
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff) || (c >= 0x20000 && c <= 0x3fffd);
}

class LineLog {
  constructor(stream, rows) {
    this.stream = stream;
    this.rows = rows > 0 ? rows : 0; // 터미널 높이(모르면 0)
    this.state = 'text'; // text | esc | escParam | csi | osc | oscEsc | str
    this.csi = '';
    this.line = [];
    this.pos = 0;
    this.flushedLen = 0; // 현재 줄에서 이미 파일에 쓴 글자 수
    this.lineTime = null;
    this.row = null; // 마지막 커서 위치 지정의 행(모르면 null)
    this.blank = 1; // 직전에 쓴 줄이 빈 줄인지(헤더 다음이라 1로 시작해 처음 빈 줄은 건너뛴다)
    this.timer = null;
    this.repaint = false; // 창 크기 변경 뒤 화면 다시 그리기 중인지(beginRepaint)
    this.screen = null; // 다시 그리는 동안 행 번호 -> 그 행의 글자
    this.saved = null; // 다시 그리기 직전의 현재 줄
  }

  put(ch) {
    if (this.line.length === 0) this.lineTime = new Date();
    while (this.line.length < this.pos) this.line.push(' ');
    if (this.pos < this.line.length) this.line[this.pos] = ch; else this.line.push(ch);
    this.pos++;
    // 한글·한자 같은 전각 글자는 터미널에서 두 칸을 차지한다 — 빈 칸('')을 하나 더 둬서 커서 열 위치(CSI H/G/C)가 맞게 한다.
    if (isWide(ch.codePointAt(0))) {
      if (this.pos < this.line.length) this.line[this.pos] = ''; else this.line.push('');
      this.pos++;
    }
  }

  endLine() {
    if (this.repaint) { // 화면 복원 중 — 파일에 쓰지 않고 그 행의 내용만 기억한다
      if (this.row !== null && this.line.length) this.screen.set(this.row, this.line);
      this.line = []; this.pos = 0;
      return;
    }
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

  // ConPTY는 창 크기가 바뀌면 "CSI 8;행;열 t" 다음에 화면 전체를 처음부터 다시 그리고, 커서를 원래 자리(보통 프롬프트 끝)로
  // 되돌린다. 그대로 기록하면 화면 내용이 한 번 더 남고, 되돌아간 프롬프트 뒤에 친 명령이 따로 떨어진 줄이 된다.
  // 그래서 그 조각(chunk)이 끝날 때까지는 각 행의 내용만 기억하고, 끝나면 커서가 있는 행을 이어 쓸 줄로 삼는다.
  beginRepaint() {
    if (this.repaint) return;
    this.saved = { line: this.line, pos: this.pos, flushedLen: this.flushedLen, lineTime: this.lineTime };
    this.repaint = true;
    this.screen = new Map();
    this.line = []; this.pos = 0; this.row = null;
  }

  endRepaint() {
    this.repaint = false;
    const screen = this.screen;
    this.screen = null;
    if (this.line.length === 0 && this.row !== null && screen.has(this.row)) this.line = screen.get(this.row);
    const saved = this.saved;
    this.saved = null;
    const cur = { line: this.line, pos: this.pos };
    const text = (l) => l.join('').replace(/\s+$/, '');
    const savedText = text(saved.line);
    if (saved.line.length && savedText === text(cur.line)) { // 같은 줄로 돌아옴 — 이미 쓴 부분 다음부터 이어 쓴다
      this.flushedLen = saved.flushedLen; this.lineTime = saved.lineTime;
      return;
    }
    if (saved.line.length) { // 다른 줄 — 하던 줄을 마무리하고 새 줄로
      this.line = saved.line; this.pos = saved.pos; this.flushedLen = saved.flushedLen; this.lineTime = saved.lineTime;
      this.endLine();
    }
    // 크기 변경 알림이 출력 도중에 끼면(앱이 셸을 띄우자마자 칸 크기를 맞출 때 등), 하던 줄과 커서 행 사이의 줄은 다시 그린
    // 화면에만 있고 아직 기록되지 않았다 — 하던 줄을 화면에서 찾아 그 아래부터 커서 행 앞까지를 기록한다.
    if (savedText && this.row !== null) {
      let from = null;
      for (const [r, l] of screen) if (r < this.row && text(l) === savedText) from = r;
      if (from !== null) {
        for (let r = from + 1; r < this.row; r++) {
          this.line = screen.get(r) || []; this.pos = 0; this.flushedLen = 0; this.lineTime = new Date();
          this.endLine();
        }
      }
    }
    this.line = cur.line; this.pos = cur.pos; this.flushedLen = 0;
    this.lineTime = cur.line.length ? new Date() : null;
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
        const row = Math.max(1, nums[0] || 1);
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
      case 't': if (first === 8) this.beginRepaint(); break; // 창 크기 변경 알림(ConPTY) — 뒤따르는 화면 다시 그리기
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
          else if (ch === '\n') {
            this.endLine();
            if (this.row !== null) this.row = this.rows ? Math.min(this.row + 1, this.rows) : this.row + 1;
          }
          else if (ch === '\r') this.pos = 0;
          else if (c === 8) { if (this.pos > 0) this.pos--; }
          else if (c >= 0xe000 && c <= 0xf8ff) { /* 프롬프트 아이콘(Powerline/Nerd Font) 글리프 — 로그에는 의미가 없다 */ }
          else if (c === 9 || (c >= 32 && c !== 127)) this.put(c === 9 ? '\t' : ch);
      }
    }
    if (this.repaint) this.endRepaint();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushPartial(), IDLE_FLUSH_MS);
  }

  finish() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.line.length) this.endLine();
  }
}

/** 터미널 높이가 바뀌면 알려 준다(맨 아래 행에서 \n이 스크롤되는 것을 맞추는 데 쓴다). */
function resize(sessionId, rows) {
  const log = logs.get(sessionId);
  if (log && rows > 0) {
    log.rows = rows;
    if (log.row !== null && log.row > rows) log.row = rows;
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

module.exports = { open, write, resize, close, closeAll, isEnabled, setEnabled, logDir };
