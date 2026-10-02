
(function(){
  var appEl = document.getElementById('app');
  var tree = document.getElementById('tree');
  var tabbar = document.getElementById('tabbar');
  var panes = document.getElementById('panes');
  var inspToggleBtn = document.getElementById('inspToggleBtn');
  var inspHandle = document.getElementById('inspHandle');
  var inspCollapseBtn = document.getElementById('inspCollapseBtn');

  // ---- sidebar / inspector panel resize (드래그로 좌우 폭 조절, 끝까지 밀면 접힘) ----
  var SIDEBAR_FALLBACK_W = 236;
  var INSPECTOR_FALLBACK_W = 272;
  var INSPECTOR_COLLAPSE_AT = 90;

  function setupResizer(handleEl, cssVar, opts){
    var dragging = false, startX = 0, startWidth = 0;
    handleEl.addEventListener('mousedown', function(e){
      dragging = true;
      handleEl.classList.add('dragging');
      appEl.classList.add('resizing');
      startX = e.clientX;
      startWidth = parseInt(getComputedStyle(appEl).getPropertyValue(cssVar), 10) || opts.fallback;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e){
      if(!dragging) return;
      var delta = (e.clientX - startX) * (opts.reverse ? -1 : 1);
      // 범위를 작은 고정값으로 가두지 않고, 창 폭 기준으로 넉넉하게만 제한한다 (끝까지 밀면 0까지 줄어들어 접힘).
      var maxW = Math.max(opts.fallback, window.innerWidth - opts.reserve);
      var newW = Math.min(maxW, Math.max(0, startWidth + delta));
      appEl.style.setProperty(cssVar, newW + 'px');
      if(opts.onWidthChange) opts.onWidthChange(newW);
    });
    document.addEventListener('mouseup', function(){
      if(!dragging) return;
      dragging = false;
      handleEl.classList.remove('dragging');
      appEl.classList.remove('resizing');
      document.body.style.userSelect = '';
    });
  }

  setupResizer(document.getElementById('resizerSidebar'), '--sidebar-w', {
    reverse:false, fallback:SIDEBAR_FALLBACK_W, reserve:600
  });
  setupResizer(document.getElementById('resizerInspector'), '--inspector-w', {
    reverse:true, fallback:INSPECTOR_FALLBACK_W, reserve:600,
    onWidthChange: function(w){
      // 연결정보 패널은 이미 있는 접힘 상태(아이콘/핸들로 재오픈)로 스냅시킨다.
      if(w < INSPECTOR_COLLAPSE_AT && inspOpen){
        setInspector(false);
        appEl.style.setProperty('--inspector-w', INSPECTOR_FALLBACK_W + 'px');
      }
    }
  });

  var PROTO = {
    ssh:  { label:'SSH',  icon:'<svg viewBox="0 0 20 20"><polyline points="3 5 8 10 3 15"></polyline><line x1="10" y1="15" x2="17" y2="15"></line></svg>' },
    sql:  { label:'SQL',  icon:'<svg viewBox="0 0 20 20"><ellipse cx="10" cy="5" rx="7" ry="2.6"></ellipse><path d="M3 5v10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V5"></path><path d="M3 10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"></path></svg>' },
    rdp:  { label:'RDP',  icon:'<svg viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="11" rx="1.4"></rect><line x1="7" y1="17" x2="13" y2="17"></line></svg>' },
    vnc:  { label:'VNC',  icon:'<svg viewBox="0 0 20 20"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"></path><circle cx="10" cy="10" r="2.3"></circle></svg>' },
    sftp: { label:'SFTP', icon:'<svg viewBox="0 0 20 20"><path d="M2 6l2-2h4l2 2h8v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6z"></path></svg>' },
    web:  { label:'Web',  icon:'<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"></circle><line x1="2.5" y1="10" x2="17.5" y2="10"></line><path d="M10 2.5c2.2 2 2.2 13 0 15M10 2.5c-2.2 2-2.2 13 0 15"></path></svg>' }
  };

  var SQL_ENGINE_LABELS = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', mssql: 'MS SQL Server' };

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

  // 인증정보(비밀번호·Passphrase)는 저장하지 않는다(F-301/601) — authMethod/keyFilePath는
  // "어떻게 물어볼지"를 결정하는 메타데이터일 뿐, 실제 비밀값은 접속 시점에만 메모리에 存在한다.
  function authLabel(s){
    if(s.authMethod === 'publickey'){
      var base = s.keyFilePath ? s.keyFilePath.split('/').pop() : null;
      return 'SSH Key' + (base ? ' (' + base + ')' : '');
    }
    return '비밀번호';
  }

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

  // ---- 범용 텍스트 입력 모달 (Electron은 window.prompt()를 지원하지 않아 직접 구현) ----
  var promptBackdrop = document.getElementById('promptBackdrop');
  var promptInput = document.getElementById('promptInput');
  var promptTitleEl = document.getElementById('promptTitle');
  var promptErrorEl = document.getElementById('promptError');
  var promptOkBtn = document.getElementById('promptOkBtn');
  var promptCancelBtn = document.getElementById('promptCancelBtn');

  function showTextPrompt(title, placeholder){
    return new Promise(function(resolve){
      promptTitleEl.textContent = title;
      promptInput.placeholder = placeholder || '';
      promptInput.value = '';
      promptErrorEl.textContent = '';
      promptBackdrop.classList.add('show');
      setTimeout(function(){ promptInput.focus(); }, 0);

      function cleanup(){
        promptBackdrop.classList.remove('show');
        promptOkBtn.removeEventListener('click', onOk);
        promptCancelBtn.removeEventListener('click', onCancel);
        promptInput.removeEventListener('keydown', onKeydown);
        promptBackdrop.removeEventListener('click', onBackdropClick);
      }
      function onOk(){
        var v = promptInput.value.trim();
        cleanup();
        resolve(v || null);
      }
      function onCancel(){ cleanup(); resolve(null); }
      function onKeydown(e){
        if(e.key === 'Enter'){ e.preventDefault(); e.stopPropagation(); onOk(); }
        else if(e.key === 'Escape'){ e.stopPropagation(); onCancel(); }
      }
      function onBackdropClick(e){ if(e.target === promptBackdrop) onCancel(); }

      promptOkBtn.addEventListener('click', onOk);
      promptCancelBtn.addEventListener('click', onCancel);
      promptInput.addEventListener('keydown', onKeydown);
      promptBackdrop.addEventListener('click', onBackdropClick);
    });
  }

  function addNewGroup(){
    return showTextPrompt('새 그룹 추가', '예: 모니터링').then(function(name){
      if(!name) return null;
      if(GROUP_ORDER.indexOf(name) === -1) GROUP_ORDER.push(name);
      renderTree();
      populateGroupSelectors();
      return name;
    });
  }

  document.querySelector('.add-group').addEventListener('click', function(){ addNewGroup(); });
  document.getElementById('manageAddGroupBtn').addEventListener('click', function(){
    addNewGroup().then(function(name){ if(name) renderManageTable(); });
  });

  var currentInspectedId = null; // 인스펙터에 표시 중인 탭(세션 인스턴스) id
  var currentInspectedServerId = null; // 위 탭이 속한 서버 id (메모 등 서버 단위 데이터에 사용)
  var memoEl = document.getElementById('i-memo');
  var memoStatusEl = document.getElementById('i-memo-status');
  var memoSaveTimer = null;
  var hasMemoBridge = !!(window.onegyeok && window.onegyeok.saveMemo);

  function showMemoStatus(text, isError){
    memoStatusEl.textContent = text;
    memoStatusEl.classList.toggle('err', !!isError);
    memoStatusEl.classList.add('show');
    clearTimeout(memoStatusEl._hideTimer);
    memoStatusEl._hideTimer = setTimeout(function(){ memoStatusEl.classList.remove('show'); }, 1500);
  }

  function persistMemo(serverId, text){
    if(!hasMemoBridge || !serverId) return;
    window.onegyeok.saveMemo(serverId, text).then(function(res){
      if(res && res.ok) showMemoStatus('저장됨');
      else showMemoStatus('저장 불가(암호화 미지원)', true);
    }).catch(function(){ showMemoStatus('저장 실패', true); });
  }

  function scheduleMemoSave(serverId, text){
    clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(function(){ persistMemo(serverId, text); }, 400);
  }

  function flushMemoSave(){
    clearTimeout(memoSaveTimer);
    if(!currentInspectedServerId) return;
    var srv = SERVERS.find(function(s){ return s.id === currentInspectedServerId; });
    if(srv) persistMemo(currentInspectedServerId, srv.memo || '');
  }

  // 탭(세션 인스턴스) id로부터 그 탭이 속한 서버 id를 찾는다. 같은 서버로 여러 탭을 열 수 있으므로
  // (탭 id ≠ 서버 id)인 경우가 일반적이다 — 탭 엘리먼트의 data-server-id를 기준으로 판단한다.
  function serverIdForTab(tabId){
    var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
    return (tab && tab.dataset.serverId) || tabId;
  }

  function inspectorFor(tabId){
    var serverId = serverIdForTab(tabId);
    var row = tree.querySelector('.server[data-id="'+serverId+'"]');
    if(!row) return;
    if(currentInspectedServerId && currentInspectedServerId !== serverId) flushMemoSave();
    currentInspectedId = tabId;
    currentInspectedServerId = serverId;
    var proto = row.dataset.protocol;
    var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
    var tabNameEl = tab && tab.querySelector('.tab-name');
    document.getElementById('i-name').textContent = (tabNameEl && tabNameEl.textContent) || serverId;
    document.getElementById('i-group').textContent = row.dataset.group;
    document.getElementById('i-host').textContent = row.dataset.host;
    document.getElementById('i-username').textContent = row.dataset.username || '(접속 시 입력)';
    document.getElementById('i-auth').textContent = row.dataset.auth;
    document.getElementById('i-jump').textContent = row.dataset.jump;
    document.getElementById('i-since').textContent = row.dataset.since;
    document.getElementById('i-proto-label').textContent = PROTO[proto].label;
    var chip = document.getElementById('i-proto-chip');
    chip.className = 'proto-chip sm proto-' + proto;
    chip.innerHTML = PROTO[proto].icon;
    document.getElementById('row-jump').style.display = proto === 'ssh' ? '' : 'none';
    document.getElementById('row-sql-engine').style.display = proto === 'sql' ? '' : 'none';
    document.getElementById('row-sql-database').style.display = proto === 'sql' ? '' : 'none';
    document.getElementById('row-username').style.display = proto === 'web' ? 'none' : '';
    var srv = SERVERS.find(function(s){ return s.id === serverId; });
    if(proto === 'sql'){
      document.getElementById('i-sql-engine').textContent = SQL_ENGINE_LABELS[row.dataset.sqlEngine] || row.dataset.sqlEngine;
      document.getElementById('i-sql-database').textContent = row.dataset.database || '(기본값)';
    }
    memoEl.value = (srv && srv.memo) || '';
    memoStatusEl.classList.remove('show');

    var connBtn = document.getElementById('inspConnActionBtn');
    if(proto === 'ssh' || proto === 'sql' || proto === 'rdp'){
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

  function ensurePane(tabId, serverId){
    var pane = panes.querySelector('.pane[data-id="'+tabId+'"]');
    if(pane) return pane;
    var row = tree.querySelector('.server[data-id="'+serverId+'"]');
    var proto = row.dataset.protocol;
    var el = document.createElement('div');
    el.dataset.id = tabId;
    el.dataset.serverId = serverId;
    if(proto === 'ssh'){
      el.className = 'pane pane-layout';
      el.innerHTML =
        '<div class="pane-split-controls">' +
          '<button type="button" class="split-btn" data-orientation="row" title="세로 분할 (⌘D)"><svg class="icon" viewBox="0 0 20 20" style="width:12px;height:12px"><rect x="2" y="2" width="7" height="16" rx="1"></rect><rect x="11" y="2" width="7" height="16" rx="1"></rect></svg></button>' +
          '<button type="button" class="split-btn" data-orientation="column" title="가로 분할 (⌘⇧D)"><svg class="icon" viewBox="0 0 20 20" style="width:12px;height:12px"><rect x="2" y="2" width="16" height="7" rx="1"></rect><rect x="2" y="11" width="16" height="7" rx="1"></rect></svg></button>' +
        '</div>' +
        '<div class="pane-cells"></div>';
      el.classList.add('ssh-pane');
      panes.appendChild(el);
      tabLayouts[tabId] = { orientation: null, paneIds: [tabId] };
      var firstCell = createPaneCellDom(tabId);
      el.querySelector('.pane-cells').appendChild(firstCell.cellEl);
      startSshSession(tabId, serverId, firstCell.statusEl, firstCell.hostEl);
      updateLayoutChrome(tabId);
      return el;
    } else if(proto === 'sql'){
      el.className = 'pane sql-pane';
      panes.appendChild(el);
      startDbSession(tabId, serverId, el);
      return el;
    } else if(proto === 'rdp'){
      el.className = 'pane rdp-pane';
      panes.appendChild(el);
      startRdpSession(tabId, serverId, el);
      return el;
    } else {
      el.className = 'pane placeholder-pane proto-' + proto;
      el.innerHTML =
        '<div class="ph-icon">'+PROTO[proto].icon+'</div>' +
        '<div class="ph-title">'+serverId+'</div>' +
        '<div class="ph-desc">'+PROTO[proto].label+' 세션이 여기에 표시됩니다.</div>';
    }
    panes.appendChild(el);
    return el;
  }

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
  var sshSessions = {}; // tabId -> { term, fitAddon, statusEl, hostEl, state, handleInput, srv }
  var dbSessions = {}; // tabId -> { state, srv, el, dom } (SQL 클라이언트 세션, 아래 쪽에서 정의)
  var rdpSessions = {}; // tabId -> { state, srv, el, dom, client, mouse, keyboard } (RDP 세션, 아래 쪽에서 정의)
  var hasSshBridge = !!(window.onegyeok && window.onegyeok.ssh);

  // 사이드바의 서버 상태 점은 "그 서버로 열린 탭 중 하나라도 연결돼 있는지"를 보여준다
  // (같은 서버로 여러 탭을 동시에 열 수 있으므로 하나의 세션 상태만으로는 부족하다).
  // SSH/SQL 두 세션 저장소를 모두 확인한다 — 한 서버는 둘 중 한 프로토콜만 가지지만, 조회 쪽을
  // 프로토콜 불문하고 공용으로 써도 무방하도록 통합했다.
  function updateServerRowStatus(serverId){
    var row = tree.querySelector('.server[data-id="'+serverId+'"]');
    if(!row) return;
    var anyConnected = Object.keys(sshSessions).some(function(tid){
      var s = sshSessions[tid];
      return s && s.srv && s.srv.id === serverId && s.state === 'connected';
    }) || Object.keys(dbSessions).some(function(tid){
      var s = dbSessions[tid];
      return s && s.srv && s.srv.id === serverId && s.state === 'connected';
    }) || Object.keys(rdpSessions).some(function(tid){
      var s = rdpSessions[tid];
      return s && s.srv && s.srv.id === serverId && s.state === 'connected';
    });
    row.dataset.status = anyConnected ? 'on' : 'off';
    var dot = row.querySelector('.proto-chip .stat');
    if(dot) dot.classList.toggle('on', anyConnected);
  }

  // 인스펙터의 "연결 종료/재연결" 버튼은 SSH/SQL/RDP 세션 어느 쪽이든 같은 방식으로 상태를 읽는다.
  function sessionFor(tabId){ return sshSessions[tabId] || dbSessions[tabId] || rdpSessions[tabId]; }

  function disposeSession(tabId){
    if(sshSessions[tabId]) disposeSshSession(tabId);
    else if(dbSessions[tabId]) disposeDbSession(tabId);
    else if(rdpSessions[tabId]) disposeRdpSession(tabId);
  }

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

  function updateConnActionButton(id){
    var btn = document.getElementById('inspConnActionBtn');
    var label = document.getElementById('inspConnActionLabel');
    var endIcon = btn.querySelector('.conn-action-icon-end');
    var retryIcon = btn.querySelector('.conn-action-icon-retry');
    var s = sessionFor(id);
    var connected = s && s.state === 'connected';
    btn.classList.toggle('danger', connected);
    label.textContent = connected ? '연결 종료' : '재연결';
    endIcon.style.display = connected ? '' : 'none';
    retryIcon.style.display = connected ? 'none' : '';
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

  // 탭을 완전히 닫는다 — skipDispose가 true면 세션은 이미 다른 곳으로 옮겨진 상태이므로
  // 탭/레이아웃 UI만 정리하고 세션 자체는 건드리지 않는다(moveSessionIntoCell에서 사용).
  function closeTabById(tabId, skipDispose){
    var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
    if(!tab) return;
    var wasActive = tab.classList.contains('active');
    if(!skipDispose){
      var layout = tabLayouts[tabId];
      var ids = layout ? layout.paneIds.slice() : [tabId];
      ids.forEach(function(id){ disposeSession(id); });
    }
    var pane = panes.querySelector('.pane[data-id="'+tabId+'"]');
    tab.remove();
    if(pane) pane.remove();
    delete tabLayouts[tabId];
    renumberTabs();
    if(wasActive){
      var remaining = visibleTabs()[0];
      if(remaining) activate(remaining.dataset.id); else activateEmpty(currentFilter);
    }
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

  // ==================================================================
  // SQL DB 클라이언트 (디비버 느낌의 "SQL" 연결 종류) — MySQL/PostgreSQL/MS SQL Server
  //
  // SSH와 동일한 보안 원칙: 비밀번호는 저장하지 않고, 탭 안의 접속 폼에 그때그때 직접
  // 입력받는다. 터미널이 아니라 쿼리 에디터 + 결과 테이블로 구성된 일반적인 폼 UI라서,
  // SSH처럼 키 입력을 가로채는 방식 대신 평범한 input/textarea를 그대로 사용한다.
  // ==================================================================
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

  // ==================================================================
  // RDP 클라이언트 (Apache Guacamole 기반 — docs/기술스택/03_RDP_기술스택.md)
  //
  // 메인 프로세스(IPC)는 로컬 WebSocket 주소 + 1회용 암호화 토큰만 돌려준다. 실제 화면
  // 스트림은 여기서 그 주소로 직접 WebSocket을 열어 받는다(IPC를 거치지 않음 — 바이너리
  // 화면 데이터를 IPC로 중계하면 느리고 무겁기 때문). 비밀번호는 SSH/SQL과 동일한 원칙으로
  // 저장하지 않고, 탭 안의 접속 폼에 그때그때 직접 입력받는다.
  // ==================================================================
  var hasRdpBridge = !!(window.onegyeok && window.onegyeok.rdp);

  function setRdpStatus(tabId, state, message){
    var s = rdpSessions[tabId];
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

  function buildRdpPaneDom(el){
    el.innerHTML =
      '<div class="rdp-connect">' +
        '<div class="rdp-connect-box">' +
          '<div class="rdp-connect-title"></div>' +
          '<label class="rdp-f-username-row" style="display:none">사용자명<input type="text" class="rdp-f-username" autocomplete="off"></label>' +
          '<label>비밀번호<input type="password" class="rdp-f-password" autocomplete="off"></label>' +
          '<div class="rdp-connect-error"></div>' +
          '<button type="button" class="rdp-connect-btn">접속</button>' +
        '</div>' +
      '</div>' +
      '<div class="rdp-workspace">' +
        '<div class="rdp-toolbar">' +
          '<span class="rdp-meta"></span>' +
          '<button type="button" class="rdp-disconnect-btn" title="연결 종료"><svg class="icon" viewBox="0 0 20 20" style="width:13px;height:13px"><circle cx="10" cy="10" r="7.5"></circle><line x1="7" y1="7" x2="13" y2="13"></line><line x1="13" y1="7" x2="7" y2="13"></line></svg></button>' +
        '</div>' +
        '<div class="rdp-display-wrap" tabindex="0"></div>' +
      '</div>';
    return {
      titleEl: el.querySelector('.rdp-connect-title'),
      usernameRow: el.querySelector('.rdp-f-username-row'),
      usernameInput: el.querySelector('.rdp-f-username'),
      passwordInput: el.querySelector('.rdp-f-password'),
      connectError: el.querySelector('.rdp-connect-error'),
      connectBtn: el.querySelector('.rdp-connect-btn'),
      meta: el.querySelector('.rdp-meta'),
      disconnectBtn: el.querySelector('.rdp-disconnect-btn'),
      displayWrap: el.querySelector('.rdp-display-wrap'),
    };
  }

  // Guacamole 프로토콜 상태 코드를 SSH/SQL과 동일한 kind('auth'/'network'/'other') 체계로 분류한다.
  function classifyRdpStatus(code){
    var C = window.Guacamole.Status.Code;
    if(code === C.CLIENT_UNAUTHORIZED || code === C.CLIENT_FORBIDDEN) return 'auth';
    if(code === C.UPSTREAM_NOT_FOUND || code === C.UPSTREAM_UNAVAILABLE || code === C.UPSTREAM_TIMEOUT) return 'network';
    return 'other';
  }
  function rdpStatusMessage(kind){
    if(kind === 'auth') return '인증 실패 — 사용자명 또는 비밀번호를 확인해주세요';
    if(kind === 'network') return '대상 서버에 연결할 수 없습니다 — 호스트/포트를 확인해주세요';
    return '연결 실패';
  }

  function showRdpConnectForm(tabId){
    var s = rdpSessions[tabId];
    if(!s) return;
    s.el.classList.remove('connected');
    s.dom.connectError.textContent = '';
    s.dom.passwordInput.value = '';
    s.dom.connectBtn.disabled = false;
    s.dom.connectBtn.textContent = '접속';
    if(s.client){
      try { s.client.disconnect(); } catch(_e){ /* noop */ }
      s.client = null; s.mouse = null; s.keyboard = null;
    }
    s.dom.displayWrap.innerHTML = '';
    setTimeout(function(){
      if(s.dom.usernameRow.style.display !== 'none') s.dom.usernameInput.focus();
      else s.dom.passwordInput.focus();
    }, 0);
  }

  function setupRdpInput(tabId){
    var s = rdpSessions[tabId];
    if(!s || !s.client) return;
    var mouse = new window.Guacamole.Mouse(s.dom.displayWrap);
    mouse.onEach(['mousedown', 'mousemove', 'mouseup'], function(e){
      s.client.sendMouseState(e.state, true);
    });
    s.mouse = mouse;

    var keyboard = new window.Guacamole.Keyboard(s.dom.displayWrap);
    keyboard.onkeydown = function(keysym){ s.client.sendKeyEvent(1, keysym); };
    keyboard.onkeyup = function(keysym){ s.client.sendKeyEvent(0, keysym); };
    s.keyboard = keyboard;
  }

  function startGuacamoleClient(tabId, wsBaseUrl, token){
    var s = rdpSessions[tabId];
    if(!s) return;
    // 토큰은 tunnel URL에 미리 붙이지 않는다 — WebSocketTunnel.connect(data)가 내부적으로
    // `tunnelURL + "?" + data`로 자기 쿼리스트링을 붙이므로, client.connect()에 넘겨야 한다.
    var tunnel = new window.Guacamole.WebSocketTunnel(wsBaseUrl);
    var client = new window.Guacamole.Client(tunnel);
    s.client = client;

    s.dom.displayWrap.appendChild(client.getDisplay().getElement());

    client.onstatechange = function(state){
      if(!rdpSessions[tabId]) return;
      var STATE = window.Guacamole.Client.State;
      if(state === STATE.CONNECTED){
        s.dom.connectBtn.disabled = false;
        s.dom.connectBtn.textContent = '접속';
        s.el.classList.add('connected');
        s.dom.meta.textContent = s.srv.host + ':' + (s.srv.port || 3389);
        setRdpStatus(tabId, 'connected', '');
        setupRdpInput(tabId);
        setTimeout(function(){ s.dom.displayWrap.focus(); }, 0);
      } else if(state === STATE.DISCONNECTED){
        if(s.state === 'connected'){
          setRdpStatus(tabId, 'disconnected', '연결이 종료되었습니다.');
          showRdpConnectForm(tabId);
        }
      }
    };

    client.onerror = function(status){
      if(!rdpSessions[tabId]) return;
      var kind = classifyRdpStatus(status.code);
      var message = rdpStatusMessage(kind);
      s.dom.connectBtn.disabled = false;
      s.dom.connectBtn.textContent = '접속';
      s.dom.connectError.textContent = message;
      setRdpStatus(tabId, 'error', message);
    };

    client.connect('token=' + encodeURIComponent(token));
  }

  function attemptRdpConnect(tabId){
    var s = rdpSessions[tabId];
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
    setRdpStatus(tabId, 'connecting', '');

    var rect = s.dom.displayWrap.getBoundingClientRect();
    var width = Math.max(320, Math.round(rect.width) || 1024);
    var height = Math.max(240, Math.round(rect.height) || 768);

    window.onegyeok.rdp.connect(tabId, {
      host: srv.host, port: srv.port || 3389, username: username, password: password,
      width: width, height: height,
    }).then(function(res){
      if(!rdpSessions[tabId]) return;
      if(!res.ok){
        s.dom.connectBtn.disabled = false;
        s.dom.connectBtn.textContent = '접속';
        s.dom.connectError.textContent = res.error || '연결 실패';
        setRdpStatus(tabId, 'error', res.error);
        return;
      }
      startGuacamoleClient(tabId, res.wsBaseUrl, res.token);
    });
  }

  // 연결된 상태에서 "연결 종료"를 누르면 탭은 유지한 채 다시 접속 폼으로 되돌린다.
  function disconnectRdpKeepTab(tabId){
    var s = rdpSessions[tabId];
    if(!s) return;
    if(hasRdpBridge) window.onegyeok.rdp.disconnect(tabId);
    setRdpStatus(tabId, 'disconnected', '연결이 종료되었습니다.');
    showRdpConnectForm(tabId);
  }

  function startRdpSession(tabId, serverId, el){
    var srv = SERVERS.find(function(s){ return s.id === serverId; });
    if(!srv) return;
    var dom = buildRdpPaneDom(el);
    dom.titleEl.textContent = srv.host + ':' + (srv.port || 3389);
    var showUsernameField = !srv.username;
    dom.usernameRow.style.display = showUsernameField ? '' : 'none';

    var session = { state: 'disconnected', srv: srv, el: el, dom: dom, client: null, mouse: null, keyboard: null };
    rdpSessions[tabId] = session;

    dom.connectBtn.addEventListener('click', function(){ attemptRdpConnect(tabId); });
    dom.passwordInput.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ e.preventDefault(); attemptRdpConnect(tabId); } });
    dom.disconnectBtn.addEventListener('click', function(){ disconnectRdpKeepTab(tabId); });

    if(!hasRdpBridge || !window.Guacamole){
      dom.connectError.textContent = 'RDP 연결 기능을 사용할 수 없습니다 (preload 브리지 없음)';
      dom.connectBtn.disabled = true;
      return;
    }
    setTimeout(function(){
      if(showUsernameField) dom.usernameInput.focus(); else dom.passwordInput.focus();
    }, 0);
  }

  function disposeRdpSession(tabId){
    var s = rdpSessions[tabId];
    if(!s) return;
    if(s.client){ try { s.client.disconnect(); } catch(_e){ /* noop */ } }
    if(hasRdpBridge) window.onegyeok.rdp.disconnect(tabId);
    var serverId = s.srv && s.srv.id;
    delete rdpSessions[tabId];
    if(serverId) updateServerRowStatus(serverId);
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

  document.getElementById('inspConnActionBtn').addEventListener('click', function(){
    var id = currentInspectedId;
    if(!id) return;
    var s = sshSessions[id];
    if(s){
      if(s.state === 'connected'){
        if(hasSshBridge) window.onegyeok.ssh.disconnect(id);
      } else {
        s.term.writeln('');
        promptAndConnect(id, s);
      }
      return;
    }
    var d = dbSessions[id];
    if(d){
      if(d.state === 'connected') disconnectDbKeepTab(id);
      else attemptDbConnect(id);
      return;
    }
    var r = rdpSessions[id];
    if(r){
      if(r.state === 'connected') disconnectRdpKeepTab(id);
      else attemptRdpConnect(id);
    }
  });

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
    updateTabScrollButtons();
  }

  // ---- tab overflow scrolling (탭이 넘치면 화살표로 이동) ----
  var tabScrollLeftBtn = document.getElementById('tabScrollLeft');
  var tabScrollRightBtn = document.getElementById('tabScrollRight');

  function updateTabScrollButtons(){
    var overflowing = tabbar.scrollWidth > tabbar.clientWidth + 1;
    tabScrollLeftBtn.classList.toggle('show', overflowing && tabbar.scrollLeft > 2);
    tabScrollRightBtn.classList.toggle('show', overflowing && (tabbar.scrollLeft + tabbar.clientWidth < tabbar.scrollWidth - 2));
  }
  tabbar.addEventListener('scroll', updateTabScrollButtons);
  window.addEventListener('resize', updateTabScrollButtons);
  if(window.ResizeObserver){
    new ResizeObserver(updateTabScrollButtons).observe(tabbar);
  }
  tabScrollLeftBtn.addEventListener('click', function(){ tabbar.scrollBy({ left: -160, behavior: 'smooth' }); });
  tabScrollRightBtn.addEventListener('click', function(){ tabbar.scrollBy({ left: 160, behavior: 'smooth' }); });

  var tabSeq = 0;

  // 같은 서버로 이미 열려 있는 탭이 몇 개인지 세어 "서버명 #2"처럼 구분용 이름을 만든다.
  function tabLabelFor(serverId){
    var n = tabbar.querySelectorAll('.tab[data-server-id="'+serverId+'"]').length;
    return n === 0 ? serverId : serverId + ' #' + (n + 1);
  }

  function ensureTab(tabId, serverId){
    var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
    if(tab) return tab;
    var row = tree.querySelector('.server[data-id="'+serverId+'"]');
    var proto = row.dataset.protocol;
    var label = tabLabelFor(serverId);
    tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.id = tabId;
    tab.dataset.serverId = serverId;
    tab.dataset.protocol = proto;
    var reconnectBtn = (proto === 'ssh' || proto === 'sql' || proto === 'rdp')
      ? '<button type="button" class="tab-reconnect" title="빠른 재연결"><svg class="icon" viewBox="0 0 20 20"><polyline points="3 9 3 4 8 4"></polyline><path d="M3.5 13a6.5 6.5 0 1 0 1.6-6.8L3 9"></path></svg></button>'
      : '';
    tab.innerHTML =
      '<span class="proto-chip sm proto-'+proto+'">'+PROTO[proto].icon+'<span class="stat"></span></span>' +
      '<span class="tab-name">'+escapeHtml(label)+'</span>' + reconnectBtn + '<span class="tab-num"></span>' +
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
    var activeTab = null;
    tabbar.querySelectorAll('.tab').forEach(function(t){
      var match = t.dataset.id === id;
      t.classList.toggle('active', match);
      if(match) activeTab = t;
    });
    panes.querySelectorAll('.pane').forEach(function(p){ p.classList.toggle('active', p.dataset.id === id); });
    tree.querySelectorAll('.server').forEach(function(s){ s.classList.toggle('selected', s.dataset.id === id); });
    inspectorFor(id);
    recordActive(id);
    if(activeTab) activeTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    if(sshSessions[id]){
      requestAnimationFrame(function(){
        fitAllPanesInTab(id);
        if(sshSessions[id]) sshSessions[id].term.focus();
      });
    }
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
    // 사이드바가 드래그로 완전히 접혀 있으면, 레일 버튼(전체/프로토콜) 클릭으로도 다시 펼친다.
    var curSidebarW = parseInt(getComputedStyle(appEl).getPropertyValue('--sidebar-w'), 10) || 0;
    if(curSidebarW < 20){
      appEl.style.setProperty('--sidebar-w', SIDEBAR_FALLBACK_W + 'px');
    }
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

  // 서버를 클릭할 때마다 매번 새 탭(새 세션)을 연다 — 같은 서버에 여러 개의 독립된 연결을
  // 동시에 띄우고 싶은 경우(예: 여러 작업을 병행) 대응. 이미 열려 있어도 포커스만 이동하지 않는다.
  function selectServer(serverId){
    var row = tree.querySelector('.server[data-id="'+serverId+'"]');
    var proto = row.dataset.protocol;
    var tabId = serverId + '::' + (++tabSeq);
    ensureTab(tabId, serverId);
    ensurePane(tabId, serverId);
    if(currentFilter !== 'all' && currentFilter !== proto){
      applyFilter(proto);
    }
    activate(tabId);
  }

  // 서버를 완전히 삭제할 때는 그 서버로 열려 있는 탭/세션을 전부 닫는다(여러 개 열려 있을 수 있음).
  function removeServerById(serverId){
    if(hasMemoBridge) window.onegyeok.saveMemo(serverId, '');
    var tabIdsToRemove = Array.prototype.map.call(tabbar.querySelectorAll('.tab[data-server-id="'+serverId+'"]'), function(t){ return t.dataset.id; });
    // closeTabById가 분할된 탭이면 그 안의 pane 세션까지 전부 정리한다(tabLayouts 기준).
    tabIdsToRemove.forEach(function(tabId){ closeTabById(tabId); });
    SERVERS = SERVERS.filter(function(s){ return s.id !== serverId; });
    selectedManageIds.delete(serverId);
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
    var fGroup = document.getElementById('f-group');
    var prevValue = fGroup.value;
    fGroup.innerHTML = opts + '<option value="__new__">+ 새 그룹 추가...</option>';
    if(GROUP_ORDER.indexOf(prevValue) > -1) fGroup.value = prevValue;
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

  var SQL_DEFAULT_PORTS = { mysql: 3306, postgres: 5432, mssql: 1433 };

  function updatePortPlaceholder(){
    var proto = document.getElementById('f-protocol').value;
    var portEl = document.getElementById('f-port');
    if(proto === 'sql'){
      portEl.placeholder = String(SQL_DEFAULT_PORTS[document.getElementById('f-sql-engine').value] || 3306);
    } else {
      portEl.placeholder = proto === 'ssh' ? '22' : (proto === 'sftp' ? '22' : (proto === 'rdp' ? '3389' : (proto === 'vnc' ? '5900' : '')));
    }
  }

  function toggleSshOnlyFields(){
    var proto = document.getElementById('f-protocol').value;
    var isSsh = proto === 'ssh';
    var isSql = proto === 'sql';
    document.getElementById('row-f-jump').style.display = isSsh ? '' : 'none';
    document.getElementById('row-f-auth-method').style.display = isSsh ? '' : 'none';
    document.getElementById('row-f-sql-engine').style.display = isSql ? '' : 'none';
    document.getElementById('row-f-database').style.display = isSql ? '' : 'none';
    document.getElementById('row-f-username').style.display = (proto === 'web') ? 'none' : '';
    toggleKeyPathField();
    updatePortPlaceholder();
  }
  document.getElementById('f-protocol').addEventListener('change', toggleSshOnlyFields);
  document.getElementById('f-sql-engine').addEventListener('change', updatePortPlaceholder);

  function toggleKeyPathField(){
    var proto = document.getElementById('f-protocol').value;
    var isKey = proto === 'ssh' && document.getElementById('f-auth-method').value === 'publickey';
    document.getElementById('row-f-keypath').style.display = isKey ? '' : 'none';
  }
  document.getElementById('f-auth-method').addEventListener('change', toggleKeyPathField);

  document.getElementById('pickKeyFileBtn').addEventListener('click', function(){
    if(!window.onegyeok || !window.onegyeok.pickKeyFile) return;
    window.onegyeok.pickKeyFile().then(function(res){
      if(res && !res.canceled && res.filePath) document.getElementById('f-key-path').value = res.filePath;
    });
  });

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
    document.getElementById('f-auth-method').value = s ? s.authMethod : 'password';
    document.getElementById('f-key-path').value = s && s.keyFilePath ? s.keyFilePath : '';
    document.getElementById('f-sql-engine').value = s && s.sqlEngine ? s.sqlEngine : 'mysql';
    document.getElementById('f-database').value = s && s.database ? s.database : '';
    populateJumpSelect(id);
    document.getElementById('f-jump').value = s && s.jump ? s.jump : '';
    document.getElementById('editError').textContent = '';
    document.getElementById('editDeleteBtn').style.display = s ? '' : 'none';
    toggleSshOnlyFields();
    toggleKeyPathField();
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
    var authMethod = (protocol === 'ssh' && document.getElementById('f-auth-method').value === 'publickey') ? 'publickey' : 'password';
    var keyFilePath = authMethod === 'publickey' ? document.getElementById('f-key-path').value.trim() || null : null;
    var jump = protocol === 'ssh' ? (document.getElementById('f-jump').value || null) : null;
    var sqlEngine = protocol === 'sql' ? document.getElementById('f-sql-engine').value : null;
    var database = protocol === 'sql' ? document.getElementById('f-database').value.trim() : '';
    var errEl = document.getElementById('editError');

    if(!name || !host){ errEl.textContent = '이름과 호스트는 필수입니다.'; return; }
    // 사용자명은 선택 — 비워두면 접속할 때마다 터미널(또는 접속 폼)에서 직접 물어본다(다른 사용자로 로그인하는 경우 대비).
    var dup = SERVERS.find(function(s){ return s.id === name && s.id !== editingId; });
    if(dup){ errEl.textContent = '이미 사용 중인 이름입니다.'; return; }
    if(authMethod === 'publickey' && !keyFilePath){ errEl.textContent = 'SSH Key 파일 경로를 지정해주세요.'; return; }

    if(GROUP_ORDER.indexOf(group) === -1) GROUP_ORDER.push(group);

    if(editingId){
      var s = SERVERS.find(function(x){ return x.id === editingId; });
      var oldId = s.id;
      s.name = name; s.id = name; s.group = group; s.protocol = protocol; s.host = host; s.port = port;
      s.username = username; s.authMethod = authMethod; s.keyFilePath = keyFilePath; s.auth = authLabel(s);
      s.jump = jump; s.sqlEngine = sqlEngine; s.database = database;
      if(oldId !== name) propagateIdRename(oldId, name);
    } else {
      var newServer = {
        id: name, name: name, group: group, protocol: protocol, host: host, port: port,
        username: username, authMethod: authMethod, keyFilePath: keyFilePath,
        jump: jump, sqlEngine: sqlEngine, database: database, status: 'off', since: '연결 안 됨'
      };
      newServer.auth = authLabel(newServer);
      SERVERS.push(newServer);
    }
    closeEdit();
    renderTree(); renderManageTable(); populateGroupSelectors();
  });

  document.querySelectorAll('.rail-btn[data-filter]').forEach(function(btn){
    btn.addEventListener('click', function(){ applyFilter(btn.dataset.filter); });
  });

  tabbar.addEventListener('click', function(e){
    if(e.target.closest('.tab-add')){ openPalette(); return; }
    var reconnectBtn = e.target.closest('.tab-reconnect');
    if(reconnectBtn){
      e.stopPropagation();
      var rid = reconnectBtn.closest('.tab').dataset.id;
      var rs = sshSessions[rid];
      if(rs && rs.state !== 'connected' && rs.state !== 'connecting' && rs.state !== 'prompting'){
        rs.term.writeln('');
        promptAndConnect(rid, rs);
        activate(rid); // 탭으로 바로 전환해 인증 프롬프트가 보이게 한다
        return;
      }
      var rd = dbSessions[rid];
      if(rd && rd.state !== 'connected' && rd.state !== 'connecting'){
        showDbConnectForm(rid);
        activate(rid);
        return;
      }
      var rr = rdpSessions[rid];
      if(rr && rr.state !== 'connected' && rr.state !== 'connecting'){
        showRdpConnectForm(rid);
        activate(rid);
      }
      return;
    }
    var close = e.target.closest('.close');
    var tab = e.target.closest('.tab');
    if(!tab) return;
    if(close){
      // 탭을 닫으면 그 탭의 모든 pane(분할돼 있었다면 전부)의 세션이 종료된다 — closeTabById가
      // tabLayouts를 참고해 분할된 탭이면 paneId 전부를, 아니면 탭 자신만 정리한다.
      closeTabById(tab.dataset.id);
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

  if(hasMemoBridge){
    window.onegyeok.loadMemos().then(function(memos){
      SERVERS.forEach(function(s){
        if(Object.prototype.hasOwnProperty.call(memos, s.id)) s.memo = memos[s.id];
      });
      if(currentInspectedServerId){
        var srv = SERVERS.find(function(s){ return s.id === currentInspectedServerId; });
        memoEl.value = (srv && srv.memo) || '';
      }
    }).catch(function(err){ console.error('[memo] 초기 로드 실패', err); });
  }

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
