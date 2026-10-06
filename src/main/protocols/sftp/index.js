const manager = require('../../file-manager');
const { registerMainProtocol } = require('../../core/protocol-registry');
registerMainProtocol('sftp', {
  wire({ipcMain,getMainWindow}) {
    const handle=(name,fn)=>ipcMain.handle('files:'+name,async(event,...args)=>{
      if(event.sender !== getMainWindow()?.webContents) return {ok:false,error:'허용되지 않은 요청입니다'};
      try {return {ok:true,data:await fn(...args)};} catch(err){return {ok:false,error:err.message};}
    });
    handle('connect',(id,params)=>manager.connect(id,params,(type,data)=>{
      const win=getMainWindow();if(win && !win.isDestroyed()) win.webContents.send('files:event',id,type,data);
    }));
    handle('local-list',manager.localList);
    handle('list',manager.list);
    handle('operation',manager.operation);
    handle('enqueue',manager.enqueue);
    handle('control',manager.control);
    for(const name of ['preview','execute','recursive','renamePreview','reserve','cancelReservation'])handle(name,manager[name]);
    handle('disconnect',manager.disconnect);
  },
  disconnectAll:manager.disconnectAll,
});
