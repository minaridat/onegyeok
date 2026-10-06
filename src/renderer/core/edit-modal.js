// ==================================================================
// S2. 서버 등록/수정 모달 (S7과 topbar [서버 등록] 양쪽에서 공유)
//
// 프로토콜별 전용 입력 필드(SSH의 인증방식/키/점프호스트, SQL의 DB엔진/데이터베이스 등)는
// #regExtraContainer 하나에 해당 프로토콜의 registration.renderExtra()가 그려준다 — 새 프로토콜을
// 추가할 때 이 파일은 건드릴 필요 없이 protocols/<proto>/<proto>.js의 registration만 구현하면 된다.
// ==================================================================

function refreshRegExtra(existingServer){
  var proto = document.getElementById('f-protocol').value;
  var protoDef = getProtocol(proto);
  var reg = protoDef && protoDef.registration;
  document.getElementById('row-f-username').style.display = (reg && reg.hideUsername) ? 'none' : '';
  var container = document.getElementById('regExtraContainer');
  container.innerHTML = '';
  if(reg && reg.renderExtra) reg.renderExtra(container, existingServer || null);
  updatePortPlaceholder();
}

function updatePortPlaceholder(){
  var proto = document.getElementById('f-protocol').value;
  var protoDef = getProtocol(proto);
  var reg = protoDef && protoDef.registration;
  var portEl = document.getElementById('f-port');
  portEl.placeholder = (reg && reg.defaultPortPlaceholder)
    ? (reg.defaultPortPlaceholder(document.getElementById('regExtraContainer')) || '')
    : '';
}

document.getElementById('f-protocol').addEventListener('change', function(){ refreshRegExtra(null); });

var fGroupPrevValue = '';
document.getElementById('f-group').addEventListener('change', function(e){
  if(e.target.value === '__new__'){
    addNewGroup().then(function(created){
      e.target.value = created || fGroupPrevValue || (GROUP_ORDER[0] || '');
      fGroupPrevValue = e.target.value;
    });
    return;
  }
  fGroupPrevValue = e.target.value;
});

function openEdit(id){
  editingId = id || null;
  var s = id ? SERVERS.find(function(x){ return x.id === id; }) : null;
  document.getElementById('editTitle').textContent = s ? '서버 수정' : '서버 등록';
  document.getElementById('f-name').value = s ? s.name : '';
  document.getElementById('f-group').value = s ? s.group : (manageGroupF !== 'all' ? manageGroupF : (GROUP_ORDER[0] || '기타'));
  document.getElementById('f-protocol').value = s ? s.protocol : 'ssh';
  document.getElementById('f-host').value = s ? s.host : '';
  document.getElementById('f-port').value = s && s.port ? s.port : '';
  document.getElementById('f-username').value = s ? s.username : '';
  document.getElementById('editError').textContent = '';
  document.getElementById('editDeleteBtn').style.display = s ? '' : 'none';
  refreshRegExtra(s);
  populateGroupSelectors();
  fGroupPrevValue = document.getElementById('f-group').value;
  appEl.classList.add('edit-open');
  setTimeout(function(){ document.getElementById('f-name').focus(); }, 0);
}
function closeEdit(){ appEl.classList.remove('edit-open'); editingId = null; }

// 서버 이름(=id)이 바뀌면, 그 서버로 열려 있는 모든 탭(여러 개일 수 있음)의 표시 이름을 갱신한다.
// 탭 자체의 id(data-id)는 세션 인스턴스 식별자이므로 그대로 두고, data-server-id만 바꾼다.
function relabelForRename(label, oldId, newId){
  if(label === oldId) return newId;
  if(label.indexOf(oldId + ' #') === 0) return newId + label.slice(oldId.length);
  return label;
}
function propagateIdRename(oldId, newId){
  tabbar.querySelectorAll('.tab[data-server-id="'+oldId+'"]').forEach(function(tab){
    tab.dataset.serverId = newId;
    var nameEl = tab.querySelector('.tab-name');
    if(nameEl) nameEl.textContent = relabelForRename(nameEl.textContent, oldId, newId);
  });
  panes.querySelectorAll('.pane[data-server-id="'+oldId+'"]').forEach(function(pane){ pane.dataset.serverId = newId; });
  SERVERS.forEach(function(s){ if(s.jump === oldId) s.jump = newId; });
  if(currentInspectedServerId === oldId) currentInspectedServerId = newId;
  if(hasMemoBridge) window.onegyeok.renameMemo(oldId, newId);
}

// ==================================================================
// 연결 정보 패널 내부 탭 전환 (연결 정보 ↔ 메모)
// ==================================================================
var inspTabButtons = document.querySelectorAll('.insp-tab');
var inspPanes = document.querySelectorAll('.insp-pane');
inspTabButtons.forEach(function(btn){
  btn.addEventListener('click', function(){
    inspTabButtons.forEach(function(b){ b.classList.toggle('active', b === btn); });
    inspPanes.forEach(function(p){ p.classList.toggle('active', p.dataset.pane === btn.dataset.tab); });
    if(btn.dataset.tab === 'memo') setTimeout(function(){ memoEl.focus(); }, 0);
  });
});

document.getElementById('registerOpenBtn').addEventListener('click', function(){ openEdit(null); });
document.getElementById('manageAddBtn').addEventListener('click', function(){ openEdit(null); });
document.getElementById('editCancelBtn').addEventListener('click', closeEdit);
document.getElementById('editCloseBtn').addEventListener('click', closeEdit);
document.getElementById('editBackdrop').addEventListener('click', function(e){
  if(e.target.id === 'editBackdrop') closeEdit();
});

document.getElementById('editDeleteBtn').addEventListener('click', function(){
  if(!editingId) return;
  var s = SERVERS.find(function(x){ return x.id === editingId; });
  if(!confirm('"'+(s ? s.name : editingId)+'" 서버를 삭제할까요?')) return;
  removeServerById(editingId);
  closeEdit();
  renderTree(); renderManageTable();
});

document.getElementById('editSaveBtn').addEventListener('click', function(){
  var name = document.getElementById('f-name').value.trim();
  var group = document.getElementById('f-group').value.trim() || '기타';
  var protocol = document.getElementById('f-protocol').value;
  var host = document.getElementById('f-host').value.trim();
  var portRaw = document.getElementById('f-port').value.trim();
  var port = portRaw ? parseInt(portRaw, 10) : null;
  var username = document.getElementById('f-username').value.trim();
  var errEl = document.getElementById('editError');

  if(!name || !host){ errEl.textContent = '이름과 호스트는 필수입니다.'; return; }
  // 사용자명은 선택 — 비워두면 접속할 때마다 터미널(또는 접속 폼)에서 직접 물어본다(다른 사용자로 로그인하는 경우 대비).
  var dup = SERVERS.find(function(s){ return s.id === name && s.id !== editingId; });
  if(dup){ errEl.textContent = '이미 사용 중인 이름입니다.'; return; }

  var protoDef = getProtocol(protocol);
  var reg = protoDef && protoDef.registration;
  var extra = (reg && reg.collectExtra) ? (reg.collectExtra(document.getElementById('regExtraContainer')) || {}) : {};

  if(extra.authMethod === 'publickey' && !extra.keyFilePath){ errEl.textContent = 'SSH Key 파일 경로를 지정해주세요.'; return; }

  if(GROUP_ORDER.indexOf(group) === -1) GROUP_ORDER.push(group);

  if(editingId){
    var s = SERVERS.find(function(x){ return x.id === editingId; });
    var oldId = s.id;
    s.name = name; s.id = name; s.group = group; s.protocol = protocol; s.host = host; s.port = port;
    s.username = username;
    s.authMethod = extra.authMethod || 'password'; s.keyFilePath = extra.keyFilePath || null;
    s.jump = extra.jump || null; s.sqlEngine = extra.sqlEngine || null; s.database = extra.database || '';
    s.fileProtocol = extra.fileProtocol || null;
    s.auth = authLabel(s);
    if(oldId !== name) propagateIdRename(oldId, name);
  } else {
    var newServer = {
      id: name, name: name, group: group, protocol: protocol, host: host, port: port,
      username: username,
      authMethod: extra.authMethod || 'password', keyFilePath: extra.keyFilePath || null,
      jump: extra.jump || null, sqlEngine: extra.sqlEngine || null, database: extra.database || '',
      fileProtocol: extra.fileProtocol || null,
      status: 'off', since: '연결 안 됨'
    };
    newServer.auth = authLabel(newServer);
    SERVERS.push(newServer);
  }
  closeEdit();
  renderTree(); renderManageTable(); populateGroupSelectors();
});
