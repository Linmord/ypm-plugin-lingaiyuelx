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

/** 设置项也按 provider 分开，避免两个音质设置互相覆盖。
 *  只传一个参数时当作完整键名——历史上音质设置就是这么读的，
 *  传成 setting('qq:quality') 会被拼成 qq:quality:undefined 并静默读空。 */
/** 支持的音质档位，从低到高；hires 就是最高档（QQ 的 F000 无损 / 洛雪 flac24bit） */
export const QUALITY_LEVELS = ['standard', 'high', 'lossless', 'hires'];

/** 音质：插件设置面板的全局项优先，其次控制台按平台存的项，都没有就用最好音质 */
export function qualityOf(provider) {
  const known = (value) => (QUALITY_LEVELS.includes(value) ? value : '');
  return known(setting('quality')) || (provider ? known(setting(provider, 'quality')) : '') || 'hires';
}

export function setting(provider, name) {
  const key = name === undefined ? String(provider) : provider + ':' + name;
  return typeof host.setting === 'function' ? host.setting(key) : '';
}
