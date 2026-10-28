const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerMainProtocol } = require('../../core/protocol-registry');
const sessionLog = require('../../core/session-log');

// 로컬 터미널 — 이 PC의 셸(cmd, PowerShell, Git Bash, WSL / macOS는 zsh·bash)을 앱 탭 안에서 연다. git 같은 로컬 도구를 앱을
// 벗어나지 않고 쓰기 위한 것이다. node-pty(ConPTY)로 진짜 콘솔을 만들어 xterm.js에 잇는다 — 그냥 child_process로 띄우면
// 프롬프트·방향키·색상·vim 같은 대화형 프로그램이 동작하지 않는다.
let pty = null;
function loadPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

const sessions = new Map(); // sessionId -> IPty
let savedCtx = null;

function exists(p) { try { return fs.statSync(p).isFile(); } catch (_e) { return false; } }

// PATH에서 실행 파일 찾기(Windows는 확장자 포함으로 넘긴다)
function which(exe) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && exists(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

// Git for Windows의 bash.exe — 기본 설치 위치를 먼저 보고, 없으면 PATH의 git.exe 위치(…\Git\cmd\git.exe)에서 찾아 올라간다.
function findGitBash() {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  for (const r of roots) if (r && exists(path.join(r, 'Git', 'bin', 'bash.exe'))) return path.join(r, 'Git', 'bin', 'bash.exe');
  const git = which('git.exe');
  if (git) {
    const candidate = path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe');
    if (exists(candidate)) return candidate;
  }
  return null;
}

// 이 PC에서 쓸 수 있는 셸 목록 — 첫 항목이 기본값.
function detectShells() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const list = [];
    const ps = path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(ps)) list.push({ id: 'powershell', label: 'PowerShell', file: ps, args: ['-NoLogo'] });
    const pwsh = which('pwsh.exe');
    if (pwsh) list.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'] });
    list.push({ id: 'cmd', label: '명령 프롬프트(cmd)', file: process.env.ComSpec || path.join(sys, 'cmd.exe'), args: [] });
    const bash = findGitBash();
    if (bash) list.push({ id: 'gitbash', label: 'Git Bash', file: bash, args: ['--login', '-i'] });
    const wsl = path.join(sys, 'wsl.exe');
    if (exists(wsl)) list.push({ id: 'wsl', label: 'WSL', file: wsl, args: [] });
    return list;
  }
  const list = [];
  const userShell = process.env.SHELL;
  if (userShell && exists(userShell)) list.push({ id: path.basename(userShell), label: path.basename(userShell), file: userShell, args: ['-l'] });
  for (const p of ['/bin/zsh', '/bin/bash']) {
    if (exists(p) && !list.some((s) => s.file === p)) list.push({ id: path.basename(p), label: path.basename(p), file: p, args: ['-l'] });
  }
  return list;
}

// Windows 설치 파일에 같이 넣은 git(MinGit, scripts/win/fetch-mingit.ps1) — 설치본은 resources/git, 개발 실행은 build/win-git/mingit.
function bundledGitCmdDir() {
  if (process.platform !== 'win32') return null;
  const roots = [process.resourcesPath && path.join(process.resourcesPath, 'git'), path.join(__dirname, '..', '..', '..', '..', 'build', 'win-git', 'mingit')];
  for (const r of roots) if (r && exists(path.join(r, 'cmd', 'git.exe'))) return path.join(r, 'cmd');
  return null;
}

// 로컬 셸에 넘길 환경 — 같이 넣은 git을 PATH 맨 뒤에 붙인다(PC에 직접 설치한 git이 있으면 그쪽이 먼저 잡힌다).
// Windows 환경 변수 이름은 대소문자를 가리지 않아 복사본에는 "Path"로 들어 있을 수 있으니, 있는 키에 붙인다(PATH를 새로 만들면 둘이 겹친다).
function shellEnv() {
  const env = Object.assign({}, process.env, { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  const gitCmd = bundledGitCmdDir();
  if (gitCmd) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[key] = (env[key] ? env[key] + path.delimiter : '') + gitCmd;
  }
  return env;
}

// git을 쓸 수 있는지(PC에 설치됐거나 같이 넣은 git이 있는지) — 없으면 렌더러가 설치 안내를 보여준다.
function hasGit() {
  return !!which(process.platform === 'win32' ? 'git.exe' : 'git') || (process.platform === 'win32' && (!!findGitBash() || !!bundledGitCmdDir()));
}

function stopSession(sessionId) {
  const p = sessions.get(sessionId);
  if (!p) return;
  sessions.delete(sessionId);
  try { p.kill(); } catch (_e) { /* 이미 종료 */ }
  sessionLog.close(sessionId);
}

registerMainProtocol('local', {
  wire(ctx) {
    savedCtx = ctx;
    const { ipcMain, sendToSession, registerSessionWindow, unregisterSession, windowForEvent } = ctx;

    ipcMain.handle('local:shells', () => ({
      shells: detectShells().map((s) => ({ id: s.id, label: s.label })),
      hasGit: hasGit(),
    }));

    ipcMain.handle('local:spawn', (event, sessionId, params) => {
      stopSession(sessionId);
      const shells = detectShells();
      const shell = shells.find((s) => s.id === params.shell) || shells[0];
      if (!shell) return { ok: false, error: '사용할 수 있는 셸이 없습니다' };
      registerSessionWindow(sessionId, windowForEvent(event), 'local');
      let p;
      try {
        p = loadPty().spawn(shell.file, shell.args, {
          name: 'xterm-256color',
          cols: params.cols || 80,
          rows: params.rows || 24,
          cwd: os.homedir(),
          env: shellEnv(),
        });
      } catch (err) {
        unregisterSession(sessionId);
        return { ok: false, error: '셸을 시작할 수 없습니다: ' + err.message };
      }
      sessions.set(sessionId, p);
      sessionLog.open(sessionId, { protocol: 'local', name: params.serverName || shell.label, host: os.hostname(), rows: params.rows || 24 });
      p.onData((data) => {
        sendToSession(sessionId, 'local:data', data);
        sessionLog.write(sessionId, data);
      });
      p.onExit(({ exitCode }) => {
        if (sessions.get(sessionId) !== p) return; // 이미 다른 셸로 교체됨
        sessions.delete(sessionId);
        sessionLog.close(sessionId);
        sendToSession(sessionId, 'local:status', { state: 'disconnected', exitCode });
        unregisterSession(sessionId);
      });
      sendToSession(sessionId, 'local:status', { state: 'connected', shell: shell.label });
      return { ok: true, shell: shell.label };
    });

    ipcMain.on('local:input', (_event, sessionId, data) => {
      const p = sessions.get(sessionId);
      if (p) p.write(data);
    });
    ipcMain.on('local:resize', (_event, sessionId, cols, rows) => {
      const p = sessions.get(sessionId);
      // 크기가 같으면 넘긴다 — ConPTY는 resize마다 화면 전체를 다시 그려 보내 같은 내용이 세션 로그에 두 번 남는다.
      if (!p || !(cols > 0 && rows > 0) || (p.cols === cols && p.rows === rows)) return;
      try { p.resize(cols, rows); } catch (_e) { /* 종료 직후 */ }
      sessionLog.resize(sessionId, rows);
    });
    ipcMain.handle('local:kill', (_event, sessionId) => {
      stopSession(sessionId);
      unregisterSession(sessionId);
      return { ok: true };
    });
  },

  // 탭이 다른 창으로 옮겨질 때 — 셸은 그대로 두고 마지막 상태만 새 창에 다시 보낸다(ssh와 같음).
  onSessionWindowChanged(sessionId, newWin) {
    if (savedCtx) savedCtx.replayLastSend(sessionId, 'local:status', newWin);
  },

  disconnectSession(sessionId) { stopSession(sessionId); },

  disconnectAll() { Array.from(sessions.keys()).forEach(stopSession); },
});
