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
}

function applyTreeFilterVisual(){
  tree.querySelectorAll('.server').forEach(function(s){
    s.classList.toggle('filtered-out', !(currentFilter === 'all' || s.dataset.protocol === currentFilter));
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
    return;
  }
  var row = e.target.closest('.server');
  if(row){ selectServer(row.dataset.id); }
});

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
