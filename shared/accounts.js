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

export function list(provider) {
  const raw = store.get(key(provider));
  return Array.isArray(raw) ? raw : [];
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
  const accounts = list(provider);
  const at = accounts.findIndex((a) => a.id === account.id);
  if (at >= 0) {
    accounts[at] = { ...accounts[at], ...account };
  } else {
    accounts.push(account);
  }
  save(provider, accounts);
  if (!options.keepActive) setActive(provider, account.id);
  return account;
}

export function remove(provider, id) {
  const accounts = list(provider).filter((a) => a.id !== id);
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
  }));
}
