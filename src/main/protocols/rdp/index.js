const { registerMainProtocol } = require('../../core/protocol-registry');
const { MSG, spawnHelper, parseFramePayload } = require('./helper-bridge');

// RDP 연결 — libfreerdp를 직접 링크한 네이티브 헬퍼 프로세스(native/rdp-helper) 기반.
// docs/기술스택/03_RDP_기술스택.md 참고. guacd/guacamole-lite 경유 구현(rdp-manager.js)은 폐기됨 —
// git 히스토리에 남아 있다.
//
// 세션(탭)마다 헬퍼 프로세스를 1개 띄우고, 비밀번호는 커맨드라인 인자가 아니라 spawn 이후
// stdin으로 보내는 CONNECT 프레임으로만 전달한다(F-601 — 프로세스 목록 노출 방지).
const CONNECT_TIMEOUT_MS = 15000;

const sessions = new Map(); // sessionId -> helper(spawnHelper 반환값)

registerMainProtocol('rdp', {
  wire(ctx) {
    const { ipcMain, sendToSession, registerSessionWindow, unregisterSession, windowForEvent } = ctx;

    ipcMain.handle('rdp:connect', (event, sessionId, params) => {
      registerSessionWindow(sessionId, windowForEvent(event));
      return new Promise((resolve) => {
        if (sessions.has(sessionId)) sessions.get(sessionId).kill();

        let settled = false;
        const timeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          helper.kill();
          sessions.delete(sessionId);
          resolve({ ok: false, error: '연결 시간이 초과되었습니다', kind: 'network' });
        }, CONNECT_TIMEOUT_MS);

        const helper = spawnHelper(
          (type, payload) => {
            if (type === MSG.CONNECTED) {
              let info = {};
              try { info = JSON.parse(payload.toString('utf8')); } catch (_e) { /* 치수 없이도 진행 가능 */ }
              if (!settled) {
                settled = true;
                clearTimeout(timeoutTimer);
                resolve({ ok: true, width: info.width, height: info.height });
              }
              sendToSession(sessionId, 'rdp:status', { state: 'connected' });
            } else if (type === MSG.FRAME) {
              const frame = parseFramePayload(payload);
              sendToSession(sessionId, 'rdp:frame', { x: frame.x, y: frame.y, w: frame.w, h: frame.h }, frame.pixels);
            } else if (type === MSG.STATUS) {
              let status;
              try { status = JSON.parse(payload.toString('utf8')); } catch (_e) { status = { state: 'error', message: '상태 메시지 파싱 실패' }; }
              if (!settled && status.state === 'error') {
                settled = true;
                clearTimeout(timeoutTimer);
                sessions.delete(sessionId);
                resolve({ ok: false, error: status.message || '연결 실패', kind: 'other' });
              }
              sendToSession(sessionId, 'rdp:status', status);
              if (status.state === 'disconnected' || status.state === 'error') { sessions.delete(sessionId); unregisterSession(sessionId); }
            }
          },
          (logLine) => { console.log('[rdp-helper][' + sessionId + ']', logLine.trimEnd()); }
        );

        helper.child.on('exit', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutTimer);
            resolve({ ok: false, error: 'RDP 헬퍼 프로세스가 비정상 종료되었습니다', kind: 'other' });
          }
          sessions.delete(sessionId);
          unregisterSession(sessionId);
        });
        helper.child.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutTimer);
            // ENOENT는 거의 항상 "네이티브 헬퍼 바이너리를 이 워크트리/체크아웃에서 아직 빌드 안 함"이다
            // (onegyeok-rdp-helper는 .gitignore 대상이라 git에 안 들어있다 — 워크트리마다 한 번 빌드해야 함).
            const hint = err.code === 'ENOENT' ? ' (native/rdp-helper 바이너리가 없음 — `npm run build:native` 실행 필요)' : '';
            resolve({ ok: false, error: 'RDP 헬퍼 프로세스를 시작할 수 없습니다: ' + err.message + hint, kind: 'other' });
          }
          sessions.delete(sessionId);
          unregisterSession(sessionId);
        });

        sessions.set(sessionId, helper);
        helper.connect({
          host: params.host, port: params.port || 3389, username: params.username,
          password: params.password, domain: params.domain,
          width: params.width || 1024, height: params.height || 768,
          colorDepth: params.colorDepth || 32,
          security: params.security || 'tls',
          ignoreCertificate: params.ignoreCertificate !== false,
        });
      });
    });

    ipcMain.handle('rdp:disconnect', (_event, sessionId) => {
      const helper = sessions.get(sessionId);
      if (helper) { helper.disconnect(); helper.kill(); sessions.delete(sessionId); }
      unregisterSession(sessionId);
      return { ok: true };
    });

    ipcMain.on('rdp:mouse', (_event, sessionId, x, y, flags) => {
      const helper = sessions.get(sessionId);
      if (helper) helper.mouse(x, y, flags);
    });
    ipcMain.on('rdp:key', (_event, sessionId, scancode, flags) => {
      const helper = sessions.get(sessionId);
      if (helper) helper.key(scancode, flags);
    });
    ipcMain.on('rdp:resize', (_event, sessionId, width, height) => {
      const helper = sessions.get(sessionId);
      if (helper) helper.resize(width, height);
    });
  },
  disconnectAll() {
    sessions.forEach((helper) => { try { helper.disconnect(); } catch (_e) { /* noop */ } helper.kill(); });
    sessions.clear();
  },
});
