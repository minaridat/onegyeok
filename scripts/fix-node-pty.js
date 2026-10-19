// npm이 설치 스크립트를 막는 환경(npm 11 기본값)에서는 node-pty의 post-install이 실행되지 않아, 미리 빌드된 spawn-helper에
// 실행 권한이 없다 — 로컬 터미널(macOS)이 "posix_spawnp failed"로 실패한다. 설치 직후 권한을 직접 준다.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  fs.readdirSync(root).forEach((dir) => {
    const helper = path.join(root, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  });
} catch (_e) { /* node-pty가 없으면(개발 의존성만 설치 등) 무시 */ }
