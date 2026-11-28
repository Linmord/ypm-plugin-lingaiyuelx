// 跨平台「打开一个跟踪 app.log 的终端窗口」
//
// 宿主没有给插件设置按钮的控件，但用户就在电脑前，替他弹一个终端最省事。
// 三个平台各有一套终端习惯，这里只做纯函数，方便单测；真正 spawn 交给调用方。

export const TAIL_LINES = 20;

/** 给路径加引号（POSIX 用双引号转义，Windows 用单引号） */
function quote(posix, p) {
  return posix ? '"' + String(p).replace(/(["\\$])/g, '\\$1') + '"'
    : "'" + String(p).replace(/'/g, "''") + "'";
}

/**
 * @param {'win32'|'darwin'|'linux'} platform
 * @param {string} logFile 日志绝对路径
 * @returns {{via: string, cmd: string, args: string[], fallbacks?: {via: string, cmd: string, args: string[]}[]}}
 */
export function planLogWindow(platform, logFile) {
  const file = String(logFile || '');

  if (platform === 'win32') {
    const psCmd = 'Get-Content ' + quote(false, file) + ' -Wait -Tail ' + TAIL_LINES + ' -Encoding UTF8';
    return { via: 'powershell', cmd: 'cmd.exe', args: ['/c', 'start', '', 'powershell.exe', '-NoExit', '-Command', psCmd] };
  }

  const tail = 'tail -n ' + TAIL_LINES + ' -f ' + quote(true, file);

  if (platform === 'darwin') {
    // Terminal 是 macOS 自带的，用 AppleScript 开一个窗口跑命令
    const script = 'tell application "Terminal" to do script ' + JSON.stringify(tail);
    return { via: 'Terminal', cmd: 'osascript', args: ['-e', script] };
  }

  // Linux：终端种类多，按常见程度依次试，缺哪个（ENOENT）就换下一个
  const sh = ['sh', '-c', tail];
  const first = { via: 'x-terminal-emulator', cmd: 'x-terminal-emulator', args: ['-e', ...sh] };
  return {
    ...first,
    fallbacks: [
      { via: 'gnome-terminal', cmd: 'gnome-terminal', args: ['--', ...sh] },
      { via: 'konsole', cmd: 'konsole', args: ['-e', ...sh] },
      { via: 'xfce4-terminal', cmd: 'xfce4-terminal', args: ['--command', tail] },
      { via: 'xterm', cmd: 'xterm', args: ['-e', ...sh] },
    ],
  };
}

/** 拿不到终端时给用户手动执行的命令 */
export function manualCommand(platform, logFile) {
  return platform === 'win32'
    ? 'Get-Content ' + quote(false, logFile) + ' -Wait -Tail ' + TAIL_LINES + ' -Encoding UTF8'
    : 'tail -n ' + TAIL_LINES + ' -f ' + quote(true, logFile);
}
