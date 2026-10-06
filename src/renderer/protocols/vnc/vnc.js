// ==================================================================
// VNC 클라이언트 (libvncclient 직접 연동 네이티브 헬퍼 기반 — docs/기술스택/04_VNC_기술스택.md)
//
// 구조는 RDP(protocols/rdp/rdp.js)와 동일하다 — 메인 프로세스가 네이티브 헬퍼 프로세스
// (native/vnc-helper)를 스폰하고, 화면 프레임(원본 RGBA32 픽셀 — VNC는 헬퍼가 픽셀 포맷을 직접
// 요청하므로 RDP와 달리 채널 스왑이 필요 없다)과 상태를 IPC로 이 쪽에 push한다. 입력은 <canvas>
// 위의 마우스/키보드 이벤트를 RFB 버튼마스크/X11 keysym으로 변환해 반대 방향으로 보낸다.
// VNC는 사용자명 개념이 없고(F-1006) 비밀번호만 그때그때 직접 입력받아 저장하지 않는다.
// ==================================================================
var vncSessions = {}; // tabId -> { state, srv, el, dom, ctx }
var hasVncBridge = !!(window.onegyeok && window.onegyeok.vnc);

// RFB(VNC) 포인터 버튼마스크 — SendPointerEvent(client, x, y, buttonMask)의 비트 의미.
var RFB_BUTTON1_MASK = 1; // 좌클릭
var RFB_BUTTON2_MASK = 2; // 중클릭
var RFB_BUTTON3_MASK = 4; // 우클릭
var RFB_WHEEL_UP_MASK = 8;
var RFB_WHEEL_DOWN_MASK = 16;

// 물리 키(KeyboardEvent.code, 미국 쿼티 배열 기준) → X11 keysym.
// VNC(RFB)는 스캔코드가 아니라 keysym을 쓴다(RDP와 다른 체계). 문자/숫자 키는 ASCII 코드값과
// 같아 그때그때 계산하고, 그 외 특수 키만 이 표에 둔다. 미디어 키 등 드문 키는 범위 밖(알려진 한계).
var XK_BackSpace = 0xff08, XK_Tab = 0xff09, XK_Return = 0xff0d, XK_Escape = 0xff1b,
  XK_Delete = 0xffff, XK_Insert = 0xff63, XK_Home = 0xff50, XK_End = 0xff57,
  XK_Page_Up = 0xff55, XK_Page_Down = 0xff56,
  XK_Left = 0xff51, XK_Up = 0xff52, XK_Right = 0xff53, XK_Down = 0xff54,
  XK_Shift_L = 0xffe1, XK_Shift_R = 0xffe2, XK_Control_L = 0xffe3, XK_Control_R = 0xffe4,
  XK_Alt_L = 0xffe9, XK_Alt_R = 0xffea, XK_Super_L = 0xffeb, XK_Super_R = 0xffec,
  XK_Menu = 0xff67, XK_Caps_Lock = 0xffe5, XK_Num_Lock = 0xff7f, XK_Scroll_Lock = 0xff14,
  XK_space = 0x0020;
var KEYSYM_MAP = {
  Backspace:XK_BackSpace, Tab:XK_Tab, Enter:XK_Return, Escape:XK_Escape,
  Delete:XK_Delete, Insert:XK_Insert, Home:XK_Home, End:XK_End,
  PageUp:XK_Page_Up, PageDown:XK_Page_Down,
  ArrowLeft:XK_Left, ArrowUp:XK_Up, ArrowRight:XK_Right, ArrowDown:XK_Down,
  ShiftLeft:XK_Shift_L, ShiftRight:XK_Shift_R, ControlLeft:XK_Control_L, ControlRight:XK_Control_R,
  AltLeft:XK_Alt_L, AltRight:XK_Alt_R, MetaLeft:XK_Super_L, MetaRight:XK_Super_R,
  ContextMenu:XK_Menu, CapsLock:XK_Caps_Lock, NumLock:XK_Num_Lock, ScrollLock:XK_Scroll_Lock,
  Space:XK_space,
  F1:0xffbe, F2:0xffbf, F3:0xffc0, F4:0xffc1, F5:0xffc2, F6:0xffc3,
  F7:0xffc4, F8:0xffc5, F9:0xffc6, F10:0xffc7, F11:0xffc8, F12:0xffc9,
};

// 문자/숫자/기호 등 일반 출력 가능한 키는 keysym == 유니코드 코드포인트(Latin-1 범위, 0x20~0x7e)와
// 같다 — e.key가 길이 1인 문자면 그대로 codePointAt을 keysym으로 쓴다(대소문자/Shift 조합은
// 브라우저가 e.key에 이미 반영해서 준다).
function keysymFor(e){
  if(KEYSYM_MAP[e.code] != null) return KEYSYM_MAP[e.code];
  if(e.key && e.key.length === 1) return e.key.codePointAt(0);
  return null; // 매핑 없는 키(미디어 키 등)는 무시 — 알려진 한계
}

function setVncStatus(tabId, state, message){
  var s = vncSessions[tabId];
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

function buildVncPaneDom(el){
  el.innerHTML =
    '<div class="vnc-connect">' +
      '<div class="vnc-connect-box">' +
        '<div class="vnc-connect-title"></div>' +
        '<label>비밀번호<input type="password" class="vnc-f-password" autocomplete="off"></label>' +
        '<div class="vnc-connect-error"></div>' +
        '<button type="button" class="vnc-connect-btn">접속</button>' +
      '</div>' +
    '</div>' +
    '<div class="vnc-workspace">' +
      '<div class="vnc-toolbar">' +
        '<span class="vnc-meta"></span>' +
        '<button type="button" class="icon-btn vnc-actualsize-btn" title="실제 크기(1:1)로 보기 / 창에 맞추기"><svg class="icon" viewBox="0 0 20 20" style="width:13px;height:13px"><rect x="3" y="3" width="14" height="14" rx="1.4"></rect><path d="M7 10h6M10 7v6"></path></svg></button>' +
        '<button type="button" class="icon-btn vnc-fullscreen-btn" title="전체화면"><svg class="icon" viewBox="0 0 20 20" style="width:13px;height:13px"><path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4"></path></svg></button>' +
        '<button type="button" class="vnc-disconnect-btn" title="연결 종료"><svg class="icon" viewBox="0 0 20 20" style="width:13px;height:13px"><circle cx="10" cy="10" r="7.5"></circle><line x1="7" y1="7" x2="13" y2="13"></line><line x1="13" y1="7" x2="7" y2="13"></line></svg></button>' +
      '</div>' +
      '<div class="vnc-display-wrap"><canvas class="vnc-canvas" tabindex="0"></canvas></div>' +
    '</div>';
  return {
    titleEl: el.querySelector('.vnc-connect-title'),
    passwordInput: el.querySelector('.vnc-f-password'),
    connectError: el.querySelector('.vnc-connect-error'),
    connectBtn: el.querySelector('.vnc-connect-btn'),
    meta: el.querySelector('.vnc-meta'),
    actualSizeBtn: el.querySelector('.vnc-actualsize-btn'),
    fullscreenBtn: el.querySelector('.vnc-fullscreen-btn'),
    disconnectBtn: el.querySelector('.vnc-disconnect-btn'),
    displayWrap: el.querySelector('.vnc-display-wrap'),
    canvas: el.querySelector('.vnc-canvas'),
  };
}

function showVncConnectForm(tabId){
  var s = vncSessions[tabId];
  if(!s) return;
  s.el.classList.remove('connected');
  s.dom.connectError.textContent = '';
  s.dom.passwordInput.value = '';
  s.dom.connectBtn.disabled = false;
  s.dom.connectBtn.textContent = '접속';
  setTimeout(function(){ s.dom.passwordInput.focus(); }, 0);
}

// 원격 화면이 연결되면 캔버스에 포커스를 줘서 바로 마우스/키보드 입력을 받을 수 있게 한다.
function setupVncInput(tabId){
  var s = vncSessions[tabId];
  if(!s) return;
  var canvas = s.dom.canvas;
  var heldMask = 0; // 현재 눌려 있는 버튼들(드래그 중 좌표만 바뀌는 mousemove에도 유지해서 보내야 함)

  function sendMouse(x, y, mask){
    if(hasVncBridge) window.onegyeok.vnc.mouse(tabId, Math.round(x), Math.round(y), mask);
  }
  function buttonMask(button){
    if(button === 0) return RFB_BUTTON1_MASK;
    if(button === 1) return RFB_BUTTON2_MASK;
    if(button === 2) return RFB_BUTTON3_MASK;
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
    // 레터박스 여백을 클릭하면 범위 밖 좌표가 나올 수 있다 — IPC 쪽 writeUInt16LE가 음수/범위초과
    // 값에 예외를 던지므로 캔버스 범위 안으로 clamp한다.
    var x = Math.min(canvas.width - 1, Math.max(0, (e.clientX - rect.left - offsetX) / scale));
    var y = Math.min(canvas.height - 1, Math.max(0, (e.clientY - rect.top - offsetY) / scale));
    return { x: x, y: y };
  }

  canvas.addEventListener('mousemove', function(e){
    var p = canvasXY(e);
    sendMouse(p.x, p.y, heldMask);
  });
  canvas.addEventListener('mousedown', function(e){
    canvas.focus();
    heldMask |= buttonMask(e.button);
    var p = canvasXY(e);
    sendMouse(p.x, p.y, heldMask);
    e.preventDefault();
  });
  canvas.addEventListener('mouseup', function(e){
    heldMask &= ~buttonMask(e.button);
    var p = canvasXY(e);
    sendMouse(p.x, p.y, heldMask);
    e.preventDefault();
  });
  canvas.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  canvas.addEventListener('wheel', function(e){
    // RFB에는 전용 휠 이벤트가 없다 — 관례적으로 버튼4/5(마스크 8/16)를 눌렀다 바로 떼는 펄스로 보낸다.
    var p = canvasXY(e);
    var wheelMask = e.deltaY < 0 ? RFB_WHEEL_UP_MASK : RFB_WHEEL_DOWN_MASK;
    sendMouse(p.x, p.y, heldMask | wheelMask);
    sendMouse(p.x, p.y, heldMask);
    e.preventDefault();
  });

  function sendKey(e, down){
    var keysym = keysymFor(e);
    if(keysym == null) return;
    if(hasVncBridge) window.onegyeok.vnc.key(tabId, keysym, down);
    e.preventDefault();
  }
  canvas.addEventListener('keydown', function(e){ sendKey(e, true); });
  canvas.addEventListener('keyup', function(e){ sendKey(e, false); });
}

// 헬퍼가 보낸 RGBA32 원본 픽셀을 그대로 캔버스에 그린다(RDP와 달리 채널 스왑 불필요 — 헬퍼가
// rfbGetClient 호출 시 RGBA로 픽셀 포맷을 요청해두었다).
function drawVncFrame(tabId, rect, buffer){
  var s = vncSessions[tabId];
  if(!s || !s.ctx) return;
  var src = buffer instanceof Uint8ClampedArray ? buffer : new Uint8ClampedArray(
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  );
  var imageData = new ImageData(src, rect.w, rect.h);
  s.ctx.putImageData(imageData, rect.x, rect.y);
}

// onFrame/onStatus 리스너는 모듈 전체에 1개만 등록하고, sessionId로 해당 세션에 분배한다
// (세션마다 새로 구독하면 탭을 여러 개 열었을 때 리스너가 중복으로 쌓인다).
if(hasVncBridge){
  window.onegyeok.vnc.onFrame(function(sessionId, rect, buffer){
    drawVncFrame(sessionId, rect, buffer);
  });
  window.onegyeok.vnc.onStatus(function(sessionId, status){
    var s = vncSessions[sessionId];
    if(!s) return;
    if(status.state === 'disconnected' || status.state === 'error'){
      setVncStatus(sessionId, status.state, status.message || (status.state === 'error' ? '연결 실패' : '연결이 종료되었습니다.'));
      showVncConnectForm(sessionId);
    }
  });
}

function attemptVncConnect(tabId){
  var s = vncSessions[tabId];
  if(!s) return;
  var srv = s.srv;
  var password = s.dom.passwordInput.value;
  s.dom.connectError.textContent = '';
  s.dom.connectBtn.disabled = true;
  s.dom.connectBtn.textContent = '접속 중...';
  setVncStatus(tabId, 'connecting', '');

  window.onegyeok.vnc.connect(tabId, {
    host: srv.host, port: srv.port || 5900, password: password,
  }).then(function(res){
    if(!vncSessions[tabId]) return;
    if(!res.ok){
      s.dom.connectBtn.disabled = false;
      s.dom.connectBtn.textContent = '접속';
      s.dom.connectError.textContent = res.error || '연결 실패';
      setVncStatus(tabId, 'error', res.error);
      return;
    }
    var w = res.width || 1024, h = res.height || 768;
    s.dom.canvas.width = w;
    s.dom.canvas.height = h;
    s.ctx = s.dom.canvas.getContext('2d');
    s.dom.connectBtn.disabled = false;
    s.dom.connectBtn.textContent = '접속';
    s.el.classList.add('connected');
    s.dom.meta.textContent = srv.host + ':' + (srv.port || 5900);
    setVncStatus(tabId, 'connected', '');
    setupVncInput(tabId);
    setTimeout(function(){ s.dom.canvas.focus(); }, 0);
  });
}

// 연결된 상태에서 "연결 종료"를 누르면 탭은 유지한 채 다시 접속 폼으로 되돌린다.
function disconnectVncKeepTab(tabId){
  var s = vncSessions[tabId];
  if(!s) return;
  if(hasVncBridge) window.onegyeok.vnc.disconnect(tabId);
  setVncStatus(tabId, 'disconnected', '연결이 종료되었습니다.');
  showVncConnectForm(tabId);
}

function startVncSession(tabId, serverId, el){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv) return;
  el.className = 'pane vnc-pane';
  var dom = buildVncPaneDom(el);
  dom.titleEl.textContent = srv.host + ':' + (srv.port || 5900);

  var session = { state: 'disconnected', srv: srv, el: el, dom: dom, ctx: null };
  vncSessions[tabId] = session;

  dom.connectBtn.addEventListener('click', function(){ attemptVncConnect(tabId); });
  dom.passwordInput.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); attemptVncConnect(tabId); } });
  dom.disconnectBtn.addEventListener('click', function(){ disconnectVncKeepTab(tabId); });
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

  if(!hasVncBridge){
    dom.connectError.textContent = 'VNC 연결 기능을 사용할 수 없습니다 (preload 브리지 없음)';
    dom.connectBtn.disabled = true;
    return;
  }
  setTimeout(function(){ dom.passwordInput.focus(); }, 0);
}

function disposeVncSession(tabId){
  var s = vncSessions[tabId];
  if(!s) return;
  if(hasVncBridge) window.onegyeok.vnc.disconnect(tabId);
  var serverId = s.srv && s.srv.id;
  delete vncSessions[tabId];
  if(serverId) updateServerRowStatus(serverId);
}

registerProtocol('vnc', {
  meta: { label:'VNC', icon:'<svg viewBox="0 0 20 20"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"></path><circle cx="10" cy="10" r="2.3"></circle></svg>' },

  startSession: startVncSession,
  hasSession: function(tabId){ return !!vncSessions[tabId]; },
  getSession: function(tabId){ return vncSessions[tabId] || null; },
  disposeSession: function(tabId){ disposeVncSession(tabId); },
  isServerConnected: function(serverId){
    return Object.keys(vncSessions).some(function(tid){
      var s = vncSessions[tid];
      return s && s.srv && s.srv.id === serverId && s.state === 'connected';
    });
  },

  hasConnAction: true,
  onConnActionClick: function(tabId){
    var r = vncSessions[tabId];
    if(!r) return;
    if(r.state === 'connected') disconnectVncKeepTab(tabId);
    else attemptVncConnect(tabId);
  },
  quickReconnect: function(tabId){
    var rr = vncSessions[tabId];
    if(rr && rr.state !== 'connected' && rr.state !== 'connecting'){
      showVncConnectForm(tabId);
      activate(tabId);
    }
  },

  registration: {
    hideUsername: true,
    defaultPortPlaceholder: function(){ return '5900'; },
  },
});
