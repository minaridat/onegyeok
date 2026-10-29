# 맥 작업 인계 — v0.1.18 dmg 다시 빌드

Windows 쪽에서 맥 인계분(#34 RDP 파일 복사, SFTP, 서버 목록 등)을 확인하면서 고친 것 중에 맥에도 해당하는 수정이 있다. `main`을 받아 맥 dmg를 다시 빌드하고 **v0.1.18 릴리스의 dmg를 교체**해 줘.

- 버전은 **0.1.18 그대로** 둔다. `package.json`도 이미 0.1.18이다.
- v0.1.18 릴리스의 Windows 설치 파일은 이 코드로 이미 교체했다(sha256 `ca3da0dd…41470c4cf0`).
- Windows 쪽 확인 기록은 `docs/QA.md`의 W18(입력)·W19(파일 복사)·W20(UI)에 있다.

## 1. 맥에도 해당하는 수정 (공용 코드)

1. **RDP 입력 (`src/renderer/protocols/rdp/rdp.js`)** — 사용자 제보 "타자가 두 번씩 쳐지고 마우스가 이상하게 움직임"
   - 같은 탭에서 다시 접속하면(연결 종료 → 접속, ↻ 재연결) 키보드·마우스 리스너가 또 붙어 키와 클릭이 2~3번씩 갔다. 이제 한 번만 붙는다.
   - 화면을 누른 채 밖에서 떼면 떼기가 안 가서 원격 버튼이 눌린 채로 남았다. 이제 화면 밖에서 떼도 떼기가 간다.
   - 키를 누른 채 포커스가 빠지면(⌘Tab 등) 원격에서 키가 눌린 채로 남았다. 이제 포커스를 잃으면 모두 뗀다.
   - 휠 방향이 반대였고 양도 틀렸다. 이제 위로 한 칸은 +120, 아래로 한 칸은 -120이 가고, 가로 휠도 보낸다.
2. **파일 복사 (`src/main/protocols/rdp/file-clipboard.js`)** — 받은 파일 이름 중 `CON`·`NUL`·`COM1` 같은 장치 이름은 앞에 `_`를 붙여 저장한다. 나머지 수정(Set-Clipboard 명령 실행 문제, 파일 목록 읽기)은 Windows 쪽 코드라 맥 동작은 그대로다.
3. **RDP 헬퍼 (`native/rdp-helper/src/clipboard.c`)**
   - 원격 파일 이름에 탭·줄바꿈 같은 제어 문자가 있으면 그 파일 목록은 받지 않는다.
   - `FILEDESCRIPTORW` 크기가 592바이트가 아니면 컴파일이 멈추게 검사를 넣었다(`filedescriptorw_size_check`).
   - **맥 빌드에서 여기서 컴파일 오류가 나면** winpr의 구조체 크기가 달라 파일 목록이 깨지는 상황이다. 검사를 지우지 말고 사용자에게 알린다.
4. **서버 목록 (`src/renderer/core/app-state.js`)** — "모든 연결 닫기" 확인 창에 내부 id 대신 서버 이름이 나온다.

## 2. 빌드 설정 고치기 (`package.json` `build.mac.files`)

지금 제외 패턴만 있다. electron-builder는 제외 패턴만 있는 목록을 "프로젝트 폴더 전체에서 이것만 빼기"로 받아들여서, `dist/`·`native/`·`build/` 같은 폴더가 app.asar에 들어갈 수 있다. Windows는 이것 때문에 설치 파일이 422MB가 돼서 `win.files`를 고쳤다.

`win.files`처럼 포함 패턴과 공통 제외 패턴을 같이 적는다:

```json
"files": [
  "src/**/*",
  "package.json",
  "!node_modules/node-pty/{deps,src,third_party,scripts}/**",
  "!node_modules/node-pty/prebuilds/*/*.pdb",
  "!node_modules/node-pty/prebuilds/win32-*/**",
  "!node_modules/node-pty/prebuilds/darwin-x64/**"
]
```

빌드한 뒤 `npx @electron/asar list <앱>/Contents/Resources/app.asar`에서 최상위가 `src`, `package.json`, `node_modules`만인지 확인한다.

## 3. 맥에서 확인할 것

1. RDP: 같은 탭에서 연결 종료 → 다시 접속한 뒤 타자를 쳤을 때 한 번씩만 입력되는지
2. RDP: 원격 창을 끌다가 앱 화면 밖에서 버튼을 뗐을 때 끌기가 끝나는지
3. RDP: 트랙패드·마우스 휠로 위아래·좌우 스크롤이 맞는 방향과 양으로 되는지. 맥 "자연스러운 스크롤" 설정과 맞는지, 스크롤 양이 너무 많거나 적지 않은지도 본다.
4. RDP: ⌘Tab으로 다른 앱에 갔다 왔을 때 원격에서 키가 눌린 채로 남지 않는지
5. 맥 → 원격, 원격 → 맥 파일 복사가 전처럼 되는지(#34 회귀 확인)

## 4. 마무리

- 결과는 `docs/QA.md` macOS 쪽에 적는다. 릴리스 기록의 v0.1.18 줄에는 dmg 교체 사실과 sha256을 덧붙인다.
- 새 dmg는 v0.1.18 릴리스의 `onegyeok-arm64.dmg`를 덮어쓴다(`gh release upload v0.1.18 onegyeok-arm64.dmg --clobber`). 릴리스 설명의 macOS 줄도 이번 수정이 들어갔다고 고친다. **올리기 전에 사용자에게 먼저 확인받는다.**
- 작업은 `minaridat/QA-mac`에서 하고 `minaridat/integration` → `main` 순서로 `--no-ff` 병합해서 푸시한다. 커밋 메시지는 한국어로 쓴다.
- 끝나면 이 파일의 맨 위에 "완료(날짜, 커밋)"를 적어 둔다.
