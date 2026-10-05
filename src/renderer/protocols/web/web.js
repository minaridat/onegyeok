// Web 콘솔 — 아직 미구현(Phase 5 예정). 기존 목업과 동일한 placeholder pane만 보여준다.
registerProtocol('web', {
  meta: { label:'Web', icon:'<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"></circle><line x1="2.5" y1="10" x2="17.5" y2="10"></line><path d="M10 2.5c2.2 2 2.2 13 0 15M10 2.5c-2.2 2-2.2 13 0 15"></path></svg>' },

  startSession: function(tabId, serverId, el){
    el.className = 'pane placeholder-pane proto-web';
    el.innerHTML =
      '<div class="ph-icon">'+this.meta.icon+'</div>' +
      '<div class="ph-title">'+serverId+'</div>' +
      '<div class="ph-desc">Web 세션이 여기에 표시됩니다.</div>';
  },
  hasSession: function(){ return false; },
  getSession: function(){ return null; },
  disposeSession: function(){},
  isServerConnected: function(){ return false; },

  hasConnAction: false,

  registration: {
    hideUsername: true,
    defaultPortPlaceholder: function(){ return ''; },
  },
});
