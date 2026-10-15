const sshManager = require('../../ssh-manager');
const localTerminal = require('../../local-terminal');
const sessionLog = require('../../core/session-log');
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
        let logStarted = false;
        await sshManager.connect(
          sessionId,
          params,
          (chunk) => { sessionLog.append(sessionId, chunk); sendToSession(sessionId, 'ssh:data', chunk); },
          (status) => {
            // 셸이 열린 시점(connected)부터 화면 출력을 기록한다 — 접속 중 비밀번호 입력 단계는 렌더러 안에서만 처리돼 로그에 없다.
            if (status.state === 'connected' && !logStarted) {
              logStarted = true;
              sessionLog.start(sessionId, { title: params.title || params.host, detail: 'SSH ' + params.username + '@' + params.host + ':' + (params.port || 22) });
            }
            if (status.state === 'disconnected' || status.state === 'error') sessionLog.stop(sessionId, status.state === 'error' ? '오류: ' + (status.message || '') : '연결 종료');
            sendToSession(sessionId, 'ssh:status', status);
            if (status.state === 'disconnected' || status.state === 'error') unregisterSession(sessionId);
          }
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message, kind: err.kind };
      }
    });

    // 로컬 터미널(이 PC의 셸)도 같은 ssh:* 이벤트/입력 채널을 쓴다 — 렌더러의 SSH 터미널 화면·동시 입력·스플릿뷰를 그대로 재사용하기 위해서다.
    ipcMain.handle('local:open', (event, sessionId, params) => {
      registerSessionWindow(sessionId, windowForEvent(event), 'ssh');
      try {
        const info = localTerminal.open(
          sessionId,
          params || {},
          (data) => { sessionLog.append(sessionId, data); sendToSession(sessionId, 'ssh:data', data); },
          (status) => {
            if (status.state === 'disconnected') sessionLog.stop(sessionId, '셸 종료');
            sendToSession(sessionId, 'ssh:status', status);
            if (status.state === 'disconnected') unregisterSession(sessionId);
          }
        );
        sessionLog.start(sessionId, { title: '로컬 터미널', detail: info.shell + ' · ' + info.cwd });
        return { ok: true, shell: info.shell };
      } catch (err) {
        unregisterSession(sessionId);
        return { ok: false, error: '로컬 터미널을 열 수 없습니다: ' + err.message };
      }
    });
    ipcMain.on('ssh:input', (_event, sessionId, data) => { if (localTerminal.has(sessionId)) localTerminal.write(sessionId, data); else sshManager.write(sessionId, data); });
    ipcMain.on('ssh:resize', (_event, sessionId, cols, rows) => { if (localTerminal.has(sessionId)) localTerminal.resize(sessionId, cols, rows); else sshManager.resize(sessionId, cols, rows); });
    ipcMain.handle('ssh:disconnect', (_event, sessionId) => {
      localTerminal.close(sessionId); sshManager.disconnect(sessionId); sessionLog.stop(sessionId, '연결 종료'); unregisterSession(sessionId);
      return { ok: true };
    });
  },

  // 탭이 다른 창으로 옮겨질 때(Stage B, window-manager.js) 마지막 상태를 즉시 재전송 — 그래야
  // 새 창이 다음 자연스러운 상태 변화가 올 때까지 기다리지 않고 바로 handleInput이 제대로 꽂힌다
  // (렌더러 ssh.js의 onStatus 리스너가 'connected' 수신 시 handleInput을 실제 전송 함수로 바꾼다).
  onSessionWindowChanged(sessionId, newWin) {
    if (savedCtx) savedCtx.replayLastSend(sessionId, 'ssh:status', newWin);
  },

  disconnectSession(sessionId) {
    localTerminal.close(sessionId);
    sshManager.disconnect(sessionId);
    sessionLog.stop(sessionId, '연결 종료');
  },

  disconnectAll() {
    localTerminal.closeAll();
    sshManager.disconnectAll();
    sessionLog.stopAll('앱 종료');
  },
});
