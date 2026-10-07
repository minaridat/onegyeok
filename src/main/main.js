const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { wireAll, disconnectAllProtocols } = require('./core/protocol-registry');
const windowRegistry = require('./core/window-registry');
const windowManager = require('./core/window-manager');
const dialogCore = require('./core/dialog');
const memoStore = require('./core/memo-store');

// require()하는 것만으로 각 프로토콜 모듈의 registerMainProtocol(...) 등록이 실행된다
// (이 require 목록이 곧 "현재 지원하는 연결 종류" 목록이다 — 새 프로토콜은 이 한 줄만 추가).
require('./protocols/ssh');
require('./protocols/sql');
require('./protocols/rdp');
require('./protocols/vnc');
require('./protocols/sftp');
require('./protocols/web');

let mainWindow = null; // 앱의 첫 창(= 일반 종료 로직이 기준으로 삼는 "주 창")
let isQuitting = false; // before-quit 경로와 window-manager의 "보조 창 닫힘" 세션 정리가 겹치지 않게 함

const ctx = {
  ipcMain,
  app,
  safeStorage,
  isQuitting: () => isQuitting,
  getMainWindow: () => mainWindow,
  // 아래는 세션(탭)을 지금 표시하고 있는 창으로 이벤트를 라우팅하기 위한 것 —
  // src/main/core/window-registry.js 참고. 탭을 별도 창으로 분리/병합하는 기능(Stage B)부터
  // sendToSession이 유일하게 맞는 전송 경로다 — 프로토콜 쪽 코드는 전부 이걸로 통일돼 있다.
  registerSessionWindow: windowRegistry.registerSessionWindow,
  unregisterSession: windowRegistry.unregisterSession,
  windowForEvent: (event) => BrowserWindow.fromWebContents(event.sender),
  sendToSession: (sessionId, channel, ...args) => {
    windowRegistry.rememberLastSend(sessionId, channel, args);
    const win = windowRegistry.getSessionWindow(sessionId) || mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, sessionId, ...args);
  },
  replayLastSend: (sessionId, channel, targetWin) => windowRegistry.replayLastSend(sessionId, channel, targetWin),
};

ipcMain.handle('ping', () => 'pong');

wireAll(ctx);
dialogCore.wire(ctx);
memoStore.wire(ctx);

// ---------------------------------------------------------------------------
// 탭 분리/병합(Stage B) — src/main/core/window-manager.js가 실제 로직을 들고 있고,
// 여기서는 IPC 핸들러만 얇게 연결한다.
// ---------------------------------------------------------------------------

ipcMain.handle('window:getInitialState', (event) => {
  const win = ctx.windowForEvent(event);
  const tabs = windowManager.getInitialTabsFor(event.sender.id);
  // 세션의 프레임/상태 재전송(replay)은 반드시 이 시점에 해야 한다 — 창 생성 직후(아직 페이지/
  // 스크립트가 로드되기 전)에 보내면 렌더러의 onFrame/onStatus 리스너가 아직 없어 유실된다.
  // 렌더러가 getInitialState를 호출하는 시점(core/bootstrap.js)은 모든 프로토콜 스크립트(=
  // 리스너 등록)가 이미 로드된 뒤이므로, 여기서 재전송하면 유실 없이 전달된다.
  if (tabs) tabs.forEach((tab) => windowManager.moveSessionToWindow(tab.tabId, tab.protocol, win));
  return tabs;
});

ipcMain.handle('window:detachTab', (event, payload) => {
  const sourceWin = ctx.windowForEvent(event);
  windowManager.createAppWindow(ctx, [payload]);
  if (sourceWin && !sourceWin.isDestroyed()) {
    sourceWin.webContents.send('window:tabDetached', payload.tabId);
  }
  return { ok: true };
});

ipcMain.handle('window:mergeTab', (event, payload) => {
  const sourceWin = ctx.windowForEvent(event);
  const targetWin = BrowserWindow.fromId(payload.targetWindowId);
  if (!targetWin || targetWin.isDestroyed()) return { ok: false, error: '대상 창을 찾을 수 없습니다' };
  windowManager.moveSessionToWindow(payload.tabId, payload.protocol, targetWin);
  targetWin.webContents.send('window:tabAttached', payload);
  if (sourceWin && !sourceWin.isDestroyed()) {
    sourceWin.webContents.send('window:tabDetached', payload.tabId);
  }
  return { ok: true };
});

// excludeWindowId: 실시간 드래그 중인 창 자기 자신(커서가 바로 그 창 위에 있으니 항상 "병합
// 대상"으로 잡혀버린다) — 예전에는 "호출한 창(event.sender)"을 자동으로 제외했는데, 실시간
// 드래그에서는 원래 창(소스)도 다시 유효한 병합 대상이어야 해서(탭을 뺐다가 제자리로 돌아오면
// 다시 합쳐지는 크롬 동작) 호출자 기준 제외를 버리고 명시적 제외 id로 바꿨다.
ipcMain.handle('window:isPointInAnotherWindow', (_event, screenX, screenY, excludeWindowId) => {
  const hit = BrowserWindow.getAllWindows().find((win) => {
    if (win.isDestroyed()) return false;
    if (excludeWindowId != null && win.id === excludeWindowId) return false;
    const b = win.getBounds();
    return screenX >= b.x && screenX <= b.x + b.width && screenY >= b.y && screenY <= b.y + b.height;
  });
  return hit ? hit.id : null;
});

// ---------------------------------------------------------------------------
// 실시간 탭 드래그(크롬처럼 커서를 따라다니는 창) — 탭바 밖으로 나가는 순간 바로 진짜 창을
// 만들고, 드래그하는 동안 그 창을 커서 위치로 계속 옮긴다. 손을 뗄 때 다른 창 위였으면 그
// 창에 세션을 합치고(병합) 방금 만든 드래그용 창은 닫는다 — 아니면 그 자리에 그대로 둔다.
// dragWindows: 드래그로 막 만든 창(아직 "병합될 수도, 그대로 남을 수도" 결정 전)의 원본
// payload(tabId/serverId/protocol/server/handoff) — 병합 시 대상 창에 그대로 재사용한다.
// ---------------------------------------------------------------------------
const dragWindows = new Map(); // BrowserWindow.id -> payload

ipcMain.handle('window:beginTearOffDrag', (event, payload) => {
  const sourceWin = ctx.windowForEvent(event);
  const win = windowManager.createAppWindow(ctx, [payload], { x: payload.initialX, y: payload.initialY });
  dragWindows.set(win.id, payload);
  win.once('closed', () => { dragWindows.delete(win.id); });
  if (sourceWin && !sourceWin.isDestroyed()) {
    sourceWin.webContents.send('window:tabDetached', payload.tabId);
  }
  return { ok: true, windowId: win.id };
});

// 고빈도 호출(마우스무브마다) — 응답이 필요 없으므로 handle이 아니라 on(fire-and-forget).
// 실제 이동은 window-manager.js의 updatePositionTarget()이 한다 — 거기 달린 'move' 자가
// 치유 리스너 주석 참고(멀티 모니터 환경에서 loadFile 로딩 중 창이 제멋대로 다른 모니터로
// 옮겨가는 걸 실측으로 확인해서 생긴 방어 로직).
ipcMain.on('window:dragMoveWindow', (_event, windowId, x, y) => {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  windowManager.updatePositionTarget(win, x, y);
});

ipcMain.handle('window:completeTearOffDrag', (_event, windowId, mergeTargetId) => {
  const win = BrowserWindow.fromId(windowId);
  const payload = dragWindows.get(windowId);
  dragWindows.delete(windowId);
  if (!win || win.isDestroyed() || !payload) return { ok: true };
  // 드래그가 끝났으니 'move' 자가 치유 추적은 반드시 뗀다 — 안 그러면 병합 안 되고 남는
  // 경우(else 분기) 사용자가 타이틀바로 직접 창을 옮기려 할 때마다 제자리로 되돌려버린다.
  windowManager.stopPositionTracking(win);
  if (mergeTargetId != null) {
    const targetWin = BrowserWindow.fromId(mergeTargetId);
    if (targetWin && !targetWin.isDestroyed() && targetWin !== win) {
      windowManager.moveSessionToWindow(payload.tabId, payload.protocol, targetWin);
      targetWin.webContents.send('window:tabAttached', payload);
      win.close(); // 세션을 옮겼으니 드래그용으로 떠 있던 이 창은 빈 채로 남는다 — 닫는다
    }
  }
  else {
    // 병합 안 되고 그대로 남는 경우 — 드래그 중엔 포커스를 안 뺏도록 showInactive()로
    // 띄워뒀으니(window-manager.js 참고), 드래그가 끝난 지금은 정상적인 새 창으로 포커스를 준다.
    win.focus();
  }
  return { ok: true };
});

app.whenReady().then(() => {
  mainWindow = windowManager.createAppWindow(ctx, null);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = windowManager.createAppWindow(ctx, null);
  });
});

// Phase1 F-502: 프로그램 종료 시 SSH/SQL/RDP/VNC/SFTP/Web 연결을 예외 없이 강제 종료한다.
app.on('before-quit', () => {
  isQuitting = true;
  disconnectAllProtocols();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
