// 宿主只把 id 原样回传，不带音源信息，所以跨插件边界时给 id 加前缀。
// netease:347230 / qq:0039MnYb0qxYhV；没有前缀的历史 id 归主音源。
export const PROVIDERS = ['netease', 'qq'];

export function encode(provider, id) {
  const value = String(id ?? '');
  if (!value) return '';
  return value.startsWith(provider + ':') ? value : provider + ':' + value;
}

export function decode(value) {
  const text = String(value ?? '');
  const at = text.indexOf(':');
  if (at < 0) return { provider: '', id: text };
  const provider = text.slice(0, at);
  if (!PROVIDERS.includes(provider)) return { provider: '', id: text };
  return { provider, id: text.slice(at + 1) };
}
