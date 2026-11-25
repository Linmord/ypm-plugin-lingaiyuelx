// QQ 音乐扫码登录。协议层（MQTT 编解码、二维码解码、请求签名）在各自模块里，
// 这里只负责「扫码拿到什么 → 怎么换成登录态」这一段业务逻辑。
//
// 与上游实现的差别：上游只把 uin / qqmusic_key / qrcode_id 三个字段送进 Login 兑换，
// 微信账号（uin 是 2^60 偏移的编码 ID，tmeLoginType=1）在这条路径上永远返回 1000/10006。
// 这里改成把 MQTT 推送的全部 cookie 字段都带上，并额外尝试几条不同的兑换路径。
import { cgi, clearSession, epoch, fail, guid, session, verify } from './client.js';
import { t } from './i18n.js';
import { createQr, exchange as exchangeWxCode, pollStatus, STATUS as WX_STATUS } from './wxlogin.js';
import { createQr as createQqQr, exchange as exchangeQqCode, pollStatus as pollQqStatus, STATUS as QQ_STATUS } from './qqlogin.js';
import * as accounts from '../../shared/accounts.js';

let attempt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const binary = (text) => Uint8Array.from(atob(text), (x) => x.charCodeAt(0));
const encoded = (bytes) => btoa(String.fromCharCode(...bytes));

/** MQTT 推送的 cookie 是 {name: {value, domain, ...}} 结构，拍平成普通对象 */
function flattenCookies(raw) {
  const out = {};
  for (const [name, entry] of Object.entries(raw || {})) {
    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
    if (value === undefined || value === null) continue;
    out[name] = String(value).trim().replace(/^"|"$/g, '');
  }
  return out;
}




/** 连上 MQTT 通道，等扫码结果；返回推送的 cookie 原文 */

/**
 * 把扫码推送的 cookie 换成可用的登录态。
 *
 * 这里不再假设「必须用 Login 兑换」：微信账号的 uin 是 2^60 偏移的编码 ID，
 * Login 兑换对它恒返回 1000/10006。改成依次尝试几条路径，先验证成功的那条胜出。
 * 所有路径都失败时，把每条的返回码一起报出来，便于定位。
 */

/** 从 Login 响应里挑出凭据字段；19 位 uin 走字符串，避免 Number 丢精度 */
function credentialOf(data, fallbackUin, loginType, euin) {
  const source = { ...(data?.data || {}), ...data };
  const pick = (...values) => {
    for (const v of values) {
      const text = String(v ?? '').trim();
      if (text && text !== '0') return text;
    }
    return '';
  };
  const uin = pick(source.str_musicid, source.musicid, source.uin, fallbackUin);
  const musickey = pick(source.musickey, source.musicKey);
  if (!uin || !musickey) fail('signIn', 'QQ音乐未签发正式登录凭据，请重新扫码');
  const result = { uin, musickey, loginType: source.loginType ?? loginType, euin, encryptUin: source.encryptUin || euin };
  for (const key of ['refresh_token', 'refresh_key', 'openid', 'access_token', 'unionid', 'expired_at', 'str_musicid']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

export async function signIn() {
  // 设置项 qq:loginMode 决定用哪种扫码：wechat / qq / app
  const mode = typeof host.setting === 'function' ? host.setting('qq:loginMode') : '';
  if (mode === 'qq') return signInByQq();
  return signInByWeChat();
}

/** 微信扫码：微信开放平台 OAuth → code → Login 换凭据 */
async function signInByWeChat() {
  const current = ++attempt, generation = epoch();
  const deadline = Date.now() + 8 * 60 * 1000;
  const check = () => {
    if (current !== attempt || generation !== epoch()) fail('signIn', '扫码登录已取消，请重新点击登录');
    if (Date.now() >= deadline) fail('signIn', '扫码登录超时，请重新点击登录');
  };
  try {
    for (let failures = 0; Date.now() < deadline;) {
      check();
      host.signInPrompt({ text: t('正在获取微信登录二维码…') });
      let qr;
      try {
        qr = await createQr();
      } catch (e) {
        check();
        if (!e.retryable || failures++ >= 2) throw e;
        host.signInPrompt({ text: t('网络暂时不稳定，正在重试…') });
        await sleep(1500 * failures);
        continue;
      }
      check();
      host.signInPrompt({ qr: qr.image, text: t('请用微信扫描二维码，并在手机上确认登录') });

      let wxCode = '';
      while (Date.now() < deadline) {
        check();
        const status = await pollStatus(qr.uuid);
        check();
        const hint = WX_STATUS[status.code];
        if (hint !== undefined) host.signInPrompt({ qr: qr.image, text: t(hint) });
        if (status.code === 405) { wxCode = status.wxCode; break; }
        if (status.code === 402) break;
        if (status.code === 403) fail('signIn', '已在微信中取消登录，请重新扫码');
        if (!(status.code in WX_STATUS)) fail('failed', t('微信返回了未知状态（{code}）', { code: status.code }));
      }
      if (!wxCode) { host.signInPrompt({ text: t('二维码已过期，正在刷新…') }); failures = 0; continue; }

      const data = await exchangeWxCode(wxCode);
      check();
      const credential = credentialOf(data, '', 1, '');
      if (!credential.musickey) fail('signIn', '微信登录成功但 QQ 音乐未签发凭据，请重试');
      return await finish(credential, check);
    }
    fail('signIn', '扫码登录超时，请重新点击登录');
  } finally {
    if (current === attempt) host.signInPrompt();
  }
}

/** QQ 号扫码：ptlogin2 → ptsigx → oauth2.0/authorize → QQConnectLogin */
async function signInByQq() {
  const current = ++attempt, generation = epoch();
  const deadline = Date.now() + 8 * 60 * 1000;
  const check = () => {
    if (current !== attempt || generation !== epoch()) fail('signIn', '扫码登录已取消，请重新点击登录');
    if (Date.now() >= deadline) fail('signIn', '扫码登录超时，请重新点击登录');
  };
  try {
    for (let failures = 0; Date.now() < deadline;) {
      check();
      host.signInPrompt({ text: t('正在获取 QQ 登录二维码…') });
      let qr;
      try {
        qr = await createQqQr();
      } catch (e) {
        check();
        if (!e.retryable || failures++ >= 2) throw e;
        host.signInPrompt({ text: t('网络暂时不稳定，正在重试…') });
        await sleep(1500 * failures);
        continue;
      }
      check();
      host.signInPrompt({ qr: qr.image, text: t('请用手机 QQ 扫描二维码，并在手机上确认登录') });

      let done = null;
      while (Date.now() < deadline) {
        check();
        const status = await pollQqStatus(qr.qrsig);
        check();
        const hint = QQ_STATUS[status.code];
        if (hint !== undefined && hint) host.signInPrompt({ qr: qr.image, text: t(hint) });
        if (status.code === 0) { done = status; break; }
        if (status.code === 65) break;
        if (status.code === 68) fail('signIn', '已在手机上取消登录，请重新扫码');
        if (!(status.code in QQ_STATUS)) fail('failed', t('QQ 返回了未知状态（{code}）', { code: status.code }));
        await sleep(1000);
      }
      if (!done) { host.signInPrompt({ text: t('二维码已过期，正在刷新…') }); failures = 0; continue; }

      const data = await exchangeQqCode(done.uin, done.sigx);
      check();
      const credential = credentialOf(data, done.uin, 2, '');
      if (!credential.musickey) fail('signIn', 'QQ 登录成功但 QQ 音乐未签发凭据，请重试');
      return await finish(credential, check);
    }
    fail('signIn', '扫码登录超时，请重新点击登录');
  } finally {
    if (current === attempt) host.signInPrompt();
  }
}

/** 手机 App 扫码：MQTT 推送 cookie → Login 兑换（只有 QQ 号账号走这条） */

/** 登录收尾：复核凭据、写入多账号表、设为当前账号 */
async function finish(credential, check) {
  host.storage.set('session', credential);
  const user = await verify(credential, check);
  check();
  // 登录只写入账号表；是否切到它由 switchAccount 决定。
  // 这样已登录状态下也能继续登录新账号，不会把当前账号顶掉。
  const existing = accounts.list('qq').find((a) => a.id === String(credential.uin));
  accounts.upsert('qq', {
    id: String(credential.uin),
    name: user.name,
    imageUrl: user.imageUrl || '',
    loginType: credential.loginType,
    credential,
  }, { keepActive: true });
  // 第一个账号自动成为当前；后续登录不动当前账号
  if (!existing && accounts.list('qq').length === 1) accounts.setActive('qq', String(credential.uin));
  return user;
}


/**
 * 手动填 cookie 登录。
 * 用户在浏览器登录 y.qq.com 后可以拿到 qqmusic_key + qqmusic_uin（或微信的 wxuin）。
 * 这条路绕过扫码，适合扫码通道不可用、或想直接搬用已有会话的场景。
 * input: { uin, musickey, loginType? }
 */
export async function signInByCookie(input = {}) {
  const uin = String(input.uin ?? '').trim();
  const musickey = String(input.musickey ?? '').trim();
  if (!uin || !musickey) fail('setup', '请同时填写账号 ID 和登录凭据');
  if (!/^\d+$/.test(uin)) fail('setup', '账号 ID 应该是一串数字');
  const loginType = Number(input.loginType) || (uin.length > 15 ? 1 : 6);
  const credential = { uin, musickey, loginType };
  const generation = epoch();
  const check = () => { if (generation !== epoch()) fail('signIn', '登录状态已变化，请重试'); };
  return await finish(credential, check);
}

// signIn 只负责登录，不负责切换：已登录时再登录会新增账号，当前账号保持不变。
export async function account() {
  // 多账号：优先看设置项 qq:activeAccount（插件设置里能直接切），
  // 没设置就沿用控制台写入的 active 指针。
  // 不能回落到 session —— signOut 只是把 active 清空，session 里还留着凭据，
  // 一回落就等于「退出登录后刷新又登上了」。
  const chosen = typeof host.setting === 'function' ? host.setting('qq:activeAccount') : '';
  const all = accounts.list('qq');
  const saved = (chosen && all.find((a) => a.id === String(chosen))) || accounts.current('qq');
  if (!saved) return null;
  const credential = saved.credential;
  const generation = epoch();
  if (!credential || !credential.musickey) return null;
  const check = () => { if (generation !== epoch()) fail('signIn', '登录状态已变化，请重新扫码'); };
  try { return await verify(credential, check); }
  catch (e) {
    if (e.code !== 'signIn') throw e;
    if (credential.refresh_token && credential.refresh_key) {
      try {
        const data = await cgi('music.login.LoginServer', 'Login', { ...credential, musicid: credential.uin, str_musicid: credential.uin, loginMode: 2 }, { platform: 'android', session: credential, comm: { tmeLoginType: credential.loginType || 6 } });
        check();
        const fresh = credentialOf(data, credential.uin, credential.loginType, credential.euin);
        if (saved) accounts.upsert('qq', { ...saved, credential: fresh });
        return await verify(fresh, check);
      } catch (error) { if (error.code !== 'signIn') throw error; }
    }
    // 只是这一个账号失效，不要清掉整个账号表
    if (generation === epoch() && saved) accounts.remove('qq', saved.id);
    else if (generation === epoch()) clearSession();
    return null;
  }
}

/** 退出只切走当前账号，凭据留在账号表里，随时可以切回来 */
export function signOut() {
  attempt++;
  accounts.setActive('qq', '');
  // session 是历史遗留的单一凭据槽，清掉它才不会在别处被回落到
  clearSession();
}

/** 真正清空：删掉所有账号和 session（给「清除全部登录」用） */
export function clearAll() {
  attempt++;
  accounts.clear('qq');
  clearSession();
}

/** 账号管理：列出 / 切换 / 删除 */
export function accounts_() { return accounts.publicView('qq'); }
export function switchAccount(id) {
  const found = accounts.list('qq').find((a) => a.id === String(id));
  if (!found) fail('unavailable', '找不到这个账号');
  accounts.setActive('qq', found.id);
  return accounts.publicView('qq');
}
export function removeAccount(id) {
  accounts.remove('qq', String(id));
  return accounts.publicView('qq');
}