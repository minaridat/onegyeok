// ---- keyboard shortcuts (전역) ----
// 터미널(xterm)에 포커스가 있을 때 Ctrl 단독 조합은 셸·vim의 제어키(Ctrl+D=EOF, Ctrl+[=ESC, Ctrl+K=줄 끝까지 삭제 등)다.
// document 리스너는 xterm이 키를 이미 원격으로 보낸 뒤에 실행되므로, 여기서 가로채면 두 동작이 겹친다 — 앱 단축키를 건너뛴다.
// ⌘(macOS)는 터미널 제어키가 아니라 그대로 앱 단축키로 쓴다. ssh.js의 분할/pane 이동 리스너도 이 함수를 쓴다.
function isTerminalCtrlKey(e){
  return e.ctrlKey && !e.metaKey && !!(e.target && e.target.closest && e.target.closest('.xterm'));
}

document.addEventListener('keydown', function(e){
  // Ctrl+Tab(탭 전환)은 터미널 제어키로 쓰이지 않아 예외 — 없으면 Windows에서 터미널을 떠나지 않고 탭을 바꿀 방법이 없다.
  if(isTerminalCtrlKey(e) && e.key !== 'Tab') return;
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); openPalette(); return; }
  if(e.key === 'Escape'){
    if(appEl.classList.contains('edit-open')){ closeEdit(); return; }
    if(appEl.classList.contains('manage-open')){ closeManage(); return; }
    closePalette(); return;
  }
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
  var next = (e.ctrlKey && e.key === 'Tab' && !e.shiftKey) || (e.metaKey && e.altKey && e.key === 'ArrowRight') || isNextKey;
  var prev = (e.ctrlKey && e.key === 'Tab' && e.shiftKey) || (e.metaKey && e.altKey && e.key === 'ArrowLeft') || isPrevKey;
  if(next || prev){
    e.preventDefault();
    var list = visibleTabs();
    if(!list.length) return;
    var cur = list.findIndex(function(t){ return t.classList.contains('active'); });
    var to = next ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
    activate(list[to].dataset.id);
  }
});
