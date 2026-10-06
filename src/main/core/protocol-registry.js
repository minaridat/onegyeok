// 메인 프로세스 쪽 프로토콜 레지스트리 — src/renderer/core/registry.js와 같은 취지다.
// 새 프로토콜(VNC/SFTP/Web 등)의 IPC 핸들러를 추가할 때 이 파일은 건드리지 않고
// src/main/protocols/<proto>/index.js 하나만 만들어 registerMainProtocol(...)을
// 호출하면 된다. main.js는 그 폴더들을 require()하고 wireAll(ctx)/disconnectAllProtocols()만
// 호출하므로, 프로토콜별 파일을 서로 다른 git 워크트리에서 병렬로 수정해도 충돌이 거의 없다.
//
// def 계약:
//   wire(ctx)        — ctx.ipcMain으로 이 프로토콜의 ipcMain 핸들러를 등록한다.
//                       ctx.getMainWindow()는 BrowserWindow 인스턴스(또는 아직 없으면 null)를
//                       그때그때 조회하는 함수다 — createWindow() 호출 전에 wire()가 실행되므로
//                       mainWindow 값을 미리 캡처하면 안 되고, 호출 시점마다 getter로 조회해야 한다.
//   disconnectAll()  — 앱 종료 시 이 프로토콜의 모든 연결을 강제 종료한다.
const protocols = {};

function registerMainProtocol(name, def) {
  protocols[name] = def;
}

function wireAll(ctx) {
  Object.keys(protocols).forEach((name) => {
    if (protocols[name].wire) protocols[name].wire(ctx);
  });
}

function disconnectAllProtocols() {
  Object.keys(protocols).forEach((name) => {
    if (protocols[name].disconnectAll) protocols[name].disconnectAll();
  });
}

module.exports = { registerMainProtocol, wireAll, disconnectAllProtocols };
