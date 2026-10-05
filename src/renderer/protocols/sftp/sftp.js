// SFTP — 아직 미구현(Phase 2 예정). 기존 목업과 동일한 placeholder pane만 보여준다.
registerProtocol('sftp', {
  meta: { label:'SFTP', icon:'<svg viewBox="0 0 20 20"><path d="M2 6l2-2h4l2 2h8v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6z"></path></svg>' },

  startSession: function(tabId, serverId, el){
    el.className = 'pane placeholder-pane proto-sftp';
    el.innerHTML =
      '<div class="ph-icon">'+this.meta.icon+'</div>' +
      '<div class="ph-title">'+serverId+'</div>' +
      '<div class="ph-desc">SFTP 세션이 여기에 표시됩니다.</div>';
  },
  hasSession: function(){ return false; },
  getSession: function(){ return null; },
  disposeSession: function(){},
  isServerConnected: function(){ return false; },

  hasConnAction: false,

  registration: {
    defaultPortPlaceholder: function(){ return '22'; },
  },
});
