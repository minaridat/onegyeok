// 터미널 세션 로그 — SSH·로컬 터미널에 찍힌 출력(입력한 명령어는 셸이 화면에 되돌려 찍으므로 함께 남는다)을 세션마다 파일로
// 자동 기록한다. 감사(Audit)·문제 해결용으로 나중에 열어 보는 용도라, 색상·커서 이동 같은 제어 문자는 빼고 읽을 수 있는 글자만 남긴다.
//
// - 위치: <userData>/session-logs/YYYY-MM-DD/HHMMSS_<서버이름>.log  (메뉴 "도구 > 세션 로그 폴더 열기")
// - 켜고 끄기: 메뉴 "도구 > 터미널 세션 로그 기록"(기본 켬). 설정은 <userData>/settings.json에 저장한다.
// - 화면에 표시되지 않는 입력(비밀번호 프롬프트 등)은 셸이 되돌려 찍지 않으므로 기록되지 않는다 — 키 입력 자체는 기록하지 않는다.
// 특정 프로토콜 소유가 아니라 공용이므로 각 프로토콜(ssh, local)이 직접 require해서 쓴다.
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const logs = new Map(); // sessionId -> { stream, carry }
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
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '_' + safeName);
    let file = base + '.log';
    for (let n = 2; fs.existsSync(file); n++) file = base + '(' + n + ').log'; // 같은 초에 같은 서버를 여러 탭으로 열 때
    const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    stream.on('error', (err) => { console.error('[session-log] 기록 실패:', err.message); logs.delete(sessionId); });
    const who = info.username ? info.username + '@' : '';
    stream.write('=== ' + stamp(now) + ' 세션 시작 · ' + info.protocol.toUpperCase() + ' · ' + (info.name || '') +
      (info.host ? ' (' + who + info.host + ')' : '') + ' ===\n');
    logs.set(sessionId, { stream, carry: '', newlines: 1 });
  } catch (err) {
    console.error('[session-log] 로그 파일을 만들 수 없습니다:', err.message);
  }
}

// 터미널 제어 시퀀스(색상, 커서 이동, 창 제목 등)를 지운다. 덩어리 끝에서 잘린 시퀀스는 다음 덩어리와 이어 붙여 처리한다.
// eslint-disable-next-line no-control-regex
const ESC_SEQ = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[()*+][0-9A-Za-z]|\x1b[ -/]*[0-Z\\^-~]/g;
// 덩어리가 시퀀스 중간에서 끝났는지(위 시퀀스들의 앞부분만 있는지)
// eslint-disable-next-line no-control-regex
const ESC_PARTIAL = /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[P^_][^\x1b]*|[()*+]|[ -/]*)$/;
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function clean(log, chunk) {
  let text = log.carry + chunk;
  log.carry = '';
  const lastEsc = text.lastIndexOf('\x1b');
  if (lastEsc !== -1 && text.length - lastEsc < 256 && ESC_PARTIAL.test(text.slice(lastEsc))) {
    log.carry = text.slice(lastEsc);
    text = text.slice(0, lastEsc);
  }
  // 커서 이동(CUP, ESC[행;열H)을 줄바꿈으로 본다 — 로컬 터미널(ConPTY)과 전체 화면 프로그램은 줄바꿈 대신 커서 이동으로 다음 줄에
  // 쓰고, 화면을 다시 그릴 때는 같은 줄 맨 앞으로 돌아가 덮어쓴다. 그냥 지우면 줄이 이어 붙으므로, 다른 줄로 가거나 글자를 쓴 줄의
  // 맨 앞으로 돌아가면 새 줄을 시작한다(같은 줄 안에서 커서만 옮기는 것은 무시). 줄바꿈·화면 지우기 뒤에는 현재 줄을 모르는 것으로 둔다.
  let lastEnd = 0;
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\n|\x1b\[[23]?J|\x1b\[(\d*)(?:;(\d*))?[Hf]/g, (m, row, col, offset) => {
    const wrote = text.slice(lastEnd, offset).replace(ESC_SEQ, '').replace(/[\r\b]/g, '').length > 0;
    lastEnd = offset + m.length;
    if (wrote) log.lineDirty = true;
    if (m === '\n' || m.endsWith('J')) { log.row = null; log.lineDirty = false; return m === '\n' ? m : ''; }
    const r = row || '1';
    const newLine = r !== log.row || ((col || '1') === '1' && log.lineDirty);
    log.row = r;
    if (!newLine) return '';
    log.lineDirty = false;
    return '\n';
  });
  if (text.slice(lastEnd).replace(ESC_SEQ, '').replace(/[\r\b]/g, '').length > 0) log.lineDirty = true;
  text = text.replace(ESC_SEQ, '').replace(/\r+\n/g, '\n').replace(/\r/g, '');
  // 줄 편집의 백스페이스("\b \b" 등)는 앞 글자를 지운 것으로 반영한다(같은 덩어리 안에서만).
  if (text.indexOf('\b') !== -1) {
    let out = '';
    for (const ch of text) {
      if (ch === '\b') { if (out && out[out.length - 1] !== '\n') out = out.slice(0, -1); } else out += ch;
    }
    text = out;
  }
  return text.replace(CTRL, '');
}

// 빈 줄은 최대 한 줄까지만 남긴다 — 로컬 터미널(ConPTY)은 화면을 다시 그릴 때 빈 줄을 화면 높이만큼 보낸다.
function squeezeBlankLines(log, text) {
  let out = '';
  for (const ch of text) {
    if (ch === '\n') { if (log.newlines >= 2) continue; log.newlines++; } else if (ch !== ' ') log.newlines = 0;
    out += ch;
  }
  return out;
}

function write(sessionId, chunk) {
  const log = logs.get(sessionId);
  if (!log) return;
  const text = squeezeBlankLines(log, clean(log, chunk));
  if (text) log.stream.write(text);
}

function close(sessionId) {
  const log = logs.get(sessionId);
  if (!log) return;
  logs.delete(sessionId);
  log.stream.end('\n=== ' + stamp(new Date()) + ' 세션 종료 ===\n');
}

function closeAll() { Array.from(logs.keys()).forEach(close); }

module.exports = { open, write, close, closeAll, isEnabled, setEnabled, logDir };
