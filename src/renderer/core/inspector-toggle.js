// ---- inspector toggle ----
var inspOpen = true;
// 세션(탭)마다 서버 목록·연결정보/메모 패널의 접힘 상태를 따로 기억한다 — 탭을 옮기면 그 탭에서 마지막으로 둔 상태로 돌아온다.
var tabPanelState = {};
function rememberPanelState(){
  if(currentInspectedId) tabPanelState[currentInspectedId] = { side: sideOpen, insp: inspOpen };
}
function restorePanelState(tabId){
  var st = tabPanelState[tabId];
  if(!st){ rememberPanelState(); return; } // 처음 여는 탭은 지금 상태를 그대로 물려받는다
  applySidebar(st.side);
  applyInspector(st.insp);
}
function applyInspector(open){
  inspOpen = open;
  appEl.classList.toggle('insp-collapsed', !open);
  inspToggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
}
function setInspector(open){ applyInspector(open); rememberPanelState(); }
function toggleInspector(){ setInspector(!inspOpen); }
inspToggleBtn.addEventListener('click', toggleInspector);
inspOpenBtn.addEventListener('click', toggleInspector);
inspCollapseBtn.addEventListener('click', toggleInspector);

// ---- 서버 목록(사이드바) 접기/펼치기 — 서버 검색창 옆 ‹ 버튼 또는 ⌘/Ctrl+B ----
var sideOpen = true;
function applySidebar(open){
  sideOpen = open;
  appEl.classList.toggle('side-collapsed', !open);
}
function setSidebar(open){ applySidebar(open); rememberPanelState(); }
function toggleSidebar(){ setSidebar(!sideOpen); }
sideCollapseBtn.addEventListener('click', toggleSidebar);
sideOpenBtn.addEventListener('click', toggleSidebar);
