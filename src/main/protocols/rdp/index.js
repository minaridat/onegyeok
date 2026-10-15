const { registerMainProtocol } = require('../../core/protocol-registry');
const fs = require('node:fs');
const { clipboard } = require('electron');
const { MSG, spawnHelper, parseFramePayload } = require('./helper-bridge');

// RDP 연결 — libfreerdp를 직접 링크한 네이티브 헬퍼 프로세스(native/rdp-helper) 기반.
// docs/기술스택/03_RDP_기술스택.md 참고. guacd/guacamole-lite 경유 구현(rdp-manager.js)은 폐기됨 —
// git 히스토리에 남아 있다.
//
// 세션(탭)마다 헬퍼 프로세스를 1개 띄우고, 비밀번호는 커맨드라인 인자가 아니라 spawn 이후
// stdin으로 보내는 CONNECT 프레임으로만 전달한다(F-601 — 프로세스 목록 노출 방지).
const CONNECT_TIMEOUT_MS = 15000;

const sessions = new Map(); // sessionId -> helper(spawnHelper 반환값)
let savedCtx = null; // wire(ctx)가 저장해둔다 — onSessionWindowChanged는 wire() 밖이라 클로저로 못 받음
// 세션별 "지금까지 합성된 전체 화면" 캐시 — FRAME 이벤트는 변경된 사각형만 보내는 증분
// 업데이트라, 탭이 다른 창으로 옮겨질 때(Stage B) 그 사각형 하나만 재전송하면 화면 대부분이
// 비어 보인다. 매 FRAME마다 이 버퍼의 해당 영역을 덮어써두고, 창 이동 시 전체를 한 번에
// 보내 새 창이 바로 완전한 화면을 보게 한다.
// 클립보드 공유 상태 — 원격→로컬로 방금 쓴 텍스트와 로컬→원격으로 마지막에 알린 텍스트를 기억해, 같은 내용을 서로 되돌려
// 보내는 반복(핑퐁)을 막는다. 클립보드 공유를 끈 세션(enabled=false)은 어느 방향으로도 전송하지 않는다.
const clipStates = new Map(); // sessionId -> { enabled, last }
const MAX_CLIP_CHARS = 1024 * 1024; // 한 번에 주고받는 텍스트 상한(1M자)
const frameCaches = new Map(); // sessionId -> { width, height, buffer(BGRA32) }

function updateFrameCache(sessionId, frame) {
  let cache = frameCaches.get(sessionId);
  if (!cache || frame.x + frame.w > cache.width || frame.y + frame.h > cache.height) {
    // 처음 받거나(헬퍼가 보통 첫 프레임은 풀프레임) 캐시보다 큰 영역이 오면 캐시 자체를 새로 키운다.
    const width = Math.max(cache ? cache.width : 0, frame.x + frame.w);
    const height = Math.max(cache ? cache.height : 0, frame.y + frame.h);
    const buffer = Buffer.alloc(width * height * 4);
    if (cache) cache.buffer.copy(buffer); // 기존 내용 보존(새로 커진 영역만 비어 있음)
    cache = { width, height, buffer };
    frameCaches.set(sessionId, cache);
  }
  for (let row = 0; row < frame.h; row++) {
    const srcStart = row * frame.w * 4;
    const dstStart = ((frame.y + row) * cache.width + frame.x) * 4;
    frame.pixels.copy(cache.buffer, dstStart, srcStart, srcStart + frame.w * 4);
  }
}

// 렌더러로 보내는 화면 흐름 제어 — 렌더러가 그리는 속도보다 헬퍼가 빨리 보내면(창·폴더를 끌 때처럼 넓은 영역이 계속
// 바뀔 때) IPC 큐에 프레임이 쌓여 화면이 입력보다 점점 늦어진다. 그래서 렌더러에는 한 번에 한 프레임만 보내고(다 그리면
// rdp:frame-ack), 그 사이에 온 FRAME은 위 캐시에 합성만 해 두었다가 바뀐 영역을 합친 사각형 하나로 다음에 보낸다.
// ack가 오지 않아도(창이 닫히는 중 등) ACK_TIMEOUT_MS 뒤에는 다시 보낸다.
const ACK_TIMEOUT_MS = 250;
const flows = new Map(); // sessionId -> { inFlight, timer, dirty: {x0,y0,x1,y1}|null }

function flowOf(sessionId) {
  let f = flows.get(sessionId);
  if (!f) { f = { inFlight: false, timer: null, dirty: null }; flows.set(sessionId, f); }
  return f;
}

function clearFlow(sessionId) {
  const f = flows.get(sessionId);
  if (f && f.timer) clearTimeout(f.timer);
  flows.delete(sessionId);
}

function markInFlight(sessionId, f) {
  f.inFlight = true;
  if (f.timer) clearTimeout(f.timer);
  f.timer = setTimeout(() => { f.timer = null; f.inFlight = false; pumpFrame(sessionId); }, ACK_TIMEOUT_MS);
}

// 쌓인 변경 영역을 캐시에서 잘라 한 번에 보낸다.
function pumpFrame(sessionId) {
  const f = flows.get(sessionId);
  if (!f || f.inFlight || !f.dirty || !savedCtx) return;
  const cache = frameCaches.get(sessionId);
  const d = f.dirty;
  f.dirty = null;
  if (!cache) return;
  const x0 = Math.max(0, d.x0), y0 = Math.max(0, d.y0);
  const x1 = Math.min(cache.width, d.x1), y1 = Math.min(cache.height, d.y1);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const pixels = Buffer.allocUnsafe(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y0 + row) * cache.width + x0) * 4;
    cache.buffer.copy(pixels, row * w * 4, srcStart, srcStart + w * 4);
  }
  markInFlight(sessionId, f);
  savedCtx.sendToSession(sessionId, 'rdp:frame', { x: x0, y: y0, w, h }, pixels);
}

function queueFrame(sessionId, frame) {
  const f = flowOf(sessionId);
  if (!f.inFlight && !f.dirty) {
    // 렌더러가 놀고 있으면 받은 프레임을 그대로 보낸다(추가 복사 없음).
    markInFlight(sessionId, f);
    savedCtx.sendToSession(sessionId, 'rdp:frame', { x: frame.x, y: frame.y, w: frame.w, h: frame.h }, frame.pixels);
    return;
  }
  const x1 = frame.x + frame.w, y1 = frame.y + frame.h;
  if (!f.dirty) f.dirty = { x0: frame.x, y0: frame.y, x1, y1 };
  else {
    f.dirty.x0 = Math.min(f.dirty.x0, frame.x); f.dirty.y0 = Math.min(f.dirty.y0, frame.y);
    f.dirty.x1 = Math.max(f.dirty.x1, x1); f.dirty.y1 = Math.max(f.dirty.y1, y1);
  }
  pumpFrame(sessionId);
}

// 로컬 클립보드 텍스트가 마지막으로 알린 것과 다르면 헬퍼에 알린다(원격이 붙여넣을 때 이 텍스트를 가져간다).
async function syncLocalClipboard(sessionId) {
  const st = clipStates.get(sessionId);
  const helper = sessions.get(sessionId);
  if (!st || !st.enabled || !helper) return;
  let text = '';
  try { text = await clipboard.readText(); } catch (_e) { return; }
  if (typeof text !== 'string') return;
  if (!sessions.get(sessionId) || st !== clipStates.get(sessionId)) return; // 읽는 사이 세션이 끝났을 수 있다
  if (text.length > MAX_CLIP_CHARS) text = text.slice(0, MAX_CLIP_CHARS);
  if (text === st.last) return;
  st.last = text;
  helper.clipSet(text);
}

registerMainProtocol('rdp', {
  wire(ctx) {
    savedCtx = ctx;
    const { ipcMain, sendToSession, registerSessionWindow, unregisterSession, windowForEvent } = ctx;

    ipcMain.handle('rdp:connect', (event, sessionId, params) => {
      registerSessionWindow(sessionId, windowForEvent(event), 'rdp');
      return new Promise((resolve) => {
        if (sessions.has(sessionId)) sessions.get(sessionId).kill();

        let settled = false;
        const timeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          helper.kill();
          sessions.delete(sessionId);
          resolve({ ok: false, error: '연결 시간이 초과되었습니다', kind: 'network' });
        }, CONNECT_TIMEOUT_MS);

        const helper = spawnHelper(
          (type, payload) => {
            if (type === MSG.CONNECTED) {
              let info = {};
              try { info = JSON.parse(payload.toString('utf8')); } catch (_e) { /* 치수 없이도 진행 가능 */ }
              if (!settled) {
                settled = true;
                clearTimeout(timeoutTimer);
                resolve({ ok: true, width: info.width, height: info.height });
              }
              sendToSession(sessionId, 'rdp:status', { state: 'connected' });
              syncLocalClipboard(sessionId).catch(() => {});
            } else if (type === MSG.CLIP_DATA) {
              const st = clipStates.get(sessionId);
              if (st && st.enabled) {
                const text = payload.toString('utf8');
                if (text && text.length <= MAX_CLIP_CHARS) { st.last = text; Promise.resolve(clipboard.writeText(text)).catch(() => {}); }
              }
            } else if (type === MSG.FRAME) {
              const frame = parseFramePayload(payload);
              updateFrameCache(sessionId, frame);
              queueFrame(sessionId, frame);
            } else if (type === MSG.DESKTOP_RESIZED) {
              let size = null;
              try { size = JSON.parse(payload.toString('utf8')); } catch (_e) { /* 무시 */ }
              if (size && size.width > 0 && size.height > 0) {
                // 해상도가 바뀌면 합성 화면 캐시도 새 크기로 비운다(이후 첫 FRAME이 전체 화면으로 다시 채움).
                frameCaches.set(sessionId, { width: size.width, height: size.height, buffer: Buffer.alloc(size.width * size.height * 4) });
                sendToSession(sessionId, 'rdp:resized', { width: size.width, height: size.height });
              }
            } else if (type === MSG.STATUS) {
              let status;
              try { status = JSON.parse(payload.toString('utf8')); } catch (_e) { status = { state: 'error', message: '상태 메시지 파싱 실패' }; }
              if (!settled && status.state === 'error') {
                settled = true;
                clearTimeout(timeoutTimer);
                sessions.delete(sessionId);
                resolve({ ok: false, error: status.message || '연결 실패', kind: 'other' });
              }
              sendToSession(sessionId, 'rdp:status', status);
              if (status.state === 'disconnected' || status.state === 'error') {
                sessions.delete(sessionId);
                frameCaches.delete(sessionId);
    clipStates.delete(sessionId);
                clearFlow(sessionId);
                unregisterSession(sessionId);
              }
            }
          },
          (logLine) => { console.log('[rdp-helper][' + sessionId + ']', logLine.trimEnd()); }
        );

        helper.child.on('exit', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutTimer);
            resolve({ ok: false, error: 'RDP 헬퍼 프로세스가 비정상 종료되었습니다', kind: 'other' });
          }
          sessions.delete(sessionId);
          frameCaches.delete(sessionId);
    clipStates.delete(sessionId);
          clearFlow(sessionId);
          unregisterSession(sessionId);
        });
        helper.child.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutTimer);
            // ENOENT는 거의 항상 "네이티브 헬퍼 바이너리를 이 워크트리/체크아웃에서 아직 빌드 안 함"이다
            // (onegyeok-rdp-helper는 .gitignore 대상이라 git에 안 들어있다 — 워크트리마다 한 번 빌드해야 함).
            const hint = err.code === 'ENOENT' ? ' (native/rdp-helper 바이너리가 없음 — `npm run build:native` 실행 필요)' : '';
            resolve({ ok: false, error: 'RDP 헬퍼 프로세스를 시작할 수 없습니다: ' + err.message + hint, kind: 'other' });
          }
          sessions.delete(sessionId);
          frameCaches.delete(sessionId);
    clipStates.delete(sessionId);
          clearFlow(sessionId);
          unregisterSession(sessionId);
        });

        sessions.set(sessionId, helper);
        const clipEnabled = params.clipboard !== false;
        clipStates.set(sessionId, { enabled: clipEnabled, last: null });
        // 로컬 폴더 마운트 — 렌더러가 넘긴 경로가 실제 폴더일 때만 헬퍼에 전달한다(이름은 영숫자·한글·-_ 등으로 정리).
        let driveName, drivePath;
        if (params.drivePath && typeof params.drivePath === 'string') {
          try { if (fs.statSync(params.drivePath).isDirectory()) drivePath = params.drivePath; } catch (_e) { /* 없는 경로면 마운트 생략 */ }
          if (drivePath) driveName = String(params.driveName || 'onegyeok').replace(/[^\p{L}\p{N}_\- ]/gu, '').trim().slice(0, 32) || 'onegyeok';
        }
        helper.connect({
          host: params.host, port: params.port || 3389, username: params.username,
          password: params.password, domain: params.domain,
          width: params.width || 1024, height: params.height || 768,
          colorDepth: params.colorDepth || 32,
          security: params.security || 'tls',
          ignoreCertificate: params.ignoreCertificate !== false,
          clipboard: clipEnabled, driveName, drivePath,
        });
      });
    });

    ipcMain.handle('rdp:disconnect', (_event, sessionId) => {
      const helper = sessions.get(sessionId);
      if (helper) { helper.disconnect(); helper.kill(); sessions.delete(sessionId); }
      frameCaches.delete(sessionId);
    clipStates.delete(sessionId);
      clearFlow(sessionId);
      unregisterSession(sessionId);
      return { ok: true };
    });

    ipcMain.on('rdp:frame-ack', (_event, sessionId) => {
      const f = flows.get(sessionId);
      if (!f) return;
      if (f.timer) { clearTimeout(f.timer); f.timer = null; }
      f.inFlight = false;
      pumpFrame(sessionId);
    });
    ipcMain.on('rdp:clip-sync', (_event, sessionId) => { syncLocalClipboard(sessionId).catch(() => {}); });
    ipcMain.on('rdp:mouse', (_event, sessionId, x, y, flags) => {
      const helper = sessions.get(sessionId);
      if (helper) helper.mouse(x, y, flags);
    });
    ipcMain.on('rdp:key', (_event, sessionId, scancode, flags) => {
      const helper = sessions.get(sessionId);
      if (helper) helper.key(scancode, flags);
    });
    ipcMain.on('rdp:resize', (_event, sessionId, width, height) => {
      const helper = sessions.get(sessionId);
      if (helper) helper.resize(width, height);
    });
  },

  // 탭이 다른 창으로 옮겨질 때(Stage B, window-manager.js) 호출된다 — 그 창이 받을 다음 자연스러운
  // FRAME 이벤트까지 기다리게 하지 않고, 지금까지 합성된 화면 전체를 한 번에 재전송한다.
  onSessionWindowChanged(sessionId, newWin) {
    const cache = frameCaches.get(sessionId);
    if (cache) {
      const f = flowOf(sessionId);
      f.dirty = null; // 전체 화면을 보내므로 쌓인 영역은 필요 없다
      markInFlight(sessionId, f);
      newWin.webContents.send('rdp:frame', sessionId, { x: 0, y: 0, w: cache.width, h: cache.height }, cache.buffer);
    }
    if (savedCtx) savedCtx.replayLastSend(sessionId, 'rdp:status', newWin);
  },

  disconnectSession(sessionId) {
    const helper = sessions.get(sessionId);
    if (helper) { try { helper.disconnect(); } catch (_e) { /* noop */ } helper.kill(); sessions.delete(sessionId); }
    frameCaches.delete(sessionId);
    clipStates.delete(sessionId);
    clearFlow(sessionId);
  },

  disconnectAll() {
    sessions.forEach((helper) => { try { helper.disconnect(); } catch (_e) { /* noop */ } helper.kill(); });
    sessions.clear();
    frameCaches.clear();
    clipStates.clear();
    flows.forEach((f) => { if (f.timer) clearTimeout(f.timer); });
    flows.clear();
  },
});
