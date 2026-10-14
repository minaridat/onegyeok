// ---- keyboard shortcuts (전역) ----
document.addEventListener('keydown', function(e){
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); openPalette(); return; }
  if(e.key === 'Escape'){
    if(appEl.classList.contains('edit-open')){ closeEdit(); return; }
    if(appEl.classList.contains('manage-open')){ closeManage(); return; }
    closePalette(); return;
  }
  if((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b' && !(e.target && e.target.closest && e.target.closest('.xterm'))){ e.preventDefault(); toggleSidebar(); return; }
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i'){ e.preventDefault(); toggleInspector(); return; }
  if((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)){
    e.preventDefault();
    var tabs = visibleTabs();
    var idx = parseInt(e.key, 10) - 1;
    if(tabs[idx]) activate(tabs[idx].dataset.id);
    return;
  }
  // ⌘< / ⌘>: macOS는 ⌘를 누르면 e.key가 '<'/'>'가 아니라 ','/'.'로 오는 경우가 많아 e.key만으로는 안 잡힌다 —
  // 물리 키(e.code: Comma/Period, Shift 동반)도 함께 본다. Alt가 눌린 조합(⌘⌥,)은 제외.
  var metaOrCtrl = (e.metaKey || e.ctrlKey) && !e.altKey;
  var isNextKey = metaOrCtrl && (e.key === '>' || (e.shiftKey && e.code === 'Period'));
  var isPrevKey = metaOrCtrl && (e.key === '<' || (e.shiftKey && e.code === 'Comma'));
  var altNav = (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey; // 그룹탭이 아닐 때만 여기까지 온다(그룹탭의 칸 이동은 splitview.js가 먼저 가로챔)
  var next = (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) || (altNav && e.key === 'ArrowRight') || isNextKey;
  var prev = (e.ctrlKey && e.key === 'Tab' && e.shiftKey) || (altNav && e.key === 'ArrowLeft') || isPrevKey;
  if(next || prev){
    e.preventDefault();
    var list = visibleTabs();
    if(!list.length) return;
    var cur = list.findIndex(function(t){ return t.classList.contains('active'); });
    var to = next ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
    activate(list[to].dataset.id);
  }
});
