// ---- inspector toggle ----
var inspOpen = true;
function setInspector(open){
  inspOpen = open;
  appEl.classList.toggle('insp-collapsed', !open);
  inspToggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
}
function toggleInspector(){ setInspector(!inspOpen); }
inspToggleBtn.addEventListener('click', toggleInspector);
inspHandle.addEventListener('click', toggleInspector);
inspCollapseBtn.addEventListener('click', toggleInspector);

// ---- 서버 목록(사이드바) 접기/펼치기 — 서버 검색창 옆 ‹ 버튼 또는 ⌘/Ctrl+B ----
var sideOpen = true;
function setSidebar(open){
  sideOpen = open;
  appEl.classList.toggle('side-collapsed', !open);
}
function toggleSidebar(){ setSidebar(!sideOpen); }
sideCollapseBtn.addEventListener('click', toggleSidebar);
sideHandle.addEventListener('click', toggleSidebar);
