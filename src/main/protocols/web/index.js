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

// 사용자가 "이 탭에서만 계속"을 명시적으로 허용한 인증서 오류 호스트 — webContents.id별, 메모리에만 둔다.
const trustedCertHosts = new Map(); // webContentsId -> Set(host)

registerMainProtocol('web', {
  wire(ctx) {
    const { ipcMain, app } = ctx;
    const { webContents: webContentsApi } = require('electron');

    ipcMain.handle('web:trust-cert', (_event, webContentsId, url) => {
      const wc = webContentsApi.fromId(webContentsId);
      if (!wc || wc.getType() !== 'webview' || !isHttpUrl(url)) return { ok: false };
      const host = new URL(url).host;
      if (!trustedCertHosts.has(webContentsId)) {
        trustedCertHosts.set(webContentsId, new Set());
        wc.once('destroyed', () => trustedCertHosts.delete(webContentsId));
      }
      trustedCertHosts.get(webContentsId).add(host);
      return { ok: true };
    });

    // 기본은 거부(Chromium 기본 동작). 사용자가 허용한 호스트에 한해 이 탭에서만 통과시킨다.
    app.on('certificate-error', (event, wc, url, _error, _cert, callback) => {
      let host = '';
      try { host = new URL(url).host; } catch (e) { /* 무시 */ }
      const trusted = wc.getType() === 'webview' && host && trustedCertHosts.get(wc.id)?.has(host);
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
  disconnectAll() {},
});
