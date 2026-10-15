# Windows 빌드 작업 지시서 (AI 에이전트용)

> 이 문서는 **Windows PC에서 AI 에이전트에게 "이 파일을 읽고 Windows 설치 파일을 만들어라"** 라고 시킬 때 읽히는 용도다.
> 저장소: `https://github.com/minaridat/onegyeok` (브랜치 `main`). 작업은 새 브랜치 `minaridat/win-build`에서 한다.

## 0. 목표

onegyeok(Electron 기반 SSH/SQL/SFTP·FTP/RDP/VNC/Web 원격 접속 클라이언트)의 **Windows x64 설치 파일**(`.exe`, NSIS)을 만든다.

- 대상: Windows 10 22H2 이상 / Windows 11, **x64 전용** (ARM64·32bit 제외).
- 사용자 PC에 아무것도 설치돼 있지 않아도 설치 한 번으로 실행돼야 한다 → 헬퍼는 **정적 링크 또는 DLL 동봉**. vcpkg/Visual Studio가 사용자 PC에 필요하면 안 된다.
- 목업·테스트용 서버는 이미 제거돼 있다(서버 0개로 시작). 그대로 둔다.
- ISMS 방침: **비밀번호는 어디에도 저장하지 않는다**. 서버 목록은 Electron `safeStorage`(Windows에서는 DPAPI)로 암호화 저장되며 이미 구현돼 있다.

## 1. 이미 되어 있는 것 / 해야 하는 것

JS(메인·렌더러) 코드는 OS 공통이라 **수정 없이 Windows에서도 동작**한다. 막혀 있는 것은 아래 둘이다.

| 구분 | 상태 |
|---|---|
| Electron 앱(SSH·SQL·SFTP/FTP·Web·서버 저장·UI) | 공통 코드. 그대로 사용 |
| `native/rdp-helper`, `native/vnc-helper` (C 네이티브 헬퍼) | **macOS 전용으로만 빌드됨 → Windows용 빌드·포팅 필요** |
| `package.json`의 `build.win` / `nsis` 설정 | **없음 → 추가 필요** |
| 빌드 스크립트 | `scripts/mac/`만 있음 → `scripts/win/` 추가 필요 |

앱은 헬퍼를 이미 Windows 이름으로 찾도록 되어 있다(`src/main/protocols/rdp/helper-bridge.js`: `onegyeok-rdp-helper.exe`, 패키징 시 `process.resourcesPath/native/rdp-helper/`). VNC도 동일 패턴(`native/vnc-helper/onegyeok-vnc-helper.exe`).

## 2. 해야 할 작업

### 2-1. 사전 준비 (Windows PC)
- Node.js LTS, Git, Visual Studio 2022 Build Tools(C++ 워크로드), CMake, Ninja, vcpkg.
- `git clone` 후 `git checkout -b minaridat/win-build main`, `npm install`.

### 2-2. 네이티브 의존성 빌드 (정적, x64)
macOS의 `scripts/mac/build-native-deps.sh`를 참고해 `scripts/win/build-native-deps.ps1`(또는 `.bat`)을 만든다.

- 대상 버전: **OpenSSL 3.5 / FreeRDP 3.32.1 / LibVNCServer(libvncclient)**. 가능하면 같은 버전을 쓴다.
- vcpkg 사용 시 triplet은 `x64-windows-static`(정적 CRT는 `x64-windows-static` 기본값). `freerdp3`는 vcpkg 포트의 기능을 확인하되 아래 **FreeRDP 필수 설정**을 만족해야 한다. 포트로 안 되면 FreeRDP 소스를 직접 CMake 빌드한다.
- FreeRDP는 **최소 구성**으로 빌드한다(macOS와 동일).
  - 클라이언트 채널: **`drdynvc`와 `disp`만 ON**, 나머지(clipboard, rdpdr, rdpsnd, audin, gfx 등) OFF.
  - 서버/샘플/프록시/Shadow/테스트 OFF, 정적 라이브러리(`BUILD_SHARED_LIBS=OFF`), 정적 CRT(`/MT`).
  - 호스트의 다른 라이브러리(예: Chocolatey/MSYS 경로)를 줍지 않도록 prefix를 격리한다(macOS에서 Homebrew의 opus를 잘못 주운 전례가 있다).
- **FreeRDP 소스 패치 1건 필수**: `libfreerdp/core/update.c`의 `update_recv`에서 상태 하한을 낮춘다. macOS 스크립트의 python 패치 부분을 그대로 옮긴다(`build-native-deps.sh`에서 `update.c`를 검색). 이 패치가 없으면 해상도 변경 시 xrdp 등에서 세션이 끊긴다.
- LibVNCServer: 클라이언트 라이브러리만 필요. CMake 4 이상에서 정책 오류가 나면 `-DCMAKE_POLICY_VERSION_MINIMUM=3.5`.

### 2-3. 헬퍼 C 코드 Windows 포팅
대상: `native/rdp-helper/src/{main.c,framing.c}`, `native/vnc-helper/src/{main.c,framing.c}`.

- **pthread 대체**: `pthread_mutex_*`, `pthread_create/join` → WinPR(`winpr/synch.h`, `winpr/thread.h`의 `CRITICAL_SECTION`/`CreateThread`) 또는 C11 `<threads.h>`. FreeRDP를 이미 링크하므로 WinPR 사용을 권장한다.
- **`<unistd.h>` 제거**: `read/write`로 stdin/stdout을 다루는 `framing.c`(`frame_read(int fd,…)`, `frame_write(int fd,…)`)를 Windows용으로 분기한다. `_read/_write`(`<io.h>`) 사용 시 **반드시 바이너리 모드**: `_setmode(_fileno(stdin), _O_BINARY)`, `_setmode(_fileno(stdout), _O_BINARY)`. 이걸 안 하면 `0x0A`가 `0x0D 0x0A`로 바뀌어 프레임이 깨진다.
- **`sleep/usleep`** 등 POSIX 호출은 `Sleep()`/WinPR `Sleep`으로 교체. `clock_gettime`은 `GetTickCount64`/`winpr/sysinfo.h` 등으로 교체.
- stderr 로그(`log_msg`)는 그대로 둔다(Electron이 stderr를 수집).
- Makefile 대신 **CMakeLists.txt**를 추가해 MSVC로 빌드한다. 산출물: `native/rdp-helper/onegyeok-rdp-helper.exe`, `native/vnc-helper/onegyeok-vnc-helper.exe` (정적 링크, VC 런타임 DLL 불필요).
- 포팅 후에도 **프로토콜(프레임 형식·MSG 번호)은 절대 바꾸지 않는다**. 메인 프로세스(`helper-bridge.js`)와 맞아야 한다. 새 메시지 `0x85 DESKTOP_RESIZED`가 이미 포함돼 있다.

### 2-4. package.json
`build`에 추가한다(macOS 설정은 건드리지 않는다).

```json
"win": {
  "target": [{ "target": "nsis", "arch": ["x64"] }]
},
"nsis": { "oneClick": false, "perMachine": false, "allowToChangeInstallationDirectory": true }
```

- `extraResources`의 `filter`가 현재 `onegyeok-rdp-helper`(확장자 없음)뿐이다 → `.exe`도 포함되도록 `"onegyeok-rdp-helper*"` 형태로 바꾸고(macOS 빌드에 영향 없는지 확인), 소스·Makefile·`.dSYM`·`test`는 제외한다. VNC도 동일.
- `scripts`에 `build:native:win`, `dist:win` 추가. `npmRebuild:false` 유지(`cpu-features` 네이티브 빌드가 실패하는 전례 있음).
- 코드 서명 인증서가 없으면 **미서명 설치 파일**이 된다(SmartScreen 경고 발생). 이는 정상이며 README에 "추가 정보 → 실행" 안내를 넣는다. 인증서 도입 여부는 사내 정책 결정 사항이므로 임의로 만들지 않는다.

### 2-5. 키보드·플랫폼 점검
`src/renderer/core/keyboard-shortcuts.js`는 `metaKey || ctrlKey`로 이미 Windows(Ctrl)를 허용한다. 다만 아래를 Windows에서 눈으로 확인한다.
- 탭 이동 단축키: macOS는 `⌘ + < >`. Windows에서는 `Ctrl + < >`(= `Ctrl+,` / `Ctrl+.` 계열)가 동작하는지, `Ctrl+Tab`, `Ctrl+Shift+Tab`이 동작하는지 확인하고, 안 되면 `e.code`(Comma/Period) 기반으로 보완.
- SSH 터미널에서 Ctrl 조합이 앱 단축키와 충돌하지 않는지(Ctrl+C 등은 터미널로 가야 함).

## 3. 이번까지의 수정/QA 내역 (Windows에서도 유지돼야 하는 것)

전체 항목은 [`docs/QA.md`](./QA.md)에 있다. 아래는 Windows 빌드에서 **회귀 검증**해야 할 핵심이다.

1. **서버 목록 저장(F-602)**: 서버 등록 → 종료 → 재실행 시 복원. `userData/servers.dat`가 평문으로 검색되지 않아야 한다. 비밀번호는 저장되지 않는다. 빠른 연결 임시 서버는 저장 제외.
2. **SSH 로그인 입력**: `login as:`에서 아이디는 그대로 보이고, 비밀번호/Passphrase는 `*`로 표시.
3. **SSH 화면 높이**: 분할 없이도 터미널이 pane 전체를 채움(윗부분만 차는 증상 없음).
4. **SSH 분할 선택기**: "새 세션 열기"(등록된 SSH 서버 전부, 같은 서버·열린 세션 없는 경우 포함)와 "열려 있는 세션 가져오기"(다른 탭 세션만). 같은 서버 선택 시 분할이 합쳐지지 않고 새 세션이 열림.
5. **그룹 없음 상태**에서 서버 등록 시 "새 그룹 추가"가 동작.
6. **Web 빠른 주소창** / **SFTP·FTP 빠른 연결**(등록 없이 연결, 저장 안 함, "빠른 연결" 그룹).
7. **SQL 결과**: 흰 배경 + 검정 글자.
8. **FTP/SFTP 선택 업로드(파랑)/선택 다운로드(빨강)** 버튼 강조.
9. **RDP 화면 크기 조절(동적 해상도)** — 가장 중요. 아래 4장 참고.
10. 서버 목록 영속화 외에 Web 인증서 오류 처리: 자체 서명 인증서 사이트에서 오류 화면 → "위험을 감수하고 이 탭에서만 계속"으로 해당 탭만 신뢰(메모리에만 유지).

## 4. RDP 동적 해상도 — Windows 헬퍼에서 반드시 지킬 것

이 기능은 구현 함정이 많았다(자세한 근거는 [`기술스택/03_RDP_기술스택.md`](./기술스택/03_RDP_기술스택.md) "화면 크기 조절"). `native/rdp-helper/src/main.c`의 로직을 **그대로 유지**한 채 포팅한다.

- 채널 로딩은 `PreConnect`가 아니라 **`instance->LoadChannels`** 훅(`my_load_channels` → `freerdp_client_load_addins`)에서 한다. PreConnect에서 로드하면 채널이 해제돼 `drdynvc`가 협상에 안 실린다.
- 정적 FreeRDP이므로 `freerdp_new()` 전에 `freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0)`를 호출한다.
- NetworkAutoDetect / Heartbeat / Multitransport / DeviceRedirection 등은 설정에서 꺼서 `rdpdr` 로드 실패를 피한다.
- `DISP_DVC_CHANNEL_NAME` 연결/해제 콜백으로 `g_disp`를 잡고, **첫 프레임을 낸 뒤에만** `SendMonitorLayout`을 보낸다(너무 일찍 보내면 세션이 끊김). 크기는 200~8192로 제한, 너비는 짝수.
- 해상도 변경 콜백(`my_desktop_resize`)에서 **`gdi_resize(context->gdi, w, h)`를 직접 호출**한다(`gdi_init`은 DesktopResize 핸들러를 등록하지 않는다 — 안 하면 화면이 왼쪽 위로만 늘어나고 오른쪽·아래가 빈다). 이어서 `freerdp_client_codecs_reset(...)`, 렌더러에 `0x85`(DESKTOP_RESIZED) 통지, **RefreshRect를 +400ms/+1500ms에 전체 화면으로 요청**.
- Windows Server는 xrdp와 동작이 다를 수 있으므로 **실제 Windows Server 대상 검증이 이번 작업의 핵심 산출물**이다(macOS 쪽은 xrdp로만 검증됨).

## 5. 검증 절차 (완료 기준)

각 항목을 직접 확인하고 결과를 `docs/QA.md` 하단 "Windows" 섹션에 ✅/🟡/🔲로 기록한다.

1. `npm run dist:win` 성공, `dist/`에 설치 `.exe` 생성. 깨끗한 Windows(VM 등)에서 설치·실행 가능(별도 런타임 설치 없이).
2. 설치 후 서버 0개·탭 0개 빈 화면으로 시작.
3. 3장의 1~8번 확인.
4. RDP: **실제 Windows Server**에 접속 → 창을 가로/세로로 키움·줄임·다시 키움 → 오른쪽·아래까지 화면이 채워지고 세션 유지. 전체 화면 전환도 확인. (Windows 로그인 NLA 접속 포함)
5. VNC: 접속·화면 표시·입력.
6. 설치된 앱 안의 `resources/native/*-helper/*.exe`가 실행되는지, 의존 DLL 누락이 없는지(`dumpbin /dependents`로 시스템 DLL만 남았는지) 확인.
7. 누락·실패 사항은 숨기지 말고 QA.md에 그대로 기록한다.

## 6. 작업 규칙

- 브랜치: `minaridat/win-build`에서 작업 → push → `minaridat/integration`에 `--no-ff` 병합 → `main` 병합 후 push.
- 커밋 메시지는 한국어, 변경 이유 중심으로.
- 릴리스: Windows 설치 파일은 GitHub Releases에 **macOS dmg와 같은 릴리스**에 `onegyeok-x64.exe` 등으로 추가하고, README의 설치 안내에 Windows 항목(다운로드 링크, SmartScreen 안내)을 추가한다.
- macOS 빌드 설정·스크립트(`scripts/mac`, `build.mac`)는 수정하지 않는다. `extraResources` 변경은 macOS 빌드에 영향이 없는지 `npm run dist:mac`로 확인(가능한 경우).
- 외부 서비스로 소스·설치 파일을 올리거나 인증서를 새로 발급하는 등 되돌리기 어려운 작업은 사용자에게 먼저 확인한다.


## 7. 추가 기능 반영 시 Windows에서 해야 할 일 (RDP 클립보드·드라이브 마운트, 로컬 터미널, 세션 로그)

1. **FreeRDP 다시 빌드** — `scripts/win/build-native-deps.ps1`이 이제 채널 `cliprdr`, `rdpdr`, `drive`, `rdpsnd`(rdpdr가 가짜 소리 장치를 함께 요구)를 켠다. 스크립트가 스탬프 파일(`.freerdp-channels-clip-drive-v2`)로 재빌드 여부를 판단하므로 그냥 다시 실행하면 FreeRDP가 다시 빌드된다.
2. **RDP 헬퍼 다시 빌드·링크** — `native/rdp-helper/src/main.c`에 cliprdr/rdpdr 코드가 들어갔다. `ConvertUtf8NToWCharAlloc`, `ConvertWCharNToUtf8Alloc`(winpr string.h)을 쓴다. 링크 오류가 나면 rdpsnd/drive 채널이 쓰는 Windows 시스템 라이브러리(`winmm`, `shlwapi` 등)를 `native/rdp-helper/CMakeLists.txt`(또는 `scripts/win/build-native.ps1`)의 링크 목록에 추가한다. macOS에서는 `CoreServices`·`AudioToolbox`·`CoreAudio`·`AVFoundation` 프레임워크를 추가해야 했다.
3. **node-pty** — 로컬 터미널용(`npm install`로 설치, 미리 빌드된 `prebuilds/win32-x64`를 쓰므로 컴파일러 불필요). `package.json`의 `asarUnpack`/`files` 설정이 이미 되어 있다. 설치 후 `npm run dist:win` 결과의 `resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/`에 `pty.node`, `conpty.node`, `conpty/`(OpenConsole.exe 등)가 있는지 확인한다.
4. **검증**: ① 로컬 터미널(Ctrl+Shift+T)에서 `cmd.exe`가 뜨고 `git --version`이 나오는지(Git for Windows가 PATH에 있어야 함), ② RDP 접속 폼에서 클립보드 공유로 양방향 복사·붙여넣기(Windows Server ↔ 로컬), ③ "로컬 폴더 마운트…"로 고른 폴더가 원격 탐색기의 "<폴더명> on <PC이름>" 드라이브로 보이고 파일을 열 수 있는지, ④ 세션 로그 탭에 SSH/로컬 터미널 기록이 쌓이는지.
