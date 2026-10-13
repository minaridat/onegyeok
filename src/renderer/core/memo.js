var currentInspectedId = null; // 인스펙터에 표시 중인 탭(세션 인스턴스) id
var currentInspectedServerId = null; // 위 탭이 속한 서버 id (메모 등 서버 단위 데이터에 사용)
var memoEl = document.getElementById('i-memo');
var memoStatusEl = document.getElementById('i-memo-status');
var memoSaveTimer = null;
var hasMemoBridge = !!(window.onegyeok && window.onegyeok.saveMemo);

function showMemoStatus(text, isError){
  memoStatusEl.textContent = text;
  memoStatusEl.classList.toggle('err', !!isError);
  memoStatusEl.classList.add('show');
  clearTimeout(memoStatusEl._hideTimer);
  memoStatusEl._hideTimer = setTimeout(function(){ memoStatusEl.classList.remove('show'); }, 1500);
}

function persistMemo(serverId, text){
  if(!hasMemoBridge || !serverId) return;
  window.onegyeok.saveMemo(serverId, text).then(function(res){
    if(res && res.ok) showMemoStatus('저장됨');
    else showMemoStatus('저장 불가(암호화 미지원)', true);
  }).catch(function(){ showMemoStatus('저장 실패', true); });
}

function scheduleMemoSave(serverId, text){
  clearTimeout(memoSaveTimer);
  memoSaveTimer = setTimeout(function(){ persistMemo(serverId, text); }, 400);
}

function flushMemoSave(){
  clearTimeout(memoSaveTimer);
  if(!currentInspectedServerId) return;
  var srv = SERVERS.find(function(s){ return s.id === currentInspectedServerId; });
  if(srv) persistMemo(currentInspectedServerId, srv.memo || '');
}

// 탭(세션 인스턴스) id로부터 그 탭이 속한 서버 id를 찾는다. 같은 서버로 여러 탭을 열 수 있으므로
// (탭 id ≠ 서버 id)인 경우가 일반적이다 — 탭 엘리먼트의 data-server-id를 기준으로 판단한다.
function serverIdForTab(tabId){
  var tab = tabbar.querySelector('.tab[data-id="'+tabId+'"]');
  return (tab && tab.dataset.serverId) || tabId;
}
