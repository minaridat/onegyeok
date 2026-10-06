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
var PROTO = {};
var OnegyeokProtocols = {};

function registerProtocol(name, def){
  OnegyeokProtocols[name] = def;
  if(def.meta) PROTO[name] = def.meta;
}

function getProtocol(name){ return OnegyeokProtocols[name]; }

function allProtocolNames(){ return Object.keys(OnegyeokProtocols); }
