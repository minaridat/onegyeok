// 세션(탭) id -> 그 세션의 화면/입력이 지금 표시되고 있는 BrowserWindow 레지스트리.
// Stage A에서는 창이 하나뿐이라 모든 세션이 사실상 같은 창으로 귀결됐지만, Stage B(탭을 끌어서
// 별도 창으로 분리/병합)부터는 이 레지스트리가 "이 세션의 프레임/상태 이벤트를 어느 창에 보내야
// 하는지" 판단의 유일한 기준이다 — 각 프로토콜의 *:connect 핸들러가 세션을 등록하고,
// window-manager.js의 탭 분리/병합 로직이 그 매핑을 갱신한다.
const sessionWindows = new Map(); // sessionId -> BrowserWindow
const sessionProtocols = new Map(); // sessionId -> protocol name (창을 닫을 때 어느 프로토콜의
                                     // disconnectSession을 불러야 하는지 알기 위함)

function registerSessionWindow(sessionId, win, protocolName) {
  if (win) sessionWindows.set(sessionId, win);
  if (protocolName) sessionProtocols.set(sessionId, protocolName);
}

function unregisterSession(sessionId) {
  sessionWindows.delete(sessionId);
  sessionProtocols.delete(sessionId);
  lastPayloads.forEach((_v, key) => { if (key.startsWith(sessionId + ':')) lastPayloads.delete(key); });
}

function getSessionWindow(sessionId) {
  const win = sessionWindows.get(sessionId);
  return (win && !win.isDestroyed()) ? win : null;
}

function getSessionProtocol(sessionId) {
  return sessionProtocols.get(sessionId) || null;
}

// 창을 닫을 때 "이 창이 들고 있던 세션들"을 찾아 정리하는 데 쓴다(window-manager.js).
function sessionIdsForWindow(win) {
  const ids = [];
  for (const [sessionId, w] of sessionWindows) {
    if (w === win) ids.push(sessionId);
  }
  return ids;
}

// sendToSession이 보낸 마지막 payload를 (sessionId, channel)별로 기억해뒀다가, 탭이 다른 창으로
// 옮겨질 때 그 창에 "현재 상태"를 즉시 재전송(replay)하는 데 쓴다 — 그렇지 않으면 새 창은 다음
// 자연 변화(다음 ssh:status/db:status 등)가 올 때까지 빈 화면으로 남는다. FRAME류 이벤트(RDP/VNC)는
// 증분 사각형이라 이 캐시만으로는 부족해서, 각 프로토콜이 자체적으로 전체 프레임 버퍼를 따로
// 유지한다(src/main/protocols/{rdp,vnc}/index.js) — 거긴 이 캐시를 쓰지 않는다.
const lastPayloads = new Map(); // `${sessionId}:${channel}` -> args 배열

function rememberLastSend(sessionId, channel, args) {
  lastPayloads.set(sessionId + ':' + channel, args);
}

function replayLastSend(sessionId, channel, targetWin) {
  const args = lastPayloads.get(sessionId + ':' + channel);
  if (args && targetWin && !targetWin.isDestroyed()) {
    targetWin.webContents.send(channel, sessionId, ...args);
  }
}

module.exports = {
  registerSessionWindow, unregisterSession, getSessionWindow, getSessionProtocol, sessionIdsForWindow,
  rememberLastSend, replayLastSend,
};
