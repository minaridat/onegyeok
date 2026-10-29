'use strict';

// RDP 파일 복사·붙여넣기(클립보드의 파일) — 로컬 클립보드의 파일 목록 읽기/쓰기, 보낼 목록 만들기, 원격에서 받은 파일을 임시 폴더에 쓰기.
// 헬퍼와는 clipboard.c의 MSG_CLIP_FILES / MSG_REMOTE_FILES_* 프레임으로 주고받는다(자세한 형식은 거기 주석).
//
// 보안: 원격이 보낸 경로는 신뢰하지 않는다 — 각 경로 요소를 정리하고(.., 절대 경로, 드라이브 문자 제거) 임시 폴더 밖으로 나가지 못하게 막는다.
// 받은 파일은 세션 전용 임시 폴더에만 쓰고, 세션이 끝나거나 새 복사를 받으면 지운다. 총 크기·개수 상한은 헬퍼가 적용한다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clipboard } = require('electron');
const { execFile } = require('node:child_process');
const { fileURLToPath } = require('node:url');

const MAX_SEND_ENTRIES = 2000; // 로컬 → 원격으로 알릴 항목(폴더 포함) 상한
const MAX_DEPTH = 12;

function xmlDecode(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Electron 44의 clipboard에는 readBuffer/writeBuffer가 없다 — 대신 플랫폼 원본 형식을 `electron application/osclipboard;format="…"` 이름으로
// has()/read()의 getType()에서 읽을 수 있다. 파일이 올라와 있는지는 has()로 값싸게 먼저 확인한다.
const raw = (format) => 'electron application/osclipboard;format="' + format + '"';

async function readItemBlob(type) {
  const items = await clipboard.read();
  for (const it of items) {
    if (it.types.includes(type)) return it.getType(type);
  }
  return null;
}
async function readItemText(type) {
  const blob = await readItemBlob(type);
  return blob ? blob.text() : null;
}

// macOS는 NSFilenamesPboardType을 바이너리 plist로 준다 — 기본 도구 plutil로 XML로 바꿔 읽는다.
function binaryPlistToXml(buf) {
  return new Promise((resolve) => {
    const child = execFile('plutil', ['-convert', 'xml1', '-o', '-', '-'], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    child.stdin.on('error', () => {});
    child.stdin.end(buf);
  });
}

// 로컬 클립보드에 올라 있는 파일/폴더의 절대 경로들(없으면 []).
async function readLocalFilePaths() {
  let paths = [];
  try {
    if (process.platform === 'darwin') {
      const type = raw('NSFilenamesPboardType');
      if (!(await clipboard.has(type))) return [];
      const blob = await readItemBlob(type);
      let text = '';
      if (blob) {
        const buf = Buffer.from(await blob.arrayBuffer());
        text = buf.subarray(0, 6).toString('latin1') === 'bplist' ? await binaryPlistToXml(buf) : buf.toString('utf8');
      }
      if (text) paths = Array.from(text.matchAll(/<string>([\s\S]*?)<\/string>/g)).map((m) => xmlDecode(m[1]));
    } else if (process.platform === 'win32') {
      // Electron은 Windows 파일 목록(CF_HDROP)을 text/uri-list로 보여 준다 — 탐색기뿐 아니라 CF_HDROP만 올리는 앱(.NET의
      // Set-Clipboard 등, FileNameW가 없음)의 복사도 잡히고, 0.7초마다 PowerShell을 띄우지 않아도 된다.
      if (!(await clipboard.has('text/uri-list'))) return [];
      const text = await readItemText('text/uri-list');
      if (text) {
        paths = text.split(/\r?\n/).filter((l) => l.startsWith('file:')).map((l) => {
          try { return fileURLToPath(l); } catch (_e) { return ''; }
        }).filter(Boolean);
      }
    } else {
      const text = await readItemText('text/uri-list');
      if (text) {
        paths = text.split(/\r?\n/).filter((l) => l.startsWith('file://')).map((l) => {
          try { return decodeURIComponent(new URL(l).pathname); } catch (_e) { return ''; }
        }).filter(Boolean);
      }
    }
  } catch (_e) { return []; }
  return paths.filter((p) => path.isAbsolute(p));
}

// 클립보드 경로들을 헬퍼에 보낼 줄 목록으로 펼친다: "d\t크기\t상대경로(/)\t절대경로\n". 심볼릭 링크는 따라가지 않는다.
async function buildListing(paths) {
  const lines = [];
  let count = 0;
  const bad = (n) => /[\t\n\r\0]/.test(n);
  async function walk(abs, rel, depth) {
    if (count >= MAX_SEND_ENTRIES || depth > MAX_DEPTH) return;
    let st;
    try { st = await fs.promises.lstat(abs); } catch (_e) { return; }
    if (st.isSymbolicLink()) return;
    if (bad(rel) || bad(abs)) return;
    if (st.isDirectory()) {
      lines.push('1\t0\t' + rel + '\t' + abs);
      count++;
      let names = [];
      try { names = await fs.promises.readdir(abs); } catch (_e) { return; }
      for (const n of names) await walk(path.join(abs, n), rel + '/' + n, depth + 1);
    } else if (st.isFile()) {
      lines.push('0\t' + st.size + '\t' + rel + '\t' + abs);
      count++;
    }
  }
  for (const p of paths) await walk(p, path.basename(p), 0);
  return lines.length ? Buffer.from(lines.join('\n') + '\n', 'utf8') : Buffer.alloc(0);
}

// 원격에서 받은 파일을 로컬 클립보드의 "파일"로 올린다.
const MAC_SET_JS = 'ObjC.import("AppKit");function run(argv){var pb=$.NSPasteboard.generalPasteboard;pb.clearContents;var arr=$.NSMutableArray.alloc.init;' +
  'for(var i=0;i<argv.length;i++)arr.addObject($(argv[i]));pb.declareTypesOwner($.NSArray.arrayWithObject("NSFilenamesPboardType"),$());' +
  'return pb.setPropertyListForType(arr,"NSFilenamesPboardType");}';

function writeLocalFilePaths(paths) {
  if (!paths.length) return;
  if (process.platform === 'darwin') {
    execFile('osascript', ['-l', 'JavaScript', '-e', MAC_SET_JS, ...paths], () => {});
  } else if (process.platform === 'win32') {
    // 경로는 명령 문자열에 넣지 않고 환경 변수로 넘긴다. 원격이 정한 파일 이름이 들어 있어, 따옴표로 감싸 넣으면 PowerShell이
    // 따옴표로 치는 ‘ ’ ‚ ‛ 같은 글자로 문자열을 끝내고 뒤에 명령을 붙일 수 있다(' 하나만 이스케이프해서는 막지 못함).
    const env = Object.assign({}, process.env, { ONEGYEOK_CLIP_PATHS: paths.join('\n') });
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
      'Set-Clipboard -LiteralPath ($env:ONEGYEOK_CLIP_PATHS -split [char]10)'], { windowsHide: true, env }, () => {});
  } else {
    const blob = new Blob([paths.map((p) => 'file://' + encodeURI(p)).join('\r\n')], { type: 'text/uri-list' });
    Promise.resolve(clipboard.write([new (require('electron').ClipboardItem)({ 'text/uri-list': blob })])).catch(() => {});
  }
}

// ':'도 바꾸므로 NTFS 대체 스트림(a.txt:b)은 a.txt_b가 된다. CON·NUL·COM1처럼 Windows가 장치로 여기는 이름(확장자가 붙어도 같음)은
// 앞에 '_'를 붙인다 — 그대로 열면 파일 대신 장치가 열린다.
const INVALID_CHARS = /[<>:"|?*\x00-\x1f]/g;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
function safeParts(rel) {
  const parts = [];
  for (const raw of String(rel).split(/[\\/]+/)) {
    if (!raw || raw === '.' || raw === '..') continue;
    let part = raw.replace(INVALID_CHARS, '_').replace(/[. ]+$/, '');
    if (RESERVED.test(part)) part = '_' + part;
    if (part) parts.push(part);
  }
  return parts;
}

// 세션 하나의 "원격 → 로컬" 파일 받기 상태.
class RemoteFileReceiver {
  constructor(log) {
    this.log = log || (() => {});
    this.root = null;
    this.entries = [];
    this.fds = new Map();
    this.published = false; // 받은 파일이 로컬 클립보드에 올라가 있는 상태
  }

  cleanup() {
    for (const fd of this.fds.values()) { try { fs.closeSync(fd); } catch (_e) { /* 무시 */ } }
    this.fds.clear();
    if (this.root) { try { fs.rmSync(this.root, { recursive: true, force: true }); } catch (_e) { /* 무시 */ } }
    this.root = null;
    this.entries = [];
    this.published = false;
  }

  begin(payload) {
    this.cleanup();
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'onegyeok-rdp-clip-'));
    const rootResolved = path.resolve(this.root);
    const lines = payload.toString('utf8').split('\n').filter(Boolean);
    this.entries = lines.map((line, index) => {
      const [d, size, ...rest] = line.split('\t');
      const parts = safeParts(rest.join('\t'));
      const entry = { index, dir: d === '1', size: Number(size) || 0, parts, abs: null };
      if (!parts.length) return entry;
      const abs = path.resolve(rootResolved, ...parts);
      if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return entry; // 임시 폴더 밖 — 무시
      entry.abs = abs;
      try {
        if (entry.dir) fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
        else {
          fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
          this.fds.set(index, fs.openSync(abs, 'w', 0o600));
        }
      } catch (err) { entry.abs = null; this.log('원격 파일 생성 실패: ' + err.message); }
      return entry;
    });
  }

  chunk(payload) {
    if (payload.length < 4) return;
    const fd = this.fds.get(payload.readUInt32LE(0));
    if (fd === undefined) return;
    try { fs.writeSync(fd, payload, 4, payload.length - 4); } catch (err) { this.log('원격 파일 쓰기 실패: ' + err.message); }
  }

  // 끝나면 로컬 클립보드에 올릴 최상위 경로들을 돌려준다(실패·상한 초과면 []).
  end(payload) {
    const result = payload.length ? payload.readUInt8(0) : 0;
    for (const fd of this.fds.values()) { try { fs.closeSync(fd); } catch (_e) { /* 무시 */ } }
    this.fds.clear();
    if (result !== 1) {
      if (result === 2) this.log('원격에서 복사한 파일이 너무 커서 받지 않았습니다(상한 초과).');
      const stale = this.published; // 이전에 올린 파일은 지워지므로 로컬 클립보드도 비워야 한다
      this.cleanup();
      return { result, paths: [], stale };
    }
    const tops = [];
    for (const e of this.entries) if (e.abs && e.parts.length === 1) tops.push(e.abs);
    this.published = tops.length > 0;
    return { result, paths: tops };
  }
}

module.exports = { readLocalFilePaths, buildListing, writeLocalFilePaths, RemoteFileReceiver, safeParts };
