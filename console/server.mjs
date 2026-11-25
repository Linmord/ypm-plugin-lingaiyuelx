#!/usr/bin/env node
// 多音源播放器 · 本地管理控制台
//
// 为什么需要它：YesPlayMusic 宿主只有一个账号槽位，两个音源的登录无法在应用内切换。
// 插件能访问 127.0.0.1（已实测），所以把账号管理搬到本地网页，直接读写插件的 storage.json。
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { installHost } from './host-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 47800);

// 各平台的宿主数据目录（见插件文档「插件目录」表）：
//   Windows  %APPDATA%\YesPlayMusic
//   macOS    ~/Library/Application Support/YesPlayMusic
//   Linux    $XDG_DATA_HOME/YesPlayMusic（默认 ~/.local/share/YesPlayMusic）
function hostRoot() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || home, 'YesPlayMusic');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'YesPlayMusic');
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'YesPlayMusic');
  }
}

const ROOT = hostRoot();
// 由插件 spawn 时 HERE 就是插件目录里的 console/，上一级即插件根
const PLUGIN_DIR = process.env.PLUGIN_DIR
  || path.join(ROOT, 'plugins', 'multisource');
const DATA_DIR = process.env.DATA_DIR
  || path.join(ROOT, 'plugin-data', 'multisource');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// 由插件启动时传入 --parent <pid>：父进程没了就自己退出，
// 避免宿主异常结束留下孤儿进程占着端口。
// 默认看护父进程：宿主 spawn 出来的子进程，ppid 就是宿主进程。
// 宿主被强杀时不会替我们收进程，所以自己盯着。
const PARENT_PID = (() => {
  const i = process.argv.indexOf('--parent');
  if (i > 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  // 手动从 bat 启动时 ppid 是 cmd，父进程一关也该退出，行为一致
  return process.ppid || 0;
})();
if (PARENT_PID && PARENT_PID > 0) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0);
    } catch (_) {
      log('父进程已退出（pid ' + PARENT_PID + '），控制台自动关闭');
      process.exit(0);
    }
  }, 2000).unref();
}

const PROVIDERS = ['netease', 'qq'];
const LABEL = { netease: '网易云音乐', qq: 'QQ 音乐' };

const PROBE_FILE = path.join(process.env.TEMP || '/tmp', 'ypm-probe.log');
const log = (msg) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  console.log(line);
  try { appendFileSync(PROBE_FILE, line + '\n', 'utf8'); } catch { /* 落盘失败不影响主流程 */ }
};
// 插件里的 console.log 走的是本进程 stdout，重定向到文件时可能被缓冲；
// 这里同步镜像一份到独立文件，扫码探针才不会丢。
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      appendFileSync(PROBE_FILE, new Date().toISOString().slice(11, 19) + ' [' + level + '] ' + args.map(String).join(' ') + '\n', 'utf8');
    } catch { /* 忽略 */ }
  };
}

function readSettings() {
  if (!existsSync(SETTINGS_FILE)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function writeSettings(next) {
  // 数据目录可能还不存在（首次运行、或用户指了一个新路径），先建再写
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
}

// 登录二维码状态：宿主用 signInPrompt 推给 UI，这里转成轮询接口
const prompts = { netease: null, qq: null };
const loginState = {
  netease: { status: 'idle', message: '' },
  qq: { status: 'idle', message: '' },
};

installHost({
  dataDir: DATA_DIR,
  pluginDir: PLUGIN_DIR,
  getSettings: readSettings,
  onPrompt: (value) => {
    // 两个音源同时登录时会混在一起，用当前活动登录标记归属
    const who = activeLogin || 'netease';
    prompts[who] = value && value.qr ? { qr: value.qr, text: value.text || '' } : prompts[who];
    if (value && value.text) loginState[who].message = value.text;
  },
  onLog: (m) => log('[host] ' + m),
});

let activeLogin = null;

const modules = new Map();
async function provider(name) {
  if (modules.has(name)) return modules.get(name);
  const file = path.join(PLUGIN_DIR, 'providers', name, 'api.js');
  if (!existsSync(file)) throw new Error('找不到 provider: ' + name);
  const mod = await import(pathToFileURL(file).href);
  modules.set(name, mod);
  return mod;
}

const mask = (v) => {
  const s = String(v ?? '');
  if (s.length <= 12) return s ? '***' : '';
  return s.slice(0, 6) + '…' + s.slice(-4);
};

async function status() {
  const out = [];
  for (const name of PROVIDERS) {
    const mod = await provider(name).catch(() => null);
    let account = null, error = '';
    if (mod) {
      try { account = await mod.account(); }
      catch (e) { error = e && e.message ? e.message : String(e); }
    }
    let accountList = [];
    if (name === 'qq' && typeof mod?.accounts_ === 'function') {
      try { accountList = mod.accounts_(); } catch { /* 账号表损坏时忽略 */ }
    }
    out.push({
      name,
      label: LABEL[name],
      loggedIn: Boolean(account),
      account: account ? { id: account.id, name: account.name, imageUrl: account.imageUrl || '' } : null,
      accounts: accountList,
      error,
      login: loginState[name],
      prompt: prompts[name],
    });
  }
  const settings = readSettings();
  // 标出当前使用中的音源，UI 用它高亮
  const active = String(settings.activeProvider || 'netease');
  for (const p of out) p.active = p.name === active;
  // 插件版本：直接读 plugin.json，页脚显示用
  let version = '';
  try {
    version = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8')).version || '';
  } catch { /* 读不到就不显示 */ }
  return { providers: out, settings, activeProvider: active, version };
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = readFileSync(path.join(HERE, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (url.pathname === '/api/status') return json(res, 200, await status());

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const patch = await readBody(req);
      writeSettings({ ...readSettings(), ...patch });
      return json(res, 200, { ok: true, settings: readSettings() });
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { provider: name } = await readBody(req);
      if (!PROVIDERS.includes(name)) return json(res, 400, { error: '未知音源' });
      const mod = await provider(name);
      activeLogin = name;
      prompts[name] = null;
      loginState[name] = { status: 'pending', message: '正在获取二维码…' };
      // 登录是长任务（扫码最长 10 分钟），不阻塞 HTTP 响应
      mod.signIn().then((account) => {
        loginState[name] = { status: account ? 'done' : 'idle', message: account ? '登录成功' : '已取消' };
        prompts[name] = null;
        log(name + ' 登录成功: ' + (account ? account.name : '(取消)'));
      }).catch((e) => {
        loginState[name] = { status: 'error', message: e && e.message ? e.message : String(e) };
        log(name + ' 登录失败: ' + loginState[name].message);
      }).finally(() => { activeLogin = null; });
      return json(res, 200, { ok: true, started: true });
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const { provider: name } = await readBody(req);
      if (!PROVIDERS.includes(name)) return json(res, 400, { error: '未知音源' });
      const mod = await provider(name);
      mod.signOut();
      loginState[name] = { status: 'idle', message: '已退出' };
      prompts[name] = null;
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/loginCookie' && req.method === 'POST') {
      const body = await readBody(req);
      const mod = await provider('qq');
      if (typeof mod.signInByCookie !== 'function') return json(res, 400, { error: '当前插件版本不支持手动填 cookie' });
      try {
        const account = await mod.signInByCookie({
          uin: body.uin,
          musickey: body.musickey,
          loginType: body.loginType,
        });
        log('qq 手动 cookie 登录成功: ' + (account && account.name ? account.name : '(未知)'));
        return json(res, 200, { ok: true, account });
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        log('qq 手动 cookie 登录失败: ' + message);
        return json(res, 400, { error: message });
      }
    }

    if (url.pathname === '/api/capabilities') {
      // 只对 qq provider 探一次：确认插件运行环境能不能执行导入的脚本
      const mod = await provider('qq');
      const api = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
      const probe = typeof api.probeCapabilities === 'function' ? api.probeCapabilities() : { error: '插件没有 probeCapabilities' };
      return json(res, 200, { probe, provider: Boolean(mod) });
    }

    if (url.pathname === '/api/sources/luoxue') {
      const api = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
      const list = typeof api.listSources === 'function' ? api.listSources() : [];
      return json(res, 200, { scripts: list });
    }

    if (url.pathname === '/api/sources/import' && req.method === 'POST') {
      const { name, source } = await readBody(req);
      const api = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
      if (typeof api.importSource !== 'function') return json(res, 400, { error: '当前插件版本不支持导入音源' });
      try {
        const info = api.importSource({ name, source });
        log('导入落雪音源「' + info.name + '」支持: ' + info.sources.join(','));
        return json(res, 200, { ok: true, info, scripts: api.listSources() });
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        log('导入落雪音源失败: ' + message);
        return json(res, 400, { error: message });
      }
    }

    if (url.pathname === '/api/sources/importUrl' && req.method === 'POST') {
      const { name, url: sourceUrl } = await readBody(req);
      const api = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
      if (typeof api.importSourceFromUrl !== 'function') return json(res, 400, { error: '当前插件版本不支持网络导入' });
      try {
        const info = await api.importSourceFromUrl({ name, url: sourceUrl });
        log('从网络导入「' + info.name + '」: ' + (info.from || sourceUrl));
        return json(res, 200, { ok: true, info, scripts: api.listSources() });
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        log('网络导入失败: ' + message);
        return json(res, 400, { error: message });
      }
    }

    if (url.pathname === '/api/sources/reorder' && req.method === 'POST') {
      const { names } = await readBody(req);
      const api = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
      if (typeof api.reorderSources !== 'function') return json(res, 400, { error: '当前插件版本不支持排序' });
      try {
        const scripts = api.reorderSources({ names });
        log('音源顺序已更新: ' + (names || []).join(' > '));
        return json(res, 200, { ok: true, scripts });
      } catch (e) {
        return json(res, 400, { error: e && e.message ? e.message : String(e) });
      }
    }

    if (url.pathname === '/api/sources/reorder' && req.method === 'POST') {
      const { names } = await readBody(req);
      const api = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
      if (typeof api.reorderSources !== 'function') return json(res, 400, { error: '当前插件版本不支持排序' });
      try {
        const scripts = api.reorderSources({ names });
        log('音源顺序已更新: ' + (names || []).join(' > '));
        return json(res, 200, { ok: true, scripts });
      } catch (e) {
        return json(res, 400, { error: e && e.message ? e.message : String(e) });
      }
    }

    if (url.pathname === '/api/sources/remove' && req.method === 'POST') {
      const { name } = await readBody(req);
      const api = await import(pathToFileURL(path.join(PLUGIN_DIR, 'index.js')).href);
      try {
        api.removeSource({ name });
        return json(res, 200, { ok: true, scripts: api.listSources() });
      } catch (e) {
        return json(res, 400, { error: e && e.message ? e.message : String(e) });
      }
    }

    if (url.pathname === '/api/accounts') {
      const mod = await provider('qq');
      const list = typeof mod.accounts_ === 'function' ? mod.accounts_() : [];
      return json(res, 200, { accounts: list, loginMode: readSettings()['qq:loginMode'] || 'wechat' });
    }

    if (url.pathname === '/api/accounts/switch' && req.method === 'POST') {
      const { id } = await readBody(req);
      const mod = await provider('qq');
      const accounts = mod.switchAccount(id);
      // 同时记下这个账号属于哪个音源，插件用它决定首页/账号显示
      writeSettings({ ...readSettings(), activeProvider: 'qq' });
      log('切换账号: ' + id + '（音源 qq）');
      return json(res, 200, { ok: true, accounts });
    }

    if (url.pathname === '/api/activeProvider' && req.method === 'POST') {
      const { provider: name } = await readBody(req);
      if (!['netease', 'qq'].includes(name)) return json(res, 400, { error: '未知音源' });
      writeSettings({ ...readSettings(), activeProvider: name });
      log('当前音源切换为: ' + name);
      return json(res, 200, { ok: true, provider: name });
    }

    if (url.pathname === '/api/accounts/remove' && req.method === 'POST') {
      const { id } = await readBody(req);
      const mod = await provider('qq');
      return json(res, 200, { ok: true, accounts: mod.removeAccount(id) });
    }

    if (url.pathname === '/api/loginMode' && req.method === 'POST') {
      const { mode } = await readBody(req);
      if (!['wechat', 'qq', 'app'].includes(mode)) return json(res, 400, { error: '未知登录方式' });
      writeSettings({ ...readSettings(), 'qq:loginMode': mode });
      return json(res, 200, { ok: true, mode });
    }

    if (url.pathname === '/api/prompt') {
      const name = url.searchParams.get('provider') || 'netease';
      return json(res, 200, { prompt: prompts[name] || null, login: loginState[name] || null });
    }

    if (url.pathname === '/api/cancel' && req.method === 'POST') {
      const { provider: name } = await readBody(req);
      if (PROVIDERS.includes(name)) {
        loginState[name] = { status: 'idle', message: '已取消' };
        prompts[name] = null;
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    log('请求失败 ' + url.pathname + ': ' + (e && e.stack ? e.stack.split('\n')[0] : e));
    return json(res, 500, { error: e && e.message ? e.message : String(e) });
  }
});

// 启动就把数据目录建好，避免第一次写设置时才报错
mkdirSync(DATA_DIR, { recursive: true });

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log('端口 ' + PORT + ' 已被占用，视为控制台已在运行，本次退出');
    process.exit(0);
  }
  log('控制台启动失败: ' + (e && e.message ? e.message : e));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  log('管理控制台已启动: http://127.0.0.1:' + PORT);
  log('插件目录: ' + PLUGIN_DIR);
  log('数据目录: ' + DATA_DIR);
});
