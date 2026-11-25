// 两个音源的 storage 键会撞车（都用 account / sessionEpoch），按前缀隔离。
// 宿主只给一个全局 host，所以每个 provider 拿自己的作用域访问器。
const PREFIX = 'p:';

export function scoped(provider) {
  const key = (name) => PREFIX + provider + ':' + name;
  return {
    get: (name) => host.storage.get(key(name)),
    set: (name, value) => host.storage.set(key(name), value),
    remove: (name) => host.storage.remove(key(name)),
  };
}

/** 设置项也按 provider 分开，避免两个音质设置互相覆盖 */
export function setting(provider, name) {
  return typeof host.setting === 'function' ? host.setting(provider + ':' + name) : '';
}
