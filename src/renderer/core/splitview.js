// ==================================================================
// 스플릿뷰 — 탭을 끌어 다른 탭 화면 위에 놓아 좌우/상하로 합치는 기능 (docs/기능명세/08_스플릿뷰_기능명세.md)
//
// 설계 요점
//  - 세션/pane DOM은 옮기지 않는다(<webview>는 부모가 바뀌면 다시 로드되므로). 합쳐진 탭의 pane은 그대로 #panes의 자식으로 두고
//    CSS 절대 위치(left/top/width/height)만 칸 크기로 바꾼다. 칸 헤더·경계선은 같은 위치의 overlay(.group-overlay)에 따로 그린다.
//  - 합쳐진 탭들의 .tab 요소는 탭바에서 숨기고(.in-group, 조회용으로 DOM에 남김) 탭바에는 그룹탭(.group-tab) 하나만 보인다.
//  - 분할 구성은 저장하지 않는다(런타임 상태). 복원은 칸을 탭바로 끌어내는 것(splitExtract) 하나뿐이다.
// ==================================================================
var SPLIT_MAX_CELLS = 6;
var SPLIT_MIN_W = 280;
var SPLIT_MIN_H = 180;
var SPLIT_HEADER_H = 26;
var SPLIT_GAP = 5;        // 칸 사이 경계 두께(px)
var SPLIT_EDGE = 0.25;    // 가장자리 25% = 드롭 영역

var groups = {};          // 'group:N' -> group
var groupOfTab = {};      // 멤버 tabId -> groupId
window.__splitDragging = false;

var GROUP_ICON = '<svg class="icon" viewBox="0 0 20 20" style="width:14px;height:14px"><rect x="2.5" y="3.5" width="15" height="13" rx="1.4"></rect><line x1="10" y1="3.5" x2="10" y2="16.5"></line><line x1="10" y1="10" x2="17.5" y2="10"></line></svg>';
var CLOSE_ICON = '<svg class="icon" viewBox="0 0 20 20" style="width:10px;height:10px"><line x1="5" y1="5" x2="15" y2="15"></line><line x1="15" y1="5" x2="5" y2="15"></line></svg>';
var RECONNECT_ICON = '<svg class="icon" viewBox="0 0 20 20" style="width:11px;height:11px"><polyline points="3 9 3 4 8 4"></polyline><path d="M3.5 13a6.5 6.5 0 1 0 1.6-6.8L3 9"></path></svg>';

// ---------------------------------------------------------------- 트리 도우미
function splitLeaves(node, out){
  out = out || [];
  if(node.type === 'cell') out.push(node.tabId);
  else node.children.forEach(function(c){ splitLeaves(c, out); });
  return out;
}

function splitFindParent(root, tabId){
  var found = null;
  (function walk(node, parent, index){
    if(found) return;
    if(node.type === 'cell'){ if(node.tabId === tabId) found = { node: node, parent: parent, index: index }; return; }
    node.children.forEach(function(c, i){ walk(c, node, i); });
  })(root, null, -1);
  return found;
}

function splitNormalizeSizes(node){
  var sum = node.sizes.reduce(function(a, b){ return a + b; }, 0) || 1;
  node.sizes = node.sizes.map(function(s){ return s / sum; });
}

// 한 칸을 트리에서 빼고, 남은 자식이 1개인 분할은 그 자식으로 접는다. 같은 방향 분할이 중첩되면 펼친다.
function splitRemoveLeaf(g, tabId){
  var f = splitFindParent(g.root, tabId);
  if(!f) return;
  if(!f.parent){ g.root = null; return; }
  var p = f.parent;
  p.children.splice(f.index, 1);
  p.sizes.splice(f.index, 1);
  splitNormalizeSizes(p);
  if(p.children.length === 1){
    var only = p.children[0];
    var gp = splitFindParentOfNode(g.root, p);
    if(!gp.parent) g.root = only; else gp.parent.children[gp.index] = only;
  }
  splitFlatten(g.root);
}

function splitFindParentOfNode(root, target){
  var res = { parent: null, index: -1 };
  (function walk(node){
    if(node.type !== 'split') return;
    node.children.forEach(function(c, i){
      if(c === target) res = { parent: node, index: i };
      walk(c);
    });
  })(root);
  return res;
}

function splitFlatten(node){
  if(!node || node.type !== 'split') return;
  node.children.forEach(splitFlatten);
  for(var i = 0; i < node.children.length; i++){
    var c = node.children[i];
    if(c.type === 'split' && c.dir === node.dir){
      var share = node.sizes[i];
      node.children.splice.apply(node.children, [i, 1].concat(c.children));
      node.sizes.splice.apply(node.sizes, [i, 1].concat(c.sizes.map(function(s){ return s * share; })));
      i += c.children.length - 1;
    }
  }
}

// target 칸을 zone 방향으로 쪼개 새 칸을 넣는다.
function splitInsertLeaf(g, targetTabId, newTabId, zone){
  var dir = (zone === 'left' || zone === 'right') ? 'row' : 'column';
  var before = (zone === 'left' || zone === 'top');
  var f = splitFindParent(g.root, targetTabId);
  var newCell = { type: 'cell', tabId: newTabId };
  if(f.parent && f.parent.dir === dir){
    var p = f.parent, half = p.sizes[f.index] / 2;
    p.sizes[f.index] = half;
    p.children.splice(before ? f.index : f.index + 1, 0, newCell);
    p.sizes.splice(before ? f.index : f.index + 1, 0, half);
    return;
  }
  var node = { type: 'split', dir: dir, children: before ? [newCell, f.node] : [f.node, newCell], sizes: [0.5, 0.5] };
  if(!f.parent) g.root = node; else f.parent.children[f.index] = node;
}

// ---------------------------------------------------------------- 레이아웃 계산
function splitMinLen(node, dir){
  if(node.type === 'cell') return dir === 'row' ? SPLIT_MIN_W : SPLIT_MIN_H;
  var lens = node.children.map(function(c){ return splitMinLen(c, dir); });
  if(node.dir === dir) return lens.reduce(function(a, b){ return a + b; }, 0) + SPLIT_GAP * (node.children.length - 1);
  return Math.max.apply(null, lens);
}

function splitComputeRects(node, x, y, w, h, rects, dividers){
  if(node.type === 'cell'){ rects[node.tabId] = { x: x, y: y, w: w, h: h }; return; }
  var n = node.children.length;
  var total = (node.dir === 'row' ? w : h) - SPLIT_GAP * (n - 1);
  var offset = 0;
  node.children.forEach(function(c, i){
    var len = total * node.sizes[i];
    var cx = node.dir === 'row' ? x + offset + SPLIT_GAP * i : x;
    var cy = node.dir === 'row' ? y : y + offset + SPLIT_GAP * i;
    var cw = node.dir === 'row' ? len : w;
    var ch = node.dir === 'row' ? h : len;
    splitComputeRects(c, cx, cy, cw, ch, rects, dividers);
    if(i < n - 1){
      dividers.push({
        node: node, index: i, total: total,
        x: node.dir === 'row' ? cx + cw : x, y: node.dir === 'row' ? y : cy + ch,
        w: node.dir === 'row' ? SPLIT_GAP : w, h: node.dir === 'row' ? h : SPLIT_GAP
      });
    }
    offset += len;
  });
}

// ---------------------------------------------------------------- DOM 도우미
function splitTabEl(tabId){ return tabbar.querySelector('.tab[data-id="' + tabId + '"]'); }
function splitPaneEl(tabId){ return panes.querySelector('.pane[data-id="' + tabId + '"]'); }

function groupForId(id){
  if(groups[id]) return groups[id];
  var gid = groupOfTab[id];
  return gid ? groups[gid] : null;
}

function activeGroup(){
  var t = tabbar.querySelector('.tab.group-tab.active');
  return t ? groups[t.dataset.id] : null;
}

function splitMemberLabel(tabId){
  var t = splitTabEl(tabId);
  var n = t && t.querySelector('.tab-name');
  return (n && n.textContent) || tabId;
}

function splitNextGroupNumber(){
  var used = {};
  Object.keys(groups).forEach(function(k){ used[groups[k].num] = true; });
  var n = 1;
  while(used[n]) n++;
  return n;
}

// ---------------------------------------------------------------- 그룹탭(탭바) / overlay / 칸 헤더
function splitBuildGroupTab(g){
  var el = document.createElement('div');
  el.className = 'tab group-tab';
  el.dataset.id = g.id;
  el.dataset.protocol = 'group';
  el.innerHTML = '<span class="group-chip">' + GROUP_ICON + '</span>' +
    '<span class="tab-name"></span><span class="group-count"></span><span class="tab-num"></span>' +
    '<svg class="icon close" viewBox="0 0 20 20"><line x1="5" y1="5" x2="15" y2="15"></line><line x1="15" y1="5" x2="5" y2="15"></line></svg>';
  g.tabEl = el;
  return el;
}

function splitRefreshGroupTab(g){
  var leaves = splitLeaves(g.root);
  g.tabEl.querySelector('.tab-name').textContent = g.name;
  g.tabEl.querySelector('.group-count').textContent = leaves.length;
  g.tabEl.title = leaves.map(splitMemberLabel).join('\n');
  var anyBroadcast = typeof broadcastSet !== 'undefined' && leaves.some(function(id){ return broadcastSet.has(id); });
  g.tabEl.classList.toggle('broadcast-active', anyBroadcast);
}

function splitBuildHeader(g, tabId){
  var tabEl = splitTabEl(tabId);
  var proto = tabEl ? tabEl.dataset.protocol : '';
  var def = getProtocol(proto);
  var h = document.createElement('div');
  h.className = 'cell-header';
  h.dataset.tabId = tabId;
  h.innerHTML =
    (proto === 'ssh' ? '<input type="checkbox" class="cell-bc" title="동시 입력 그룹에 포함">' : '') +
    '<span class="proto-chip sm proto-' + proto + '">' + (PROTO[proto] ? PROTO[proto].icon : '') + '<span class="stat"></span></span>' +
    '<span class="cell-name"></span>' +
    (def && def.quickReconnect ? '<button type="button" class="cell-reconnect" title="재연결">' + RECONNECT_ICON + '</button>' : '') +
    '<button type="button" class="cell-close" title="이 칸 닫기">' + CLOSE_ICON + '</button>';
  var bc = h.querySelector('.cell-bc');
  if(bc){
    bc.addEventListener('mousedown', function(e){ e.stopPropagation(); });
    bc.addEventListener('click', function(e){ e.stopPropagation(); });
    bc.addEventListener('change', function(){
      var te = splitTabEl(tabId);
      if(te){ setTabBroadcastChecked(te, bc.checked); updateBroadcastCount(); }
    });
  }
  var rc = h.querySelector('.cell-reconnect');
  if(rc){
    rc.addEventListener('mousedown', function(e){ e.stopPropagation(); });
    rc.addEventListener('click', function(e){ e.stopPropagation(); if(def && def.quickReconnect) def.quickReconnect(tabId); });
  }
  var cl = h.querySelector('.cell-close');
  cl.addEventListener('mousedown', function(e){ e.stopPropagation(); });
  cl.addEventListener('click', function(e){ e.stopPropagation(); closeTabById(tabId); });
  g.headers[tabId] = h;
  g.overlayEl.appendChild(h);
  // 멤버 탭 요소의 이름/상태 점이 바뀌면 헤더에 그대로 반영한다(각 프로토콜이 탭 요소를 갱신하는 기존 방식 유지).
  if(tabEl && window.MutationObserver){
    var mo = new MutationObserver(function(){ splitSyncHeader(g, tabId); });
    mo.observe(tabEl, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true, characterData: true });
    g.observers[tabId] = mo;
  }
  splitSyncHeader(g, tabId);
  splitSyncBroadcast(tabId);
  return h;
}

function splitSyncHeader(g, tabId){
  var h = g.headers[tabId], te = splitTabEl(tabId);
  if(!h || !te) return;
  var name = splitMemberLabel(tabId);
  var nameEl = h.querySelector('.cell-name');
  if(nameEl.textContent !== name) nameEl.textContent = name;
  var on = !!te.querySelector('.proto-chip .stat.on');
  h.querySelector('.proto-chip .stat').classList.toggle('on', on);
  splitRefreshGroupTab(g);
}

// ssh.js의 broadcast 로직이 호출한다 — 칸 헤더의 체크박스/빨간 테두리를 탭 요소의 상태와 맞춘다.
function syncCellBroadcast(tabId){ splitSyncBroadcast(tabId); }
function splitSyncBroadcast(tabId){
  var g = groupOfTab[tabId] && groups[groupOfTab[tabId]];
  if(!g) return;
  var h = g.headers[tabId];
  if(!h) return;
  var bc = h.querySelector('.cell-bc');
  var checked = typeof broadcastSet !== 'undefined' && broadcastSet.has(tabId);
  if(bc){
    bc.classList.toggle('show', !!broadcastMode);
    bc.checked = checked;
    var hasSession = typeof sshSessions !== 'undefined' && !!sshSessions[tabId];
    bc.disabled = !hasSession;
  }
  h.classList.toggle('broadcast-active', checked);
  var pane = splitPaneEl(tabId);
  if(pane) pane.classList.toggle('broadcast-pane', checked);
  splitRefreshGroupTab(g);
}

function splitBuildOverlay(g){
  var o = document.createElement('div');
  o.className = 'group-overlay';
  o.dataset.groupId = g.id;
  panes.appendChild(o);
  g.overlayEl = o;
  g.headers = {};
  g.observers = {};
  g.dividerEls = [];
  return o;
}

// ---------------------------------------------------------------- 레이아웃 적용
function layoutGroup(g){
  if(!g || !g.root) return;
  var pw = panes.clientWidth, ph = panes.clientHeight;
  if(pw <= 0 || ph <= 0) return;
  var rects = {}, dividers = [];
  splitComputeRects(g.root, 0, 0, pw, ph, rects, dividers);
  g.rects = rects;
  splitLeaves(g.root).forEach(function(id){
    var r = rects[id];
    var pane = splitPaneEl(id);
    if(pane){
      pane.classList.add('in-group');
      pane.style.inset = 'auto';
      pane.style.left = Math.round(r.x) + 'px';
      pane.style.top = Math.round(r.y + SPLIT_HEADER_H) + 'px';
      pane.style.width = Math.round(r.w) + 'px';
      pane.style.height = Math.max(0, Math.round(r.h - SPLIT_HEADER_H)) + 'px';
    }
    var h = g.headers[id];
    if(h){
      h.style.left = Math.round(r.x) + 'px';
      h.style.top = Math.round(r.y) + 'px';
      h.style.width = Math.round(r.w) + 'px';
      h.style.height = SPLIT_HEADER_H + 'px';
    }
  });
  // 경계선(드래그로 크기 조절)
  if(g.dividerEls.length !== dividers.length){
    g.dividerEls.forEach(function(d){ d.el.remove(); });
    g.dividerEls = dividers.map(function(){
      var el = document.createElement('div');
      el.className = 'group-divider';
      g.overlayEl.appendChild(el);
      var d = { el: el };
      el.addEventListener('mousedown', function(e){ splitStartResize(g, d, e); });
      return d;
    });
  }
  dividers.forEach(function(dv, i){
    var d = g.dividerEls[i];
    d.node = dv.node; d.index = dv.index; d.total = dv.total;
    d.el.className = 'group-divider ' + dv.node.dir;
    d.el.style.left = Math.round(dv.x) + 'px';
    d.el.style.top = Math.round(dv.y) + 'px';
    d.el.style.width = Math.round(dv.w) + 'px';
    d.el.style.height = Math.round(dv.h) + 'px';
  });
  splitUpdateFocusVisual(g);
}

function splitResetPane(tabId){
  var pane = splitPaneEl(tabId);
  if(!pane) return;
  pane.classList.remove('in-group', 'focused-cell', 'broadcast-pane');
  pane.style.inset = pane.style.left = pane.style.top = pane.style.width = pane.style.height = '';
}

function splitUpdateFocusVisual(g){
  splitLeaves(g.root).forEach(function(id){
    var focused = id === g.focusedTabId;
    if(g.headers[id]) g.headers[id].classList.toggle('focused', focused);
    var pane = splitPaneEl(id);
    if(pane) pane.classList.toggle('focused-cell', focused);
  });
}

function splitRelayoutActive(){
  var g = activeGroup();
  if(g) layoutGroup(g);
}
if(window.ResizeObserver) new ResizeObserver(splitRelayoutActive).observe(panes);

// ---------------------------------------------------------------- 활성화
function splitHideOverlays(except){
  Object.keys(groups).forEach(function(k){ groups[k].overlayEl.style.display = groups[k] === except ? '' : 'none'; });
}

function splitFocusSession(tabId){
  if(typeof sshSessions !== 'undefined' && sshSessions[tabId] && sshSessions[tabId].term){ try { sshSessions[tabId].term.focus(); } catch(e){} }
}

// activate()가 그룹 id나 그룹 멤버 id를 받았을 때 처리한다. 처리했으면 true.
function splitActivate(id){
  var g = groupForId(id);
  if(!g) return false;
  var focus = (id === g.id) ? (g.focusedTabId && g.headers[g.focusedTabId] ? g.focusedTabId : splitLeaves(g.root)[0]) : id;
  g.focusedTabId = focus;
  emptyPane.classList.remove('active');
  if(typeof quickConnectEl !== 'undefined' && quickConnectEl) quickConnectEl.hidden = true;
  tabbar.querySelectorAll('.tab').forEach(function(t){ t.classList.toggle('active', t === g.tabEl); });
  var members = splitLeaves(g.root);
  panes.querySelectorAll('.pane').forEach(function(p){ p.classList.toggle('active', members.indexOf(p.dataset.id) > -1); });
  splitHideOverlays(g);
  layoutGroup(g);
  tree.querySelectorAll('.server').forEach(function(s){ s.classList.remove('selected'); });
  inspectorFor(focus);
  recordActive(g.id);
  if(typeof updateQcAddrBar === 'function') updateQcAddrBar(focus);
  g.tabEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  splitFocusSession(focus);
  return true;
}

function splitFocusCell(tabId){
  var g = groupForId(tabId);
  if(!g || g.focusedTabId === tabId) return;
  g.focusedTabId = tabId;
  splitUpdateFocusVisual(g);
  inspectorFor(tabId);
  recordActive(g.id);
  if(typeof updateQcAddrBar === 'function') updateQcAddrBar(tabId);
}

panes.addEventListener('mousedown', function(e){
  var pane = e.target.closest('.pane.in-group');
  var header = e.target.closest('.cell-header');
  var id = header ? header.dataset.tabId : (pane ? pane.dataset.id : null);
  if(id) splitFocusCell(id);
}, true);
panes.addEventListener('focus', function(e){
  var pane = e.target.closest && e.target.closest('.pane.in-group');
  if(pane) splitFocusCell(pane.dataset.id);
}, true);

// ---------------------------------------------------------------- 합치기 / 빼내기 / 해제
function splitMerge(sourceId, targetId, zone){
  var srcTab = splitTabEl(sourceId), tgtTab = splitTabEl(targetId);
  if(!srcTab || !tgtTab || groupOfTab[sourceId]) return false;
  var g = groupOfTab[targetId] ? groups[groupOfTab[targetId]] : null;
  if(!g){
    var num = splitNextGroupNumber();
    g = { id: 'group:' + num, num: num, name: '그룹탭' + num, root: { type: 'cell', tabId: targetId }, focusedTabId: targetId, rects: {} };
    groups[g.id] = g;
    splitBuildOverlay(g);
    var gt = splitBuildGroupTab(g);
    tabbar.insertBefore(gt, tgtTab);
    groupOfTab[targetId] = g.id;
    tgtTab.classList.add('in-group');
    splitBuildHeader(g, targetId);
  }
  splitInsertLeaf(g, targetId, sourceId, zone);
  groupOfTab[sourceId] = g.id;
  srcTab.classList.add('in-group');
  splitBuildHeader(g, sourceId);
  g.focusedTabId = sourceId;
  splitRefreshGroupTab(g);
  renumberTabs();
  splitActivate(g.id);
  return true;
}

// 그룹에서 멤버 하나를 뺀다(탭은 다시 탭바에 보이게). 1칸만 남으면 그룹을 해제한다.
function splitRemoveMember(tabId){
  var g = groupForId(tabId);
  if(!g || g.id === tabId) return;
  var wasActive = g.tabEl.classList.contains('active');
  var leaves = splitLeaves(g.root);
  var idx = leaves.indexOf(tabId);
  splitRemoveLeaf(g, tabId);
  delete groupOfTab[tabId];
  if(g.headers[tabId]){ g.headers[tabId].remove(); delete g.headers[tabId]; }
  if(g.observers[tabId]){ g.observers[tabId].disconnect(); delete g.observers[tabId]; }
  splitResetPane(tabId);
  var te = splitTabEl(tabId);
  if(te){ te.classList.remove('in-group'); tabbar.insertBefore(te, g.tabEl.nextSibling); }
  var rest = g.root ? splitLeaves(g.root) : [];
  if(rest.length <= 1){
    var last = rest[0];
    if(last){
      var lt = splitTabEl(last);
      if(lt){ lt.classList.remove('in-group'); tabbar.insertBefore(lt, g.tabEl); }
      delete groupOfTab[last];
      splitResetPane(last);
    }
    Object.keys(g.observers).forEach(function(k){ g.observers[k].disconnect(); });
    g.overlayEl.remove();
    g.tabEl.remove();
    delete groups[g.id];
    renumberTabs();
    if(wasActive && last) activate(last);
    return;
  }
  if(g.focusedTabId === tabId) g.focusedTabId = rest[Math.min(idx, rest.length - 1)];
  splitRefreshGroupTab(g);
  renumberTabs();
  if(wasActive){ layoutGroup(g); splitUpdateFocusVisual(g); inspectorFor(g.focusedTabId); }
}

// 칸 헤더를 탭바로 끌어낸 경우 — 독립 탭으로 빼고 그 탭을 활성화한다.
function splitExtract(tabId){
  var g = groupForId(tabId);
  if(!g) return;
  var wasActive = g.tabEl.classList.contains('active');
  splitRemoveMember(tabId);
  if(wasActive) activate(tabId);
  else renumberTabs();
}

// closeTabById가 그룹 관련 닫기를 먼저 맡긴다. 그룹탭 전체 닫기면 true(전부 처리), 멤버 하나면 그룹에서 빼고 false(이후 일반 닫기 진행).
function splitCloseHook(tabId){
  var g = groups[tabId];
  if(g){
    var leaves = splitLeaves(g.root);
    var connected = leaves.filter(function(id){ var s = sessionFor(id); return s && s.state === 'connected'; }).length;
    if(connected && !window.confirm('그룹 안의 ' + leaves.length + '개 세션이 모두 종료됩니다. 계속할까요?')) return true;
    var wasActive = g.tabEl.classList.contains('active');
    leaves.forEach(function(id){
      disposeSession(id);
      delete groupOfTab[id];
      if(g.observers[id]) g.observers[id].disconnect();
      var te = splitTabEl(id), pe = splitPaneEl(id);
      if(te) te.remove();
      if(pe) pe.remove();
      if(typeof tabLayouts !== 'undefined') delete tabLayouts[id];
    });
    g.overlayEl.remove();
    g.tabEl.remove();
    delete groups[g.id];
    renumberTabs();
    if(wasActive){
      var next = visibleTabs()[0];
      if(next) activate(next.dataset.id); else activateEmpty(currentFilter);
    }
    return true;
  }
  if(groupOfTab[tabId]) splitRemoveMember(tabId);
  return false;
}

// ---------------------------------------------------------------- 경계 드래그(크기 조절)
function splitStartResize(g, d, e){
  e.preventDefault();
  var node = d.node, i = d.index;
  var dir = node.dir;
  var start = dir === 'row' ? e.clientX : e.clientY;
  var s0 = node.sizes.slice();
  var a = node.children[i], b = node.children[i + 1];
  var minA = splitMinLen(a, dir) / d.total, minB = splitMinLen(b, dir) / d.total;
  window.__splitDragging = true;
  document.body.classList.add('split-resizing', dir);
  var raf = 0;
  function move(ev){
    var delta = ((dir === 'row' ? ev.clientX : ev.clientY) - start) / d.total;
    var na = Math.min(s0[i] + s0[i + 1] - minB, Math.max(minA, s0[i] + delta));
    node.sizes[i] = na;
    node.sizes[i + 1] = s0[i] + s0[i + 1] - na;
    if(!raf) raf = requestAnimationFrame(function(){ raf = 0; layoutGroup(g); });
  }
  function up(){
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('split-resizing', 'row', 'column');
    window.__splitDragging = false;
    layoutGroup(g);
    window.dispatchEvent(new Event('splitsettled'));
  }
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

// ---------------------------------------------------------------- 드래그 중 드롭 영역 계산/표시
var splitHintEl = null, splitGhostEl = null;

function splitEnsureHint(){
  if(!splitHintEl){
    splitHintEl = document.createElement('div');
    splitHintEl.className = 'split-drop-hint';
    splitHintEl.style.display = 'none';
    panes.appendChild(splitHintEl);
  }
  return splitHintEl;
}

// 커서 위치의 드롭 대상(칸)과 영역을 계산한다. 합칠 수 없으면 null, 합칠 수 있어도 한도를 넘으면 valid:false.
function splitDropTargetAt(sourceId, clientX, clientY){
  var pr = panes.getBoundingClientRect();
  if(clientX < pr.left || clientX > pr.right || clientY < pr.top || clientY > pr.bottom) return null;
  var g = activeGroup();
  var targetId = null, rect = null;
  if(g){
    if(!g.rects) return null;
    var lx = clientX - pr.left, ly = clientY - pr.top;
    splitLeaves(g.root).forEach(function(id){
      var r = g.rects[id];
      if(r && lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h){ targetId = id; rect = { x: r.x, y: r.y, w: r.w, h: r.h }; }
    });
  } else {
    var at = tabbar.querySelector('.tab.active');
    if(!at || !at.dataset.serverId) return null;
    targetId = at.dataset.id;
    rect = { x: 0, y: 0, w: pr.width, h: pr.height };
  }
  if(!targetId || targetId === sourceId) return null;
  var nx = (clientX - pr.left - rect.x) / rect.w, ny = (clientY - pr.top - rect.y) / rect.h;
  var cand = [['left', nx], ['right', 1 - nx], ['top', ny], ['bottom', 1 - ny]];
  cand.sort(function(a, b){ return a[1] - b[1]; });
  if(cand[0][1] > SPLIT_EDGE) return null; // 가운데는 무동작
  var zone = cand[0][0];
  var count = g ? splitLeaves(g.root).length : 1;
  var halfW = zone === 'left' || zone === 'right' ? (rect.w - SPLIT_GAP) / 2 : rect.w;
  var halfH = zone === 'top' || zone === 'bottom' ? (rect.h - SPLIT_GAP) / 2 : rect.h;
  var valid = count + 1 <= SPLIT_MAX_CELLS && halfW >= SPLIT_MIN_W && halfH >= SPLIT_MIN_H;
  return { targetId: targetId, zone: zone, rect: rect, valid: valid };
}

function splitShowHint(t){
  var el = splitEnsureHint();
  if(!t){ el.style.display = 'none'; return; }
  var r = t.rect, x = r.x, y = r.y, w = r.w, h = r.h;
  if(t.zone === 'left') w = w / 2;
  else if(t.zone === 'right'){ x = x + w / 2; w = w / 2; }
  else if(t.zone === 'top') h = h / 2;
  else { y = y + h / 2; h = h / 2; }
  el.style.display = '';
  el.style.left = Math.round(x) + 'px';
  el.style.top = Math.round(y) + 'px';
  el.style.width = Math.round(w) + 'px';
  el.style.height = Math.round(h) + 'px';
  el.classList.toggle('invalid', !t.valid);
}

function splitDragStart(label){
  document.body.classList.add('split-dragging');
  window.__splitDragging = true;
  splitGhostEl = document.createElement('div');
  splitGhostEl.className = 'split-ghost';
  splitGhostEl.textContent = label;
  document.body.appendChild(splitGhostEl);
}

function splitDragMove(ds, e){
  if(splitGhostEl){ splitGhostEl.style.left = (e.clientX + 12) + 'px'; splitGhostEl.style.top = (e.clientY + 12) + 'px'; }
  ds.dropTarget = null;
  if(ds.kind === 'tab'){
    ds.dropTarget = splitDropTargetAt(ds.tabId, e.clientX, e.clientY);
    splitShowHint(ds.dropTarget);
  } else if(ds.kind === 'cell'){
    var r = tabbar.getBoundingClientRect();
    ds.overTabbar = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
    tabbar.classList.toggle('drop-extract', ds.overTabbar);
  }
}

// 창 밖 분리가 시작됐거나 드래그가 끝났을 때 — 드롭 영역/고스트/드래그 상태 표시를 모두 치운다.
function splitDragVisualsOff(){
  document.body.classList.remove('split-dragging');
  window.__splitDragging = false;
  if(splitGhostEl){ splitGhostEl.remove(); splitGhostEl = null; }
  splitShowHint(null);
  tabbar.classList.remove('drop-extract');
}

function splitDragEnd(ds){
  splitDragVisualsOff();
  if(ds.kind === 'tab' && ds.dropTarget && ds.dropTarget.valid){
    splitMerge(ds.tabId, ds.dropTarget.targetId, ds.dropTarget.zone);
  } else if(ds.kind === 'cell' && ds.overTabbar){
    splitExtract(ds.tabId);
  }
  window.dispatchEvent(new Event('splitsettled'));
}

// ---------------------------------------------------------------- 그룹탭 이름 변경(더블클릭)
function splitStartRename(g){
  var nameEl = g.tabEl.querySelector('.tab-name');
  if(!nameEl || g.tabEl.querySelector('.group-rename')) return;
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'group-rename';
  input.maxLength = 20;
  input.value = g.name;
  nameEl.style.display = 'none';
  nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
  var done = false;
  function finish(commit){
    if(done) return;
    done = true;
    if(commit){
      var v = input.value.trim();
      g.name = v || ('그룹탭' + g.num);
    }
    input.remove();
    nameEl.style.display = '';
    splitRefreshGroupTab(g);
  }
  input.addEventListener('keydown', function(e){
    e.stopPropagation();
    if(e.key === 'Enter'){ e.preventDefault(); finish(true); }
    else if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
  });
  input.addEventListener('mousedown', function(e){ e.stopPropagation(); });
  input.addEventListener('click', function(e){ e.stopPropagation(); });
  input.addEventListener('blur', function(){ finish(true); });
  input.focus();
  input.select();
}

tabbar.addEventListener('dblclick', function(e){
  var tab = e.target.closest('.group-tab');
  if(!tab || e.target.closest('.close')) return;
  var g = groups[tab.dataset.id];
  if(g) splitStartRename(g);
});

// ---------------------------------------------------------------- 칸 사이 키보드 이동
// macOS ⌘⌥+방향키 / Windows Ctrl+Alt+방향키 — 그룹탭이 활성일 때만 칸 이동으로 쓰고, 아니면 기존 동작(⌘⌥←/→ 탭 이동)에 맡긴다.
// capture 단계에서 먼저 받아 터미널(xterm)이나 셸로 키가 새어 들어가지 않게 한다.
document.addEventListener('keydown', function(e){
  if(!e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
  var dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
  if(!dir) return;
  var g = activeGroup();
  if(!g || !g.rects) return;
  e.preventDefault();
  e.stopPropagation();
  var cur = g.rects[g.focusedTabId];
  if(!cur) return;
  var cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;
  var best = null, bestScore = Infinity;
  splitLeaves(g.root).forEach(function(id){
    if(id === g.focusedTabId) return;
    var r = g.rects[id];
    var dx = (r.x + r.w / 2) - cx, dy = (r.y + r.h / 2) - cy;
    var ok = (dir === 'left' && dx < -1) || (dir === 'right' && dx > 1) || (dir === 'up' && dy < -1) || (dir === 'down' && dy > 1);
    if(!ok) return;
    // 이동 방향 거리 + 직각 방향 어긋남(가중)이 가장 작은 칸
    var main = (dir === 'left' || dir === 'right') ? Math.abs(dx) : Math.abs(dy);
    var cross = (dir === 'left' || dir === 'right') ? Math.abs(dy) : Math.abs(dx);
    var score = main + cross * 2;
    if(score < bestScore){ bestScore = score; best = id; }
  });
  if(best){ splitFocusCell(best); splitFocusSession(best); }
}, true);
