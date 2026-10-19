// ---- keyboard shortcuts (전역) ----
// 터미널(xterm)에 포커스가 있을 때 Ctrl 단독 조합은 셸·vim의 제어키(Ctrl+D=EOF, Ctrl+[=ESC, Ctrl+K=줄 끝까지 삭제 등)다.
// document 리스너는 xterm이 키를 이미 원격으로 보낸 뒤에 실행되므로, 여기서 가로채면 두 동작이 겹친다 — 앱 단축키를 건너뛴다.
// ⌘(macOS)는 터미널 제어키가 아니라 그대로 앱 단축키로 쓴다.
function isTerminalCtrlKey(e){
  return e.ctrlKey && !e.metaKey && !!(e.target && e.target.closest && e.target.closest('.xterm'));
}

// xterm은 처리한 키를 preventDefault한다. macOS는 메뉴 가속키가 페이지보다 먼저 받지만, Windows/Linux의 Electron은
// 페이지가 소비하지 않은 키만 메뉴로 넘기므로 터미널에서 Ctrl+Shift+W(탭 닫기, app-menu.js)가 셸의 ^W로 새어 버린다.
// 앱 메뉴가 받아야 하는 조합은 xterm이 처리하지 않게 한다(ssh.js가 attachCustomKeyEventHandler로 붙인다).
//
// 복사/붙여넣기(Windows/Linux): Windows Terminal·WSL 창처럼 Ctrl+C는 선택한 글자가 있으면 복사, 없으면 그대로 ^C(작업 취소)로
// 보내고, Ctrl+V는 붙여넣기다. Ctrl+Shift+C/V도 같은 동작이다. ^V(다음 글자를 그대로 입력)가 필요하면 Ctrl+Shift+V가 아니라
// 셸 설정으로 다른 키에 묶어야 한다 — 일반 사용자는 붙여넣기를 기대한다. macOS는 ⌘C/⌘V가 따로 있어 Ctrl은 건드리지 않는다.
var isMacPlatform = /Mac/i.test(navigator.platform || navigator.userAgent || '');
function terminalKeyPassthrough(e, term){
  if(e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyW') return false;
  if(!isMacPlatform && term && e.ctrlKey && !e.altKey && !e.metaKey){
    if(e.code === 'KeyC' && (e.shiftKey || term.hasSelection())){
      // 선택이 없을 때의 Ctrl+Shift+C는 아무것도 하지 않는다(^C를 보내지 않음).
      if(e.type === 'keydown' && term.hasSelection()){
        var text = term.getSelection();
        if(navigator.clipboard) navigator.clipboard.writeText(text).catch(function(){});
        term.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    // false를 돌려주면 xterm이 ^V를 보내지 않고 브라우저 기본 붙여넣기가 일어나며, xterm이 그 paste 이벤트를 받아 입력으로 보낸다
    // (여러 줄은 bracketed paste로 감싸 준다).
    if(e.code === 'KeyV') return false;
  }
  return true;
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
  if((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b' && !(e.target && e.target.closest && e.target.closest('.xterm'))){ e.preventDefault(); toggleSidebar(); return; }
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i'){ e.preventDefault(); toggleInspector(); return; }
  if((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)){
    e.preventDefault();
    var tabs = visibleTabs();
    var idx = parseInt(e.key, 10) - 1;
    if(tabs[idx]) activate(tabs[idx].dataset.id);
    return;
  }
});

// 이전 / 다음 탭 — macOS·Windows 공통으로 Ctrl+< / Ctrl+>(Shift 유무 무관, 물리 키 , . 기준)을 쓴다. 기존 ⌘< ⌘>, Ctrl+Tab(Shift=이전),
// 일반 탭에서의 ⌘⌥←/→(Win Ctrl+Alt+←/→)도 그대로 받는다. xterm(터미널)이 키를 먼저 삼키지 않도록 capture 단계에서 처리하고,
// 그룹탭 칸 이동(splitview.js)이 이미 처리한 키(defaultPrevented)는 건너뛴다.
document.addEventListener('keydown', function(e){
  if(e.defaultPrevented) return;
  var ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey;
  var metaOnly = e.metaKey && !e.ctrlKey && !e.altKey;
  var altNav = (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey;
  var isNext = (ctrlOnly && (e.code === 'Period' || e.key === '>')) || (metaOnly && (e.key === '>' || (e.shiftKey && e.code === 'Period'))) ||
    (e.ctrlKey && !e.altKey && e.key === 'Tab' && !e.shiftKey) || (altNav && e.key === 'ArrowRight');
  var isPrev = (ctrlOnly && (e.code === 'Comma' || e.key === '<')) || (metaOnly && (e.key === '<' || (e.shiftKey && e.code === 'Comma'))) ||
    (e.ctrlKey && !e.altKey && e.key === 'Tab' && e.shiftKey) || (altNav && e.key === 'ArrowLeft');
  if(!isNext && !isPrev) return;
  e.preventDefault();
  e.stopPropagation();
  var list = visibleTabs();
  if(!list.length) return;
  var cur = list.findIndex(function(t){ return t.classList.contains('active'); });
  var to = isNext ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
  activate(list[to].dataset.id);
}, true);
