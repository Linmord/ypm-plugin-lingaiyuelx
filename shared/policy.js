// 「灰歌是否可播」由回落开关决定：开了回落就不该在列表层把歌标成不可播，
// 否则用户点不动，永远走不到 stream() 的回落链。
// 宿主设置改动后立即生效，所以每次读，不缓存。
export function fallbackEnabled() {
  if (typeof host.setting !== 'function') return false;
  const raw = host.setting('fallback');
  return raw === 'true' || raw === '1';
}

/** 官方判定不可播、但回落可能救回来时，保留可点击状态 */
export function playable(officialUnavailable) {
  return officialUnavailable ? !fallbackEnabled() : false;
}
