// QQ 号扫码登录（ptlogin2 通道）。
//
// 与手机 App 扫码的区别：这条走 QQ 互联 OAuth，最后把 code 送进
// QQConnectLogin.QQLogin（tmeLoginType=2），同样不需要 MQTT 通道。
import { cgi, fail } from './client.js';
import { hash33 } from './crypto.js';
import { t } from './i18n.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const APPID = '716027609';
const DAID = '383';
const PT_3RD_AID = '100497308';

/** ptuiCB 的第一个参数是状态码：0 成功，66 未扫，67 待确认，65 过期，68 拒绝 */
const STATUS = {
  0: '',
  66: '请用手机 QQ 扫描二维码',
  67: '已扫码，请在手机上确认登录',
  65: '二维码已过期，正在刷新…',
  68: '已在手机上取消登录',
};

/**
 * 取二维码。
 * 返回 { qrsig, image }：qrsig 是后续轮询要带上的 cookie。
 */
export async function createQr() {
  const params = new URLSearchParams({
    appid: APPID,
    e: '2',
    l: 'M',
    s: '3',
    d: '72',
    v: '4',
    t: String(Math.random()),
    daid: DAID,
    pt_3rd_aid: PT_3RD_AID,
  });
  const response = await fetch('https://ssl.ptlogin2.qq.com/ptqrshow?' + params.toString(), {
    headers: { 'User-Agent': UA, Referer: 'https://xui.ptlogin2.qq.com/' },
    signal: AbortSignal.timeout(15000),
  }).catch(() => fail('failed', '无法连接 QQ 登录服务，请检查网络或稍后重试', true));
  if (!response.ok) fail('failed', t('QQ 登录服务暂时不可用（HTTP {status}）', { status: response.status }), true);

  const cookie = response.headers.getSetCookie?.() || [];
  const qrsig = pickCookie(cookie, 'qrsig');
  if (!qrsig) fail('failed', 'QQ 未返回登录二维码，请稍后重试');

  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get('content-type') || 'image/png';
  return { qrsig, image: 'data:' + type + ';base64,' + bytesToBase64(bytes) };
}

function pickCookie(list, name) {
  for (const line of list) {
    const pair = String(line).split(';', 1)[0];
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return '';
}

function bytesToBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}

/**
 * 轮询扫码状态。
 * 返回 { code, uin, sigx }：code=0 时 uin 和 sigx 才有值。
 */
export async function pollStatus(qrsig) {
  const params = new URLSearchParams({
    u1: 'https://graph.qq.com/oauth2.0/login_jump',
    ptqrtoken: String(hash33(qrsig)),
    ptredirect: '0',
    h: '1',
    t: '1',
    g: '1',
    from_ui: '1',
    ptlang: '2052',
    action: '0-0-' + Date.now(),
    js_ver: '20102616',
    js_type: '1',
    pt_uistyle: '40',
    aid: APPID,
    daid: DAID,
    pt_3rd_aid: PT_3RD_AID,
    has_onekey: '1',
  });
  const response = await fetch('https://ssl.ptlogin2.qq.com/ptqrlogin?' + params.toString(), {
    headers: {
      'User-Agent': UA,
      Referer: 'https://xui.ptlogin2.qq.com/',
      Cookie: 'qrsig=' + qrsig,
    },
    signal: AbortSignal.timeout(20000),
  }).catch(() => fail('failed', '无法连接 QQ 登录服务，请检查网络或稍后重试', true));
  if (!response.ok) fail('failed', t('QQ 登录服务暂时不可用（HTTP {status}）', { status: response.status }), true);

  const text = await response.text();
  const outer = /ptuiCB\((.*?)\)/.exec(text);
  if (!outer) fail('failed', 'QQ 返回了无法识别的状态，请稍后重试', true);
  const args = [...outer[1].matchAll(/'((?:\\.|[^'])*)'/g)].map((m) => m[1]);
  if (!args.length) fail('failed', 'QQ 返回了无法识别的状态，请稍后重试', true);

  const code = Number(args[0]);
  if (code !== 0) return { code, uin: '', sigx: '' };
  // args[2] 是跳转 URL，里面有 uin 和 ptsigx
  const target = args[2] || '';
  const uin = /(?:\?|&)uin=(.+?)&service/.exec(target);
  const sigx = /(?:\?|&)ptsigx=(.+?)&s_url/.exec(target);
  if (!uin || !sigx) fail('failed', 'QQ 未返回完整登录参数，请重新扫码');
  return { code, uin: uin[1], sigx: sigx[1] };
}

/**
 * 用 uin + ptsigx 换 QQ 音乐凭据。
 * 两步：先 check_sig 拿 p_skey，再用 p_skey 走 oauth2.0/authorize 拿 code。
 */
export async function exchange(uin, sigx) {
  const checkParams = new URLSearchParams({
    uin,
    pttype: '1',
    service: 'ptqrlogin',
    nodirect: '0',
    ptsigx: sigx,
    s_url: 'https://graph.qq.com/oauth2.0/login_jump',
    ptlang: '2052',
    ptredirect: '100',
    aid: APPID,
    daid: DAID,
    j_later: '0',
    low_login_hour: '0',
    regmaster: '0',
    pt_login_type: '3',
    pt_aid: '0',
    pt_aaid: '16',
    pt_light: '0',
    pt_3rd_aid: PT_3RD_AID,
  });
  const check = await fetch('https://ssl.ptlogin2.graph.qq.com/check_sig?' + checkParams.toString(), {
    headers: { 'User-Agent': UA, Referer: 'https://xui.ptlogin2.qq.com/' },
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  }).catch(() => fail('failed', '无法连接 QQ 登录服务，请检查网络或稍后重试', true));

  const cookies = check.headers.getSetCookie?.() || [];
  const pSkey = pickCookie(cookies, 'p_skey');
  if (!pSkey) fail('signIn', 'QQ 未签发登录凭据，请重新扫码');

  // 把 check_sig 拿到的 cookie 全带上，oauth2.0/authorize 需要它们
  const jar = cookies.map((line) => String(line).split(';', 1)[0]).join('; ');

  const authorize = await fetch('https://graph.qq.com/oauth2.0/authorize', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://graph.qq.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: jar,
    },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: PT_3RD_AID,
      redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
      scope: 'get_user_info,get_app_friends',
      state: 'state',
      switch: '',
      from_ptlogin: '1',
      src: '1',
      update_auth: '1',
      openapi: '1010_1030',
      g_tk: String(hash33(pSkey, 5381)),
      auth_time: String(Date.now()),
      ui: randomUuid(),
    }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(20000),
  }).catch(() => fail('failed', '无法连接 QQ 登录服务，请检查网络或稍后重试', true));

  const location = authorize.headers.get('location') || authorize.headers.get('Location') || '';
  const codeMatch = /code=(.+?)(?:&|$)/.exec(location);
  if (!codeMatch) fail('signIn', 'QQ 未返回授权码，请重新扫码');

  return cgi(
    'QQConnectLogin.LoginServer',
    'QQLogin',
    { code: codeMatch[1] },
    { platform: 'android', session: {}, comm: { tmeLoginType: 2 } },
  );
}

function randomUuid() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const seg = (n) => Array.from({ length: n }, hex).join('');
  return seg(8) + '-' + seg(4) + '-4' + seg(3) + '-' + seg(4) + '-' + seg(12);
}

export { STATUS };
