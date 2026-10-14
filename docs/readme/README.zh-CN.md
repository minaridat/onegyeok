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
  <sub><a href="../../README.md">한국어</a> · <b>中文</b> · <a href="README.ja.md">日本語</a> · <a href="README.en.md">English</a></sub>
</p>

<p align="center">
  <strong>SSH · SQL · SFTP · RDP · VNC · Web —— 把零散的远程连接客户端合而为一。</strong><br/>
  注册一次服务器，即可按协议直接连接，并在同一窗口中并排显示多个会话。<br/>
  密码绝不保存，每次连接时手动输入。
</p>

<p align="center">
  <a href="https://github.com/minaridat/onegyeok/releases/latest/download/onegyeok-arm64.dmg"><img src="https://img.shields.io/badge/Download-macOS%20(Apple%20Silicon)-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS" /></a>
  &nbsp;
  <a href="https://github.com/minaridat/onegyeok/releases/latest/download/onegyeok-x64.exe"><img src="https://img.shields.io/badge/Download-Windows%20(x64)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" /></a>
</p>

<p align="center">
  <b>🍎 macOS — 首次运行时：系统设置 → 隐私与安全性 → 向下滚动点击“仍要打开” → 输入密码 / Touch ID 验证</b><br/>
  <b>🪟 Windows — 出现“Windows 已保护你的电脑”（SmartScreen）窗口时：更多信息 → 仍要运行</b>
</p>

<p align="center">
  <sub>安装方法及<b>首次运行时的安全许可说明</b>请见下方 <a href="#install">Install</a> · <a href="https://github.com/minaridat/onegyeok/releases">全部版本</a></sub>
</p>

<p align="center">
  <img src="../assets/splitview.gif" alt="onegyeok — 在分屏中并排显示 SSH、Web 与 SQL" width="960" />
</p>

> **说明：** 应用界面目前为韩语。下文按钮和菜单名称以中文说明，并在括号中标注韩语界面文字。

---

## Features

<table>
<tr>
<td width="42%" valign="middle">

### 分屏视图（分组标签）

把标签拖到另一个标签画面的边缘，**SSH · SQL · SFTP · RDP · VNC · Web 任意组合**都能并排显示。最多 6 格，拖动分隔线调整大小，把格子标题拖回标签栏即可恢复为独立标签。

[用法 →](#split-view)

</td>
<td width="58%">
  <img src="../assets/splitview.gif" alt="分屏视图" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### SSH 终端

基于 xterm.js 的终端。登录名可见，密码显示为 `*`，登录提示直接出现在**终端内**。支持密钥认证和跳板机。

[用法 →](#connect)

</td>
<td width="58%">
  <img src="../assets/ssh.gif" alt="SSH 终端" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### 同时输入到多台服务器

勾选多个 SSH 会话，**从密码输入阶段起**，相同的按键就会同时发送给全部会话。目标以红色边框标示。

[用法 →](#broadcast)

</td>
<td width="58%">
  <img src="../assets/broadcast.gif" alt="同时输入" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### SQL 客户端

连接 MySQL / MariaDB · PostgreSQL · MS SQL Server，执行查询并以表格查看结果。

[用法 →](#connect)

</td>
<td width="58%">
  <img src="../assets/sql.gif" alt="SQL 客户端" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### SFTP / FTP / FTPS 文件管理器

本地/远程**双面板**、文件与文件夹递归传输、比较并同步、批量重命名、定时传输、传输队列（暂停·继续·取消）、SHA-256 校验。

[用法 →](#connect)

</td>
<td width="58%">
  <img src="../assets/sftp.gif" alt="SFTP 文件管理器" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### RDP · VNC 远程桌面

无需外部服务器，原生辅助程序直接渲染远程画面。调整窗口大小时**远程分辨率随之变化**（RDP），支持全屏和 1:1 显示。

[用法 →](#connect)

</td>
<td width="58%">
  <img src="../assets/rdp.gif" alt="RDP 远程桌面" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Web 控制台 · 书签

在内置浏览器中打开内部 Web 控制台。可像 Chrome 一样直接修改地址栏，并用 `☆` 把当前页面注册为服务器。Cookie 不会写入磁盘。

[用法 →](#connect)

</td>
<td width="58%">
  <img src="../assets/web.gif" alt="Web 控制台" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### 快速连接

无需注册服务器，在**一个表单中填写主机、用户名和密码**即可直接连接。每种协议保留最近 5 条记录（用 `×` 删除），地址输错时可在标签上方直接修改后重新连接。

[用法 →](#quick-connect)

</td>
<td width="58%">
  <img src="../assets/quick-connect.gif" alt="快速连接" width="100%" />
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### 内置快捷键指南

右侧面板的**快捷键**（단축키）标签页列出了 macOS / Windows 的全部快捷键（当前系统显示在上方）。

[快捷键表 →](#shortcuts)

</td>
<td width="58%">
  <img src="../assets/shortcuts.gif" alt="快捷键标签页" width="100%" />
</td>
</tr>
</table>

**另外：**

- **不保存密码** —— 密码和密钥口令仅在单次连接期间保存在内存中，随后丢弃（为 ISMS 审查而设计）。
- **服务器列表加密保存** —— 主机、分组和备注使用系统钥匙串加密，重启后仍然保留。
- **同一服务器多个会话** —— 再次点击服务器，总是打开新标签和新连接。
- **多窗口** —— 把标签拖出窗口即可分离为新窗口。窗口标题会显示打开的会话数，如 `onegyeok 6`。
- **退出应用即断开所有连接** —— 不会有任何悄悄保持的连接。

---

<a id="install"></a>

## Install

### macOS — Apple Silicon（M1 及以上），macOS 15 以上

1. **[下载 onegyeok-arm64.dmg](https://github.com/minaridat/onegyeok/releases/latest/download/onegyeok-arm64.dmg)**，打开后把 `onegyeok` 拖到**应用程序**文件夹。
2. **首次运行需要允许该应用。** 由于尚未通过 Apple 公证，macOS 会以*“无法验证开发者”*警告拦截。只需允许一次，之后即可正常打开。

   > **系统设置 → 隐私与安全性** → 向下滚动，点击 **“仍要打开”** → 输入密码 / Touch ID 验证

   （请先在“应用程序”中双击一次 `onegyeok`，让警告出现后才会显示“仍要打开”。）

   终端方式：`xattr -dr com.apple.quarantine /Applications/onegyeok.app`
3. 不支持 Intel（x64）Mac。所需运行环境（包括 RDP/VNC 辅助程序）都已包含在安装包中。

### Windows — Windows 10 22H2 以上 / 11（x64）

1. **[下载 onegyeok-x64.exe](https://github.com/minaridat/onegyeok/releases/latest/download/onegyeok-x64.exe)** 并运行（可选择安装位置，无需管理员权限）。
2. 如果出现 **“Windows 已保护你的电脑”（SmartScreen）**，请点击 **更多信息 → 仍要运行**。这是因为安装包尚未进行代码签名。

> 应用数据（服务器列表、备注）加密保存在 macOS 的 `~/Library/Application Support/onegyeok/` 和 Windows 的 `%APPDATA%\onegyeok\`，卸载应用后仍会保留。需要彻底清除时请删除该文件夹。

从源码运行或自行构建安装包，请参阅**[开发者指南](../DEVELOPER.md)**（韩语）。

---

## 使用手册

### 开始使用

1. 点击顶部 **[+ 注册服务器]**（서버 등록），填写名称、分组、协议、主机、端口、用户名。也可以不注册，直接在左侧栏选择协议使用**[快速连接](#quick-connect)**。
2. 在服务器列表中点击服务器：会打开**新标签**并开始连接。
3. 每次连接都要输入密码（不会保存）。

### 界面布局

| 区域 | 说明 |
|---|---|
| **左侧栏** | 协议筛选（全部 · SSH · SQL · RDP · VNC · SFTP · Web）。没有打开的会话时显示快速连接表单 |
| **顶部栏** | 服务器搜索 / 快速连接（⌘K）· 关闭标签 · 信息面板开关 · 服务器管理（서버 관리）· 注册服务器（서버 등록） |
| **服务器列表** | 按分组的服务器树。点击 `‹`（⌘B）折叠，整条区域连同分隔线一起消失，用标签行左侧的小按钮重新展开 |
| **标签行** | 已打开的会话标签。右侧 `((•))` 为同时输入开关，旁边的小按钮用于重新打开已折叠的信息面板 |
| **信息面板** | 三个标签页：连接信息（연결 정보）· 备注（메모）· 快捷键（단축키）。点击 `›`（⌘I）折叠 |

<a id="connect"></a>

### 连接方式

| 协议 | 连接方法 | 主要功能 |
|---|---|---|
| **SSH** | 在终端中根据 `login as:` / `password:` 提示输入（密码显示为 `*`）。失败最多重试 3 次，`Ctrl+C` 取消。断开后点击标签的 ↻ 重连 | 密钥认证、跳板机、**以 SFTP 打开**、同时输入 |
| **SQL** | 在连接表单中输入（用户名和）密码 | MySQL/MariaDB · PostgreSQL · MS SQL，`⌘/Ctrl+Enter` 执行（选中时仅执行选中部分），结果表格 |
| **SFTP / FTP / FTPS** | 输入用户名和密码 | 双面板、拖拽/按钮上传下载、比较同步、批量重命名、定时传输、队列、SHA-256 校验。明文 FTP 连接前会警告 |
| **RDP / VNC** | 在连接表单中输入（用户名和）密码 | 工具栏：1:1 ↔ 适应窗口 · 全屏 · 断开。RDP 分辨率随窗口/格子大小自动变化 |
| **Web** | 把 URL 注册为服务器（或快速连接） | 可编辑地址栏（Enter 跳转、Esc 还原）、后退/刷新、`↗` 用默认浏览器打开、`☆` 书签。自签名证书默认拦截，可选择“仅在此标签继续” |

<a id="quick-connect"></a>

### 快速连接

无需注册即可连接。在左侧栏选择协议（没有打开的会话时）就会出现表单。

- **一个表单搞定** —— 同时填写主机、端口、用户名和密码并点击连接，无需再进入第二个登录界面（VNC 只需密码，Web 只需地址）。
- **最近 5 条** —— 按协议保存历史（仅主机、端口、用户名，**绝不保存密码**），可用 `×` 逐条删除。
- **地址输错了？** —— 在标签上方的栏中修改地址/用户名/密码并点击“重新连接”，输错的历史记录也会一并清理。

<a id="split-view"></a>

### 分屏视图

1. **合并** —— 把标签拖到另一个标签画面的**边缘（25%）**，就会向该方向分屏（中间无动作，超出上限的方向会变灰）。
2. **分组标签** —— 合并后的标签显示为一个名为 `그룹탭1`（“分组标签 1”）的标签。**双击**可重命名（Enter 确认，Esc 取消）。
3. **格子标题** —— 显示服务器名称和状态，以及**同时输入勾选（SSH）· 重连 ↻ · 关闭 ×**。点击格子即聚焦，信息面板随之切换。
4. **调整大小** —— 拖动格子之间的分隔线（最小 280×180 px，最多 6 格）。
5. **拖出** —— 把格子标题拖到标签栏即可恢复为独立标签；拖出窗口外则打开新窗口。
6. 分屏布局**不会保存**（重启后恢复为独立标签）。

<a id="broadcast"></a>

### 同时输入

打开标签行右侧的 `((•))`，每个已打开的 SSH 会话都会出现复选框（分屏视图中位于格子标题），并显示警告横幅。勾选的会话带**红色边框**，从密码提示开始你输入的所有内容都会发送给全部勾选的服务器。密码会发送到每一台服务器，请谨慎使用。

<a id="shortcuts"></a>

### 快捷键

| 操作 | macOS | Windows |
|---|---|---|
| 服务器搜索 / 快速连接 | `⌘K` | `Ctrl+K`  *（在终端输入时无效）* |
| 折叠 / 展开服务器列表 | `⌘B` | `Ctrl+B` *（在终端输入时无效）* |
| 折叠 / 展开信息面板 | `⌘I` | `Ctrl+I`  *（在终端输入时无效）* |
| 关闭弹窗（注册/编辑服务器、服务器管理、`⌘K` 搜索框） | `Esc` | `Esc` |
| 关闭标签（分组标签则关闭整组） | `⌘W` | `Ctrl+Shift+W` |
| 按编号切换标签 | `⌘1`–`⌘9` | `Ctrl+1`–`Ctrl+9`  *（在终端输入时无效）* |
| 上一个 / 下一个标签 | `Ctrl+<` / `Ctrl+>` | `Ctrl+<` / `Ctrl+>` |
| 上一个 / 下一个标签（备用） | `Ctrl+Tab` / `Ctrl+Shift+Tab`、`⌘<` / `⌘>` | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 在分组标签的格子间移动 | `⌘⌥+方向键` | `Ctrl+Alt+方向键` |
| 执行 SQL 查询 | `⌘Enter` | `Ctrl+Enter` |
| 重命名分组标签 | 双击标签 → `Enter` / `Esc` | 相同 |

鼠标：把标签拖到边缘**合并** · 把格子标题拖到标签栏**拖出** · 拖动分隔线**调整大小** · 拖出窗口外**分离为新窗口**。

### 常见问题

<details>
<summary><b>密码真的完全不保存吗？</b></summary>

完全不保存。每次连接都要输入，仅在该次连接期间从内存中使用，随后丢弃。只有服务器列表、备注和快速连接历史（主机、端口、用户名）会通过系统钥匙串加密保存。
</details>

<details>
<summary><b>在其他 Mac/PC 上也能看到服务器列表吗？</b></summary>

不能。加密密钥只存在于该电脑的登录钥匙串（Windows 为 DPAPI）中，不会通过 iCloud 钥匙串同步，因此每台电脑都需要单独注册。仅复制 `servers.dat` 文件在另一台电脑上也无法打开。
</details>

<details>
<summary><b>退出应用后 SSH 会话会保留吗？</b></summary>

不会。退出应用会断开所有已打开的连接。如需在服务器端保持会话，请在终端中自行运行 `tmux` 等工具。
</details>

<details>
<summary><b>如何彻底重置服务器列表？</b></summary>

删除 `~/Library/Application Support/onegyeok`（Windows 为 `%APPDATA%\onegyeok`），macOS 还需在“钥匙串访问”中删除 `onegyeok Safe Storage` 项目。
</details>

---

## 文档

| | |
|---|---|
| **[开发者指南](../DEVELOPER.md)** | 从源码运行 · 自行构建安装包（macOS/Windows）· 技术栈（韩语） |
| [功能规格](../기능명세/) | 各协议的功能规格与验收清单（韩语） |
| [QA 记录](../QA.md) | 已验证项目与遗留问题（韩语） |
| [策划文档](../기획서.md) | 背景与安全要求（韩语） |

## 安全概要

- 密码和密钥口令不以任何形式保存。
- 服务器列表和备注通过 Electron `safeStorage`，基于系统凭据存储（macOS 钥匙串 / Windows DPAPI）加密。
- Web 控制台的 Cookie 存放在每个标签独立的内存分区中，不会写入磁盘，也没有账号自动填充。
- 退出应用时，所有 SSH/SQL/RDP/VNC/SFTP 连接都会被无例外地终止。
