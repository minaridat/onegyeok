const { clipboard } = require('electron');
const fileClip = require('./file-clipboard');
const { registerMainProtocol } = require('../../core/protocol-registry');
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

// 클립보드 공유(텍스트) — 헬퍼의 cliprdr 채널과 로컬 클립보드를 잇는다. Electron에는 클립보드 변경 이벤트가 없어서 공유를 켠
// 세션이 있는 동안만 주기적으로 읽어 바뀌었을 때 헬퍼로 보낸다. 원격에서 받아 로컬에 쓴 텍스트는 다시 원격으로 돌려보내지 않는다.
// Windows 클립보드는 줄바꿈이 CRLF라 원격으로는 CRLF로 보내고, macOS에서는 받은 텍스트를 LF로 바꿔 쓴다.
const CLIPBOARD_POLL_MS = 700;
const clipboardSessions = new Set(); // 공유를 켠 sessionId
let clipboardTimer = null;
let lastLocalText = null;

function toRemoteText(text) { return text.replace(/\r?\n/g, '\r\n'); }

// Electron 44(macOS)의 clipboard.readText()는 Promise를 돌려주고 Windows는 문자열을 돌려줘서, 둘 다 받도록 항상 await한다.
// 클립보드에 "파일"이 있으면 파일이 우선이다(텍스트는 보내지 않고 서버에는 파일 목록만 알린다). 파일은 FileGroupDescriptorW로,
// 실제 내용은 서버가 붙여넣을 때 헬퍼가 로컬 파일을 직접 읽어 보낸다(native/rdp-helper/src/clipboard.c).
let lastFilesKey = null; // 마지막으로 서버에 알린(또는 원격에서 받아 올린) 파일 목록의 키, 파일이 없으면 null
const fileReceivers = new Map(); // sessionId -> RemoteFileReceiver

async function pollClipboard() {
  let paths = [];
  try { paths = await fileClip.readLocalFilePaths(); } catch (_e) { paths = []; }
  if (paths.length) {
    const key = paths.join('\n');
    if (key === lastFilesKey) return;
    lastFilesKey = key;
    const listing = await fileClip.buildListing(paths);
    clipboardSessions.forEach((id) => { const h = sessions.get(id); if (h) h.clipFiles(listing); });
    return;
  }
  if (lastFilesKey !== null) { // 파일 복사가 풀렸다 — 서버에 알리고 텍스트를 다시 보낸다
    lastFilesKey = null;
    lastLocalText = null;
    clipboardSessions.forEach((id) => { const h = sessions.get(id); if (h) h.clipFiles(Buffer.alloc(0)); });
  }
  let text;
  try { text = await clipboard.readText(); } catch (_e) { return; }
  if (typeof text !== 'string' || text === lastLocalText) return;
  lastLocalText = text;
  clipboardSessions.forEach((id) => { const h = sessions.get(id); if (h) h.clipboard(toRemoteText(text)); });
}

async function startClipboardSync(sessionId) {
  clipboardSessions.add(sessionId);
  if (!clipboardTimer) clipboardTimer = setInterval(() => { pollClipboard().catch(() => {}); }, CLIPBOARD_POLL_MS);
  let paths = [];
  try { paths = await fileClip.readLocalFilePaths(); } catch (_e) { paths = []; }
  const helper = sessions.get(sessionId);
  if (paths.length) {
    const listing = await fileClip.buildListing(paths);
    if (helper && clipboardSessions.has(sessionId)) helper.clipFiles(listing);
    if (lastFilesKey === null) lastFilesKey = paths.join('\n');
    return;
  }
  let text = '';
  try { text = await clipboard.readText(); } catch (_e) { /* 읽을 수 없으면 빈 클립보드로 시작 */ }
  if (typeof text !== 'string') text = '';
  if (helper && clipboardSessions.has(sessionId)) helper.clipboard(toRemoteText(text));
  if (lastLocalText === null) lastLocalText = text;
}

function stopClipboardSync(sessionId) {
  clipboardSessions.delete(sessionId);
  if (!clipboardSessions.size && clipboardTimer) { clearInterval(clipboardTimer); clipboardTimer = null; lastLocalText = null; }
}

// 원격 → 로컬 파일 복사: 헬퍼가 목록(BEGIN)·내용(CHUNK)·끝(END)을 차례로 보내 준다.
function onRemoteFiles(sessionId, type, payload) {
  if (!clipboardSessions.has(sessionId)) return;
  let receiver = fileReceivers.get(sessionId);
  if (!receiver) { receiver = new fileClip.RemoteFileReceiver((m) => console.error('[rdp] ' + m)); fileReceivers.set(sessionId, receiver); }
  try {
    if (type === MSG.REMOTE_FILES_BEGIN) receiver.begin(payload);
    else if (type === MSG.REMOTE_FILE_CHUNK) receiver.chunk(payload);
    else if (type === MSG.REMOTE_FILES_END) {
      const { paths, stale } = receiver.end(payload);
      if (stale) { lastFilesKey = null; Promise.resolve(clipboard.clear()).catch(() => {}); }
      if (!paths.length) return;
      lastFilesKey = paths.join('\n'); // 원격에서 받은 것 — 다시 원격으로 보내지 않는다
      fileClip.writeLocalFilePaths(paths);
    }
  } catch (err) { console.error('[rdp] 원격 파일 처리 실패: ' + err.message); }
}

function onRemoteClipboard(sessionId, payload) {
  if (!clipboardSessions.has(sessionId)) return;
  let text = payload.toString('utf8');
  if (process.platform !== 'win32') text = text.replace(/\r\n/g, '\n');
  lastFilesKey = null; // 텍스트를 쓰면 로컬 클립보드의 파일은 사라진다 — 파일 복사가 풀렸다고 다시 알리지 않게 미리 정리
  lastLocalText = text; // 원격에서 온 것 — 다시 보내지 않는다(쓰기가 비동기여도 다음 폴링 전에 먼저 기록해 둔다)
  try { Promise.resolve(clipboard.writeText(text)).catch(() => {}); } catch (_e) { return; }
  // 다른 RDP 세션들에도 새 로컬 클립보드로 알린다(보낸 세션 자신은 이미 갖고 있다).
  clipboardSessions.forEach((id) => { if (id !== sessionId) { const h = sessions.get(id); if (h) h.clipboard(toRemoteText(text)); } });
}

// 세션이 끝날 때 정리할 것들(캐시·흐름 제어·클립보드).
function forgetSession(sessionId) {
  const receiver = fileReceivers.get(sessionId);
  if (receiver) {
    const stale = receiver.published;
    receiver.cleanup();
    fileReceivers.delete(sessionId);
    if (stale) { lastFilesKey = null; try { Promise.resolve(clipboard.clear()).catch(() => {}); } catch (_e) { /* 무시 */ } } // 지워진 임시 파일을 가리키는 클립보드를 비운다
  }
  frameCaches.delete(sessionId);
  clearFlow(sessionId);
  stopClipboardSync(sessionId);
}

// 원격에 \\tsclient\<이름>으로 보일 공유 이름 — 폴더 이름에서 영문·숫자만 남긴다(RDP 장치 이름은 ASCII만 확실히 통한다).
function driveNameFor(drivePath) {
  const base = String(drivePath).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const ascii = base.replace(/[^A-Za-z0-9_-]/g, '');
  return ascii || 'onegyeok';
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
              if (params.clipboard) startClipboardSync(sessionId).catch(() => {});
              sendToSession(sessionId, 'rdp:status', { state: 'connected' });
            } else if (type === MSG.FRAME) {
              const frame = parseFramePayload(payload);
              updateFrameCache(sessionId, frame);
              queueFrame(sessionId, frame);
            } else if (type === MSG.CLIPBOARD_REMOTE) {
              onRemoteClipboard(sessionId, payload);
            } else if (type === MSG.REMOTE_FILES_BEGIN || type === MSG.REMOTE_FILE_CHUNK || type === MSG.REMOTE_FILES_END) {
              onRemoteFiles(sessionId, type, payload);
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
                forgetSession(sessionId);
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
          forgetSession(sessionId);
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
          forgetSession(sessionId);
          unregisterSession(sessionId);
        });

        sessions.set(sessionId, helper);
        helper.connect({
          host: params.host, port: params.port || 3389, username: params.username,
          password: params.password, domain: params.domain,
          width: params.width || 1024, height: params.height || 768,
          colorDepth: params.colorDepth || 32,
          security: params.security || 'tls',
          ignoreCertificate: params.ignoreCertificate !== false,
          clipboard: !!params.clipboard,
          drivePath: params.drivePath || undefined,
          driveName: params.drivePath ? driveNameFor(params.drivePath) : undefined,
        });
      });
    });

    ipcMain.handle('rdp:disconnect', (_event, sessionId) => {
      const helper = sessions.get(sessionId);
      if (helper) { helper.disconnect(); helper.kill(); sessions.delete(sessionId); }
      forgetSession(sessionId);
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
    forgetSession(sessionId);
  },

  disconnectAll() {
    sessions.forEach((helper) => { try { helper.disconnect(); } catch (_e) { /* noop */ } helper.kill(); });
    sessions.clear();
    frameCaches.clear();
    flows.forEach((f) => { if (f.timer) clearTimeout(f.timer); });
    flows.clear();
    clipboardSessions.forEach((id) => stopClipboardSync(id));
  },
});
