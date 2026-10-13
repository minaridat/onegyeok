#!/usr/bin/env node
'use strict';

// 개발/테스트용 가짜 RDP 헬퍼 — 실제 native/rdp-helper 바이너리와 똑같은 프레이밍 프로토콜을
// stdin/stdout으로 말한다(docs/기술스택/03_RDP_기술스택.md 참고). 실제 libfreerdp 없이도
// main 프로세스 ↔ 렌더러 쪽 배선(캔버스 렌더링, IPC 중계)을 테스트할 수 있게 하는 용도.
// 사용: ONEGYEOK_RDP_HELPER_PATH=<node 실행파일> 로 쓰려면 spawn 쪽에서 이 파일을 인자로 넘겨야 하므로,
// 보통은 helper-bridge.js의 resolveHelperPath()가 이 파일을 직접 spawn하지 않는다 — 테스트 코드에서
// `spawn(process.execPath, [thisFile])` 형태로 띄운다.

const WIDTH = 800, HEIGHT = 600;

function writeFrame(type, payload) {
  const body = payload || Buffer.alloc(0);
  const header = Buffer.alloc(5);
  header.writeUInt32LE(body.length + 1, 0);
  header.writeUInt8(type, 4);
  process.stdout.write(Buffer.concat([header, body]));
}

let frameTimer = null;
let hue = 0;

function hueToBgr(h) {
  // 아주 단순한 무채도 사이클(R=h, G=255-h, B=128) — 테스트 패턴 확인 목적
  return { r: h, g: 255 - h, b: 128 };
}

function sendSyntheticFrame() {
  hue = (hue + 8) % 256;
  const c = hueToBgr(hue);
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    pixels[i * 4] = c.b; pixels[i * 4 + 1] = c.g; pixels[i * 4 + 2] = c.r; pixels[i * 4 + 3] = 255;
  }
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(0, 2);
  header.writeUInt16LE(WIDTH, 4); header.writeUInt16LE(HEIGHT, 6);
  writeFrame(0x82, Buffer.concat([header, pixels]));
}

let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) return;
    const type = buf.readUInt8(4);
    const payload = buf.subarray(5, 4 + len);
    buf = buf.subarray(4 + len);
    handleCommand(type, payload);
  }
});

function handleCommand(type, payload) {
  if (type === 0x01) { // CONNECT
    setTimeout(() => {
      writeFrame(0x81, Buffer.from(JSON.stringify({ width: WIDTH, height: HEIGHT }), 'utf8'));
      writeFrame(0x83, Buffer.from(JSON.stringify({ state: 'connected' }), 'utf8'));
      sendSyntheticFrame();
      frameTimer = setInterval(sendSyntheticFrame, 200);
    }, 300);
  } else if (type === 0x02) { // DISCONNECT
    if (frameTimer) clearInterval(frameTimer);
    writeFrame(0x83, Buffer.from(JSON.stringify({ state: 'disconnected' }), 'utf8'));
    process.exit(0);
  }
  // MOUSE/KEY/RESIZE는 스텁에서 무시(실제 헬퍼에서만 의미 있음)
}

process.stdin.on('end', () => process.exit(0));
