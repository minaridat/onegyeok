const { contextBridge, ipcRenderer } = require('electron');

// 렌더러(웹 UI)에 노출하는 API는 여기서 화이트리스트 방식으로만 추가한다.
// Phase1에서 서버 등록/SSH 연결 관련 IPC가 이 자리에 추가될 예정.
contextBridge.exposeInMainWorld('onegyeok', {
  ping: () => ipcRenderer.invoke('ping'),
  saveMemo: (serverId, text) => ipcRenderer.invoke('memo:save', serverId, text),
  loadMemos: () => ipcRenderer.invoke('memo:load-all'),
  renameMemo: (oldServerId, newServerId) => ipcRenderer.invoke('memo:rename', oldServerId, newServerId),
});
