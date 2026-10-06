// ==================================================================
// Web 콘솔 — URL 북마크 (docs/기능명세/07_Web_기능명세.md)
// 탭을 열면 내장 <webview>로 URL을 보여주고, 툴바 버튼으로 기본 브라우저로도 열 수 있다.
// 계정 자동입력은 지원하지 않는다(F-1103). 웹뷰 파티션은 "persist:" 없는 메모리 전용이라
// 쿠키/세션이 앱 종료 시 사라진다(F-1104). 부착 검증은 main/protocols/web/index.js 참고.
// ==================================================================
var webSessions = {}; // tabId -> { state, srv, el, view }

// 호스트 입력에서 열 URL을 만든다. 스킴이 있으면 그대로, 없으면 포트가 없거나 443/8443/9443이면 https, 그 외 http.
function buildWebUrl(srv){
  var host = srv.host;
  var url;
  if(/^[a-z][a-z0-9+.-]*:\/\//i.test(host)){
    url = host;
  } else {
    var scheme = (!srv.port || srv.port === 443 || srv.port === 8443 || srv.port === 9443) ? 'https' : 'http';
    var portPart = (srv.port && srv.port !== 80 && srv.port !== 443) ? ':' + srv.port : '';
    url = scheme + '://' + host + portPart;
  }
  try {
    var u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch(e){ return null; }
}

registerProtocol('web', {
  meta: { label:'Web', icon:'<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"></circle><line x1="2.5" y1="10" x2="17.5" y2="10"></line><path d="M10 2.5c2.2 2 2.2 13 0 15M10 2.5c-2.2 2-2.2 13 0 15"></path></svg>' },

  startSession: function(tabId, serverId, el){
    var srv = SERVERS.find(function(s){ return s.id === serverId; });
    el.className = 'pane web-pane proto-web';
    var url = srv && buildWebUrl(srv);
    if(!url){
      el.innerHTML = '<div class="web-error">열 수 없는 URL입니다. 서버 편집에서 호스트를 확인해주세요.</div>';
      return;
    }
    el.innerHTML =
      '<div class="web-toolbar">' +
        '<button type="button" class="web-back" title="뒤로">←</button>' +
        '<button type="button" class="web-reload" title="새로고침">↻</button>' +
        '<span class="web-url"></span>' +
        '<button type="button" class="web-external" title="기본 브라우저로 열기">브라우저로 열기</button>' +
      '</div>';
    var urlEl = el.querySelector('.web-url');
    urlEl.textContent = url;
    var view = document.createElement('webview');
    view.setAttribute('src', url);
    view.setAttribute('partition', 'web-' + tabId); // persist: 없음 → 메모리 전용(F-1104)
    el.appendChild(view);
    var errBox = document.createElement('div');
    errBox.className = 'web-load-error';
    errBox.hidden = true;
    el.appendChild(errBox);
    var s = webSessions[tabId] = { state:'connected', srv:srv, el:el, view:view };
    updateServerRowStatus(srv.id);

    view.addEventListener('did-start-loading', function(){ errBox.hidden = true; });
    view.addEventListener('did-fail-load', function(e){
      if(!e.isMainFrame || e.errorCode === -3) return; // -3: 사용자가 로드를 중단함(ERR_ABORTED)
      var isCert = e.errorCode <= -200 && e.errorCode > -300; // ERR_CERT_* 계열
      errBox.innerHTML = '';
      var title = document.createElement('div');
      title.className = 'web-load-error-title';
      title.textContent = isCert ? '인증서를 신뢰할 수 없어 연결을 차단했습니다' : '페이지를 불러오지 못했습니다';
      var desc = document.createElement('div');
      desc.className = 'web-load-error-desc';
      desc.textContent = e.validatedURL + ' · ' + e.errorDescription + ' (' + e.errorCode + ')';
      errBox.appendChild(title); errBox.appendChild(desc);
      if(isCert && window.onegyeok && window.onegyeok.web){
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '위험을 감수하고 이 탭에서만 계속';
        btn.addEventListener('click', function(){
          window.onegyeok.web.trustCert(view.getWebContentsId(), e.validatedURL).then(function(){
            errBox.hidden = true;
            view.loadURL(e.validatedURL);
          });
        });
        errBox.appendChild(btn);
      }
      errBox.hidden = false;
    });
    view.addEventListener('did-navigate', function(e){ urlEl.textContent = e.url; });
    view.addEventListener('did-navigate-in-page', function(e){ if(e.isMainFrame) urlEl.textContent = e.url; });
    el.querySelector('.web-back').addEventListener('click', function(){ if(view.canGoBack()) view.goBack(); });
    el.querySelector('.web-reload').addEventListener('click', function(){ view.reload(); });
    el.querySelector('.web-external').addEventListener('click', function(){
      if(window.onegyeok && window.onegyeok.web) window.onegyeok.web.openExternal(urlEl.textContent);
    });
    return s;
  },
  hasSession: function(tabId){ return !!webSessions[tabId]; },
  getSession: function(tabId){ return webSessions[tabId] || null; },
  disposeSession: function(tabId){
    var s = webSessions[tabId];
    if(!s) return;
    delete webSessions[tabId];
    if(s.view && s.view.parentNode) s.view.parentNode.removeChild(s.view);
    if(s.srv) updateServerRowStatus(s.srv.id);
  },
  isServerConnected: function(serverId){
    return Object.keys(webSessions).some(function(k){ return webSessions[k].srv && webSessions[k].srv.id === serverId; });
  },

  hasConnAction: false,

  registration: {
    hideUsername: true,
    defaultPortPlaceholder: function(){ return '443'; },
  },
});
