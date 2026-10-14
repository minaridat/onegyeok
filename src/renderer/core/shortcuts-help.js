// 연결 정보 패널의 "단축키" 탭 — macOS / Windows 두 버전을 모두 보여준다(현재 OS 쪽을 먼저, "현재" 표시).
// 키는 공백으로 구분한 토큰이 각각 키 모양(kbd)으로 그려지고, '/'는 "또는"을 뜻하는 구분자다.
// 새 단축키를 추가할 때 이 표와 README "단축키" 절을 같이 고친다.
var SHORTCUT_HELP = [
  { title: '기본', rows: [
    ['서버 검색 / 빠른 연결', '⌘ K', 'Ctrl K'],
    ['서버 목록 접기 / 펼치기', '⌘ B', 'Ctrl B'],
    ['연결 정보 패널 접기 / 펼치기', '⌘ I', 'Ctrl I'],
    ['열린 창·모달 닫기', 'Esc', 'Esc'],
  ]},
  { title: '탭 이동', rows: [
    ['번호로 탭 이동', '⌘ 1–9', 'Ctrl 1–9'],
    ['이전 / 다음 탭', '⌘ < / ⌘ >', 'Ctrl < / Ctrl >'],
    ['이전 / 다음 탭 (대체)', '⌃ Tab / ⌃ ⇧ Tab', 'Ctrl Tab / Ctrl Shift Tab'],
    ['이전 / 다음 탭 (일반 탭에서만)', '⌘ ⌥ ← / ⌘ ⌥ →', 'Ctrl Alt ← / Ctrl Alt →'],
  ]},
  { title: '스플릿뷰 (그룹탭)', rows: [
    ['칸 사이 포커스 이동', '⌘ ⌥ ← ↑ ↓ →', 'Ctrl Alt ← ↑ ↓ →'],
    ['그룹탭 이름 변경', '탭 더블클릭 · Enter 확정 · Esc 취소', '탭 더블클릭 · Enter 확정 · Esc 취소'],
    ['화면 합치기', '탭을 끌어 다른 탭 화면의 가장자리에 놓기', '탭을 끌어 다른 탭 화면의 가장자리에 놓기'],
    ['칸 빼내기', '칸 헤더를 탭바로 끌기', '칸 헤더를 탭바로 끌기'],
    ['칸 크기 조절', '칸 사이 경계선 끌기', '칸 사이 경계선 끌기'],
  ]},
  { title: '프로토콜별', rows: [
    ['SQL 쿼리 실행', '⌘ Enter', 'Ctrl Enter'],
    ['Web 주소 이동 / 되돌리기', 'Enter / Esc', 'Enter / Esc'],
    ['SSH 접속 프롬프트 취소', '⌃ C', 'Ctrl C'],
  ]},
];

function shortcutKeysHtml(spec){
  // 한 줄짜리 설명(드래그 안내 등)은 키 모양 없이 글자로 보여준다.
  if(/[가-힣]/.test(spec)) return '<span class="sc-text">' + escapeHtml(spec) + '</span>';
  return spec.split(' ').map(function(t){
    return t === '/' ? '<span class="sc-or">/</span>' : '<kbd>' + escapeHtml(t) + '</kbd>';
  }).join('');
}

function renderShortcutHelp(){
  var host = document.getElementById('shortcutHelp');
  if(!host) return;
  var isMac = /Mac/i.test(navigator.platform || navigator.userAgent || '');
  var sections = [
    { os: 'mac', name: 'macOS', col: 1 },
    { os: 'win', name: 'Windows', col: 2 },
  ];
  if(!isMac) sections.reverse(); // 지금 쓰는 OS를 위에
  host.innerHTML = sections.map(function(sec){
    var cur = (sec.os === 'mac') === isMac;
    return '<section class="sc-os' + (cur ? ' current' : '') + '"><h4>' + sec.name + (cur ? ' <span class="sc-cur">현재</span>' : '') + '</h4>' +
      SHORTCUT_HELP.map(function(g){
        return '<div class="sc-group"><div class="sc-title">' + escapeHtml(g.title) + '</div>' +
          g.rows.map(function(r){
            return '<div class="sc-row"><span class="sc-label">' + escapeHtml(r[0]) + '</span><span class="sc-keys">' + shortcutKeysHtml(r[sec.col]) + '</span></div>';
          }).join('') + '</div>';
      }).join('') + '</section>';
  }).join('');
}
renderShortcutHelp();
