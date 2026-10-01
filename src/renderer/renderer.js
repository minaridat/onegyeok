
(function(){
  var appEl = document.getElementById('app');
  var tree = document.getElementById('tree');
  var tabbar = document.getElementById('tabbar');
  var panes = document.getElementById('panes');
  var inspToggleBtn = document.getElementById('inspToggleBtn');
  var inspHandle = document.getElementById('inspHandle');
  var inspCollapseBtn = document.getElementById('inspCollapseBtn');

  var PROTO = {
    ssh:  { label:'SSH',  icon:'<svg viewBox="0 0 20 20"><polyline points="3 5 8 10 3 15"></polyline><line x1="10" y1="15" x2="17" y2="15"></line></svg>' },
    rdp:  { label:'RDP',  icon:'<svg viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="11" rx="1.4"></rect><line x1="7" y1="17" x2="13" y2="17"></line></svg>' },
    vnc:  { label:'VNC',  icon:'<svg viewBox="0 0 20 20"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"></path><circle cx="10" cy="10" r="2.3"></circle></svg>' },
    sftp: { label:'SFTP', icon:'<svg viewBox="0 0 20 20"><path d="M2 6l2-2h4l2 2h8v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6z"></path></svg>' },
    web:  { label:'Web',  icon:'<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"></circle><line x1="2.5" y1="10" x2="17.5" y2="10"></line><path d="M10 2.5c2.2 2 2.2 13 0 15M10 2.5c-2.2 2-2.2 13 0 15"></path></svg>' }
  };

  function escapeHtml(str){
    return String(str == null ? '' : str).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function parseHostPort(str){
    str = str || '';
    var idx = str.lastIndexOf(':');
    if(idx > -1 && /^\d+$/.test(str.slice(idx+1))){
      return { host: str.slice(0, idx), port: parseInt(str.slice(idx+1), 10) };
    }
    return { host: str, port: null };
  }
  function joinHostPort(host, port){ return port ? (host + ':' + port) : host; }

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
      list.push({
        id: s.dataset.id, name: s.dataset.id, group: s.dataset.group, protocol: s.dataset.protocol,
        host: hp.host, port: hp.port, auth: s.dataset.auth, tmux: s.dataset.tmux,
        jump: (s.dataset.jump && s.dataset.jump !== '없음') ? s.dataset.jump : null,
        status: s.dataset.status, since: s.dataset.since
      });
    });
    return { list: list, order: order, collapsed: collapsed };
  }

  function isJumpHost(id){ return SERVERS.some(function(s){ return s.jump === id; }); }

  function serverRowHtml(s){
    var hostDisplay = joinHostPort(s.host, s.port);
    var jumpTag = isJumpHost(s.id) ? ' <span style="color:var(--text-faint);font-weight:400;">· Jump</span>' : '';
    return '<div class="server" data-id="'+escapeHtml(s.id)+'" data-protocol="'+s.protocol+'" data-group="'+escapeHtml(s.group)+'" ' +
      'data-host="'+escapeHtml(hostDisplay)+'" data-auth="'+escapeHtml(s.auth)+'" data-tmux="'+escapeHtml(s.tmux||'—')+'" ' +
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

  document.querySelector('.add-group').addEventListener('click', function(){
    var name = prompt('새 그룹 이름을 입력하세요');
    if(!name) return;
    name = name.trim();
    if(!name || GROUP_ORDER.indexOf(name) > -1) return;
    GROUP_ORDER.push(name);
    renderTree();
    populateGroupSelectors();
  });

  var currentInspectedId = null;
  var memoEl = document.getElementById('i-memo');

  function inspectorFor(id){
    var row = tree.querySelector('.server[data-id="'+id+'"]');
    if(!row) return;
    currentInspectedId = id;
    var proto = row.dataset.protocol;
    document.getElementById('i-name').textContent = id;
    document.getElementById('i-group').textContent = row.dataset.group;
    document.getElementById('i-host').textContent = row.dataset.host;
    document.getElementById('i-auth').textContent = row.dataset.auth;
    document.getElementById('i-jump').textContent = row.dataset.jump;
    document.getElementById('i-tmux').textContent = row.dataset.tmux;
    document.getElementById('i-since').textContent = row.dataset.since;
    document.getElementById('i-proto-label').textContent = PROTO[proto].label;
    var chip = document.getElementById('i-proto-chip');
    chip.className = 'proto-chip sm proto-' + proto;
    chip.innerHTML = PROTO[proto].icon;
    document.getElementById('row-jump').style.display = proto === 'ssh' ? '' : 'none';
    document.getElementById('row-tmux').style.display = proto === 'ssh' ? '' : 'none';
    var srv = SERVERS.find(function(s){ return s.id === id; });
    memoEl.value = (srv && srv.memo) || '';
  }

  memoEl.addEventListener('input', function(e){
    if(!currentInspectedId) return;
    var srv = SERVERS.find(function(s){ return s.id === currentInspectedId; });
    if(srv) srv.memo = e.target.value;
  });

  function ensurePane(id){
    var pane = panes.querySelector('.pane[data-id="'+id+'"]');
    if(pane) return pane;
    var row = tree.querySelector('.server[data-id="'+id+'"]');
    var proto = row.dataset.protocol;
    var el = document.createElement('div');
    el.dataset.id = id;
    if(proto === 'ssh'){
      el.className = 'pane';
      el.innerHTML =
        '<div class="ln muted">Connecting to '+row.dataset.host+' ...</div>' +
        '<div class="ln muted">tmux: attaching to session \''+row.dataset.tmux+'\' (created)</div>' +
        '<div class="ln">&nbsp;</div>' +
        '<div class="ln"><span class="prompt">root@'+id+'</span><span class="muted">:~#</span> <span class="cursor"></span></div>';
    } else if(proto === 'rdp'){
      el.className = 'pane screen';
      el.innerHTML =
        '<div class="screen-toolbar"><span>'+id+' · RDP</span><span class="grow"></span>' +
        '<span class="icon-btn" title="전체화면"><svg class="icon" viewBox="0 0 20 20" style="width:14px;height:14px"><path d="M3 7V4a1 1 0 0 1 1-1h3M17 7V4a1 1 0 0 0-1-1h-3M3 13v3a1 1 0 0 0 1 1h3M17 13v3a1 1 0 0 1-1 1h-3"></path></svg></span></div>' +
        '<div class="screen-canvas"><div class="win" style="left:12%;top:14%;width:50%;height:56%;"></div>' +
        '<span class="screen-badge">원격 제어 중</span>' +
        '<div class="screen-taskbar"><span class="dot"></span><span class="dot"></span></div></div>';
    } else {
      el.className = 'pane placeholder-pane proto-' + proto;
      el.innerHTML =
        '<div class="ph-icon">'+PROTO[proto].icon+'</div>' +
        '<div class="ph-title">'+id+'</div>' +
        '<div class="ph-desc">'+PROTO[proto].label+' 세션이 여기에 표시됩니다.</div>';
    }
    panes.appendChild(el);
    return el;
  }

  var currentFilter = 'all';
  var lastActiveByFilter = {};
  var emptyPane = document.getElementById('emptyPane');
  var emptyMsgEl = document.getElementById('emptyMsg');
  var filterLabelEl = document.getElementById('filterLabel');

  function visibleTabs(){
    return Array.prototype.filter.call(tabbar.querySelectorAll('.tab'), function(t){
      return !t.classList.contains('filtered-out');
    });
  }

  function renumberTabs(){
    var vis = visibleTabs();
    vis.forEach(function(t, i){ t.querySelector('.tab-num').textContent = (i < 9) ? String(i+1) : ''; });
    tabbar.querySelectorAll('.tab.filtered-out .tab-num').forEach(function(n){ n.textContent = ''; });
  }

  function ensureTab(id){
    var tab = tabbar.querySelector('.tab[data-id="'+id+'"]');
    if(tab) return tab;
    var row = tree.querySelector('.server[data-id="'+id+'"]');
    var proto = row.dataset.protocol;
    tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.id = id;
    tab.dataset.protocol = proto;
    var statOn = row.dataset.status === 'on' ? ' on' : '';
    tab.innerHTML =
      '<span class="proto-chip sm proto-'+proto+'">'+PROTO[proto].icon+'<span class="stat'+statOn+'"></span></span>' +
      '<span class="tab-name">'+id+'</span><span class="tab-num"></span>' +
      '<svg class="icon close" viewBox="0 0 20 20"><line x1="5" y1="5" x2="15" y2="15"></line><line x1="15" y1="5" x2="5" y2="15"></line></svg>';
    tabbar.insertBefore(tab, tabbar.querySelector('.tab-add'));
    renumberTabs();
    return tab;
  }

  function recordActive(id){
    var tab = tabbar.querySelector('.tab[data-id="'+id+'"]');
    if(!tab) return;
    lastActiveByFilter['all'] = id;
    lastActiveByFilter[tab.dataset.protocol] = id;
  }

  function activate(id){
    emptyPane.classList.remove('active');
    tabbar.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t.dataset.id === id); });
    panes.querySelectorAll('.pane').forEach(function(p){ p.classList.toggle('active', p.dataset.id === id); });
    tree.querySelectorAll('.server').forEach(function(s){ s.classList.toggle('selected', s.dataset.id === id); });
    inspectorFor(id);
    recordActive(id);
  }

  function activateEmpty(filter){
    tabbar.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
    panes.querySelectorAll('.pane').forEach(function(p){ p.classList.remove('active'); });
    tree.querySelectorAll('.server').forEach(function(s){ s.classList.remove('selected'); });
    emptyMsgEl.textContent = filter === 'all'
      ? '왼쪽에서 서버를 선택하면 여기에 세션이 열립니다.'
      : PROTO[filter].label + ' 서버를 선택하면 여기에 세션이 열립니다. (열린 ' + PROTO[filter].label + ' 세션 없음)';
    emptyPane.classList.add('active');
  }

  function applyFilter(filter){
    currentFilter = filter;
    applyTreeFilterVisual();
    tabbar.querySelectorAll('.tab').forEach(function(t){
      t.classList.toggle('filtered-out', !(filter === 'all' || t.dataset.protocol === filter));
    });
    renumberTabs();
    document.querySelectorAll('.rail-btn[data-filter]').forEach(function(b){
      b.classList.toggle('active', b.dataset.filter === filter);
    });
    filterLabelEl.textContent = filter === 'all' ? '전체' : PROTO[filter].label;

    var vis = visibleTabs();
    var remembered = lastActiveByFilter[filter];
    var rememberedTab = remembered && tabbar.querySelector('.tab[data-id="'+remembered+'"]');
    if(rememberedTab && !rememberedTab.classList.contains('filtered-out')){
      activate(remembered);
    } else if(vis.length){
      activate(vis[0].dataset.id);
    } else {
      activateEmpty(filter);
    }
  }

  function selectServer(id){
    ensureTab(id);
    ensurePane(id);
    var row = tree.querySelector('.server[data-id="'+id+'"]');
    var proto = row.dataset.protocol;
    if(currentFilter !== 'all' && currentFilter !== proto){
      applyFilter(proto);
    }
    activate(id);
  }

  function removeServerById(id){
    SERVERS = SERVERS.filter(function(s){ return s.id !== id; });
    var tab = tabbar.querySelector('.tab[data-id="'+id+'"]');
    if(tab){
      var wasActive = tab.classList.contains('active');
      var pane = panes.querySelector('.pane[data-id="'+id+'"]');
      tab.remove();
      if(pane) pane.remove();
      renumberTabs();
      if(wasActive){
        var remaining = visibleTabs()[0];
        if(remaining) activate(remaining.dataset.id); else activateEmpty(currentFilter);
      }
    }
    selectedManageIds.delete(id);
  }

  // ==================================================================
  // S7. 서버 관리 (전체 목록/편집)
  // ==================================================================
  var manageSort = { key:'name', dir:1 };
  var manageSearchQ = '';
  var manageProtoF = 'all';
  var manageGroupF = 'all';
  var selectedManageIds = new Set();
  var editingId = null; // null = 서버 추가 모드

  function populateGroupSelectors(){
    var opts = GROUP_ORDER.map(function(g){ return '<option value="'+escapeHtml(g)+'">'+escapeHtml(g)+'</option>'; }).join('');
    var gf = document.getElementById('manageGroupFilter');
    gf.innerHTML = '<option value="all">그룹 전체</option>' + opts;
    gf.value = manageGroupF;
    document.getElementById('manageBulkGroup').innerHTML = '<option value="">그룹 이동...</option>' + opts;
    document.getElementById('groupDatalist').innerHTML = opts;
  }

  function filteredSortedServers(){
    var q = manageSearchQ.trim().toLowerCase();
    var list = SERVERS.filter(function(s){
      var matchQ = !q || s.name.toLowerCase().indexOf(q) > -1 || s.host.toLowerCase().indexOf(q) > -1 ||
        s.group.toLowerCase().indexOf(q) > -1;
      var matchP = manageProtoF === 'all' || s.protocol === manageProtoF;
      var matchG = manageGroupF === 'all' || s.group === manageGroupF;
      return matchQ && matchP && matchG;
    });
    var key = manageSort.key, dir = manageSort.dir;
    list.sort(function(a, b){
      if(key === 'port'){ return ((a.port||0) - (b.port||0)) * dir; }
      var av = (a[key]||'').toString().toLowerCase(), bv = (b[key]||'').toString().toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    });
    return list;
  }

  function renderManageTable(){
    var list = filteredSortedServers();
    var tbody = document.getElementById('manageTbody');
    document.getElementById('manageCount').textContent = SERVERS.length + '개 서버';
    if(!list.length){
      tbody.innerHTML = '<tr><td colspan="9"><div class="manage-empty">조건에 맞는 서버가 없습니다.</div></td></tr>';
    } else {
      tbody.innerHTML = list.map(function(s){
        var checked = selectedManageIds.has(s.id) ? ' checked' : '';
        return '<tr data-id="'+s.id+'">' +
          '<td><input type="checkbox" class="row-check" data-id="'+s.id+'"'+checked+'></td>' +
          '<td><div class="row-name"><span class="proto-chip sm proto-'+s.protocol+'">'+PROTO[s.protocol].icon+'</span>'+escapeHtml(s.name)+'</div></td>' +
          '<td>'+escapeHtml(s.group)+'</td>' +
          '<td>'+PROTO[s.protocol].label+'</td>' +
          '<td>'+escapeHtml(s.host)+'</td>' +
          '<td class="num">'+(s.port || '—')+'</td>' +
          '<td>'+escapeHtml(s.auth || '—')+'</td>' +
          '<td>'+escapeHtml(s.since || '-')+'</td>' +
          '<td><div class="manage-row-actions">' +
            '<button class="manage-icon-btn" data-edit="'+s.id+'" title="편집"><svg class="icon" viewBox="0 0 20 20" style="width:14px;height:14px"><path d="M4 16l.7-3L14 3.7a1.5 1.5 0 0 1 2.1 0l.2.2a1.5 1.5 0 0 1 0 2.1L7 15.3 4 16z"></path></svg></button>' +
            '<button class="manage-icon-btn danger" data-del="'+s.id+'" title="삭제"><svg class="icon" viewBox="0 0 20 20" style="width:14px;height:14px"><path d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6M5.5 6l.6 10a1.5 1.5 0 0 0 1.5 1.4h4.8a1.5 1.5 0 0 0 1.5-1.4L14.5 6"></path></svg></button>' +
          '</div></td></tr>';
      }).join('');
    }
    document.getElementById('manageSelCount').textContent = '선택된 항목: ' + selectedManageIds.size + '개';
    document.getElementById('manageSelectAll').checked = list.length > 0 && list.every(function(s){ return selectedManageIds.has(s.id); });
  }

  function openManage(){
    populateGroupSelectors();
    renderManageTable();
    appEl.classList.add('manage-open');
  }
  function closeManage(){ appEl.classList.remove('manage-open'); }

  document.getElementById('manageOpenBtn').addEventListener('click', openManage);
  document.getElementById('manageCloseBtn').addEventListener('click', closeManage);
  document.getElementById('manageBackdrop').addEventListener('click', function(e){
    if(e.target.id === 'manageBackdrop') closeManage();
  });
  document.getElementById('manageSearch').addEventListener('input', function(e){ manageSearchQ = e.target.value; renderManageTable(); });
  document.getElementById('manageProtoFilter').addEventListener('change', function(e){ manageProtoF = e.target.value; renderManageTable(); });
  document.getElementById('manageGroupFilter').addEventListener('change', function(e){ manageGroupF = e.target.value; renderManageTable(); });

  document.querySelectorAll('.manage-table thead th[data-sort]').forEach(function(th){
    th.addEventListener('click', function(){
      if(manageSort.key === th.dataset.sort){ manageSort.dir *= -1; } else { manageSort = { key: th.dataset.sort, dir: 1 }; }
      document.querySelectorAll('.manage-table thead th').forEach(function(t){ t.classList.remove('sorted'); t.removeAttribute('data-dir'); });
      th.classList.add('sorted');
      th.setAttribute('data-dir', manageSort.dir === 1 ? '▲' : '▼');
      renderManageTable();
    });
  });

  document.getElementById('manageSelectAll').addEventListener('change', function(e){
    var list = filteredSortedServers();
    list.forEach(function(s){ if(e.target.checked) selectedManageIds.add(s.id); else selectedManageIds.delete(s.id); });
    renderManageTable();
  });

  document.getElementById('manageTbody').addEventListener('click', function(e){
    var editBtn = e.target.closest('[data-edit]');
    var delBtn = e.target.closest('[data-del]');
    var check = e.target.closest('.row-check');
    if(editBtn){ openEdit(editBtn.dataset.edit); return; }
    if(delBtn){ deleteServerConfirm(delBtn.dataset.del); return; }
    if(check){
      if(check.checked) selectedManageIds.add(check.dataset.id); else selectedManageIds.delete(check.dataset.id);
      document.getElementById('manageSelCount').textContent = '선택된 항목: ' + selectedManageIds.size + '개';
      document.getElementById('manageSelectAll').checked = filteredSortedServers().every(function(s){ return selectedManageIds.has(s.id); });
      return;
    }
    var tr = e.target.closest('tr[data-id]');
    if(tr){ openEdit(tr.dataset.id); }
  });

  document.getElementById('manageBulkDeleteBtn').addEventListener('click', function(){
    if(!selectedManageIds.size) return;
    if(!confirm(selectedManageIds.size + '개 서버를 삭제할까요? 열려 있는 세션도 함께 종료됩니다.')) return;
    Array.from(selectedManageIds).forEach(removeServerById);
    selectedManageIds.clear();
    renderTree(); renderManageTable();
  });

  document.getElementById('manageBulkMoveBtn').addEventListener('click', function(){
    var target = document.getElementById('manageBulkGroup').value;
    if(!target || !selectedManageIds.size) return;
    SERVERS.forEach(function(s){ if(selectedManageIds.has(s.id)) s.group = target; });
    selectedManageIds.clear();
    document.getElementById('manageBulkGroup').value = '';
    renderTree(); renderManageTable();
  });

  function deleteServerConfirm(id){
    var s = SERVERS.find(function(x){ return x.id === id; });
    if(!s) return;
    if(!confirm('"'+s.name+'" 서버를 삭제할까요?')) return;
    removeServerById(id);
    renderTree(); renderManageTable();
  }

  // ==================================================================
  // S2. 서버 등록/수정 모달 (S7과 topbar [서버 등록] 양쪽에서 공유)
  // ==================================================================
  function populateJumpSelect(currentId){
    var sel = document.getElementById('f-jump');
    var opts = SERVERS.filter(function(s){ return s.protocol === 'ssh' && s.id !== currentId; })
      .map(function(s){ return '<option value="'+s.id+'">'+escapeHtml(s.name)+'</option>'; }).join('');
    sel.innerHTML = '<option value="">없음</option>' + opts;
  }

  function toggleSshOnlyFields(){
    var isSsh = document.getElementById('f-protocol').value === 'ssh';
    document.getElementById('row-f-jump').style.display = isSsh ? '' : 'none';
    document.getElementById('row-f-tmux').style.display = isSsh ? '' : 'none';
  }
  document.getElementById('f-protocol').addEventListener('change', toggleSshOnlyFields);

  function openEdit(id){
    editingId = id || null;
    var s = id ? SERVERS.find(function(x){ return x.id === id; }) : null;
    document.getElementById('editTitle').textContent = s ? '서버 수정' : '서버 등록';
    document.getElementById('f-name').value = s ? s.name : '';
    document.getElementById('f-group').value = s ? s.group : (manageGroupF !== 'all' ? manageGroupF : (GROUP_ORDER[0] || '기타'));
    document.getElementById('f-protocol').value = s ? s.protocol : 'ssh';
    document.getElementById('f-host').value = s ? s.host : '';
    document.getElementById('f-port').value = s && s.port ? s.port : '';
    document.getElementById('f-auth').value = s ? s.auth : '';
    document.getElementById('f-tmux').value = s && s.tmux !== '—' ? s.tmux : '';
    populateJumpSelect(id);
    document.getElementById('f-jump').value = s && s.jump ? s.jump : '';
    document.getElementById('editError').textContent = '';
    document.getElementById('editDeleteBtn').style.display = s ? '' : 'none';
    toggleSshOnlyFields();
    populateGroupSelectors();
    appEl.classList.add('edit-open');
    setTimeout(function(){ document.getElementById('f-name').focus(); }, 0);
  }
  function closeEdit(){ appEl.classList.remove('edit-open'); editingId = null; }

  function propagateIdRename(oldId, newId){
    var tab = tabbar.querySelector('.tab[data-id="'+oldId+'"]');
    if(tab){ tab.dataset.id = newId; tab.querySelector('.tab-name').textContent = newId; }
    var pane = panes.querySelector('.pane[data-id="'+oldId+'"]');
    if(pane) pane.dataset.id = newId;
    Object.keys(lastActiveByFilter).forEach(function(k){ if(lastActiveByFilter[k] === oldId) lastActiveByFilter[k] = newId; });
    SERVERS.forEach(function(s){ if(s.jump === oldId) s.jump = newId; });
  }

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
    var auth = document.getElementById('f-auth').value.trim();
    var jump = document.getElementById('f-jump').value || null;
    var tmux = document.getElementById('f-tmux').value.trim();
    var errEl = document.getElementById('editError');

    if(!name || !host){ errEl.textContent = '이름과 호스트는 필수입니다.'; return; }
    var dup = SERVERS.find(function(s){ return s.id === name && s.id !== editingId; });
    if(dup){ errEl.textContent = '이미 사용 중인 이름입니다.'; return; }

    if(GROUP_ORDER.indexOf(group) === -1) GROUP_ORDER.push(group);

    if(editingId){
      var s = SERVERS.find(function(x){ return x.id === editingId; });
      var oldId = s.id;
      s.name = name; s.id = name; s.group = group; s.protocol = protocol; s.host = host; s.port = port;
      s.auth = auth; s.jump = jump; s.tmux = protocol === 'ssh' ? (tmux || name) : '—';
      if(oldId !== name) propagateIdRename(oldId, name);
    } else {
      SERVERS.push({
        id: name, name: name, group: group, protocol: protocol, host: host, port: port, auth: auth,
        jump: jump, tmux: protocol === 'ssh' ? (tmux || name) : '—', status: 'off', since: '연결 안 됨'
      });
    }
    closeEdit();
    renderTree(); renderManageTable(); populateGroupSelectors();
  });

  document.querySelectorAll('.rail-btn[data-filter]').forEach(function(btn){
    btn.addEventListener('click', function(){ applyFilter(btn.dataset.filter); });
  });

  tabbar.addEventListener('click', function(e){
    if(e.target.closest('.tab-add')){ openPalette(); return; }
    var close = e.target.closest('.close');
    var tab = e.target.closest('.tab');
    if(!tab) return;
    if(close){
      var id = tab.dataset.id;
      var wasActive = tab.classList.contains('active');
      var pane = panes.querySelector('.pane[data-id="'+id+'"]');
      tab.remove();
      if(pane) pane.remove();
      renumberTabs();
      if(wasActive){
        var remaining = visibleTabs()[0];
        if(remaining) activate(remaining.dataset.id); else activateEmpty(currentFilter);
      }
      return;
    }
    activate(tab.dataset.id);
  });

  // ---- inspector toggle ----
  var inspOpen = true;
  function setInspector(open){
    inspOpen = open;
    appEl.classList.toggle('insp-collapsed', !open);
    inspToggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }
  function toggleInspector(){ setInspector(!inspOpen); }
  inspToggleBtn.addEventListener('click', toggleInspector);
  inspHandle.addEventListener('click', toggleInspector);
  inspCollapseBtn.addEventListener('click', toggleInspector);

  // ---- command palette ----
  var paletteOpenBtn = document.getElementById('paletteOpenBtn');
  var paletteBackdrop = document.getElementById('paletteBackdrop');
  var paletteInput = document.getElementById('paletteInput');
  var paletteList = document.getElementById('paletteList');

  function allServers(){
    return Array.prototype.map.call(tree.querySelectorAll('.server'), function(s){
      return { id:s.dataset.id, group:s.dataset.group, proto:s.dataset.protocol };
    });
  }

  function renderPalette(q){
    var items = allServers().filter(function(s){
      return !q || s.id.toLowerCase().indexOf(q.toLowerCase()) > -1;
    });
    paletteList.innerHTML = items.map(function(s, i){
      return '<div class="palette-item'+(i===0?' hi':'')+'" data-id="'+s.id+'">' +
        '<span class="proto-chip sm proto-'+s.proto+'">'+PROTO[s.proto].icon+'</span>' +
        '<span>'+s.id+'</span><span class="grp">'+s.group+' · '+PROTO[s.proto].label+'</span></div>';
    }).join('') || '<div class="palette-item" style="color:var(--text-faint)">결과 없음</div>';
  }

  function openPalette(){
    appEl.classList.add('palette-open');
    paletteInput.value = '';
    renderPalette('');
    setTimeout(function(){ paletteInput.focus(); }, 0);
  }
  function closePalette(){ appEl.classList.remove('palette-open'); }

  paletteOpenBtn.addEventListener('click', openPalette);
  paletteBackdrop.addEventListener('click', function(e){ if(e.target === paletteBackdrop) closePalette(); });
  paletteInput.addEventListener('input', function(){ renderPalette(paletteInput.value); });
  paletteList.addEventListener('click', function(e){
    var item = e.target.closest('.palette-item[data-id]');
    if(item){ selectServer(item.dataset.id); closePalette(); }
  });

  // ---- keyboard shortcuts ----
  document.addEventListener('keydown', function(e){
    if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); openPalette(); return; }
    if(e.key === 'Escape'){
      if(appEl.classList.contains('edit-open')){ closeEdit(); return; }
      if(appEl.classList.contains('manage-open')){ closeManage(); return; }
      closePalette(); return;
    }
    if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i'){ e.preventDefault(); toggleInspector(); return; }
    if((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)){
      e.preventDefault();
      var tabs = visibleTabs();
      var idx = parseInt(e.key, 10) - 1;
      if(tabs[idx]) activate(tabs[idx].dataset.id);
      return;
    }
    var next = (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) || (e.metaKey && e.altKey && e.key === 'ArrowRight') ||
      ((e.metaKey || e.ctrlKey) && e.key === '>');
    var prev = (e.ctrlKey && e.key === 'Tab' && e.shiftKey) || (e.metaKey && e.altKey && e.key === 'ArrowLeft') ||
      ((e.metaKey || e.ctrlKey) && e.key === '<');
    if(next || prev){
      e.preventDefault();
      var list = visibleTabs();
      if(!list.length) return;
      var cur = list.findIndex(function(t){ return t.classList.contains('active'); });
      var to = next ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
      activate(list[to].dataset.id);
    }
  });

  var scraped = scrapeServers();
  SERVERS = scraped.list;
  GROUP_ORDER = scraped.order;
  collapsedGroups = scraped.collapsed;
  renderTree();
  populateGroupSelectors();

  renumberTabs();
  recordActive('prod-web-01');
})();

// ---- preload/main process smoke test (scaffold verification) ----
if (window.onegyeok && typeof window.onegyeok.ping === 'function') {
  window.onegyeok.ping().then(function (reply) {
    console.log('[onegyeok] main process round-trip:', reply);
  });
} else {
  console.warn('[onegyeok] preload bridge(window.onegyeok) not found — check preload.js wiring');
}
