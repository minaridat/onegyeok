# SFTP/FTP 기술 스택 — `ssh2-sftp-client` / `basic-ftp`

> 메인 기술 스택: [00_메인_기술스택.md](./00_메인_기술스택.md) · 기능 명세: [../기능명세/03_SFTP_기능명세.md](../기능명세/03_SFTP_기능명세.md)
> 상태: 🔲 예정

- **SFTP**: `ssh2-sftp-client` — `ssh2`를 그대로 활용하므로 SSH 등록 정보(호스트/인증방식)를 재사용하기 쉽다([03_SFTP_기능명세.md](../기능명세/03_SFTP_기능명세.md) F-701).
- **FTP/FTPS**: `basic-ftp` — Promise 기반, FTPS(TLS) 지원. 순수 FTP는 평문이므로 기본값은 FTPS를 권장하고 평문 연결 시 경고를 띄운다(F-709).
