'use strict';

// onegyeok-rdp-helper(네이티브 libfreerdp 헬퍼) 프로세스 1개를 스폰하고, docs/기술스택/03_RDP_기술스택.md에
// 정의된 길이-프리픽스 바이너리 프레이밍([u32 LE length][u8 type][payload], length는 type 바이트 포함
// 길이)으로 stdin에 명령을 쓰고 stdout에서 이벤트를 파싱해 돌려준다.
const { spawn } = require('node:child_process');
const path = require('node:path');

const MSG = {
  CONNECT: 0x01,
  DISCONNECT: 0x02,
  MOUSE: 0x03,
  KEY: 0x04,
  UNICODE_KEY: 0x05,
  RESIZE: 0x06,
  CONNECTED: 0x81,
  FRAME: 0x82,
  STATUS: 0x83,
  LOG: 0x84,
};

function resolveHelperPath() {
  if (process.env.ONEGYEOK_RDP_HELPER_PATH) return process.env.ONEGYEOK_RDP_HELPER_PATH;
  // 패키징 전 개발 단계의 기본 추정 경로 — src/main/protocols/rdp/ 기준 리포 루트의
  // native/rdp-helper/ Makefile이 프로젝트 디렉터리에 바로 바이너리를 만든다(build/ 서브디렉터리 없음).
  // 실제 배포 시 경로는 패키징 스크립트가 ONEGYEOK_RDP_HELPER_PATH로 덮어쓸 것이므로, 여기 값이
  // 정확하지 않아도 그 환경변수가 항상 우선한다.
  const bin = process.platform === 'win32' ? 'onegyeok-rdp-helper.exe' : 'onegyeok-rdp-helper';
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
