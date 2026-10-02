# SQL 기술 스택 — `mysql2` / `pg` / `mssql`

> 메인 기술 스택: [00_메인_기술스택.md](./00_메인_기술스택.md) · 기능 명세: [../기능명세/02_SQL_기능명세.md](../기능명세/02_SQL_기능명세.md)
> 상태: ✅ 적용됨 — `src/main/db-manager.js`

- 디비버 느낌의 "SQL" 연결 종류를 위해 엔진별 공식/표준 드라이버를 그대로 사용 — ORM이나 쿼리 빌더를 끼우지 않고 원시 SQL을 그대로 실행하는 게 목적(디비버처럼 사용자가 직접 쓴 쿼리를 실행)이라 추가 추상화 계층이 불필요하다고 판단.
  - **MySQL/MariaDB**: `mysql2/promise` — 콜백 기반 `mysql`보다 빠르고 Promise API 기본 제공.
  - **PostgreSQL**: `pg` — 사실상 표준 드라이버.
  - **MS SQL Server**: `mssql`(내부적으로 `tedious` 사용) — Windows 인증 없이 SQL 인증만 쓰는 환경이라 `tedious` 직접 사용 대신 더 간단한 API를 제공하는 `mssql`을 선택.
- `src/main/db-manager.js`에서 세 드라이버를 공통 어댑터 인터페이스(`connect/query/disconnect/classify/translate`)로 감싸, 렌더러·IPC 계층은 엔진 차이를 몰라도 되게 구성 — `ssh-manager.js`의 `classifySshError` 패턴을 그대로 재사용해 인증 실패(`kind:'auth'`)와 네트워크 오류(`kind:'network'`)를 구분한다.
- 비밀번호는 SSH와 동일한 원칙([공통 기능명세](../기능명세/00_공통_기능명세.md) F-601)으로 어디에도 저장하지 않는다 — IPC 호출 인자로만 전달되고 연결에만 쓰인다.
- 스키마 트리 탐색기, ER 다이어그램, 데이터 직접 편집, 쿼리 히스토리 등 디비버의 더 넓은 기능은 1차 범위에서 제외 — 쿼리 실행 + 결과 테이블까지가 현재 구현 범위([02_SQL_기능명세.md](../기능명세/02_SQL_기능명세.md) F-1203, 6절 범위 밖 참고).
- 서버가 먼저 연결을 끊는 경우(idle timeout 등)를 감지하기 위해 각 드라이버의 `error`/`end` 이벤트를 훅해 렌더러에 `db:status` 푸시로 알린다 — `ssh-manager.js`의 비동기 상태 푸시 패턴과 동일.
