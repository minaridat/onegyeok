const sshManager = require('../../ssh-manager');
const { registerMainProtocol } = require('../../core/protocol-registry');

// SSH 연결 (Phase1 F-201~213)
// 비밀번호/Passphrase는 이 IPC 호출의 인자로만 전달되고 어디에도 저장하지 않는다 (F-301/601).
registerMainProtocol('ssh', {
  wire(ctx) {
    const { ipcMain, sendToSession, registerSessionWindow, unregisterSession, windowForEvent } = ctx;

    ipcMain.handle('ssh:connect', async (event, sessionId, params) => {
      // 연결 과정(프롬프트 단계 포함) 중에 오는 data/status 이벤트도 맞는 창으로 가야 하므로,
      // 실제 접속이 성사되기 전에 미리 등록한다.
      registerSessionWindow(sessionId, windowForEvent(event));
      try {
        await sshManager.connect(
          sessionId,
          params,
          (chunk) => { sendToSession(sessionId, 'ssh:data', chunk); },
          (status) => {
            sendToSession(sessionId, 'ssh:status', status);
            if (status.state === 'disconnected' || status.state === 'error') unregisterSession(sessionId);
          }
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message, kind: err.kind };
      }
    });

    ipcMain.on('ssh:input', (_event, sessionId, data) => { sshManager.write(sessionId, data); });
    ipcMain.on('ssh:resize', (_event, sessionId, cols, rows) => { sshManager.resize(sessionId, cols, rows); });
    ipcMain.handle('ssh:disconnect', (_event, sessionId) => { sshManager.disconnect(sessionId); unregisterSession(sessionId); return { ok: true }; });
  },
  disconnectAll() {
    sshManager.disconnectAll();
  },
});
