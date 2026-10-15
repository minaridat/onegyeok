// ---- 연결 정보 패널의 "세션 로그" 탭 — 기록 켜기/끄기, 보관 기간, 로그 목록·열람 ----
// 로그 파일은 메인 프로세스(core/session-log.js)가 쓴다. 여기서는 읽기 전용으로 보여줄 뿐 수정·삭제 기능은 두지 않는다(감사 목적).
var hasLogBridge = !!(window.onegyeok && window.onegyeok.sessionLog);
var slogEnabledEl = document.getElementById('slogEnabled');
var slogRetentionEl = document.getElementById('slogRetention');
var slogListEl = document.getElementById('slogList');
var slogDirEl = document.getElementById('slogDir');
var slogViewBackdrop = document.getElementById('slogViewBackdrop');
var slogViewBody = document.getElementById('slogViewBody');
var slogViewSearch = document.getElementById('slogViewSearch');
var slogViewText = '';
var slogViewId = null;

function slogFmtSize(n){ return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
// 파일명 "HHmmss_이름_세션.log" → "HH:mm:ss 이름"
function slogLabel(f){
  var m = /^(\d{2})(\d{2})(\d{2})_(.*)_[^_]*\.log$/.exec(f.name);
  return m ? { time: m[1] + ':' + m[2] + ':' + m[3], name: m[4].replace(/_/g, ' ') } : { time: '', name: f.name };
}

function renderSessionLogList(files){
  if(!files.length){ slogListEl.innerHTML = '<div class="slog-empty">아직 기록된 로그가 없습니다. SSH나 로컬 터미널을 사용하면 자동으로 쌓입니다.</div>'; return; }
  var html = '', lastDate = '';
  files.forEach(function(f){
    if(f.date !== lastDate){ html += '<div class="slog-date">' + escapeHtml(f.date) + '</div>'; lastDate = f.date; }
    var l = slogLabel(f);
    html += '<button type="button" class="slog-item" data-id="' + escapeHtml(f.id) + '">' +
      '<span class="slog-item-time">' + escapeHtml(l.time) + '</span>' +
      '<span class="slog-item-name">' + escapeHtml(l.name) + '</span>' +
      (f.active ? '<span class="slog-live">기록 중</span>' : '') +
      '<span class="slog-item-size">' + slogFmtSize(f.size) + '</span></button>';
  });
  slogListEl.innerHTML = html;
}

function refreshSessionLogs(){
  if(!hasLogBridge) return;
  window.onegyeok.sessionLog.getConfig().then(function(cfg){
    slogEnabledEl.checked = !!cfg.enabled;
    slogRetentionEl.value = String(cfg.retentionDays);
    if(!slogRetentionEl.value){ // 목록에 없는 값이면 그 값을 선택지로 추가
      var o = document.createElement('option'); o.value = String(cfg.retentionDays); o.textContent = cfg.retentionDays + '일'; slogRetentionEl.appendChild(o); slogRetentionEl.value = o.value;
    }
    slogDirEl.textContent = cfg.dir;
  });
  window.onegyeok.sessionLog.list().then(renderSessionLogList);
}

function applySlogFilter(){
  var q = slogViewSearch.value.trim().toLowerCase();
  if(!q){ slogViewBody.textContent = slogViewText; return; }
  var lines = slogViewText.split('\n').filter(function(l){ return l.toLowerCase().indexOf(q) !== -1; });
  slogViewBody.textContent = lines.length ? lines.join('\n') : '(일치하는 줄이 없습니다)';
}

function openSessionLogView(id){
  if(!hasLogBridge) return;
  window.onegyeok.sessionLog.read(id).then(function(res){
    if(!res.ok){ alert('로그를 읽을 수 없습니다: ' + res.error); return; }
    slogViewId = id;
    slogViewText = res.text;
    document.getElementById('slogViewTitle').textContent = id;
    document.getElementById('slogViewNote').textContent = res.truncated ? '파일이 커서 끝부분 2MB만 표시합니다. 전체는 "폴더에서 보기"로 여세요. (' + slogFmtSize(res.size) + ')' : slogFmtSize(res.size);
    slogViewSearch.value = '';
    applySlogFilter();
    slogViewBackdrop.hidden = false;
    slogViewBody.scrollTop = slogViewBody.scrollHeight; // 최근 내용부터 보이게
  });
}
function closeSessionLogView(){ slogViewBackdrop.hidden = true; slogViewId = null; }

if(hasLogBridge){
  slogEnabledEl.addEventListener('change', function(){ window.onegyeok.sessionLog.setConfig({ enabled: slogEnabledEl.checked }); });
  slogRetentionEl.addEventListener('change', function(){ window.onegyeok.sessionLog.setConfig({ retentionDays: parseInt(slogRetentionEl.value, 10) }); });
  document.getElementById('slogRefreshBtn').addEventListener('click', refreshSessionLogs);
  document.getElementById('slogFolderBtn').addEventListener('click', function(){ window.onegyeok.sessionLog.openFolder(); });
  document.getElementById('slogCurrentBtn').addEventListener('click', function(){
    var tabId = typeof currentInspectedId !== 'undefined' ? currentInspectedId : null;
    if(!tabId){ alert('열려 있는 터미널 탭이 없습니다.'); return; }
    window.onegyeok.sessionLog.sessionFile(tabId).then(function(id){
      if(id) openSessionLogView(id); else alert('이 탭은 기록 중인 로그가 없습니다. (SSH·로컬 터미널만 기록되며, 접속 전이거나 기록을 껐다면 없습니다)');
    });
  });
  slogListEl.addEventListener('click', function(e){
    var item = e.target.closest('.slog-item');
    if(item) openSessionLogView(item.dataset.id);
  });
  document.getElementById('slogViewClose').addEventListener('click', closeSessionLogView);
  document.getElementById('slogViewFolder').addEventListener('click', function(){ if(slogViewId) window.onegyeok.sessionLog.openFolder(slogViewId); });
  slogViewBackdrop.addEventListener('click', function(e){ if(e.target === slogViewBackdrop) closeSessionLogView(); });
  slogViewSearch.addEventListener('input', applySlogFilter);
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && !slogViewBackdrop.hidden){ closeSessionLogView(); e.stopPropagation(); } }, true);
  // 탭을 열 때마다 목록을 새로 읽는다.
  document.querySelector('.insp-tab[data-tab="logs"]').addEventListener('click', refreshSessionLogs);
}
