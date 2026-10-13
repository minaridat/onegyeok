const sshManager = require('../../ssh-manager');
const { registerMainProtocol } = require('../../core/protocol-registry');

let savedCtx = null; // wire(ctx)가 저장해둔다 — onSessionWindowChanged는 wire() 밖이라 클로저로 못 받음

// SSH 연결 (Phase1 F-201~213)
// 비밀번호/Passphrase는 이 IPC 호출의 인자로만 전달되고 어디에도 저장하지 않는다 (F-301/601).
registerMainProtocol('ssh', {
  wire(ctx) {
    savedCtx = ctx;
    const { ipcMain, sendToSession, registerSessionWindow, unregisterSession, windowForEvent } = ctx;

    ipcMain.handle('ssh:connect', async (event, sessionId, params) => {
      // 연결 과정(프롬프트 단계 포함) 중에 오는 data/status 이벤트도 맞는 창으로 가야 하므로,
      // 실제 접속이 성사되기 전에 미리 등록한다.
      registerSessionWindow(sessionId, windowForEvent(event), 'ssh');
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

  // 탭이 다른 창으로 옮겨질 때(Stage B, window-manager.js) 마지막 상태를 즉시 재전송 — 그래야
  // 새 창이 다음 자연스러운 상태 변화가 올 때까지 기다리지 않고 바로 handleInput이 제대로 꽂힌다
  // (렌더러 ssh.js의 onStatus 리스너가 'connected' 수신 시 handleInput을 실제 전송 함수로 바꾼다).
  onSessionWindowChanged(sessionId, newWin) {
    if (savedCtx) savedCtx.replayLastSend(sessionId, 'ssh:status', newWin);
  },

  disconnectSession(sessionId) {
    sshManager.disconnect(sessionId);
  },

  disconnectAll() {
    sshManager.disconnectAll();
  },
});
