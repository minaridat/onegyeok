'use strict';

// onegyeok-vnc-helper(네이티브 libvncclient 헬퍼) 프로세스 1개를 스폰하고, docs/기술스택/04_VNC_기술스택.md에
// 정의된 길이-프리픽스 바이너리 프레이밍([u32 LE length][u8 type][payload], length는 type 바이트 포함
// 길이)으로 stdin에 명령을 쓰고 stdout에서 이벤트를 파싱해 돌려준다. RDP 쪽(src/main/protocols/rdp/
// helper-bridge.js)과 프레이밍 자체는 동일하지만, 메시지 스키마가 VNC(RFB)에 맞게 다르므로 공용 모듈로
// 뽑지 않고 독립 파일로 유지한다(폴더 분할 목적 — 병렬 작업 시 공용 파일 충돌 없음).
const { spawn } = require('node:child_process');
const path = require('node:path');
const { app } = require('electron');

const MSG = {
  CONNECT: 0x01,
  DISCONNECT: 0x02,
  MOUSE: 0x03,
  KEY: 0x04,
  RESIZE: 0x06,
  CONNECTED: 0x81,
  FRAME: 0x82,
  STATUS: 0x83,
  LOG: 0x84,
};

function resolveHelperPath() {
  if (process.env.ONEGYEOK_VNC_HELPER_PATH) return process.env.ONEGYEOK_VNC_HELPER_PATH;
  const bin = process.platform === 'win32' ? 'onegyeok-vnc-helper.exe' : 'onegyeok-vnc-helper';
  // electron-builder로 패키징된 앱은 extraResources로 복사된 바이너리를 resourcesPath 밑에서 찾는다
  // (docs/기술스택/06_빌드배포_기술스택.md 참고) — 개발 중(app.isPackaged === false)에는 리포 루트의
  // native/vnc-helper/ 프로젝트 디렉터리에 바로 만들어진 바이너리를 쓴다(build/ 서브디렉터리 없음).
  if (app.isPackaged) return path.join(process.resourcesPath, 'native', 'vnc-helper', bin);
  return path.join(__dirname, '..', '..', '..', '..', 'native', 'vnc-helper', bin);
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
function makeFrameReader(onEvent) {
  let buf = Buffer.alloc(0);
  return function onData(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const type = buf.readUInt8(4);
      const payload = buf.subarray(5, 4 + len);
      buf = buf.subarray(4 + len);
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
    mouse(x, y, buttonMask) {
      const p = Buffer.alloc(5);
      p.writeUInt16LE(x, 0); p.writeUInt16LE(y, 2); p.writeUInt8(buttonMask, 4);
      writeFrame(child, MSG.MOUSE, p);
    },
    key(keysym, down) {
      const p = Buffer.alloc(5);
      p.writeUInt32LE(keysym, 0); p.writeUInt8(down ? 1 : 0, 4);
      writeFrame(child, MSG.KEY, p);
    },
    resize() {
      // VNC는 서버가 해상도를 결정한다 — 클라이언트발 리사이즈 개념이 없다(문서의 알려진 no-op).
      writeFrame(child, MSG.RESIZE, Buffer.alloc(0));
    },
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
