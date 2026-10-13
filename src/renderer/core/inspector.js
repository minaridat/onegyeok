function inspectorFor(tabId){
  var serverId = serverIdForTab(tabId);
  var row = tree.querySelector('.server[data-id="'+serverId+'"]');
  if(!row) return;
  if(currentInspectedServerId && currentInspectedServerId !== serverId) flushMemoSave();
  currentInspectedId = tabId;
  currentInspectedServerId = serverId;
  var inspectedTab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  var proto = (inspectedTab && inspectedTab.dataset.protocol) || row.dataset.protocol;
  document.getElementById('openSftpBtn').style.display = row.dataset.protocol === 'ssh' ? '' : 'none';
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  var tabNameEl = tab && tab.querySelector('.tab-name');
  document.getElementById('i-name').textContent = (tabNameEl && tabNameEl.textContent) || serverId;
  document.getElementById('i-group').textContent = row.dataset.group;
  document.getElementById('i-host').textContent = row.dataset.host;
  document.getElementById('i-username').textContent = row.dataset.username || '(접속 시 입력)';
  document.getElementById('i-auth').textContent = row.dataset.auth;
  document.getElementById('i-since').textContent = row.dataset.since;
  document.getElementById('i-proto-label').textContent = PROTO[proto].label;
  var chip = document.getElementById('i-proto-chip');
  chip.className = 'proto-chip sm proto-' + proto;
  chip.innerHTML = PROTO[proto].icon;
  document.getElementById('row-username').style.display = proto === 'web' ? 'none' : '';

  // 프로토콜별 인스펙터 전용 행(점프 호스트, DB 엔진 등)은 레지스트리의 inspectorExtra가 채운다 —
  // 여기서는 일단 전부 숨기고, 현재 프로토콜이 필요한 행만 다시 보이게 한다.
  document.querySelectorAll('[data-insp-extra]').forEach(function(el){ el.style.display = 'none'; });
  var protoDef = getProtocol(proto);
  if(protoDef && protoDef.inspectorExtra) protoDef.inspectorExtra(document.getElementById('inspBody'), row);

  var srv = SERVERS.find(function(s){ return s.id === serverId; });
  memoEl.value = (srv && srv.memo) || '';
  memoStatusEl.classList.remove('show');

  var connBtn = document.getElementById('inspConnActionBtn');
  if(protoDef && protoDef.hasConnAction){
    connBtn.style.display = '';
    updateConnActionButton(tabId);
  } else {
    connBtn.style.display = 'none';
  }
}

memoEl.addEventListener('input', function(e){
  if(!currentInspectedServerId) return;
  var srv = SERVERS.find(function(s){ return s.id === currentInspectedServerId; });
  if(srv) srv.memo = e.target.value;
  scheduleMemoSave(currentInspectedServerId, e.target.value);
});
memoEl.addEventListener('blur', flushMemoSave);
window.addEventListener('beforeunload', flushMemoSave);
