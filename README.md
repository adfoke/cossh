# SSHX · 终端画布（sshx-canvas）

浏览器里的**无限画布多终端**。点「＋终端」就是本机一个**真 PTY shell**——
不是 tmux 快照镜像，是 xterm.js ↔ WebSocket ↔ node-pty 的字节级双向管道：
vim / htop / ssh / less 这类全屏程序直接跑。开 N 个窗口 = N 个独立进程，
在画布上随意摆位、最小化（进程不死）、最大化、撤销找回。

服务永远只跑在 **127.0.0.1**：这是给你自己机器用的终端，不是多人在服器。
灵感来自 [ekzhang/sshx](https://github.com/ekzhang/sshx)（共享终端），本项目走向不同：
一切以「本机真终端」为中心，外加 Codex CLI 一键安装/配置与远端 tmux 自动观察窗。

## 快速开始

要求：**Node ≥ 24**（服务端以 type-stripping 直跑 TS）+ npm。macOS / Linux 已验证；Windows 未测试。

```bash
npm install        # postinstall 自动修复 node-pty spawn-helper 执行位
npm start          # 构建前端 + 单端口起服务
# 打开 http://127.0.0.1:8787 ，点「＋终端」
```

开发模式（热更新，双端口）：

```bash
npm run dev        # web :5173 + server :8787，打开 http://localhost:5173
```

端口可配：server 用 `SSHX_PORT=<port>`（默认 8787）。

## 网络与代理

- 依赖安装、Codex 安装等走你 shell 自己的 npm 配置（`.npmrc` / `*_proxy` env），
  项目内**零硬编码代理**。
- 「↓ 获取」拉模型列表若直连不通，给 server 进程设 `SSHX_PROXY=http://127.0.0.1:<port>`
  （或标准 `https_proxy`）即可自动兜底；不设就只试直连。

## 架构与协议

```
浏览器画布                          本机 (127.0.0.1)
┌─────────────────────────┐        ┌──────────────────────────┐
│ ReactFlow 画布           │   ws   │ server (express + ws)    │
│  └─ TermNode ×N          │◄──────►│  /ws/pty: 1 连接 = 1 PTY  │
│     xterm.js + FitAddon  │        │  node-pty spawn $SHELL -l│
└─────────────────────────┘        └──────────────────────────┘
```

WS 协议（每条连接一个 shell）：

| 方向 | 帧 | 含义 |
|---|---|---|
| client → server | **binary** | 键盘输入（stdin，永远二进制，文本帧保留给控制） |
| client → server | text `{type:"resize",cols,rows}` | 网格尺寸 → `pty.resize` |
| client → server | text `{type:"hb"}` | 应用层心跳（5s 一发） |
| server → client | **binary** | PTY 输出（stdout 原样字节流） |
| server → client | text `{type:"hello",pid,shell}` / `{type:"exit",...}` | 状态 |

生命周期：ws 断开 → `pty.kill()`；页面消失后网络进程卡半开连接的，由 hb 断流 15s 清扫兜底。
dev 下 ws 直连 8787（绕开 vite 代理——它会留半开上游连接）；生产模式同源单端口。

## 安全边界

- server **只绑 127.0.0.1**——每个终端窗都是这台机器的任意命令执行，
  改成 0.0.0.0 / 反向代理裸暴露等于把电脑交出去。
- 想从手机/其它设备用：把本机服务套进隧道并加鉴权（如 Cloudflare Tunnel + Access），
  永远不要直接开公网端口。
- Codex API key 只写 `~/.codex/.env`（0600），接口永不回显。

## 画布操作

| 键 | 作用 |
|---|---|
| 须知（红色） | 三条前置：依赖 npm / 这是用 codex-cli 操作服务器的程序 / 装完 codex 让 codex 帮你装 tmux |
| ＋终端 | 新建真 PTY 窗口（可开无限个） |
| 📦 安装 Codex | 开一次性安装窗：先 `command -v codex` 检查，缺了才 `npm install -g @openai/codex`（走你自己的 npm 代理配置；runOnOpen 用后即焚） |
| 🔑 配置 Codex | 表单写 `~/.codex`：`config.toml` 合并更新自定义 provider（其它键无损），key 进 `.env`（0600、永不回显、留空不改）；`GET/POST /api/codex/config` |
| 📜 Codex 规矩 | 幂等标记块写入 `~/.codex/AGENTS.md`：远端 tmux 共享工位协议（send-keys/capture-pane），让 codex 的远程操作天然可被 👀 围观；本仓库 `AGENTS.md` 随 clone 零点击生效 |
| ↓ 获取（模型列表） | `POST /api/codex/models` 服务端代理：curl 直连失败退 `SSHX_PROXY`（若配置），base 带/不带 `/v1` 双候选探测，返回归一成 chips 可点选；key 表单留空 = 用已存的，接口只回 `{models}` |
| 拖标题栏 / 滚轮 / 拖空白 | 移窗 / 缩放画布 / 平移 |
| — / □ / ✕ | 最小化（进程活着）/ 最大化（pty 跟着 resize）/ 关闭（进程收割） |
| Del / ⌘Z / ⇧⌘Z | 删窗 / 撤销（关错的窗能捞回来）/ 重做 |
| 双击标题栏 / F2 | 重命名窗口 |
| ? | 用法弹层 |
| ⌗ Auto（右下角） | 一键整理：全部窗按阅读顺序网格排布（尊重最大化/最小化尺寸），动画落位 + 适应视口，⌘Z 可退回 |

窗口布局、标题、窗口状态随画布存 localStorage，刷新后原位重开 shell；
正在跑的进程跨不过刷新（页面即终端的生命周期）。

## 👀 自动观察窗（远端 tmux 当共享工位）

给 codex（或你自己）定规矩：远程机器上的操作一律进远端 tmux 会话——
`ssh host tmux send-keys -t <sess> '<cmd>' Enter` 执行、`capture-pane` 读屏。
画布这边不需要任何手动围观动作：

1. 每个终端窗的 PATH 最前挂着 `server/shims/ssh`（只作用于画布内的 shell）；
   shim 发现命令行里出现 `tmux` 就后台向 `/api/observe` 上报 `(host, session)`，
   然后原样 exec 真 `/usr/bin/ssh`——其余 ssh 用法零开销零干预。
   （macOS 的 path_helper 会在登录 shell 重排 PATH，故用 ZDOTDIR 引导壳在用户 rc
   全部跑完后把 shim 一锤定音顶回最前。）
2. 前端 1.5s 轮询事件环，未见过的 `host+session` 自动开一个 👀 窗，
   窗里常驻执行 `ssh -t [user@]host tmux new -As <sess>`（登录名从 `user@host` 形态贯通解析，
   缺了会以本机用户登录被 publickey 拒——真实教训）——tmux 的 attach-or-create 语义
   保证你和 codex 落在同一个会话：它敲什么你实时看什么，还能随时抢键盘。
3. 观察窗自带 `SSHX_NO_OBSERVE=1`（它的 attach 再进 shim 也不上报，防回声环）；
   同 key 只开一扇窗；观察窗布局随画布持久化，刷新自动重贴。

## 技术栈

Vite + React 19 + TypeScript（strict）· HeroUI v3 · @xyflow/react（无限画布、undo/redo、localStorage）
· @xterm/xterm + FitAddon · Node 服务端：express + ws + node-pty

## 回归测试（贡献者向）

```bash
npm run typecheck && npm run build   # 静态自检
node scripts/e2e-pty.mjs             # 需要 npm run dev 在跑 + 一个 CDP :9222 的 headless Chrome
node scripts/e2e-theme.mjs           # 主题跟随 7 断言
```

`e2e-pty` 含 62+ 断言：tty 真设备、字符链路、多窗隔离、resize 打到内核（stty 侧证）、
最小化进程不死、关闭/撤销、刷新持久化、Codex 三按钮、shim 上报→👀 自动观察窗全链路。
其中「真机远端 tmux」段默认 SKIP，配 `SSHX_E2E_SSH_HOST=[user@]your-test-host`
（需密钥免密登录 + tmux）才会跑，且不可达自动 SKIP 不算红。

## License

MIT
