const sshManager = require('../../ssh-manager');
const { registerMainProtocol } = require('../../core/protocol-registry');

// SSH 연결 (Phase1 F-201~213)
// 비밀번호/Passphrase는 이 IPC 호출의 인자로만 전달되고 어디에도 저장하지 않는다 (F-301/601).
registerMainProtocol('ssh', {
  wire(ctx) {
    const { ipcMain, getMainWindow } = ctx;

    ipcMain.handle('ssh:connect', async (_event, sessionId, params) => {
      try {
        await sshManager.connect(
          sessionId,
          params,
          (chunk) => { const win = getMainWindow(); if (win) win.webContents.send('ssh:data', sessionId, chunk); },
          (status) => { const win = getMainWindow(); if (win) win.webContents.send('ssh:status', sessionId, status); }
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message, kind: err.kind };
      }
    });

    ipcMain.on('ssh:input', (_event, sessionId, data) => { sshManager.write(sessionId, data); });
    ipcMain.on('ssh:resize', (_event, sessionId, cols, rows) => { sshManager.resize(sessionId, cols, rows); });
    ipcMain.handle('ssh:disconnect', (_event, sessionId) => { sshManager.disconnect(sessionId); return { ok: true }; });
  },
  disconnectAll() {
    sshManager.disconnectAll();
  },
});
