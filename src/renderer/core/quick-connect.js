// 빠른 연결 — 서버를 등록하지 않고 주소만 입력해 바로 여는 기능(Web/SFTP·FTP/SSH/SQL/RDP/VNC).
// 해당 프로토콜 레일 버튼을 눌러 열린 세션이 없을 때 빈 화면(emptyPane)에 뜬다.
// 입력한 대상은 사이드바 "빠른 연결" 그룹에 임시 서버(temp:true)로 만들어 기존 selectServer 흐름을 그대로 쓴다.
// 이력은 프로토콜별 최신 5개만 유지하고(호스트/포트만 — 사용자명·비밀번호는 저장하지 않음) 개별 삭제할 수 있다.
// 주소를 잘못 입력했을 때는 열린 탭 위의 주소 바(#qcAddrBar)에서 고쳐 다시 연결한다(Web은 자체 주소창이 있음).
var QUICK_GROUP = '빠른 연결';
var QUICK_MAX_PER_PROTOCOL = 5;
var quickConnectEl = document.getElementById('quickConnect');
var qcAddrBarEl = document.getElementById('qcAddrBar');

var QUICK_SQL_DEFAULT_PORTS = { mysql: 3306, postgres: 5432, mssql: 1433 };
var QUICK_SQL_LABELS = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', mssql: 'MS SQL Server' };

function quickServerId(label){
  var base = label, n = 1;
  while(SERVERS.some(function(s){ return s.id === base; })){ n++; base = label + ' (' + n + ')'; }
  return base;
}

function quickDefaultPort(rec){
  if(rec.protocol === 'ssh') return 22;
  if(rec.protocol === 'rdp') return 3389;
  if(rec.protocol === 'vnc') return 5900;
  if(rec.protocol === 'sql') return QUICK_SQL_DEFAULT_PORTS[rec.sqlEngine] || 3306;
  if(rec.protocol === 'sftp') return rec.fileProtocol === 'sftp' ? 22 : rec.fileProtocol === 'ftps-implicit' ? 990 : 21;
  return null;
}

function quickLabelFor(rec){
  var hp = joinHostPort(rec.host, rec.port);
  if(rec.protocol === 'web') return rec.host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if(rec.protocol === 'sftp') return (rec.fileProtocol || 'sftp').toUpperCase() + ' ' + hp;
  if(rec.protocol === 'sql') return (rec.sqlEngine || 'mysql').toUpperCase() + ' ' + hp;
  return hp;
}

function quickServers(protocol){
  return SERVERS.filter(function(s){ return s.temp && s.group === QUICK_GROUP && (!protocol || s.protocol === protocol); });
}

function quickHasOpenTab(serverId){
  return !!tabbar.querySelector('.tab[data-server-id="' + serverId + '"]');
}

// 프로토콜별로 최신 5개만 남긴다 — 탭이 열려 있는 항목은 지우지 않는다.
function pruneQuickHistory(protocol){
  var list = quickServers(protocol).sort(function(a, b){ return (b.qcAt || 0) - (a.qcAt || 0); });
  list.slice(QUICK_MAX_PER_PROTOCOL).forEach(function(s){
    if(quickHasOpenTab(s.id)) return;
    SERVERS = SERVERS.filter(function(x){ return x.id !== s.id; });
  });
}

function removeQuickServer(serverId){
  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  if(!srv || !srv.temp) return;
  removeServerById(serverId);
  renderTree();
  if(typeof renderManageTable === 'function') renderManageTable();
  refreshQuickRecent();
}

// 서버 레코드를 만들거나(같은 주소가 있으면 재사용하고 맨 위로) 반환한다. 탭은 열지 않는다.
function ensureQuickServer(rec){
  var existing = SERVERS.find(function(s){
    return s.temp && s.protocol === rec.protocol && s.host === rec.host && (s.port || null) === (rec.port || null) &&
      (s.fileProtocol || null) === (rec.fileProtocol || null) && (s.sqlEngine || null) === (rec.sqlEngine || null) &&
      (s.database || '') === (rec.database || '');
  });
  var srv = existing;
  if(!srv){
    srv = {
      id: quickServerId(rec.label || quickLabelFor(rec)), name: '', group: QUICK_GROUP, protocol: rec.protocol, host: rec.host, port: rec.port,
      username: '', authMethod: 'password', keyFilePath: null, jump: null, sqlEngine: rec.sqlEngine || null, database: rec.database || '',
      fileProtocol: rec.fileProtocol || null, temp: true, status: 'off', since: '연결 안 됨'
    };
    srv.name = srv.id;
    srv.auth = authLabel(srv);
    SERVERS.push(srv);
    if(GROUP_ORDER.indexOf(QUICK_GROUP) === -1) GROUP_ORDER.push(QUICK_GROUP);
  }
  srv.qcAt = Date.now();
  pruneQuickHistory(rec.protocol);
  renderTree();
  populateGroupSelectors();
  return srv;
}

function openQuickServer(rec){
  var srv = ensureQuickServer(rec);
  selectServer(srv.id);
}

// "10.0.0.5:8443"처럼 스킴 없이 포트가 붙은 입력은 host/port로 나누고, 스킴이 있으면 그대로 host에 둔다(web.js가 URL로 조립).
function parseQuickWebInput(raw){
  var v = raw.trim();
  if(!v) return null;
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(v)){
    if(!/^https?:\/\//i.test(v)) return null;
    return { host: v, port: null };
  }
  // host[:port][/path?query#hash] — 경로가 붙어 있어도 포트를 분리해야 http/https 판단이 맞는다(경로는 host 뒤에 그대로 붙여 둠).
  var m = /^([^:/\s?#]+)(?::(\d{1,5}))?([/?#]\S*)?$/.exec(v);
  if(!m) return null;
  return { host: m[1] + (m[3] || ''), port: m[2] ? parseInt(m[2], 10) : null };
}

// ---- 빈 화면의 빠른 연결 폼 ----
var QUICK_FORMS = {
  web:  { title: '빠른 주소 열기' },
  sftp: { title: '빠른 SFTP / FTP / FTPS 연결', hint: '사용자명/비밀번호는 다음 화면에서 입력합니다 (저장되지 않음).' },
  ssh:  { title: '빠른 SSH 연결', hint: '사용자명/비밀번호는 접속 후 터미널에서 입력합니다 (저장되지 않음).' },
  sql:  { title: '빠른 SQL 연결', hint: '사용자명/비밀번호는 다음 화면에서 입력합니다 (저장되지 않음).' },
  rdp:  { title: '빠른 RDP 연결', hint: '사용자명/비밀번호는 다음 화면에서 입력합니다 (저장되지 않음).' },
  vnc:  { title: '빠른 VNC 연결', hint: '비밀번호는 다음 화면에서 입력합니다 (저장되지 않음).' }
};

function quickFormHtml(filter){
  var cfg = QUICK_FORMS[filter];
  var row;
  if(filter === 'web'){
    row = '<input class="qc-url" type="text" placeholder="주소 입력 (예: https://10.0.0.5, example.com:8443)" spellcheck="false">';
  } else {
    var extra = '';
    if(filter === 'sftp') extra = '<select class="qc-mode"><option value="sftp">SFTP (SSH)</option><option value="ftps">FTPS (TLS 권장)</option><option value="ftp">FTP (평문)</option><option value="ftps-implicit">FTPS implicit</option></select>';
    if(filter === 'sql') extra = '<select class="qc-engine"><option value="mysql">MySQL / MariaDB</option><option value="postgres">PostgreSQL</option><option value="mssql">MS SQL Server</option></select>';
    row = extra + '<input class="qc-host" type="text" placeholder="호스트 (예: 10.0.0.5)" spellcheck="false">' +
      '<input class="qc-port" type="text" inputmode="numeric" maxlength="5">';
  }
  return '<form class="qc-form" autocomplete="off" data-filter="' + filter + '">' +
    '<div class="qc-title">' + cfg.title + '</div>' +
    '<div class="qc-row">' + row + '<button type="submit" class="qc-go">' + (filter === 'web' ? '열기' : '접속') + '</button></div>' +
    (filter === 'sql' ? '<div class="qc-row"><input class="qc-db" type="text" placeholder="데이터베이스 (선택)" spellcheck="false"></div>' : '') +
    (cfg.hint ? '<div class="qc-hint">' + cfg.hint + '</div>' : '') +
    '<div class="qc-error"></div>' +
  '</form><div class="qc-recent" data-filter="' + filter + '"></div>';
}

function quickRecentLabel(s){
  if(s.protocol === 'web') return s.host.replace(/^https?:\/\//i, '');
  return s.name;
}

function refreshQuickRecent(){
  if(!quickConnectEl) return;
  var box = quickConnectEl.querySelector('.qc-recent');
  if(!box) return;
  var filter = box.dataset.filter;
  var list = quickServers(filter).sort(function(a, b){ return (b.qcAt || 0) - (a.qcAt || 0); }).slice(0, QUICK_MAX_PER_PROTOCOL);
  if(!list.length){ box.innerHTML = ''; return; }
  box.innerHTML = '<div class="qc-recent-title">최근 연결</div>' + list.map(function(s){
    return '<div class="qc-recent-item" data-id="' + escapeHtml(s.id) + '"><button type="button" class="qc-recent-open" title="다시 연결">' +
      escapeHtml(quickRecentLabel(s)) + '</button><button type="button" class="qc-recent-del" title="이력에서 삭제" aria-label="삭제">×</button></div>';
  }).join('');
}

function renderQuickConnect(filter){
  if(!quickConnectEl) return;
  quickConnectEl.hidden = true;
  quickConnectEl.innerHTML = '';
  if(!QUICK_FORMS[filter]) return;
  quickConnectEl.innerHTML = quickFormHtml(filter);
  var f = quickConnectEl.querySelector('form');
  var err = f.querySelector('.qc-error');
  if(filter !== 'web'){
    var modeEl = f.querySelector('.qc-mode'), engineEl = f.querySelector('.qc-engine'), portEl = f.querySelector('.qc-port');
    var curRec = function(){ return { protocol: filter, fileProtocol: modeEl ? modeEl.value : null, sqlEngine: engineEl ? engineEl.value : null }; };
    var syncPlaceholder = function(){ portEl.placeholder = String(quickDefaultPort(curRec())); };
    if(modeEl) modeEl.addEventListener('change', syncPlaceholder);
    if(engineEl) engineEl.addEventListener('change', syncPlaceholder);
    syncPlaceholder();
  }
  f.addEventListener('submit', function(e){
    e.preventDefault();
    err.textContent = '';
    if(filter === 'web'){
      var parsed = parseQuickWebInput(f.querySelector('.qc-url').value);
      if(!parsed){ err.textContent = 'http/https 주소를 입력해주세요.'; return; }
      openQuickServer({ protocol: 'web', host: parsed.host, port: parsed.port });
      return;
    }
    var hp = parseHostPort(f.querySelector('.qc-host').value.trim());
    if(!hp.host || /\s/.test(hp.host)){ err.textContent = '호스트를 입력해주세요.'; return; }
    var rec = { protocol: filter, host: hp.host };
    var mode = f.querySelector('.qc-mode'), engine = f.querySelector('.qc-engine'), db = f.querySelector('.qc-db');
    if(mode) rec.fileProtocol = mode.value;
    if(engine) rec.sqlEngine = engine.value;
    if(db) rec.database = db.value.trim();
    var portStr = f.querySelector('.qc-port').value.trim();
    rec.port = hp.port || (portStr ? parseInt(portStr, 10) : quickDefaultPort(rec));
    if(!(rec.port > 0 && rec.port < 65536)){ err.textContent = '포트가 올바르지 않습니다.'; return; }
    openQuickServer(rec);
  });
  quickConnectEl.addEventListener('click', quickRecentClick);
  refreshQuickRecent();
  quickConnectEl.hidden = false;
  var first = f.querySelector('.qc-url, .qc-host');
  setTimeout(function(){ if(first) first.focus(); }, 0);
}

function quickRecentClick(e){
  var item = e.target.closest('.qc-recent-item');
  if(!item) return;
  if(e.target.closest('.qc-recent-del')){ removeQuickServer(item.dataset.id); return; }
  if(e.target.closest('.qc-recent-open')){
    var srv = SERVERS.find(function(s){ return s.id === item.dataset.id; });
    if(!srv) return;
    srv.qcAt = Date.now();
    selectServer(srv.id);
  }
}

// ---- 열린 탭 위의 주소 바: 주소를 잘못 입력했을 때 고쳐서 다시 연결 ----
// Web은 자체 주소창(web.js)이 있으므로 제외. 새 주소는 새 빠른 연결 항목으로 열고, 아직 연결되지 않은
// 옛 탭과 (다른 탭이 안 쓰는) 옛 항목은 정리한다 — 잘못 친 주소가 이력에 남지 않게.
function updateQcAddrBar(tabId){
  if(!qcAddrBarEl) return;
  var tab = tabId ? tabbar.querySelector('.tab[data-id="' + tabId + '"]') : null;
  var srv = tab ? SERVERS.find(function(s){ return s.id === tab.dataset.serverId; }) : null;
  var show = !!(srv && srv.temp && srv.protocol !== 'web');
  if(qcAddrBarEl.hidden === !show && (!show || qcAddrBarEl.dataset.tab === tabId)) return;
  qcAddrBarEl.hidden = !show;
  if(show){
    qcAddrBarEl.dataset.tab = tabId;
    qcAddrBarEl.querySelector('.qc-addr-proto').textContent = srv.protocol === 'sftp' ? (srv.fileProtocol || 'sftp').toUpperCase() : srv.protocol === 'sql' ? (QUICK_SQL_LABELS[srv.sqlEngine] || 'SQL') : srv.protocol.toUpperCase();
    qcAddrBarEl.querySelector('.qc-addr-input').value = joinHostPort(srv.host, srv.port);
    qcAddrBarEl.querySelector('.qc-addr-error').textContent = '';
  }
  window.dispatchEvent(new Event('resize'));
}

function applyQuickAddress(tabId, text){
  var tab = tabbar.querySelector('.tab[data-id="' + tabId + '"]');
  var old = tab ? SERVERS.find(function(s){ return s.id === tab.dataset.serverId; }) : null;
  var errEl = qcAddrBarEl.querySelector('.qc-addr-error');
  if(!old) return;
  var hp = parseHostPort((text || '').trim());
  if(!hp.host || /\s/.test(hp.host)){ errEl.textContent = '호스트를 입력해주세요.'; return; }
  var rec = { protocol: old.protocol, host: hp.host, fileProtocol: old.fileProtocol, sqlEngine: old.sqlEngine, database: old.database };
  rec.port = hp.port || quickDefaultPort(rec);
  var connected = (sessionFor(tabId) || {}).state === 'connected';
  var srv = ensureQuickServer(rec);
  if(!connected){
    closeTabById(tabId);
    if(srv.id !== old.id && !quickHasOpenTab(old.id)){
      SERVERS = SERVERS.filter(function(x){ return x.id !== old.id; });
      renderTree();
    }
  }
  selectServer(srv.id);
}

if(qcAddrBarEl){
  qcAddrBarEl.addEventListener('submit', function(e){
    e.preventDefault();
    applyQuickAddress(qcAddrBarEl.dataset.tab, qcAddrBarEl.querySelector('.qc-addr-input').value);
  });
}
