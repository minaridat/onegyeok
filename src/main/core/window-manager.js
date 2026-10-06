// 탭을 끌어서 별도 OS 창으로 분리/병합하는 기능(Stage B)의 메인 프로세스 쪽 조율 지점.
// - createAppWindow(initialTabs): 새 onegyeok 창을 만든다. initialTabs가 null이면 평소처럼
//   데모 시드로 부팅하는 "진짜 새 창"(앱의 첫 창), 배열이면 그 탭들만 이어받는 "분리된 창"이다.
// - moveSessionToWindow(...): 분리(새 창)와 병합(기존 창)이 공유하는 내부 로직 — 세션의 소유
//   창을 바꾸고, 마지막 상태/프레임을 새 창에 즉시 재전송(replay)해서 빈 화면으로 남지 않게 한다.
// - 창을 닫으면(보조 창 한정) 그 창이 들고 있던 세션을 전부 진짜로 끊는다 — 몰래 메인 창으로
//   되돌리거나 하지 않는다(F-502와 같은 원칙: 눈에 보이지 않는 "자동 유지"를 하지 않는다).
const { BrowserWindow } = require('electron');
const path = require('node:path');
const windowRegistry = require('./window-registry');
const protocolRegistry = require('./protocol-registry');

const pendingInitialTabs = new Map(); // webContents.id -> initialTabs 배열(한 번 조회되면 지워짐)
const appWindows = new Set(); // createAppWindow로 만든 모든 창(주 창 포함) — quit 시점 구분용

function windowOptions(ctx) {
  return {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'onegyeok',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  };
}

// initialTabs: null(평소 데모 시드 부팅) 또는 [{tabId, serverId, protocol}, ...](분리된 창).
function createAppWindow(ctx, initialTabs) {
  const win = new BrowserWindow(windowOptions(ctx));
  appWindows.add(win);

  win.loadFile(path.join(__dirname, '../../renderer/index.html'));

  if (!ctx.app.isPackaged) {
    win.webContents.on('console-message', (event) => {
      console.log('[renderer]', event.message);
    });
  }

  if (initialTabs) pendingInitialTabs.set(win.webContents.id, initialTabs);

  // 보조 창(initialTabs가 있던 창)이 닫히면 그 창이 들고 있던 세션을 전부 끊는다. app.quit()의
  // before-quit → disconnectAllProtocols()는 이와 별개로 이미 전부 끊으므로 여기서 또 끊을
  // 필요 없다 — isQuitting 플래그로 그 경로와 겹치지 않게 막는다.
  win.on('closed', () => {
    appWindows.delete(win);
    if (ctx.isQuitting()) return;
    const sessionIds = windowRegistry.sessionIdsForWindow(win);
    sessionIds.forEach((sessionId) => {
      const protoName = windowRegistry.getSessionProtocol(sessionId);
      const def = protoName && protocolRegistry.getProtocol(protoName);
      if (def && def.disconnectSession) {
        try { def.disconnectSession(sessionId); } catch (_e) { /* noop */ }
      }
      windowRegistry.unregisterSession(sessionId);
    });
  });

  return win;
}

// 분리(새 창 생성)와 병합(기존 창에 합류)이 공유하는 내부 로직 — 세션의 소유 창을 옮기고,
// 마지막으로 보낸 상태(및 RDP/VNC면 전체 프레임 캐시)를 새 창에 즉시 재전송한다.
function moveSessionToWindow(sessionId, protocolName, targetWin) {
  windowRegistry.registerSessionWindow(sessionId, targetWin, protocolName);
  const def = protocolRegistry.getProtocol(protocolName);
  if (def && def.onSessionWindowChanged) {
    try { def.onSessionWindowChanged(sessionId, targetWin); } catch (_e) { /* noop */ }
  }
}

function getInitialTabsFor(webContentsId) {
  const tabs = pendingInitialTabs.get(webContentsId) || null;
  pendingInitialTabs.delete(webContentsId); // 1회성 — 재부팅(새로고침)은 지원 범위 밖
  return tabs;
}

module.exports = { createAppWindow, moveSessionToWindow, getInitialTabsFor, appWindows };
