// ---- server data (drives sidebar tree AND S7 management table) ----
var SERVERS = [];
var GROUP_ORDER = [];
var collapsedGroups = new Set();

function scrapeServers(){
  var list = [];
  var order = [];
  var collapsed = new Set();
  tree.querySelectorAll('.group').forEach(function(g){
    var name = g.querySelector('.group-head').textContent.trim();
    order.push(name);
    if(g.classList.contains('collapsed')) collapsed.add(name);
  });
  tree.querySelectorAll('.server').forEach(function(s){
    var hp = parseHostPort(s.dataset.host);
    var authMethod = s.dataset.authMethod === 'publickey' ? 'publickey' : 'password';
    var keyFilePath = s.dataset.keyPath || null;
    var srv = {
      id: s.dataset.id, name: s.dataset.id, group: s.dataset.group, protocol: s.dataset.protocol,
      host: hp.host, port: hp.port, username: s.dataset.username || '',
      authMethod: authMethod, keyFilePath: keyFilePath,
      sqlEngine: s.dataset.sqlEngine || 'mysql', database: s.dataset.database || '',
      jump: (s.dataset.jump && s.dataset.jump !== '없음') ? s.dataset.jump : null,
      status: s.dataset.status, since: s.dataset.since
    };
    srv.auth = authLabel(srv);
    list.push(srv);
  });
  return { list: list, order: order, collapsed: collapsed };
}

function isJumpHost(id){ return SERVERS.some(function(s){ return s.jump === id; }); }

function serverRowHtml(s){
  var hostDisplay = joinHostPort(s.host, s.port);
  var jumpTag = isJumpHost(s.id) ? ' <span style="color:var(--text-faint);font-weight:400;">· Jump</span>' : '';
  return '<div class="server" draggable="true" data-id="'+escapeHtml(s.id)+'" data-protocol="'+s.protocol+'" data-group="'+escapeHtml(s.group)+'" ' +
    'data-host="'+escapeHtml(hostDisplay)+'" data-username="'+escapeHtml(s.username||'')+'" data-auth="'+escapeHtml(authLabel(s))+'" ' +
    'data-auth-method="'+s.authMethod+'" data-key-path="'+escapeHtml(s.keyFilePath||'')+'" ' +
    'data-sql-engine="'+escapeHtml(s.sqlEngine||'mysql')+'" data-database="'+escapeHtml(s.database||'')+'" ' +
    'data-status="'+s.status+'" data-since="'+escapeHtml(s.since)+'" data-jump="'+escapeHtml(s.jump||'없음')+'">' +
    '<span class="proto-chip proto-'+s.protocol+'">'+PROTO[s.protocol].icon+'<span class="stat'+(s.status==='on'?' on':'')+'"></span></span>' +
    '<span class="server-name">'+escapeHtml(s.name)+jumpTag+'</span>' +
    (s.temp ? '<button type="button" class="server-del" title="빠른 연결 이력에서 삭제" aria-label="삭제">×</button>' : '') +
    '<svg class="icon go" viewBox="0 0 20 20"><polyline points="8 4 14 10 8 16"></polyline></svg>' +
  '</div>';
}

function renderTree(){
  var prevSelected = tree.querySelector('.server.selected');
  prevSelected = prevSelected ? prevSelected.dataset.id : null;
  tree.innerHTML = GROUP_ORDER.map(function(gname){
    var members = SERVERS.filter(function(s){ return s.group === gname; });
    var cls = collapsedGroups.has(gname) ? ' collapsed' : '';
    return '<div class="group'+cls+'" data-group>' +
      '<div class="group-head" data-toggle><svg class="icon" viewBox="0 0 20 20"><polyline points="6 4 13 10 6 16"></polyline></svg>' +
      escapeHtml(gname)+'</div><div class="group-body">'+members.map(serverRowHtml).join('')+'</div></div>';
  }).join('');
  if(prevSelected){
    var row = tree.querySelector('.server[data-id="'+prevSelected+'"]');
    if(row) row.classList.add('selected');
  }
  applyTreeFilterVisual();
  schedulePersistServers();
}

var sidebarQuery = '';
document.getElementById('sidebarSearch').addEventListener('input', function(e){
  sidebarQuery = e.target.value.trim().toLowerCase();
  applyTreeFilterVisual();
});

function applyTreeFilterVisual(){
  tree.querySelectorAll('.server').forEach(function(s){
    var protoOk = currentFilter === 'all' || s.dataset.protocol === currentFilter;
    var textOk = !sidebarQuery || (s.textContent + ' ' + (s.dataset.host || '') + ' ' + (s.dataset.group || '') + ' ' + (s.dataset.username || '')).toLowerCase().indexOf(sidebarQuery) !== -1;
    s.classList.toggle('filtered-out', !(protoOk && textOk));
  });
  tree.querySelectorAll('.group').forEach(function(g){
    var vis = g.querySelectorAll('.server:not(.filtered-out)').length;
    g.classList.toggle('filtered-out', vis === 0);
  });
}

// ---- group collapse / server select ----
tree.addEventListener('click', function(e){
  var head = e.target.closest('[data-toggle]');
  if(head){
    var groupEl = head.closest('.group');
    var gname = head.textContent.trim();
    groupEl.classList.toggle('collapsed');
    if(groupEl.classList.contains('collapsed')) collapsedGroups.add(gname); else collapsedGroups.delete(gname);
    schedulePersistServers();
    return;
  }
  var del = e.target.closest('.server-del');
  if(del){ e.stopPropagation(); removeQuickServer(del.closest('.server').dataset.id); return; }
  var row = e.target.closest('.server');
  if(row){ openOrFocusServer(row.dataset.id); }
});

// ---- 서버 클릭 = 이미 열린 세션이 있으면 그 세션으로 이동, 없을 때만 새 연결 ----
function tabsOfServer(serverId){
  return Array.prototype.filter.call(tabbar.querySelectorAll('.tab[data-server-id="'+serverId+'"]'), function(t){
    return !t.classList.contains('group-tab');
  });
}
function openOrFocusServer(serverId){
  var row = tree.querySelector('.server[data-id="'+serverId+'"]');
  if(!row) return;
  var tabs = tabsOfServer(serverId);
  if(!tabs.length){ selectServer(serverId); return; }
  // 현재 보고 있는 탭이 이 서버 것이면 그대로 둔다. 아니면 마지막으로 보던 탭(없으면 가장 최근에 연 탭)으로 이동.
  var proto = row.dataset.protocol;
  var cur = tabs.filter(function(t){ return t.classList.contains('active'); })[0];
  var target = cur || tabs.filter(function(t){ return t.dataset.id === lastActiveByServer[serverId]; })[0]
    || tabs.filter(function(t){ return t.dataset.protocol === proto; }).pop() || tabs[tabs.length - 1];
  if(currentFilter !== 'all' && currentFilter !== target.dataset.protocol) applyFilter(target.dataset.protocol);
  activate(target.dataset.id);
}
var lastActiveByServer = {};

// ---- 서버 우클릭 미니 메뉴: 새 연결 / 이 서버의 모든 연결 닫기 ----
var treeMenuEl = null;
function hideTreeMenu(){ if(treeMenuEl){ treeMenuEl.remove(); treeMenuEl = null; } }
tree.addEventListener('contextmenu', function(e){
  var row = e.target.closest('.server');
  if(!row) return;
  e.preventDefault();
  hideTreeMenu();
  var serverId = row.dataset.id;
  var open = tabsOfServer(serverId);
  treeMenuEl = document.createElement('div');
  treeMenuEl.className = 'tree-menu';
  var items = [
    { label: '새 연결', run: function(){ selectServer(serverId); } },
    { label: open.length ? '모든 연결 닫기 (' + open.length + ')' : '모든 연결 닫기', disabled: !open.length, danger: true, run: function(){
      if(open.length > 1 && !confirm('"' + serverId + '" 서버의 연결 ' + open.length + '개를 모두 닫을까요?')) return;
      open.map(function(t){ return t.dataset.id; }).forEach(function(id){ closeTabById(id); });
    } }
  ];
  items.forEach(function(it){
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.disabled = !!it.disabled;
    if(it.danger) b.classList.add('danger');
    b.onclick = function(){ hideTreeMenu(); it.run(); };
    treeMenuEl.appendChild(b);
  });
  document.body.appendChild(treeMenuEl);
  var w = treeMenuEl.offsetWidth, h = treeMenuEl.offsetHeight;
  treeMenuEl.style.left = Math.min(e.clientX, window.innerWidth - w - 4) + 'px';
  treeMenuEl.style.top = Math.min(e.clientY, window.innerHeight - h - 4) + 'px';
});
document.addEventListener('mousedown', function(e){ if(treeMenuEl && !treeMenuEl.contains(e.target)) hideTreeMenu(); });
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') hideTreeMenu(); });
window.addEventListener('blur', hideTreeMenu);
tree.addEventListener('scroll', hideTreeMenu);

// ---- 사이드바 서버 드래그로 순서 변경 (같은 그룹 안에서만) ----
var dragServerId = null;

function clearDragIndicators(){
  tree.querySelectorAll('.server.drag-over-top,.server.drag-over-bottom').forEach(function(el){
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
}

function reorderServer(draggedId, targetId, before){
  var fromIdx = SERVERS.findIndex(function(s){ return s.id === draggedId; });
  if(fromIdx === -1) return;
  var dragged = SERVERS.splice(fromIdx, 1)[0];
  var toIdx = SERVERS.findIndex(function(s){ return s.id === targetId; });
  if(toIdx === -1){ SERVERS.push(dragged); }
  else { SERVERS.splice(before ? toIdx : toIdx + 1, 0, dragged); }
  renderTree();
}

tree.addEventListener('dragstart', function(e){
  var row = e.target.closest('.server');
  if(!row) return;
  dragServerId = row.dataset.id;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', row.dataset.id); } catch(_err){ /* 일부 환경에서 미지원 */ }
});

tree.addEventListener('dragend', function(e){
  var row = e.target.closest('.server');
  if(row) row.classList.remove('dragging');
  clearDragIndicators();
  dragServerId = null;
});

tree.addEventListener('dragover', function(e){
  if(!dragServerId) return;
  var row = e.target.closest('.server');
  if(!row || row.dataset.id === dragServerId) return;
  var draggingEl = tree.querySelector('.server.dragging');
  if(!draggingEl || row.dataset.group !== draggingEl.dataset.group) return; // 같은 그룹만 허용
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  var rect = row.getBoundingClientRect();
  var before = (e.clientY - rect.top) < rect.height / 2;
  clearDragIndicators();
  row.classList.toggle('drag-over-top', before);
  row.classList.toggle('drag-over-bottom', !before);
});

tree.addEventListener('drop', function(e){
  if(!dragServerId) return;
  var row = e.target.closest('.server');
  if(!row || row.dataset.id === dragServerId) return;
  e.preventDefault();
  var before = row.classList.contains('drag-over-top');
  clearDragIndicators();
  reorderServer(dragServerId, row.dataset.id, before);
  dragServerId = null;
});
