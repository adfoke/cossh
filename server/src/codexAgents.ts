// 把「远端 tmux 共享工位」协议以带标记的幂等块写入 ~/.codex/AGENTS.md（codex 全局规矩）。
// 幂等：块已存在 → 原位替换；不存在 → 追加。点一百次只有一份，用户自己的内容绝不触碰。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENTS_PATH = path.join(process.env.SSHX_CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"), "AGENTS.md");
const BEGIN = "<!-- sshx:remote-tmux:start -->";
const END = "<!-- sshx:remote-tmux:end -->";

export const RULE_BLOCK = `${BEGIN}
## 远程操作协议（SSHX 共享工位 · 由 sshx 画布维护）

在远程机器上干活一律走远端 tmux 会话——SSHX 画布会自动弹出观察窗直播，用户随时可围观/抢键盘：

1. 建会话（幂等）：\`ssh <user>@<host> tmux new -d -s <session>\`（会话名建议 \`codex-<主机短名>\`）
2. 执行：\`ssh <user>@<host> tmux send-keys -t <session> '<命令>' Enter\`
3. 读屏：\`ssh <user>@<host> tmux capture-pane -pt <session> -S -40\`
4. 需要交互/长时运行的程序只能走上面的循环；禁止一次性 \`ssh host 命令\` 跑交互式任务。
5. 收尾自行清理：\`ssh <user>@<host> tmux kill-session -t <session>\`（用户可能要看现场就别删）。
${END}`;

export function writeAgentsRule(): { path: string; created: boolean } | { error: string } {
  let existing = "";
  try {
    existing = fs.readFileSync(AGENTS_PATH, "utf8");
  } catch {
    /* 首次 */
  }
  const re = /<!-- sshx:remote-tmux:start -->[\s\S]*?<!-- sshx:remote-tmux:end -->/;
  let out: string;
  let created = false;
  if (re.test(existing)) {
    out = existing.replace(re, RULE_BLOCK); // 原位更新
  } else {
    out = (existing.trimEnd() ? existing.trimEnd() + "\n\n" : "") + RULE_BLOCK + "\n";
    created = !existing.trim();
  }
  try {
    fs.mkdirSync(path.dirname(AGENTS_PATH), { recursive: true, mode: 0o700 });
    const tmp = AGENTS_PATH + ".tmp";
    fs.writeFileSync(tmp, out, "utf8");
    fs.renameSync(tmp, AGENTS_PATH);
  } catch (e) {
    return { error: (e as Error).message };
  }
  return { path: AGENTS_PATH, created };
}

export function agentsRuleState(): { exists: boolean; path: string } {
  try {
    return { exists: fs.readFileSync(AGENTS_PATH, "utf8").includes(BEGIN), path: AGENTS_PATH };
  } catch {
    return { exists: false, path: AGENTS_PATH };
  }
}
