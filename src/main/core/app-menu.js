// 앱 메뉴 — Electron 기본 메뉴를 쓰면 ⌘W(Windows는 Ctrl+W)가 "창 닫기"라서 탭 하나를 닫으려다 창 전체(앱)가 닫힌다.
// 그래서 기본 메뉴를 직접 구성하고, "탭 닫기"를 렌더러로 전달하는 항목을 둔다(그룹탭이면 렌더러가 확인 후 안의 세션까지 닫음).
//  - macOS: ⌘W
//  - Windows/Linux: Ctrl+Shift+W  (Ctrl+W는 터미널 셸의 "단어 지우기"라서 앱이 가로채지 않는다)
// 메뉴 가속키는 터미널(xterm)에 포커스가 있어도 먼저 처리된다.
const fs = require('node:fs');
const { app, Menu, BrowserWindow, shell } = require('electron');
const sessionLog = require('./session-log');

function sendCloseTab() {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) win.webContents.send('menu:close-tab');
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  template.push({
    label: '탭',
    submenu: [
      { id: 'close-tab', label: '탭 닫기', accelerator: isMac ? 'Cmd+W' : 'Ctrl+Shift+W', click: sendCloseTab },
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ],
  });
  template.push({
    label: '편집',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ],
  });
  template.push({
    label: '보기',
    submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
      // 개발 중에만 새로고침/개발자 도구(패키지된 앱에서 새로고침하면 열려 있는 화면 상태가 사라진다)
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
    ],
  });
  template.push({
    label: '도구',
    submenu: [
      // 터미널 세션 로그(core/session-log.js) — 바꾸면 다음에 여는 세션부터 적용된다.
      { label: '터미널 세션 로그 기록', type: 'checkbox', checked: sessionLog.isEnabled(), click: (item) => sessionLog.setEnabled(item.checked) },
      {
        label: '세션 로그 폴더 열기',
        click: () => {
          const dir = sessionLog.logDir();
          fs.mkdirSync(dir, { recursive: true });
          shell.openPath(dir);
        },
      },
    ],
  });
  template.push({
    label: '창',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])],
  });
  return Menu.buildFromTemplate(template);
}

function installAppMenu() {
  Menu.setApplicationMenu(buildAppMenu());
}

module.exports = { installAppMenu };
