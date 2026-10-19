// ==================================================================
// 로컬 터미널 — 이 PC의 셸(cmd/PowerShell/Git Bash/WSL, macOS는 zsh·bash)을 탭으로 연다(main: src/main/protocols/local).
// git 같은 로컬 도구를 앱을 벗어나지 않고 쓰기 위한 것. 레일의 "로컬 터미널" 버튼을 누르면 빈 화면에 셸 고르기 버튼이 뜨고,
// 고른 셸은 "빠른 연결" 그룹에 임시 항목(host = 셸 id)으로 남아 다시 열 수 있다.
// 복사/붙여넣기 단축키는 SSH 터미널과 같다(keyboard-shortcuts.js terminalKeyPassthrough).
// ==================================================================
var localSessions = {}; // tabId -> { term, fitAddon, statusEl, hostEl, state, srv, ro }
var hasLocalBridge = !!(window.onegyeok && window.onegyeok.local);

function setLocalStatus(tabId, state, message){
  var s = localSessions[tabId];
  if(!s) return;
  s.state = state;
  s.statusEl.style.display = (state === 'disconnected' || state === 'error') ? '' : 'none';
  s.statusEl.textContent = message || '';
  s.statusEl.classList.toggle('err', state === 'error');
  if(s.srv) updateServerRowStatus(s.srv.id);
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(tab){
    var dot = tab.querySelector('.proto-chip .stat');
    if(dot) dot.classList.toggle('on', state === 'connected');
    var reconnectBtn = tab.querySelector('.tab-reconnect');
    if(reconnectBtn) reconnectBtn.classList.toggle('show', state === 'disconnected' || state === 'error');
  }
  if(currentInspectedId === tabId) updateConnActionButton(tabId);
}

function fitLocalSession(id){
  var s = localSessions[id];
  if(!s) return;
  try {
    s.fitAddon.fit();
    if(s.state === 'connected' && hasLocalBridge) window.onegyeok.local.resize(id, s.term.cols, s.term.rows);
  } catch(_e){ /* 패널이 아직 안 보이면 치수 계산이 실패할 수 있다 */ }
}

function createLocalTerminal(tabId, serverId, el, state){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv) return null;
  el.className = 'pane ssh-pane local-pane';
  el.innerHTML = '<div class="ssh-connecting">셸 시작 중...</div><div class="xterm-host"></div>';
  var statusEl = el.querySelector('.ssh-connecting'), hostEl = el.querySelector('.xterm-host');
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
  term.attachCustomKeyEventHandler(function(e){ return terminalKeyPassthrough(e, term); });
  var session = { term: term, fitAddon: fitAddon, statusEl: statusEl, hostEl: hostEl, state: state, srv: srv, ro: null };
  localSessions[tabId] = session;
  statusEl.style.display = 'none';
  term.onData(function(data){
    if(session.state === 'connected' && hasLocalBridge) window.onegyeok.local.input(tabId, data);
  });
  if(window.ResizeObserver){
    var raf = 0;
    session.ro = new ResizeObserver(function(){
      if(raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function(){ raf = 0; if(localSessions[tabId] && hostEl.clientWidth > 0) fitLocalSession(tabId); });
    });
    session.ro.observe(hostEl);
  }
  requestAnimationFrame(function(){ fitLocalSession(tabId); });
  return session;
}

function spawnLocalShell(tabId){
  var s = localSessions[tabId];
  if(!s || !hasLocalBridge) return;
  setLocalStatus(tabId, 'connecting', '');
  fitLocalSession(tabId);
  window.onegyeok.local.spawn(tabId, { shell: s.srv.host, cols: s.term.cols, rows: s.term.rows, serverName: s.srv.name }).then(function(res){
    if(!localSessions[tabId]) return;
    if(!res.ok){
      s.term.writeln('\x1b[31m' + (res.error || '셸을 시작할 수 없습니다') + '\x1b[0m');
      setLocalStatus(tabId, 'error', res.error);
    }
  });
}

function disposeLocalSession(tabId, keepProcess){
  var s = localSessions[tabId];
  if(!s) return;
  if(!keepProcess && hasLocalBridge) window.onegyeok.local.kill(tabId);
  try { s.term.dispose(); } catch(_e){ /* noop */ }
  if(s.ro) s.ro.disconnect();
  var serverId = s.srv && s.srv.id;
  delete localSessions[tabId];
  if(serverId) updateServerRowStatus(serverId);
}

if(hasLocalBridge){
  window.onegyeok.local.onData(function(id, chunk){
    var s = localSessions[id];
    if(s) s.term.write(chunk);
  });
  window.onegyeok.local.onStatus(function(id, status){
    var s = localSessions[id];
    if(!s) return;
    if(status.state === 'connected'){
      setLocalStatus(id, 'connected', '');
      fitLocalSession(id);
      setTimeout(function(){ if(localSessions[id]) s.term.focus(); }, 0);
    } else if(status.state === 'disconnected'){
      s.term.writeln('\r\n\x1b[33m셸이 종료되었습니다' + (status.exitCode ? ' (코드 ' + status.exitCode + ')' : '') + '. 재연결 버튼으로 새로 시작할 수 있습니다.\x1b[0m');
      setLocalStatus(id, 'disconnected', '셸이 종료되었습니다.');
    }
  });
}

// 빈 화면(레일에서 "로컬 터미널"을 눌렀고 열린 탭이 없을 때)의 셸 고르기 — core/quick-connect.js가 호출한다.
function renderLocalLauncher(container){
  container.innerHTML = '<div class="qc-form local-launch"><div class="qc-title">로컬 터미널</div>' +
    '<div class="local-shells">불러오는 중...</div><div class="qc-hint local-git-hint" hidden></div></div>' +
    '<div class="qc-recent" data-filter="local"></div>';
  if(!hasLocalBridge){ container.querySelector('.local-shells').textContent = '로컬 터미널을 사용할 수 없습니다 (preload 브리지 없음)'; return; }
  window.onegyeok.local.shells().then(function(info){
    var box = container.querySelector('.local-shells');
    if(!box) return;
    box.innerHTML = info.shells.map(function(sh){
      return '<button type="button" class="qc-go local-shell-btn" data-shell="' + escapeHtml(sh.id) + '">' + escapeHtml(sh.label) + '</button>';
    }).join('') || '사용할 수 있는 셸이 없습니다.';
    box.querySelectorAll('.local-shell-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        openQuickServer({ protocol: 'local', host: btn.dataset.shell, port: null, label: btn.textContent });
      });
    });
    var hint = container.querySelector('.local-git-hint');
    if(!info.hasGit){
      hint.textContent = 'Git이 설치되어 있지 않아 git 명령을 쓸 수 없습니다. Git for Windows(git-scm.com)를 설치하면 git 명령과 Git Bash를 바로 쓸 수 있습니다.';
      hint.hidden = false;
    }
  });
  if(typeof refreshQuickRecent === 'function') refreshQuickRecent();
}

registerProtocol('local', {
  meta: { label:'로컬 터미널', icon:'<svg viewBox="0 0 20 20"><rect x="2.5" y="3.5" width="15" height="13" rx="1.6"></rect><polyline points="6 8 8.5 10.5 6 13"></polyline><line x1="10.5" y1="13" x2="14" y2="13"></line></svg>' },

  startSession: function(tabId, serverId, el){
    var s = createLocalTerminal(tabId, serverId, el, 'connecting');
    if(!s) return;
    if(!hasLocalBridge){ s.term.writeln('로컬 터미널을 사용할 수 없습니다 (preload 브리지 없음)'); setLocalStatus(tabId, 'error', ''); return; }
    spawnLocalShell(tabId);
  },
  // 탭을 다른 창으로 옮길 때 셸 프로세스는 그대로 두고 화면만 정리한다(ssh와 같음). 새 창은 이후 출력부터 보인다.
  detachLocal: function(tabId){ disposeLocalSession(tabId, true); },
  attachSession: function(tabId, serverId, el){
    var s = createLocalTerminal(tabId, serverId, el, 'connecting');
    if(s) s.term.writeln('\x1b[2m(다른 창에서 이어받음 — 이전 화면 내용은 표시되지 않습니다)\x1b[0m');
  },

  hasSession: function(tabId){ return !!localSessions[tabId]; },
  getSession: function(tabId){ return localSessions[tabId] || null; },
  disposeSession: function(tabId){ disposeLocalSession(tabId, false); },
  isServerConnected: function(serverId){
    return Object.keys(localSessions).some(function(tid){
      var s = localSessions[tid];
      return s && s.srv && s.srv.id === serverId && s.state === 'connected';
    });
  },

  hasConnAction: true,
  onConnActionClick: function(tabId){
    var s = localSessions[tabId];
    if(!s) return;
    if(s.state === 'connected'){ if(hasLocalBridge) window.onegyeok.local.kill(tabId); setLocalStatus(tabId, 'disconnected', '셸을 종료했습니다.'); }
    else { s.term.writeln(''); spawnLocalShell(tabId); }
  },
  quickReconnect: function(tabId){
    var s = localSessions[tabId];
    if(s && s.state !== 'connected' && s.state !== 'connecting'){ s.term.writeln(''); spawnLocalShell(tabId); activate(tabId); }
  },

  renderQuickLaunch: renderLocalLauncher,
});
