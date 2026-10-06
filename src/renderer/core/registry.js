// 프로토콜(연결 종류) 레지스트리 — 새 프로토콜(VNC/SFTP/Web 등)을 추가할 때 이 파일이나
// core/의 다른 파일은 건드리지 않고, src/renderer/protocols/<proto>/<proto>.js 하나만
// 새로 만들어 registerProtocol(...)을 호출하면 된다. index.html에 <script> 태그 한 줄만
// 추가하면 끝 — 공용 파일(index.html의 다른 부분, renderer core, 다른 프로토콜 파일)은
// 전혀 수정할 필요가 없다.
//
// 이 프로젝트는 번들러가 없어 모든 <script>가 하나의 전역 스코프를 공유한다(옛날식 스크립트
// 합치기 방식) — 그래서 각 프로토콜 파일은 독립 파일이면서도 core의 함수/변수를 그냥 이름으로
// 바로 참조할 수 있다. 서로 다른 git 파일이라 각자 독립적으로 수정해도 병합 충돌이 거의 없다.
//
// 각 프로토콜이 registerProtocol(name, def)에 넘기는 def 객체의 계약(contract):
//
//   meta: { label: string, icon: string(SVG 마크업) }
//     — 레일 아이콘, 탭 칩, 사이드바 서버 아이콘 등에 공통으로 쓰임. PROTO[name]으로도 그대로
//       조회 가능(과거 코드와의 호환을 위해 registerProtocol이 자동으로 PROTO[name] = def.meta 설정).
//
//   startSession(tabId, serverId, el)
//     — 서버를 클릭해 새 탭이 열릴 때 호출된다. el은 비어 있는 .pane 컨테이너(className도 아직
//       기본값). 필요한 className/자식 DOM을 el에 직접 구성하고, 그 안에서 실제 연결을 시작한다.
//
//   hasSession(tabId) -> boolean
//   getSession(tabId) -> object | null   (상태 조회용, 최소 { state: 'connected'|... } 형태)
//   disposeSession(tabId)                (탭을 완전히 닫을 때 — 세션 종료 + 내부 정리)
//   isServerConnected(serverId) -> boolean  (사이드바 상태 점 표시용 — 그 서버로 열린 세션 중
//                                            하나라도 연결돼 있으면 true)
//
//   hasConnAction: boolean
//     — 인스펙터의 "연결 종료/재연결" 버튼과 탭의 빠른 재연결 아이콘을 보여줄지 여부.
//   onConnActionClick(tabId)
//     — 인스펙터 버튼 클릭 시 호출(연결중이면 종료, 아니면 재연결 — 프로토콜이 내부에서 판단).
//   quickReconnect(tabId)
//     — 탭의 빠른 재연결 아이콘 클릭 시 호출.
//
//   registration: {
//     hideUsername: boolean,                       // 'web'만 true
//     renderExtra(container, existingServer),       // 등록 모달에 프로토콜 전용 필드를 주입
//     collectExtra(container) -> object,            // 저장 시 그 필드들의 값을 읽어옴
//     defaultPortPlaceholder(container) -> string,  // 포트 입력란 placeholder
//   }
//   inspectorExtra(container, row)
//     — 인스펙터 "연결 정보" 탭에 프로토콜 전용 행(예: SSH 점프호스트, SQL DB엔진)을 주입.
//       필요 없으면 생략 가능.
//
//   detachLocal(tabId)  [선택 — 탭 분리/병합 기능(core/tabs.js) 전용]
//     — 탭을 다른 창으로 끌어내 뺄 때, 원래 창에서 호출된다. 이 프로토콜의 로컬 UI 상태(예:
//       xterm Terminal 인스턴스, canvas 컨텍스트)를 정리하되, *IPC 연결 종료는 호출하지 않는다* —
//       main 프로세스의 실제 연결은 살아 있어야 새 창이 이어받을 수 있다. 정의하지 않으면
//       core가 대신 disposeSession(tabId)을 호출한다(=연결까지 완전히 끊고 새 창에서 새로 접속).
//   attachSession(tabId, serverId, el, handoff)  [선택 — 위와 짝]
//     — 다른 창에서 넘어온 탭을 받는 쪽(새 창 또는 병합 대상 창)에서 호출된다. startSession과
//       달리 "이미 연결돼 있을 수 있다"고 가정하고 접속 폼을 건너뛴 UI를 바로 구성한다 — 실제
//       상태는 메인 프로세스가 직후에 재전송(replay)하는 *:status(및 RDP/VNC는 전체 프레임)
//       이벤트로 채워진다. 정의하지 않으면 core가 대신 startSession(tabId, serverId, el)을
//       호출한다(=접속 폼부터 다시 시작). handoff는 아래 captureHandoff가 돌려준 값(없으면 null).
//
//   captureHandoff(tabId) -> object | undefined  [선택 — detachLocal/attachSession과 짝]
//     — 탭을 다른 창으로 끌어내기 직전(detachLocal보다 먼저), 원래 창에서 호출된다. main
//       프로세스는 이 값을 그대로 통째로 옮겨 실어 나를 뿐 내용을 전혀 들여다보지 않으므로,
//       JSON 직렬화 가능한 값이면 뭐든 담아도 된다(예: Web은 현재 URL). 대부분의 프로토콜은
//       정의할 필요 없다 — main 프로세스가 세션 상태(*:status)는 이미 자동으로 재전송해준다.
//
var PROTO = {};
var OnegyeokProtocols = {};

function registerProtocol(name, def){
  OnegyeokProtocols[name] = def;
  if(def.meta) PROTO[name] = def.meta;
}

function getProtocol(name){ return OnegyeokProtocols[name]; }

function allProtocolNames(){ return Object.keys(OnegyeokProtocols); }
