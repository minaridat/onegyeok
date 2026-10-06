const dbManager = require('../../db-manager');
const { registerMainProtocol } = require('../../core/protocol-registry');

// SQL DB 클라이언트 연결 (디비버 느낌의 "SQL" 연결 종류)
// 비밀번호는 이 IPC 호출의 인자로만 전달되고 어디에도 저장하지 않는다 (F-301/601과 동일 원칙).
registerMainProtocol('sql', {
  wire(ctx) {
    const { ipcMain, sendToSession, registerSessionWindow, unregisterSession, windowForEvent } = ctx;

    ipcMain.handle('db:connect', async (event, sessionId, params) => {
      registerSessionWindow(sessionId, windowForEvent(event));
      try {
        await dbManager.connect(sessionId, params, (status) => {
          sendToSession(sessionId, 'db:status', status);
          if (status.state === 'disconnected' || status.state === 'error') unregisterSession(sessionId);
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message, kind: err.kind };
      }
    });

    ipcMain.handle('db:query', async (_event, sessionId, sql) => {
      try {
        const result = await dbManager.query(sessionId, sql);
        return Object.assign({ ok: true }, result);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('db:disconnect', async (_event, sessionId) => {
      await dbManager.disconnect(sessionId);
      unregisterSession(sessionId);
      return { ok: true };
    });
  },
  disconnectAll() {
    dbManager.disconnectAll();
  },
});
