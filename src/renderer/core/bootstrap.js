// 모든 core/*.js + protocols/*/*.js 로드가 끝난 뒤 마지막으로 실행되는 초기화 시퀀스.
// (registerProtocol 호출이 전부 끝나야 PROTO/getProtocol()이 완전해지므로, 이 파일은
// index.html에서 반드시 마지막 <script>여야 한다.)
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

// 탭을 다른 창으로 분리할 때(Stage B) 새 창은 데모 시드 탭 대신 넘겨받은 탭만 연다 —
// src/main/core/window-manager.js 참고. 평소 부팅(앱의 첫 창)은 getInitialState()가 null을
// 돌려주므로 아래 분기가 그대로 기존 동작(정적 데모 탭 유지)을 한다.
function bootTabs(){
  if(!(window.onegyeok && window.onegyeok.window)){
    renumberTabs();
    recordActive('prod-web-01');
    return;
  }
  window.onegyeok.window.getInitialState().then(function(initialTabs){
    if(!initialTabs){
      renumberTabs();
      recordActive('prod-web-01');
      return;
    }
    // 분리된 창 — 정적 데모 탭/pane을 전부 치우고 넘겨받은 탭만 연다. 사이드바(서버 목록)는
    // 이미 위에서 scrapeServers()/renderTree()로 채워졌으니 그대로 둔다 — 크롬 창처럼 분리된
    // 창에서도 서버 목록을 보고 새 탭을 열 수 있어야 한다.
    tabbar.querySelectorAll('.tab').forEach(function(t){ t.remove(); });
    panes.querySelectorAll('.pane:not(#emptyPane)').forEach(function(p){ p.remove(); });
    initialTabs.forEach(function(tab){
      openHydratedTab(tab.tabId, tab.serverId, tab.protocol, tab.server);
    });
  }).catch(function(err){
    console.error('[window] 초기 상태 조회 실패 — 평소대로 부팅', err);
    renumberTabs();
    recordActive('prod-web-01');
  });
}
bootTabs();

// ---- preload/main process smoke test (scaffold verification) ----
if (window.onegyeok && typeof window.onegyeok.ping === 'function') {
  window.onegyeok.ping().then(function (reply) {
    console.log('[onegyeok] main process round-trip:', reply);
  });
} else {
  console.warn('[onegyeok] preload bridge(window.onegyeok) not found — check preload.js wiring');
}
