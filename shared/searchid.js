// 按歌名到各平台搜 ID，供落雪音源取址用。
//
// 为什么需要它：落雪音源的 musicUrl 接口要的是平台自己的歌曲 ID
// （酷我 MUSICRID、酷狗 FileHash、QQ songmid），不是歌名。
// 回落场景只有歌名+时长，所以得先搜出候选，挑最像的，再喂给脚本。
//
// 匹配策略：歌名必须有实质匹配（宽松指歌手不限，不是歌名不限），
// 时长误差 ≤5 秒，并剔除 cover/翻 DJ/片段 这类变体。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const DURATION_TOLERANCE = 5;
const VARIANT = /cover|翻自|翻唱|DJ|片段|伴奏|纯音乐|Live|现场|remix|混音|抖音|铃声|钢琴|小提琴|吉他|古筝|二胡|长笛|萨克斯|八音盒|口琴|手风琴|乐器|演奏|翻奏|纯享|和声|降调|升调|加速|慢速|男声|女声|童声|群星|合辑|串烧|medley|instrumental|piano|violin|guitar|karaoke|acoustic/i;

const decode = (value) => String(value ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .trim();

const plain = (value) => String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function looseJson(text) {
  const fixed = String(text)
    .replace(/'/g, '"')
    .replace(/\\(?!u[0-9a-fA-F]{4}|"|\\|\/)/g, '');
  return JSON.parse(fixed);
}

const mainArtist = (value) => String(value || '')
  .split(/[&,、/]|\bfeat\.?\b|\bft\.?\b/i)[0].replace(/\(.*?\)|（.*?）/g, '').trim();

const normalizeTitle = (value) => plain(value)
  .replace(/[\(（\[【].*?[\)）\]】]/g, '')
  .replace(/\s+/g, '')
  .toLowerCase();

/** 排序规则 */
function rank(candidates, { title, artist, duration }) {
  const wanted = normalizeTitle(title);
  if (!wanted) return [];
  const singer = mainArtist(artist).toLowerCase();
  const scored = [];
  for (const item of candidates) {
    if (!item.id) continue;
    if (VARIANT.test(item.title)) continue;
    if (duration > 0 && item.duration > 0 && Math.abs(item.duration - duration) > DURATION_TOLERANCE) continue;
    const found = normalizeTitle(item.title);
    if (!found) continue;
    // 只允许「候选包含目标」，不允许反向。
    // 反过来的话，搜「不存在的歌名xyzabc」会匹配到「不存在的」——目标串更长，
    // 反而更容易命中无关歌曲。这是实测踩到的坑。
    if (!(found === wanted || found.includes(wanted))) continue;
    let score = found === wanted ? 100 : 40;
    const itemSinger = mainArtist(item.artist).toLowerCase();
    if (singer && itemSinger === singer) score += 50;
    else if (singer && (itemSinger.includes(singer) || singer.includes(itemSinger))) score += 20;
    scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.item);
}

/** 酷我：MUSICRID + DURATION（秒） */
async function searchKuwo(title, artist) {
  const url = 'http://search.kuwo.cn/r.s?all=' + encodeURIComponent([title, mainArtist(artist)].filter(Boolean).join(' '))
    + '&ft=music&itemset=web_2013&client=kt&pn=0&rn=30&rformat=json&encoding=utf8';
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('kuwo ' + r.status);
  const body = looseJson(await r.text());
  return (body.abslist || []).map((x) => ({
    // 落雪脚本把 rid 直接拼进 URL，酷我要纯数字，MUSIC_ 前缀会报 parameter error
    id: String(x.MUSICRID || '').replace(/^MUSIC_/, ''),
    title: plain(decode(x.SONGNAME)),
    artist: plain(decode(x.ARTIST)),
    duration: Number(x.DURATION) || 0,
  }));
}

/** 酷狗：FileHash + SQFileHash/HQFileHash，Duration 是秒 */
async function searchKugou(title, artist) {
  const url = 'https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent([title, mainArtist(artist)].filter(Boolean).join(' '))
    + '&page=1&pagesize=30&platform=WebFilter&userid=-1&clientver=2000';
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('kugou ' + r.status);
  const j = await r.json();
  const list = (j.data && j.data.lists) || [];
  return list.map((x) => ({
    id: String(x.FileHash || ''),
    title: plain(decode(x.SongName)),
    artist: plain(decode(x.SingerName)),
    duration: Number(x.Duration) || 0,
    // 落雪脚本会优先读 SQFileHash / HQFileHash
    SQFileHash: String(x.SQFileHash || ''),
    HQFileHash: String(x.HQFileHash || ''),
    FileHash: String(x.FileHash || ''),
  }));
}

/** QQ：songmid，interval 是秒 */
async function searchQq(title, artist) {
  const url = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=' + encodeURIComponent([title, mainArtist(artist)].filter(Boolean).join(' '))
    + '&format=json&n=30&p=1';
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('qq ' + r.status);
  const j = await r.json();
  const list = (j.data && j.data.song && j.data.song.list) || [];
  return list.map((x) => ({
    id: String(x.songmid || ''),
    title: plain(decode(x.songname)),
    artist: (x.singer || []).map((s) => s.name).filter(Boolean).join(' / '),
    duration: Number(x.interval) || 0,
    songmid: String(x.songmid || ''),
  }));
}

const SEARCHERS = { kw: searchKuwo, kg: searchKugou, tx: searchQq };

/**
 * 搜出最匹配的候选，返回 { source, musicInfo } 供落雪脚本使用。
 * @returns {Promise<{source: string, item: object} | null>}
 */
export async function findId({ title, artist, duration, sources = ['kw', 'kg', 'tx'] }) {
  if (!title) return null;
  for (const source of sources) {
    const searcher = SEARCHERS[source];
    if (!searcher) continue;
    try {
      const list = await searcher(title, artist);
      const best = rank(list, { title, artist, duration })[0];
      if (best) return { source, item: best };
    } catch (e) {
      console.warn('[search-id] ' + source + ' 失败: ' + (e && e.message ? e.message : e));
    }
  }
  return null;
}

export { SEARCHERS };
