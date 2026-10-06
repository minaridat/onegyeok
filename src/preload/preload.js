const { contextBridge, ipcRenderer } = require('electron');

// 렌더러(웹 UI)에 노출하는 API는 여기서 화이트리스트 방식으로만 추가한다.
//
// NOTE: 이 파일은 의도적으로 분할하지 않은 단일 파일이다 — Electron의 sandbox:true 프리로드는
// 전용 모듈 로더를 쓰며 'electron' 외에는 로컬 상대경로 require든 node: 내장 모듈(예: node:path)
// 이든 전혀 지원하지 않는다(직접 확인: require('./core.js'), require(path.join(__dirname,...)),
// require('node:path') 모두 "module not found"로 실패). 번들러 없이 여러 파일로 쪼개 로드할
// 방법이 없으므로, sandbox를 끄지 않는 한(보안상 금지) preload는 한 파일로 유지해야 한다.
// main 프로세스(src/main/protocols/*)와 renderer(src/renderer/protocols/*)는 이런 제약이
// 없어 정상적으로 기능별 분할이 끝났다.
contextBridge.exposeInMainWorld('onegyeok', {
  ping: () => ipcRenderer.invoke('ping'),

  saveMemo: (serverId, text) => ipcRenderer.invoke('memo:save', serverId, text),
  loadMemos: () => ipcRenderer.invoke('memo:load-all'),
  renameMemo: (oldServerId, newServerId) => ipcRenderer.invoke('memo:rename', oldServerId, newServerId),

  pickKeyFile: () => ipcRenderer.invoke('dialog:pick-key-file'),

  ssh: {
    connect: (sessionId, params) => ipcRenderer.invoke('ssh:connect', sessionId, params),
    input: (sessionId, data) => ipcRenderer.send('ssh:input', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    disconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    // IpcRendererEvent 객체는 렌더러로 그대로 넘기지 않고 payload만 전달한다.
    onData: (callback) => {
      const listener = (_event, sessionId, chunk) => callback(sessionId, chunk);
      ipcRenderer.on('ssh:data', listener);
      return () => ipcRenderer.removeListener('ssh:data', listener);
    },
    onStatus: (callback) => {
      const listener = (_event, sessionId, status) => callback(sessionId, status);
      ipcRenderer.on('ssh:status', listener);
      return () => ipcRenderer.removeListener('ssh:status', listener);
    },
  },

  db: {
    connect: (sessionId, params) => ipcRenderer.invoke('db:connect', sessionId, params),
    query: (sessionId, sql) => ipcRenderer.invoke('db:query', sessionId, sql),
    disconnect: (sessionId) => ipcRenderer.invoke('db:disconnect', sessionId),
    onStatus: (callback) => {
      const listener = (_event, sessionId, status) => callback(sessionId, status);
      ipcRenderer.on('db:status', listener);
      return () => ipcRenderer.removeListener('db:status', listener);
    },
  },

  files: {
    connect: (id, params) => ipcRenderer.invoke('files:connect', id, params),
    localList: (directory) => ipcRenderer.invoke('files:local-list', directory),
    list: (id, directory) => ipcRenderer.invoke('files:list', id, directory),
    operation: (id, action, target, value) => ipcRenderer.invoke('files:operation', id, action, target, value),
    preview: (id, params) => ipcRenderer.invoke('files:preview', id, params),
    execute: (id, token) => ipcRenderer.invoke('files:execute', id, token),
    recursive: (id, params) => ipcRenderer.invoke('files:recursive', id, params),
    renamePreview: (id, params) => ipcRenderer.invoke('files:renamePreview', id, params),
    reserve: (id, params) => ipcRenderer.invoke('files:reserve', id, params),
    cancelReservation: (id, key) => ipcRenderer.invoke('files:cancelReservation', id, key),
    enqueue: (id, params) => ipcRenderer.invoke('files:enqueue', id, params),
    control: (id, jobId, action) => ipcRenderer.invoke('files:control', id, jobId, action),
    disconnect: (id) => ipcRenderer.invoke('files:disconnect', id),
    onEvent: (callback) => {
      const listener = (_event, id, type, data) => callback(id, type, data);
      ipcRenderer.on('files:event', listener);
      return () => ipcRenderer.removeListener('files:event', listener);
    },
  },

  web: {
    openExternal: (url) => ipcRenderer.invoke('web:open-external', url),
    trustCert: (webContentsId, url) => ipcRenderer.invoke('web:trust-cert', webContentsId, url),
  },

  rdp: {
    connect: (sessionId, params) => ipcRenderer.invoke('rdp:connect', sessionId, params),
    disconnect: (sessionId) => ipcRenderer.invoke('rdp:disconnect', sessionId),
    mouse: (sessionId, x, y, flags) => ipcRenderer.send('rdp:mouse', sessionId, x, y, flags),
    key: (sessionId, scancode, flags) => ipcRenderer.send('rdp:key', sessionId, scancode, flags),
    resize: (sessionId, width, height) => ipcRenderer.send('rdp:resize', sessionId, width, height),
    onFrame: (callback) => {
      const listener = (_event, sessionId, rect, buffer) => callback(sessionId, rect, buffer);
      ipcRenderer.on('rdp:frame', listener);
      return () => ipcRenderer.removeListener('rdp:frame', listener);
    },
    onStatus: (callback) => {
      const listener = (_event, sessionId, status) => callback(sessionId, status);
      ipcRenderer.on('rdp:status', listener);
      return () => ipcRenderer.removeListener('rdp:status', listener);
    },
  },

  // 탭을 끌어서 별도 창으로 분리/병합하는 기능(Stage B) — src/main/core/window-manager.js.
  window: {
    getInitialState: () => ipcRenderer.invoke('window:getInitialState'),
    detachTab: (payload) => ipcRenderer.invoke('window:detachTab', payload),
    mergeTab: (payload) => ipcRenderer.invoke('window:mergeTab', payload),
    isPointInAnotherWindow: (screenX, screenY) => ipcRenderer.invoke('window:isPointInAnotherWindow', screenX, screenY),
    onTabDetached: (callback) => {
      const listener = (_event, tabId) => callback(tabId);
      ipcRenderer.on('window:tabDetached', listener);
      return () => ipcRenderer.removeListener('window:tabDetached', listener);
    },
    onTabAttached: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('window:tabAttached', listener);
      return () => ipcRenderer.removeListener('window:tabAttached', listener);
    },
  },

  vnc: {
    connect: (sessionId, params) => ipcRenderer.invoke('vnc:connect', sessionId, params),
    disconnect: (sessionId) => ipcRenderer.invoke('vnc:disconnect', sessionId),
    mouse: (sessionId, x, y, buttonMask) => ipcRenderer.send('vnc:mouse', sessionId, x, y, buttonMask),
    key: (sessionId, keysym, down) => ipcRenderer.send('vnc:key', sessionId, keysym, down),
    onFrame: (callback) => {
      const listener = (_event, sessionId, rect, buffer) => callback(sessionId, rect, buffer);
      ipcRenderer.on('vnc:frame', listener);
      return () => ipcRenderer.removeListener('vnc:frame', listener);
    },
    onStatus: (callback) => {
      const listener = (_event, sessionId, status) => callback(sessionId, status);
      ipcRenderer.on('vnc:status', listener);
      return () => ipcRenderer.removeListener('vnc:status', listener);
    },
  },
});
