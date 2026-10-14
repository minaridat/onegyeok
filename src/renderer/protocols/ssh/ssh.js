// ==================================================================
// SSH 세션 (Phase1 F-201~213) — xterm.js 터미널 + ssh2(main 프로세스) 연동
//
// 인증(비밀번호/Key Passphrase)은 별도 모달이 아니라 "user@host's password:" 같은
// 프롬프트를 터미널 안에 직접 띄우고, 사용자가 그 자리에서 타이핑하는 방식으로 받는다
// (일반 ssh 커맨드라인과 동일한 경험). 입력된 값은 연결 1회에만 쓰이고 저장하지 않는다(F-301/601).
//
// 모든 키 입력은 터미널별 handleInput 함수로 들어가며, 동시 입력(브로드캐스트) 모드일 때는
// 같은 키 입력이 선택된 모든 세션의 handleInput으로 동시에 전달된다 — 그래서 비밀번호
// 프롬프트 단계든 셸 접속 이후든 구분 없이 "한 번 타이핑하면 여러 서버에 동시 입력"이 된다.
// ==================================================================
var sshSessions = {}; // tabId(or paneId) -> { term, fitAddon, statusEl, hostEl, state, handleInput, srv }
var hasSshBridge = !!(window.onegyeok && window.onegyeok.ssh);

function setSshStatus(tabId, state, message){
  var s = sshSessions[tabId];
  if(!s) return;
  s.state = state;
  if(state === 'error' || state === 'disconnected' || state === 'canceled'){
    s.statusEl.style.display = '';
    s.statusEl.textContent = message || '';
    s.statusEl.classList.toggle('err', state === 'error');
  } else {
    s.statusEl.style.display = 'none';
  }
  if(s.srv) updateServerRowStatus(s.srv.id);
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(tab){
    var tabDot = tab.querySelector('.proto-chip .stat');
    if(tabDot) tabDot.classList.toggle('on', state === 'connected');
    var reconnectBtn = tab.querySelector('.tab-reconnect');
    // 연결되어 있거나 지금 막 연결 시도/인증 중일 때는 재연결 버튼을 숨긴다 — 끊긴 상태일 때만 의미가 있다.
    if(reconnectBtn){
      var idleFailed = (state === 'error' || state === 'disconnected' || state === 'canceled');
      reconnectBtn.classList.toggle('show', idleFailed);
    }
  }
  if(currentInspectedId === tabId) updateConnActionButton(tabId);
}

function fitSshSession(id){
  var s = sshSessions[id];
  if(!s || !s.fitAddon) return;
  try {
    s.fitAddon.fit();
    if(s.state === 'connected' && hasSshBridge) {
      window.onegyeok.ssh.resize(id, s.term.cols, s.term.rows);
    }
  } catch(_e){ /* 패널이 아직 비표시 상태면 치수 계산이 실패할 수 있음 — 무시 */ }
}

// ---- 동시 입력(브로드캐스트) 모드 — Phase1 S8/F-208~212 ----
// 토글을 켜면 실제 세션이 있는 SSH 탭마다 체크박스가 나타난다. 기본은 전체 선택이며,
// 사용자가 탭별로 체크를 풀어 그룹에서 빼낼 수 있다.
var broadcastMode = false;
var broadcastSet = new Set();
var broadcastToggleBtn = document.getElementById('broadcastToggleBtn');
var broadcastBanner = document.getElementById('broadcastBanner');
var broadcastCountEl = document.getElementById('broadcastCount');

function dispatchTerminalInput(sourceId, data){
  var targets = (broadcastMode && broadcastSet.has(sourceId)) ? Array.from(broadcastSet) : [sourceId];
  targets.forEach(function(tid){
    var s = sshSessions[tid];
    if(s && s.handleInput) s.handleInput(data);
  });
}

function updateBroadcastCount(){
  broadcastCountEl.textContent = broadcastSet.size;
}

function ensureBroadcastCheckbox(tabEl){
  var cb = tabEl.querySelector('.tab-broadcast-check');
  if(cb) return cb;
  cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'tab-broadcast-check';
  cb.title = '동시 입력 그룹에 포함';
  cb.addEventListener('click', function(e){ e.stopPropagation(); }); // 탭 전환 방지
  cb.addEventListener('change', function(e){
    setTabBroadcastChecked(tabEl, e.target.checked);
    updateBroadcastCount();
  });
  tabEl.insertBefore(cb, tabEl.firstChild);
  return cb;
}

function setTabBroadcastChecked(tabEl, checked){
  var id = tabEl.dataset.id;
  var cb = ensureBroadcastCheckbox(tabEl);
  cb.checked = checked;
  if(checked) broadcastSet.add(id); else broadcastSet.delete(id);
  tabEl.classList.toggle('broadcast-active', checked);
  if(typeof syncCellBroadcast === 'function') syncCellBroadcast(id); // 스플릿뷰 칸 헤더의 체크박스/빨간 테두리와 동기화
}

function setBroadcastMode(on){
  broadcastMode = on;
  broadcastToggleBtn.classList.toggle('active', on);
  broadcastBanner.style.display = on ? 'flex' : 'none';
  broadcastSet.clear();
  tabbar.querySelectorAll('.tab[data-protocol="ssh"]').forEach(function(t){
    var cb = ensureBroadcastCheckbox(t);
    var hasSession = !!sshSessions[t.dataset.id]; // 데모 시드 탭처럼 실제 세션이 없으면 선택 불가
    cb.classList.toggle('show', on);
    cb.disabled = !hasSession;
    if(on && hasSession) setTabBroadcastChecked(t, true); // 기본값: 전체 선택
    else { cb.checked = false; t.classList.remove('broadcast-active'); }
    if(typeof syncCellBroadcast === 'function') syncCellBroadcast(t.dataset.id);
  });
  updateBroadcastCount();
}

broadcastToggleBtn.addEventListener('click', function(){ setBroadcastMode(!broadcastMode); });
document.getElementById('broadcastOffBtn').addEventListener('click', function(){ setBroadcastMode(false); });

// 터미널 안에서 한 줄을 로컬로 입력받는다. echo 옵션으로 화면 표시 방식을 고른다:
//   { term, mask: false } — 입력한 글자를 그대로 보여준다(login as: 아이디)
//   { term, mask: true }  — 글자 수만큼 '*'로 보여준다(비밀번호/Passphrase, 값 자체는 화면·저장 어디에도 남지 않음)
//   echo 생략            — 아무것도 표시하지 않는다
// 브로드캐스트 중에는 세션마다 독립된 버퍼를 가지므로, 같은 키 입력이 동시에 들어와도
// 각자 알아서 자기 줄을 완성하고 각자 접속을 진행한다.
function isWideChar(ch){
  var c = ch.charCodeAt(0);
  return (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3) ||
    (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60) || (c >= 0xFFE0 && c <= 0xFFE6);
}

function createLinePrompter(onSubmit, onCancel, echo){
  var buf = '';
  var chars = []; // 화면에 그려진 글자(백스페이스 시 지울 칸 수 계산용)
  function show(ch){
    if(!echo) return;
    var out = echo.mask ? '*' : ch;
    chars.push(echo.mask ? 1 : (isWideChar(ch) ? 2 : 1));
    echo.term.write(out);
  }
  function erase(){
    if(!echo || !chars.length) return;
    var w = chars.pop();
    var back = '', blank = '';
    for(var k = 0; k < w; k++){ back += '\b'; blank += ' '; }
    echo.term.write(back + blank + back);
  }
  return function handleInput(data){
    // 방향키 등 이스케이프 시퀀스는 무시한다(\x1b[A 같은 문자가 입력값에 섞이지 않게).
    data = data.replace(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]/g, '');
    for(var i = 0; i < data.length; i++){
      var ch = data[i];
      var code = data.charCodeAt(i);
      if(ch === '\r' || ch === '\n'){
        var value = buf; buf = ''; chars = [];
        onSubmit(value);
        return;
      } else if(code === 3){ // Ctrl+C
        buf = ''; chars = [];
        onCancel();
        return;
      } else if(code === 127 || code === 8){ // Backspace
        if(buf.length){ buf = buf.slice(0, -1); erase(); }
      } else if(code >= 32){
        buf += ch;
        show(ch);
      }
    }
  };
}

// 인증 실패(비밀번호/Key 거절) 시 실제 ssh 명령어처럼 "Permission denied, please try again."를
// 띄우고 같은 자리에서 바로 재입력받는다 — 최대 횟수 넘으면 그때 최종 에러로 멈춘다.
var MAX_AUTH_ATTEMPTS = 3;

// 등록 시 사용자명을 비워뒀다면(다른 사용자로 로그인하는 경우 대비) 접속할 때마다
// "login as:"를 먼저 물어본다 — 이 값은 저장하지 않으므로 매번 다른 사용자로 접속 가능하다.
function promptAndConnect(id, session){
  var srv = session.srv;
  session.state = 'prompting';
  session.authAttempts = 0;
  setSshStatus(id, 'prompting', '');
  if(srv.username){
    session.activeUsername = srv.username;
    promptAuthStep(id, session);
    return;
  }
  session.term.write('login as: ');
  session.handleInput = createLinePrompter(
    function(value){
      session.term.write('\r\n');
      var username = value.trim();
      if(!username){
        session.term.writeln('사용자명이 필요합니다. 재연결 버튼으로 다시 시도해주세요.');
        setSshStatus(id, 'canceled', '');
        session.handleInput = function(){};
        return;
      }
      session.activeUsername = username;
      promptAuthStep(id, session);
    },
    function(){ session.term.write('^C\r\n'); session.term.writeln('연결이 취소되었습니다. 재연결 버튼으로 다시 시도할 수 있습니다.'); setSshStatus(id, 'canceled', ''); session.handleInput = function(){}; },
    { term: session.term, mask: false } // 아이디는 입력하는 대로 보여준다
  );
}

function promptAuthStep(id, session){
  var srv = session.srv, term = session.term;
  if(srv.authMethod === 'publickey'){
    term.write("Enter passphrase for key '" + (srv.keyFilePath || '') + "' (없으면 Enter): ");
    session.handleInput = createLinePrompter(
      function(value){ term.write('\r\n'); finishPrompt(id, session, { passphrase: value || undefined }); },
      function(){ term.write('^C\r\n'); term.writeln('연결이 취소되었습니다. 재연결 버튼으로 다시 시도할 수 있습니다.'); setSshStatus(id, 'canceled', ''); session.handleInput = function(){}; },
      { term: term, mask: true } // 비밀번호/Passphrase는 '*'로 표시
    );
  } else {
    term.write(session.activeUsername + '@' + srv.host + "'s password: ");
    session.handleInput = createLinePrompter(
      function(value){ term.write('\r\n'); finishPrompt(id, session, { password: value }); },
      function(){ term.write('^C\r\n'); term.writeln('연결이 취소되었습니다. 재연결 버튼으로 다시 시도할 수 있습니다.'); setSshStatus(id, 'canceled', ''); session.handleInput = function(){}; },
      { term: term, mask: true } // 비밀번호/Passphrase는 '*'로 표시
    );
  }
}

function finishPrompt(id, session, secretParams){
  var srv = session.srv, term = session.term;
  session.handleInput = function(){}; // 연결 결과가 오기 전까지 추가 키 입력은 무시
  setSshStatus(id, 'connecting', '');
  var params = {
    host: srv.host, port: srv.port || 22, username: session.activeUsername,
    authMethod: srv.authMethod, keyFilePath: srv.keyFilePath,
    cols: term.cols, rows: term.rows,
  };
  if(secretParams.password !== undefined) params.password = secretParams.password;
  if(secretParams.passphrase !== undefined) params.passphrase = secretParams.passphrase;

  window.onegyeok.ssh.connect(id, params).then(function(res){
    if(!sshSessions[id]) return; // 그 사이 탭이 닫혔을 수 있음
    // 'ssh:status' 푸시 이벤트가 이미 처리했을 수 있으므로, 아직 'connecting' 상태일 때만(= 아직
    // 아무도 처리 안 했을 때만) 이 응답을 기준으로 처리한다.
    if(!res.ok && sshSessions[id].state === 'connecting'){
      handleAuthFailureOrError(id, session, res.error, res.kind);
    }
  });
}

// 인증 관련 실패(auth/badkey)는 ssh 명령어처럼 그 자리에서 바로 재입력받고,
// 그 외(네트워크 오류 등)는 재입력해도 의미가 없으므로 바로 최종 에러로 표시한다.
function handleAuthFailureOrError(id, session, message, kind){
  var term = session.term;
  var retryable = (kind === 'auth' || kind === 'badkey');
  if(retryable && session.authAttempts < MAX_AUTH_ATTEMPTS - 1){
    session.authAttempts++;
    term.writeln('\r\n\x1b[31mPermission denied, please try again.\x1b[0m');
    setSshStatus(id, 'prompting', '');
    promptAuthStep(id, session);
  } else if(retryable){
    term.writeln('\r\n\x1b[31mPermission denied (' + (kind === 'badkey' ? 'publickey' : 'password') + ').\x1b[0m');
    setSshStatus(id, 'error', message);
    session.handleInput = function(){};
  } else {
    term.writeln('\r\n\x1b[31m' + (message || '연결 실패') + '\x1b[0m');
    setSshStatus(id, 'error', message);
    session.handleInput = function(){};
  }
}

function startSshSession(tabId, serverId, statusEl, hostEl){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv) return;

  var term = new window.Terminal({
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", "D2Coding", Consolas, monospace',
    fontSize: 13,
    theme: { background: '#18150f', foreground: '#ece7d8', cursor: '#e2a765' },
    cursorBlink: true,
    scrollback: 5000,
  });
  var fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(hostEl);
  term.attachCustomKeyEventHandler(terminalKeyPassthrough);

  var session = { term: term, fitAddon: fitAddon, statusEl: statusEl, hostEl: hostEl, state: 'prompting', handleInput: null, srv: srv, authAttempts: 0, activeUsername: null };
  sshSessions[tabId] = session;
  observeSshSize(tabId);
  statusEl.style.display = 'none';

  term.onData(function(data){ dispatchTerminalInput(tabId, data); });

  requestAnimationFrame(function(){ fitSshSession(tabId); });
  // 브로드캐스트 모드가 이미 켜져 있는 상태에서 새 SSH 탭이 열리면, 기본으로 그룹에 합류시킨다
  // (체크박스로 바로 빼낼 수 있음).
  if(broadcastMode){
    var newTab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
    if(newTab) setTabBroadcastChecked(newTab, true);
    updateBroadcastCount();
  }

  if(!hasSshBridge){
    term.writeln('SSH 연결 기능을 사용할 수 없습니다 (preload 브리지 없음)');
    setSshStatus(tabId, 'error', '');
    return;
  }

  term.writeln('Connecting to ' + srv.host + ':' + (srv.port || 22) + ' ...');
  promptAndConnect(tabId, session);
}

// startSession/attachSession 레지스트리 메서드가 공유하는 pane 뼈대(상태 표시 + xterm 호스트).
function buildSshPaneShell(tabId, el){
  el.className = 'pane ssh-pane';
  el.innerHTML = '<div class="ssh-connecting">연결 준비 중...</div><div class="xterm-host"></div>';
  return { statusEl: el.querySelector('.ssh-connecting'), hostEl: el.querySelector('.xterm-host') };
}

// 탭을 다른 창으로 끌어내 뺄 때(Stage B) 이 창(원래 창)에서 호출된다 — IPC 연결 종료 없이
// xterm Terminal·세션 맵 엔트리 등 로컬 UI 상태만 정리한다. main 프로세스의 실제 ssh2 연결은
// 살아있고, 새 창이 이어받는다.
function detachSshSessionLocal(tabId){
  var s = sshSessions[tabId];
  if(!s) return;
  try { s.term.dispose(); } catch(_e){ /* noop */ }
  if(s.ro) s.ro.disconnect();
  var serverId = s.srv && s.srv.id;
  delete sshSessions[tabId];
  broadcastSet.delete(tabId);
  if(broadcastMode) updateBroadcastCount();
  if(serverId) updateServerRowStatus(serverId);
}

// 다른 창에서 넘어온(이미 연결돼 있을 수 있는) 탭을 이 창에서 받을 때 호출된다 — 로그인
// 프롬프트를 건너뛰고 바로 터미널을 연다. 실제 상태(및 handleInput 활성화)는 메인 프로세스가
// 직후에 재전송하는 ssh:status 이벤트로 채워진다(아래 onStatus 리스너가 'connected'를 받으면
// handleInput을 실제 전송 함수로 바꾼다 — promptAndConnect를 거치지 않아도 동일하게 동작).
function attachSshSession(tabId, serverId, statusEl, hostEl){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv) return;

  var term = new window.Terminal({
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", "D2Coding", Consolas, monospace',
    fontSize: 13,
    theme: { background: '#18150f', foreground: '#ece7d8', cursor: '#e2a765' },
    cursorBlink: true,
    scrollback: 5000,
  });
  var fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(hostEl);
  term.attachCustomKeyEventHandler(terminalKeyPassthrough);

  var session = { term: term, fitAddon: fitAddon, statusEl: statusEl, hostEl: hostEl, state: 'connecting', handleInput: function(){}, srv: srv, authAttempts: 0, activeUsername: srv.username || null };
  sshSessions[tabId] = session;
  observeSshSize(tabId);
  statusEl.style.display = 'none';

  term.onData(function(data){ dispatchTerminalInput(tabId, data); });
  requestAnimationFrame(function(){ fitSshSession(tabId); });
  // 알려진 한계(known limitation): 이전 창의 스크롤백(터미널 출력 이력)은 옮겨오지 않는다 —
  // xterm 버퍼 직렬화는 이번 버전 범위 밖이라, 새 터미널은 빈 화면에서 시작해 다음 출력부터 보인다.
  term.writeln('\x1b[2m(다른 창에서 이어받음 — 이전 화면 내용은 표시되지 않습니다)\x1b[0m');

  if(broadcastMode){
    var newTab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
    if(newTab) setTabBroadcastChecked(newTab, true);
    updateBroadcastCount();
  }
}

function disposeSshSession(tabId){
  var s = sshSessions[tabId];
  if(!s) return;
  if(hasSshBridge) window.onegyeok.ssh.disconnect(tabId);
  try { s.term.dispose(); } catch(_e){ /* noop */ }
  if(s.ro) s.ro.disconnect();
  var serverId = s.srv && s.srv.id;
  delete sshSessions[tabId];
  broadcastSet.delete(tabId);
  if(broadcastMode) updateBroadcastCount();
  if(serverId) updateServerRowStatus(serverId);
}

// 화면 분할은 SSH 전용이 아니라 core/splitview.js(탭 드래그 앤 드롭 스플릿뷰)가 모든 프로토콜에 대해 맡는다.
// 여기서는 세션 하나(= pane 하나)의 터미널 크기 맞춤만 책임진다.
function observeSshSize(id){
  var s = sshSessions[id];
  if(!s || s.ro || !window.ResizeObserver) return;
  var raf = 0;
  s.ro = new ResizeObserver(function(){
    if(raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(function(){ raf = 0; if(sshSessions[id] && s.hostEl.clientWidth > 0) fitSshSession(id); });
  });
  s.ro.observe(s.hostEl);
}

if(hasSshBridge){
  window.onegyeok.ssh.onData(function(id, chunk){
    var s = sshSessions[id];
    if(s) s.term.write(chunk);
  });
  window.onegyeok.ssh.onStatus(function(id, status){
    var s = sshSessions[id];
    if(!s) return;
    if(status.state === 'connected'){
      setSshStatus(id, 'connected');
      s.handleInput = function(data){ window.onegyeok.ssh.input(id, data); };
      fitSshSession(id);
    } else if(status.state === 'error'){
      // finishPrompt의 invoke 응답이 이미 처리했을 수 있으므로, 아직 'connecting' 상태일 때만 처리한다.
      if(s.state === 'connecting') handleAuthFailureOrError(id, s, status.message, status.kind);
    } else if(status.state === 'disconnected'){
      s.term.writeln('\r\n\x1b[33m연결이 종료되었습니다.\x1b[0m');
      setSshStatus(id, 'disconnected', '연결이 종료되었습니다.');
      s.handleInput = function(){};
    }
  });
}

registerProtocol('ssh', {
  meta: { label:'SSH', icon:'<svg viewBox="0 0 20 20"><polyline points="3 5 8 10 3 15"></polyline><line x1="10" y1="15" x2="17" y2="15"></line></svg>' },

  startSession: function(tabId, serverId, el){
    var firstCell = buildSshPaneShell(tabId, el);
    startSshSession(tabId, serverId, firstCell.statusEl, firstCell.hostEl);
  },
  detachLocal: detachSshSessionLocal,
  attachSession: function(tabId, serverId, el){
    var firstCell = buildSshPaneShell(tabId, el);
    attachSshSession(tabId, serverId, firstCell.statusEl, firstCell.hostEl);
  },

  hasSession: function(tabId){ return !!sshSessions[tabId]; },
  getSession: function(tabId){ return sshSessions[tabId] || null; },
  disposeSession: function(tabId){ disposeSshSession(tabId); },
  isServerConnected: function(serverId){
    return Object.keys(sshSessions).some(function(tid){
      var s = sshSessions[tid];
      return s && s.srv && s.srv.id === serverId && s.state === 'connected';
    });
  },

  hasConnAction: true,
  onConnActionClick: function(tabId){
    var s = sshSessions[tabId];
    if(!s) return;
    if(s.state === 'connected'){
      if(hasSshBridge) window.onegyeok.ssh.disconnect(tabId);
    } else {
      s.term.writeln('');
      promptAndConnect(tabId, s);
    }
  },
  quickReconnect: function(tabId){
    var rs = sshSessions[tabId];
    if(rs && rs.state !== 'connected' && rs.state !== 'connecting' && rs.state !== 'prompting'){
      rs.term.writeln('');
      promptAndConnect(tabId, rs);
      activate(tabId); // 탭으로 바로 전환해 인증 프롬프트가 보이게 한다
    }
  },

  inspectorExtra: function(container, row){
    var jumpRow = document.getElementById('row-jump');
    jumpRow.style.display = '';
    document.getElementById('i-jump').textContent = row.dataset.jump;
  },

  registration: {
    renderExtra: function(container, existingServer){
      var currentId = existingServer ? existingServer.id : null;
      var jumpOpts = SERVERS.filter(function(s){ return s.protocol === 'ssh' && s.id !== currentId; })
        .map(function(s){ return '<option value="'+s.id+'">'+escapeHtml(s.name)+'</option>'; }).join('');
      container.innerHTML =
        '<label id="row-f-auth-method">인증 방식' +
          '<select id="f-auth-method"><option value="password">비밀번호</option><option value="publickey">SSH Key</option></select>' +
        '</label>' +
        '<label id="row-f-keypath" style="display:none">키 파일 경로' +
          '<div class="edit-filepick"><input type="text" id="f-key-path" placeholder="~/.ssh/id_rsa"><button type="button" class="insp-btn" id="pickKeyFileBtn">찾아보기</button></div>' +
        '</label>' +
        '<label id="row-f-jump">점프 호스트<select id="f-jump"><option value="">없음</option>'+jumpOpts+'</select></label>';

      document.getElementById('f-auth-method').value = existingServer ? existingServer.authMethod : 'password';
      document.getElementById('f-key-path').value = (existingServer && existingServer.keyFilePath) || '';
      document.getElementById('f-jump').value = (existingServer && existingServer.jump) || '';

      function refreshKeyPathVisibility(){
        document.getElementById('row-f-keypath').style.display =
          document.getElementById('f-auth-method').value === 'publickey' ? '' : 'none';
      }
      refreshKeyPathVisibility();
      document.getElementById('f-auth-method').addEventListener('change', refreshKeyPathVisibility);
      document.getElementById('pickKeyFileBtn').addEventListener('click', function(){
        if(!window.onegyeok || !window.onegyeok.pickKeyFile) return;
        window.onegyeok.pickKeyFile().then(function(res){
          if(res && !res.canceled && res.filePath) document.getElementById('f-key-path').value = res.filePath;
        });
      });
    },
    collectExtra: function(){
      var isKey = document.getElementById('f-auth-method').value === 'publickey';
      return {
        authMethod: isKey ? 'publickey' : 'password',
        keyFilePath: isKey ? (document.getElementById('f-key-path').value.trim() || null) : null,
        jump: document.getElementById('f-jump').value || null,
      };
    },
    defaultPortPlaceholder: function(){ return '22'; },
  },
});
