// 回归：画布背景布跟随主题 —— light 浅底 / dark 深底；terminal 屏幕保持深色不受主题影响
// 用法：dev 栈 + headless Chrome(:9222) → node scripts/e2e-theme.mjs
import { WebSocket } from "ws";

const DEBUG = "http://127.0.0.1:9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) failures++;
};

const tabs = await (await fetch(`${DEBUG}/json/list`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.on("open", r));
let id = 0;
const pending = new Map();
ws.on("message", (b) => {
  const m = JSON.parse(String(b));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const call = (method, params = {}) =>
  new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (e) => {
  const r = await call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};

// 页面内取色：背景可能是 oklch(...) 或 rgb(...)，统一归一成感知亮度 0..1
const SNAP = `(() => {
  const lum = (c) => {
    if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return null;
    let m = c.match(/oklch\\(\\s*([\\d.]+)(%?)/);
    if (m) return parseFloat(m[1]) / (m[2] ? 100 : 1);
    m = c.match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
    if (m) { const [r,g,b] = [+m[1],+m[2],+m[3]].map(v => { v/=255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
      return 0.2126*r + 0.7152*g + 0.0722*b; }
    return null;
  };
  const rf = document.querySelector('.react-flow');
  const termBody = document.querySelector('.react-flow__node-term .bg-\\\\[\\\\#0c0e13\\\\]') || document.querySelector('.react-flow__node-term');
  const bg = (el) => el ? lum(getComputedStyle(el).backgroundColor) : null;
  return {
    rfClass: rf ? [...rf.classList].filter(c=>c==='dark'||c==='light').join() : null,
    rfLum: bg(rf),
    bodyLum: bg(document.body),
    termLum: bg(termBody),
    toggle: [...document.querySelectorAll('button')].some(x=>/🌙|☀️/.test(x.textContent)),
    ls: localStorage.getItem('heroui-theme'),
    attr: document.documentElement.getAttribute('data-theme'),
  };
})()`;

const shot = async (name) => {
  const s = await call("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs");
  fs.writeFileSync(name, Buffer.from(s.data, "base64"));
};

await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// 干净基线 + 主题复位为 dark
await call("Page.navigate", { url: "http://localhost:5173/" });
await sleep(2500);
await evalJs(`localStorage.removeItem('sshx.canvas.nodes'); localStorage.removeItem('sshx.canvas.edges'); localStorage.setItem('heroui-theme','dark'); 1`);
await call("Page.reload");
await sleep(2500);

// 1. dark：画布布底应为深色
let s = await evalJs(SNAP);
ok("dark 画布底为深色", s.rfClass === "dark" && s.rfLum !== null && s.rfLum < 0.25, JSON.stringify(s));

// 2. 建一个真终端后切 light（顶栏 🌙 按钮）
await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='＋终端'); b?.click(); return 1; })()`);
await sleep(4000);
await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/🌙|☀️/.test(x.textContent)); b?.click(); return 1; })()`);
await sleep(1200);
s = await evalJs(SNAP);
ok("light 画布底变浅色布", s.rfClass === "light" && s.rfLum !== null && s.rfLum > 0.85, `lum=${s.rfLum?.toFixed(3)} class=${s.rfClass}`);
ok("light 下 body 同步浅色", s.bodyLum !== null && s.bodyLum > 0.85, String(s.bodyLum?.toFixed(3)));
ok("light 下终端屏幕仍保持深色", s.termLum !== null && s.termLum < 0.15, String(s.termLum?.toFixed(3)));
await shot("/tmp/theme-light.png");

// 3. 主题持久化：reload 后仍是 light
await call("Page.reload");
for (let t = 400; t <= 3200; t += 700) {
  await sleep(700);
  console.log(`  t≈${t}ms: ${JSON.stringify(await evalJs(`({attr: document.documentElement.getAttribute('data-theme'), rf: document.querySelector('.react-flow') ? [...document.querySelector('.react-flow').classList].join(' ') : 'no-rf'})`))}`);
}
s = await evalJs(SNAP);
ok("reload 后主题保持 light", s.rfClass === "light" && s.rfLum > 0.85, `class=${s.rfClass} attr=${s.attr} ls=${s.ls}`);
ok("reload 后节点已恢复(持久化未坏)", await evalJs(`document.querySelectorAll('.react-flow__node').length`) === 1);

// 4. 切回 dark 再验一遍
await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/🌙|☀️/.test(x.textContent)); b?.click(); return 1; })()`);
await sleep(1000);
s = await evalJs(SNAP);
ok("切回 dark 画布底为深色", s.rfClass === "dark" && s.rfLum < 0.25, `lum=${s.rfLum?.toFixed(3)}`);
await shot("/tmp/theme-dark.png");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
