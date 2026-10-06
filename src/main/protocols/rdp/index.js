const rdpManager = require('../../rdp-manager');
const { registerMainProtocol } = require('../../core/protocol-registry');

// RDP 연결 (Apache Guacamole 기반 — docs/기술스택/03_RDP_기술스택.md)
// 이 핸들러는 로컬 WebSocket 주소 + 1회용 암호화 토큰만 돌려준다. 실제 화면 스트림은
// 렌더러가 그 주소로 직접 WebSocket을 열어 받는다(IPC로 중계하지 않음).
registerMainProtocol('rdp', {
  wire(ctx) {
    const { ipcMain } = ctx;

    ipcMain.handle('rdp:connect', async (_event, sessionId, params) => {
      try {
        const result = await rdpManager.connect(sessionId, params);
        return { ok: true, wsBaseUrl: result.wsBaseUrl, token: result.token };
      } catch (err) {
        return { ok: false, error: err.message, kind: err.kind };
      }
    });

    ipcMain.handle('rdp:disconnect', (_event, sessionId) => {
      rdpManager.disconnect(sessionId);
      return { ok: true };
    });
  },
  disconnectAll() {
    rdpManager.disconnectAll();
  },
});
