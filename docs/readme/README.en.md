<h1 align="center">
  <img src="../assets/logo.svg" alt="onegyeok" width="64" valign="middle" /> onegyeok
</h1>

<p align="center">
  <a href="https://github.com/minaridat/onegyeok/releases/latest"><img src="https://img.shields.io/github/v/release/minaridat/onegyeok?style=flat&color=C16A30" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS%2015%2B%20(Apple%20Silicon)%20%7C%20Windows%2010%2B%20(x64)-4493F8?style=flat" alt="Supported platforms" />
  <img src="https://img.shields.io/badge/SSH%20%C2%B7%20SQL%20%C2%B7%20SFTP%20%C2%B7%20RDP%20%C2%B7%20VNC%20%C2%B7%20Web-444?style=flat" alt="Protocols" />
  <img src="https://img.shields.io/badge/passwords-never%20stored-168a4a?style=flat" alt="Passwords never stored" />
</p>

<p align="center">
  <sub><a href="../../README.md">한국어</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <b>English</b></sub>
</p>

<p align="center">
  <strong>SSH · SQL · SFTP · RDP · VNC · Web — one client for every remote connection.</strong><br/>
  Register a server once and connect with the right protocol; show several sessions side by side in one window.<br/>
  Passwords are never stored — you type them each time you connect.
</p>

<p align="center">
  <a href="https://github.com/minaridat/onegyeok/releases/latest/download/onegyeok-arm64.dmg"><img src="https://img.shields.io/badge/Download-macOS%20(Apple%20Silicon)-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  &nbsp;
  <a href="https://github.com/minaridat/onegyeok/releases/latest/download/onegyeok-x64.exe"><img src="https://img.shields.io/badge/Download-Windows%20(x64)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" /></a>
</p>

<p align="center">
  <sub>See <a href="#install">Install</a> below for setup steps, including the <b>first-launch security approval</b> · <a href="https://github.com/minaridat/onegyeok/releases">All releases</a></sub>
</p>

<p align="center">
  <img src="../assets/splitview.jpg" alt="onegyeok — SSH, Web and SQL side by side in a split view" width="960" />
</p>

> **Note:** the app's interface is currently in Korean. Button and menu names below are given in English with the Korean label in parentheses.

---

## Features

<table>
<tr>
<td width="42%" valign="middle">

### Split view (group tabs)

Drag a tab onto the edge of another tab's screen and **any mix of SSH · SQL · SFTP · RDP · VNC · Web** shows side by side. Up to 6 panes, drag the dividers to resize, and drag a pane header back to the tab bar to turn it into a normal tab again.

[How to →](#split-view)

</td>
<td width="58%">
  <img src="../assets/splitview.jpg" alt="Split view" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### SSH terminal

xterm.js terminal. The login name stays visible, the password shows as `*`, and the prompts appear **inside the terminal**. Key authentication and jump hosts are supported.

[How to →](#connect)

</td>
<td width="58%">
  <img src="../assets/ssh.jpg" alt="SSH terminal" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Type into many servers at once

Tick several SSH sessions and the same keystrokes go to all of them — **starting from the password prompt**. Targets get a red border.

[How to →](#broadcast)

</td>
<td width="58%">
  <img src="../assets/broadcast.jpg" alt="Broadcast input" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### SQL client

Connect to MySQL / MariaDB · PostgreSQL · MS SQL Server, run queries and read the results as a table.

[How to →](#connect)

</td>
<td width="58%">
  <img src="../assets/sql.jpg" alt="SQL client" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### SFTP / FTP / FTPS file explorer

**Dual local/remote panes**, recursive file and folder transfer, compare & sync, batch rename, scheduled transfer, a transfer queue (pause / resume / cancel) and SHA-256 verification.

[How to →](#connect)

</td>
<td width="58%">
  <img src="../assets/sftp.jpg" alt="SFTP explorer" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### RDP · VNC remote desktop

Native helpers render the remote screen — no external server needed. Resize the window and the **remote resolution follows** (RDP); full screen and 1:1 view are supported.

[How to →](#connect)

</td>
<td width="58%">
  <img src="../assets/rdp.jpg" alt="RDP remote desktop" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Web console · bookmarks

Open internal web consoles in the built-in browser. Edit the address bar like Chrome, and bookmark the current page as a server with `☆`. Cookies are never written to disk.

[How to →](#connect)

</td>
<td width="58%">
  <img src="../assets/web.jpg" alt="Web console" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Quick connect

Connect without registering anything: put **host, user and password in one form**. The last 5 per protocol are kept (delete with `×`), and a mistyped address can be fixed right above the tab.

[How to →](#quick-connect)

</td>
<td width="58%">
  <img src="../assets/quick-connect.jpg" alt="Quick connect" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Built-in shortcut guide

The **Shortcuts** (단축키) tab of the right-hand panel lists every macOS and Windows shortcut (your current OS is shown first).

[Shortcut table →](#shortcuts)

</td>
<td width="58%">
  <img src="../assets/shortcuts.jpg" alt="Shortcuts tab" width="100%" />
</td>
</tr>
</table>

**Also:**

- **No stored passwords** — passwords and key passphrases live in memory for one connection only (built for ISMS audits).
- **Encrypted server list** — hosts, groups and notes are encrypted with the OS keychain and survive restarts.
- **Many sessions per server** — clicking a server again always opens a new tab and a new connection.
- **Multiple windows** — drag a tab out of the window to detach it. The window title shows the open session count, e.g. `onegyeok 6`.
- **All connections end when the app quits** — nothing silently stays alive.

---

<a id="install"></a>

## Install

### macOS — Apple Silicon (M1 or later), macOS 15+

1. **[Download onegyeok-arm64.dmg](https://github.com/minaridat/onegyeok/releases/latest/download/onegyeok-arm64.dmg)**, open it and drag `onegyeok` into **Applications**.
2. **You must allow the app on first launch.** It is not notarized by Apple yet, so macOS blocks it with an *"unidentified developer"* warning. Allow it once and it opens normally afterwards.

   > **System Settings → Privacy & Security** → scroll down and click **"Open Anyway"** → authenticate with your password / Touch ID

   (Double-click `onegyeok` in Applications once first, so the warning appears and "Open Anyway" becomes available.)

   Terminal alternative: `xattr -dr com.apple.quarantine /Applications/onegyeok.app`
3. Intel (x64) Macs are not supported. Everything the app needs (including the RDP/VNC helpers) is inside the installer.

### Windows — Windows 10 22H2+ / 11 (x64)

1. **[Download onegyeok-x64.exe](https://github.com/minaridat/onegyeok/releases/latest/download/onegyeok-x64.exe)** and run it (choose the install location; no administrator rights needed).
2. If **"Windows protected your PC" (SmartScreen)** appears, click **More info → Run anyway**. The installer is not code-signed yet, hence the warning.

> App data (server list, notes) is stored encrypted in `~/Library/Application Support/onegyeok/` on macOS and `%APPDATA%\onegyeok\` on Windows. It remains after uninstalling — delete the folder to wipe it.

To run from source or build the installers yourself, see the **[Developer guide](../DEVELOPER.md)** (Korean).

---

## User manual

### Getting started

1. Click **[+ Register server]** (서버 등록) at the top — name, group, protocol, host, port, user. Or skip registration and use **[Quick connect](#quick-connect)** from the left rail.
2. Click a server in the server list: a **new tab** opens and the connection starts.
3. Type the password every time you connect (it is never stored).

### Screen layout

| Area | Description |
|---|---|
| **Left rail** | Protocol filter (All · SSH · SQL · RDP · VNC · SFTP · Web). With no open session it shows the quick-connect form |
| **Top bar** | Server search / quick connect (⌘K) · close tab · info-panel toggle · Server management (서버 관리) · Register server (서버 등록) |
| **Server list** | Servers grouped in a tree. Collapse with `‹` (⌘B) — the whole strip disappears and a small button at the left of the tab row brings it back |
| **Tab row** | Open session tabs. `((•))` on the right toggles broadcast input; the small button next to it reopens a collapsed info panel |
| **Info panel** | Three tabs: Info (연결 정보) · Notes (메모) · Shortcuts (단축키). Collapse with `›` (⌘I) |

<a id="connect"></a>

### Connecting

| Protocol | How to connect | Highlights |
|---|---|---|
| **SSH** | Type at the `login as:` / `password:` prompts in the terminal (password shows as `*`). Up to 3 retries on failure, `Ctrl+C` cancels. Use the tab's ↻ to reconnect | Key auth, jump host, **Open as SFTP**, broadcast input |
| **SQL** | Enter (user and) password in the connect form | MySQL/MariaDB · PostgreSQL · MS SQL, run with `⌘/Ctrl+Enter` (selection only if you select), result table |
| **SFTP / FTP / FTPS** | Enter user and password | Dual panes, drag or button upload/download, compare & sync, batch rename, scheduled transfer, queue, SHA-256 verify. Plain FTP shows a warning first |
| **RDP / VNC** | Enter (user and) password in the connect form | Toolbar: 1:1 ↔ fit-to-window · full screen · disconnect. RDP follows window/pane size with the resolution |
| **Web** | Register the URL as a server (or quick connect) | Editable address bar (Enter to go, Esc to revert), back/reload, `↗` open in default browser, `☆` bookmark. Self-signed certificates are blocked by default; allow per tab with "continue on this tab only" |

<a id="quick-connect"></a>

### Quick connect

Connect without registering. Pick a protocol on the rail (with no open session) and the form appears.

- **One form** — fill in host, port, user and password and press Connect: no second login screen (VNC: password only, Web: address only).
- **Last 5** — per-protocol history (host, port, user only — **never the password**), deletable one by one with `×`.
- **Mistyped the address?** — fix address / user / password in the bar above the tab and press Reconnect; the wrong history entry is cleaned up too.

<a id="split-view"></a>

### Split view

1. **Merge** — drag a tab onto the **edge (25%)** of another tab's screen to split in that direction (the centre does nothing; directions over the limit turn grey).
2. **Group tab** — merged tabs appear as one tab called `그룹탭1` ("Group tab 1"). **Double-click** it to rename (Enter confirms, Esc cancels).
3. **Pane header** — server name and status plus **broadcast checkbox (SSH) · reconnect ↻ · close ×**. Click a pane to focus it; the info panel follows.
4. **Resize** — drag the divider between panes (min 280×180 px, max 6 panes).
5. **Pull out** — drag a pane header onto the tab bar to make it a normal tab again; drag it outside the window to open a new window.
6. The layout is **not saved** (after a restart you get plain tabs).

<a id="broadcast"></a>

### Broadcast input

Turn on `((•))` at the right of the tab row: a checkbox appears on every open SSH session (on pane headers in a split view) and a warning banner is shown. Ticked sessions get a **red border**, and everything you type — from the password prompt on — goes to all ticked servers. Your password goes to every one of them, so use it carefully.

<a id="shortcuts"></a>

### Shortcuts

| Action | macOS | Windows |
|---|---|---|
| Server search / quick connect | `⌘K` | `Ctrl+K` *(not while typing in a terminal)* |
| Collapse / expand server list | `⌘B` | `Ctrl+B` *(not while typing in a terminal)* |
| Collapse / expand info panel | `⌘I` | `Ctrl+I` *(not while typing in a terminal)* |
| Close popups (register/edit server, server management, `⌘K` palette) | `Esc` | `Esc` |
| Close tab (whole group for a group tab) | `⌘W` | `Ctrl+Shift+W` |
| Go to tab by number | `⌘1`–`⌘9` | `Ctrl+1`–`Ctrl+9` *(not while typing in a terminal)* |
| Previous / next tab | `Ctrl+<` / `Ctrl+>` | `Ctrl+<` / `Ctrl+>` |
| Previous / next tab (alternatives) | `Ctrl+Tab` / `Ctrl+Shift+Tab`, `⌘<` / `⌘>` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Move between panes of a group tab | `⌘⌥+arrow keys` | `Ctrl+Alt+arrow keys` |
| Run SQL query | `⌘Enter` | `Ctrl+Enter` |
| Rename group tab | double-click the tab → `Enter` / `Esc` | same |

Mouse: drag a tab to an edge to **merge** · drag a pane header to the tab bar to **pull out** · drag dividers to **resize** · drag outside the window to **detach**.

### FAQ

<details>
<summary><b>Are passwords really never stored?</b></summary>

Never. You type them on every connection; they are used from memory for that one connection and discarded. Only the server list, notes and quick-connect history (host, port, user) are stored, encrypted with the OS keychain.
</details>

<details>
<summary><b>Will my server list show up on another Mac/PC?</b></summary>

No. The encryption key stays in that computer's login keychain (DPAPI on Windows) and is not synced through iCloud Keychain, so register servers on each computer. Copying `servers.dat` alone will not open on another machine.
</details>

<details>
<summary><b>Do SSH sessions survive quitting the app?</b></summary>

No. Quitting ends every open connection. If you need server-side persistence, run `tmux` yourself inside the terminal.
</details>

<details>
<summary><b>How do I fully reset the server list?</b></summary>

Delete `~/Library/Application Support/onegyeok` (Windows: `%APPDATA%\onegyeok`) and, on macOS, the `onegyeok Safe Storage` item in Keychain Access.
</details>

---

## Docs

| | |
|---|---|
| **[Developer guide](../DEVELOPER.md)** | Run from source · build installers (macOS/Windows) · tech stack (Korean) |
| [Feature specs](../기능명세/) | Per-protocol specs and acceptance checklists (Korean) |
| [QA log](../QA.md) | Verified items and open issues (Korean) |
| [Planning document](../기획서.md) | Background and security requirements (Korean) |

## Security summary

- Passwords and key passphrases are never stored in any form.
- The server list and notes are encrypted via Electron `safeStorage` on top of the OS credential store (macOS Keychain / Windows DPAPI).
- Web console cookies live in per-tab in-memory partitions and never reach disk; there is no credential autofill.
- Quitting the app ends every SSH/SQL/RDP/VNC/SFTP connection without exception.
