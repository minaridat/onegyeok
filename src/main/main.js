const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const { wireAll, disconnectAllProtocols } = require('./core/protocol-registry');
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
