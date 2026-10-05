// ==================================================================
// SQL DB 클라이언트 (디비버 느낌의 "SQL" 연결 종류) — MySQL/PostgreSQL/MS SQL Server
//
// SSH와 동일한 보안 원칙: 비밀번호는 저장하지 않고, 탭 안의 접속 폼에 그때그때 직접
// 입력받는다. 터미널이 아니라 쿼리 에디터 + 결과 테이블로 구성된 일반적인 폼 UI라서,
// SSH처럼 키 입력을 가로채는 방식 대신 평범한 input/textarea를 그대로 사용한다.
// ==================================================================
var SQL_ENGINE_LABELS = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', mssql: 'MS SQL Server' };
var SQL_DEFAULT_PORTS = { mysql: 3306, postgres: 5432, mssql: 1433 };

var dbSessions = {}; // tabId -> { state, srv, el, dom }
var hasDbBridge = !!(window.onegyeok && window.onegyeok.db);

function setDbStatus(tabId, state, message){
  var s = dbSessions[tabId];
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

function buildSqlPaneDom(el){
  el.innerHTML =
    '<div class="sql-connect">' +
      '<div class="sql-connect-box">' +
        '<div class="sql-connect-title"></div>' +
        '<label class="sql-f-username-row" style="display:none">사용자명<input type="text" class="sql-f-username" autocomplete="off"></label>' +
        '<label>비밀번호<input type="password" class="sql-f-password" autocomplete="off"></label>' +
        '<div class="sql-connect-error"></div>' +
        '<button type="button" class="sql-connect-btn">접속</button>' +
      '</div>' +
    '</div>' +
    '<div class="sql-workspace">' +
      '<div class="sql-toolbar">' +
        '<button type="button" class="sql-run-btn">실행 ▶</button>' +
        '<span class="sql-run-hint">⌘/Ctrl+Enter</span>' +
        '<span class="sql-meta"></span>' +
      '</div>' +
      '<textarea class="sql-editor" placeholder="SELECT * FROM ..." spellcheck="false"></textarea>' +
      '<div class="sql-error-box" style="display:none"></div>' +
      '<div class="sql-results-wrap"><div class="sql-empty-note">쿼리를 실행하면 결과가 여기에 표시됩니다.</div></div>' +
    '</div>';
  return {
    titleEl: el.querySelector('.sql-connect-title'),
    usernameRow: el.querySelector('.sql-f-username-row'),
    usernameInput: el.querySelector('.sql-f-username'),
    passwordInput: el.querySelector('.sql-f-password'),
    connectError: el.querySelector('.sql-connect-error'),
    connectBtn: el.querySelector('.sql-connect-btn'),
    runBtn: el.querySelector('.sql-run-btn'),
    meta: el.querySelector('.sql-meta'),
    editor: el.querySelector('.sql-editor'),
    errorBox: el.querySelector('.sql-error-box'),
    resultsWrap: el.querySelector('.sql-results-wrap'),
  };
}

function renderSqlResults(dom, result){
  dom.errorBox.style.display = 'none';
  if(!result.columns || !result.columns.length){
    dom.resultsWrap.innerHTML = '<div class="sql-empty-note">'+escapeHtml(result.message || ('영향받은 행 ' + result.rowCount + '개'))+'</div>';
  } else {
    var thead = '<thead><tr>' + result.columns.map(function(c){ return '<th>'+escapeHtml(c)+'</th>'; }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + result.rows.map(function(row){
      return '<tr>' + result.columns.map(function(c){
        var v = row[c];
        return '<td>'+escapeHtml(v === null || v === undefined ? 'NULL' : String(v))+'</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody>';
    dom.resultsWrap.innerHTML = '<table class="sql-results-table">'+thead+tbody+'</table>';
  }
  dom.meta.textContent = result.rowCount + '행 · ' + result.durationMs + 'ms';
}

function runSqlQuery(tabId){
  var s = dbSessions[tabId];
  if(!s || s.state !== 'connected') return;
  var sql = s.dom.editor.value.trim();
  if(!sql) return;
  s.dom.runBtn.disabled = true;
  s.dom.errorBox.style.display = 'none';
  window.onegyeok.db.query(tabId, sql).then(function(res){
    if(!dbSessions[tabId]) return;
    s.dom.runBtn.disabled = false;
    if(res.ok){
      renderSqlResults(s.dom, res);
    } else {
      s.dom.errorBox.textContent = res.error || '쿼리 실행 실패';
      s.dom.errorBox.style.display = '';
    }
  });
}

// 연결이 끊기거나 재연결 버튼을 누르면 접속 폼을 다시 보여준다(비밀번호는 매번 새로 입력).
function showDbConnectForm(tabId){
  var s = dbSessions[tabId];
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

function attemptDbConnect(tabId){
  var s = dbSessions[tabId];
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
  setDbStatus(tabId, 'connecting', '');
  window.onegyeok.db.connect(tabId, {
    engine: srv.sqlEngine, host: srv.host, port: srv.port, username: username,
    password: password, database: srv.database || undefined,
  }).then(function(res){
    if(!dbSessions[tabId]) return;
    s.dom.connectBtn.disabled = false;
    s.dom.connectBtn.textContent = '접속';
    if(res.ok){
      s.el.classList.add('connected');
      setDbStatus(tabId, 'connected', '');
      setTimeout(function(){ s.dom.editor.focus(); }, 0);
    } else {
      s.dom.connectError.textContent = res.error || '연결 실패';
      setDbStatus(tabId, 'error', res.error);
    }
  });
}

// 연결된 상태에서 "연결 종료"를 누르면 탭은 유지한 채 다시 접속 폼으로 되돌린다.
function disconnectDbKeepTab(tabId){
  var s = dbSessions[tabId];
  if(!s) return;
  if(hasDbBridge) window.onegyeok.db.disconnect(tabId);
  setDbStatus(tabId, 'disconnected', '연결이 종료되었습니다.');
  showDbConnectForm(tabId);
}

function startDbSession(tabId, serverId, el){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv) return;
  el.className = 'pane sql-pane';
  var dom = buildSqlPaneDom(el);
  dom.titleEl.textContent = (SQL_ENGINE_LABELS[srv.sqlEngine] || srv.sqlEngine) + ' · ' + srv.host + ':' + (srv.port || '') + (srv.database ? ' / ' + srv.database : '');
  var showUsernameField = !srv.username;
  dom.usernameRow.style.display = showUsernameField ? '' : 'none';

  var session = { state: 'disconnected', srv: srv, el: el, dom: dom };
  dbSessions[tabId] = session;

  dom.connectBtn.addEventListener('click', function(){ attemptDbConnect(tabId); });
  dom.passwordInput.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); attemptDbConnect(tabId); } });
  dom.runBtn.addEventListener('click', function(){ runSqlQuery(tabId); });
  dom.editor.addEventListener('keydown', function(e){
    if((e.metaKey || e.ctrlKey) && e.key === 'Enter'){ e.preventDefault(); runSqlQuery(tabId); }
  });

  if(!hasDbBridge){
    dom.connectError.textContent = 'DB 연결 기능을 사용할 수 없습니다 (preload 브리지 없음)';
    dom.connectBtn.disabled = true;
    return;
  }
  setTimeout(function(){
    if(showUsernameField) dom.usernameInput.focus(); else dom.passwordInput.focus();
  }, 0);
}

function disposeDbSession(tabId){
  var s = dbSessions[tabId];
  if(!s) return;
  if(hasDbBridge) window.onegyeok.db.disconnect(tabId);
  var serverId = s.srv && s.srv.id;
  delete dbSessions[tabId];
  if(serverId) updateServerRowStatus(serverId);
}

if(hasDbBridge && window.onegyeok.db.onStatus){
  window.onegyeok.db.onStatus(function(id, status){
    var s = dbSessions[id];
    if(!s) return;
    if(status.state === 'disconnected' && s.state === 'connected'){
      setDbStatus(id, 'disconnected', '연결이 종료되었습니다.');
      showDbConnectForm(id);
    }
  });
}

registerProtocol('sql', {
  meta: { label:'SQL', icon:'<svg viewBox="0 0 20 20"><ellipse cx="10" cy="5" rx="7" ry="2.6"></ellipse><path d="M3 5v10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V5"></path><path d="M3 10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"></path></svg>' },

  startSession: startDbSession,
  hasSession: function(tabId){ return !!dbSessions[tabId]; },
  getSession: function(tabId){ return dbSessions[tabId] || null; },
  disposeSession: function(tabId){ disposeDbSession(tabId); },
  isServerConnected: function(serverId){
    return Object.keys(dbSessions).some(function(tid){
      var s = dbSessions[tid];
      return s && s.srv && s.srv.id === serverId && s.state === 'connected';
    });
  },

  hasConnAction: true,
  onConnActionClick: function(tabId){
    var d = dbSessions[tabId];
    if(!d) return;
    if(d.state === 'connected') disconnectDbKeepTab(tabId);
    else attemptDbConnect(tabId);
  },
  quickReconnect: function(tabId){
    var rd = dbSessions[tabId];
    if(rd && rd.state !== 'connected' && rd.state !== 'connecting'){
      showDbConnectForm(tabId);
      activate(tabId);
    }
  },

  inspectorExtra: function(container, row){
    document.getElementById('row-sql-engine').style.display = '';
    document.getElementById('row-sql-database').style.display = '';
    document.getElementById('i-sql-engine').textContent = SQL_ENGINE_LABELS[row.dataset.sqlEngine] || row.dataset.sqlEngine;
    document.getElementById('i-sql-database').textContent = row.dataset.database || '(기본값)';
  },

  registration: {
    renderExtra: function(container, existingServer){
      container.innerHTML =
        '<label id="row-f-sql-engine">DB 엔진' +
          '<select id="f-sql-engine"><option value="mysql">MySQL / MariaDB</option><option value="postgres">PostgreSQL</option><option value="mssql">MS SQL Server</option></select>' +
        '</label>' +
        '<label id="row-f-database">데이터베이스 <span style="font-weight:400;color:var(--text-faint);">(선택)</span><input type="text" id="f-database" placeholder="비워두면 서버 기본값 사용"></label>';
      document.getElementById('f-sql-engine').value = (existingServer && existingServer.sqlEngine) || 'mysql';
      document.getElementById('f-database').value = (existingServer && existingServer.database) || '';
      document.getElementById('f-sql-engine').addEventListener('change', updatePortPlaceholder);
    },
    collectExtra: function(){
      return {
        sqlEngine: document.getElementById('f-sql-engine').value,
        database: document.getElementById('f-database').value.trim(),
      };
    },
    defaultPortPlaceholder: function(container){
      var sel = container.querySelector('#f-sql-engine');
      return String(SQL_DEFAULT_PORTS[sel ? sel.value : 'mysql'] || 3306);
    },
  },
});
