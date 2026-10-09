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
const APP = "http://localhost:5173/"; // vite 默认只听 IPv6 ::1，127.0.0.1 会 goto timeout（与 README、e2e-theme 统一用 localhost）
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
const SEEN_PIDS = new Set(); // 本测试亲眼见过的所有 shell pid（OS 级收割断言用，不信服务端账本）
const nodePidMap = async () => {
  const arr = await evalJs(`(() => { const out = []; for (const n of window.__sshxRf.getNodes()) {
    const el = document.querySelector('.react-flow__node[data-id="' + n.id + '"]');
    const m = el?.textContent.match(/⌗(\\d+)/); out.push({ id: n.id, pid: m ? m[1] : null, title: n.data?.title });
  } return out; })()`);
  for (const n of arr ?? []) if (n?.pid) SEEN_PIDS.add(Number(n.pid));
  return arr;
};
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

/* ── 0. 基线：清场重载 ── */
await goto(APP);
await evalJs(`localStorage.clear(); 1`);
await sleep(700); // 让持久化的 debounce 先落定，再补一刀（防写回）
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
    return /本程序依赖/.test(b) && /npm/.test(b) && /在浏览器画布上开真终端/.test(b); })()`);
}
ok("点击展示两条须知（npm / 真终端逐条在位）", nShown,
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
  {id:'term-x',type:'term',position:{x:20,y:20},data:{title:'旧窗口',hostId:'host-local',session:'demo',win:'max'}}])); return 1 })()`);
await goto(APP);
ok("迁移：host/chat 节点被淘汰，只剩 term", (await rfCount()) === 1);
const maxW = await evalJs(`document.querySelector('.react-flow__node[data-id="term-x"]')?.getBoundingClientRect().width ?? 0`);
ok("迁移：老 term 的 win:max 仍生效", maxW > 800, `width=${maxW}`);
const mig = await nodePidMap();
ok("迁移：标题保留 + 脏字段剥离后能开出真 PTY", mig.length === 1 && mig[0].title === "旧窗口" && !!mig[0].pid, JSON.stringify(mig));
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

/* ── 13. ⚡ 快捷命令：⌘K 面板 CRUD + 注入聚焦窗 + 无活窗兜底开新窗 ── */
const K = "e2eqk" + Math.random().toString(36).slice(2, 6);
const QNAME = "e2e-" + K;
const QCMD = `echo ${K}_MARK`;
const pressCmdK = async () => {
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}))`);
  await sleep(250);
};
const qcRowCount = () => evalJs(`document.querySelectorAll('[data-qc-row]').length`);
const qcRowOf = (name) =>
  `[...document.querySelectorAll('[data-qc-row]')].find(r=>r.textContent.includes(${JSON.stringify(name)}))`;
await pressCmdK();
ok("⌘K 唤起快捷命令面板", (await evalJs(`!!document.querySelector('[data-qc-overlay]')`)) === true);
await clickEl(`document.querySelector('button[aria-label="新建快捷命令"]')`);
await sleep(200);
await setField("qc-name", QNAME);
await setField("qc-cmd", QCMD);
await clickEl(`document.querySelector('button[aria-label="qc-save"]')`);
await sleep(300);
ok("保存后回列表且行在位", (await evalJs(`(${qcRowOf(QNAME)} ? 1 : 0)`)) === 1);
ok("命令落 localStorage 持久化", String(await evalJs(`localStorage.getItem("sshx.quickCommands") ?? ""`)).includes(`${K}_MARK`));
// 执行目标 = 最后敲过字的活窗：先关面板（modal 遮罩会截走 TopBar 的真鼠标事件），
// 开一扇新终端（注册即 touch，MRU 第一），再 ⌘K 回来执行
await pressCmdK(); // 面板此刻开着 → 再按 ⌘K 收起
await sleep(250);
const nPre13 = await rfCount();
await clickEl(addTermBtn);
await sleep(700);
const all13 = await nodePidMap();
const QT = all13[all13.length - 1];
ok("执行用的专用终端已就绪", all13.length === nPre13 + 1 && !!QT?.id, JSON.stringify({ nPre13, got: QT }));
if (!QT?.id) throw new Error("section 13: 新终端没开出来，后面全空转");
await focusTerm(QT.id);
await pressCmdK();
await clickEl(`(${qcRowOf(QNAME)})?.querySelector('[data-qc-run]')`);
await sleep(400);
ok("执行后面板自动收起（不挡终端视野）", (await evalJs(`!!document.querySelector('[data-qc-overlay]')`)) === false);
const scr13 = await waitScreen(QT.id, new RegExp(`${K}_MARK`), 6000);
ok("命令注入到聚焦终端并已执行", !!scr13);
// 无活终端兜底：全部窗下 → ▶ 自动开「快捷命令」新窗跑
await evalJs(`window.__sshxRf.setNodes([])`);
await sleep(500);
await pressCmdK();
await clickEl(`document.querySelector('[data-qc-row] [data-qc-run]')`);
await sleep(1000);
const mQ2 = await nodePidMap();
const QT2 = mQ2[0];
ok("无活终端时自动开新窗执行", mQ2.length === 1 && String(QT2?.title) === "快捷命令", JSON.stringify(mQ2));
const scr13b = await waitScreen(QT2?.id ?? "", new RegExp(`${K}_MARK`), 8000);
ok("新窗里命令真跑了", !!scr13b);
// 编辑与删除
await pressCmdK();
await clickEl(`(${qcRowOf(QNAME)})?.querySelector('[aria-label="qc-edit"]')`);
await sleep(200);
await setField("qc-name", QNAME + "B");
await clickEl(`document.querySelector('button[aria-label="qc-save"]')`);
await sleep(250);
ok("编辑改名生效", (await evalJs(`(${qcRowOf(QNAME + "B")} ? 1 : 0)`)) === 1);
// 面板此时本就开着（保存后回列表）——别再 ⌘K，会把面板toggle关了把行下掉
await clickEl(`(${qcRowOf(QNAME + "B")})?.querySelector('button[aria-label^=\"\u5220\u9664 \"]')`);
await sleep(250);
ok("删除后行消失且 LS 同步", (await qcRowCount()) === 0 && !String(await evalJs(`localStorage.getItem("sshx.quickCommands") ?? ""`)).includes(QNAME));
await pressCmdK(); // 关掉面板再收场：别让 modal 遮罩截走 14 段的 TopBar 点击
await sleep(250);
// 注意：绝不在此清空画布——收尾段靠「活终端数严格下降」证明无泄漏，
// 清空后 hPreLeave=0 会让该断言结构性必红（run6 实录）。本段终端留给收割。

/* ── 14. 📈 状态卡：白名单硬拒注入 +（有测试机时）真机采集全链 ── */
const HEALTH_BASE = "http://127.0.0.1:8787";
const badHosts = ["root@a;rm -rf /", "-oProxyCommand=touch /tmp/pwned", "a b"];
const badRes = [];
for (const bh of badHosts) {
  const r = await fetch(`${HEALTH_BASE}/api/status?host=${encodeURIComponent(bh)}`);
  badRes.push({ s: r.status, e: (await r.json()).err });
}
ok("状态 API 对注入形态 host 全拒 400", badRes.every((x) => x.s === 400 && x.e === "invalid host"), JSON.stringify(badRes));
ok("注入 host 未被执行（/tmp/pwned 不存在）", !fs.existsSync("/tmp/pwned"));
const VPS3 = process.env.SSHX_E2E_SSH_HOST ?? "";
const SH3 = VPS3.includes("@") || !VPS3 ? VPS3 : `root@${VPS3}`;
const { spawnSync: sp3 } = await import("node:child_process");
const probe3 = SH3
  ? sp3("ssh", ["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/sshx-e2e-cm", "-o", "ControlPersist=120", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", SH3, "echo up"], { encoding: "utf8" })
  : { stdout: "" };
if (!SH3 || probe3.stdout?.trim() !== "up") {
  console.log(SH3 ? "SKIP  14 真机段（SSHX_E2E_SSH_HOST 不可达）" : "SKIP  14 真机段（未配 SSHX_E2E_SSH_HOST）");
} else {
  await clickEl(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='📈 状态卡')`);
  await sleep(250);
  await setField("status-host", SH3);
  await clickEl(`document.querySelector('[data-status-create]')`);
  await sleep(400);
  ok("状态卡节点落画布", (await evalJs(`document.querySelectorAll('[data-status-node]').length`)) === 1);
  let stState = "";
  for (let i = 0; i < 30 && stState !== "ok"; i++) {
    await sleep(1000);
    stState = String(await evalJs(`document.querySelector('[data-status-node]')?.dataset.statusState ?? ""`));
  }
  ok("真机：30s 内首采成功（state=ok）", stState === "ok", stState);
  const stBody = String(await evalJs(`document.querySelector('[data-status-node]')?.textContent ?? ""`));
  ok("卡面含 CPU/MEM 采样值", /CPU/.test(stBody) && /MEM/.test(stBody) && /\d+(\.\\d)?%/.test(stBody), stBody.slice(0, 120));
  ok("卡面含 up 时长与 top 进程区", /up /.test(stBody) && /TOP/.test(stBody), stBody.slice(0, 160));
  // 缓存去重：TTL 内连打两发必须拿到同一份 at（没多花一次 ssh）
  const f2 = await (await fetch(`${HEALTH_BASE}/api/status?host=${encodeURIComponent(SH3)}`)).json();
  const f3 = await (await fetch(`${HEALTH_BASE}/api/status?host=${encodeURIComponent(SH3)}`)).json();
  ok("TTL 内连击共享同一次采集（缓存去重）", f2.ok === true && f2.at === f3.at, JSON.stringify({ a: f2.at, b: f3.at }));
  await clickEl(`document.querySelector('[data-status-node] button[aria-label="pause-polling"]')`);
  await sleep(200);
  ok("⏸ 定格生效（state=paused，轮询停）", (await evalJs(`document.querySelector('[data-status-node]').dataset.statusState`)) === "paused");
  await goto(APP); // 刷新：状态卡经迁移函数原位复活
  await sleep(1600);
  ok("刷新后状态卡持久复活", (await evalJs(`document.querySelectorAll('[data-status-node]').length`)) === 1);
  await clickEl(`document.querySelector('[data-status-node] button[aria-label="close"]')`);
  await sleep(300);
  ok("✕ 关闭状态卡", (await evalJs(`document.querySelectorAll('[data-status-node]').length`)) === 0);
}

/* ── 9. 收尾：离开页面 → 本测试的 shell 全部收割 ── */
const hPreLeave = (await health()).ptys;
// 正常导航即时 close 走 dispose；若网络进程卡住半开连接，则由 hb 断流清扫（≤15s）兜底
await goto("about:blank");
// 判定「严格下降」而非等于某绝对值：外部客户端中途上下线不该算我头上；
// 若我们的 pty 泄漏，计数会原地停在 hPreLeave → 照样红
let hEnd = await health();
for (let i = 0; i < 35 && hEnd.ptys >= hPreLeave; i++) { await sleep(1000); hEnd = await health(); }
ok("页面关闭后本测试的 shell 全收割（直连 close 或 hb 清扫兜底）", hEnd.ptys < hPreLeave, `pre=${hPreLeave} end=${JSON.stringify(hEnd)}`);
await sleep(1500); // 给 node-pty 回收窗口，避开 kill 后短暂的僵尸态误报
const leakedOs = [...SEEN_PIDS].filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
ok(`OS 级：本测试开过的 ${SEEN_PIDS.size} 个 shell 全部真死（账本外证据，dispose 吞 kill 必红）`, leakedOs.length === 0, JSON.stringify(leakedOs));

ws.close();
console.log(failures === 0 ? "\nALL PASS ✅" : `\n${failures} FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
