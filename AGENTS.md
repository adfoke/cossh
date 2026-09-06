# AGENTS.md — 给在此项目里工作的 AI agent（codex 等）

本项目的画布会自动围观「远端 tmux 会话」：只要你按下面协议操作远程机器，
用户无需任何手动动作，画布就会弹出 👀 观察窗实时直播你的操作，且可随时抢键盘。

## 远程操作协议（共享工位）

1. 建会话（幂等）：`ssh <user>@<host> tmux new -d -s <session>`
   - 会话命名建议 `codex-<主机短名>`（如 `codex-web1`）；已存在会直接复用。
2. 执行命令：`ssh <user>@<host> tmux send-keys -t <session> '<命令>' Enter`
3. 读屏：`ssh <user>@<host> tmux capture-pane -pt <session> -S -40`
4. 交互式/长时任务（vim、安装器、跳板后再 ssh）只能走 2/3 的循环，
   **禁止一次性 `ssh host 命令` 去跑需要交互的东西**（没有 TTY，也围观不到）。
5. 收尾：任务完成后自行 `ssh <user>@<host> tmux kill-session -t <session>`
   清理；若用户可能要看现场则留着别删。

原理一句话：每台开画布终端的机器，PATH 最前挂了一个 ssh 透明 shim，
看到命令里出现 `tmux` 就上报 (user, host, session) 给本机控制面（8787），
控制面让画布自动拉起 `ssh -t <user>@<host> tmux new -As <session>` 的观察窗。
你的正常 ssh 用法（scp/rsync/git over ssh）不受任何影响。

## 本机构建约定

- `npm run dev` 起 web(:5173)+server(:8787)；回归在 `scripts/e2e-pty.mjs`（需 dev 栈 + headless Chrome :9222）。
- 改 `server/src/*` 会触发 node --watch 热重启，跑 e2e 前留 ≥4s 缓冲。
