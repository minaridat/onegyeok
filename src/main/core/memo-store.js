const path = require('node:path');
const fs = require('node:fs/promises');

// 서버별 메모 저장 (Phase1 F-108)
// 기술스택_명세서.md 5장: 로그인 자격증명과 동일하게, 메모도 Electron safeStorage로
// OS 자격증명 저장소(macOS Keychain / Windows DPAPI 등) 기반 암호화 후 저장한다.
// 서버 목록 자체는 아직 영속화되지 않으므로(렌더러 메모리에만 존재), 메모는 서버 id를
// 키로 하는 별도 파일에 독립적으로 저장한다 — 서버 등록 데이터 영속화는 이후 과제.
// 특정 프로토콜 소유가 아니라 공용이므로 레지스트리를 쓰지 않고 main.js가 직접 한 번 wire()한다.

function memoStorePath(app) {
  return path.join(app.getPath('userData'), 'memos.json');
}

async function readMemoStore(app) {
  try {
    const raw = await fs.readFile(memoStorePath(app), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('[memo] 저장 파일을 읽지 못했습니다:', err);
    return {};
  }
}

async function writeMemoStore(app, store) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(memoStorePath(app), JSON.stringify(store), 'utf-8');
}

function wire(ctx) {
  const { ipcMain, app, safeStorage } = ctx;

  ipcMain.handle('memo:load-all', async () => {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[memo] 이 환경에서는 OS 암호화를 사용할 수 없어 메모를 불러오지 않습니다.');
      return {};
    }
    const store = await readMemoStore(app);
    const result = {};
    for (const [serverId, encodedB64] of Object.entries(store)) {
      try {
        result[serverId] = safeStorage.decryptString(Buffer.from(encodedB64, 'base64'));
      } catch (err) {
        console.error('[memo] 복호화 실패(건너뜀):', serverId, err.message);
      }
    }
    return result;
  });

  ipcMain.handle('memo:save', async (_event, serverId, text) => {
    if (!serverId) return { ok: false, error: 'invalid-server-id' };
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'encryption-unavailable' };
    }
    const store = await readMemoStore(app);
    if (text) {
      store[serverId] = safeStorage.encryptString(text).toString('base64');
    } else {
      delete store[serverId];
    }
    await writeMemoStore(app, store);
    return { ok: true };
  });

  ipcMain.handle('memo:rename', async (_event, oldServerId, newServerId) => {
    if (!oldServerId || !newServerId || oldServerId === newServerId) return { ok: true };
    const store = await readMemoStore(app);
    if (Object.prototype.hasOwnProperty.call(store, oldServerId)) {
      store[newServerId] = store[oldServerId];
      delete store[oldServerId];
      await writeMemoStore(app, store);
    }
    return { ok: true };
  });
}

module.exports = { wire };
