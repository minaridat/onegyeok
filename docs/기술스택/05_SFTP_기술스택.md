# SFTP/FTP 기술 스택 — `ssh2-sftp-client` / `basic-ftp`

> 메인 기술 스택: [00_메인_기술스택.md](./00_메인_기술스택.md) · 기능 명세: [../기능명세/03_SFTP_기능명세.md](../기능명세/03_SFTP_기능명세.md)
> 상태: ✅ 파일 단위 전송 구현 (`minaridat/sql-ftp`, 2026-10-06)

- **SFTP**: `ssh2-sftp-client` — `ssh2`를 그대로 활용하므로 SSH 등록 정보(호스트/인증방식)를 재사용하기 쉽다([03_SFTP_기능명세.md](../기능명세/03_SFTP_기능명세.md) F-701).
- **FTP/FTPS**: `basic-ftp` — Promise 기반, FTPS(TLS) 지원. 순수 FTP는 평문이므로 기본값은 FTPS를 권장하고 평문 연결 시 경고를 띄운다(F-709).


## 구현 구조

- `src/main/file-manager.js`: SFTP/FTP/FTPS 연결, 로컬/원격 목록, 파일 관리, 직렬 전송 큐, 부분 파일 재개와 SHA-256 검증.
- `src/main/protocols/sftp/index.js`: 파일 IPC 핸들러 등록 및 메인 창 sender 검사.
- `src/preload/preload.js`: 명시적인 `files.*` API만 노출하고 IPC 이벤트 객체는 전달하지 않는다.
- `src/renderer/protocols/sftp/sftp.js`와 `sftp.css`: 접속 폼, 듀얼 패널, 검색·정렬, 전송 큐 및 등록 옵션.
- `protocol`은 기존 레지스트리의 `sftp`를 공유하며 `fileProtocol`으로 실제 전송 방식을 구분한다. 공통 탭 함수의 선택적 protocol override를 통해 SSH 등록 정보로 SFTP 탭을 연다.
- `basic-ftp`의 연결에서는 동시 명령이 불가능하므로 세션별 Promise 체인으로 탐색·파일 관리·전송을 직렬화한다.
- 중단된 SFTP 스트림의 종료 Promise가 끝나지 않는 경우에도 큐를 해제하도록 명시적 interrupt Promise와 전송 세대 번호를 사용한다. 재개 시 이전 연결/스트림을 재사용하지 않는다.
- FTPS는 `rejectUnauthorized: true`로 서버 인증서를 검증한다. 평문 FTP는 별도 사용자 확인이 필요하다.
- 재시도용 인증정보는 활성 세션 메모리에만 보관하며 디스크에 기록하지 않는다. 파일 전송도 앱 종료 시 레지스트리의 `disconnectAll()`로 연결을 정리한다.

라이브러리 근거: [basic-ftp 공식 API](https://github.com/patrickjuchli/basic-ftp), [ssh2-sftp-client 공식 API](https://github.com/theophilusx/ssh2-sftp-client).

검증 결과와 현재 제한은 [기능 명세 6~7절](../기능명세/03_SFTP_기능명세.md) 참고.
