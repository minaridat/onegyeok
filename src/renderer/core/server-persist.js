// 서버 목록 영속화(F-602) — 서버 레코드/그룹 순서/접힌 그룹을 main의 servers:* IPC로 저장·복원한다.
// 비밀번호 등 인증정보는 애초에 SERVERS에 없고(F-601), 런타임 상태(status/since/auth)와 메모(memo —
// 별도 memo-store가 저장)는 저장 대상에서 뺀다. 변경 감지는 직렬화 문자열 비교로 하므로 렌더만 다시 한
// 경우나 다른 창이 읽기만 한 경우에는 디스크에 쓰지 않는다.
var hasServerBridge = !!(window.onegyeok && window.onegyeok.servers);
var serverPersistReady = false;   // 초기 로드가 끝나기 전에는 빈 목록으로 디스크를 덮어쓰지 않는다
var lastPersistedJson = '';
var persistTimer = null;
var NON_PERSISTED_SERVER_FIELDS = ['status', 'since', 'auth', 'memo'];

function serializeServerState(){
  return JSON.stringify({
    version: 1,
    servers: SERVERS.filter(function(s){ return !s.temp; }).map(function(s){
      var copy = {};
      Object.keys(s).forEach(function(k){
        if(NON_PERSISTED_SERVER_FIELDS.indexOf(k) === -1) copy[k] = s[k];
      });
      return copy;
    }),
    groupOrder: GROUP_ORDER.filter(function(g){ return g !== QUICK_GROUP; }),
    collapsed: Array.from(collapsedGroups).filter(function(g){ return g !== QUICK_GROUP; }).sort()
  });
}

function persistServersNow(){
  persistTimer = null;
  if(!hasServerBridge || !serverPersistReady) return;
  var json = serializeServerState();
  if(json === lastPersistedJson) return;
  lastPersistedJson = json;
  window.onegyeok.servers.save(JSON.parse(json)).then(function(res){
    if(!res || !res.ok){
      lastPersistedJson = ''; // 다음 변경 때 재시도
      console.error('[servers] 저장 실패', res && res.error);
    }
  }).catch(function(err){
    lastPersistedJson = '';
    console.error('[servers] 저장 실패', err);
  });
}

function schedulePersistServers(){
  if(!hasServerBridge || !serverPersistReady) return;
  if(persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistServersNow, 200);
}

// 저장된 목록을 SERVERS/GROUP_ORDER/collapsedGroups에 채운다. 항상 resolve(저장 파일이 없거나 깨져도 빈 목록으로 진행).
function loadPersistedServers(){
  if(!hasServerBridge){ serverPersistReady = true; return Promise.resolve(); }
  return window.onegyeok.servers.load().then(function(data){
    if(data && Array.isArray(data.servers)){
      SERVERS = data.servers.map(function(s){
        s.status = 'off';
        s.since = '연결 안 됨';
        s.auth = authLabel(s);
        return s;
      });
      GROUP_ORDER = Array.isArray(data.groupOrder) ? data.groupOrder.slice() : [];
      SERVERS.forEach(function(s){ if(GROUP_ORDER.indexOf(s.group) === -1) GROUP_ORDER.push(s.group); });
      collapsedGroups = new Set(Array.isArray(data.collapsed) ? data.collapsed : []);
    }
  }).catch(function(err){
    console.error('[servers] 불러오기 실패 — 빈 목록으로 시작', err);
  }).then(function(){
    lastPersistedJson = serializeServerState();
    serverPersistReady = true;
  });
}

window.addEventListener('beforeunload', function(){ if(persistTimer) persistServersNow(); });
