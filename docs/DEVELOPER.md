# 개발자 가이드

> [← README로 돌아가기](../README.md) · 소스에서 실행하거나 설치 파일을 직접 빌드하는 **개발자·배포 담당자용** 문서입니다.
> 일반 사용자는 README의 **Download / Install** 절만 보면 됩니다.

목차: [1. 소스에서 실행](#1-소스에서-실행) · [2. macOS 설치 파일 빌드](#2-macos-설치-파일dmg-직접-빌드) · [3. Windows 설치 파일 빌드](#3-windows-설치-파일exe-직접-빌드) · [기술 스택](#기술-스택) · [개발 문서](#개발-문서)

---

## 1. 소스에서 실행

### 공통 준비물

- [Node.js](https://nodejs.org/) 18 이상 (LTS 권장)
- [Git](https://git-scm.com/)
- **RDP/VNC를 쓰려면**: 네이티브 헬퍼(`libfreerdp`/`libvncclient` 직접 링크, 외부 서버·Docker 불필요)를
  한 번 빌드해야 합니다 — `npm install` 뒤 `npm run build:native` 실행(아래 참고). SSH/SQL/SFTP/Web은
  필요 없습니다. macOS는 `brew install freerdp libvncserver pkg-config`로 빌드 의존성을 먼저 설치하세요.
  (이 개발용 빌드는 Homebrew 라이브러리를 동적 링크하므로 배포용이 아닙니다 — 배포용은 아래 2·3번)

설치 여부 확인:

```bash
node -v
git --version
```

### macOS

```bash
# 1. Node.js가 없다면 Homebrew로 설치
brew install node

# 2. 저장소 클론 후 의존성 설치
git clone https://github.com/minaridat/onegyeok.git
cd onegyeok
npm install

# 3. RDP/VNC 네이티브 헬퍼 빌드(최초 1회 — 워크트리/클론마다 필요, 빌드 산출물은 git에 안 들어있음)
npm run build:native

# 4. 실행
npm start
```

### Windows

1. [nodejs.org](https://nodejs.org/)에서 LTS 버전 설치 프로그램을 받아 설치합니다 (설치 중 "Add to PATH" 체크).
2. [git-scm.com](https://git-scm.com/)에서 Git을 설치합니다.
3. PowerShell(또는 명령 프롬프트)을 열고:

```powershell
git clone https://github.com/minaridat/onegyeok.git
cd onegyeok
npm install
npm start
```

`npm start`를 실행하면 onegyeok 데스크톱 창이 뜹니다. SSH 접속 기능(`ssh2`)은 순수 JS/옵셔널 네이티브
모듈 구조라 별도 빌드 도구 없이 바로 동작합니다.


### 소스 구조

```bash
npm install
npm start
```

`src/renderer/`가 UI(서버 트리·탭·터미널·서버 관리), `src/main/`이 Electron 메인 프로세스(SSH 연결
관리·IPC), `src/preload/`가 렌더러에 노출하는 API 화이트리스트입니다. 콘솔에 렌더러 로그가 함께
출력됩니다(`npm start` 실행 중인 터미널 확인).

---

## 2. macOS 설치 파일(.dmg) 직접 빌드

Apple Silicon Mac에서 빌드합니다. 빌드 머신에만 아래 도구가 필요하고, 결과물(`.dmg`)을 받는 사용자 PC에는 필요 없습니다.

```bash
# 빌드 도구 (최초 1회)
brew install node cmake ninja pkgconf
xcode-select --install        # Xcode Command Line Tools가 없다면

git clone https://github.com/minaridat/onegyeok.git
cd onegyeok
npm install
npm run dist:mac              # 네이티브 헬퍼 정적 빌드 → electron-builder → dist/onegyeok-<버전>-arm64.dmg
                              # (배포: gh release create vX.Y.Z 로 .dmg를 'onegyeok-arm64.dmg' 이름으로 업로드)
```

- 첫 빌드는 OpenSSL·FreeRDP·libvncclient를 소스에서 컴파일해 **수 분~십수 분** 걸립니다(이후엔 캐시 사용:
  `build/mac-deps/`). 인터넷 연결이 필요합니다.
- 최소 macOS 버전은 15.0으로 고정됩니다(`package.json`의 `build.mac.minimumSystemVersion`,
  `scripts/mac/build-native-deps.sh`의 `MACOSX_DEPLOYMENT_TARGET`).
- 임시(ad-hoc) 서명만 하고 Apple 공증은 하지 않습니다(`mac.identity: "-"`) — 서명 정책이 정해지면 `package.json`의 `build.mac`을 채우세요. 서명을 아예 끄면(`null`) 다운로드한 앱이 "손상됨"으로 막힙니다.
- 자세한 설계·검증 범위는 [06_빌드배포_기술스택.md](./기술스택/06_빌드배포_기술스택.md) 참고.

---

## 3. Windows 설치 파일(.exe) 직접 빌드

Windows x64 PC에서 빌드합니다. 빌드 도구는 빌드 머신에만 필요합니다.

```powershell
# 빌드 도구 (최초 1회) — Visual Studio Build Tools는 "C++를 사용한 데스크톱 개발" 워크로드 + Windows SDK 선택
winget install Kitware.CMake Ninja-build.Ninja StrawberryPerl.StrawberryPerl NASM.NASM Git.Git OpenJS.NodeJS.LTS

git clone https://github.com/minaridat/onegyeok.git
cd onegyeok
npm install
node node_modules/electron/install.js   # npm 11이 설치 스크립트를 막으면 Electron 바이너리를 직접 받음
npm run dist:win              # 네이티브 헬퍼 정적 빌드 → electron-builder → dist/onegyeok-<버전>-x64.exe
                              # (배포: macOS dmg와 같은 릴리스에 'onegyeok-x64.exe' 이름으로 업로드)
```

- 첫 빌드는 OpenSSL·zlib·FreeRDP·libvncclient를 소스에서 MSVC로 정적 빌드해 **30분 안팎** 걸립니다(이후엔 캐시
  사용: `build/win-deps/`). 스크립트는 `scripts/win/`에 있습니다.
- 코드 서명은 하지 않습니다(SmartScreen 경고 발생). 인증서가 정해지면 `package.json`의 `build.win`에 서명 설정을 추가하세요.

---

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 앱 프레임워크 | Electron 44 (Chromium + Node.js), 번들러 없는 순수 JS 렌더러, `contextIsolation` + `sandbox` |
| SSH / 터미널 | `ssh2`(순수 JS), `@xterm/xterm` 6 + fit addon |
| SQL | `mysql2`(MySQL/MariaDB), `pg`(PostgreSQL), `mssql`(MS SQL Server) |
| SFTP / FTP / FTPS | `ssh2-sftp-client`, `basic-ftp` |
| RDP | **FreeRDP 3.32.1**(`libfreerdp3`)을 직접 링크한 C 네이티브 헬퍼 — 화면은 IPC로 `<canvas>`에 렌더링 |
| VNC | **LibVNCServer 0.9.15**(`libvncclient`)을 직접 링크한 C 네이티브 헬퍼 |
| Web | Electron `<webview>`(메모리 전용 파티션, 부착 검증·http(s)만 허용) |
| 저장소 / 암호화 | Electron `safeStorage`(OS 키체인) — 서버 목록 `servers.dat`, 메모 `memos.json` |
| 패키징 | `electron-builder` 26 → macOS arm64 `.dmg`(최소 macOS 15.0), Windows x64 NSIS `.exe` |
| 네이티브 빌드 | `clang` + `pkg-config` Makefile, 배포용은 OpenSSL 3.5 / FreeRDP / libvncclient를 `cmake`+`ninja`로 **정적 빌드**(`scripts/mac/build-native-deps.sh`), Windows는 MSVC `/MT` 정적 빌드(`scripts/win/`) |

선택 근거와 연결 종류별 상세는 [기술스택/](./기술스택/) 참고.

## 개발 문서

문서는 `docs/`에 모여 있고, 연결 종류(SSH/SQL/RDP/...)마다 기능 명세와 기술 스택을 각각 별도 파일로 분리해뒀다.

| 문서 | 내용 |
|---|---|
| [기획서.md](./기획서.md) | 전체 기획, 문제 정의, 로드맵, 보안 요구사항 |
| [기능명세/](./기능명세/) | 연결 종류별 기능 명세(00_공통, 01_SSH, 02_SQL, 03_SFTP, 04_터미널분할(대체됨), 05_RDP, 06_VNC, 07_Web, 08_스플릿뷰) — 목록·ID 대역표는 폴더의 README 참고 |
| [QA.md](./QA.md) | QA 항목 정리(증상·원인·조치·확인 방법, 남은 과제) |
| [기술스택/](./기술스택/) | 연결 종류별 라이브러리 선택 근거(00_메인, 01_SSH, 02_SQL, 03_RDP, 04_VNC, 05_SFTP, 06_빌드배포) |
