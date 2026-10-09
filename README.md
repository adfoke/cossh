# COSSH · 终端画布（cossh）

浏览器里的**无限画布多终端**。点「＋终端」就是本机一个**真 PTY shell**——
不是 tmux 快照镜像，是 xterm.js ↔ WebSocket ↔ node-pty 的字节级双向管道：
vim / htop / ssh / less 这类全屏程序直接跑。开 N 个窗口 = N 个独立进程，
在画布上随意摆位、最小化（进程不死）、最大化、撤销找回。

服务永远只跑在 **127.0.0.1**：这是给你自己机器用的终端，不是多人在服器。
灵感来自 [ekzhang/sshx](https://github.com/ekzhang/sshx)（共享终端），本项目走向不同：
一切以「本机真终端」为中心。

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
终端开局目录：`SSHX_TERM_CWD=<dir>`（默认 `~`）——想让画布里的 shell 固定落在某个工作目录就指它。

## 网络与代理

- 依赖安装走你 shell 自己的 npm 配置（`.npmrc` / `*_proxy` env），项目内**零硬编码代理**。

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

## 画布操作

| 键 | 作用 |
|---|---|
| 须知（红色） | 两条前置：依赖 npm / 这是开真终端操作服务器的程序 |
| ＋终端 | 新建真 PTY 窗口（可开无限个） |
| 拖标题栏 / 滚轮 / 拖空白 | 移窗 / 缩放画布 / 平移 |
| — / □ / ✕ | 最小化（进程活着）/ 最大化（pty 跟着 resize）/ 关闭（进程收割） |
| Del / ⌘Z / ⇧⌘Z | 删窗 / 撤销（关错的窗能捞回来）/ 重做 |
| 双击标题栏 / F2 | 重命名窗口 |
| ? | 用法弹层 |
| ⌗ Auto（右下角） | 一键整理：全部窗按阅读顺序网格排布（尊重最大化/最小化尺寸），动画落位 + 适应视口，⌘Z 可退回 |

窗口布局、标题、窗口状态随画布存 localStorage，刷新后原位重开 shell；
正在跑的进程跨不过刷新（页面即终端的生命周期）。

## 技术栈

Vite + React 19 + TypeScript（strict）· HeroUI v3 · @xyflow/react（无限画布、undo/redo、localStorage）
· @xterm/xterm + FitAddon · Node 服务端：express + ws + node-pty

## 回归测试（贡献者向）

```bash
npm run typecheck && npm run build   # 静态自检
node scripts/e2e-pty.mjs             # 需要 npm run dev 在跑 + 一个 CDP :9222 的 headless Chrome
node scripts/e2e-theme.mjs           # 主题跟随 7 断言
```

`e2e-pty` 含 59 条断言：tty 真设备、字符链路、多窗隔离、resize 打到内核（stty 侧证）、
最小化进程不死、关闭/撤销、刷新持久化、⌗ Auto 整理、⚡ 快捷命令、📈 状态卡。
其中 📈 状态卡的真机采集段默认 SKIP，配 `SSHX_E2E_SSH_HOST=[user@]your-test-host`
（需密钥免密登录）才会跑，且不可达自动 SKIP 不算红。

## License

MIT
