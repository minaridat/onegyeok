// 사이드바의 서버 상태 점은 "그 서버로 열린 탭 중 하나라도 연결돼 있는지"를 보여준다
// (같은 서버로 여러 탭을 동시에 열 수 있으므로 하나의 세션 상태만으로는 부족하다).
// 모든 등록된 프로토콜에게 "이 서버로 연결된 세션이 있는지" 물어보고 OR로 합친다.
function updateServerRowStatus(serverId){
  var row = tree.querySelector('.server[data-id="'+serverId+'"]');
  if(!row) return;
  var anyConnected = allProtocolNames().some(function(name){
    var p = getProtocol(name);
    return !!(p && p.isServerConnected && p.isServerConnected(serverId));
  });
  row.dataset.status = anyConnected ? 'on' : 'off';
  var dot = row.querySelector('.proto-chip .stat');
  if(dot) dot.classList.toggle('on', anyConnected);
}

// 인스펙터의 "연결 종료/재연결" 버튼은 어느 프로토콜이든 같은 방식으로 상태를 읽는다.
function sessionFor(tabId){
  var found = null;
  allProtocolNames().some(function(name){
    var p = getProtocol(name);
    var s = p && p.getSession && p.getSession(tabId);
    if(s){ found = s; return true; }
    return false;
  });
  return found;
}

function disposeSession(tabId){
  allProtocolNames().forEach(function(name){
    var p = getProtocol(name);
    if(p && p.hasSession && p.hasSession(tabId)) p.disposeSession(tabId);
  });
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

// mode: 'start'(기본, 서버를 새로 클릭해서 여는 탭) | 'attach'(다른 창에서 넘어온 탭 — 이미
// 연결돼 있을 수 있으니 attachSession을 쓴다. 프로토콜이 attachSession을 정의하지 않으면
// startSession으로 자동 폴백 — 탭 분리/병합 기능, core/registry.js의 계약 설명 참고).
function ensurePane(tabId, serverId, protocolOverride, mode){
  var pane = panes.querySelector('.pane[data-id="'+tabId+'"]');
  if(pane) return pane;
  var row = tree.querySelector('.server[data-id="'+serverId+'"]');
  var proto = protocolOverride || row.dataset.protocol;
  var el = document.createElement('div');
  el.dataset.id = tabId;
  el.dataset.serverId = serverId;
  var protoDef = getProtocol(proto);
  if(protoDef){
    el.className = 'pane';
    panes.appendChild(el);
    if(mode === 'attach' && protoDef.attachSession) protoDef.attachSession(tabId, serverId, el);
    else protoDef.startSession(tabId, serverId, el);
    return el;
  }
  // 등록되지 않은 프로토콜(이론상 도달하지 않음 — 안전망)
  el.className = 'pane placeholder-pane proto-' + proto;
  el.innerHTML =
    '<div class="ph-icon">'+PROTO[proto].icon+'</div>' +
    '<div class="ph-title">'+serverId+'</div>' +
    '<div class="ph-desc">'+PROTO[proto].label+' 세션이 여기에 표시됩니다.</div>';
  panes.appendChild(el);
  return el;
}

document.getElementById('inspConnActionBtn').addEventListener('click', function(){
  var id = currentInspectedId;
  if(!id) return;
  var tab = tabbar.querySelector('.tab[data-id="'+id+'"]');
  var proto = tab && tab.dataset.protocol;
  var p = proto && getProtocol(proto);
  if(p && p.onConnActionClick) p.onConnActionClick(id);
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

function ensureTab(tabId, serverId, protocolOverride){
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(tab) return tab;
  var row = tree.querySelector('.server[data-id="'+serverId+'"]');
  var proto = protocolOverride || row.dataset.protocol;
  var label = tabLabelFor(serverId);
  tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = tabId;
  tab.dataset.serverId = serverId;
  tab.dataset.protocol = proto;
  var protoDef = getProtocol(proto);
  var reconnectBtn = (protoDef && protoDef.hasConnAction)
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
function selectServer(serverId, protocolOverride){
  var row = tree.querySelector('.server[data-id="'+serverId+'"]');
  var proto = protocolOverride || row.dataset.protocol;
  var tabId = serverId + '::' + (++tabSeq);
  ensureTab(tabId, serverId, protocolOverride);
  ensurePane(tabId, serverId, protocolOverride);
  if(currentFilter !== 'all' && currentFilter !== proto){
    applyFilter(proto);
  }
  activate(tabId);
}

// closeTabById/detachTabLocal이 공유하는 꼬리 부분 — 탭·pane DOM과 레이아웃 테이블 엔트리를
// 지우고 다음 탭으로 포커스를 옮긴다. 세션 자체(디스코넥트든 로컬 정리든)는 호출하는 쪽 책임이다.
function removeTabDom(tabId){
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(!tab) return;
  var wasActive = tab.classList.contains('active');
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

// 탭을 완전히 닫는다 — skipDispose가 true면 세션은 이미 다른 곳으로 옮겨진 상태이므로
// 탭/레이아웃 UI만 정리하고 세션 자체는 건드리지 않는다(moveSessionIntoCell에서 사용).
// tabLayouts(SSH 전용 pane-split 테이블)는 ssh.js가 정의하는 전역이다 — 분할돼 있지 않은
// 탭(대부분의 프로토콜)은 거기에 엔트리가 없으므로 ids는 항상 [tabId] 하나로 떨어진다.
function closeTabById(tabId, skipDispose){
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(!tab) return;
  if(!skipDispose){
    var layout = tabLayouts[tabId];
    var ids = layout ? layout.paneIds.slice() : [tabId];
    ids.forEach(function(id){ disposeSession(id); });
  }
  removeTabDom(tabId);
}

// 탭을 다른 창으로 끌어내 뺄 때(Stage B) 이 창(원래 창)에서 호출된다 — IPC 연결 종료 없이
// 로컬 UI만 정리한다(detachLocal이 없는 프로토콜은 disposeSession으로 자동 폴백 — 연결까지
// 완전히 끊김, core/registry.js의 계약 설명 참고). SSH는 탭이 분할돼 있으면(pane-split) 여러
// 세션을 한 번에 옮기는 복잡도를 감수하지 않고 전부 끊는다 — 분할 해제 후 다시 시도하면 된다.
function detachTabLocal(tabId){
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(!tab) return;
  var proto = tab.dataset.protocol;
  var p = getProtocol(proto);
  var layout = tabLayouts[tabId];
  var isSplit = layout && layout.paneIds.length > 1;
  if(p && p.detachLocal && !isSplit) p.detachLocal(tabId);
  else disposeSession(tabId);
  removeTabDom(tabId);
}

// 각 창은 SERVERS/사이드바 트리를 독립적으로 갖는다(부팅 시 자기 자신의 정적 데모 마크업을
// scrapeServers()로 읽은 결과) — 다른 창에서 동적으로 등록한 서버는 애초에 이 창의 SERVERS
// 배열에 없다. 탭을 분리/병합으로 넘겨받을 때 그 서버 레코드도 같이 넘어오므로(payload.server),
// 여기 없으면(또는 최신화하려면) 끼워 넣고 사이드바도 다시 그린다 — 안 그러면 attachSession이
// SERVERS.find()에서 못 찾아 조용히 아무 것도 안 그린다.
function upsertServerRecord(srv){
  if(!srv) return;
  var idx = SERVERS.findIndex(function(s){ return s.id === srv.id; });
  if(idx === -1) SERVERS.push(srv); else SERVERS[idx] = srv;
  if(GROUP_ORDER.indexOf(srv.group) === -1) GROUP_ORDER.push(srv.group);
  renderTree();
}

// 다른 창에서 넘어온(또는 처음 부팅 시 이어받는) 탭을 이 창에 연다 — selectServer()와 달리
// tabId를 새로 생성하지 않고 넘겨받은 그대로 쓴다(메인 프로세스 세션이 그 id로 등록돼 있음).
function openHydratedTab(tabId, serverId, protocolOverride, serverRecord){
  upsertServerRecord(serverRecord);
  ensureTab(tabId, serverId, protocolOverride);
  ensurePane(tabId, serverId, protocolOverride, 'attach');
  activate(tabId);
}

closeActiveTabBtn.addEventListener('click', function(){
  var activeTab = tabbar.querySelector('.tab.active');
  if(activeTab) closeTabById(activeTab.dataset.id);
});

// 서버를 완전히 삭제할 때는 그 서버로 열려 있는 탭/세션을 전부 닫는다(여러 개 열려 있을 수 있음).
function removeServerById(serverId){
  if(hasMemoBridge) window.onegyeok.saveMemo(serverId, '');
  var tabIdsToRemove = Array.prototype.map.call(tabbar.querySelectorAll('.tab[data-server-id="'+serverId+'"]'), function(t){ return t.dataset.id; });
  // closeTabById가 분할된 탭이면 그 안의 pane 세션까지 전부 정리한다(tabLayouts 기준).
  tabIdsToRemove.forEach(function(tabId){ closeTabById(tabId); });
  SERVERS = SERVERS.filter(function(s){ return s.id !== serverId; });
  selectedManageIds.delete(serverId);
}

document.querySelectorAll('.rail-btn[data-filter]').forEach(function(btn){
  btn.addEventListener('click', function(){ applyFilter(btn.dataset.filter); });
});

tabbar.addEventListener('click', function(e){
  if(e.target.closest('.tab-add')){ openPalette(); return; }
  var reconnectBtn = e.target.closest('.tab-reconnect');
  if(reconnectBtn){
    e.stopPropagation();
    var rtab = reconnectBtn.closest('.tab');
    var p = getProtocol(rtab.dataset.protocol);
    if(p && p.quickReconnect) p.quickReconnect(rtab.dataset.id);
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
  if(suppressNextTabClick){ suppressNextTabClick = false; return; } // 드래그-아웃/병합이 막 끝남 — 활성화 생략
  activate(tab.dataset.id);
});

// ==================================================================
// 탭 드래그-아웃으로 별도 창 분리/병합 (크롬 탭 방식) — src/main/core/window-manager.js와 짝.
// 수평으로만 움직이면(탭바 안에 머무르면) 그냥 클릭/드래그로 취급해 아무 일도 안 한다(현재
// 탭바 안 순서 변경 기능은 없음). 탭바 bounding box 밖으로 수직 이동하면 분리 의도로 본다.
// 다른 onegyeok 창 위에서 손을 떼면 그 창에 병합, 아니면 새 창으로 분리된다.
// ==================================================================
var dragState = null; // { tabId, serverId, protocol, startX, startY, dragging, pollTimer }
var suppressNextTabClick = false;
var TEAROFF_THRESHOLD = 8; // 이 이상 움직여야 드래그로 인정(클릭과 구분)
var MERGE_POLL_MS = 150;

function hasWindowBridge(){ return !!(window.onegyeok && window.onegyeok.window); }

tabbar.addEventListener('mousedown', function(e){
  if(!hasWindowBridge()) return;
  if(e.button !== 0) return; // 좌클릭만
  if(e.target.closest('.close, .tab-reconnect, .tab-add, .tab-broadcast-check')) return;
  var tab = e.target.closest('.tab');
  if(!tab) return;
  dragState = {
    tabId: tab.dataset.id, serverId: tab.dataset.serverId, protocol: tab.dataset.protocol,
    startX: e.clientX, startY: e.clientY, dragging: false, pollTimer: null, mergeTargetId: null,
  };
  document.addEventListener('mousemove', onTabDragMove);
  document.addEventListener('mouseup', onTabDragEnd);
});

function onTabDragMove(e){
  if(!dragState) return;
  var dx = e.clientX - dragState.startX, dy = e.clientY - dragState.startY;
  if(!dragState.dragging && Math.sqrt(dx*dx + dy*dy) < TEAROFF_THRESHOLD) return;
  dragState.dragging = true;

  var rect = tabbar.getBoundingClientRect();
  var outsideTabbar = e.clientY < rect.top - 10 || e.clientY > rect.bottom + 10;
  var tabEl = tabbar.querySelector('.tab[data-id="'+dragState.tabId+'"]');
  if(tabEl) tabEl.classList.toggle('tearing-off', outsideTabbar);

  if(outsideTabbar && !dragState.pollTimer){
    dragState.pollTimer = setInterval(function(){
      if(!dragState) return;
      var sx = window.screenX + e.clientX, sy = window.screenY + e.clientY;
      window.onegyeok.window.isPointInAnotherWindow(sx, sy).then(function(winId){
        if(dragState) dragState.mergeTargetId = winId;
      });
    }, MERGE_POLL_MS);
  } else if(!outsideTabbar && dragState.pollTimer){
    clearInterval(dragState.pollTimer);
    dragState.pollTimer = null;
    dragState.mergeTargetId = null;
  }
}

function onTabDragEnd(e){
  document.removeEventListener('mousemove', onTabDragMove);
  document.removeEventListener('mouseup', onTabDragEnd);
  if(!dragState) return;
  var ds = dragState;
  dragState = null;
  if(ds.pollTimer) clearInterval(ds.pollTimer);
  var tabEl = tabbar.querySelector('.tab[data-id="'+ds.tabId+'"]');
  if(tabEl) tabEl.classList.remove('tearing-off');
  if(!ds.dragging) return; // 그냥 클릭 — 평소대로 activate되게 둔다

  var rect = tabbar.getBoundingClientRect();
  var outsideTabbar = e.clientY < rect.top - 10 || e.clientY > rect.bottom + 10;
  if(!outsideTabbar) return; // 탭바 안으로 돌아왔으면 드래그 취소 취급(순서 변경 기능 없음)

  suppressNextTabClick = true;
  var srv = SERVERS.find(function(s){ return s.id === ds.serverId; });
  var payload = { tabId: ds.tabId, serverId: ds.serverId, protocol: ds.protocol, server: srv };
  if(ds.mergeTargetId != null){
    window.onegyeok.window.mergeTab(Object.assign({ targetWindowId: ds.mergeTargetId }, payload));
  } else {
    window.onegyeok.window.detachTab(payload);
  }
}

if(hasWindowBridge()){
  window.onegyeok.window.onTabDetached(function(tabId){
    detachTabLocal(tabId);
  });
  window.onegyeok.window.onTabAttached(function(payload){
    openHydratedTab(payload.tabId, payload.serverId, payload.protocol, payload.server);
  });
}
