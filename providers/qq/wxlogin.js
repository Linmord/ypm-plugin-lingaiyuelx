// 微信扫码登录（QQ 音乐网页版走的就是这条路）。
//
// 与手机 App 扫码的区别：App 扫码拿到 qqmusic_uin + qqmusic_key，再用 musicid + qrCodeID
// + token 去 Login 兑换；微信账号在这条路上永远失败（uin 是 2^60 偏移的编码 ID）。
// 微信登录走的是微信开放平台 OAuth，最后只把 code + strAppid 送进 Login，不需要 uin。
import { cgi, fail } from './client.js';
import { t } from './i18n.js';

/** QQ 音乐在微信开放平台的应用 ID，公开在 y.qq.com 前端代码里 */
const APPID = 'wx48db31d50e334801';
const REDIRECT = 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

/** 微信扫码状态码 → 给用户看的话 */
const STATUS = {
  408: '请用微信扫描二维码',
  404: '已扫码，请在微信中确认登录',
  405: '',            // 确认成功，进入换凭据
  402: '二维码已过期，正在刷新…',
  403: '已在微信中取消登录',
};

/**
 * 取二维码。
 * 返回 { uuid, image }：image 是 data URL，直接交给 host.signInPrompt 显示。
 */
export async function createQr() {
  const params = new URLSearchParams({
    appid: APPID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'snsapi_login',
    state: 'STATE',
    href: 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect',
  });
  const response = await fetch('https://open.weixin.qq.com/connect/qrconnect?' + params.toString(), {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  }).catch(() => fail('failed', '无法连接微信登录服务，请检查网络或稍后重试', true));
  if (!response.ok) fail('failed', t('微信登录服务暂时不可用（HTTP {status}）', { status: response.status }), true);

  const html = await response.text();
  const match = /uuid=(.+?)"/.exec(html);
  if (!match) fail('failed', '微信未返回登录二维码，请稍后重试');
  const uuid = match[1];

  const image = await fetch('https://open.weixin.qq.com/connect/qrcode/' + encodeURIComponent(uuid), {
    headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/connect/qrconnect' },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!image || !image.ok) fail('failed', '无法获取二维码图片，请稍后重试', true);

  const bytes = new Uint8Array(await image.arrayBuffer());
  const type = image.headers.get('content-type') || 'image/jpeg';
  return { uuid, image: 'data:' + type + ';base64,' + bytesToBase64(bytes) };
}

function bytesToBase64(bytes) {
  let text = '';
  // 分块避免 String.fromCharCode 参数过多导致栈溢出
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}

/**
 * 长轮询扫码状态。微信这个接口会挂住约 35 秒，未扫码时返回 408。
 * 超时按「仍在等待」处理，不算错误。
 */
export async function pollStatus(uuid) {
  let response;
  try {
    response = await fetch(
      'https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=' + encodeURIComponent(uuid) + '&_=' + Date.now(),
      {
        headers: { 'User-Agent': UA, Referer: 'https://open.weixin.qq.com/' },
        signal: AbortSignal.timeout(40000),
      },
    );
  } catch (e) {
    // 长轮询超时是常态：说明用户还没扫
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return { code: 408, wxCode: '' };
    fail('failed', '无法连接微信登录服务，请检查网络或稍后重试', true);
  }
  if (!response.ok) fail('failed', t('微信登录服务暂时不可用（HTTP {status}）', { status: response.status }), true);

  const text = await response.text();
  const match = /window\.wx_errcode=(\d+);window\.wx_code='([^']*)'/.exec(text);
  if (!match) fail('failed', '微信返回了无法识别的状态，请稍后重试', true);
  return { code: Number(match[1]), wxCode: match[2] };
}

/**
 * 用微信给的 code 换 QQ 音乐登录凭据。
 * 这是整条链路的关键一步：参数是 code + strAppid，tmeLoginType=1。
 */
export async function exchange(wxCode) {
  if (!wxCode) fail('signIn', '微信未返回授权码，请重新扫码');
  const data = await cgi(
    'music.login.LoginServer',
    'Login',
    { code: wxCode, strAppid: APPID },
    { platform: 'android', session: {}, comm: { tmeLoginType: 1 } },
  );
  return data;
}

export { STATUS };
