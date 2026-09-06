// 回归：真 PTY 终端画布（＋终端按钮 / 键盘输入 / tty 真设备 / resize 透传 / 多窗隔离 /
// 最小化进程不死 / 关闭+撤销恢复 / 刷新持久化 / 旧 host/chat 节点淘汰 / 退出检测 / 无泄漏）
// 用法：dev 栈 + headless Chrome(:9222) → node scripts/e2e-pty.mjs
// 寻的约定：一律 pid → nodeId（__sshxRf 钩子），不依赖 DOM 顺序；两窗摆成不重叠再交互。
import { WebSocket } from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEBUG = "http://127.0.0.1:9222";
const APP = "http://127.0.0.1:5173/";
const HEALTH = "http://127.0.0.1:8787/api/health";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
  if (!cond) failures++;
};

/* ── CDP 连接 ── */
const all = await (await fetch(`${DEBUG}/json/list`)).json();
const pages0 = all.filter((t) => t.type === "page");
for (const t of pages0.slice(1)) await fetch(`${DEBUG}/json/close/${t.id}`); // 清掉本 Chrome 的遗留页
await sleep(600);
const tabs = await (await fetch(`${DEBUG}/json/list`)).json();
const tab = tabs.find((t) => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.on("open", r));
let id = 0;
const pending = new Map();
ws.on("message", (b) => {
  const m = JSON.parse(String(b));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const call = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJs = async (e) => {
  const r = await call("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval threw: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};

/* ── 页面工具 ── */
let VPW = 1400, VPH = 860; // 视口边界，goto 后刷新

const goto = async (url) => {
  await call("Page.navigate", { url });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (url === "about:blank") return sleep(600);
    if (await evalJs(`!!document.querySelector('.react-flow')`)) {
      const vp = await evalJs(`({ w: innerWidth, h: innerHeight })`);
      VPW = vp.w - 8; VPH = vp.h - 8;
      return sleep(500);
    }
    await sleep(200);
  }
  throw new Error("goto timeout: " + url);
};
const click = async (x, y) => {
  for (const type of ["mousePressed", "mouseReleased"])
    await call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
};
const clickEl = async (jsExpr) => {
  const rect = await evalJs(`(() => { const b = (${jsExpr}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error("clickEl: element not found: " + jsExpr);
  if (rect.x < 0 || rect.y < 0 || rect.x > VPW || rect.y > VPH)
    throw new Error(`clickEl: offscreen (${rect.x.toFixed(0)},${rect.y.toFixed(0)}) — 先 bringIntoView: ${jsExpr.slice(0, 60)}`);
  await click(rect.x, rect.y);
};
/** 可打印字符：keyDown(带 text) 时 Chrome 自动补 textInput，不能再发 char 帧（会双倍回显） */
const typeChar = async (ch) => {
  const base = /^[a-zA-Z]$/.test(ch)
    ? { key: ch, code: "Key" + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) }
    : /^[0-9]$/.test(ch)
      ? { key: ch, code: "Digit" + ch, windowsVirtualKeyCode: ch.charCodeAt(0) }
      : ch === " "
        ? { key: " ", code: "Space", windowsVirtualKeyCode: 32 }
        : { key: ch };
  await call("Input.dispatchKeyEvent", { ...base, type: "keyDown", text: ch, unmodifiedText: ch });
  await call("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
};
const typeText = async (s) => {
  for (const ch of s) { await typeChar(ch); await sleep(12); }
};
const pressEnter = async () => {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
};
const health = async () => (await fetch(HEALTH)).json();
const addTermBtn = `[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='＋终端')`;

/* ── pid → nodeId 寻的层 ── */
const nodePidMap = () =>
  evalJs(`(() => { const out = []; for (const n of window.__sshxRf.getNodes()) {
    const el = document.querySelector('.react-flow__node[data-id="' + n.id + '"]');
    const m = el?.textContent.match(/⌗(\\d+)/); out.push({ id: n.id, pid: m ? m[1] : null, title: n.data?.title });
  } return out; })()`);
/** 读某节点终端 buffer 全文 */
const screenOf = (nid) => `(() => {
  const el = document.querySelector('.react-flow__node[data-id="${nid}"] .term-host');
  const t = el?.__xterm; if (!t) return null;
  const b = t.buffer.active; const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\\n');
})()`;
const waitScreen = async (nid, re, ms = 6000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await evalJs(screenOf(nid));
    if (s && re.test(s)) return s;
    await sleep(150);
  }
  return null;
};
/** 真鼠标聚焦某节点终端并断言焦点确实落在它身上（错位即炸，不再歪打正着） */
const focusTerm = async (nid) => {
  const // 落点在屏幕中下部偏左：左上角 +24px 在「最大化窗」下会扎进悬浮 TopBar 的底缘（实测抢焦到 BODY）
  rect = await evalJs(`(() => { const el = document.querySelector('.react-flow__node[data-id="${nid}"] .term-host'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + Math.min(120, r.width * 0.3), y: r.y + Math.max(r.height * 0.5, 80) }; })()`);
  if (!rect) throw new Error("focusTerm: no node " + nid);
  await click(rect.x, rect.y);
  await sleep(150);
  const hit = await evalJs(`document.activeElement?.closest('.react-flow__node')?.dataset.id ?? null`);
  if (hit !== nid) {
    const forensics = await evalJs(`(() => { const under = document.elementFromPoint(${Math.round(rect.x)}, ${Math.round(rect.y)});
      return { hit: under?.closest('.react-flow__node')?.dataset.id ?? String(under?.className).slice(0, 40),
        zs: [...document.querySelectorAll('.react-flow__node')].map(w => [w.dataset.id.slice(-6), getComputedStyle(w).zIndex, Math.round(w.getBoundingClientRect().x), Math.round(w.getBoundingClientRect().y)]) }; })()`);
    throw new Error(`focusTerm: focus went to ${hit}, expected ${nid} :: ${JSON.stringify(forensics)}`);
  }
};
const runCmd = async (nid, cmd) => { await focusTerm(nid); await typeText(cmd); await pressEnter(); };
const winBtn = (nid, label) =>
  `document.querySelectorAll('.react-flow__node[data-id="${nid}"] button[aria-label="${label}"]')[0]`;
/** 把某窗搬回可视区：左上角落到屏幕 (60,80)，宽 760 的窗在常见视口下必然完整可见 */
const bringIntoView = async (nid) => {
  // 搬回左上安全区，且 zIndex 顶到最高——否则两个窗先后 bring 会精确叠在 (60,80)，
  // 后开的窗在下面，点击被先聚焦过的窗偷走（obs3 崩点实录）
  await evalJs(`(() => { const p = window.__sshxRf.screenToFlowPosition({ x: 60, y: 80 });
    window.__sshxRf.setNodes(ns => { const top = Math.max(0, ...ns.map(n => n.zIndex ?? 0));
      // 选中态自带 1000+ 置顶（obs6 取证实录：手工 zIndex=2 被选中窗的 1001 压住偷点击）
      return ns.map(n => n.id === ${JSON.stringify(nid)}
        ? { ...n, position: p, zIndex: top + 1, selected: true }
        : { ...n, selected: false }); }); return 1; })()`);
  await sleep(250);
};
const layout = (aId, bId) =>
  evalJs(`window.__sshxRf.setNodes(ns => ns.map(n =>
    n.id === ${JSON.stringify(aId)} ? { ...n, position: { x: -640, y: -360 } } :
    n.id === ${JSON.stringify(bId)} ? { ...n, position: { x: 220, y: 100 } } : n)); 1`);
const fit = () => evalJs(`window.__sshxRf.fitView({ padding: 0.15 }); 1`);
const rfCount = () => evalJs(`window.__sshxRf.getNodes().length`);

/** 真交互填输入框：三击全选 → insertText 覆盖（React 受控组件走原生 input 事件） */
const setField = async (elId, value) => {
  const rect = await evalJs(`(() => { const b = document.getElementById(${JSON.stringify(elId)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!rect) throw new Error("setField: no input #" + elId);
  for (const type of ["mousePressed", "mouseReleased"])
    await call("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 3, buttons: type === "mousePressed" ? 1 : 0 });
  await sleep(80);
  await call("Input.insertText", { text: value });
  await sleep(120);
};
const dialogGone = async (ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await evalJs(`document.body.textContent.includes("配置 Codex API")`))) return true;
    await sleep(150);
  }
  return false;
};
const saveBtnExpr = `[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='保存')`;

/* ── 0. 基线：清场重载 ── */
// 三方一起清：localStorage（窗）+ 事件环（防上一轮崩溃残留被本轮开局重放爆窗）；
// clear 跑两遍夹掉 in-flight 上报
await goto(APP);
for (let i = 0; i < 2; i++) {
  await fetch(HEALTH.replace("/api/health", "/api/observe/clear"), { method: "POST" });
  await sleep(1200);
}
await evalJs(`localStorage.clear(); 1`);
await sleep(700); // 让轮询期间可能开的窗先落盘完毕，再补一刀 clear（防 debounce 写回）
await evalJs(`localStorage.clear(); 1`);
await goto(APP);
// 本机可能另有合法客户端（比如桌面上开着的标签页），计数一律用前后 diff 判定

ok("TopBar 只剩 ＋终端（三老按钮全下线）",
  await evalJs(`(() => { const ts=[...document.querySelectorAll('button')].map(x=>x.textContent.trim());
    return !ts.some(t=>t.includes('＋主机')||t.includes('＋AI')||t.includes('＋终端观察')||t.includes('演示'))&&ts.some(t=>t==='＋终端') })()`));
ok("空态引导卡出现", await evalJs(`[...document.querySelectorAll('button')].some(x=>x.textContent.includes('开第一个终端'))`));

/* ── 0b. 红色「须知」：在位、在左、三条内容、可关 ── */
const noticeBtn = `[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='须知')`;
ok("须知按钮存在且 danger 红色样式", await evalJs(`(() => { const b = ${noticeBtn}; return !!b && /danger/.test(b.className); })()`));
ok("须知排在 ＋终端 左边", await evalJs(`(() => { const n = ${noticeBtn}; const t = [...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='＋终端');
  return !!n && !!t && !!(n.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); })()`));
await clickEl(noticeBtn);
let nShown = false;
for (let i = 0; i < 20 && !nShown; i++) { // 弹层入场动画窗口，轮询到 2.5s
  await sleep(150);
  nShown = await evalJs(`(() => { const d = document.querySelector('[role="dialog"]'); if (!d) return false; const b = d.textContent;
    return /本程序依赖/.test(b) && /npm/.test(b) && /codex-cli/.test(b) && /安装[ ]*codex[ ]*之后请让[ ]*codex[ ]*帮忙安装/.test(b) && /tmux/.test(b); })()`);
}
ok("点击展示三条须知（npm / codex-cli / tmux 逐条在位）", nShown,
  nShown ? "" : await evalJs(`(() => { const d = document.querySelector('[role="dialog"]'); return d ? "dialog-but-text-mismatch" : "no-dialog"; })()`));
// react-aria 的 Esc 监听挂在 dialog 焦点子树里：必须从 activeElement 派发（document 级派发够不到）
await evalJs(`(document.activeElement || document).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
await sleep(400);
ok("Esc 可关闭须知弹层", !(await evalJs(`!!document.querySelector('[role="dialog"]')`)),
  String(await evalJs(`document.activeElement?.className?.slice(0,30)`)));

/* ── 1. 旧节点淘汰迁移 ── */
await evalJs(`(() => { localStorage.setItem('sshx.canvas.nodes', JSON.stringify([
  {id:'host-x',type:'host',position:{x:0,y:0},data:{hostId:'host-local',name:'本机'}},
  {id:'chat-x',type:'chat',position:{x:10,y:10},data:{title:'AI 对话'}},
  {id:'term-x',type:'term',position:{x:20,y:20},data:{title:'旧观察窗',hostId:'host-local',session:'demo',win:'max'}}])); return 1 })()`);
await goto(APP);
ok("迁移：host/chat 节点被淘汰，只剩 term", (await rfCount()) === 1);
const maxW = await evalJs(`document.querySelector('.react-flow__node[data-id="term-x"]')?.getBoundingClientRect().width ?? 0`);
ok("迁移：老 term 的 win:max 仍生效", maxW > 800, `width=${maxW}`);
const mig = await nodePidMap();
ok("迁移：标题保留 + 脏字段剥离后能开出真 PTY", mig.length === 1 && mig[0].title === "旧观察窗" && !!mig[0].pid, JSON.stringify(mig));
const migId = mig[0].id;
await runCmd(migId, "echo MIGRATED_$((40+2))");
ok("迁移后的窗口可直接交互", !!(await waitScreen(migId, /MIGRATED_42/)));
await evalJs(`localStorage.clear(); 1`);
await goto(APP);

/* ── 2. ＋终端 → 真 PTY 起来 ── */
const hPreAdd = (await health()).ptys; // diff 断言：别的客户端中途上下线也不影响判定
await clickEl(addTermBtn);
await sleep(1200);
const m1 = await nodePidMap();
const A = m1[0];
ok("点＋终端建出一个终端窗", (await rfCount()) === 1 && !!A?.pid, JSON.stringify(m1));
ok("xterm 已挂载", await evalJs(`!!document.querySelector('.react-flow__node[data-id="${A.id}"] .xterm')`));
ok("健康接口 ptys 计数 +1", (await health()).ptys === hPreAdd + 1, JSON.stringify(await health()));

/* ── 3. 键盘输入 → shell → 输出（真 tty 设备！） ── */
await runCmd(A.id, "tty");
const ttyOut = await waitScreen(A.id, /\/dev\/ttys\d+/);
ok("tty 返回 /dev/ttysNNN（字节级真 PTY，非管道假终端）", !!ttyOut, ttyOut?.match(/\/dev\/ttys\d+/)?.[0] ?? "timeout");
await runCmd(A.id, "echo PTY_$((6*7))");
ok("echo 计算结果回显（字符级键入 → stdin → stdout 全链路）", !!(await waitScreen(A.id, /PTY_42/)));

/* ── 4. 第二个终端：摆开 → 进程隔离 + resize 透传 ── */
await clickEl(addTermBtn);
await sleep(1200);
const m2 = await nodePidMap();
const B = m2.find((x) => x.id !== A.id);
ok("两个终端窗并存", m2.length === 2);
ok("两窗 pid 不同（各自独立 shell 进程）", !!A.pid && !!B?.pid && A.pid !== B.pid, `${A.pid} vs ${B?.pid}`);
await layout(A.id, B.id);
await fit();
await sleep(500);
await runCmd(B.id, "echo ONLY_B_$((3*3))");
ok("B 窗输入回显", !!(await waitScreen(B.id, /ONLY_B_9/)));
ok("A 窗没串到 B 的输出（会话隔离）", !/ONLY_B_9/.test((await evalJs(screenOf(A.id))) ?? "__none__"));
await runCmd(B.id, "stty size"); // 基线尺寸
await waitScreen(B.id, /^\s*\d+\s+\d+\s*$/m);
await bringIntoView(B.id); // 真鼠标走产品路径，前提：按钮在视口内
await clickEl(winBtn(B.id, "maximize"));
await sleep(1000); // fit + 80ms debounce + pty.resize
await runCmd(B.id, "stty size");
const big = await waitScreen(B.id, /^\s*\d+\s+\d{3,}\s*$/m, 5000);
ok("最大化后 stty 报告列数 >100（resize 控制帧真打到了内核 PTY）", !!big, big?.match(/^\s*\d+\s+\d{3,}\s*$/m)?.[0].trim() ?? "timeout");

/* ── 5. 最小化：进程与缓冲活着 ── */
await bringIntoView(B.id);
await clickEl(winBtn(B.id, "maximize")); // 上轮是 max 态：点 □ 退出最大化 → normal
await sleep(400);
await runCmd(B.id, "sleep 0.8; echo ALIVE_$((20+1))");
const hPreMin = (await health()).ptys;
await bringIntoView(B.id);
await clickEl(winBtn(B.id, "minimize")); // 命令跑着时最小化
await sleep(300);
ok("最小化瞬间 xterm DOM 不卸载（缓冲与前台进程保活的前提）",
  await evalJs(`!!document.querySelector('.react-flow__node[data-id="${B.id}"] .xterm')`));
ok("最小化期间 shell 进程仍在服务端口账上", (await health()).ptys === hPreMin, JSON.stringify(await health()));
await sleep(900); // 让 sleep 0.8 在"看不见"的时候跑完
await bringIntoView(B.id);
await clickEl(winBtn(B.id, "minimize")); // 还原
await sleep(400);
ok("还原后能读到最小化期间产生的输出（进程没死、输出没丢）",
  /ALIVE_21/.test((await evalJs(screenOf(B.id))) ?? ""));

/* ── 6. 关闭 → ⌘Z 复活 → 重做 ── */
const hPreClose = (await health()).ptys;
await bringIntoView(B.id); // ✕ 在标题栏最右端，不搬窗就会点到视口外（第一轮 7 红的根因）
await clickEl(winBtn(B.id, "close"));
await sleep(500);
ok("✕ 关闭一个窗后只剩 1 个", (await rfCount()) === 1);
ok("关窗即收割 PTY 进程（ws close → kill）", (await health()).ptys === hPreClose - 1, JSON.stringify(await health()));
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,bubbles:true}))`);
await sleep(900);
const m3 = await nodePidMap();
ok("⌘Z 找回关掉的终端窗", m3.length === 2, JSON.stringify(m3));
const B2 = m3.find((x) => x.id === B.id) ?? m3.find((x) => x.id !== A.id);
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,shiftKey:true,bubbles:true}))`);
await sleep(600);
ok("⇧⌘Z 重做回到关闭后状态", (await rfCount()) === 1);
void B2;

/* ── 7. exit 检测 ── */
const hPreExit = (await health()).ptys;
await runCmd(A.id, "exit");
const exited = await waitScreen(A.id, /shell 已退出/, 5000);
ok("shell exit → 窗口打出退出标记", !!exited);
ok("shell 进程随 exit 收割（计数 -1）", (await health()).ptys === hPreExit - 1, JSON.stringify(await health()));

/* ── 8. 刷新持久化：窗回来、shell 重开 ── */
await goto(APP);
await sleep(800);
ok("刷新后终端窗原位恢复", (await rfCount()) === 1);
const m4 = await nodePidMap();
const A2 = m4[0];
ok("刷新后自动重开了新 shell（pid 变化）", !!A2?.pid && A2.pid !== A.pid, `old=${A.pid} new=${A2?.pid}`);
await runCmd(A2.id, "echo RELOAD_$((1+1))");
ok("重开的 shell 可正常交互", !!(await waitScreen(A2.id, /RELOAD_2/)));

/* ── 8b. 📦 安装 Codex：先检查、缺才装、runOnOpen 用后即焚 ── */
await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('安装 Codex'))`);
await sleep(1500);
const mC = (await nodePidMap()).find((x) => /Codex/.test(String(x.title)));
ok("Codex 安装窗出现且带自己的 PTY", !!mC?.pid, JSON.stringify(mC));
// 输入回显会包含命令里的全部字面量（未检测到/安装失败都在）——判定只用「输出独有」token：
//   版本行 "codex-cli x.y.z"（两分支共同终点）、"已装过：/绝对路径"（输入回显是 "：$(command"）、
//   npm 自身的 "added N packages in"（命令字面量里没有 added 一词）
const ran = await waitScreen(mC.id, /codex-cli \d+\.\d+/, 300_000);
ok("自动执行到终态：输出了 codex 版本行", !!ran, ran?.match(/codex-cli [\d.]+/)?.[0] ?? "timeout");
const hadIt = !!ran && /已装过[：:]\s*\/\S+codex/.test(ran);
const installedNow = !!ran && /added \d+ packages? in/.test(ran);
ok("分支判定成立：本机已有(路径行) 或 本次真装(npm added 行)，二者居一", hadIt || installedNow,
   `已装过=${hadIt} 刚装=${installedNow}`);
ok("runOnOpen 用后即焚：节点 data 已抹除（刷新不会重跑安装）",
  await evalJs(`(() => { const n = window.__sshxRf.getNodes().find(n => n.id === ${JSON.stringify(mC.id)}); return !!n && n.data.runOnOpen == null; })()`));

/* ── 8c-8e. Codex 三连：只打隔离演练场，绝不碰真实 ~/.codex ──
   服务端 SSHX_CODEX_HOME 可整体改写配置目录；GET /api/codex/config 回读的路径
   不是真 HOME 默认位才算隔离。血泪教训（2026-09-06）：旧「备份→覆写→恢复」设计里
   8c 显式调 restoreOnce 把 exit 钩子标 done 作废，8d 随后覆写并在收尾 rmSync——
   只要用户真配置存在就会被这套流程吃掉。现在：路径不隔离就整段 SKIP。 */
const cfgProbe = await (await fetch(HEALTH.replace("/api/health", "/api/codex/config"))).json();
const CODEX_FILES = { cfg: cfgProbe.configPath, env: cfgProbe.envPath };
const codexIsolated = !!cfgProbe.configPath && cfgProbe.configPath !== path.join(os.homedir(), ".codex", "config.toml");
if (!codexIsolated) {
  console.log("SKIP  8c/8d/8e（server 直写真实 ~/.codex，测试拒碰现场；全量请 SSHX_CODEX_HOME=/tmp/codex-fixture npm run dev）");
} else {
// 预置「用户已有配置」靶子（就在演练场里，用完即弃）
fs.mkdirSync(path.dirname(CODEX_FILES.cfg), { recursive: true });
fs.writeFileSync(CODEX_FILES.cfg, 'sandbox_mode = "workspace-write"\n\n[my_custom]\nkeep = "me"\n');
fs.writeFileSync(CODEX_FILES.env, "SOME_OTHER=keepme\n");

await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('配置 Codex'))`);
await sleep(700);
ok("🔑 按钮打开配置弹层", await evalJs(`document.body.textContent.includes("配置 Codex API")`));
await setField("codex-base-url", "http://127.0.0.1:9/v1");
await setField("codex-api-key", "sk-e2e-TESTKEY-123456");
await setField("codex-model", "gpt-5-codex");
{ // 协议下拉：点开后打字母走原生 typeahead 选中 chat
  const rect = await evalJs(`(() => { const b = document.getElementById("codex-wire-api"); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await click(rect.x, rect.y);
  await sleep(80);
  await typeText("chat");
}
const vals = await evalJs(`({ u: document.getElementById("codex-base-url").value, k: document.getElementById("codex-api-key").value, m: document.getElementById("codex-model").value, w: document.getElementById("codex-wire-api").value })`);
ok("表单四字段真输入到位", vals.u === "http://127.0.0.1:9/v1" && vals.k === "sk-e2e-TESTKEY-123456" && vals.m === "gpt-5-codex" && vals.w === "chat", JSON.stringify(vals));
await clickEl(saveBtnExpr);
ok("保存后弹层自动关闭（成功态）", await dialogGone());

const cfgOut = fs.readFileSync(CODEX_FILES.cfg, "utf8");
ok("config.toml 写入 provider 三要素（base_url/wire_api/model_provider）",
  /base_url = "http:\/\/127\.0\.0\.1:9\/v1"/.test(cfgOut) && /wire_api = "chat"/.test(cfgOut) && /model_provider = "sshx"/.test(cfgOut), cfgOut.split("\n").length + " lines");
ok("合并安全：用户已有的 [my_custom] 与 sandbox_mode 原样保留",
  /\[my_custom\]/.test(cfgOut) && /sandbox_mode = "workspace-write"/.test(cfgOut));
const envOut = fs.readFileSync(CODEX_FILES.env, "utf8");
ok("API key 落到 ~/.codex/.env（codex 官方 dotenv 位）", /OPENAI_API_KEY=sk-e2e-TESTKEY-123456/.test(envOut));
ok(".env 其它变量未被清掉", /SOME_OTHER=keepme/.test(envOut));
ok(".env 权限 0600", (fs.statSync(CODEX_FILES.env).mode & 0o777) === 0o600);
const apiGet = await (await fetch(HEALTH.replace("/api/health", "/api/codex/config"))).text();
ok("读取接口脱敏：回 hasKey 但绝不回 key 本体", /"hasKey":true/.test(apiGet) && !apiGet.includes("sk-e2e-TESTKEY"), apiGet.slice(0, 90));

// 留空 key 再存一次：必须保持不动
await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('配置 Codex'))`);
await sleep(700);
const prefill = await evalJs(`document.getElementById("codex-base-url").value`);
ok("重开弹层回填已存配置（key 除外）", prefill === "http://127.0.0.1:9/v1", prefill);
await clickEl(saveBtnExpr); // key 输入框保持空
await dialogGone();
ok("key 留空再保存：旧 key 原封不动",
  /OPENAI_API_KEY=sk-e2e-TESTKEY-123456/.test(fs.readFileSync(CODEX_FILES.env, "utf8")));

// 非法地址 → 服务端拒绝 + 文件不动
await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('配置 Codex'))`);
await sleep(700);
await setField("codex-base-url", "not-a-url");
await clickEl(saveBtnExpr);
await sleep(600);
ok("非法地址被拒（表单红字），弹层不关", await evalJs(`document.body.textContent.includes("API 地址需要是")`) && !(await evalJs(`!document.body.textContent.includes("配置 Codex API")`)));
ok("非法请求没污染 config.toml", /base_url = "http:\/\/127\.0\.0\.1:9\/v1"/.test(fs.readFileSync(CODEX_FILES.cfg, "utf8")));
await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='取消')`);
await sleep(300);

/* ── 8d. ↓ 获取模型列表：假网关 + 服务端代理 + 已存 key 兜底 + chip 选模型 ── */
let lastAuth = "";
const fakeApi = http.createServer((req, res) => {
  lastAuth = String(req.headers.authorization ?? "");
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  // 关键设计：裸 /models 故意 404，只有 /v1/models 能用——
  // 这样「/v1 候选探测」才是被真正测到的（上一版两路都通，突变不红=断言说谎）
  if (req.url === "/v1/models") {
    if (lastAuth.includes("sk-e2e-TESTKEY-123456")) send(200, { data: [{ id: "gpt-mock-1" }, { id: "gpt-mock-2" }, { id: "deepseek-v3" }] });
    else send(401, { error: { message: "bad key" } });
  } else send(404, { error: "nf" });
});
await new Promise((r) => fakeApi.listen(8799, "127.0.0.1", r));
// 现场再种一次：.env 有 key、config 只有用户键
fs.writeFileSync(CODEX_FILES.cfg, 'sandbox_mode = "workspace-write"\n');
fs.writeFileSync(CODEX_FILES.env, "OPENAI_API_KEY=sk-e2e-TESTKEY-123456\n");

await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('配置 Codex'))`);
await sleep(700);
await setField("codex-base-url", "http://127.0.0.1:8799"); // 故意不带 /v1：考候选探测
await clickEl(`document.getElementById("codex-fetch-models")`);
const chipsUp = await evalJs(`(() => {
  const t0 = Date.now();
  return new Promise((r) => { const q = setInterval(() => {
    if (document.querySelector('[data-model-chip="deepseek-v3"]') || Date.now() - t0 > 14000) { clearInterval(q); r(!!document.querySelector('[data-model-chip="deepseek-v3"]')); }
  }, 200); });
})()`);
ok("「↓ 获取」渲染出模型 chips（/v1 候选探测生效）", chipsUp === true);
await sleep(400); // 让请求落定
ok("表单 key 留空：服务端用 .env 已存 key 拉取（不回显、不央求用户重填）", lastAuth.includes("sk-e2e-TESTKEY-123456"), lastAuth.slice(0, 18) + "…");
await clickEl(`document.querySelector('[data-model-chip="deepseek-v3"]')`);
await sleep(200);
ok("点 chip 回填模型输入框", (await evalJs(`document.getElementById("codex-model").value`)) === "deepseek-v3");
await clickEl(saveBtnExpr);
await dialogGone();
ok("选中的模型随保存进 config.toml", /model = "deepseek-v3"/.test(fs.readFileSync(CODEX_FILES.cfg, "utf8")));

await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.includes('配置 Codex'))`);
await sleep(700);
await setField("codex-api-key", "sk-whatever-wrong");
await clickEl(`document.getElementById("codex-fetch-models")`);
await sleep(1500);
const err401 = await evalJs(`document.querySelector('[data-test="models-err"]')?.textContent ?? ""`);
ok("错 key → 红字点名 401 且不渲染 chips", /401/.test(err401) && !(await evalJs(`!!document.querySelector('[data-model-chip]')`)), err401);
await setField("codex-base-url", "http://127.0.0.1:9"); // 死地址：直连+代理双失败路径
await clickEl(`document.getElementById("codex-fetch-models")`);
let deadErr = "";
for (let i = 0; i < 40; i++) {
  await sleep(700);
  deadErr = await evalJs(`document.querySelector('[data-test="models-err"]')?.textContent ?? ""`);
  if (/拉取失败/.test(deadErr)) break;
}
ok("死地址 → 明示失败原因（代理分支或未配置提示）",
  /直连(与.*代理都试过|失败)/.test(deadErr), deadErr.slice(0, 80));
await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='取消')`);
await sleep(300);
fakeApi.close();
for (const f of Object.values(CODEX_FILES)) fs.rmSync(f, { force: true });
ok("8d 现场已清理", !fs.existsSync(CODEX_FILES.cfg) && !fs.existsSync(CODEX_FILES.env));

/* ── 8e. 📜 Codex 规矩：幂等标记块写演练场 AGENTS.md + 弹窗验货 ── */
{
  const AGF = path.join(path.dirname(CODEX_FILES.cfg), "AGENTS.md");
  fs.writeFileSync(AGF, "我的自定义规矩：永远不要碰生产库\n"); // 合并安全靶子
  const ruleBtn = `[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Codex 规矩'))`;
  await clickEl(ruleBtn);
  await sleep(2000);
  const mR = (await nodePidMap()).find((x) => /Codex 规矩/.test(String(x.title)));
  ok("📜 按钮开出验货窗（带 PTY）", !!mR?.pid, JSON.stringify(mR));
  // 输入回显里有 sed 参数"sshx:remote-tmux"，判定只用输出独有词
  const shown = await waitScreen(mR.id, /远程操作协议|已创建|已更新/, 9000);
  ok("验货窗打出块内容/状态（输出独有 token）", !!shown, shown?.match(/(远程操作协议|已创建|已更新)/)?.[0] ?? "timeout");
  const txt1 = fs.readFileSync(AGF, "utf8");
  ok("标记块写入且用户内容原样保留", /永远不要碰生产库/.test(txt1) && /sshx:remote-tmux:start/.test(txt1) && /send-keys/.test(txt1));
  const n1 = (txt1.match(/sshx:remote-tmux:start/g) ?? []).length;
  await clickEl(ruleBtn); // 再点一次
  await sleep(1600);
  const n2 = ((fs.readFileSync(AGF, "utf8")).match(/sshx:remote-tmux:start/g) ?? []).length;
  ok("幂等：重复点击标记块仍只有一份", n1 === 1 && n2 === 1, `${n1}→${n2}`);
}
} // end: 8c/8d/8e 隔离演练场

/* ── 10. 👀 自动观察：ssh shim 上报 → 画布自动拉起 attach 窗（无需手敲） ── */
await fetch(HEALTH.replace("/api/health", "/api/observe/clear"), { method: "POST" }); // 清事件环，测试自给自足
await sleep(1600);

await bringIntoView(A2.id);
await runCmd(A2.id, "which ssh");
const wOut = await waitScreen(A2.id, /shims\/ssh/, 5000);
ok("PTY 的 PATH 前置了 ssh shim", !!wOut, wOut?.match(/\S*shims\/ssh/)?.[0] ?? "timeout");
await runCmd(A2.id, "ssh -V");
const vOut = await waitScreen(A2.id, /OpenSSH_\d/, 5000);
ok("shim 透传真 ssh（-V 正常出版本，不干预任何 ssh 行为）", !!vOut, vOut?.match(/OpenSSH_[\d.]+\w*/)?.[0] ?? "timeout");

// 模拟 codex 驱动远端 tmux（假主机，DNS 快速失败；上报是 exec 前后台完成的，不依赖连通）
await runCmd(A2.id, "ssh -o ConnectTimeout=2 obs-probe.invalid tmux send-keys -t e2e-watch uptime Enter");
let mW = null;
for (let i = 0; i < 40 && !mW?.pid; i++) {
  await sleep(300);
  mW = (await nodePidMap()).find((x) => /👀.*e2e-watch/.test(String(x.title)));
}
ok("send-keys 形态自动拉起 👀 观察窗（带自己 PTY）", !!mW?.pid, JSON.stringify(mW));
const attached = await waitScreen(mW.id, /obs-probe\.invalid|Could not resolve/, 9000);
ok("观察窗自动执行 attach 命令（ssh 报错即证明命令已投递）", !!attached);
await bringIntoView(mW.id); // 新窗落在视口中心，先搬回左上安全区再交互（防叠窗偷焦点）
await runCmd(mW.id, "echo NOBS=${SSHX_NO_OBSERVE:-none}");
const nobs = await waitScreen(mW.id, /NOBS=1/, 6000);
ok("观察窗 PTY 自带 SSHX_NO_OBSERVE=1（attach 不再触发上报，防回声环）", !!nobs);
const cntBefore = await rfCount();
await bringIntoView(A2.id);
await runCmd(A2.id, "ssh -o ConnectTimeout=2 obs-probe.invalid tmux send-keys -t e2e-watch date Enter");
await sleep(4000);
ok("同 host+session 重复驱动不再开第二扇窗（key 去重）", (await rfCount()) === cntBefore, `${cntBefore} → ${await rfCount()}`);
await runCmd(A2.id, "ssh obs-probe.invalid tmux new -As ci-x");
let mW2 = null;
for (let i = 0; i < 40 && !mW2?.pid; i++) {
  await sleep(300);
  mW2 = (await nodePidMap()).find((x) => /👀.*ci-x/.test(String(x.title)));
}
ok("new -As 形态同样解析出会话名并开窗（双格式支持）", !!mW2?.pid, JSON.stringify(mW2));
// user 透传：ops@host 形态 → 事件带 user → attach 命令还原 ops@
await bringIntoView(A2.id);
await runCmd(A2.id, "ssh -o ConnectTimeout=2 ops@obs-user.invalid tmux new -As uwin");
let mU = null;
for (let i = 0; i < 40 && !mU?.pid; i++) {
  await sleep(300);
  mU = (await nodePidMap()).find((x) => /👀.*uwin/.test(String(x.title)));
}
ok("ops@host 形态：用户名随事件贯通", !!mU && /ops@obs-user\.invalid/.test(String(mU.title)), JSON.stringify(mU));
const uAttach = await waitScreen(mU.id, /ops@obs-user\.invalid/, 9000);
ok("观察窗 attach 命令还原了登录名（不再裸 host 误用本机用户）", !!uAttach);
await fetch(HEALTH.replace("/api/health", "/api/observe/clear"), { method: "POST" }); // 清场：不留事件给用户的其它标签页

/* ── 11. 真机全链路：远端 tmux 共享工位 ──
   测试机由环境显式指定：SSHX_E2E_SSH_HOST=[user@]host（配了且可达才跑，否则 SKIP 不算红）。
   user 缺省 root；该机器要接受 BatchMode 密钥登录且装有 tmux。 */
{
  const VPS_HOST = process.env.SSHX_E2E_SSH_HOST ?? "";
  const VPS = VPS_HOST.includes("@") ? VPS_HOST.split("@").pop() : VPS_HOST;
  const VPS_USER = VPS_HOST.includes("@") ? VPS_HOST.split("@")[0] : (process.env.SSHX_E2E_SSH_USER ?? "root");
  const { spawnSync } = await import("node:child_process");
  const probe = VPS ? spawnSync("ssh", ["-o", "ConnectTimeout=6", "-o", "BatchMode=yes", "-o", "ControlPath=none", `${VPS_USER}@${VPS}`, "tmux", "-V"], { encoding: "utf8" }) : { status: -1 };
  if (!VPS || probe.status !== 0) {
    console.log(VPS ? "SKIP  11 段（SSHX_E2E_SSH_HOST 不可达，不算失败）"
                    : "SKIP  11 段（未配 SSHX_E2E_SSH_HOST，真机链路只在有测试机时跑）");
  } else {
  const SESS = "canvas-e2e";
  // 全程 ControlMaster 复用一条 TCP：连接洪水把 sshguard 打出过 REJECT 封禁（实录教训），
  // 测试公民从减少连接数做起
  const CM = ["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/sshx-e2e-cm", "-o", "ControlPersist=120"];
  const vpsSh = (cmd) => spawnSync("ssh", [...CM, "-o", "BatchMode=yes", `${VPS_USER}@${VPS}`, cmd], { encoding: "utf8" }).stdout;
  vpsSh(`tmux kill-session -t ${SESS} 2>/dev/null; true`);
  await bringIntoView(A2.id);
  // codex 式第一步：非交互建远端会话（含 tmux → shim 应上报）
  // 先由测试进程开主连接（画布里的 ssh 走复用，不再新起 TCP）
  vpsSh("echo master-up");
  await runCmd(A2.id, `ssh -o ControlPath=/tmp/sshx-e2e-cm ${VPS_USER}@${VPS} tmux new -d -s ${SESS}`);
  let mV = null;
  for (let i = 0; i < 40 && !mV?.pid; i++) { await sleep(300); mV = (await nodePidMap()).find((x) => /👀.*canvas-e2e/.test(String(x.title))); }
  ok("真机：建会话指令自动拉起 👀 观察窗", !!mV?.pid, JSON.stringify(mV));
  await sleep(2500); // 给 A2 的 new -d 与观察窗的 attach 都留往返时间
  ok("中间证：远端会话确实建出来了（A2 那条 ssh 生效）",
    new RegExp(SESS).test(vpsSh("tmux ls 2>/dev/null || true")));
  const joined = await waitScreen(mV.id, /[$#] /, 15_000); // 通用 shell 提示符判定（远端性由后续 TOKYO_42/WATCHBACK 双证兜底）
  ok("观察窗自动 attach 进远端 shell（真实提示符出现）", !!joined,
    joined ? joined.split("\n").filter(Boolean).slice(-2).join(" ⏎ ").slice(0, 90)
           : "screen: " + String(await evalJs(screenOf(mV.id))).split("\n").filter(Boolean).slice(-4).join(" ⏎ ").slice(0, 220));
  // codex 式驱动：send-keys 一条命令，输出应实时出现在观察窗
  await bringIntoView(A2.id);
  await runCmd(A2.id, `ssh -o ControlPath=/tmp/sshx-e2e-cm ${VPS_USER}@${VPS} tmux send-keys -t ${SESS} 'echo TOKYO_$((6*7))' Enter`);
  const live = await waitScreen(mV.id, /TOKYO_42/, 12_000);
  ok("实时围观：A 窗 send-keys → 👀 窗看见远端输出（共享工位成立）", !!live);
  // 抢键盘：直接在观察窗敲，落到远端会话
  await bringIntoView(mV.id);
  await runCmd(mV.id, "echo WATCHBACK_$((8+1))");
  const kb = await waitScreen(mV.id, /WATCHBACK_9/, 12_000);
  const remoteSaw = /watchback_9/i.test(vpsSh(`tmux capture-pane -pt ${SESS} 2>/dev/null | tr A-Z a-z`).toLowerCase());
  ok("观察窗抢键盘直达远端（屏上有 + 远端 capture 里也有，双证防本地假阳性）", !!kb && remoteSaw,
    `screen=${!!kb} remote=${remoteSaw}`);
  vpsSh(`tmux kill-session -t ${SESS} 2>/dev/null; true`);
  ok("VPS 现场清理（会话已 kill，无残留）", !/canvas-e2e/.test(vpsSh("tmux ls 2>/dev/null || true")));
  await fetch(HEALTH.replace("/api/health", "/api/observe/clear"), { method: "POST" });
  }
}

/* ── 12. ⌗ Auto 整理：重叠窗网格化 + 撤销可退回原位 ── */
await clickEl(addTermBtn);
await sleep(1400);
await clickEl(addTermBtn); // 两扇新窗抖动着落，和现存窗必然叠
await sleep(1400);
ok("右下角 Controls 列有 Auto 整理按钮", await evalJs(`!!document.querySelector('button[aria-label="auto-arrange"]')`));
const overlaps = () =>
  evalJs(`(() => { const rs=[...document.querySelectorAll('.react-flow__node')].map(w=>{const b=w.getBoundingClientRect();return{x:b.x,y:b.y,r:b.right,bo:b.bottom};});
    let bad=0; for(let i=0;i<rs.length;i++)for(let j=i+1;j<rs.length;j++){const A=rs[i],B=rs[j];
      const ow=Math.min(A.r,B.r)-Math.max(A.x,B.x), oh=Math.min(A.bo,B.bo)-Math.max(A.y,B.y); if(ow>2&&oh>2)bad++;}
    return {n:rs.length,bad}; })()`);
const posMap = () =>
  evalJs(`JSON.stringify(Object.fromEntries(window.__sshxRf.getNodes().map(n=>[n.id,[Math.round(n.position.x),Math.round(n.position.y)]])))`);
const pre = await overlaps();
ok("整理前存在叠窗（前提成立，不成立则本段失去意义）", pre.bad > 0, JSON.stringify(pre));
const posBefore = await posMap();
await clickEl(`document.querySelector('button[aria-label="auto-arrange"]')`);
await sleep(1800); // animate 420ms + fitView 420ms 缓冲
const post = await overlaps();
ok("Auto 之后两两不重叠", post.bad === 0 && post.n === pre.n, JSON.stringify(post));
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,bubbles:true}))`);
await sleep(900);
ok("⌘Z 精确退回整理前的位置", (await posMap()) === posBefore);
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,shiftKey:true,bubbles:true}))`);
await sleep(1800);
ok("⇧⌘Z 重做回到整齐态", (await overlaps()).bad === 0);

/* ── 9. 收尾：离开页面 → 本测试的 shell 全部收割 ── */
const hPreLeave = (await health()).ptys;
// 正常导航即时 close 走 dispose；若网络进程卡住半开连接，则由 hb 断流清扫（≤15s）兜底
await goto("about:blank");
// 判定「严格下降」而非等于某绝对值：外部客户端中途上下线不该算我头上；
// 若我们的 pty 泄漏，计数会原地停在 hPreLeave → 照样红
let hEnd = await health();
for (let i = 0; i < 35 && hEnd.ptys >= hPreLeave; i++) { await sleep(1000); hEnd = await health(); }
ok("页面关闭后本测试的 shell 全收割（直连 close 或 hb 清扫兜底）", hEnd.ptys < hPreLeave, `pre=${hPreLeave} end=${JSON.stringify(hEnd)}`);

ws.close();
console.log(failures === 0 ? "\nALL PASS ✅" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
