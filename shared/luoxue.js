// 洛雪音源（lx-music）运行时。
//
// 洛雪音源是一份依赖 globalThis.lx 的脚本：它注册 request 回调，收到
// { action: 'musicUrl', source, info } 时返回音频地址。QQ 音乐/网易云的
// 灰歌可以交给它去别的平台找。
//
// QuickJS 支持 eval / new Function / 异步函数（已实测），所以能在插件里跑。
// 但脚本是用户导入的，必须隔离：只暴露最小 lx 接口，不传 host。
import { fail } from '../providers/qq/client.js';
import { t } from '../shared/i18n.js';
import { scoped } from './storage.js';
import { findId } from './searchid.js';

/** 同时运行的音源上限，避免用户导入太多把内存吃满 */
const MAX_SCRIPTS = 20;
/** 单次取址超时（毫秒） */
const TIMEOUT = 20000;
/** 等脚本异步上报 inited 的上限（毫秒）。同步上报的脚本不受影响 */
const INITED_WAIT = 2000;

/** 已加载的音源：key 是用户起的名字。脚本原文存 storage，重启后自动重建 */
const loaded = new Map();
const store = scoped('luoxue');

/** 把已导入的脚本原文存起来，插件重载后能恢复 */
function persist() {
  const list = [...loaded.values()].map((x) => ({
    name: x.name,
    source: x.source,
    sources: x.sources,
    importedAt: x.importedAt,
  }));
  store.set('scripts', list);
}

/** 从 storage 恢复：重新执行脚本，重建 handler */
function restore() {
  if (loaded.size) return;
  const saved = store.get('scripts');
  if (!Array.isArray(saved) || !saved.length) return;
  for (const item of saved) {
    try {
      // 异步初始化的脚本要等它上报，这里不阻塞，失败了单独记一笔
      const pending = loadInto(item.name, item.source, item.importedAt);
      if (pending && typeof pending.then === 'function') {
        pending.catch((e) => console.warn('[luoxue] 恢复「' + item.name + '」失败: ' + (e && e.message ? e.message : e)));
      }
    } catch (e) { console.warn('[luoxue] 恢复「' + item.name + '」失败: ' + (e && e.message ? e.message : e)); }
  }
}

/**
 * lx 宿主垫片。只提供脚本真正用到的能力：
 * - EVENT_NAMES / on / send：注册回调与上报初始化
 * - request：发 HTTP（走插件的 fetch，受 permissions.network 限制）
 * - env / version：脚本里会读
 */
function createHost(name, sandbox) {
  const handlers = {};
  return {
    EVENT_NAMES: {
      request: 'request',
      inited: 'inited',
      updateAlert: 'updateAlert',
    },
    on(event, fn) { handlers[event] = fn; },
    send(event, payload) {
      if (event === 'inited') {
        sandbox.inited = payload;
        // 异步初始化的脚本会晚一步上报，叫醒正在等它的导入流程
        if (typeof sandbox.onInited === 'function') sandbox.onInited(payload);
      }
      if (event === 'updateAlert') sandbox.updateAlert = payload;
    },
    request(url, options, callback) {
      // 洛雪脚本用的是回调风格：request(url, opts, (err, resp, body) => {})
      const opts = options || {};
      const init = {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        signal: AbortSignal.timeout(opts.timeout || TIMEOUT),
      };
      if (opts.body !== undefined) {
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      }
      fetch(url, init)
        .then(async (res) => {
          const text = await res.text();
          const headers = {};
          try { res.headers.forEach((v, k) => { headers[k] = v; }); } catch (_) { /* 有些实现不支持遍历 */ }
          callback(null, { statusCode: res.status, headers, body: text }, text);
        })
        .catch((err) => callback(err, null, null));
    },
    env: 'desktop',
    version: '2.0.0',
    __handlers: handlers,
    __name: name,
  };
}

/**
 * 导入一份洛雪音源脚本。
 * @param {string} name 用户起的名字，用于在设置里选择
 * @param {string} source 脚本全文
 * @returns {{ name: string, sources: string[], actions: string[] }}
 */
/** 真正把脚本跑起来，返回 { handler, sources }。导入和恢复共用这一段 */
function loadInto(name, source, importedAt) {
  const key = String(name || '').trim();
  const text = String(source || '');
  if (!key) fail('setup', '请给音源起一个名字');
  if (loaded.size >= MAX_SCRIPTS && !loaded.has(key)) fail('setup', t('最多导入 {n} 个音源', { n: MAX_SCRIPTS }));
  if (!text.trim()) fail('setup', '脚本内容为空');
  if (text.length > 512 * 1024) fail('setup', '脚本过大（上限 512 KB）');

  const sandbox = { inited: null, updateAlert: null };
  const lx = createHost(key, sandbox);

  // 用 new Function 构造一个作用域：脚本里 const {EVENT_NAMES...} = globalThis.lx
  // 需要 globalThis.lx 指向我们的垫片。QuickJS 支持改写 globalThis，但为了不污染
  // 其他音源，运行完立刻恢复。
  const previous = globalThis.lx;
  try {
    globalThis.lx = lx;
    new Function('lx', text)(lx);
  } catch (e) {
    fail('failed', t('音源脚本执行失败：{msg}', { msg: e && e.message ? e.message : String(e) }));
  } finally {
    if (previous === undefined) delete globalThis.lx; else globalThis.lx = previous;
  }

  const inited = sandbox.inited;
  if (inited) return register(key, text, lx, inited, importedAt);
  // 有的脚本是异步初始化的（先 await 拉配置，或 setTimeout 里才 send(inited)），
  // 脚本执行完这一刻还没上报——等一会儿再看，别再把它当成「没初始化」。
  return waitInited(sandbox, INITED_WAIT).then((value) => register(key, text, lx, value, importedAt));
}

/**
 * 等脚本异步上报 inited：send 时立刻兑现，不轮询。
 * 运行时不支持定时器时直接按当前值结算，避免卡死。
 * @returns {Promise<object|null>}
 */
function waitInited(sandbox, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      sandbox.onInited = null;
      resolve(value);
    };
    sandbox.onInited = finish;
    try {
      setTimeout(() => finish(sandbox.inited), ms);
    } catch (_) {
      finish(sandbox.inited);
    }
  });
}

/** 校验 inited 并把音源登记进 loaded；同步与异步两条路径共用 */
function register(key, text, lx, inited, importedAt) {
  if (!inited) {
    fail('failed', t('音源脚本没有完成初始化（send inited 未调用或 status 不为 true）'));
  }
  // 洛雪桌面端不要求带 status：pdone/lx-music-source 里非常刀、全豆要、幻音、溯音、
  // helloworld 都只发 { openDevTools, sources }，按 status !== true 判会把这些正常源全部误杀。
  if (inited.status === false) {
    fail('failed', t('音源脚本自报初始化失败：{msg}', { msg: String(inited.message || '').trim() || '（脚本没有给原因）' }));
  }
  const sources = Object.keys(inited.sources || {});
  const handler = lx.__handlers.request;
  if (typeof handler !== 'function') fail('failed', t('音源脚本没有注册 request 回调'));

  loaded.set(key, { name: key, handler, sources, inited, source: text, importedAt: importedAt || Date.now() });
  return { name: key, sources, actions: ['musicUrl'] };
}

/**
 * 导入一份洛雪音源脚本。
 * @param {string} name 用户起的名字，用于在设置里选择
 * @param {string} source 脚本全文
 */
export async function importScript(name, source) {
  // loadInto 对同步上报的脚本直接返回结果，对异步上报的返回 Promise，await 两种都吃得下
  const info = await loadInto(name, source);
  persist();
  console.warn('[luoxue] 已导入音源「' + info.name + '」，支持: ' + info.sources.join(', '));
  return info;
}

/** 只恢复一次；失败的脚本不阻塞其他 */
let restored = false;
function ensureRestored() {
  if (restored) return;
  restored = true;
  restore();
}


/**
 * 从网络地址导入音源脚本。
 * 只接受 https 地址；下载后与本地导入走同一条路径（同样校验、同样持久化）。
 */
export async function importFromUrl(name, url) {
  const key = String(name || '').trim();
  if (!key) fail('setup', '请给音源起一个名字');
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) fail('setup', '请填写 http(s) 开头的音源地址');
  if (target.length > 2048) fail('setup', '地址过长');

  let response;
  try {
    response = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    fail('failed', t('无法下载音源脚本：{msg}', { msg: e && e.message ? e.message : String(e) }));
  }
  if (!response.ok) fail('failed', t('下载音源失败（HTTP {status}）', { status: response.status }));

  const text = await response.text();
  if (!text || !text.trim()) fail('failed', '下载到的脚本是空的');
  // 下载回来的必须像洛雪音源，避免误把 HTML 错误页当脚本执行
  if (!/globalThis\.lx|EVENT_NAMES/.test(text)) {
    fail('failed', '这个地址返回的内容不像洛雪音源脚本（缺少 globalThis.lx）');
  }

  const info = await importScript(key, text);
  console.warn('[luoxue] 从网络导入「' + key + '」: ' + target);
  return { ...info, from: target };
}

/** 用户设定的音源顺序（名字数组）；没设定时按导入时间 */
function scriptOrder() {
  const raw = store.get('order');
  return Array.isArray(raw) ? raw : [];
}

export function setOrder(names) {
  ensureRestored();
  const list = Array.isArray(names) ? names.map((x) => String(x).trim()).filter(Boolean) : [];
  store.set('order', list.filter((n) => loaded.has(n)));
  return listScripts();
}

/** 按用户顺序排好的脚本数组，取址时按这个顺序尝试 */
function orderScripts() {
  ensureRestored();
  const all = [...loaded.values()];
  const order = scriptOrder();
  const rank = (x) => {
    const at = order.indexOf(x.name);
    return at >= 0 ? at : order.length + x.importedAt;
  };
  return all.sort((a, b) => rank(a) - rank(b));
}

export function listScripts() {
  return orderScripts().map((x, i) => ({
    name: x.name,
    sources: x.sources,
    importedAt: x.importedAt,
    rank: i + 1,
  }));
}

export function removeScript(name) {
  ensureRestored();
  const key = String(name || '').trim();
  const had = loaded.delete(key);
  if (!had) fail('unavailable', t('找不到这个音源'));
  persist();
}

export function clearScripts() {
  loaded.clear();
  persist();
}

/**
 * 用已导入的音源取址。
 * 依次尝试每个脚本；某个脚本失败就换下一个，全部失败返回 null。
 * @returns {Promise<{url: string, from: string} | null>}
 */
/**
 * 直接用平台 ID 取地址（跳过 findId）。
 * 用于「当前平台有这首歌的 ID，但取不到播放地址」的场景，
 * 比如 QQ 里要会员，但第三方音源支持 wy/tx 平台，可以直接拿官方 ID 去要地址。
 */
export async function resolveUrlWithId({ musicInfo, source, quality = "320k" }) {
  if (!loaded.size) return null;
  for (const script of orderScripts()) {
    if (!script.sources.includes(source)) continue;
    try {
      const url = await withTimeout(
        Promise.resolve(script.handler({
          action: "musicUrl",
          source,
          info: { type: quality, musicInfo },
        })),
        TIMEOUT,
      );
      if (typeof url === "string" && /^https?:\/\//.test(url)) {
        console.warn("[luoxue] 「" + script.name + "」命中 " + source + ": " + (musicInfo.name || "") + " (id=" + (musicInfo.id || "") + ")");
        return { url, from: script.name, source };
      }
      console.warn("[luoxue] 「" + script.name + "」(" + source + ") 未返回地址");
    } catch (e) {
      console.warn("[luoxue] 「" + script.name + "」(" + source + ") 失败: " + (e && e.message ? e.message : e));
    }
  }
  return null;
}
export async function resolveUrl({ title, artist, duration, quality = '320k' }) {
  if (!loaded.size) return null;
  // 脚本的 musicUrl 要的是平台自己的歌曲 ID，不是歌名。
  // 所以先按歌名去各平台搜出最匹配的 ID，再按「脚本支持哪个平台」逐个试。
  const found = await findId({ title, artist, duration, sources: ['kw', 'kg', 'tx'] }).catch(() => null);
  if (!found) {
    console.warn('[luoxue] 没搜到匹配的歌曲 ID，跳过: ' + title);
    return null;
  }
  const source = found.source;
  const musicInfo = {
    name: found.item.title || title,
    singer: found.item.artist || artist,
    title: found.item.title || title,
    artist: found.item.artist || artist,
    interval: found.item.duration || duration,
    duration: found.item.duration || duration,
    songmid: found.item.songmid || found.item.id,
    hash: found.item.FileHash || found.item.id,
    FileHash: found.item.FileHash || found.item.id,
    HQFileHash: found.item.HQFileHash || '',
    SQFileHash: found.item.SQFileHash || '',
    rid: found.item.id,
    id: found.item.id,
    musicId: found.item.id,
    source,
  };

  for (const script of orderScripts()) {
    if (!script.sources.includes(source)) continue;
    try {
      const url = await withTimeout(
        Promise.resolve(script.handler({
          action: 'musicUrl',
          source,
          info: { type: quality, musicInfo },
        })),
        TIMEOUT,
      );
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        console.warn('[luoxue] 「' + script.name + '」命中 ' + source + ': ' + title + ' → ' + found.item.title);
        return { url, from: script.name, source };
      }
    } catch (e) {
      console.warn('[luoxue] 「' + script.name + '」(' + source + ') 失败: ' + (e && e.message ? e.message : e));
    }
  }
  return null;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('音源取址超时')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
