const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

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

// Phase1 F-502: 프로그램 종료 시 SSH/RDP/VNC/SFTP/Web 연결을 예외 없이 강제 종료한다.
// 아직 실제 프로토콜 연결 관리자가 없어 자리만 잡아둔다 — SSH 등 연동이 들어오면 여기서 호출한다.
function terminateAllSessions() {
  // TODO(Phase1): connection-manager와 연동해 열려 있는 모든 세션을 강제 종료 (F-502)
}

ipcMain.handle('ping', () => 'pong');

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  terminateAllSessions();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
