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
      if(name==='connect' && args.length>=1) registerSessionWindow(args[0], windowForEvent(event));
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
  disconnectAll:manager.disconnectAll,
});
