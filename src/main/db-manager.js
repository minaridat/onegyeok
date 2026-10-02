// SQL DB 클라이언트 연결 관리자 (디비버 느낌의 "SQL" 연결 종류)
//
// 보안 원칙(F-301/601과 동일): 비밀번호는 어디에도 저장하지 않는다.
// 이 모듈은 전달받은 자격증명을 연결에만 사용하고 보관하지 않으며,
// connect()가 반환하는 Promise가 끝나면 호출부(main.js)의 변수 스코프를 벗어나
// 더 이상 참조되지 않는다.
'use strict';

const mysql = require('mysql2/promise');
const { Client: PgClient } = require('pg');
const mssql = require('mssql');

/** @type {Map<string, {engine: string, conn: any}>} */
const sessions = new Map();

function isConnected(sessionId) {
  return sessions.has(sessionId);
}

const ADAPTERS = {
  mysql: {
    async connect(params) {
      const conn = await mysql.createConnection({
        host: params.host,
        port: params.port || 3306,
        user: params.username,
        password: params.password,
        database: params.database || undefined,
        connectTimeout: 10000,
      });
      return conn;
    },
    async query(conn, sql) {
      const [rows, fields] = await conn.query(sql);
      if (Array.isArray(rows)) {
        const columns = (fields || []).map((f) => f.name);
        return { columns, rows, rowCount: rows.length };
      }
      // INSERT/UPDATE/DELETE 등은 rows가 OkPacket 형태로 온다.
      return { columns: [], rows: [], rowCount: rows.affectedRows || 0, message: 'affected rows: ' + (rows.affectedRows || 0) };
    },
    async disconnect(conn) {
      await conn.end();
    },
    onDisconnect(conn, cb) {
      conn.on('error', cb);
    },
    classify(err) {
      const msg = String((err && err.message) || err);
      const code = err && err.code;
      if (code === 'ER_ACCESS_DENIED_ERROR') return 'auth';
      if (code === 'ECONNREFUSED') return 'network';
      if (code === 'ETIMEDOUT' || code === 'PROTOCOL_CONNECTION_LOST') return 'network';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'network';
      if (code === 'ER_BAD_DB_ERROR') return 'other';
      return 'other';
    },
    translate(err) {
      const code = err && err.code;
      if (code === 'ER_ACCESS_DENIED_ERROR') return '인증 실패 — 사용자명 또는 비밀번호를 확인해주세요';
      if (code === 'ECONNREFUSED') return '연결 거부됨 — 호스트/포트를 확인해주세요';
      if (code === 'ETIMEDOUT') return '연결 시간 초과';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '호스트를 찾을 수 없습니다';
      if (code === 'ER_BAD_DB_ERROR') return '데이터베이스를 찾을 수 없습니다';
      return String((err && err.message) || err);
    },
  },
  postgres: {
    async connect(params) {
      const conn = new PgClient({
        host: params.host,
        port: params.port || 5432,
        user: params.username,
        password: params.password,
        database: params.database || undefined,
        connectionTimeoutMillis: 10000,
      });
      await conn.connect();
      return conn;
    },
    async query(conn, sql) {
      const res = await conn.query(sql);
      const columns = (res.fields || []).map((f) => f.name);
      return { columns, rows: res.rows, rowCount: res.rowCount };
    },
    async disconnect(conn) {
      await conn.end();
    },
    onDisconnect(conn, cb) {
      conn.on('error', cb);
      conn.on('end', cb);
    },
    classify(err) {
      const code = err && err.code;
      if (code === '28P01' || code === '28000') return 'auth';
      if (code === 'ECONNREFUSED') return 'network';
      if (code === 'ETIMEDOUT') return 'network';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'network';
      if (code === '3D000') return 'other';
      return 'other';
    },
    translate(err) {
      const code = err && err.code;
      if (code === '28P01' || code === '28000') return '인증 실패 — 사용자명 또는 비밀번호를 확인해주세요';
      if (code === 'ECONNREFUSED') return '연결 거부됨 — 호스트/포트를 확인해주세요';
      if (code === 'ETIMEDOUT') return '연결 시간 초과';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '호스트를 찾을 수 없습니다';
      if (code === '3D000') return '데이터베이스를 찾을 수 없습니다';
      return String((err && err.message) || err);
    },
  },
  mssql: {
    async connect(params) {
      const pool = new mssql.ConnectionPool({
        server: params.host,
        port: params.port || 1433,
        user: params.username,
        password: params.password,
        database: params.database || undefined,
        connectTimeout: 10000,
        options: { encrypt: false, trustServerCertificate: true },
      });
      await pool.connect();
      return pool;
    },
    async query(conn, sql) {
      const res = await conn.request().query(sql);
      const recordset = res.recordset || [];
      const columns = recordset.columns ? Object.keys(recordset.columns) : (recordset[0] ? Object.keys(recordset[0]) : []);
      return { columns, rows: recordset, rowCount: typeof res.rowsAffected?.[0] === 'number' ? res.rowsAffected[0] : recordset.length };
    },
    async disconnect(conn) {
      await conn.close();
    },
    onDisconnect(conn, cb) {
      conn.on('error', cb);
    },
    classify(err) {
      const msg = String((err && err.message) || err);
      if (/Login failed/i.test(msg)) return 'auth';
      if (/ECONNREFUSED/.test(msg)) return 'network';
      if (/ETIMEDOUT|Failed to connect/i.test(msg)) return 'network';
      if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'network';
      return 'other';
    },
    translate(err) {
      const msg = String((err && err.message) || err);
      if (/Login failed/i.test(msg)) return '인증 실패 — 사용자명 또는 비밀번호를 확인해주세요';
      if (/ECONNREFUSED/.test(msg)) return '연결 거부됨 — 호스트/포트를 확인해주세요';
      if (/ETIMEDOUT|Failed to connect/i.test(msg)) return '연결 시간 초과';
      if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return '호스트를 찾을 수 없습니다';
      return msg;
    },
  },
};

/**
 * @param {string} sessionId 탭(세션 인스턴스)마다 고유한 id
 * @param {object} params engine('mysql'|'postgres'|'mssql'), host, port, username, password, database
 * @param {(status: {state: string}) => void} [onStatus] 서버 측에서 먼저 끊었을 때(idle timeout 등) 알려주는 콜백
 */
async function connect(sessionId, params, onStatus) {
  if (sessions.has(sessionId)) {
    throw new Error('이미 연결된 세션입니다');
  }
  const adapter = ADAPTERS[params.engine];
  if (!adapter) throw new Error('지원하지 않는 DB 엔진입니다: ' + params.engine);

  try {
    const conn = await adapter.connect(params);
    sessions.set(sessionId, { engine: params.engine, conn });
    if (adapter.onDisconnect) {
      let notified = false;
      adapter.onDisconnect(conn, () => {
        if (notified) return;
        notified = true;
        if (sessions.has(sessionId)) {
          sessions.delete(sessionId);
          if (onStatus) onStatus({ state: 'disconnected' });
        }
      });
    }
    return { ok: true };
  } catch (err) {
    const kind = adapter.classify(err);
    const wrapped = new Error(adapter.translate(err));
    wrapped.kind = kind;
    throw wrapped;
  }
}

async function query(sessionId, sql) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('연결되어 있지 않습니다');
  const adapter = ADAPTERS[s.engine];
  const started = Date.now();
  try {
    const result = await adapter.query(s.conn, sql);
    return Object.assign({ durationMs: Date.now() - started }, result);
  } catch (err) {
    const wrapped = new Error(String((err && err.message) || err));
    wrapped.kind = 'query';
    throw wrapped;
  }
}

async function disconnect(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  try {
    await ADAPTERS[s.engine].disconnect(s.conn);
  } catch (_e) { /* noop */ }
}

// Phase1 F-502와 동일한 정책: 앱 종료 시 모든 활성 DB 연결을 예외 없이 강제 종료한다.
async function disconnectAll() {
  const ids = Array.from(sessions.keys());
  await Promise.all(ids.map((id) => disconnect(id)));
}

module.exports = { connect, query, disconnect, disconnectAll, isConnected };
