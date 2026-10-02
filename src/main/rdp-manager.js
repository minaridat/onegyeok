// RDP 연결 관리자 (Apache Guacamole 기반 — docs/기술스택/03_RDP_기술스택.md 참고)
//
// SSH/SQL과 달리 RDP는 onegyeok 프로세스 혼자서 말할 수 있는 프로토콜이 아니다 — 실제 RDP 핸드셰이크는
// 별도로 떠 있는 guacd 데몬이 담당하고, 이 모듈은 guacamole-lite로 로컬 WebSocket 서버를 하나 띄워
// guacd와 중계만 한다. 화면 스트림(바이너리) 자체는 이 모듈을 거치지 않는다 — 렌더러가 connect()가
// 돌려준 주소로 직접 WebSocket을 열어 받는다(IPC로 중계하면 느리고 무겁기 때문).
//
// 보안 원칙(F-601과 동일): 비밀번호는 토큰 암호화에만 쓰이고 어디에도 저장하지 않는다. 암호화 키도
// 앱 실행마다 메모리에서 새로 생성하며 디스크에 쓰지 않는다.
'use strict';

const crypto = require('node:crypto');
const GuacamoleLite = require('guacamole-lite');

const GUACD_HOST = '127.0.0.1';
const GUACD_PORT = 4822;
const CIPHER = 'AES-256-CBC';

let guacServer = null;
let serverReadyPromise = null;
let cryptKey = null;
const activeSessionIds = new Set();

function startServer() {
  if (serverReadyPromise) return serverReadyPromise;

  cryptKey = crypto.randomBytes(16).toString('hex'); // 32바이트(32 hex문자) — 메모리에만 존재

  serverReadyPromise = new Promise((resolve, reject) => {
    let settled = false;
    try {
      guacServer = new GuacamoleLite(
        { port: 0 },
        { host: GUACD_HOST, port: GUACD_PORT },
        { crypt: { cypher: CIPHER, key: cryptKey }, log: { level: 1 } } // level 1 = ERRORS만
      );
    } catch (err) {
      reject(err);
      return;
    }
    guacServer.webSocketServer.on('listening', () => {
      if (settled) return;
      settled = true;
      resolve(guacServer.webSocketServer.address().port);
    });
    guacServer.webSocketServer.on('error', (err) => {
      if (settled) return;
      settled = true;
      guacServer = null;
      serverReadyPromise = null;
      reject(err);
    });
  });

  return serverReadyPromise;
}

function encryptToken(payload) {
  // guacamole-lite@1.2.0의 ClientConnection.decryptToken()은 IV를 base64 디코드한 뒤
  // Buffer.toString('ascii')로 문자열화한다 — 'ascii'는 7비트라 상위 비트가 있는 바이트(0x80
  // 이상)는 매 바이트 손실되어 원래 IV와 달라지고, 그 결과 복호화가 거의 항상 "Token validation
  // failed"로 실패한다(라이브러리 자체의 버그 — value 필드는 손실 없는 'binary'로 디코드하면서
  // iv만 'ascii'를 씀). 실제 암호화 때 생성하는 IV를 7비트 범위(0~127)로만 제한하면 그 손실
  // 변환을 통과해도 원래 값이 그대로 보존된다 — 엔트로피가 128비트에서 112비트로 줄지만, 이
  // 토큰은 로컬에서만 쓰이는 1회용이라 그 정도로 충분하다.
  const iv = Buffer.from(crypto.randomBytes(16).map((b) => b & 0x7f));
  const cipher = crypto.createCipheriv(CIPHER, cryptKey, iv);
  let encrypted = cipher.update(JSON.stringify(payload), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const data = { iv: iv.toString('base64'), value: encrypted };
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

/**
 * @param {string} sessionId 탭(세션 인스턴스)마다 고유한 id
 * @param {object} params host, port, username, password, width, height
 */
async function connect(sessionId, params) {
  let port;
  try {
    port = await startServer();
  } catch (err) {
    const wrapped = new Error('원격 데스크톱 서비스(guacd)에 연결할 수 없습니다 — guacd가 실행 중인지 확인해주세요');
    wrapped.kind = 'guacd';
    throw wrapped;
  }

  const settings = {
    hostname: params.host,
    port: String(params.port || 3389),
    username: params.username,
    password: params.password,
    width: params.width || 1024,
    height: params.height || 768,
    'ignore-cert': true,
    security: 'any',
  };
  const token = encryptToken({ connection: { type: 'rdp', settings: settings } });
  activeSessionIds.add(sessionId);
  // wsBaseUrl에는 쿼리스트링을 붙이지 않는다 — Guacamole.WebSocketTunnel.connect(data)가
  // 내부적으로 `tunnelURL + "?" + data`로 자기 쿼리스트링을 붙이므로, 여기서 먼저 ?token=...을
  // 붙여두면 물음표가 두 번 들어가 토큰 값이 깨진다(렌더러가 client.connect()에 토큰을 넘긴다).
  return { wsBaseUrl: 'ws://127.0.0.1:' + port + '/', token: token };
}

// 실제 네트워크 연결 종료는 렌더러가 자신의 WebSocket을 닫는 것으로 처리된다(정상 흐름).
// 여기서는 세션 목록 북키핑만 한다.
function disconnect(sessionId) {
  activeSessionIds.delete(sessionId);
}

// Phase1 F-502: 앱 종료 시 모든 활성 RDP 연결을 예외 없이 강제 종료한다.
// 렌더러가 미처 정리하지 못했을 경우(강제 종료)를 대비해, 로컬 WS 서버 자체를 닫아
// 그 서버에 연결된 모든 클라이언트 연결을 한 번에 끊는다.
function disconnectAll() {
  activeSessionIds.clear();
  if (guacServer) {
    try { guacServer.close(); } catch (_e) { /* noop */ }
    guacServer = null;
    serverReadyPromise = null;
  }
}

module.exports = { connect, disconnect, disconnectAll };
