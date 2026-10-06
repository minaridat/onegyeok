# SFTP/FTP 기술 스택 — `ssh2-sftp-client` / `basic-ftp`

> 메인 기술 스택: [00_메인_기술스택.md](./00_메인_기술스택.md) · 기능 명세: [../기능명세/03_SFTP_기능명세.md](../기능명세/03_SFTP_기능명세.md)
> 상태: ✅ 파일·폴더 전송 / 비교·동기화 / 일괄 이름 변경 / 세션 예약 구현 (`minaridat/sql-ftp`, 2026-10-06)

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

## 폴더·동기화·이름 변경·예약 기술

추가 런타임 패키지 없이 기존 전송 라이브러리와 Node.js 표준 API로 구현한다.

| 기능 | 기술 / 파일 | 동작 |
|---|---|---|
| 폴더 재귀 전송 | `src/main/file-workflows.js`, `fs/promises`, POSIX/로컬 `path` | 목록 DFS, 빈 폴더 생성, 일반 파일을 기존 큐로 분해 |
| 비교·동기화 | 상대 경로 `Map`, 파일 크기·mtime | 미리보기 토큰, 5분 TTL, 실행 직전 스냅샷 재검사, 방향별 변경 파일 등록 |
| 수정일 보존 | 로컬 `fs.utimes`, ssh2 SFTP `utimes`, FTP `MFMT` | 부분 파일에 적용 후 최종 이름변경, 미지원 서버는 경고 |
| 일괄 이름 변경 | 문자열 `split/join`, 결과 이름 `Set`, `fs.rename` / 원격 `rename` | 리터럴 치환·접두사·접미사·순번, 충돌 검사, 순차 실행과 부분 실패 반환 |
| 예약 전송 | 메인 프로세스 `setTimeout`, 세션별 `Map` | 1회 예약, 최대 7일, 종료 시 `clearTimeout`, 실행 시 큐 등록 |
| UI | 기존 renderer DOM / CSS | 비교 표, 변경 미리보기, 예약 datetime-local 입력·상태·취소 |

- IPC/preload에 `preview`, `execute`, `recursive`, `renamePreview`, `reserve`, `cancelReservation`을 명시적으로 추가한다. 기존 sender 검사를 공유한다.
- 각 세션은 미리보기 최대 20개와 예약 최대 20개를 보관한다. 연결 종료 시 계획과 타이머를 제거한다. 계정 비밀번호나 예약을 디스크에 직렬화하지 않는다.
- 탐색 한 번당 최대 10,000항목·깊이 64로 제한한다. 심볼릭 링크를 따라가지 않고 `.onegyeok-*.part` 중간 파일을 제외한다. 대상 심볼릭 링크는 충돌로 처리한다.
- 동기화는 크기/수정일 기반의 한 방향 복사다. SHA-256은 선택형 전송 무결성 검증에만 사용하며 내용 비교·삭제 미러링·양방향 충돌 해결 엔진은 포함하지 않는다.
- 임의 정규식은 실행하지 않는다. 현재 UI는 리터럴 치환을 제공하며 정규식이 필요하면 실행 시간 제한 또는 선형 시간 정규식 엔진을 별도로 검토한다.
- 예약은 프로세스 내 타이머라 OS 작업 스케줄러/cron에 의존하지 않는다. 앱 미실행 예약·반복 실행·예약 영속화를 도입하려면 자격증명 보관 정책과 별도 백그라운드 실행 설계가 필요하다.
- 통신 명령은 기존 세션별 Promise 체인으로 직렬화한다. 폴더 계획·이름 변경 전체가 원자적 트랜잭션인 것은 아니며 서버/파일시스템 외부 변경에 대한 잠금은 제공하지 않는다.
