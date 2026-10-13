// 빠른 연결 — 서버를 등록하지 않고 주소만 입력해 바로 여는 기능(Web 주소창, SFTP/FTP/FTPS 접속 폼).
// 해당 프로토콜 레일 버튼(P5 Web / P2 SFTP)을 눌러 열린 세션이 없을 때 빈 화면(emptyPane)에 뜬다.
// 입력한 대상은 사이드바 "빠른 연결" 그룹에 임시 서버(temp:true)로 만들어 기존 selectServer 흐름을 그대로 쓰고,
// 디스크에는 저장하지 않는다(server-persist.js가 temp 서버와 이 그룹을 제외). 비밀번호는 평소처럼 접속 폼에서 직접 입력.
var QUICK_GROUP = '빠른 연결';
var quickConnectEl = document.getElementById('quickConnect');

function quickServerId(label){
  var base = label, n = 1;
  while(SERVERS.some(function(s){ return s.id === base; })){ n++; base = label + ' (' + n + ')'; }
  return base;
}

function openQuickServer(rec){
  var existing = SERVERS.find(function(s){
    return s.temp && s.protocol === rec.protocol && s.host === rec.host && s.port === rec.port && s.fileProtocol === rec.fileProtocol;
  });
  var srv = existing;
  if(!srv){
    srv = {
      id: quickServerId(rec.label), name: '', group: QUICK_GROUP, protocol: rec.protocol, host: rec.host, port: rec.port,
      username: '', authMethod: 'password', keyFilePath: null, jump: null, sqlEngine: null, database: '',
      fileProtocol: rec.fileProtocol || null, temp: true, status: 'off', since: '연결 안 됨'
    };
    srv.name = srv.id;
    srv.auth = authLabel(srv);
    SERVERS.push(srv);
    if(GROUP_ORDER.indexOf(QUICK_GROUP) === -1) GROUP_ORDER.push(QUICK_GROUP);
    renderTree();
    populateGroupSelectors();
  }
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
  var m = /^([^:/\s]+):(\d{1,5})$/.exec(v);
  if(m) return { host: m[1], port: parseInt(m[2], 10) };
  return /^[^\s/]+(\/\S*)?$/.test(v) ? { host: v, port: null } : null;
}

function renderQuickConnect(filter){
  if(!quickConnectEl) return;
  quickConnectEl.hidden = true;
  quickConnectEl.innerHTML = '';
  if(filter === 'web'){
    quickConnectEl.innerHTML =
      '<form class="qc-form" autocomplete="off">' +
        '<div class="qc-title">빠른 주소 열기</div>' +
        '<div class="qc-row"><input class="qc-url" type="text" placeholder="주소 입력 (예: https://10.0.0.5, example.com:8443)" spellcheck="false">' +
        '<button type="submit" class="qc-go">열기</button></div>' +
        '<div class="qc-error"></div>' +
      '</form>';
    var form = quickConnectEl.querySelector('form');
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var parsed = parseQuickWebInput(quickConnectEl.querySelector('.qc-url').value);
      if(!parsed){ quickConnectEl.querySelector('.qc-error').textContent = 'http/https 주소를 입력해주세요.'; return; }
      openQuickServer({ protocol: 'web', host: parsed.host, port: parsed.port, label: parsed.host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') });
    });
    quickConnectEl.hidden = false;
    setTimeout(function(){ quickConnectEl.querySelector('.qc-url').focus(); }, 0);
  } else if(filter === 'sftp'){
    quickConnectEl.innerHTML =
      '<form class="qc-form" autocomplete="off">' +
        '<div class="qc-title">빠른 SFTP / FTP / FTPS 연결</div>' +
        '<div class="qc-row">' +
          '<select class="qc-mode"><option value="sftp">SFTP (SSH)</option><option value="ftps">FTPS (TLS 권장)</option><option value="ftp">FTP (평문)</option><option value="ftps-implicit">FTPS implicit</option></select>' +
          '<input class="qc-host" type="text" placeholder="호스트 (예: 10.0.0.5)" spellcheck="false">' +
          '<input class="qc-port" type="text" inputmode="numeric" placeholder="22" maxlength="5">' +
          '<button type="submit" class="qc-go">접속</button>' +
        '</div>' +
        '<div class="qc-hint">사용자명/비밀번호는 다음 화면에서 입력합니다 (저장되지 않음).</div>' +
        '<div class="qc-error"></div>' +
      '</form>';
    var f = quickConnectEl.querySelector('form');
    var mode = f.querySelector('.qc-mode'), portEl = f.querySelector('.qc-port');
    function defPort(){ return mode.value === 'sftp' ? '22' : mode.value === 'ftps-implicit' ? '990' : '21'; }
    mode.addEventListener('change', function(){ portEl.placeholder = defPort(); });
    f.addEventListener('submit', function(e){
      e.preventDefault();
      var hp = parseHostPort(f.querySelector('.qc-host').value.trim());
      if(!hp.host || /\s/.test(hp.host)){ f.querySelector('.qc-error').textContent = '호스트를 입력해주세요.'; return; }
      var portStr = portEl.value.trim();
      var port = hp.port || (portStr ? parseInt(portStr, 10) : parseInt(defPort(), 10));
      if(!(port > 0 && port < 65536)){ f.querySelector('.qc-error').textContent = '포트가 올바르지 않습니다.'; return; }
      openQuickServer({ protocol: 'sftp', host: hp.host, port: port, fileProtocol: mode.value, label: mode.value.toUpperCase() + ' ' + hp.host });
    });
    quickConnectEl.hidden = false;
    setTimeout(function(){ f.querySelector('.qc-host').focus(); }, 0);
  }
}
