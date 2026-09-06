// postinstall 自愈：某些安装环境（npm install-scripts 沙箱、受限文件系统、
// 从 tarball 解包丢权限）会剥掉 node-pty 预编译 spawn-helper 的执行位，
// 症状是开终端时 posix_spawnp failed。装完统一补回 755；没配到文件就静默通过。
// Windows 的 prebuilds 里没有 spawn-helper，天然跳过。
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prebuilds = path.join(root, "node_modules", "node-pty", "prebuilds");
let fixed = 0;
if (existsSync(prebuilds)) {
  for (const plat of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, plat, "spawn-helper");
    if (!existsSync(helper)) continue;
    if (!(statSync(helper).mode & 0o111)) {
      chmodSync(helper, 0o755);
      fixed++;
      console.log(`[fix-node-pty] chmod +x ${plat}/spawn-helper`);
    }
  }
}
console.log(fixed ? `[fix-node-pty] 修复 ${fixed} 处执行位` : "[fix-node-pty] spawn-helper 权限正常");
