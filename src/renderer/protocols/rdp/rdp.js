// ==================================================================
// RDP 클라이언트 (Apache Guacamole 기반 — docs/기술스택/03_RDP_기술스택.md)
//
// 메인 프로세스(IPC)는 로컬 WebSocket 주소 + 1회용 암호화 토큰만 돌려준다. 실제 화면
// 스트림은 여기서 그 주소로 직접 WebSocket을 열어 받는다(IPC를 거치지 않음 — 바이너리
// 화면 데이터를 IPC로 중계하면 느리고 무겁기 때문). 비밀번호는 SSH/SQL과 동일한 원칙으로
// 저장하지 않고, 탭 안의 접속 폼에 그때그때 직접 입력받는다.
// ==================================================================
var rdpSessions = {}; // tabId -> { state, srv, el, dom, client, mouse, keyboard }
var hasRdpBridge = !!(window.onegyeok && window.onegyeok.rdp);

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
        '<button type="button" class="rdp-disconnect-btn" title="연결 종료"><svg class="icon" viewBox="0 0 20 20" style="width:13px;height:13px"><circle cx="10" cy="10" r="7.5"></circle><line x1="7" y1="7" x2="13" y2="13"></line><line x1="13" y1="7" x2="7" y2="13"></line></svg></button>' +
      '</div>' +
      '<div class="rdp-display-wrap" tabindex="0"></div>' +
    '</div>';
  return {
    titleEl: el.querySelector('.rdp-connect-title'),
    usernameRow: el.querySelector('.rdp-f-username-row'),
    usernameInput: el.querySelector('.rdp-f-username'),
    passwordInput: el.querySelector('.rdp-f-password'),
    connectError: el.querySelector('.rdp-connect-error'),
    connectBtn: el.querySelector('.rdp-connect-btn'),
    meta: el.querySelector('.rdp-meta'),
    disconnectBtn: el.querySelector('.rdp-disconnect-btn'),
    displayWrap: el.querySelector('.rdp-display-wrap'),
  };
}

// Guacamole 프로토콜 상태 코드를 SSH/SQL과 동일한 kind('auth'/'network'/'other') 체계로 분류한다.
function classifyRdpStatus(code){
  var C = window.Guacamole.Status.Code;
  if(code === C.CLIENT_UNAUTHORIZED || code === C.CLIENT_FORBIDDEN) return 'auth';
  if(code === C.UPSTREAM_NOT_FOUND || code === C.UPSTREAM_UNAVAILABLE || code === C.UPSTREAM_TIMEOUT) return 'network';
  return 'other';
}
function rdpStatusMessage(kind){
  if(kind === 'auth') return '인증 실패 — 사용자명 또는 비밀번호를 확인해주세요';
  if(kind === 'network') return '대상 서버에 연결할 수 없습니다 — 호스트/포트를 확인해주세요';
  return '연결 실패';
}

function showRdpConnectForm(tabId){
  var s = rdpSessions[tabId];
  if(!s) return;
  s.el.classList.remove('connected');
  s.dom.connectError.textContent = '';
  s.dom.passwordInput.value = '';
  s.dom.connectBtn.disabled = false;
  s.dom.connectBtn.textContent = '접속';
  if(s.client){
    try { s.client.disconnect(); } catch(_e){ /* noop */ }
    s.client = null; s.mouse = null; s.keyboard = null;
  }
  s.dom.displayWrap.innerHTML = '';
  setTimeout(function(){
    if(s.dom.usernameRow.style.display !== 'none') s.dom.usernameInput.focus();
    else s.dom.passwordInput.focus();
  }, 0);
}

function setupRdpInput(tabId){
  var s = rdpSessions[tabId];
  if(!s || !s.client) return;
  var mouse = new window.Guacamole.Mouse(s.dom.displayWrap);
  mouse.onEach(['mousedown', 'mousemove', 'mouseup'], function(e){
    s.client.sendMouseState(e.state, true);
  });
  s.mouse = mouse;

  var keyboard = new window.Guacamole.Keyboard(s.dom.displayWrap);
  keyboard.onkeydown = function(keysym){ s.client.sendKeyEvent(1, keysym); };
  keyboard.onkeyup = function(keysym){ s.client.sendKeyEvent(0, keysym); };
  s.keyboard = keyboard;
}

function startGuacamoleClient(tabId, wsBaseUrl, token){
  var s = rdpSessions[tabId];
  if(!s) return;
  // 토큰은 tunnel URL에 미리 붙이지 않는다 — WebSocketTunnel.connect(data)가 내부적으로
  // `tunnelURL + "?" + data`로 자기 쿼리스트링을 붙이므로, client.connect()에 넘겨야 한다.
  var tunnel = new window.Guacamole.WebSocketTunnel(wsBaseUrl);
  var client = new window.Guacamole.Client(tunnel);
  s.client = client;

  s.dom.displayWrap.appendChild(client.getDisplay().getElement());

  client.onstatechange = function(state){
    if(!rdpSessions[tabId]) return;
    var STATE = window.Guacamole.Client.State;
    if(state === STATE.CONNECTED){
      s.dom.connectBtn.disabled = false;
      s.dom.connectBtn.textContent = '접속';
      s.el.classList.add('connected');
      s.dom.meta.textContent = s.srv.host + ':' + (s.srv.port || 3389);
      setRdpStatus(tabId, 'connected', '');
      setupRdpInput(tabId);
      setTimeout(function(){ s.dom.displayWrap.focus(); }, 0);
    } else if(state === STATE.DISCONNECTED){
      if(s.state === 'connected'){
        setRdpStatus(tabId, 'disconnected', '연결이 종료되었습니다.');
        showRdpConnectForm(tabId);
      }
    }
  };

  client.onerror = function(status){
    if(!rdpSessions[tabId]) return;
    var kind = classifyRdpStatus(status.code);
    var message = rdpStatusMessage(kind);
    s.dom.connectBtn.disabled = false;
    s.dom.connectBtn.textContent = '접속';
    s.dom.connectError.textContent = message;
    setRdpStatus(tabId, 'error', message);
  };

  client.connect('token=' + encodeURIComponent(token));
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
  }).then(function(res){
    if(!rdpSessions[tabId]) return;
    if(!res.ok){
      s.dom.connectBtn.disabled = false;
      s.dom.connectBtn.textContent = '접속';
      s.dom.connectError.textContent = res.error || '연결 실패';
      setRdpStatus(tabId, 'error', res.error);
      return;
    }
    startGuacamoleClient(tabId, res.wsBaseUrl, res.token);
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

function startRdpSession(tabId, serverId, el){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv) return;
  el.className = 'pane rdp-pane';
  var dom = buildRdpPaneDom(el);
  dom.titleEl.textContent = srv.host + ':' + (srv.port || 3389);
  var showUsernameField = !srv.username;
  dom.usernameRow.style.display = showUsernameField ? '' : 'none';

  var session = { state: 'disconnected', srv: srv, el: el, dom: dom, client: null, mouse: null, keyboard: null };
  rdpSessions[tabId] = session;

  dom.connectBtn.addEventListener('click', function(){ attemptRdpConnect(tabId); });
  dom.passwordInput.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); attemptRdpConnect(tabId); } });
  dom.disconnectBtn.addEventListener('click', function(){ disconnectRdpKeepTab(tabId); });

  if(!hasRdpBridge || !window.Guacamole){
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
  if(s.client){ try { s.client.disconnect(); } catch(_e){ /* noop */ } }
  if(hasRdpBridge) window.onegyeok.rdp.disconnect(tabId);
  var serverId = s.srv && s.srv.id;
  delete rdpSessions[tabId];
  if(serverId) updateServerRowStatus(serverId);
}

registerProtocol('rdp', {
  meta: { label:'RDP', icon:'<svg viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="11" rx="1.4"></rect><line x1="7" y1="17" x2="13" y2="17"></line></svg>' },

  startSession: startRdpSession,
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
