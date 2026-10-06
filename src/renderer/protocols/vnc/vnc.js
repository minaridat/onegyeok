// VNC — 아직 미구현(Phase 5 예정). 기존 목업과 동일한 placeholder pane만 보여준다.
registerProtocol('vnc', {
  meta: { label:'VNC', icon:'<svg viewBox="0 0 20 20"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"></path><circle cx="10" cy="10" r="2.3"></circle></svg>' },

  startSession: function(tabId, serverId, el){
    el.className = 'pane placeholder-pane proto-vnc';
    el.innerHTML =
      '<div class="ph-icon">'+this.meta.icon+'</div>' +
      '<div class="ph-title">'+serverId+'</div>' +
      '<div class="ph-desc">VNC 세션이 여기에 표시됩니다.</div>';
  },
  hasSession: function(){ return false; },
  getSession: function(){ return null; },
  disposeSession: function(){},
  isServerConnected: function(){ return false; },

  hasConnAction: false,

  registration: {
    defaultPortPlaceholder: function(){ return '5900'; },
  },
});
