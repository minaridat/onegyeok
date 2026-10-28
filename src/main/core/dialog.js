const { app, dialog } = require('electron');

// SSH 개인키 선택 등 OS 파일 다이얼로그 — 특정 프로토콜 소유가 아니라 공용이므로 레지스트리를
// 쓰지 않고 main.js가 직접 한 번 wire()한다.
function wire(ctx) {
  const { ipcMain, getMainWindow } = ctx;

  ipcMain.handle('dialog:pick-key-file', async () => {
    const win = getMainWindow();
    if (!win) return { canceled: true };
    const result = await dialog.showOpenDialog(win, {
      title: 'SSH 개인키 선택',
      defaultPath: app.getPath('home') + '/.ssh',
      properties: ['openFile'],
    });
    return { canceled: result.canceled, filePath: result.filePaths[0] || null };
  });

  // RDP 로컬 폴더 공유 대상 선택
  ipcMain.handle('dialog:pick-folder', async (_event, opts) => {
    const win = getMainWindow();
    if (!win) return { canceled: true };
    const o = opts && typeof opts === 'object' ? opts : {};
    const result = await dialog.showOpenDialog(win, {
      title: typeof o.title === 'string' ? o.title : '공유할 폴더 선택',
      defaultPath: typeof o.defaultPath === 'string' && o.defaultPath ? o.defaultPath : undefined,
      properties: ['openDirectory'],
    });
    return { canceled: result.canceled, folderPath: result.filePaths[0] || null };
  });
}

module.exports = { wire };
