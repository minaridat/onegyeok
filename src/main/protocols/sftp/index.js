const { BrowserWindow } = require('electron');
const manager = require('../../file-manager');
const { registerMainProtocol } = require('../../core/protocol-registry');
registerMainProtocol('sftp', {
  wire({ipcMain,sendToSession,registerSessionWindow,unregisterSession,windowForEvent}) {
    // event.sender를 "그 메인 창"과 직접 비교하던 예전 체크는 창이 하나뿐일 때만 맞는 가정이었다
    // — 우리 앱의 어느 최상위 창에서 왔든(BrowserWindow.fromWebContents가 null이 아니면) 허용하고,
    // <webview> 게스트처럼 우리 창이 아닌 컨텍스트에서 온 요청만 막는다.
    const handle=(name,fn)=>ipcMain.handle('files:'+name,async(event,...args)=>{
      if(!BrowserWindow.fromWebContents(event.sender)) return {ok:false,error:'허용되지 않은 요청입니다'};
      if(name==='connect' && args.length>=1) registerSessionWindow(args[0], windowForEvent(event), 'sftp');
      try {return {ok:true,data:await fn(...args)};} catch(err){return {ok:false,error:err.message};}
    });
    handle('connect',(id,params)=>manager.connect(id,params,(type,data)=>{
      sendToSession(id,'files:event',type,data);
    }));
    handle('local-list',manager.localList);
    handle('list',manager.list);
    handle('operation',manager.operation);
    handle('enqueue',manager.enqueue);
    handle('control',manager.control);
    for(const name of ['preview','execute','recursive','renamePreview','reserve','cancelReservation'])handle(name,manager[name]);
    handle('disconnect',(id)=>{ unregisterSession(id); return manager.disconnect(id); });
  },
  // SFTP는 Stage B(탭 분리/병합)에서 "끊고 새로 로그인" 수준(Tier 2)만 지원한다 — 파일 목록/전송
  // 큐 같은 복잡한 상태를 창 이동으로 이어주는 건 범위 밖. onSessionWindowChanged를 정의하지
  // 않으면 window-manager.js가 그냥 아무것도 안 하고 넘어간다. disconnectSession은 보조 창을
  // 닫을 때 그 창이 들고 있던 SFTP 세션을 정리하는 데 쓰인다.
  disconnectSession(sessionId) {
    manager.disconnect(sessionId);
  },
  disconnectAll:manager.disconnectAll,
});
