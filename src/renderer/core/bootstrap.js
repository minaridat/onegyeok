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

renumberTabs();
recordActive('prod-web-01');

// ---- preload/main process smoke test (scaffold verification) ----
if (window.onegyeok && typeof window.onegyeok.ping === 'function') {
  window.onegyeok.ping().then(function (reply) {
    console.log('[onegyeok] main process round-trip:', reply);
  });
} else {
  console.warn('[onegyeok] preload bridge(window.onegyeok) not found — check preload.js wiring');
}
