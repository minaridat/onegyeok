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

// 실시간 탭 드래그 중인 창의 "자가 치유" 위치 추적 — 멀티 모니터(특히 스케일 팩터가 다른
// 내장+외장 디스플레이 조합) macOS 환경에서, show:false로 만든 창을 showInactive()로 띄우고
// loadFile()로 페이지를 로드하면, 로드 도중(심지어 did-finish-load 이후에도) macOS/Electron이
// 비동기로 창을 요청하지 않은 다른 모니터 쪽 위치로 슬쩍 옮겨버리는 걸 실측으로 확인했다(여러
// 방식으로 재현 조건을 좁혀봤지만 정확한 트리거 시점은 특정하지 못했다 — 타이밍이 아니라
// loadFile 자체가 유발하는 것으로 보임). 시점 기반 보정(생성 직후 한 번, did-finish-load 때
// 한 번 등)으로는 다 뚫렸고, 유일하게 확실히 통한 방법은 창의 'move' 이벤트를 계속 감시하다가
// 우리가 의도한 위치(target)와 다르면 즉시 되돌리는 것이었다 — 그래서 "자가 치유" 방식으로
// 간다. 드래그가 끝나면(stopPositionTracking) 반드시 떼어내야 한다 — 안 그러면 드래그 종료
// 후 사용자가 타이틀바를 직접 끌어 옮기려 할 때도 계속 제자리로 되돌려버리게 된다.
const positionTracking = new Map(); // window.id -> { target: {x,y}, listener }

function startPositionTracking(win, x, y) {
  const tx = Math.round(x), ty = Math.round(y);
  win.setPosition(tx, ty);
  const state = { target: { x: tx, y: ty } };
  state.listener = () => {
    const b = win.getBounds();
    if (b.x !== state.target.x || b.y !== state.target.y) {
      win.setPosition(state.target.x, state.target.y);
    }
  };
  win.on('move', state.listener);
  positionTracking.set(win.id, state);
}

function updatePositionTarget(win, x, y) {
  const state = positionTracking.get(win.id);
  const tx = Math.round(x), ty = Math.round(y);
  if (!state) { win.setPosition(tx, ty); return; } // 추적 중이 아니면(드물게) 그냥 바로 이동
  state.target = { x: tx, y: ty };
  win.setPosition(tx, ty);
}

function stopPositionTracking(win) {
  const state = positionTracking.get(win.id);
  if (!state) return;
  win.removeListener('move', state.listener);
  positionTracking.delete(win.id);
}

function windowOptions(ctx, position) {
  const opts = {
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
  // 실시간 탭 드래그(아래 main.js의 beginTearOffDrag)가 커서 위치에 창을 바로 띄우기 위해
  // 쓴다 — 생성 후 setPosition()으로 옮기면 기본 위치에 한 프레임 잠깐 나타났다 옮겨가는 게
  // 보일 수 있어서, 생성자 옵션으로 바로 원하는 위치에 뜨게 한다.
  if (position && typeof position.x === 'number' && typeof position.y === 'number') {
    opts.x = position.x;
    opts.y = position.y;
    // 드래그 도중 만드는 창이 OS 포커스를 가져가면 안 된다 — 사용자는 아직 원래 창에서 마우스
    // 버튼을 누른 채고, 새 창이 포커스를 뺏으면 그 순간 드래그 입력이 끊기는 것처럼 보일 수
    // 있다(실측: Electron에서 두 번째 창이 포커스를 받으면 첫 창이 더 이상 마우스 이벤트를
    // 받지 못하는 걸 Playwright로 확인했다 — CDP 쪽 한정 동작일 수도 있지만, 실제 OS에서도
    // 포커스가 넘어가면 드래그 캡처가 끊길 위험이 있어 안전하게 막는다). show:false로 만들고
    // showInactive()로 띄워서 포커스를 주지 않는다 — 드래그가 끝나면(병합 안 되고 그대로
    // 남으면) completeTearOffDrag에서 win.focus()로 정상 포커스를 준다.
    opts.show = false;
  }
  return opts;
}

// initialTabs: null(평소 데모 시드 부팅) 또는 [{tabId, serverId, protocol}, ...](분리된 창).
// position: {x, y} — 실시간 드래그로 만드는 창의 초기 좌표(선택, 없으면 OS 기본 위치).
function createAppWindow(ctx, initialTabs, position) {
  const win = new BrowserWindow(windowOptions(ctx, position));
  appWindows.add(win);

  if (position && typeof position.x === 'number' && typeof position.y === 'number') {
    win.showInactive(); // 포커스 뺏지 않고 띄우기 — 위 windowOptions 주석 참고
    // 위 positionTracking 주석 참고 — loadFile 로딩 중에 창이 제멋대로 다른 모니터로 옮겨가는
    // 문제가 있어 'move' 이벤트로 계속 감시하며 되돌린다. 드래그가 끝나면(병합되거나 그대로
    // 남거나) main.js의 window:completeTearOffDrag에서 stopPositionTracking()으로 반드시 뗀다.
    startPositionTracking(win, position.x, position.y);
  }

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
    positionTracking.delete(win.id); // 안전망 — 보통은 completeTearOffDrag에서 미리 떼지만 혹시 몰라서
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

module.exports = {
  createAppWindow, moveSessionToWindow, getInitialTabsFor, appWindows,
  updatePositionTarget, stopPositionTracking,
};
