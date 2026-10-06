const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const { wireAll, disconnectAllProtocols } = require('./core/protocol-registry');
const windowRegistry = require('./core/window-registry');
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

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'onegyeok',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // Web 콘솔 내장 웹뷰 — 부착 검증은 protocols/web/index.js의 will-attach-webview
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (!app.isPackaged) {
    // 개발 중에는 렌더러 콘솔 로그를 터미널로도 포워딩해 디버깅을 돕는다.
    mainWindow.webContents.on('console-message', (event) => {
      console.log('[renderer]', event.message);
    });
  }
}

const ctx = {
  ipcMain,
  app,
  safeStorage,
  getMainWindow: () => mainWindow,
  // 아래 세 개는 세션(탭)을 지금 표시하고 있는 창으로 이벤트를 라우팅하기 위한 것 —
  // src/main/core/window-registry.js 참고. 지금은 창이 하나뿐이라 getMainWindow()로 매번
  // 폴백해도 결과가 같지만, 나중에 탭을 별도 창으로 분리하는 기능이 들어오면 sendToSession이
  // 유일하게 맞는 전송 경로가 된다 — 프로토콜 쪽 코드는 지금부터 이걸로 통일해둔다.
  registerSessionWindow: windowRegistry.registerSessionWindow,
  unregisterSession: windowRegistry.unregisterSession,
  windowForEvent: (event) => BrowserWindow.fromWebContents(event.sender),
  sendToSession: (sessionId, channel, ...args) => {
    const win = windowRegistry.getSessionWindow(sessionId) || mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, sessionId, ...args);
  },
};

ipcMain.handle('ping', () => 'pong');

wireAll(ctx);
dialogCore.wire(ctx);
memoStore.wire(ctx);

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Phase1 F-502: 프로그램 종료 시 SSH/SQL/RDP/VNC/SFTP/Web 연결을 예외 없이 강제 종료한다.
app.on('before-quit', () => {
  disconnectAllProtocols();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
