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
  refreshAllSessionPickers();
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
  });
  updateBroadcastCount();
}

broadcastToggleBtn.addEventListener('click', function(){ setBroadcastMode(!broadcastMode); });
document.getElementById('broadcastOffBtn').addEventListener('click', function(){ setBroadcastMode(false); });

// 터미널 안에서 한 줄을 로컬로 입력받는다 (비밀번호 입력처럼 화면에 echo하지 않음).
// 브로드캐스트 중에는 세션마다 독립된 버퍼를 가지므로, 같은 키 입력이 동시에 들어와도
// 각자 알아서 자기 줄을 완성하고 각자 접속을 진행한다.
function createLinePrompter(onSubmit, onCancel){
  var buf = '';
  return function handleInput(data){
    for(var i = 0; i < data.length; i++){
      var ch = data[i];
      var code = data.charCodeAt(i);
      if(ch === '\r' || ch === '\n'){
        var value = buf; buf = '';
        onSubmit(value);
        return;
      } else if(code === 3){ // Ctrl+C
        buf = '';
        onCancel();
        return;
      } else if(code === 127 || code === 8){ // Backspace
        buf = buf.slice(0, -1);
      } else if(code >= 32){
        buf += ch;
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
    function(){ session.term.write('^C\r\n'); session.term.writeln('연결이 취소되었습니다. 재연결 버튼으로 다시 시도할 수 있습니다.'); setSshStatus(id, 'canceled', ''); session.handleInput = function(){}; }
  );
}

function promptAuthStep(id, session){
  var srv = session.srv, term = session.term;
  if(srv.authMethod === 'publickey'){
    term.write("Enter passphrase for key '" + (srv.keyFilePath || '') + "' (없으면 Enter): ");
    session.handleInput = createLinePrompter(
      function(value){ term.write('\r\n'); finishPrompt(id, session, { passphrase: value || undefined }); },
      function(){ term.write('^C\r\n'); term.writeln('연결이 취소되었습니다. 재연결 버튼으로 다시 시도할 수 있습니다.'); setSshStatus(id, 'canceled', ''); session.handleInput = function(){}; }
    );
  } else {
    term.write(session.activeUsername + '@' + srv.host + "'s password: ");
    session.handleInput = createLinePrompter(
      function(value){ term.write('\r\n'); finishPrompt(id, session, { password: value }); },
      function(){ term.write('^C\r\n'); term.writeln('연결이 취소되었습니다. 재연결 버튼으로 다시 시도할 수 있습니다.'); setSshStatus(id, 'canceled', ''); session.handleInput = function(){}; }
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

  var session = { term: term, fitAddon: fitAddon, statusEl: statusEl, hostEl: hostEl, state: 'prompting', handleInput: null, srv: srv, authAttempts: 0, activeUsername: null };
  sshSessions[tabId] = session;
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

function disposeSshSession(tabId){
  var s = sshSessions[tabId];
  if(!s) return;
  if(hasSshBridge) window.onegyeok.ssh.disconnect(tabId);
  try { s.term.dispose(); } catch(_e){ /* noop */ }
  var serverId = s.srv && s.srv.id;
  delete sshSessions[tabId];
  broadcastSet.delete(tabId);
  if(broadcastMode) updateBroadcastCount();
  if(serverId) updateServerRowStatus(serverId);
  refreshAllSessionPickers();
}

// ==================================================================
// 탭 내 터미널 분할 (세션 복제 / 세션 선택 기반, tmux 비의존)
// docs/기능명세/04_터미널분할_기능명세.md — 분할로 생기는 새 pane에는 기본적으로 같은 서버의
// 새 독립 세션이 연결되고(F-216과 동일 원칙), pane 헤더의 세션 선택기로 이미 열려 있는 다른
// 세션(다른 탭 포함)을 그대로 가져와 이 자리에 배치할 수도 있다. v1은 한 탭 안에서 가로 일렬
// 또는 세로 일렬 중 하나의 방향만 지원한다(F-801).
// ==================================================================
var tabLayouts = {}; // tabId -> { orientation: 'row'|'column'|null, paneIds: string[] }
var splitSeq = 0;
var focusedPaneId = null;

function findTabForPane(paneId){
  for(var tabId in tabLayouts){
    if(tabLayouts[tabId].paneIds.indexOf(paneId) > -1) return tabId;
  }
  return null;
}

function sessionLabel(paneId){
  var s = sshSessions[paneId];
  if(!s || !s.srv) return paneId;
  var tab = tabbar.querySelector('.tab[data-id="'+paneId+'"]');
  var nameEl = tab && tab.querySelector('.tab-name');
  return (nameEl && nameEl.textContent) || s.srv.id;
}

function createPaneCellDom(paneId){
  var cellEl = document.createElement('div');
  cellEl.className = 'pane-cell';
  cellEl.dataset.paneId = paneId;
  var headerEl = document.createElement('div');
  headerEl.className = 'pane-cell-header';
  var labelEl = document.createElement('span');
  labelEl.className = 'pane-cell-label';
  var pickerEl = document.createElement('select');
  pickerEl.className = 'pane-cell-picker';
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pane-cell-close';
  closeBtn.title = 'pane 닫기';
  closeBtn.innerHTML = '<svg class="icon" viewBox="0 0 20 20" style="width:10px;height:10px"><line x1="5" y1="5" x2="15" y2="15"></line><line x1="15" y1="5" x2="5" y2="15"></line></svg>';
  headerEl.appendChild(labelEl);
  headerEl.appendChild(pickerEl);
  headerEl.appendChild(closeBtn);
  var statusEl = document.createElement('div');
  statusEl.className = 'ssh-connecting';
  statusEl.textContent = '연결 준비 중...';
  var hostEl = document.createElement('div');
  hostEl.className = 'xterm-host';
  cellEl.appendChild(headerEl);
  cellEl.appendChild(statusEl);
  cellEl.appendChild(hostEl);

  populateSessionPicker(pickerEl, paneId);
  pickerEl.addEventListener('change', function(){
    var chosen = pickerEl.value;
    pickerEl.value = '';
    if(chosen) moveSessionIntoCell(chosen, paneId);
  });
  closeBtn.addEventListener('click', function(e){ e.stopPropagation(); closePaneCell(paneId); });
  cellEl.addEventListener('mousedown', function(){ focusedPaneId = paneId; }, true);

  return { cellEl: cellEl, statusEl: statusEl, hostEl: hostEl };
}

// 자기 자신을 뺀, 지금 떠 있는 모든 SSH 세션이 후보. 세션이 뜨거나 닫힐 때마다 모든 picker를
// 다시 채워 항상 최신 상태를 보장한다(마우스다운 시점에만 채우면 키보드 접근성·테스트 자동화에서
// 값이 비어 보이는 문제가 있어, 생성 시 + 주요 상태 변화 시점에 미리 채워둔다).
function populateSessionPicker(pickerEl, forPaneId){
  var options = ['<option value="">— 세션 선택 —</option>'];
  Object.keys(sshSessions).forEach(function(pid){
    if(pid === forPaneId) return;
    options.push('<option value="'+escapeHtml(pid)+'">'+escapeHtml(sessionLabel(pid))+'</option>');
  });
  pickerEl.innerHTML = options.join('');
}

function refreshAllSessionPickers(){
  Array.prototype.slice.call(panes.querySelectorAll('.pane-cell')).forEach(function(cell){
    var pickerEl = cell.querySelector('.pane-cell-picker');
    if(pickerEl) populateSessionPicker(pickerEl, cell.dataset.paneId);
  });
}

function refreshPaneCellHeader(cellEl, paneId){
  var labelEl = cellEl.querySelector('.pane-cell-label');
  if(labelEl) labelEl.textContent = sessionLabel(paneId);
}

function rebuildResizers(tabId){
  var layout = tabLayouts[tabId];
  if(!layout) return;
  var container = panes.querySelector('.pane[data-id="'+tabId+'"] .pane-cells');
  if(!container) return;
  Array.prototype.slice.call(container.querySelectorAll('.pane-resizer')).forEach(function(r){ r.remove(); });
  if(layout.paneIds.length < 2) return;
  var cells = layout.paneIds.map(function(pid){ return container.querySelector('.pane-cell[data-pane-id="'+pid+'"]'); });
  for(var i = 0; i < cells.length - 1; i++){
    var resizer = document.createElement('div');
    resizer.className = 'pane-resizer ' + layout.orientation;
    container.insertBefore(resizer, cells[i + 1]);
    attachResizerDrag(resizer, cells[i], cells[i + 1], layout.orientation, tabId);
  }
}

function attachResizerDrag(resizer, beforeEl, afterEl, orientation, tabId){
  var dragging = false, startPos = 0, startBefore = 0, startAfter = 0;
  resizer.addEventListener('mousedown', function(e){
    dragging = true;
    resizer.classList.add('dragging');
    startPos = orientation === 'row' ? e.clientX : e.clientY;
    startBefore = orientation === 'row' ? beforeEl.offsetWidth : beforeEl.offsetHeight;
    startAfter = orientation === 'row' ? afterEl.offsetWidth : afterEl.offsetHeight;
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e){
    if(!dragging) return;
    var pos = orientation === 'row' ? e.clientX : e.clientY;
    var delta = pos - startPos;
    var newBefore = Math.max(60, startBefore + delta);
    var newAfter = Math.max(60, startAfter - delta);
    beforeEl.style.flex = '0 0 ' + newBefore + 'px';
    afterEl.style.flex = '0 0 ' + newAfter + 'px';
  });
  document.addEventListener('mouseup', function(){
    if(!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.userSelect = '';
    var layout = tabLayouts[tabId];
    if(layout) layout.paneIds.forEach(function(pid){ if(sshSessions[pid]) fitSshSession(pid); });
  });
}

function updateLayoutChrome(tabId){
  var layout = tabLayouts[tabId];
  var paneEl = panes.querySelector('.pane[data-id="'+tabId+'"]');
  if(!layout || !paneEl) return;
  var container = paneEl.querySelector('.pane-cells');
  container.classList.toggle('row', layout.orientation === 'row');
  container.classList.toggle('column', layout.orientation === 'column');
  container.classList.toggle('has-headers', layout.paneIds.length > 1);
  var splitControls = paneEl.querySelector('.pane-split-controls');
  // 분할 후에는 각 pane 헤더가 컨트롤을 맡는다 — 떠 있는 분할 버튼이 마지막 pane의 헤더(닫기 버튼 등)와
  // 겹치는 걸 막기 위해, 분할 전(pane 1개)에만 보여주고 이후 추가 분할은 단축키(⌘D/⌘⇧D)로 한다.
  if(splitControls) splitControls.style.display = layout.paneIds.length > 1 ? 'none' : '';
  layout.paneIds.forEach(function(pid){
    var cell = container.querySelector('.pane-cell[data-pane-id="'+pid+'"]');
    if(cell){
      cell.style.flex = '1 1 0';
      refreshPaneCellHeader(cell, pid);
    }
  });
  rebuildResizers(tabId);
  layout.paneIds.forEach(function(pid){ if(sshSessions[pid]) fitSshSession(pid); });
  refreshAllSessionPickers();
}

// 탭이 분할돼 있으면 그 안의 모든 pane을, 아니면 탭 자신의 세션 하나만 다시 맞춘다.
function fitAllPanesInTab(tabId){
  if(tabLayouts[tabId] && tabLayouts[tabId].paneIds.length > 1){
    tabLayouts[tabId].paneIds.forEach(function(pid){ if(sshSessions[pid]) fitSshSession(pid); });
  } else if(sshSessions[tabId]){
    fitSshSession(tabId);
  }
}

function splitPane(tabId, orientation){
  var layout = tabLayouts[tabId];
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(!layout || !tab) return;
  var serverId = tab.dataset.serverId;
  if(layout.paneIds.length === 1) layout.orientation = orientation;
  var newPaneId = tabId + '/p' + (++splitSeq);
  layout.paneIds.push(newPaneId);
  var dom = createPaneCellDom(newPaneId);
  panes.querySelector('.pane[data-id="'+tabId+'"] .pane-cells').appendChild(dom.cellEl);
  startSshSession(newPaneId, serverId, dom.statusEl, dom.hostEl);
  updateLayoutChrome(tabId);
}

function closePaneCell(paneId){
  var tabId = findTabForPane(paneId);
  if(!tabId) return;
  var layout = tabLayouts[tabId];
  disposeSession(paneId);
  layout.paneIds = layout.paneIds.filter(function(id){ return id !== paneId; });
  var cell = panes.querySelector('.pane-cell[data-pane-id="'+paneId+'"]');
  if(cell) cell.remove();
  if(layout.paneIds.length === 0){
    closeTabById(tabId, true);
    return;
  }
  if(layout.paneIds.length === 1) layout.orientation = null;
  updateLayoutChrome(tabId);
}

// pane 헤더의 세션 선택기로 다른 곳(다른 탭/다른 pane)의 세션을 이 자리로 가져온다.
// 원래 있던 자리의 세션은 옮겨질 뿐 끊기지 않고, 원래 자리가 비면 자동으로 정리된다(F-803/F-803a).
function moveSessionIntoCell(sourcePaneId, targetPaneId){
  if(sourcePaneId === targetPaneId || !sshSessions[sourcePaneId]) return;
  var srcTabId = findTabForPane(sourcePaneId);
  var targetTabId = findTabForPane(targetPaneId);
  if(!srcTabId || !targetTabId) return;
  var srcLayout = tabLayouts[srcTabId];
  var targetLayout = tabLayouts[targetTabId];
  var wasOnlyPane = srcLayout.paneIds.length === 1;

  var srcCell = panes.querySelector('.pane-cell[data-pane-id="'+sourcePaneId+'"]');
  var targetCellsContainer = panes.querySelector('.pane[data-id="'+targetTabId+'"] .pane-cells');
  var oldTargetCell = panes.querySelector('.pane-cell[data-pane-id="'+targetPaneId+'"]');
  if(!srcCell || !targetCellsContainer || !oldTargetCell) return;

  disposeSession(targetPaneId); // 타겟 자리에 있던 세션은 교체되면서 닫힌다

  targetCellsContainer.insertBefore(srcCell, oldTargetCell);
  oldTargetCell.remove();

  srcLayout.paneIds = srcLayout.paneIds.filter(function(id){ return id !== sourcePaneId; });
  var idx = targetLayout.paneIds.indexOf(targetPaneId);
  targetLayout.paneIds[idx] = sourcePaneId;

  if(wasOnlyPane){
    closeTabById(srcTabId, true);
  } else {
    if(srcLayout.paneIds.length === 1) srcLayout.orientation = null;
    updateLayoutChrome(srcTabId);
  }
  updateLayoutChrome(targetTabId);
  requestAnimationFrame(function(){
    fitSshSession(sourcePaneId);
    if(sshSessions[sourcePaneId]) sshSessions[sourcePaneId].term.focus();
  });
}

panes.addEventListener('click', function(e){
  var splitBtn = e.target.closest('.split-btn');
  if(!splitBtn) return;
  var paneEl = e.target.closest('.pane-layout');
  if(!paneEl) return;
  splitPane(paneEl.dataset.id, splitBtn.dataset.orientation);
});

// ⌘D/⌘⇧D로 세로/가로 분할(F-801~802), ⌘[/⌘]로 pane 간 포커스 이동(F-804)
document.addEventListener('keydown', function(e){
  if(!(e.metaKey || e.ctrlKey)) return;
  if(e.key.toLowerCase() === 'd'){
    var activeTab = tabbar.querySelector('.tab.active');
    if(!activeTab || activeTab.dataset.protocol !== 'ssh') return;
    e.preventDefault();
    splitPane(activeTab.dataset.id, e.shiftKey ? 'column' : 'row');
    return;
  }
  if(e.key === '[' || e.key === ']'){
    var activeTabEl = tabbar.querySelector('.tab.active');
    var tid = activeTabEl && activeTabEl.dataset.id;
    var layout = tid && tabLayouts[tid];
    if(!layout || layout.paneIds.length < 2) return;
    e.preventDefault();
    var curIdx = focusedPaneId ? layout.paneIds.indexOf(focusedPaneId) : 0;
    if(curIdx === -1) curIdx = 0;
    var nextIdx = e.key === ']' ? (curIdx + 1) % layout.paneIds.length : (curIdx - 1 + layout.paneIds.length) % layout.paneIds.length;
    focusedPaneId = layout.paneIds[nextIdx];
    Array.prototype.slice.call(panes.querySelectorAll('.pane-cell.focused')).forEach(function(c){ c.classList.remove('focused'); });
    var cell = panes.querySelector('.pane-cell[data-pane-id="'+focusedPaneId+'"]');
    if(cell){
      cell.classList.add('focused');
      if(sshSessions[focusedPaneId]) sshSessions[focusedPaneId].term.focus();
    }
  }
});

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

// 창 크기 변경 / 패널 드래그 리사이즈 시 현재 보이는 터미널(들)을 다시 맞춘다.
window.addEventListener('resize', function(){
  if(currentInspectedId) fitAllPanesInTab(currentInspectedId);
});
if(window.ResizeObserver){
  new ResizeObserver(function(){
    if(currentInspectedId) fitAllPanesInTab(currentInspectedId);
  }).observe(panes);
}

registerProtocol('ssh', {
  meta: { label:'SSH', icon:'<svg viewBox="0 0 20 20"><polyline points="3 5 8 10 3 15"></polyline><line x1="10" y1="15" x2="17" y2="15"></line></svg>' },

  startSession: function(tabId, serverId, el){
    el.className = 'pane pane-layout ssh-pane';
    el.innerHTML =
      '<div class="pane-split-controls">' +
        '<button type="button" class="split-btn" data-orientation="row" title="세로 분할 (⌘D)"><svg class="icon" viewBox="0 0 20 20" style="width:12px;height:12px"><rect x="2" y="2" width="7" height="16" rx="1"></rect><rect x="11" y="2" width="7" height="16" rx="1"></rect></svg></button>' +
        '<button type="button" class="split-btn" data-orientation="column" title="가로 분할 (⌘⇧D)"><svg class="icon" viewBox="0 0 20 20" style="width:12px;height:12px"><rect x="2" y="2" width="16" height="7" rx="1"></rect><rect x="2" y="11" width="16" height="7" rx="1"></rect></svg></button>' +
      '</div>' +
      '<div class="pane-cells"></div>';
    tabLayouts[tabId] = { orientation: null, paneIds: [tabId] };
    var firstCell = createPaneCellDom(tabId);
    el.querySelector('.pane-cells').appendChild(firstCell.cellEl);
    startSshSession(tabId, serverId, firstCell.statusEl, firstCell.hostEl);
    updateLayoutChrome(tabId);
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
