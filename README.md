# onegyeok
onegyeok(ssh rdp vnc Let's go~!)

SSH/RDP/VNC/SFTP/Web 통합 원격 접속 클라이언트. 기획/스펙 문서는 [기획서.md](./기획서.md),
[Phase1_기능명세서.md](./Phase1_기능명세서.md), [Phase2-5_기능명세서.md](./Phase2-5_기능명세서.md) 참고.

## 개발 실행

```bash
npm install
npm start
```

Electron 데스크톱 앱 창이 뜬다. `src/renderer/`가 현재 UI(서버 트리·탭·서버 관리·보안 정책 반영)이고,
`src/main/`·`src/preload/`는 아직 비어 있는 뼈대(IPC ping 테스트만 연결됨) — SSH 연결 등 실제 프로토콜
구현은 다음 단계.
