const path = require('node:path');
const fs = require('node:fs/promises');

// 서버 목록 영속화 (F-602) — 호스트/IP/그룹 등 인프라 토폴로지만 저장한다. 비밀번호·passphrase는
// 어떤 형태로도 저장하지 않는다(F-601). 메모(memo-store.js)와 같은 방식으로 Electron safeStorage
// (macOS Keychain 등 OS 자격증명 저장소 기반) 암호화 후 userData/servers.dat에 쓴다.
// 마스터 패스워드 기반 KDF(F-602 원안)와 유휴 잠금(F-603)은 아직 없다 — OS 계정 단위로 보호된다.
// 특정 프로토콜 소유가 아니라 공용이므로 레지스트리를 쓰지 않고 main.js가 직접 한 번 wire()한다.

function storePath(app) {
  return path.join(app.getPath('userData'), 'servers.dat');
}

function wire(ctx) {
  const { ipcMain, app, safeStorage } = ctx;

  // 저장된 적이 없으면 null(첫 실행), 읽거나 복호화에 실패해도 null — 렌더러는 빈 목록으로 시작한다.
  ipcMain.handle('servers:load', async () => {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[servers] 이 환경에서는 OS 암호화를 사용할 수 없어 서버 목록을 불러오지 않습니다.');
      return null;
    }
    try {
      const raw = await fs.readFile(storePath(app));
      return JSON.parse(safeStorage.decryptString(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[servers] 서버 목록을 읽지 못했습니다:', err.message);
      return null;
    }
  });

  ipcMain.handle('servers:save', async (_event, data) => {
    if (!data || !Array.isArray(data.servers)) return { ok: false, error: 'invalid-data' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'encryption-unavailable' };
    const file = storePath(app);
    const tmp = file + '.tmp';
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(tmp, safeStorage.encryptString(JSON.stringify(data)));
    await fs.rename(tmp, file); // 쓰는 도중 종료돼도 기존 파일이 깨지지 않게 교체 방식으로 저장
    return { ok: true };
  });
}

module.exports = { wire };
