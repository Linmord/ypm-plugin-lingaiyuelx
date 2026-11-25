// 在 Node 里模拟 YesPlayMusic 插件的 host 全局对象。
// 这样 Web 控制台能直接复用插件自己的 provider 代码，不必重写登录/加密逻辑。
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @param {object} opts
 * @param {string} opts.dataDir  与插件共用的数据目录（plugin-data/multisource）
 * @param {string} opts.pluginDir 插件目录（为了 spawn 时能解析 bin/ 相对路径）
 * @param {() => Record<string,string>} opts.getSettings 读取当前设置项
 * @param {(p:{qr?:string,text?:string}) => void} opts.onPrompt 登录二维码回调
 */
export function installHost({ dataDir, pluginDir, getSettings, onPrompt, onLog }) {
  const storageFile = path.join(dataDir, 'storage.json');
  let store = new Map();
  if (existsSync(storageFile)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(storageFile, 'utf8')))) store.set(k, v);
    } catch (e) {
      onLog?.('storage.json 解析失败，按空处理: ' + e.message);
    }
  }
  let flushTimer = null;
  const flush = () => {
    if (flushTimer) return;
    // 合并写入，避免扫码轮询时每秒落盘十几次
    flushTimer = setTimeout(() => {
      flushTimer = null;
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(storageFile, JSON.stringify(Object.fromEntries(store)), 'utf8');
    }, 200);
  };
  const flushNow = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(storageFile, JSON.stringify(Object.fromEntries(store)), 'utf8');
  };

  const children = new Set();

  globalThis.host = {
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
    arch: process.arch === 'x64' ? 'amd64' : process.arch,
    dir: pluginDir,
    dataDir,
    setting: (key) => getSettings()?.[key] ?? '',
    t: (message) => message,
    language: () => 'zh-CN',
    storage: {
      get: (k) => store.get(k),
      set: (k, v) => { store.set(k, v); flush(); },
      remove: (k) => { store.delete(k); flush(); },
    },
    crypto: {
      md5: (t) => crypto.createHash('md5').update(String(t), 'utf8').digest('hex'),
      aesEcbEncrypt: (key, text) => {
        const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
        c.setAutoPadding(true);
        return Buffer.concat([c.update(String(text), 'utf8'), c.final()]).toString('hex');
      },
    },
    signInPrompt: (value = {}) => onPrompt?.(value),
    openURL: (url) => onLog?.('openURL: ' + url),

    /**
     * QQ 扫码靠这个原生程序走 MQTT。插件的用法是：
     *   spawn(相对路径, [路径参数]) → 对象 { write(text), readLine(): Promise<string|null>, wait(), errorOutput(), kill() }
     * 这里把 child_process 桥接成同样的形状。
     */
    spawn(command, args = []) {
      const resolved = path.isAbsolute(command) ? command : path.join(pluginDir, command);
      if (!existsSync(resolved)) throw new Error('找不到程序: ' + resolved);
      const child = spawn(resolved, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      let buffer = '';
      let stderr = '';
      const waiters = [];
      let closed = false;
      let exitCode = null;

      const pump = () => {
        while (waiters.length) {
          const at = buffer.indexOf('\n');
          if (at < 0) break;
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          waiters.shift()(line);
        }
        if (closed) while (waiters.length) waiters.shift()(null);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { buffer += chunk; pump(); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (e) => { stderr += String(e && e.message); closed = true; pump(); });
      child.on('close', (code) => { closed = true; exitCode = code; pump(); });

      return {
        pid: child.pid,
        write: (text) => { try { child.stdin.write(text); } catch { /* 进程已退出 */ } },
        closeStdin: () => { try { child.stdin.end(); } catch { /* 已关闭 */ } },
        readLine: () => new Promise((resolve) => { waiters.push(resolve); pump(); }),
        wait: () => new Promise((resolve) => {
          if (closed) return resolve(exitCode ?? -1);
          child.on('close', (code) => resolve(code ?? -1));
        }),
        errorOutput: () => stderr,
        kill: () => { try { child.kill(); } catch { /* 已结束 */ } },
      };
    },
  };

  return {
    storage: {
      dump: () => Object.fromEntries(store),
      keys: () => [...store.keys()],
      flush: flushNow,
    },
    killAll: () => { for (const c of children) { try { c.kill(); } catch { /* 已结束 */ } } },
  };
}
