// 多音源播放器插件：网易云 + QQ 音乐共用一个入口，id 用「provider:原始id」区分。
// 宿主只把 id 原样回传，所以命名空间是唯一能区分来源的办法。
import * as netease from './providers/netease/api.js';
import * as qq from './providers/qq/api.js';
import { encode, decode, PROVIDERS } from './shared/ids.js';
import { scoped } from './shared/storage.js';
import { t } from './shared/i18n.js';
import * as luoxue from './shared/luoxue.js';
// 副作用导入：模块加载时把 Web 控制台拉起来，宿主关插件它就跟着结束
import './shared/console-launcher.js';

const registry = { netease, qq };
const LABEL = { netease: '网易云音乐', qq: 'QQ 音乐' };
/** 搜索默认查哪些音源；网易云作为主音源，官方优先 */
const PRIMARY = 'netease';
/** 搜索结果总量上限：超过就不再返回 more，避免宿主无限加载把内存撑爆 */
const SEARCH_MAX_ITEMS = 300;

/** 单源返回的歌曲上限，合并后按此截断，避免一次拉太多 */
const MERGE_LIMIT = 40;

const store = scoped('core');
/** 设置项 clearSessions 是自毁开关：读到 true 就清凭据，提示用户手动关掉 */
function honorClear() {
  if (typeof host.setting !== 'function') return;
  if (host.setting('clearSessions') !== 'true') return;
  for (const name of PROVIDERS) {
    try {
      // signOut 只是切走当前账号；真正删凭据要清账号表
      const api = registry[name];
      if (typeof api.clearAll === 'function') api.clearAll();
      else api.signOut();
    } catch (_) { /* 已登出 */ }
  }
  store.set('hiddenProviders', []);
  store.set('shownProvider', '');
  console.warn('[multisource] 已清除全部登录凭据，请手动关闭「清除全部登录」开关');
}
const enabled = () => {
  const raw = typeof host.setting === 'function' ? host.setting('fallback') : '';
  return raw === 'true' || raw === '1';
};

// 音源集合固定为全部已登录的音源：没登录的那个在调用时会抛错并被跳过，
// 所以不需要额外的开关让用户勾选。


function activeSources() {
  return PROVIDERS;
}

/** 首页候选顺序：primary 优先，其余按 sources */
/**
 * 用户数据（歌单、喜欢的歌、收藏专辑）只显示当前账号所属的音源。
 * 不能用 activeSources()：那会合并两个平台的歌单，切换账号后看起来没变。
 * 没有当前账号时才退回全部音源。
 */
function currentSources() {
  const account = activeAccountProvider();
  if (!account) return PROVIDERS;
  return [account, ...PROVIDERS.filter((x) => x !== account)];
}

function homeOrder() {
  // 首页只跟随当前账号：登的是哪个平台就用哪个平台的推荐。
  const account = activeAccountProvider();
  if (!account) return PROVIDERS;
  return [account, ...PROVIDERS.filter((x) => x !== account)];
}

/**
 * 当前音源。用户在控制台点「使用这个平台」时写入 activeProvider；
 * 没手动选过就用最近登录的平台，避免出现「刚登完 QQ 却还在看网易云」。
 */
function activeAccountProvider() {
  const raw = typeof host.setting === 'function' ? host.setting('activeProvider') : '';
  const name = String(raw || '').trim();
  if (PROVIDERS.includes(name)) return name;
  // 没手动选过时用最近登录的平台
  const recent = store.get('lastSignInProvider');
  return PROVIDERS.includes(recent) ? recent : '';
}

function target(value) {
  const { provider, id } = decode(value);
  // 裸 id 优先归当前账号所属音源，而不是写死网易云：
  // 宿主的页面缓存里可能存着切换前的 id，跟着账号走才不会张冠李戴。
  const name = provider || activeAccountProvider() || PRIMARY;
  const api = registry[name];
  if (!api) throw Object.assign(new Error(t('未知音源')), { code: 'unsupported' });
  return { provider: name, api, id };
}

/** 把 provider 返回的实体里的 id 全部加上命名空间 */
const tagTrack = (provider, track) => track && { ...track, id: encode(provider, track.id) };
const tagAlbum = (provider, album) => album && { ...album, id: encode(provider, album.id) };
const tagArtist = (provider, artist) => artist && { ...artist, id: encode(provider, artist.id) };
const tagPlaylist = (provider, playlist) => playlist && {
  ...playlist,
  id: encode(provider, playlist.id),
  tracks: Array.isArray(playlist.tracks) ? playlist.tracks.map((x) => tagTrack(provider, x)) : playlist.tracks,
};

/** 当前要显示哪个音源的账号；被 signOut 隐藏的音源不进候选 */
const hidden = () => {
  const raw = store.get('hiddenProviders');
  return Array.isArray(raw) ? raw : [];
};

export async function account() {
  // 设置项可以填账号 ID，也可以填昵称（模糊匹配），都找不到就退回「最近登录」。
  honorClear();
  const skip = hidden();
  // 用户切换过账号就以它为准，否则按 PROVIDERS 顺序
  const preferred = activeAccountProvider();
  const order = preferred ? [preferred, ...PROVIDERS.filter((x) => x !== preferred)] : PROVIDERS;
  for (const name of order) {
    if (skip.includes(name)) continue;
    try {
      const value = await registry[name].account();
      if (value) {
        // 记下这次显示的是谁，signOut 才知道该摘掉哪一个
        store.set('shownProvider', name);
        return { ...value, id: encode(name, value.id), name: value.name + ' · ' + LABEL[name] };
      }
    } catch (_) { /* 某个音源未登录或离线不影响另一个 */ }
  }
  return null;
}

/**
 * 宿主只有一个「登录」按钮，但插件里有两个账号体系。
 * 用设置项 signInProvider 决定这次登哪个，默认网易云；登完后切到另一个再点一次即可。
 */
export async function signIn() {
  honorClear();
  const chosen = typeof host.setting === 'function' ? host.setting('signInProvider') : '';
  const name = PROVIDERS.includes(chosen) ? chosen : PRIMARY;
  const value = await registry[name].signIn();
  // 记住最近登录的平台，下次默认用它
  if (value) store.set('lastSignInProvider', name);
  if (!value) return value;
  // 登录成功就把这个音源从隐藏列表里放出来，否则刚登完仍然看不到
  const list = hidden().filter((x) => x !== name);
  store.set('hiddenProviders', list);
  store.set('shownProvider', name);
  return { ...value, id: encode(name, value.id), name: value.name + ' · ' + LABEL[name] };
}

/**
 * 宿主只有一个按钮，登了 A 就没法登 B。所以这里的「退出登录」只把当前音源
 * 从显示里摘掉，凭据留在 storage 里；设置项 signInProvider 切到另一个音源再点登录即可。
 * 真要删凭据用「清除全部登录」开关（见 clearSessions）。
 */
export function signOut() {
  const shown = store.get('shownProvider');
  const name = PROVIDERS.includes(shown) ? shown : PRIMARY;
  const list = hidden();
  if (!list.includes(name)) store.set('hiddenProviders', [...list, name]);
}

/** 设置项 clearSessions 打开时，把所有音源的凭据真正删掉 */
export function clearSessions() {
  for (const name of PROVIDERS) {
    try {
      const api = registry[name];
      if (typeof api.clearAll === 'function') api.clearAll();
      else api.signOut();
    } catch (_) { /* 已登出 */ }
  }
  store.set('hiddenProviders', []);
}

/** 单个音源的音乐库/搜索入口；id 全部加命名空间 */
export async function search({ query = '', kind = 'tracks', offset = 0, provider = '' }) {
  // 当前账号所属音源排第一，它的结果会出现在最前面
  const names = provider ? [provider] : currentSources();
  const start = Math.max(0, Number(offset) || 0);
  // 每个音源分一半配额：合并后总数稳定在 MERGE_LIMIT 以内。
  // 不这么做的话两个音源各返回 40 条、合并 80 条，宿主翻十几页就是上千条 DOM，
  // 内存涨上去客户端会闪退；而事后截断又会让 offset 推进失真。
  const quota = Math.max(1, Math.floor(MERGE_LIMIT / names.length));
  // 各音源分别收集，最后交替排列：
  // 这样不会出现「前 20 条全是网易云、后 20 条全是 QQ」，两边的结果都能露出来。
  const buckets = [];
  let more = false;
  let total = 0;
  for (const name of names) {
    const api = registry[name];
    if (!api || typeof api.search !== 'function') continue;
    let result;
    try { result = await api.search({ query, kind, offset: start }); }
    catch (e) {
      if (names.length === 1) throw e;
      continue;
    }
    const list = result?.[kind] || [];
    const tag = { tracks: tagTrack, albums: tagAlbum, artists: tagArtist, playlists: tagPlaylist }[kind];
    buckets.push(list.slice(0, quota).map((x) => tag(name, x)));
    if (result?.more) more = true;
    if (typeof result?.total === 'number') total += result.total;
  }

  // 交替排列：第 1 条来自音源 A、第 2 条来自 B、第 3 条回到 A……
  const merged = [];
  const maxLen = buckets.reduce((n, b) => Math.max(n, b.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const b of buckets) {
      if (i < b.length) merged.push(b[i]);
    }
  }
  // 去重：不同音源可能有相同 id（罕见，但去了更稳）
  const seen = new Set();
  const page = [];
  for (const item of merged) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    page.push(item);
  }
  // 空页必须终止；offset 超过上限也终止。
  // 否则宿主会一直往下翻，几千条 DOM 会让客户端闪退。
  const beyond = start + page.length >= SEARCH_MAX_ITEMS;
  return { [kind]: page, more: (page.length === 0 || beyond) ? false : more, total: Math.min(total || page.length, SEARCH_MAX_ITEMS) };
}

export async function suggest({ query = '' }) {
  const all = [];
  for (const name of activeSources()) {
    try { all.push(...await registry[name].suggest({ query })); } catch (_) { /* 忽略单源失败 */ }
  }
  return [...new Set(all)].slice(0, 10);
}

export async function home() {
  for (const name of homeOrder()) {
    try {
      const page = await registry[name].home();
      if (page) return retagPage(name, page);
    } catch (_) { /* 换下一个音源 */ }
  }
  throw Object.assign(new Error(t('没有可用的音源')), { code: 'setup' });
}

function retagPage(provider, page) {
  if (!page || typeof page !== 'object') return page;
  const out = { ...page };
  if (Array.isArray(page.sections)) {
    out.sections = page.sections.map((section) => ({
      ...section,
      tracks: section.tracks?.map((x) => tagTrack(provider, x)),
      albums: section.albums?.map((x) => tagAlbum(provider, x)),
      artists: section.artists?.map((x) => tagArtist(provider, x)),
      playlists: section.playlists?.map((x) => tagPlaylist(provider, x)),
    }));
  }
  return out;
}

export async function browse({ page = '' }) {
  // 页面名带音源前缀：netease:charts / qq:charts
  const { provider, id } = decode(page);
  if (provider) {
    const api = registry[provider];
    if (!api) throw Object.assign(new Error(t('未知音源')), { code: 'unsupported' });
    return retagPage(provider, await api.browse({ page: id }));
  }
  // 没指定音源时依次尝试：某个音源要求登录不该让整个发现页空白
  let first = null;
  for (const name of currentSources()) {
    try {
      const page0 = await registry[name].browse({ page: id });
      if (page0) return retagPage(name, page0);
    } catch (e) {
      if (!first) first = e;
    }
  }
  throw first || Object.assign(new Error(t('没有可用的音源')), { code: 'setup' });
}

export async function album({ id }) {
  const { provider, api, id: raw } = target(id);
  const result = await api.album({ id: raw });
  return { album: tagAlbum(provider, result.album), tracks: (result.tracks || []).map((x) => tagTrack(provider, x)) };
}

export async function artist({ id }) {
  const { provider, api, id: raw } = target(id);
  const result = await api.artist({ id: raw });
  return {
    artist: tagArtist(provider, result.artist),
    tracks: (result.tracks || []).map((x) => tagTrack(provider, x)),
    albums: (result.albums || []).map((x) => tagAlbum(provider, x)),
    related: (result.related || []).map((x) => tagArtist(provider, x)),
  };
}

/**
 * 音乐库的「歌曲 / 专辑 / 艺人」三个 tab 走这个函数。
 * 不实现的话宿主会退回 liked / savedAlbums，来源会混乱。
 * 这里只聚合当前账号所属音源的数据。
 */
export async function library({ kind = "tracks", offset = 0 } = {}) {
  const name = activeAccountProvider() || PRIMARY;
  const api = registry[name];
  if (!api) throw Object.assign(new Error(t("未知音源")), { code: "unsupported" });

  if (kind === "tracks") {
    if (typeof api.liked !== "function") return { tracks: [], more: false };
    const page = await api.liked({ offset });
    return { tracks: (page.tracks || []).map((x) => tagTrack(name, x)), more: Boolean(page.more) };
  }

  if (kind === "albums") {
    if (typeof api.savedAlbums !== "function") return { albums: [], more: false };
    const list = await api.savedAlbums({ offset });
    const albums = (Array.isArray(list) ? list : []).map((x) => tagAlbum(name, x));
    return { albums, more: albums.length > 0 };
  }

  if (kind === "artists") {
    // 两个音源都没有「关注的歌手」接口，返回空而不是报错
    return { artists: [], more: false };
  }

  if (kind === "playlists") {
    if (typeof api.playlists !== "function") return { playlists: [], more: false };
    const list = await api.playlists();
    return { playlists: (Array.isArray(list) ? list : []).map((x) => tagPlaylist(name, x)), more: false };
  }

  return { more: false };
}
export async function playlists() {
  // 只显示当前账号所属平台的歌单；切换账号后这里跟着变
  for (const name of currentSources()) {
    try {
      const list = await registry[name].playlists();
      if (Array.isArray(list) && list.length) return list.map((x) => tagPlaylist(name, x));
    } catch (_) { /* 这个音源没登录，换下一个 */ }
  }
  return [];
}

export async function playlist({ id }) {
  const { provider, api, id: raw } = target(id);
  return tagPlaylist(provider, await api.playlist({ id: raw }));
}

export async function liked({ offset = 0 }) {
  for (const name of currentSources()) {
    try {
      const page = await registry[name].liked({ offset });
      if (page?.tracks?.length) return { tracks: page.tracks.map((x) => tagTrack(name, x)), more: page.more };
    } catch (_) { /* 换下一个音源 */ }
  }
  return { tracks: [], more: false };
}

export async function savedAlbums({ offset = 0 }) {
  for (const name of currentSources()) {
    try {
      const list = await registry[name].savedAlbums({ offset });
      if (Array.isArray(list) && list.length) return list.map((x) => tagAlbum(name, x));
    } catch (_) { /* 换下一个音源 */ }
  }
  return [];
}

export async function isLiked({ ids = [] }) {
  const groups = new Map();
  for (const value of ids) {
    const { provider, id } = decode(value);
    const name = provider || PRIMARY;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(id);
  }
  const out = {};
  for (const [name, list] of groups) {
    const api = registry[name];
    if (!api || typeof api.isLiked !== 'function') continue;
    try {
      const result = await api.isLiked({ ids: list });
      if (Array.isArray(result)) list.forEach((id, i) => { out[encode(name, id)] = Boolean(result[i]); });
      else for (const [id, on] of Object.entries(result || {})) out[encode(name, id)] = on;
    } catch (_) { /* 忽略 */ }
  }
  return out;
}

export async function like({ id, on }) {
  const { provider, api, id: raw } = target(id);
  if (typeof api.like !== 'function') throw Object.assign(new Error(t('不支持的操作')), { code: 'unsupported' });
  return api.like({ id: raw, on });
}

export async function lyrics({ id }) {
  const { provider, api, id: raw } = target(id);
  return api.lyrics({ id: raw });
}

/**
 * 播放：先走官方链路，官方判为 unavailable 时才回落第三方。
 * 回落失败仍然抛原始错误，让用户看到「需要会员」而不是「未知错误」。
 */
export async function stream({ id: value, quality = 'high' }) {
  const { provider, api, id } = target(value);
  try {
    const result = await api.stream({ id, quality });
    return { ...result, url: result.url };
  } catch (e) {
    if (!enabled() || e?.code !== 'unavailable') throw e;

    // 先用官方 ID 问第三方音源：当前平台有这首歌的 ID，
    // 第三方音源往往支持同一个平台，能直接换到可播地址。
    // 这条比「按歌名去别的平台搜」准确得多，不会搜错版本。
    const direct = await tryLuoxueWithId(provider, id, quality).catch(() => null);
    if (direct) return direct;

    // 官方 ID 这条路也失败，直接报原始错误。
    // 不再按歌名去酷我搜（内置那条路命中率低，而且容易匹配到翻唱）。
    throw e;
  }

  /** 用当前平台的官方 ID 直接向落雪音源要地址 */
  async function tryLuoxueWithId(provider, id, quality) {
    if (!luoxue.listScripts().length) return null;
    const detail = await describe(provider, id).catch(() => null);
    if (!detail) return null;
    // 落雪音源的平台代号：网易云 wy / QQ tx / 酷我 kw / 酷狗 kg
    const code = { netease: 'wy', qq: 'tx' }[provider];
    if (!code) return null;
    const musicInfo = {
      name: detail.title, singer: detail.artist, title: detail.title, artist: detail.artist,
      interval: detail.duration, duration: detail.duration,
      songmid: id, id, musicId: id, rid: id, hash: id, FileHash: id,
      HQFileHash: '', SQFileHash: '',
      source: code,
    };
    const hit = await luoxue.resolveUrlWithId({ musicInfo, source: code, quality: '320k' });
    if (!hit) return null;
    console.warn('[fallback] ' + detail.title + ' 用官方 ID 从「' + hit.from + '」取到地址');
    return { url: hit.url, type: 'mp3', quality: 'high', bitRate: 320000 };
  }
}

/** 回落需要歌名和时长，而 stream 只拿到 id，所以查一次详情 */
async function describe(provider, id) {
  const api = registry[provider];
  if (provider === 'netease') {
    const found = await api.detail?.(id);
    return found || null;
  }
  const found = await api.detail?.(id);
  return found || null;
}


/** 账号管理：给控制台用，宿主 UI 不调用 */

/** 落雪音源管理：导入 / 列出 / 删除，由控制台调用 */
export function importSource({ name, source }) {
  return luoxue.importScript(name, source);
}
export async function importSourceFromUrl({ name, url }) {
  return luoxue.importFromUrl(name, url);
}
export function listSources() {
  return luoxue.listScripts();
}
export function reorderSources({ names }) {
  return luoxue.setOrder(names);
}

export function removeSource({ name }) {
  luoxue.removeScript(name);
  return luoxue.listScripts();
}
export function clearSources() {
  luoxue.clearScripts();
  return [];
}

export function accounts() {
  return { netease: [], qq: qq.accounts_ ? qq.accounts_() : [] };
}
export function switchAccount({ provider, id }) {
  if (provider !== 'qq') throw Object.assign(new Error(t('该音源不支持多账号')), { code: 'unsupported' });
  return qq.switchAccount(id);
}
export function removeAccount({ provider, id }) {
  if (provider !== 'qq') throw Object.assign(new Error(t('该音源不支持多账号')), { code: 'unsupported' });
  return qq.removeAccount(id);
}

export function trackMenu({ track }) {
  const { provider } = decode(track?.id);
  const api = registry[provider || PRIMARY];
  return api?.trackMenu ? api.trackMenu({ track }) : [];
}

export function menuAction(args) {
  const { provider, api } = target(args?.track?.id);
  return api.menuAction ? api.menuAction(args) : {};
}
