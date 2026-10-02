// SSH 연결 관리자 (Phase1 F-201~F-213 핵심 구현)
//
// 보안 원칙(F-301/601): 비밀번호·Passphrase는 어디에도 저장하지 않는다.
// 이 모듈은 전달받은 자격증명을 연결에만 사용하고 보관하지 않으며,
// connect()가 반환하는 Promise가 끝나면 호출부(main.js)의 변수 스코프를 벗어나
// 더 이상 참조되지 않는다.
'use strict';

const { Client } = require('ssh2');
const fs = require('node:fs');

/** @type {Map<string, {client: import('ssh2').Client, stream: import('ssh2').ClientChannel}>} */
const sessions = new Map();

function isConnected(sessionId) {
  return sessions.has(sessionId);
}

/**
 * @param {string} sessionId 탭/세션을 식별하는 고유 id (서버 id와 동일하게 사용)
 * @param {object} params host, port, username, authMethod, password?, keyFilePath?, passphrase?, cols, rows
 * @param {(chunk: string) => void} onData 셸 출력 수신 콜백
 * @param {(status: {state: string, message?: string}) => void} onStatus 연결 상태 변화 콜백
 */
function connect(sessionId, params, onData, onStatus) {
  return new Promise((resolve, reject) => {
    if (sessions.has(sessionId)) {
      reject(new Error('이미 연결된 세션입니다'));
      return;
    }

    const client = new Client();
    const connectOpts = {
      host: params.host,
      port: params.port || 22,
      username: params.username,
      readyTimeout: 10000,
      keepaliveInterval: 15000,
    };

    if (params.authMethod === 'publickey') {
      try {
        connectOpts.privateKey = fs.readFileSync(params.keyFilePath);
      } catch (err) {
        reject(new Error('키 파일을 읽을 수 없습니다: ' + err.message));
        return;
      }
      if (params.passphrase) connectOpts.passphrase = params.passphrase;
    } else {
      connectOpts.password = params.password;
    }

    let settled = false;
    // ssh2는 인증 실패 시에도 'error' 다음에 'close'를 추가로 발생시킨다.
    // 'close'가 방금 보낸 에러 상태를 'disconnected'로 덮어쓰지 않도록 플래그로 가드한다.
    let errorReported = false;

    client
      .on('ready', () => {
        onStatus({ state: 'connected' });
        client.shell(
          { term: 'xterm-256color', cols: params.cols || 80, rows: params.rows || 24 },
          (err, stream) => {
            if (err) {
              errorReported = true;
              onStatus({ state: 'error', message: err.message });
              client.end();
              if (!settled) { settled = true; reject(err); }
              return;
            }
            sessions.set(sessionId, { client, stream });
            stream.on('data', (data) => onData(data.toString('utf8')));
            stream.stderr.on('data', (data) => onData(data.toString('utf8')));
            stream.on('close', () => {
              sessions.delete(sessionId);
              if (!errorReported) onStatus({ state: 'disconnected' });
            });
            // Phase1 F-205/206: 지정된 이름으로 tmux 세션을 attach(없으면 생성)한다.
            // 탭을 닫아도(클라이언트 연결만 종료) 서버 측 tmux 세션은 남아 재접속 시 이어진다.
            if (params.tmuxSessionName) {
              stream.write('tmux new -A -s ' + shellQuote(params.tmuxSessionName) + '\n');
            }
            if (!settled) { settled = true; resolve(); }
          }
        );
      })
      .on('error', (err) => {
        errorReported = true;
        sessions.delete(sessionId);
        onStatus({ state: 'error', message: translateSshError(err) });
        if (!settled) { settled = true; reject(err); }
      })
      .on('close', () => {
        sessions.delete(sessionId);
        if (!errorReported) onStatus({ state: 'disconnected' });
      });

    client.connect(connectOpts);
  });
}

// tmux 세션 이름을 원격 셸에 안전하게 전달하기 위한 최소 quoting (POSIX sh 기준).
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function translateSshError(err) {
  const msg = String(err && err.message || err);
  if (/all configured authentication methods failed/i.test(msg)) return '인증 실패 — 비밀번호 또는 키를 확인해주세요';
  if (/ECONNREFUSED/.test(msg)) return '연결 거부됨 — 호스트/포트를 확인해주세요';
  if (/ETIMEDOUT|Timed out/i.test(msg)) return '연결 시간 초과';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return '호스트를 찾을 수 없습니다';
  return msg;
}

function write(sessionId, data) {
  const s = sessions.get(sessionId);
  if (s) s.stream.write(data);
}

function resize(sessionId, cols, rows) {
  const s = sessions.get(sessionId);
  if (s) s.stream.setWindow(rows, cols, 0, 0);
}

function disconnect(sessionId) {
  const s = sessions.get(sessionId);
  if (s) {
    try { s.client.end(); } catch (_e) { /* noop */ }
    sessions.delete(sessionId);
  }
}

// Phase1 F-502: 앱 종료 시 모든 활성 연결을 예외 없이 강제 종료한다.
function disconnectAll() {
  for (const [id, s] of sessions) {
    try { s.client.end(); } catch (_e) { /* noop */ }
  }
  sessions.clear();
}

module.exports = { connect, write, resize, disconnect, disconnectAll, isConnected };
