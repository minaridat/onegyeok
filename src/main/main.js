const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const sshManager = require('./ssh-manager');

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
function terminateAllSessions() {
  sshManager.disconnectAll();
  // TODO(Phase2+): RDP/VNC/SFTP 연결 관리자가 추가되면 여기서 함께 종료한다.
}

ipcMain.handle('ping', () => 'pong');

// ---------------------------------------------------------------------------
// SSH 연결 (Phase1 F-201~213)
// 비밀번호/Passphrase는 이 IPC 호출의 인자로만 전달되고 어디에도 저장하지 않는다 (F-301/601).
// ---------------------------------------------------------------------------

ipcMain.handle('ssh:connect', async (_event, sessionId, params) => {
  try {
    await sshManager.connect(
      sessionId,
      params,
      (chunk) => { if (mainWindow) mainWindow.webContents.send('ssh:data', sessionId, chunk); },
      (status) => { if (mainWindow) mainWindow.webContents.send('ssh:status', sessionId, status); }
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, kind: err.kind };
  }
});

ipcMain.on('ssh:input', (_event, sessionId, data) => { sshManager.write(sessionId, data); });
ipcMain.on('ssh:resize', (_event, sessionId, cols, rows) => { sshManager.resize(sessionId, cols, rows); });
ipcMain.handle('ssh:disconnect', (_event, sessionId) => { sshManager.disconnect(sessionId); return { ok: true }; });

ipcMain.handle('dialog:pick-key-file', async () => {
  if (!mainWindow) return { canceled: true };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'SSH 개인키 선택',
    defaultPath: app.getPath('home') + '/.ssh',
    properties: ['openFile'],
  });
  return { canceled: result.canceled, filePath: result.filePaths[0] || null };
});

// ---------------------------------------------------------------------------
// 서버별 메모 저장 (Phase1 F-108)
// 기술스택_명세서.md 5장: 로그인 자격증명과 동일하게, 메모도 Electron safeStorage로
// OS 자격증명 저장소(macOS Keychain / Windows DPAPI 등) 기반 암호화 후 저장한다.
// 서버 목록 자체는 아직 영속화되지 않으므로(렌더러 메모리에만 존재), 메모는 서버 id를
// 키로 하는 별도 파일에 독립적으로 저장한다 — 서버 등록 데이터 영속화는 이후 과제.
// ---------------------------------------------------------------------------

function memoStorePath() {
  return path.join(app.getPath('userData'), 'memos.json');
}

async function readMemoStore() {
  try {
    const raw = await fs.readFile(memoStorePath(), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('[memo] 저장 파일을 읽지 못했습니다:', err);
    return {};
  }
}

async function writeMemoStore(store) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(memoStorePath(), JSON.stringify(store), 'utf-8');
}

ipcMain.handle('memo:load-all', async () => {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[memo] 이 환경에서는 OS 암호화를 사용할 수 없어 메모를 불러오지 않습니다.');
    return {};
  }
  const store = await readMemoStore();
  const result = {};
  for (const [serverId, encodedB64] of Object.entries(store)) {
    try {
      result[serverId] = safeStorage.decryptString(Buffer.from(encodedB64, 'base64'));
    } catch (err) {
      console.error('[memo] 복호화 실패(건너뜀):', serverId, err.message);
    }
  }
  return result;
});

ipcMain.handle('memo:save', async (_event, serverId, text) => {
  if (!serverId) return { ok: false, error: 'invalid-server-id' };
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'encryption-unavailable' };
  }
  const store = await readMemoStore();
  if (text) {
    store[serverId] = safeStorage.encryptString(text).toString('base64');
  } else {
    delete store[serverId];
  }
  await writeMemoStore(store);
  return { ok: true };
});

ipcMain.handle('memo:rename', async (_event, oldServerId, newServerId) => {
  if (!oldServerId || !newServerId || oldServerId === newServerId) return { ok: true };
  const store = await readMemoStore();
  if (Object.prototype.hasOwnProperty.call(store, oldServerId)) {
    store[newServerId] = store[oldServerId];
    delete store[oldServerId];
    await writeMemoStore(store);
  }
  return { ok: true };
});

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
