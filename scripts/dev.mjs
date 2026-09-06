// 一键启动：并行跑 web (vite:5173) 和 server (:8787)
import { spawn } from "node:child_process";

const jobs = [
  { name: "server", args: ["-w", "server", "run", "dev"] },
  { name: "web", args: ["-w", "web", "run", "dev"] },
];

const children = jobs.map(({ name, args }) => {
  const p = spawn("npm", args, { stdio: "inherit", env: process.env });
  p.on("exit", (code) => {
    console.log(`\n[${name}] exited with code ${code}`);
    process.exit(code ?? 0);
  });
  return p;
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const c of children) c.kill(sig);
    process.exit(0);
  });
}
