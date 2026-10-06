# VNC 기술 스택 — libvncclient 직접 링크 네이티브 헬퍼

> 메인 기술 스택: [00_메인_기술스택.md](./00_메인_기술스택.md) · 기능 명세: [../기능명세/06_VNC_기능명세.md](../기능명세/06_VNC_기능명세.md)
> 상태: ✅ 적용됨 — `native/vnc-helper/` + `src/main/protocols/vnc/` + `src/renderer/protocols/vnc/`, 실제 VNC 테스트 서버 대상 end-to-end 검증 완료. [RDP(libfreerdp 네이티브 헬퍼)](./03_RDP_기술스택.md)와 동일한 아키텍처를 그대로 따른다

## 왜 이 방식인가

RDP 때와 같은 이유다: 서버(`guacd`/Docker/websockify 등) 없이 앱만 설치해서 쓰는 걸 전제로 하면, VNC도 RFB 프로토콜을
직접 말하는 네이티브 라이브러리를 Electron이 자식 프로세스로 띄워 쓰는 게 맞다. `noVNC` 같은 브라우저 네이티브
클라이언트는 WebSocket 기반이라 `websockify`(TCP↔WS 프록시)가 로컬에 별도로 떠 있어야 하는데, 이건 RDP 때
`guacd`를 외부 의존성으로 두지 않기로 한 결정과 모순된다.

대신 **`libvncclient`(LibVNCServer 프로젝트의 클라이언트 라이브러리)를 직접 링크**한다. VNC/RFB 프로토콜은
RDP보다 훨씬 단순하고(복잡한 보안 협상이 없고, 인증도 단일 패스워드 챌린지-응답이 전부), `libvncclient`의 공개
API(`rfb/rfbclient.h`)가 RDP 때 FreeRDP 3.x에서 겪었던 것 같은 ABI 급변 없이 안정적이다. Homebrew의
`libvncserver` 패키지(0.9.15_1)가 `libvncclient`도 같이 설치하며, 이미 이전 세션의 guacd 빌드 작업 때 설치돼
있어 바로 쓸 수 있다(`pkg-config libvncclient`).

**RDP 쪽과 완전히 동일한 Node ↔ 네이티브 헬퍼 와이어 프로토콜(길이-프리픽스 바이너리 프레이밍)을 그대로
재사용**한다 — 메시지 타입 번호와 페이로드 스키마만 VNC에 맞게 조정한다(아래).

## libvncclient 핵심 API (확인됨, `/opt/homebrew/Cellar/libvncserver/0.9.15_1/include/rfb/rfbclient.h`)

RDP의 FreeRDP보다 단순하다 — 압축 해제/프레임 diff를 우리가 할 필요가 없다:

- `rfbGetClient(8,3,4)` — 클라이언트 생성(8bit/sample, 3 samples, 4 bytes/pixel = 32bpp 요청).
- `client->serverHost`/`client->serverPort` — 접속 대상(직접 필드, RDP처럼 accessor 아님).
- `client->GetPassword` 콜백 — 비밀번호 문자열을 `strdup`해서 반환(호출 후 라이브러리가 free함).
- `client->MallocFrameBuffer` 콜백 — 서버가 알려준 `client->width`/`client->height`에 맞춰 `client->frameBuffer`를 할당(해상도는 서버가 결정, RDP처럼 클라이언트 요청 무시될 수 있음 — 동일 패턴).
- `client->GotFrameBufferUpdate(client, x, y, w, h)` 콜백 — **서버가 이미 `client->frameBuffer`에 디코딩까지 끝낸 뒤 변경된 사각형 좌표를 직접 알려준다.** RDP 때처럼 우리가 풀프레임을 주기적으로 diff할 필요 없음 — 이 콜백에서 바로 해당 사각형만 떼어 헬퍼→Node로 보내면 된다.
- `ConnectToRFBServer()` + `InitialiseRFBConnection()` — 연결/핸드셰이크.
- `HandleRFBServerMessage(client)` — 메시지 1개 처리(블로킹) — 반복 호출하는 루프가 메인 루프.
- `SendPointerEvent(client, x, y, buttonMask)` — 마우스(버튼마스크 비트: `rfbButton1Mask=1`, `rfbButton2Mask=2`, `rfbButton3Mask=4`, 휠은 버튼 4/5로 표현).
- `SendKeyEvent(client, keysym, down)` — 키보드. **스캔코드가 아니라 X11 keysym**(RDP와 다른 체계 — 렌더러 쪽 키 매핑 테이블을 새로 만들어야 한다. 예: `XK_a`=0x0061, `XK_Return`=0xff0d, `XK_BackSpace`=0xff08, `XK_Up`=0xff52 등 — 표준 X11 keysym 값).

## 와이어 프로토콜 (RDP와 동일 프레이밍, 페이로드만 VNC용)

`[u32 LE length][u8 type][payload]`, length = type 바이트 포함 길이. 메시지 타입 번호는 RDP 헬퍼와 **의도적으로
같은 네임스페이스를 쓰지 않는다**(헬퍼 프로세스가 프로토콜별로 완전히 분리돼 있어 번호가 겹쳐도 실제로는 문제
없지만, 로그/디버깅 시 헷갈리지 않도록 RDP와 동일한 타입 체계를 그대로 재사용한다 — 아래 표는 RDP 문서의
표와 번호가 같다, 페이로드 스키마만 다름):

**Node → 헬퍼**

| type | 이름 | payload |
|---|---|---|
| `0x01` | `CONNECT` | JSON: `{host,port,password,colorDepth}` (VNC는 username이 없다 — F-1006. `width`/`height`는 서버가 결정하므로 보내지 않는다) |
| `0x02` | `DISCONNECT` | 없음 |
| `0x03` | `MOUSE` | `[u16 x][u16 y][u8 buttonMask]` |
| `0x04` | `KEY` | `[u32 keysym][u8 down]` (RDP의 `KEY`는 스캔코드+flags였지만 VNC는 keysym 하나 + down/up 1바이트로 충분) |
| `0x06` | `RESIZE` | 없음/no-op — VNC는 서버가 해상도를 결정하므로 클라이언트 리사이즈 개념이 없다 |

**헬퍼 → Node**

| type | 이름 | payload |
|---|---|---|
| `0x81` | `CONNECTED` | JSON `{width,height}` |
| `0x82` | `FRAME` | `[u16 x][u16 y][u16 w][u16 h]` + raw RGBA32 픽셀(`w*h*4`바이트 — `GotFrameBufferUpdate`가 이미 디코딩해준 `frameBuffer`에서 해당 사각형만 잘라 보낸다. RDP는 BGRA였는데 VNC는 `rfbGetClient` 호출 시 픽셀 포맷을 우리가 지정하므로 **RGBA로 바로 요청해서 렌더러 쪽 BGRA→RGBA 스왑을 아예 안 해도 되게** 만든다 — RDP와 다르게 의도적으로 맞춘 선택) |
| `0x83` | `STATUS` | JSON `{state, message?}` |
| `0x84` | `LOG` | 텍스트 |

## 아키텍처 (RDP와 동일 구조, 컴포넌트 경로만 vnc로)

```
렌더러(.vnc-pane, <canvas>)        메인 프로세스                       네이티브 헬퍼 프로세스              대상 서버
┌───────────────────────┐  IPC   ┌──────────────────────────┐ spawn  ┌──────────────────────────┐
│ <canvas> + putImageData│ <────> │ src/main/protocols/vnc/    │ ─────> │ onegyeok-vnc-helper        │ ──RFB──> VNC 서버
│ 마우스/키보드(keysym)   │        │   index.js + helper-bridge │ stdio  │  (libvncclient 직접 링크)   │
└───────────────────────┘        └──────────────────────────┘        └──────────────────────────┘
```

- `native/vnc-helper/`는 `native/rdp-helper/`와 **완전히 독립된 디렉터리**다(다른 프로토콜 작업자와 파일이
  절대 겹치지 않도록 — `framing.c`/`jsonlite.c` 같은 공용 로직도 공유 모듈로 뽑지 않고 각자 복붙해서 독립
  유지한다. 폴더 분할의 원래 목적인 "병렬 작업 시 공용 파일 충돌 없음"을 깨지 않기 위함).
- `src/main/protocols/vnc/index.js`가 `registerMainProtocol('vnc', {...})`로 등록(이미 스텁이 있음 — 내용만
  채운다). `src/renderer/protocols/vnc/vnc.js`도 이미 스텁(`registerProtocol('vnc', {...})`) — 내용만 채운다.

## 구현 중 발견한 `libvncclient` 함정 (우회 처리함)

실제 구현 과정에서 헤더만 보고는 알기 힘든 라이브러리 동작 3가지를 발견했다 — 다음에 또 마주칠 수 있어 기록해둔다.

1. **`client->width`/`client->height`는 `InitialiseRFBConnection()`이 채워주지 않는다.** ServerInit 메시지(데스크톱
   이름, 픽셀 포맷)는 분명히 파싱되는데도 그렇다 — 실제 해상도는 `client->si.framebufferWidth`/`framebufferHeight`에서
   읽어야 한다.
2. 라이브러리는 들어오는 `FramebufferUpdate` 사각형을 `client->width`/`height` 기준으로 검증하는데, 이게 **`MallocFrameBuffer`를
   호출하기도 전에** 일어난다 — 1번 때문에 0으로 비어 있으면 첫 업데이트부터 "Rect too large"로 서버가 연결을 끊는다.
3. 그렇다고 `client->width`/`height`를 우리가 직접 채우면, 라이브러리의 "크기가 바뀌었으니 `MallocFrameBuffer` 호출" 감지
   로직이 바로 그 필드를 비교해서 판단하기 때문에 **무력화된다** — 결과적으로 `client->frameBuffer`가 NULL인 채로 남아
   `GotFrameBufferUpdate`에서 NULL `memcpy` 세그폴트가 난다. **해결**: 치수를 직접 설정한 뒤, 라이브러리가 평소
   알아서 해주던 나머지 절반도 우리가 직접 해준다 — `client->MallocFrameBuffer(client)`를 그 자리에서 바로 호출.
4. 연결 후 첫 업데이트가 자동으로 오지 않는다 — `SendFramebufferUpdateRequest()`를 명시적으로 보내야 한다.

RGBA 다이렉트 가정은 실제로 맞았다 — `client->format.{redShift=0,greenShift=8,blueShift=16}`을 연결 전에
설정하면 이 호스트(리틀엔디안)에서 메모리상 바이트 순서가 `[R,G,B,_]`로 나온다(실측 확인, alpha는 0xFF로 강제).

## 남은 작업 / 알려진 제약 (v1)

- **F-1003(SSH 터널링 기본 적용)은 이번 범위 밖이다.** 헬퍼는 그냥 주어진 host:port에 직접 붙는다 — SSH 터널을
  거치게 하려면, 헬퍼를 건드릴 필요 없이 **Node 메인 프로세스가 `ssh2`(이미 SSH 기능에 쓰고 있는 의존성)로
  로컬 포트포워딩을 먼저 열고, 헬퍼에게는 `127.0.0.1:<로컬포트>`를 넘기면 된다** — 순수 main 프로세스 레이어의
  일이라 헬퍼 프로토콜과 독립적으로 나중에 추가 가능.
- F-1004(읽기전용 모드)는 렌더러에서 마우스/키보드 이벤트 전송을 그냥 안 하면 된다(헬퍼/프로토콜 변경 불필요).
- F-1002(화질/인코딩 옵션)는 `rfbGetClient`/`appData` 쪽 인코딩 설정 노출이 필요 — v1 범위 밖, 기본 인코딩만 사용.
- F-1005(스케일/줌)는 렌더러 쪽 캔버스 CSS 스케일링만으로 충분 — 헬퍼/IPC 변경 불필요.
- Windows 빌드 검증은 RDP와 마찬가지로 아직 안 됨.
