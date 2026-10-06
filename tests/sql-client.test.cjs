const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const connections = [];
  let response = { fields: [{name:'value'}, {name:'value'}], rows:[[1,2]], rowCount:1 };
  let waitConnect;
  let waitQuery;
  class Connection extends EventEmitter {
    constructor() { super(); connections.push(this); this.closed = false; }
    async connect() { if(waitConnect) await waitConnect.promise; }
    async query(config) { this.queryConfig = config; if(waitQuery) await waitQuery.promise; return response; }
    async end() { this.closed = true; this.emit('end'); }
  }
  const exported = { exports:{} };
  const context = vm.createContext({require(name){
    if(name === 'pg') return {Client:Connection};
    if(name === 'mysql2/promise') return {async createConnection(){ const c = new Connection(); await c.connect(); return c; }};
    if(name === 'mssql') return {ConnectionPool:Connection};
    throw Error(name);
  }, module:exported, Date, Map, Promise});
  vm.runInContext(fs.readFileSync('src/main/db-manager.js','utf8'), context);
  return { manager:exported.exports, connections,
    response(value){response=value;}, connectWait(value){waitConnect=value;}, queryWait(value){waitQuery=value;} };
}
const params = {engine:'postgres',host:'localhost',username:'test'};

test('duplicate column names and all PostgreSQL result sets survive normalization', async () => {
  const f=fixture();
  f.response([{fields:[{name:'value'},{name:'value'}],rows:[[1,2]],rowCount:1}, {fields:[],rows:[],rowCount:3,command:'UPDATE'}]);
  await f.manager.connect('tab',params);
  const result=await f.manager.query('tab','SELECT 1, 2; UPDATE test SET value=1');
  assert.equal(result.results.length,2);
  assert.deepEqual(Array.from(result.results[0].rows[0]),[1,2]);
  assert.equal(result.results[1].rowCount,3);
  assert.equal(f.connections[0].queryConfig.rowMode,'array');
});

test('closing a tab while connecting disposes the late connection', async () => {
  const f=fixture(); const wait=deferred(); f.connectWait(wait);
  const pending=f.manager.connect('tab',params);
  await f.manager.disconnect('tab'); wait.resolve();
  await assert.rejects(pending,/취소/);
  assert.equal(f.manager.isConnected('tab'),false);
  assert.equal(f.connections[0].closed,true);
});

test('concurrent connects and queries are rejected, then execution recovers', async () => {
  const f=fixture(); const connectWait=deferred(); f.connectWait(connectWait);
  const pending=f.manager.connect('tab',params);
  await assert.rejects(f.manager.connect('tab',params),/이미 연결/);
  connectWait.resolve(); await pending;
  const wait=deferred(); f.queryWait(wait);
  const first=f.manager.query('tab','SELECT 1');
  await assert.rejects(f.manager.query('tab','SELECT 2'),/실행 중/);
  wait.resolve(); await first;
  await f.manager.query('tab','SELECT 3');
});

test('an old connection event cannot remove a reconnected session', async () => {
  const f=fixture(); await f.manager.connect('tab',params);
  const old=f.connections[0]; await f.manager.disconnect('tab');
  await f.manager.connect('tab',params); old.emit('error',new Error('late error'));
  assert.equal(f.manager.isConnected('tab'),true);
});

test('shutdown cancels pending connections and closes established sessions', async () => {
  const f=fixture(); await f.manager.connect('live',params);
  const wait=deferred(); f.connectWait(wait);
  const pending=f.manager.connect('pending',params);
  await f.manager.disconnectAll(); wait.resolve(); await assert.rejects(pending,/취소/);
  assert.ok(f.connections.every(c=>c.closed));
});
