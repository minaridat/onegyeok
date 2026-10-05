# RDP 기술 스택 — FreeRDP 직접 연동 네이티브 헬퍼

> 메인 기술 스택: [00_메인_기술스택.md](./00_메인_기술스택.md) · 기능 명세: [../기능명세/05_RDP_기능명세.md](../기능명세/05_RDP_기능명세.md)
> 상태: 🚧 설계/구현 중 — 이전 Apache Guacamole(`guacd`) 기반 구현은 폐기 결정됨(아래 "폐기한 이전 접근" 참고)

## 왜 바꿨나

이전 버전은 Apache Guacamole 생태계(`guacd` + `guacamole-lite` + `guacamole-common-js`)를 그대로 썼다.
동작은 했지만, **"서버 설치 없이 앱만 설치해서 쓴다" + "Windows에서도 SSH처럼 앱 내부 탭에 화면이 떠야 한다"**
두 요구사항과 근본적으로 안 맞는다는 게 이번 세션에서 실측으로 드러났다:

- `guacd`는 RDP를 실제로 말하는 네이티브 데몬인데, **Docker로 별도 실행해야 하는 외부 의존성**이다. 매 사용자가
  Docker를 설치하게 만들 수는 없다.
- `guacd`를 앱에 네이티브로 번들링해보려 시도했다(macOS에서 소스 패치 4건 + symlink로 실제 컴파일/플러그인
  로딩까지 성공). 하지만 `guacd`의 코드베이스 전체가 POSIX 전제가 깊게 깔려 있다(`dlopen` 기반 `.so` 플러그인
  로딩, `SCM_RIGHTS` fd 전달, pthread 확장) — macOS 포팅도 패치가 필요했을 정도인데, Windows는 `dlopen`도
  `fork`+fd 전달도 없어서 포팅 난이도가 비교할 수 없이 크다. 공식 Windows 지원도 미완성 상태([GUACAMOLE-1841](https://issues.apache.org/jira/browse/GUACAMOLE-1841)).
- `guacd` 1.6.0의 RDP 플러그인은 Homebrew의 FreeRDP 3.32.1과 ABI가 안 맞아 빌드 자체가 실패했다
  (`rdp_freerdp.input` 멤버가 제거됨). 패치로 고칠 수 있는 종류의 문제였지만(실제로 아래 프로토타입에서 같은
  문제를 한 줄로 고쳤다), 그걸 고친다 해도 Windows 포팅 문제는 그대로 남는다.
- 설계상으로도 `guacd`를 쓰는 한 Windows 네이티브 창 임베딩 없이는 "앱 내부 탭" 요구를 못 채운다 — Guacamole의
  JS 라이브러리는 화면·입력 중계만 할 뿐, 실제 RDP 접속은 `guacd` 안의 FreeRDP가 하기 때문에 렌더러 코드가
  크로스플랫폼이어도 RDP 엔진 배포 문제는 그대로다.

**결론: `guacd`를 거치지 않고 `libfreerdp`를 직접 링크한 네이티브 헬퍼 프로세스를 자체 제작한다.** FreeRDP
자체는 Windows/macOS 양쪽에 공식 빌드 경로가 있고(`guacd`보다 훨씬 성숙), X11/SDL 레퍼런스 클라이언트가 이미
"libfreerdp에서 콜백으로 프레임 받기 → 자기 창에 그리기" 패턴을 쓰고 있다 — 우리는 "자기 창"을 "Electron에 IPC로
전달"로만 바꾸면 된다. `/tmp/onegyeok-verify/rdp-probe.c`로 이 핵심 가정을 먼저 검증했다(아래 "실현 가능성
검증" 참고).

## 실현 가능성 검증 (완료)

`libfreerdp`만 링크한 ~90줄 C 프로그램으로 실제 RDP(xrdp 테스트 컨테이너)에 접속해 `BitmapUpdate` 콜백으로
실제 프레임 데이터(해상도/좌표/픽셀)를 받는 데 성공했다. 확인된 사실:

- FreeRDP 3.x는 설정을 구조체 필드 직접 접근이 아니라 accessor로 쓴다: `freerdp_settings_set_string/uint32/bool(settings, FreeRDP_xxx, ...)`.
- `instance->update`는 3.x에서 제거됐고 `instance->context->update`로 옮겨갔다(= `guacd`를 깨뜨린 그 변화와 동일 — 패치 한 줄로 해결됨).
- 입력 주입 API(`freerdp_input_send_keyboard_event_ex`/`send_mouse_event`/`send_unicode_keyboard_event`)는 `instance->context->input`에 공개돼 있다(이번 프로토타입에서 수신 쪽만 확인, 송신 쪽은 문서상 동일 신뢰도).
- 비트맵은 압축된 채로 온다(`compressed=1`). **우리가 RDP 코덱을 재구현하지 않도록**, `BitmapUpdate` 콜백을 가로채지 않고 FreeRDP 내장 GDI 소프트웨어 렌더러를 그대로 돌린 뒤 `gdi->primary_buffer`(디코딩 완료된 BGRA 프레임버퍼)를 주기적으로 읽어 변경된 영역만 diff해서 보낸다.
- `freerdp_connect()`는 동기/블로킹이다 — 세션당 자기 스레드(또는 `client/common`의 `RDP_CLIENT_ENTRY_POINTS` 스캐폴딩)가 필요하다.
- 테스트에 쓴 구버전 xrdp는 TLS만 통과했고(NLA/표준 RDP 보안은 실패) — 이건 이 픽스처의 한계로 보이며, 실제 Windows 서버 대상 NLA 검증은 아직 남아 있다.
- Windows에서 `libfreerdp` 빌드 자체는 아직 검증 전이다(이번 프로토타입은 macOS만).

## 아키텍처 (v2 — 설계)

```
렌더러(.rdp-pane, <canvas>)        메인 프로세스                              네이티브 헬퍼 프로세스               대상 서버
┌───────────────────────┐  IPC   ┌──────────────────────────┐  spawn   ┌──────────────────────────┐
│ <canvas> + putImageData│ <────> │ src/main/protocols/rdp/    │ ───────> │ onegyeok-rdp-helper        │ ──RDP──> Windows 서버
│ 마우스/키보드 리스너    │ ws 없음│   index.js + helper-bridge │  stdio   │  (libfreerdp 직접 링크)     │
│ (rdp.mouse/key 호출)   │        │   - 헬퍼 프로세스 spawn    │  framed  │  - PreConnect/PostConnect  │
└───────────────────────┘        │   - stdout 프레이밍 파싱   │  binary  │  - GDI 렌더 → 프레임 diff   │
                                  │   - webContents.send로     │ <─────── │  - freerdp_input_send_*    │
                                  │     프레임/상태 push        │          │    (입력 역주입)            │
                                  └──────────────────────────┘          └──────────────────────────┘
```

- **화면 스트림이 IPC를 거친다** (이전 버전과 가장 큰 차이). 이전엔 렌더러가 로컬 WebSocket에 직접 붙어 IPC를
  우회했지만, 이번엔 상대가 로컬 프로세스의 stdout이라 렌더러가 직접 접근할 방법이 없다 — Electron의
  `ipcRenderer`/`ipcMain`은 `Buffer`/`Uint8Array`를 JSON 변환 없이 구조화 복제로 전달하므로, 프레임 사각형
  단위로 보내면 오버헤드는 작다.
- **헬퍼는 세션(탭)당 1개 프로세스**다 — `child_process.spawn()`으로 띄우고, 비밀번호는 커맨드라인 인자가 아니라
  spawn 이후 stdin으로 전송되는 `CONNECT` 메시지로만 전달한다(프로세스 목록에 노출 방지, F-601 원칙 유지).
- **연결 유지/강제 종료**(F-501/502)는 기존 패턴 그대로: `disconnectAll()`이 살아있는 모든 헬퍼 프로세스에
  `DISCONNECT`를 보내고 종료를 기다린 뒤, 응답 없으면 SIGTERM/SIGKILL.

### IPC 프레이밍 (Node ↔ 헬퍼, stdio)

양방향 공통: `[u32 LE length][u8 type][payload (length-1 bytes)]` — `length`는 `type` 바이트 포함 길이.

**Node → 헬퍼 (명령)**

| type | 이름 | payload |
|---|---|---|
| `0x01` | `CONNECT` | UTF-8 JSON: `{host,port,username,password,domain?,width,height,colorDepth,security:"tls"\|"nla"\|"rdp",ignoreCertificate:bool}` |
| `0x02` | `DISCONNECT` | 없음 |
| `0x03` | `MOUSE` | `[u16 x][u16 y][u16 flags]` (FreeRDP `PTR_FLAGS_*` 비트마스크) |
| `0x04` | `KEY` | `[u16 scancode][u16 flags]` (`KBD_FLAGS_RELEASE`/`KBD_FLAGS_EXTENDED`) |
| `0x05` | `UNICODE_KEY` | `[u16 unicode][u8 flags]` (press=0/release=1) |
| `0x06` | `RESIZE` | `[u16 width][u16 height]` |

**헬퍼 → Node (이벤트)**

| type | 이름 | payload |
|---|---|---|
| `0x81` | `CONNECTED` | UTF-8 JSON: `{width,height}` |
| `0x82` | `FRAME` | `[u16 x][u16 y][u16 w][u16 h]` + raw BGRA32 픽셀(`w*h*4`바이트, GDI가 이미 디코딩한 데이터 그대로) |
| `0x83` | `STATUS` | UTF-8 JSON: `{state:"connecting"\|"connected"\|"disconnected"\|"error", message?}` |
| `0x84` | `LOG` | UTF-8 텍스트 (디버그용, 메인 프로세스 콘솔로만 전달) |

제어 메시지(`CONNECT`/`CONNECTED`/`STATUS`)는 드물게 오가므로 JSON으로 단순하게 처리하고, 고빈도인
`FRAME`/`MOUSE`/`KEY`만 고정 바이너리 헤더를 쓴다.

### 컴포넌트별 변경 범위 (폴더 분할 덕에 전부 `protocols/rdp/` 안에서 끝남)

- `native/rdp-helper/` (신규) — `libfreerdp`/`libwinpr`를 `pkg-config`로 링크하는 C 프로젝트. `/tmp/onegyeok-verify/rdp-probe.c`를 베이스로, GDI 프레임 diff + 위 프레이밍 프로토콜 + `RDP_CLIENT_ENTRY_POINTS` 스캐폴딩 적용.
- `src/main/protocols/rdp/index.js` + 신규 `helper-bridge.js` — 헬퍼 프로세스 spawn/프레이밍 파싱/IPC 중계. `rdp-manager.js`(guacamole-lite 기반)는 대체된다.
- `src/preload/preload.js`의 `rdp:` 블록 — 기존 `{connect,disconnect}`(토큰+WS 주소 반환)를 폐기하고 `{connect,disconnect,mouse,key,resize,onFrame,onStatus}`로 교체.
- `src/renderer/protocols/rdp/rdp.js` — `guacamole-common-js`(`Guacamole.Client` + WebSocket)를 제거하고 `<canvas>` + `onFrame`으로 `putImageData`, DOM 마우스/키보드 이벤트를 스캔코드로 변환해 전송.

## 알려진 제약 / 남은 작업 (v2)

- Windows에서 `libfreerdp` 빌드·패키징 미검증.
- 실제 Windows 서버(NLA) 대상 보안 협상 미검증 — 지금까지는 구버전 xrdp 대상 TLS만 확인.
- 키보드 스캔코드 매핑(JS `KeyboardEvent` → RDP scancode)을 직접 구현해야 한다(기존엔 `guacamole-common-js`가 제공).
- 오디오/클립보드/드라이브 마운트는 범위 밖(이전 버전과 동일하게 v1 UI 미노출).

## 폐기한 이전 접근 (Apache Guacamole)

`guacd` + `guacamole-lite` + `guacamole-common-js` 기반 구현은 기능적으로는 끝까지 동작했고, 실제
`guacamole-lite@1.2.0`의 토큰 IV 복호화 손실 버그(7bit ascii 왕복)와 `WebSocketTunnel` 토큰 전달 방식
등 라이브러리 함정도 다 우회해서 end-to-end로 붙는 것까지 확인했었다. 다만 위에서 설명한 배포 구조상의
근본적 한계 때문에 v2로 교체하기로 결정했다 — 코드는 git 히스토리에 남아 있다(`src/main/rdp-manager.js`,
이전 커밋의 `src/renderer/protocols/rdp/rdp.js`).
