// 세션(탭) id -> 그 세션의 화면/입력이 지금 표시되고 있는 BrowserWindow 레지스트리.
// 지금은(Stage A) 창이 하나뿐이라 모든 세션이 사실상 같은 창으로 귀결되지만, 나중에 탭을
// 끌어서 별도 창으로 분리하는 기능(Stage B)이 생기면 이 레지스트리가 "이 세션의 프레임/상태
// 이벤트를 어느 창에 보내야 하는지" 판단의 유일한 기준이 된다 — 각 프로토콜의 *:connect
// 핸들러가 세션을 등록하고, Stage B의 탭 분리/병합 로직이 그 매핑을 갱신한다.
const sessionWindows = new Map(); // sessionId -> BrowserWindow

function registerSessionWindow(sessionId, win) {
  if (win) sessionWindows.set(sessionId, win);
}

function unregisterSession(sessionId) {
  sessionWindows.delete(sessionId);
}

function getSessionWindow(sessionId) {
  const win = sessionWindows.get(sessionId);
  return (win && !win.isDestroyed()) ? win : null;
}

// Stage B가 창을 닫을 때 "이 창이 들고 있던 세션들"을 찾아 정리하는 데 쓴다.
function sessionIdsForWindow(win) {
  const ids = [];
  for (const [sessionId, w] of sessionWindows) {
    if (w === win) ids.push(sessionId);
  }
  return ids;
}

module.exports = { registerSessionWindow, unregisterSession, getSessionWindow, sessionIdsForWindow };
