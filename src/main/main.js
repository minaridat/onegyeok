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

ipcMain.handle('window:isPointInAnotherWindow', (event, screenX, screenY) => {
  const self = ctx.windowForEvent(event);
  const hit = BrowserWindow.getAllWindows().find((win) => {
    if (win === self || win.isDestroyed()) return false;
    const b = win.getBounds();
    return screenX >= b.x && screenX <= b.x + b.width && screenY >= b.y && screenY <= b.y + b.height;
  });
  return hit ? hit.id : null;
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
