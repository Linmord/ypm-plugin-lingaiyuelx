// console-launcher.js：把 Web 控制台挂在插件生命周期上。
//
// 宿主能力（见插件文档 host.spawn）：
//   - 插件可以启动本机程序，需要 permissions.process + 用户勾选「允许运行本机程序」
//   - 「插件停止时，它启动的程序会一起结束」——正常停用插件时成立
//
// 所以：模块加载时 spawn 一个 node 跑 server.mjs。
// 另外 server.mjs 自己也会盯父进程，宿主被强杀时也能退出，双保险。

const CONSOLE_PORT = 47800;
let consoleProc = null;
let consoleTried = false;

/** 控制台是否已经在跑：探测端口比看进程靠谱 */
async function consoleAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/status`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

// node 在各个平台的常见安装位置。
// 宿主的 spawn 会先查 PATH，再查 Homebrew 等目录，但 GUI 应用继承的 PATH
// 往往不含 nvm / volta 之类装出来的 node，所以这里再补几个候选。
function nodeCandidates() {
  const platform = (typeof host !== "undefined" && host.platform) || "";
  if (platform === "windows") {
    return [
      "node",
      "C:/Program Files/nodejs/node.exe",
      "C:/Program Files (x86)/nodejs/node.exe",
    ];
  }
  if (platform === "darwin") {
    return [
      "node",
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    ];
  }
  return [
    "node",
    "/usr/bin/node",
    "/usr/local/bin/node",
    "/snap/bin/node",
  ];
}

function launch() {
  if (consoleTried) return;
  consoleTried = true;

  if (typeof host === "undefined" || typeof host.spawn !== "function") {
    console.warn("[console] 宿主不支持 host.spawn，控制台需要手动启动");
    return;
  }

  const dir = (host.dir || "").replace(/\\/g, "/");
  if (!dir) return;
  const script = dir + "/console/server.mjs";

  // 依次试候选路径，第一个能起来的就用
  const candidates = nodeCandidates();
  let lastErr = null;
  for (const bin of candidates) {
    try {
      consoleProc = host.spawn(bin, [script]);
      console.warn("[console] 已启动管理控制台 http://127.0.0.1:" + CONSOLE_PORT + "（" + bin + "）");
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn("[console] 找不到可用的 node，控制台需要手动启动" + (lastErr ? "：" + lastErr.message : ""));
}

/** 插件停用时调用；spawn 的进程宿主会自己收，这里只清引用 */
export function shutdownConsole() {
  if (consoleProc && typeof consoleProc.kill === "function") {
    try { consoleProc.kill(); } catch (_) { /* 已结束 */ }
  }
  consoleProc = null;
}

export function consoleStatus() {
  return { launched: Boolean(consoleProc), pid: (consoleProc && consoleProc.pid) || 0, port: CONSOLE_PORT };
}

// 模块加载即启动：控制台已经在跑就跳过，避免重复开进程。
consoleAlive().then((alive) => {
  if (alive) {
    console.warn("[console] 控制台已在运行，跳过启动");
    return;
  }
  try {
    launch();
  } catch (e) {
    console.warn("[console] 启动失败: " + (e && e.message ? e.message : e));
  }
});
