# RDP 기술 스택 — Apache Guacamole (`guacd` + `guacamole-lite` + `guacamole-common-js`)

> 메인 기술 스택: [00_메인_기술스택.md](./00_메인_기술스택.md) · 기능 명세: [../기능명세/05_RDP_기능명세.md](../기능명세/05_RDP_기능명세.md)
> 상태: ✅ 적용됨 — `src/main/rdp-manager.js`

## 검토했던 옵션과 최종 선택

순수 JS로 RDP 프로토콜 자체를 처음부터 구현한 활발한 라이브러리는 마땅치 않았다(`node-rdpjs`는 유지보수가
멈춘 지 오래). FreeRDP를 자식 프로세스로 띄워 OS 네이티브 창을 Electron 안에 임베딩하는 방식(CLI 서브프로세스
또는 네이티브 addon 바인딩)도 검토했지만, 플랫폼마다 창 핸들을 다뤄야 해서 구현·배포 난이도가 매우 높았다.

대신 **Apache Guacamole 생태계**를 그대로 가져다 쓰기로 했다 — RDP/VNC/SSH를 브라우저(HTML5 canvas)에서
그대로 렌더링하도록 설계된, 이미 널리 쓰이는 성숙한 오픈소스 스택이다.

| 구성 요소 | 역할 |
|---|---|
| `guacd` | RDP 프로토콜을 실제로 말하는 네이티브 데몬. **Docker(`guacamole/guacd`)로 별도 실행해야 하는 외부 의존성**이다 — onegyeok 앱 자체에는 포함되지 않는다 |
| `guacamole-lite`(npm) | Node.js 라이브러리. 메인 프로세스에서 로컬 WebSocket 서버를 띄우고, 암호화된 토큰(호스트/계정/비밀번호 등 접속 정보)을 받아 `guacd`와 TCP로 핸드셰이크한 뒤 WebSocket↔TCP 사이를 중계한다 |
| `guacamole-common-js`(npm) | 브라우저(렌더러)에서 그 WebSocket에 접속해 화면을 `<canvas>`에 그리고 마우스/키보드 입력을 전송하는 공식 클라이언트 라이브러리. xterm.js와 같은 방식으로 `src/renderer/vendor/`에 정적 스크립트로 번들링 |

## 왜 이 방식인가

- **검증된 구현체**: RDP 프로토콜 자체의 복잡한 디테일(타일 압축, 코덱 등)을 `guacd`(C로 작성된 성숙한 구현)가 전담한다 — 우리가 직접 구현할 필요가 없다.
- **렌더러는 순수 웹 기술만 사용**: `guacamole-common-js`는 WebSocket + Canvas만 쓰는 평범한 브라우저 라이브러리라, Electron의 `contextIsolation`/`sandbox` 보안 모델을 그대로 유지한 채 렌더러에서 직접 동작한다. 네이티브 창 임베딩이 필요 없다.
- **같은 코드로 VNC까지 확장 가능**: `guacd`는 VNC도 지원하므로, [06_VNC_기능명세](../기능명세/06_VNC_기능명세.md) 구현 시 `rdp-manager.js`의 어댑터 패턴을 그대로 재사용할 수 있다(연결 타입만 `rdp`→`vnc`로 바뀜).

## 아키텍처

```
렌더러(.rdp-pane)                 메인 프로세스                    외부(로컬/네트워크)
┌─────────────────────┐   IPC    ┌──────────────────────┐        ┌──────────┐
│ guacamole-common-js  │ ───────> │ rdp-manager.js        │        │  guacd   │
│  Guacamole.Client    │ connect  │  - guacamole-lite로    │  TCP   │  :4822   │
│  (Canvas에 렌더링)    │          │    로컬 WS 서버 기동   │ ─────> │          │ ──RDP──> 대상 Windows 서버
│                       │ <─ws url─│  - 접속 정보로 암호화  │        └──────────┘
│  WebSocket(직접 연결) │ ════════>│    토큰 발급           │
└─────────────────────┘  실제 화면 └──────────────────────┘
                          스트림은
                          IPC를 거치지 않고
                          렌더러↔로컬 WS로 직접 오간다
```

- IPC(`window.onegyeok.rdp.connect`)는 **토큰 발급과 로컬 WebSocket 서버 주소를 돌려주는 역할만** 한다 — 실제 화면 스트림(바이너리 데이터)을 `ipcRenderer`로 중계하면 느리고 무겁기 때문에, 렌더러가 받은 주소로 **직접** WebSocket을 연다. `index.html`의 CSP에 `connect-src`를 추가해 로컬 WebSocket 연결을 허용해야 한다.
- 비밀번호는 SSH/SQL과 동일한 원칙([공통 기능명세](../기능명세/00_공통_기능명세.md) F-601)으로 저장하지 않는다 — 접속할 때마다 탭 안의 접속 폼에 직접 입력하고, 그 값은 토큰 암호화에만 쓰인 뒤 메모리에서 사라진다. 토큰 자체는 매 연결마다 새로 발급되는 1회성이며, 암호화 키는 앱 실행마다 메모리에서 랜덤 생성한다(디스크에 저장하지 않음).
- 연결 유지/강제 종료는 [공통 기능명세](../기능명세/00_공통_기능명세.md) F-501/502를 그대로 따른다 — `ssh-manager.js`/`db-manager.js`와 같은 패턴으로 `rdp-manager.js`의 `disconnectAll()`을 `main.js`의 `terminateAllSessions()`에 등록했다(로컬 WS 서버 자체를 닫아 모든 세션을 일괄 종료).

## 로컬 개발/테스트 환경

- `docker run -d -p 4822:4822 guacamole/guacd` — Guacamole 공식 이미지.
- 검증은 공식 `ubuntu` 베이스 이미지에 Ubuntu 공식 저장소의 `xrdp` 패키지만 설치해 직접 만든 테스트용 컨테이너로 했다(출처 불명 서드파티 이미지를 그대로 받아쓰지 않기 위함).
- `guacd`와 테스트용 xrdp 컨테이너는 같은 Docker 네트워크에 올려야 한다 — `guacd`는 자기 컨테이너 안에서 접속을 시도하므로, 호스트에 포트 매핑된 `127.0.0.1:PORT`가 아니라 **컨테이너 이름(또는 IP)과 컨테이너 내부 포트**를 서버 등록의 호스트/포트로 써야 한다.

## 구현 중 발견한 `guacamole-lite@1.2.0` 자체의 버그/함정 (우회 처리함)

실제 `guacd`+테스트 xrdp로 end-to-end 검증을 하는 과정에서 두 가지 문제를 만났고, 둘 다 onegyeok 코드가 아니라
**라이브러리 사용법/라이브러리 자체 버그**였다 — 다음에 또 마주칠 수 있어 기록해둔다.

1. **`guacamole-lite`의 토큰 IV 복호화가 손실 변환을 쓴다(라이브러리 버그)**: `ClientConnection.decryptToken()` →
   `Crypt.decrypt()`가 IV를 `Buffer.toString('ascii')`로 문자열화하는데, `'ascii'`는 7비트라 상위 비트가 있는
   바이트(0x80 이상)는 매번 깎여서 원래 IV와 달라진다(반면 암호문 본문(`value`)은 손실 없는 `'binary'`로 디코드해서
   비대칭이다). 그 결과 README/예제 그대로 128비트 랜덤 IV를 쓰면 거의 항상 `"Token validation failed"`로 실패한다.
   **우회**: `rdp-manager.js`의 `encryptToken()`에서 IV를 생성할 때 각 바이트를 `& 0x7f`로 7비트 범위(0~127)로
   제한한다 — 그 범위 안에서는 `'ascii'` 왕복이 손실 없이 보존된다. 엔트로피가 128비트→112비트로 줄지만, 이
   토큰은 로컬에서만 쓰이는 1회용이라 문제 없는 수준이다.
2. **`Guacamole.WebSocketTunnel`은 토큰을 URL이 아니라 `client.connect(data)`로 받는다**: `WebSocketTunnel.connect()`
   내부가 `new WebSocket(tunnelURL + "?" + data, "guacamole")`로 자기 쿼리스트링을 붙인다. 토큰을 미리
   `?token=...`으로 넣은 URL을 `WebSocketTunnel` 생성자에 통째로 넘기고 `client.connect()`를 인자 없이 호출하면,
   물음표가 두 번 들어간 `...?token=xxx?undefined` 꼴이 되어 서버가 받는 `token` 값 끝에 `?undefined`가 붙은 채로
   깨진다 — 역시 `"Token validation failed"`로 똑같이 실패해서 1번 버그와 헷갈리기 쉽다.
   **해결**: `rdp-manager.js`는 쿼리스트링 없는 `wsBaseUrl`과 `token`을 따로 돌려주고, 렌더러는
   `new Guacamole.WebSocketTunnel(wsBaseUrl)` + `client.connect('token=' + encodeURIComponent(token))`로 연결한다.

## 알려진 제약 (v1)

- **`guacd`가 로컬(또는 접근 가능한 곳)에서 실행 중이어야 한다** — SSH/SQL과 달리 onegyeok 프로세스 혼자서는 RDP에 접속할 수 없다. `guacd`가 꺼져 있으면 연결 시도 시 명확한 에러를 보여준다(F-905a).
- `guacd`의 주소/포트는 현재 `127.0.0.1:4822` 고정이다 — 설정 화면이 생기면 변경 가능하게 만들 예정.
- 오디오/클립보드/드라이브 마운트 등은 `guacd`가 프로토콜 차원에서 지원하지만, v1 UI에는 아직 노출하지 않았다(F-903/904 범위 밖, 추후 추가).
