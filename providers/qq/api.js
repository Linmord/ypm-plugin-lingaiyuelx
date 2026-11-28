import * as accountStore from '../../shared/accounts.js';
import { cgi, webGet, fail, guid, requireAccount, resourceId, session } from './client.js';
import { scoped, setting as readSetting, qualityOf } from '../../shared/storage.js';
const store = scoped('qq');
import { t } from './i18n.js';
import * as model from './models.js';
import { lyricText } from './lyrics.js';
// 显式导出，便于宿主安装前静态识别能力。
export { account, signIn, signOut, clearAll, accounts_, switchAccount, removeAccount, verifyAccounts } from './login.js';

/** 歌单最多返回多少首：一次给太多（比如 1240 首 / 575 KB）宿主会渲染到内存耗尽闪退 */
const PLAYLIST_MAX = 300;

const PAGE = 30;
const offsetOf = (value) => Math.max(0, Math.floor(Number(value) || 0));
const numeric = (value) => { const id = resourceId(value); if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) fail('unavailable', '无效的 QQ 音乐资源编号'); return Number(id); };
/** 当前账号的凭据：多账号改造后 session 不再使用，统一从账号表取 */
function currentCredential() {
  const saved = accountStore.current('qq');
  if (saved && saved.credential) return saved.credential;
  return session();
}

const encryptedUin = () => { requireAccount(); const id = currentCredential().encryptUin; if (!id) fail('signIn', '登录缺少音乐库授权信息，请重新使用 QQ 音乐 App 扫码'); return id; };

export async function search({ query = '', kind = 'tracks', offset = 0 }) {
  const types = { tracks: 0, artists: 1, albums: 2, playlists: 3 };
  if (!(kind in types)) fail('unsupported', '不支持这种搜索类型');
  if (!query.trim()) return { [kind]: [], more: false };
  const start = offsetOf(offset);
  const data = await cgi('music.search.SearchCgiService', 'DoSearchForQQMusicMobile', { query: query.trim(), search_type: types[kind], num_per_page: PAGE, page_num: Math.floor(start / PAGE) + 1, search_id: String(Date.now()) + '0', highlight: 0 }, { platform: 'desktop' });
  const body = data.body || data;
  const item = body[{ tracks: 'item_song', albums: 'item_album', artists: 'singer', playlists: 'item_songlist' }[kind]];
  const items = model.list(item?.items || item || body[{ tracks: 'song', albums: 'album', artists: 'singer', playlists: 'songlist' }[kind]]?.list);
  const map = { tracks: model.track, albums: model.album, artists: model.artist, playlists: model.playlist }[kind];
  const total = Number(data.meta?.sum ?? data.meta?.estimate_sum ?? items.length);
  return { [kind]: items.map((x) => map(x)), total, more: start + items.length < total && items.length > 0 };
}

async function allPages(fetch, field, totalField) {
  const result = [];
  for (let page = 0; page < 100; page++) {
    const data = await fetch(result.length);
    const rows = model.list(field(data));
    result.push(...rows);
    const total = Number(totalField(data));
    if (!rows.length || (Number.isFinite(total) && result.length >= total)) return result;
  }
  fail('unsupported', '该列表过大，暂不支持一次载入，请拆分后再打开');
}

export async function album({ id }) {
  id = resourceId(id);
  const detail = await cgi('music.musichallAlbum.AlbumInfoServer', 'GetAlbumDetail', /^\d+$/.test(id) ? { albumId: numeric(id) } : { albumMId: id });
  const meta = detail.basicInfo || detail.album || detail;
  const al = model.album({ ...meta, singers: detail.singer?.singerList || meta.singers });
  const songs = await allPages((begin) => cgi('music.musichallAlbum.AlbumSongList', 'GetAlbumSongList', { ...(/^\d+$/.test(id) ? { albumId: numeric(id) } : { albumMid: id }), begin, num: 100 }), (j) => j.songList || j.list, (j) => j.totalNum);
  al.trackCount = songs.length;
  return { album: al, tracks: songs.map((x) => ({ ...model.track(x), album: al })) };
}

export async function artist({ id }) {
  id = resourceId(id);
  const [detail, songs, albums] = await Promise.all([
    cgi('music.musichallSinger.SingerInfoInter', 'GetSingerDetail', { singer_mids: [id], group_singer: 1, wiki_singer: 1, ex_singer: 1, pic: 1, photos: 0 }),
    cgi('musichall.song_list_server', 'GetSingerSongList', { singerMid: id, order: 1, number: 50, begin: 0 }),
    cgi('music.musichallAlbum.AlbumListServer', 'GetAlbumList', { singerMid: id, order: 1, number: 100, begin: 0 }),
  ]);
  const singer = detail.singer_list?.[0]?.basic_info || detail.singerList?.[0]?.basicInfo || detail.singer_list?.[0] || detail;
  return { artist: model.artist({ ...singer, mid: id }), tracks: model.list(songs.songList || songs.songlist).map(model.track), albums: model.list(albums.albumList).map((x) => model.album(x.albumInfo || x)), related: [] };
}

/** 带退避的重试：官方接口偶发失败很常见，重试一两次往往就好了 */
/** 歌单内容缓存：同一个歌单 5 分钟内重复打开不再请求服务端 */
const PLAYLIST_TTL = 5 * 60 * 1000;
const playlistCache = new Map();

function cacheGet(key) {
  const hit = playlistCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PLAYLIST_TTL) { playlistCache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  // 只留最近 30 个，避免内存无限增长
  if (playlistCache.size > 30) playlistCache.delete(playlistCache.keys().next().value);
  playlistCache.set(key, { at: Date.now(), value });
}

async function withRetry(fn, times = 2) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      // 只重试「服务端拒绝」这类临时错误，登录失效/参数错误不重试
      if (i >= times || (e && e.code && e.code !== 'failed')) throw e;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
}

export async function playlist({ id }) {
  const cacheKey = 'pl:' + String(id);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const params = { disstid: numeric(id), dirid: 0, tag: 1, userinfo: 1, orderlist: 1 };
  let info;
  // 到上限就停，不再继续翻页：歌单可能上千首，全量拉取又慢又浪费请求，
  // 而且一次给宿主上千条会让它渲染到内存耗尽闪退。
  const rows = [];
  let total = 0;
  for (let begin = 0; begin < PLAYLIST_MAX; begin += 300) {
    const data = await withRetry(() => cgi('music.srfDissInfo.DissInfo', { ...params, song_begin: begin, song_num: 300, onlysonglist: begin ? 1 : 0 }));
    const page = data.cdlist?.[0] || data;
    if (!info) info = page;
    const list = model.list(page.songlist);
    total = Number(page.total_song_num ?? page.songnum ?? list.length) || list.length;
    rows.push(...list);
    if (!list.length || rows.length >= total) break;
  }
  const capped = rows.slice(0, PLAYLIST_MAX);
  const base = model.playlist({ ...info, ...info?.dirinfo, id });
  const result = { ...base, tracks: capped.map(model.track), trackCount: total || capped.length, truncated: total > capped.length };
  cacheSet(cacheKey, result);
  return result;
}

export async function playlists() {
  const user = requireAccount();
  const created = await cgi('music.musicasset.PlaylistBaseRead', 'GetPlaylistByUin', { uin: user.id });
  const result = model.list(created.v_playlist).map((x) => model.playlist(x, true));
  if (session().encryptUin) {
    const saved = await allPages((offset) => cgi('music.musicasset.PlaylistFavRead', 'CgiGetPlaylistFavInfo', { uin: encryptedUin(), offset, size: 100 }), (j) => j.v_list, (j) => j.total);
    const ids = new Set(result.map((x) => x.id));
    for (const item of saved) { const p = model.playlist({ ...item, saved: true }); if (!ids.has(p.id)) { result.push(p); ids.add(p.id); } }
  }
  return result;
}

export async function liked({ offset = 0 }) {
  const data = await cgi('music.srfDissInfo.DissInfo', 'CgiGetDiss', { disstid: 0, dirid: 201, enc_host_uin: encryptedUin(), tag: 1, userinfo: 1, orderlist: 1, song_begin: offsetOf(offset), song_num: PAGE });
  const page = data.cdlist?.[0] || data;
  const tracks = model.list(page.songlist).map(model.track);
  return { tracks, more: tracks.length > 0 && offsetOf(offset) + tracks.length < Number(page.total_song_num || page.songnum || tracks.length) };
}

export async function savedAlbums({ offset = 0 }) {
  const data = await cgi('music.musicasset.AlbumFavRead', 'CgiGetAlbumFavInfo', { euin: encryptedUin(), offset: offsetOf(offset), size: PAGE });
  // 收藏专辑必须直接返回数组，兼容 YesPlayMusic 3.0 的音乐库读取路径。
  return model.list(data.v_list).map((x) => ({ ...model.album(x), saved: true }));
}

export async function home() {
  const data = await cgi('newsong.NewSongServer', 'get_new_song_info', { type: 5 });
  return { title: t('QQ音乐'), sections: [{ title: t('推荐新歌'), style: 'songs', tracks: model.list(data.song_list || data.songlist).slice(0, 36).map(model.track) }, { title: t('发现音乐'), links: [{ title: t('排行榜'), page: 'charts' }, { title: t('最新专辑'), page: 'new-albums' }] }] };
}

/** 分类标签：按网易云的做法做成 tabs，而不是 filters。
 * 宿主的 filters 只支持一行平铺的翻页标签，做不了两级分类；tabs 才是给分类用的。
 */
function categoryTabs(selected) {
  const base = [
    { title: t('推荐'), page: '' },
    { title: t('国语'), page: 'cat:165:0' },
    { title: t('英语'), page: 'cat:167:0' },
    { title: t('韩语'), page: 'cat:168:0' },
    { title: t('粤语'), page: 'cat:166:0' },
    { title: t('日语'), page: 'cat:169:0' },
    { title: t('流行'), page: 'cat:6:0' },
    { title: t('摇滚'), page: 'cat:11:0' },
    { title: t('民谣'), page: 'cat:28:0' },
    { title: t('电子'), page: 'cat:9:0' },
    { title: t('轻音乐'), page: 'cat:15:0' },
    { title: t('ACG'), page: 'cat:39:0' },
    { title: t('影视'), page: 'cat:133:0' },
    { title: t('伤感'), page: 'cat:52:0' },
    { title: t('治愈'), page: 'cat:116:0' },
    { title: t('学习'), page: 'cat:101:0' },
    { title: t('运动'), page: 'cat:99:0' },
    { title: t('睡前'), page: 'cat:78:0' },
    { title: t('新歌'), page: 'new-songs' },
    { title: t('排行榜'), page: 'charts' },
  ];
  return base.map((x) => ({ ...x, selected: x.page === selected }));
}

export async function browse({ page = '' }) {
  if (page === 'new-songs') {
    const data = await cgi('newsong.NewSongServer', 'get_new_song_info', { type: 5 });
    return { title: t('新歌速递'), sections: [{ tracks: model.list(data.songlist).slice(0, 36).map(model.track) }], tabs: categoryTabs(page) };
  }

  if (page === 'new-albums') {
    const data = await cgi('newalbum.NewAlbumServer', 'get_new_album_info', { area: 1, num: 50, start: 0 });
    return { title: t('最新专辑'), sections: [{ style: 'grid', albums: model.list(data.albums).map(model.album) }], tabs: categoryTabs(page) };
  }

  if (page === 'charts') {
    const data = await cgi('music.musicToplist.Toplist', 'GetAll', {});
    return { title: t('排行榜'), sections: model.list(data.group).map((group) => ({ title: group.groupName, style: 'grid', links: model.list(group.toplist).map((item) => ({ title: item.title, subtitle: item.updateTime, imageUrl: item.frontPicUrl || item.headPicUrl, page: 'top:' + item.topId })) })), tabs: categoryTabs(page) };
  }

  if (page.startsWith('top:')) {
    const data = await cgi('music.musicToplist.Toplist', 'GetDetail', { topId: numeric(page.slice(4)), offset: 0, num: 100, withTags: true });
    return { title: data.info?.title || t('排行榜'), sections: [{ tracks: model.list(data.song || data.songInfoList).map(model.track) }], tabs: categoryTabs('charts') };
  }

  // 分类歌单：cat:<categoryId>:<page>，走网页版接口
  if (page.startsWith('cat:')) {
    const [, categoryId, offset = '0'] = page.split(':');
    const pageNo = Number(offset) || 0;
    const size = 30;
    const data = await webGet('/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg', {
      categoryId: String(categoryId),
      sortId: '5',
      tagId: '0',
      sin: String(pageNo * size),
      ein: String(pageNo * size + size - 1),
      rnd: String(Math.random()),
    });
    const lists = model.list(data?.list).map((x) => ({
      id: String(x.dissid || ''),
      name: model.clean(x.dissname) || t('未命名歌单'),
      imageUrl: String(x.imgurl || '').replace(/^http:/, 'https:'),
      description: model.clean(x.introduction) || '',
      owner: model.clean(x.creator?.name) || '',
      trackCount: 0,
      plays: Number(x.listennum || 0),
      mine: false, saved: false, fixed: false,
    })).filter((x) => x.id);
    if (!lists.length) fail('unavailable', '这个分类下暂时没有歌单');
    const total = Number(data?.sum || 0);
    const sections = [{ style: 'grid', playlists: lists }];
    if (total > (pageNo + 1) * size) {
      sections.push({ links: [{ title: t('下一页'), page: 'cat:' + categoryId + ':' + (pageNo + 1) }] });
    }
    return { title: t('歌单分类'), sections, tabs: categoryTabs(page) };
  }

  // 兼容历史 page 路径（网易云时期留下的 playlists:* / cloud 等）
  if (page && !/^(new-songs|new-albums|charts|cat:|top:)/.test(page)) {
    page = '';
  }
  if (page) fail('unsupported', '不支持这个发现页面');

  // 发现页根：推荐歌单 + 排行榜入口 + 分类 tabs
  const [rec, charts] = await Promise.all([
    cgi('music.playlist.PlaylistSquare', 'GetRecommendFeed', { From: 0, Size: 24 }).catch(() => null),
    cgi('music.musicToplist.Toplist', 'GetAll', {}).catch(() => null),
  ]);

  const sections = [];
  const lists = model.list(rec?.List).map((x) => model.feedPlaylist(x.Playlist || x)).filter((x) => x.id);
  if (lists.length) sections.push({ title: t('推荐歌单'), style: 'grid', playlists: lists });
  if (charts) {
    const links = model.list(charts.group).flatMap((group) =>
      model.list(group.toplist).slice(0, 4).map((item) => ({ title: item.title, subtitle: group.groupName, imageUrl: item.frontPicUrl || item.headPicUrl, page: 'top:' + item.topId })));
    if (links.length) sections.push({ title: t('排行榜'), style: 'grid', links });
  }
  if (!sections.length) fail('unavailable', 'QQ 音乐暂时没有返回推荐内容');
  return { title: t('QQ 音乐'), sections, tabs: categoryTabs('') };
}

async function songDetail(id) {
  id = resourceId(id);
  const existing = model.songCache.get(id);
  if (existing?.file?.media_mid) return existing;
  const j = await cgi('music.pf_song_detail_svr', 'get_song_detail_yqq', /^\d+$/.test(id) ? { song_id: numeric(id) } : { song_mid: id });
  const song = j.track_info;
  if (!song) fail('unavailable', '歌曲暂不可用');
  model.track(song);
  return song;
}

export async function stream({ id, quality = 'high' }) {
  const choices = ['standard', 'high', 'lossless'];
  // 设置里有 hires：QQ 音乐的 Hi-Res 就是 F000 flac，没有更高的档，
  // 所以直接按 lossless 处理，不能再静默退回 320k。
  const normalize = (value) => (value === 'hires' ? 'lossless' : value);
  const setting = normalize(qualityOf('qq'));
  quality = normalize(quality);
  // 插件选择可以高于宿主默认的 high，不采用“音质上限”的限制方式。
  quality = choices.includes(setting) ? setting : choices.includes(quality) ? quality : 'high';
  const song = await songDetail(id);
  const mid = resourceId(song.mid || id), media = song.file?.media_mid;
  // 无损报 1411k：服务端不回码率，写 0 会让界面显示空码率（无损就是 16bit/44.1 的 1411kbps）
  const formats = quality === 'lossless' ? [['F000', '.flac', 'lossless', 1411200], ['M800', '.mp3', 'high', 320000], ['M500', '.mp3', 'standard', 128000]]
    : quality === 'standard' ? [['M500', '.mp3', 'standard', 128000]] : [['M800', '.mp3', 'high', 320000], ['M500', '.mp3', 'standard', 128000]];
  const names = formats.map(([prefix, ext]) => `${prefix}${media ? resourceId(media) : mid + mid}${ext}`);
  const data = await cgi('music.vkey.GetVkey', 'UrlGetVkey', { filename: names, guid: guid(), songmid: names.map(() => mid), songtype: names.map(() => song.type || 0), uin: session().uin || '0', loginflag: session().musickey ? 1 : 0, platform: '20', ctx: 0 });
  let unsupportedAddress = false;
  // 服务端返回顺序不保证音质排序，按请求的优先级选择完整音频。
  const ordered = names.flatMap((name) => model.list(data.midurlinfo).filter((item) => item.filename === name));
  for (const item of ordered) {
    const pos = names.indexOf(item.filename);
    if (pos < 0 || !item.purl || Number(item.result || 0) !== 0 || item.isTry || item.is_try || item.trial || /(?:^|\/)RS02|(?:^|[?&])(?:fromtag=preview|trial=1)/i.test(item.purl)) continue;
    unsupportedAddress = true;
    const bases = model.list(data.sip).filter((x) => /^https?:\/\//.test(x));
    if (!bases.length) bases.push('https://isure.stream.qqmusic.qq.com/');
    for (const base of bases) {
      let url;
      try { url = new URL(item.purl, base.replace(/^http:/, 'https:')); } catch (_) { continue; }
      // aqqmusic 是官方返回的独立 CDN 名称，并非 qqmusic.tc.qq.com 的子域名。
      const official = url.hostname === 'aqqmusic.tc.qq.com' || url.hostname.endsWith('.qqmusic.qq.com') || url.hostname.endsWith('.qqmusic.tc.qq.com');
      if (url.protocol !== 'https:' || !official || url.username || url.password || (url.port && url.port !== '443')) continue;
      if (url.pathname.split('/').pop() !== names[pos]) continue;
      return { url: url.href, type: formats[pos][1].slice(1), quality: formats[pos][2], bitRate: formats[pos][3] };
    }
  }
  if (unsupportedAddress) fail('failed', 'QQ音乐返回了暂不支持的音频地址，请更新插件或稍后重试');
  fail('unavailable', session().musickey ? '此歌曲需要会员、单独购买，或当前地区无版权；不会以试听片段代替完整歌曲' : '此歌曲需要登录或相应会员权限，请先扫码登录QQ音乐');
}

/** 回落取址需要歌名、歌手和时长；失败返回 null，由调用方决定是否放弃 */
export async function detail(value) {
  try {
    const song = await songDetail(value);
    const names = model.list(song.singer).map((x) => x.name).filter(Boolean);
    return {
      title: model.clean(song.name || song.title),
      artist: names.join(' / '),
      duration: Math.round((song.interval || 0)),
    };
  } catch (_) {
    return null;
  }
}

export async function lyrics({ id }) {
  id = resourceId(id);
  const data = await cgi('music.musichallSong.PlayLyricInfo', 'GetPlayLyricInfo', { ...(/^\d+$/.test(id) ? { songId: numeric(id) } : { songMid: id }), crypt: 1, lrc_t: 0, qrc: 0, qrc_t: 0, trans: 1, trans_t: 0, roma: 0, type: 1 });
  return { lrc: lyricText(data.lyric), translation: lyricText(data.trans) };
}
export function trackMenu() { return [{ id: 'open-qqmusic', title: t('在 QQ 音乐网页打开') }]; }
export function menuAction({ id, track }) {
  if (id !== 'open-qqmusic') fail('unsupported', '未知菜单操作');
  host.openURL(`https://y.qq.com/n/ryqq/songDetail/${resourceId(track.id)}`);
  return {};
}
