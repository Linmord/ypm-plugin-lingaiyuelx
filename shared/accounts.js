// 多账号管理。
//
// 宿主只有一个账号槽位，account() 只能返回一个对象。所以：
// - 每个音源可以保存多个账号，各自独立凭据
// - 有一个「当前账号」指针，account() 返回它
// - signOut 只切走当前账号，凭据保留；要删用 removeAccount
import { scoped } from '../shared/storage.js';

const store = scoped('core');

/** 账号列表的存储键 */
const key = (provider) => 'accounts:' + provider;
const activeKey = (provider) => 'active:' + provider;

/**
 * 删除要留「墓碑」。
 *
 * 宿主持有一份 storage 的内存副本，并且每隔几秒把整表写回 storage.json，
 * 所以控制台删掉的账号过几秒就会被写回来（重载插件后又出现）。
 * settings.json 不一样：它只在插件加载时读一次，不会被定时覆盖，
 * 所以把「谁被删了」记在设置项 removedAccounts 里，插件加载后再照着清一遍。
 *
 * 格式：provider:id@时间戳，逗号分隔。
 * 带时间戳是为了「删完又主动登录回来」不会被误杀——账号被重新写入时
 * updatedAt 会变新，比墓碑晚就不算删除。
 */
const REMOVED = 'removedAccounts';

function readSetting(name) {
  try {
    return typeof host.setting === 'function' ? String(host.setting(name) || '') : '';
  } catch (_) {
    return '';
  }
}

/** 解析墓碑串，返回 Map<'provider:id', 时间戳> */
export function parseRemoved(text) {
  const map = new Map();
  for (const part of String(text || '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const at = item.lastIndexOf('@');
    const name = at < 0 ? item : item.slice(0, at);
    const ts = Number(at < 0 ? 0 : item.slice(at + 1)) || 0;
    if (name) map.set(name, Math.max(ts, map.get(name) || 0));
  }
  return map;
}

/** 墓碑串：把一条新记录追加进去，顺手丢掉 30 天前的旧记录 */
export function withRemoved(text, provider, id, now = Date.now()) {
  const map = parseRemoved(text);
  map.set(provider + ':' + id, now);
  const keepFrom = now - 30 * 24 * 3600 * 1000;
  const parts = [];
  for (const [name, ts] of map) if (ts >= keepFrom) parts.push(name + '@' + ts);
  return parts.join(',');
}

function removedMap() {
  return parseRemoved(readSetting(REMOVED));
}

function isRemoved(provider, account, dead) {
  const ts = dead.get(provider + ':' + String(account && account.id));
  return !!ts && ts > (Number(account && account.updatedAt) || 0);
}

/** 有效账号（已过滤被删除的） */
export function list(provider) {
  const raw = store.get(key(provider));
  const accounts = Array.isArray(raw) ? raw : [];
  const dead = removedMap();
  if (!dead.size) return accounts;
  return accounts.filter((a) => !isRemoved(provider, a, dead));
}

/**
 * 把被删除的账号真正从宿主存储里清掉。
 * 插件每次加载后调用一次，宿主的内存副本也就干净了，
 * 之后它再整表写盘也不会把账号写回来。
 */
export function purge(provider) {
  const raw = store.get(key(provider));
  if (!Array.isArray(raw)) return 0;
  const dead = removedMap();
  if (!dead.size) return 0;
  const alive = raw.filter((a) => !isRemoved(provider, a, dead));
  if (alive.length === raw.length) return 0;
  save(provider, alive);
  if (!alive.some((a) => a.id === activeId(provider))) setActive(provider, alive[0] ? alive[0].id : '');
  return raw.length - alive.length;
}

function save(provider, accounts) {
  store.set(key(provider), accounts);
}

export function activeId(provider) {
  return store.get(activeKey(provider)) || '';
}

export function setActive(provider, id) {
  store.set(activeKey(provider), id);
}

/** 当前账号；没有就返回 null */
export function current(provider) {
  const id = activeId(provider);
  return list(provider).find((a) => a.id === id) || null;
}

/**
 * 新增或更新一个账号。
 * account: { id, name, imageUrl, loginType, credential }
 * 同一个 id 视为同一账号，覆盖凭据并保留昵称。
 */
/**
 * 新增或更新一个账号。
 * options.keepActive=true 时不动「当前账号」——登录和切换是两件事，
 * 已登录状态下再登录不该把用户正在用的账号顶掉。
 */
export function upsert(provider, account, options = {}) {
  // 用原始表：刚被墓碑标记的账号再登录一次时，updatedAt 要能盖过墓碑时间戳
  const raw = store.get(key(provider));
  const accounts = Array.isArray(raw) ? raw.slice() : [];
  const at = accounts.findIndex((a) => a.id === account.id);
  const stamped = { ...account, updatedAt: Date.now() };
  if (at >= 0) {
    accounts[at] = { ...accounts[at], ...stamped };
  } else {
    accounts.push(stamped);
  }
  save(provider, accounts);
  if (!options.keepActive) setActive(provider, account.id);
  return account;
}

export function remove(provider, id) {
  const raw = store.get(key(provider));
  const accounts = (Array.isArray(raw) ? raw : []).filter((a) => a.id !== id);
  save(provider, accounts);
  if (activeId(provider) === id) {
    setActive(provider, accounts[0] ? accounts[0].id : '');
  }
}

export function clear(provider) {
  save(provider, []);
  setActive(provider, '');
}

/** 脱敏后的账号信息，给 UI 用（不带 credential） */
export function publicView(provider) {
  const id = activeId(provider);
  return list(provider).map((a) => ({
    id: a.id,
    name: a.name,
    imageUrl: a.imageUrl || '',
    loginType: a.loginType || '',
    active: a.id === id,
    // 凭据失效：还能看到这个账号，但要用它得重新登录
    invalid: !!a.invalid,
  }));
}
