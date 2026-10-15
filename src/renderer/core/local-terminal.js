// ---- 로컬 터미널 — 이 PC의 셸(macOS: 로그인 셸, Windows: cmd.exe)을 SSH 터미널과 같은 화면으로 연다 ----
// git 같은 로컬 명령어를 앱을 떠나지 않고 쓸 수 있다. 원격 접속이 아니라 인증이 없고, 서버 목록(저장 대상)에도 남기지 않는다
// (사이드바 "로컬 터미널" 그룹의 임시 항목 — 다시 열 때마다 새 탭이 생긴다). 화면·동시 입력·스플릿뷰는 SSH 터미널 그대로다.
var LOCAL_TERM_ID = '로컬 터미널';
var LOCAL_TERM_GROUP = '로컬';
var localTermBtn = document.getElementById('localTermBtn');

function openLocalTerminal(){
  var srv = SERVERS.find(function(s){ return s.id === LOCAL_TERM_ID; });
  if(!srv){
    srv = {
      id: LOCAL_TERM_ID, name: LOCAL_TERM_ID, group: LOCAL_TERM_GROUP, protocol: 'ssh', host: 'localhost', port: null, username: '',
      authMethod: 'password', keyFilePath: null, jump: null, sqlEngine: null, database: '', fileProtocol: null,
      local: true, temp: true, status: 'off', since: '연결 안 됨', auth: '인증 없음 (이 PC의 셸)'
    };
    SERVERS.push(srv);
    if(GROUP_ORDER.indexOf(LOCAL_TERM_GROUP) === -1) GROUP_ORDER.push(LOCAL_TERM_GROUP);
    renderTree();
    populateGroupSelectors();
  }
  return selectServer(srv.id);
}

if(localTermBtn) localTermBtn.addEventListener('click', openLocalTerminal);
