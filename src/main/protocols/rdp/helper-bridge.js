'use strict';

// onegyeok-rdp-helper(네이티브 libfreerdp 헬퍼) 프로세스 1개를 스폰하고, docs/기술스택/03_RDP_기술스택.md에
// 정의된 길이-프리픽스 바이너리 프레이밍([u32 LE length][u8 type][payload], length는 type 바이트 포함
// 길이)으로 stdin에 명령을 쓰고 stdout에서 이벤트를 파싱해 돌려준다.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { app } = require('electron');

const MSG = {
  CONNECT: 0x01,
  DISCONNECT: 0x02,
  MOUSE: 0x03,
  KEY: 0x04,
  UNICODE_KEY: 0x05,
  RESIZE: 0x06,
  CLIP_FILES: 0x08, // 로컬 클립보드 파일 목록(줄마다 d\t크기\t상대경로\t절대경로) — 비어 있으면 지움
  CLIPBOARD: 0x07, // 로컬 클립보드 텍스트(UTF-8) → 헬퍼가 서버에 알린다(cliprdr)
  CONNECTED: 0x81,
  FRAME: 0x82,
  STATUS: 0x83,
  LOG: 0x84,
  DESKTOP_RESIZED: 0x85, // 서버가 해상도를 바꿨다({width,height}) — 동적 해상도(화면 크기 조절)
  CLIPBOARD_REMOTE: 0x86, // 원격 클립보드 텍스트(UTF-8)
  REMOTE_FILES_BEGIN: 0x87, // 원격 클립보드 파일 목록
  REMOTE_FILE_CHUNK: 0x88, // [u32 항목 번호][내용 조각]
  REMOTE_FILES_END: 0x89, // [u8 결과] 1 완료 / 0 실패 / 2 상한 초과
};

function resolveHelperPath() {
  if (process.env.ONEGYEOK_RDP_HELPER_PATH) return process.env.ONEGYEOK_RDP_HELPER_PATH;
  const bin = process.platform === 'win32' ? 'onegyeok-rdp-helper.exe' : 'onegyeok-rdp-helper';
  // electron-builder로 패키징된 앱은 extraResources로 복사된 바이너리를 resourcesPath 밑에서 찾는다
  // (docs/기술스택/06_빌드배포_기술스택.md 참고) — 개발 중(app.isPackaged === false)에는 리포 루트의
  // native/rdp-helper/ Makefile이 프로젝트 디렉터리에 바로 만든 바이너리를 쓴다(build/ 서브디렉터리 없음).
  if (app.isPackaged) return path.join(process.resourcesPath, 'native', 'rdp-helper', bin);
  return path.join(__dirname, '..', '..', '..', '..', 'native', 'rdp-helper', bin);
}

function writeFrame(child, type, payload) {
  const body = payload || Buffer.alloc(0);
  const header = Buffer.alloc(5);
  header.writeUInt32LE(body.length + 1, 0);
  header.writeUInt8(type, 4);
  child.stdin.write(Buffer.concat([header, body]));
}

function jsonPayload(obj) { return Buffer.from(JSON.stringify(obj), 'utf8'); }

// child.stdout에서 들어오는 바이트를 프레임 단위로 잘라 onEvent(type, payload)를 호출한다.
// 부분 수신(한 번의 'data' 이벤트가 프레임 하나와 정확히 안 맞는 경우)을 버퍼로 흡수한다.
// 화면 프레임은 수 MB인데 파이프는 64KB씩 들어오므로, 조각마다 누적 버퍼를 다시 이어 붙이면 복사량이 프레임 크기의
// 제곱으로 늘어난다(1920×1080 한 장에 약 110ms → 헬퍼가 쓰기에서 막혀 입력 처리까지 밀림). 조각은 모아 두기만 하고
// 프레임 하나가 다 찼을 때 한 번만 합친다(같은 조건에서 약 6ms).
function makeFrameReader(onEvent) {
  let chunks = [];
  let total = 0;
  let need = -1; // 지금 프레임의 전체 길이(4바이트 길이 필드 포함), 아직 모르면 -1
  return function onData(chunk) {
    chunks.push(chunk);
    total += chunk.length;
    for (;;) {
      if (need < 0) {
        if (total < 4) return;
        if (chunks[0].length < 4) chunks = [Buffer.concat(chunks, total)];
        need = 4 + chunks[0].readUInt32LE(0);
      }
      if (total < need) return;
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
      const type = buf.readUInt8(4);
      const payload = buf.subarray(5, need);
      const rest = buf.subarray(need);
      chunks = rest.length ? [rest] : [];
      total = rest.length;
      need = -1;
      onEvent(type, payload);
    }
  };
}

/**
 * @param {function(number, Buffer):void} onEvent 헬퍼가 보낸 프레임마다 (type, payload) 호출
 * @param {function(string):void} [onLog] 헬퍼 stderr 로그(디버깅용)
 */
function spawnHelper(onEvent, onLog) {
  const helperPath = resolveHelperPath();
  const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', makeFrameReader(onEvent));
  if (onLog) child.stderr.on('data', (chunk) => onLog(chunk.toString('utf8')));

  return {
    child,
    connect(params) { writeFrame(child, MSG.CONNECT, jsonPayload(params)); },
    disconnect() { try { writeFrame(child, MSG.DISCONNECT, Buffer.alloc(0)); } catch (_e) { /* 이미 종료됐을 수 있음 */ } },
    mouse(x, y, flags) {
      const p = Buffer.alloc(6);
      p.writeUInt16LE(x, 0); p.writeUInt16LE(y, 2); p.writeUInt16LE(flags, 4);
      writeFrame(child, MSG.MOUSE, p);
    },
    key(scancode, flags) {
      const p = Buffer.alloc(4);
      p.writeUInt16LE(scancode, 0); p.writeUInt16LE(flags, 2);
      writeFrame(child, MSG.KEY, p);
    },
    unicodeKey(unicode, flags) {
      const p = Buffer.alloc(3);
      p.writeUInt16LE(unicode, 0); p.writeUInt8(flags, 2);
      writeFrame(child, MSG.UNICODE_KEY, p);
    },
    resize(width, height) {
      const p = Buffer.alloc(4);
      p.writeUInt16LE(width, 0); p.writeUInt16LE(height, 2);
      writeFrame(child, MSG.RESIZE, p);
    },
    clipboard(text) { writeFrame(child, MSG.CLIPBOARD, Buffer.from(text, 'utf8')); },
    clipFiles(listing) { writeFrame(child, MSG.CLIP_FILES, listing); },
    kill() {
      try { child.kill(); } catch (_e) { /* noop */ }
    },
  };
}

function parseFramePayload(payload) {
  return {
    x: payload.readUInt16LE(0),
    y: payload.readUInt16LE(2),
    w: payload.readUInt16LE(4),
    h: payload.readUInt16LE(6),
    pixels: payload.subarray(8),
  };
}

module.exports = { MSG, spawnHelper, parseFramePayload };
