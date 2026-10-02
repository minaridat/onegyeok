const { contextBridge, ipcRenderer } = require('electron');

// 렌더러(웹 UI)에 노출하는 API는 여기서 화이트리스트 방식으로만 추가한다.
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
});
