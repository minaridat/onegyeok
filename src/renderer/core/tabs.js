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
function ensurePane(tabId, serverId, protocolOverride, mode, handoff){
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
    if(mode === 'attach' && protoDef.attachSession) protoDef.attachSession(tabId, serverId, el, handoff);
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
  // 스플릿뷰 멤버(.in-group)는 그룹탭 하나로 대신 보이므로 ⌘1~9/탭 이동 대상에서 뺀다.
  return Array.prototype.filter.call(tabbar.querySelectorAll('.tab'), function(t){
    return !t.classList.contains('filtered-out') && !t.classList.contains('in-group');
  });
}

// 필터(레일 버튼)에 맞는 탭인지 — 그룹탭은 포함된 멤버 중 하나라도 맞으면 보인다.
function tabMatchesFilter(t, filter){
  if(filter === 'all') return true;
  if(t.classList.contains('group-tab')){
    var g = groups[t.dataset.id];
    return !!g && splitLeaves(g.root).some(function(id){ var m = splitTabEl(id); return m && m.dataset.protocol === filter; });
  }
  return t.dataset.protocol === filter;
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
  if(tab.classList.contains('group-tab') && groups[id]){
    splitLeaves(groups[id].root).forEach(function(m){ var mt = splitTabEl(m); if(mt) lastActiveByFilter[mt.dataset.protocol] = id; });
    return;
  }
  lastActiveByFilter[tab.dataset.protocol] = id;
}

function activate(id){
  // 스플릿뷰 그룹탭(또는 그 멤버 탭)이면 그룹 전체를 보여주는 쪽에서 처리한다.
  if(typeof splitActivate === 'function' && splitActivate(id)) return;
  if(typeof splitHideOverlays === 'function') splitHideOverlays(null);
  emptyPane.classList.remove('active');
  if(typeof quickConnectEl !== 'undefined' && quickConnectEl) quickConnectEl.hidden = true;
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
  if(typeof updateQcAddrBar === 'function') updateQcAddrBar(id);
}

function activateEmpty(filter){
  if(typeof splitHideOverlays === 'function') splitHideOverlays(null);
  tabbar.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  panes.querySelectorAll('.pane').forEach(function(p){ p.classList.remove('active'); });
  tree.querySelectorAll('.server').forEach(function(s){ s.classList.remove('selected'); });
  emptyMsgEl.textContent = filter === 'all'
    ? '왼쪽에서 서버를 선택하면 여기에 세션이 열립니다.'
    : PROTO[filter].label + ' 서버를 선택하면 여기에 세션이 열립니다. (열린 ' + PROTO[filter].label + ' 세션 없음)';
  emptyPane.classList.add('active');
  if(typeof updateQcAddrBar === 'function') updateQcAddrBar(null);
  if(typeof renderQuickConnect === 'function') renderQuickConnect(filter);
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
    t.classList.toggle('filtered-out', !tabMatchesFilter(t, filter));
  });
  renumberTabs();
  document.querySelectorAll('.rail-btn[data-filter]').forEach(function(b){
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  filterLabelEl.textContent = filter === 'all' ? '전체' : PROTO[filter].label;
  var webAddBtn = document.getElementById('sidebarWebAddBtn');
  if(webAddBtn) webAddBtn.hidden = filter !== 'web';

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
  return tabId;
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
  renumberTabs();
  if(wasActive){
    var remaining = visibleTabs()[0];
    if(remaining) activate(remaining.dataset.id); else activateEmpty(currentFilter);
  }
}

// 탭을 완전히 닫는다 — skipDispose가 true면 세션은 이미 다른 곳으로 옮겨진 상태이므로
// 탭 UI만 정리하고 세션 자체는 건드리지 않는다.
function closeTabById(tabId, skipDispose){
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(!tab) return;
  // 스플릿뷰: 그룹탭이면 포함된 세션 전부를(확인 후) 닫고, 멤버 칸이면 그룹에서 먼저 빼낸 뒤 평소처럼 닫는다.
  if(typeof splitCloseHook === 'function' && splitCloseHook(tabId)) return;
  if(!skipDispose) disposeSession(tabId);
  removeTabDom(tabId);
}

// 탭을 다른 창으로 끌어내 뺄 때(Stage B) 이 창(원래 창)에서 호출된다 — IPC 연결 종료 없이
// 로컬 UI만 정리한다(detachLocal이 없는 프로토콜은 disposeSession으로 자동 폴백 — 연결까지
// 완전히 끊김, core/registry.js의 계약 설명 참고). 스플릿뷰 칸은 먼저 그룹에서 독립 탭으로 빼낸 뒤 이 경로를 탄다.
function detachTabLocal(tabId){
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  if(!tab) return;
  var proto = tab.dataset.protocol;
  var p = getProtocol(proto);
  if(p && p.detachLocal) p.detachLocal(tabId);
  else disposeSession(tabId);
  removeTabDom(tabId);
}

// detachLocal 직전에 호출해 프로토콜별 인계 데이터(예: Web의 현재 URL)를 꺼낸다 — main
// 프로세스는 내용을 몰라도 되고 그대로 옮겨 실어 나르기만 한다(core/registry.js 계약 참고).
function captureHandoff(tabId, proto){
  var p = getProtocol(proto);
  return (p && p.captureHandoff && p.captureHandoff(tabId)) || null;
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
function openHydratedTab(tabId, serverId, protocolOverride, serverRecord, handoff){
  upsertServerRecord(serverRecord);
  ensureTab(tabId, serverId, protocolOverride);
  ensurePane(tabId, serverId, protocolOverride, 'attach', handoff);
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
  tabIdsToRemove.forEach(function(tabId){ closeTabById(tabId); });
  SERVERS = SERVERS.filter(function(s){ return s.id !== serverId; });
  selectedManageIds.delete(serverId);
}

document.querySelectorAll('.rail-btn[data-filter]').forEach(function(btn){
  btn.addEventListener('click', function(){
    // 서버 목록이 접혀 있을 때 맨 위 "전체 보기" 메인 버튼을 누르면 서버 목록이 다시 펼쳐진다.
    if(btn.dataset.filter === 'all' && typeof sideOpen !== 'undefined' && !sideOpen) setSidebar(true);
    applyFilter(btn.dataset.filter);
  });
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
    closeTabById(tab.dataset.id);
    return;
  }
  if(suppressNextTabClick){ suppressNextTabClick = false; return; } // 드래그-아웃/병합이 막 끝남 — 활성화 생략
  activate(tab.dataset.id);
});

// ==================================================================
// 탭 드래그 — (1) 창 안 내용 영역에 놓으면 스플릿뷰로 합치기(core/splitview.js), (2) 창 밖으로 끌어내면 별도 창으로
// 분리/병합(크롬 탭 방식, src/main/core/window-manager.js와 짝). 칸 헤더(.cell-header)를 끌면 (3) 탭바에 놓아 독립 탭으로 빼내거나
// (4) 창 밖으로 끌어 새 창으로 옮긴다. 그룹탭 자체는 1차에서 창 밖 분리를 지원하지 않는다(docs/기능명세/08_스플릿뷰 F-1318).
//
// 별도 창 분리 모션: Electron은 OS 네이티브 창 드래그를 노출하지 않으므로, 커서가 창 밖으로 나가는 순간 바로 진짜
// BrowserWindow를 만들고(mouseup까지 기다리지 않음) 매 mousemove마다 그 창을 setPosition으로 옮긴다. Chromium이 마우스
// 캡처를 유지해 커서가 뷰포트 밖으로 나가도 mousedown을 받은 document에 mousemove/mouseup이 계속 들어오기 때문이다.
// 손을 뗄 때 다른 onegyeok 창(원래 창 포함) 위였으면 그 창에 병합하고 드래그용 창은 닫는다 — 아니면 그 자리에 그대로 둔다.
// ==================================================================
var dragState = null; // { kind:'tab'|'group'|'cell', tabId, serverId, protocol, label, startX, startY, dragging, grabOffsetX/Y,
                       //   lastScreenX/Y, liveWindowId, creatingWindow, pendingComplete, pollTimer, mergeTargetId, dropTarget, overTabbar }
var suppressNextTabClick = false;
var TEAROFF_THRESHOLD = 8; // 이 이상 움직여야 드래그로 인정(클릭과 구분)
var MERGE_POLL_MS = 150;

function hasWindowBridge(){ return !!(window.onegyeok && window.onegyeok.window); }

function startTabDrag(e, el, kind, tabEl){
  var r = el.getBoundingClientRect();
  var nameEl = tabEl.querySelector('.tab-name');
  dragState = {
    kind: kind, tabId: tabEl.dataset.id, serverId: tabEl.dataset.serverId, protocol: tabEl.dataset.protocol,
    label: (nameEl && nameEl.textContent) || tabEl.dataset.id,
    startX: e.clientX, startY: e.clientY, dragging: false,
    // 커서가 요소 안 어디를 쥐었는지 — 드래그 창도 같은 지점이 커서 밑에 오도록 옮긴다.
    grabOffsetX: e.clientX - r.left, grabOffsetY: e.clientY - r.top,
    lastScreenX: window.screenX + e.clientX, lastScreenY: window.screenY + e.clientY,
    liveWindowId: null, creatingWindow: false, pendingComplete: false,
    pollTimer: null, mergeTargetId: null, dropTarget: null, overTabbar: false,
  };
  document.addEventListener('mousemove', onTabDragMove);
  document.addEventListener('mouseup', onTabDragEnd);
}

tabbar.addEventListener('mousedown', function(e){
  if(e.button !== 0) return; // 좌클릭만
  if(e.target.closest('.close, .tab-reconnect, .tab-add, .tab-broadcast-check, .group-rename')) return;
  var tab = e.target.closest('.tab');
  if(!tab) return;
  startTabDrag(e, tab, tab.classList.contains('group-tab') ? 'group' : 'tab', tab);
});

panes.addEventListener('mousedown', function(e){
  if(e.button !== 0) return;
  var header = e.target.closest('.cell-header');
  if(!header || e.target.closest('button, input')) return;
  var tab = tabbar.querySelector('.tab[data-id="'+header.dataset.tabId+'"]');
  if(tab) startTabDrag(e, header, 'cell', tab);
});

// 창 밖으로 나가는 첫 순간 호출 — 실제 창을 만들고(비동기), 응답이 오면 그 시점의 최신
// 커서 위치로 한 번 더 맞춘다. 아주 빠르게 드래그&드롭하면 이 응답이 mouseup 이후에 올 수도
// 있어서(ds.pendingComplete), 그 경우 onTabDragEnd가 이미 정해둔 결과를 바로 반영한다.
function beginLiveTearOff(ds){
  ds.creatingWindow = true;
  var srv = SERVERS.find(function(s){ return s.id === ds.serverId; });
  var payload = {
    tabId: ds.tabId, serverId: ds.serverId, protocol: ds.protocol, server: srv,
    handoff: captureHandoff(ds.tabId, ds.protocol),
    initialX: Math.round(ds.lastScreenX - ds.grabOffsetX), initialY: Math.round(ds.lastScreenY - ds.grabOffsetY),
  };
  window.onegyeok.window.beginTearOffDrag(payload).then(function(res){
    ds.creatingWindow = false;
    if(!res || res.windowId == null) return;
    ds.liveWindowId = res.windowId;
    if(ds.pendingComplete){
      window.onegyeok.window.completeTearOffDrag(ds.liveWindowId, ds.mergeTargetId);
      return;
    }
    if(dragState === ds){ // 아직 드래그 중이면 응답 오는 사이 움직인 만큼 위치를 최신화
      window.onegyeok.window.dragMoveWindow(ds.liveWindowId, ds.lastScreenX - ds.grabOffsetX, ds.lastScreenY - ds.grabOffsetY);
    }
  });
}

function onTabDragMove(e){
  var ds = dragState;
  if(!ds) return;
  var dx = e.clientX - ds.startX, dy = e.clientY - ds.startY;
  if(!ds.dragging && Math.sqrt(dx*dx + dy*dy) < TEAROFF_THRESHOLD) return;
  if(!ds.dragging){
    ds.dragging = true;
    splitDragStart(ds.label); // 고스트 라벨 + 드래그 중 webview가 마우스를 가로채지 않게 하는 body 클래스
  }
  ds.lastScreenX = window.screenX + e.clientX;
  ds.lastScreenY = window.screenY + e.clientY;

  var outsideWindow = e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;

  if(outsideWindow && ds.kind !== 'group' && hasWindowBridge() && !ds.liveWindowId && !ds.creatingWindow){
    if(ds.kind === 'cell'){ splitExtract(ds.tabId); ds.kind = 'tab'; } // 칸은 먼저 독립 탭으로 뺀 뒤 새 창으로 옮긴다
    splitDragVisualsOff();
    beginLiveTearOff(ds);
  }

  if(ds.liveWindowId != null){
    window.onegyeok.window.dragMoveWindow(ds.liveWindowId,
      ds.lastScreenX - ds.grabOffsetX, ds.lastScreenY - ds.grabOffsetY);
    if(!ds.pollTimer){
      // 창이 생긴 뒤로는 계속 켜둔다(창 안쪽으로 돌아와도) — 원래 창 위로 되돌아오면 그
      // 창도 다시 유효한 병합 대상이어야(크롬처럼 제자리로 돌아가면 다시 합쳐짐) 하기 때문.
      ds.pollTimer = setInterval(function(){
        if(!dragState || dragState.liveWindowId == null) return;
        window.onegyeok.window.isPointInAnotherWindow(dragState.lastScreenX, dragState.lastScreenY, dragState.liveWindowId).then(function(winId){
          if(dragState) dragState.mergeTargetId = winId;
        });
      }, MERGE_POLL_MS);
    }
  } else if(!ds.creatingWindow){
    splitDragMove(ds, e); // 창 안 — 스플릿뷰 드롭 영역 표시 / 탭바 빼내기 강조
  }
}

function onTabDragEnd(e){
  document.removeEventListener('mousemove', onTabDragMove);
  document.removeEventListener('mouseup', onTabDragEnd);
  if(!dragState) return;
  var ds = dragState;
  dragState = null;
  if(ds.pollTimer) clearInterval(ds.pollTimer);
  if(!ds.dragging) return; // 그냥 클릭 — 평소대로 activate되게 둔다

  if(ds.liveWindowId != null){
    suppressNextTabClick = true;
    splitDragVisualsOff();
    window.onegyeok.window.completeTearOffDrag(ds.liveWindowId, ds.mergeTargetId);
  } else if(ds.creatingWindow){
    // beginTearOffDrag 응답이 아직 안 왔는데 손을 뗀 경우(아주 짧은 드래그) — 응답 오면
    // beginLiveTearOff가 바로 완료 처리하도록 표시만 해둔다.
    suppressNextTabClick = true;
    splitDragVisualsOff();
    ds.pendingComplete = true;
  } else {
    // 창 안에서 끝남 — 합치기/빼내기 또는 아무 일 없음. 탭 요소가 사라져 click이 안 올 수도 있으니 플래그는 곧바로 풀어준다.
    suppressNextTabClick = true;
    setTimeout(function(){ suppressNextTabClick = false; }, 0);
    splitDragEnd(ds);
  }
}

if(hasWindowBridge()){
  // 앱 메뉴의 "탭 닫기" — 활성 탭(그룹탭이면 그룹 전체, 연결 중이면 확인 후)을 닫는다. 열린 탭이 없으면 아무 일도 하지 않는다.
  window.onegyeok.window.onCloseTabRequest(function(){
    var active = tabbar.querySelector('.tab.active');
    if(active) closeTabById(active.dataset.id);
  });
  window.onegyeok.window.onTabDetached(function(tabId){
    detachTabLocal(tabId);
  });
  window.onegyeok.window.onTabAttached(function(payload){
    openHydratedTab(payload.tabId, payload.serverId, payload.protocol, payload.server, payload.handoff);
  });
}

// 창 제목에 이 창에서 열려 있는 세션 수를 붙인다("onegyeok 6") — 탭을 끌어 여러 창으로 나눠 띄웠을 때 Dock/창 목록/Mission Control에서
// 창을 구분하기 위함. 스플릿뷰로 합쳐진 탭도 세션 단위로 센다(그룹탭 자체는 세지 않음).
function updateWindowTitle(){
  var n = tabbar.querySelectorAll('.tab:not(.group-tab)').length;
  var title = 'onegyeok ' + n;
  if(document.title !== title) document.title = title;
}
if(window.MutationObserver){
  new MutationObserver(updateWindowTitle).observe(tabbar, { childList: true });
}
updateWindowTitle();
