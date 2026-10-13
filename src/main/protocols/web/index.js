const { shell } = require('electron');
const { registerMainProtocol } = require('../../core/protocol-registry');

// Web 콘솔 — 별도 연결 프로세스는 없고, 렌더러의 <webview>와 기본 브라우저 열기만 지원한다.
// 계정 자동입력은 어디에도 없고(F-1103), 웹뷰 파티션은 "persist:" 접두사가 없는 메모리 전용이라
// 쿠키/세션이 디스크에 남지 않는다(F-1104).

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// 사용자가 "이 탭에서만 계속"을 명시적으로 허용한 인증서 오류 호스트 — tabId(= webview의
// partition "web-<tabId>")별로 메모리에만 둔다. webContentsId가 아니라 tabId로 키를 잡는 이유:
// 탭 분리/병합(Stage B)에서 <webview>를 다시 만들면 webContentsId는 매번 바뀌지만 tabId는
// 그대로이므로, 창을 옮겨도 이미 승인한 인증서를 다시 물어보지 않게 하려면 tabId 기준이어야 한다.
const trustedCertHosts = new Map(); // tabId -> Set(host)
const webContentsIdToTabId = new Map(); // webContentsId -> tabId (will-/did-attach-webview로 채움)

registerMainProtocol('web', {
  wire(ctx) {
    const { ipcMain, app } = ctx;
    const { webContents: webContentsApi } = require('electron');

    ipcMain.handle('web:trust-cert', (_event, tabId, webContentsId, url) => {
      const wc = webContentsApi.fromId(webContentsId);
      if (!wc || wc.getType() !== 'webview' || !isHttpUrl(url)) return { ok: false };
      const host = new URL(url).host;
      if (!trustedCertHosts.has(tabId)) trustedCertHosts.set(tabId, new Set());
      trustedCertHosts.get(tabId).add(host);
      return { ok: true };
    });

    // 기본은 거부(Chromium 기본 동작). 사용자가 허용한 호스트에 한해 이 탭에서만 통과시킨다.
    app.on('certificate-error', (event, wc, url, _error, _cert, callback) => {
      let host = '';
      try { host = new URL(url).host; } catch (e) { /* 무시 */ }
      const tabId = webContentsIdToTabId.get(wc.id);
      const trusted = wc.getType() === 'webview' && host && tabId && trustedCertHosts.get(tabId)?.has(host);
      if (trusted) event.preventDefault();
      callback(!!trusted);
    });

    ipcMain.handle('web:open-external', async (_event, url) => {
      if (!isHttpUrl(url)) return { ok: false, error: 'http/https URL만 열 수 있습니다.' };
      await shell.openExternal(String(url));
      return { ok: true };
    });

    // 모든 <webview> 부착을 검증한다: preload 제거, Node 접근 차단, 영속 파티션 금지, http(s)만 허용.
    app.on('web-contents-created', (_e, contents) => {
      // will-attach-webview(파티션 등 params 있음) → did-attach-webview(진짜 webContents 있음) 순서로
      // 붙는 webview 하나당 한 쌍씩 온다 — 같은 host contents에 여러 webview가 거의 동시에 붙어도
      // FIFO로 들어오므로 큐로 짝을 맞춘다(trustedCertHosts를 tabId로 재전송하기 위한 매핑 구성).
      const pendingTabIds = [];
      contents.on('will-attach-webview', (event, webPreferences, params) => {
        delete webPreferences.preload;
        delete webPreferences.preloadURL;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;
        webPreferences.allowRunningInsecureContent = false;
        if (!isHttpUrl(params.src) || String(params.partition || '').startsWith('persist:')) {
          event.preventDefault();
          return;
        }
        const m = /^web-(.+)$/.exec(String(params.partition || ''));
        pendingTabIds.push(m ? m[1] : null);
      });
      contents.on('did-attach-webview', (_event, webContents) => {
        const tabId = pendingTabIds.shift();
        if (tabId) {
          webContentsIdToTabId.set(webContents.id, tabId);
          webContents.once('destroyed', () => webContentsIdToTabId.delete(webContents.id));
        }
      });
      // 웹뷰 안의 새 창 요청은 앱 안에 창을 만들지 않고 기본 브라우저로 넘긴다.
      if (contents.getType() === 'webview') {
        contents.setWindowOpenHandler(({ url }) => {
          if (isHttpUrl(url)) shell.openExternal(url);
          return { action: 'deny' };
        });
      }
    });
  },
  // Web은 main 프로세스에 들고 있는 실제 연결이 없다(렌더러의 <webview>가 전부) — 탭을 완전히
  // 닫을 때 trustedCertHosts에 쌓인 메모리만 정리하면 된다(탭 분리/병합 중간 단계는 아니므로
  // tabId 기준 신뢰 목록을 여기서 지워도 된다).
  disconnectSession(sessionId) {
    trustedCertHosts.delete(sessionId);
  },
  disconnectAll() {},
});
