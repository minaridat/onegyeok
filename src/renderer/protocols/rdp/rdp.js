// ==================================================================
// RDP 클라이언트 (libfreerdp 직접 연동 네이티브 헬퍼 기반 — docs/기술스택/03_RDP_기술스택.md)
//
// 메인 프로세스가 네이티브 헬퍼 프로세스(native/rdp-helper)를 스폰하고, 화면 프레임(원본 BGRA32
// 픽셀)과 상태를 IPC로 이 쪽에 push한다(guacd/WebSocket을 거치던 이전 버전과 달리 화면 스트림도
// IPC를 탄다 — 상대가 로컬 프로세스의 stdout이라 렌더러가 직접 붙을 방법이 없기 때문). 입력은
// <canvas> 위의 마우스/키보드 이벤트를 FreeRDP 스캔코드/플래그로 변환해 반대 방향으로 보낸다.
// 비밀번호는 SSH/SQL과 동일한 원칙으로 저장하지 않고, 탭 안의 접속 폼에 그때그때 직접 입력받는다.
// ==================================================================
var rdpSessions = {}; // tabId -> { state, srv, el, dom, canvas, ctx }
var hasRdpBridge = !!(window.onegyeok && window.onegyeok.rdp);

// FreeRDP PTR_FLAGS_* (freerdp/input.h) — 마우스 이벤트 비트마스크
var PTR_FLAGS_WHEEL = 0x0200;
var PTR_FLAGS_WHEEL_NEGATIVE = 0x0100;
var PTR_FLAGS_MOVE = 0x0800;
var PTR_FLAGS_DOWN = 0x8000;
var PTR_FLAGS_BUTTON1 = 0x1000; // 좌클릭
var PTR_FLAGS_BUTTON2 = 0x2000; // 우클릭
var PTR_FLAGS_BUTTON3 = 0x4000; // 중클릭
// FreeRDP KBD_FLAGS_* — 키보드 이벤트 비트마스크
var KBD_FLAGS_EXTENDED = 0x0100;
var KBD_FLAGS_RELEASE = 0x8000;

// 물리 키(KeyboardEvent.code, 미국 쿼티 배열 기준) → PC/AT Set1 스캔코드.
// RDP는 이 Set1 스캔코드를 그대로 쓴다(MS-RDPBCGR). 확장키(아래 EXTENDED_CODES)는 전송 시
// KBD_FLAGS_EXTENDED를 추가로 세워야 한다. 미디어 키 등 드문 키는 범위 밖(알려진 한계).
var SCANCODE_MAP = {
  Escape:0x01, Digit1:0x02, Digit2:0x03, Digit3:0x04, Digit4:0x05, Digit5:0x06,
  Digit6:0x07, Digit7:0x08, Digit8:0x09, Digit9:0x0A, Digit0:0x0B,
  Minus:0x0C, Equal:0x0D, Backspace:0x0E,
  Tab:0x0F, KeyQ:0x10, KeyW:0x11, KeyE:0x12, KeyR:0x13, KeyT:0x14, KeyY:0x15, KeyU:0x16,
  KeyI:0x17, KeyO:0x18, KeyP:0x19, BracketLeft:0x1A, BracketRight:0x1B, Enter:0x1C,
  ControlLeft:0x1D, KeyA:0x1E, KeyS:0x1F, KeyD:0x20, KeyF:0x21, KeyG:0x22, KeyH:0x23,
  KeyJ:0x24, KeyK:0x25, KeyL:0x26, Semicolon:0x27, Quote:0x28, Backquote:0x29,
  ShiftLeft:0x2A, Backslash:0x2B, KeyZ:0x2C, KeyX:0x2D, KeyC:0x2E, KeyV:0x2F, KeyB:0x30,
  KeyN:0x31, KeyM:0x32, Comma:0x33, Period:0x34, Slash:0x35, ShiftRight:0x36,
  NumpadMultiply:0x37, AltLeft:0x38, Space:0x39, CapsLock:0x3A,
  F1:0x3B, F2:0x3C, F3:0x3D, F4:0x3E, F5:0x3F, F6:0x40, F7:0x41, F8:0x42, F9:0x43, F10:0x44,
  NumLock:0x45, ScrollLock:0x46,
  Numpad7:0x47, Numpad8:0x48, Numpad9:0x49, NumpadSubtract:0x4A,
  Numpad4:0x4B, Numpad5:0x4C, Numpad6:0x4D, NumpadAdd:0x4E,
  Numpad1:0x4F, Numpad2:0x50, Numpad3:0x51, Numpad0:0x52, NumpadDecimal:0x53,
  F11:0x57, F12:0x58,
  // 확장키(0xE0 prefix 계열) — 베이스 스캔코드는 숫자 키패드 자리와 겹치는 게 많아 EXTENDED 플래그로 구분한다.
  ControlRight:0x1D, AltRight:0x38, NumpadDivide:0x35, NumpadEnter:0x1C,
  Insert:0x52, Delete:0x53, Home:0x47, End:0x4F, PageUp:0x49, PageDown:0x51,
  ArrowUp:0x48, ArrowLeft:0x4B, ArrowRight:0x4D, ArrowDown:0x50,
  MetaLeft:0x5B, MetaRight:0x5C, ContextMenu:0x5D,
};
var EXTENDED_CODES = {
  ControlRight:1, AltRight:1, NumpadDivide:1, NumpadEnter:1,
  Insert:1, Delete:1, Home:1, End:1, PageUp:1, PageDown:1,
  ArrowUp:1, ArrowLeft:1, ArrowRight:1, ArrowDown:1,
  MetaLeft:1, MetaRight:1, ContextMenu:1,
};

function setRdpStatus(tabId, state, message){
  var s = rdpSessions[tabId];
  if(!s) return;
  s.state = state;
  if(s.srv) updateServerRowStatus(s.srv.id);
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(tab){
    var tabDot = tab.querySelector('.proto-chip .stat');
    if(tabDot) tabDot.classList.toggle('on', state === 'connected');
    var reconnectBtn = tab.querySelector('.tab-reconnect');
    if(reconnectBtn){
      var idleFailed = (state === 'error' || state === 'disconnected');
      reconnectBtn.classList.toggle('show', idleFailed);
    }
  }
  if(currentInspectedId === tabId) updateConnActionButton(tabId);
}

function buildRdpPaneDom(el){
  el.innerHTML =
    '<div class="rdp-connect">' +
      '<div class="rdp-connect-box">' +
        '<div class="rdp-connect-title"></div>' +
        '<label class="rdp-f-username-row" style="display:none">사용자명<input type="text" class="rdp-f-username" autocomplete="off"></label>' +
        '<label>비밀번호<input type="password" class="rdp-f-password" autocomplete="off"></label>' +
        '<div class="rdp-connect-error"></div>' +
        '<button type="button" class="rdp-connect-btn">접속</button>' +
      '</div>' +
    '</div>' +
    '<div class="rdp-workspace">' +
      '<div class="rdp-toolbar">' +
        '<span class="rdp-meta"></span>' +
        '<button type="button" class="icon-btn rdp-actualsize-btn" title="실제 크기(1:1)로 보기 / 창에 맞추기"><svg class="icon" viewBox="0 0 20 20" style="width:13px;height:13px"><rect x="3" y="3" width="14" height="14" rx="1.4"></rect><path d="M7 10h6M10 7v6"></path></svg></button>' +
        '<button type="button" class="icon-btn rdp-fullscreen-btn" title="전체화면"><svg class="icon" viewBox="0 0 20 20" style="width:13px;height:13px"><path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4"></path></svg></button>' +
        '<button type="button" class="rdp-disconnect-btn" title="연결 종료"><svg class="icon" viewBox="0 0 20 20" style="width:13px;height:13px"><circle cx="10" cy="10" r="7.5"></circle><line x1="7" y1="7" x2="13" y2="13"></line><line x1="13" y1="7" x2="7" y2="13"></line></svg></button>' +
      '</div>' +
      '<div class="rdp-display-wrap"><canvas class="rdp-canvas" tabindex="0"></canvas></div>' +
    '</div>';
  return {
    titleEl: el.querySelector('.rdp-connect-title'),
    usernameRow: el.querySelector('.rdp-f-username-row'),
    usernameInput: el.querySelector('.rdp-f-username'),
    passwordInput: el.querySelector('.rdp-f-password'),
    connectError: el.querySelector('.rdp-connect-error'),
    connectBtn: el.querySelector('.rdp-connect-btn'),
    meta: el.querySelector('.rdp-meta'),
    actualSizeBtn: el.querySelector('.rdp-actualsize-btn'),
    fullscreenBtn: el.querySelector('.rdp-fullscreen-btn'),
    disconnectBtn: el.querySelector('.rdp-disconnect-btn'),
    displayWrap: el.querySelector('.rdp-display-wrap'),
    canvas: el.querySelector('.rdp-canvas'),
  };
}

function showRdpConnectForm(tabId){
  var s = rdpSessions[tabId];
  if(!s) return;
  s.el.classList.remove('connected');
  s.dom.connectError.textContent = '';
  s.dom.passwordInput.value = '';
  s.dom.connectBtn.disabled = false;
  s.dom.connectBtn.textContent = '접속';
  setTimeout(function(){
    if(s.dom.usernameRow.style.display !== 'none') s.dom.usernameInput.focus();
    else s.dom.passwordInput.focus();
  }, 0);
}

// 원격 화면이 연결되면 캔버스에 포커스를 줘서 바로 마우스/키보드 입력을 받을 수 있게 한다.
function setupRdpInput(tabId){
  var s = rdpSessions[tabId];
  if(!s) return;
  var canvas = s.dom.canvas;

  function sendMouse(x, y, flags){
    if(hasRdpBridge) window.onegyeok.rdp.mouse(tabId, Math.round(x), Math.round(y), flags);
  }
  function buttonFlag(button){
    if(button === 0) return PTR_FLAGS_BUTTON1;
    if(button === 1) return PTR_FLAGS_BUTTON3;
    if(button === 2) return PTR_FLAGS_BUTTON2;
    return 0;
  }
  function canvasXY(e){
    // object-fit:contain으로 canvas를 CSS에서 확대/축소하므로(화면 크기조정 기능), 화면 좌표를
    // canvas의 내부 픽셀 좌표(=원격 해상도)로 환산해야 한다. pane 비율과 원격 해상도 비율이 다르면
    // object-fit:contain이 레터박스(위아래 또는 좌우 여백)를 만드므로, rect 전체 크기가 아니라
    // 실제 그려진 영역만 따로 계산해야 한다 — 그냥 rect 비율로 나누면 레터박스가 있을 때 클릭 위치가 어긋난다.
    var rect = canvas.getBoundingClientRect();
    var scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    var renderedW = canvas.width * scale, renderedH = canvas.height * scale;
    var offsetX = (rect.width - renderedW) / 2, offsetY = (rect.height - renderedH) / 2;
    // 레터박스 여백(위아래 또는 좌우 빈 공간)을 클릭하면 범위 밖 좌표가 나올 수 있다 — IPC 쪽
    // writeUInt16LE가 음수/범위초과 값에 예외를 던지므로 캔버스 범위 안으로 clamp한다.
    var x = Math.min(canvas.width - 1, Math.max(0, (e.clientX - rect.left - offsetX) / scale));
    var y = Math.min(canvas.height - 1, Math.max(0, (e.clientY - rect.top - offsetY) / scale));
    return { x: x, y: y };
  }

  canvas.addEventListener('mousemove', function(e){
    var p = canvasXY(e);
    sendMouse(p.x, p.y, PTR_FLAGS_MOVE);
  });
  canvas.addEventListener('mousedown', function(e){
    canvas.focus();
    var p = canvasXY(e);
    sendMouse(p.x, p.y, PTR_FLAGS_DOWN | buttonFlag(e.button));
    e.preventDefault();
  });
  canvas.addEventListener('mouseup', function(e){
    var p = canvasXY(e);
    sendMouse(p.x, p.y, buttonFlag(e.button));
    e.preventDefault();
  });
  canvas.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  canvas.addEventListener('wheel', function(e){
    var p = canvasXY(e);
    var negative = e.deltaY < 0;
    var units = Math.min(255, Math.max(1, Math.round(Math.abs(e.deltaY)))) & 0xFF;
    sendMouse(p.x, p.y, PTR_FLAGS_WHEEL | (negative ? PTR_FLAGS_WHEEL_NEGATIVE : 0) | units);
    e.preventDefault();
  });

  function sendKey(e, release){
    var scancode = SCANCODE_MAP[e.code];
    if(scancode == null) return; // 매핑 없는 키(미디어 키 등)는 무시 — 알려진 한계
    var flags = (EXTENDED_CODES[e.code] ? KBD_FLAGS_EXTENDED : 0) | (release ? KBD_FLAGS_RELEASE : 0);
    if(hasRdpBridge) window.onegyeok.rdp.key(tabId, scancode, flags);
    e.preventDefault();
  }
  canvas.addEventListener('keydown', function(e){ sendKey(e, false); });
  canvas.addEventListener('keyup', function(e){ sendKey(e, true); });
}

// 헬퍼가 보낸 BGRA32 원본 픽셀을 캔버스 ImageData(RGBA)로 바꿔 그 영역에만 그린다.
function drawRdpFrame(tabId, rect, buffer){
  var s = rdpSessions[tabId];
  if(!s || !s.ctx) return;
  var canvas = s.dom.canvas;
  // attachSession으로 이어받은 세션은 접속 응답(res.width/height)이 없어 캔버스 치수를 미리
  // 몰라서 기본값(300x150)인 채로 시작한다 — 메인 프로세스가 분리/병합 직후 보내는 전체 화면
  // 재전송(x=0,y=0,w=전체,h=전체) FRAME을 받으면 그 치수에 맞춰 캔버스를 키운다.
  if(rect.x + rect.w > canvas.width || rect.y + rect.h > canvas.height){
    canvas.width = Math.max(canvas.width, rect.x + rect.w);
    canvas.height = Math.max(canvas.height, rect.y + rect.h);
  }
  var src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  var n = rect.w * rect.h;
  var out = new Uint8ClampedArray(n * 4);
  for(var i = 0; i < n; i++){
    var si = i * 4;
    out[si] = src[si + 2];     // R <- B
    out[si + 1] = src[si + 1]; // G
    out[si + 2] = src[si];     // B <- R
    out[si + 3] = 255;         // A (RDP 프레임엔 실질적 알파가 없음)
  }
  var imageData = new ImageData(out, rect.w, rect.h);
  s.ctx.putImageData(imageData, rect.x, rect.y);
}

// onFrame/onStatus 리스너는 모듈 전체에 1개만 등록하고, sessionId로 해당 세션에 분배한다
// (세션마다 새로 구독하면 탭을 여러 개 열었을 때 리스너가 중복으로 쌓인다).
if(hasRdpBridge){
  window.onegyeok.rdp.onFrame(function(sessionId, rect, buffer){
    drawRdpFrame(sessionId, rect, buffer);
  });
  window.onegyeok.rdp.onStatus(function(sessionId, status){
    var s = rdpSessions[sessionId];
    if(!s) return;
    if(status.state === 'disconnected' || status.state === 'error'){
      setRdpStatus(sessionId, status.state, status.message || (status.state === 'error' ? '연결 실패' : '연결이 종료되었습니다.'));
      showRdpConnectForm(sessionId);
    }
  });
}

function attemptRdpConnect(tabId){
  var s = rdpSessions[tabId];
  if(!s) return;
  var srv = s.srv;
  var username = srv.username || s.dom.usernameInput.value.trim();
  if(!username){
    s.dom.connectError.textContent = '사용자명을 입력해주세요.';
    return;
  }
  var password = s.dom.passwordInput.value;
  s.dom.connectError.textContent = '';
  s.dom.connectBtn.disabled = true;
  s.dom.connectBtn.textContent = '접속 중...';
  setRdpStatus(tabId, 'connecting', '');

  var rect = s.dom.displayWrap.getBoundingClientRect();
  var width = Math.max(320, Math.round(rect.width) || 1024);
  var height = Math.max(240, Math.round(rect.height) || 768);

  window.onegyeok.rdp.connect(tabId, {
    host: srv.host, port: srv.port || 3389, username: username, password: password,
    width: width, height: height,
    // v1은 등록 폼에 보안협상/인증서 설정 UI가 없다 — 이전 guacd 구현(ignore-cert:true)과 동일하게
    // TLS만 쓰고 인증서 검증은 건너뛴다(도메인/NLA는 향후 설정 UI 추가 시 확장).
    security: 'tls', ignoreCertificate: true,
  }).then(function(res){
    if(!rdpSessions[tabId]) return;
    if(!res.ok){
      s.dom.connectBtn.disabled = false;
      s.dom.connectBtn.textContent = '접속';
      s.dom.connectError.textContent = res.error || '연결 실패';
      setRdpStatus(tabId, 'error', res.error);
      return;
    }
    var w = res.width || width, h = res.height || height;
    s.dom.canvas.width = w;
    s.dom.canvas.height = h;
    s.ctx = s.dom.canvas.getContext('2d');
    s.dom.connectBtn.disabled = false;
    s.dom.connectBtn.textContent = '접속';
    s.el.classList.add('connected');
    s.dom.meta.textContent = srv.host + ':' + (srv.port || 3389);
    setRdpStatus(tabId, 'connected', '');
    setupRdpInput(tabId);
    setTimeout(function(){ s.dom.canvas.focus(); }, 0);
  });
}

// 연결된 상태에서 "연결 종료"를 누르면 탭은 유지한 채 다시 접속 폼으로 되돌린다.
function disconnectRdpKeepTab(tabId){
  var s = rdpSessions[tabId];
  if(!s) return;
  if(hasRdpBridge) window.onegyeok.rdp.disconnect(tabId);
  setRdpStatus(tabId, 'disconnected', '연결이 종료되었습니다.');
  showRdpConnectForm(tabId);
}

// startRdpSession(접속 폼부터 시작)과 attachRdpSession(이미 연결된 세션을 이어받음)이 공유하는
// 툴바 버튼 와이어링 — 중복 방지.
function wireRdpToolbarButtons(tabId, dom, el){
  dom.connectBtn.addEventListener('click', function(){ attemptRdpConnect(tabId); });
  dom.passwordInput.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); attemptRdpConnect(tabId); } });
  dom.disconnectBtn.addEventListener('click', function(){ disconnectRdpKeepTab(tabId); });
  dom.actualSizeBtn.addEventListener('click', function(){
    var on = dom.displayWrap.classList.toggle('actual-size');
    dom.actualSizeBtn.classList.toggle('active', on);
  });
  dom.fullscreenBtn.addEventListener('click', function(){
    if(document.fullscreenElement === el) document.exitFullscreen();
    else el.requestFullscreen();
  });
  el.addEventListener('fullscreenchange', function(){
    dom.fullscreenBtn.classList.toggle('active', document.fullscreenElement === el);
  });
}

// 탭을 다른 창으로 끌어내 뺄 때(Stage B) 이 창(원래 창)에서 호출된다 — IPC 연결 종료 없이
// canvas/세션 맵 엔트리 등 로컬 UI 상태만 정리한다. main 프로세스의 실제 연결(헬퍼 프로세스)은
// 살아있고, 새 창이 이어받는다(docs/기술스택/03_RDP_기술스택.md 참고).
function detachRdpSessionLocal(tabId){
  var s = rdpSessions[tabId];
  var serverId = s && s.srv && s.srv.id;
  delete rdpSessions[tabId];
  if(serverId) updateServerRowStatus(serverId);
}

// 다른 창에서 넘어온(이미 연결돼 있을 수 있는) 탭을 이 창에서 받을 때 호출된다 — 접속 폼을
// 건너뛰고 바로 연결된 작업공간 UI를 구성한다. 실제 상태/화면은 메인 프로세스가 직후에
// 재전송하는 rdp:status·rdp:frame(전체 화면 1장)으로 채워진다.
function attachRdpSession(tabId, serverId, el){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv) return;
  el.className = 'pane rdp-pane connected';
  var dom = buildRdpPaneDom(el);
  dom.titleEl.textContent = srv.host + ':' + (srv.port || 3389);
  dom.meta.textContent = srv.host + ':' + (srv.port || 3389);

  var session = { state: 'connecting', srv: srv, el: el, dom: dom, ctx: dom.canvas.getContext('2d') };
  rdpSessions[tabId] = session;

  wireRdpToolbarButtons(tabId, dom, el);
  setupRdpInput(tabId);
  setTimeout(function(){ dom.canvas.focus(); }, 0);
}

function startRdpSession(tabId, serverId, el){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv) return;
  el.className = 'pane rdp-pane';
  var dom = buildRdpPaneDom(el);
  dom.titleEl.textContent = srv.host + ':' + (srv.port || 3389);
  var showUsernameField = !srv.username;
  dom.usernameRow.style.display = showUsernameField ? '' : 'none';

  var session = { state: 'disconnected', srv: srv, el: el, dom: dom, ctx: null };
  rdpSessions[tabId] = session;

  wireRdpToolbarButtons(tabId, dom, el);

  if(!hasRdpBridge){
    dom.connectError.textContent = 'RDP 연결 기능을 사용할 수 없습니다 (preload 브리지 없음)';
    dom.connectBtn.disabled = true;
    return;
  }
  setTimeout(function(){
    if(showUsernameField) dom.usernameInput.focus(); else dom.passwordInput.focus();
  }, 0);
}

function disposeRdpSession(tabId){
  var s = rdpSessions[tabId];
  if(!s) return;
  if(hasRdpBridge) window.onegyeok.rdp.disconnect(tabId);
  var serverId = s.srv && s.srv.id;
  delete rdpSessions[tabId];
  if(serverId) updateServerRowStatus(serverId);
}

registerProtocol('rdp', {
  meta: { label:'RDP', icon:'<svg viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="11" rx="1.4"></rect><line x1="7" y1="17" x2="13" y2="17"></line></svg>' },

  startSession: startRdpSession,
  detachLocal: detachRdpSessionLocal,
  attachSession: attachRdpSession,
  hasSession: function(tabId){ return !!rdpSessions[tabId]; },
  getSession: function(tabId){ return rdpSessions[tabId] || null; },
  disposeSession: function(tabId){ disposeRdpSession(tabId); },
  isServerConnected: function(serverId){
    return Object.keys(rdpSessions).some(function(tid){
      var s = rdpSessions[tid];
      return s && s.srv && s.srv.id === serverId && s.state === 'connected';
    });
  },

  hasConnAction: true,
  onConnActionClick: function(tabId){
    var r = rdpSessions[tabId];
    if(!r) return;
    if(r.state === 'connected') disconnectRdpKeepTab(tabId);
    else attemptRdpConnect(tabId);
  },
  quickReconnect: function(tabId){
    var rr = rdpSessions[tabId];
    if(rr && rr.state !== 'connected' && rr.state !== 'connecting'){
      showRdpConnectForm(tabId);
      activate(tabId);
    }
  },

  registration: {
    defaultPortPlaceholder: function(){ return '3389'; },
  },
});
