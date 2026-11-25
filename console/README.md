# 控制台

小林的音源扩展 · 本地管理控制台。

管理两个平台的账号、落雪音源、音质与回落开关。宿主只有一个账号槽位，多账号只能在这里切。

## 随插件自动启动

插件加载时会用 `host.spawn` 拉起控制台，宿主退出时它跟着退出。**不需要手动开。**

- 插件侧：`shared/console-launcher.js`（模块加载即启动）
- 权限：`plugin.json` 的 `permissions.process`
- 生命周期：控制台自己盯父进程（`process.ppid`），父进程没了就退出

需要 Node.js 18+。没装的话控制台起不来，但**插件本身照常工作**，只是账号管理要去别处。

## 手动启动

```
Windows        双击 启动管理控制台.bat
macOS / Linux  sh 启动管理控制台.sh
或者            node server.mjs
```

然后访问 http://127.0.0.1:47800

## 跨平台

宿主数据目录按平台解析：

| 系统 | 根目录 |
| --- | --- |
| Windows | `%APPDATA%\YesPlayMusic` |
| macOS | `~/Library/Application Support/YesPlayMusic` |
| Linux | `$XDG_DATA_HOME/YesPlayMusic`（默认 `~/.local/share/YesPlayMusic`） |

node 的位置也会依次尝试 PATH 和各平台常见安装路径（Homebrew、`/usr/bin`、`/snap/bin`）。

## 目录

```
server.mjs         HTTP 服务 + 16 个 API
host-shim.mjs      在 Node 里模拟宿主的 host 全局
index.html         前端（单文件，含本地二维码生成）
启动管理控制台.bat   Windows 手动启动
启动管理控制台.sh    macOS / Linux 手动启动
```

## 为什么需要 host-shim

控制台要复用插件里的登录、加密、落雪音源运行时，这些都是 JS 模块，依赖宿主提供的 `host` 全局（`storage`、`crypto`、`signInPrompt` 等）。

`host-shim.mjs` 在 Node 里把这些补齐，然后直接 `import` 插件的模块：

```js
installHost({ dataDir, pluginDir, getSettings, onPrompt });
const login = await import(pathToFileURL(pluginDir + '/providers/qq/login.js'));
await login.signIn();   // 跑的是插件自己的代码
```

所以控制台和播放器用的是同一份逻辑，不会出现「控制台能登录、播放器不能」这种不一致。

## 安全

- 只监听 `127.0.0.1`，不对外网开放
- **没有鉴权**，本机任何程序都能访问
- 持有明文凭据（和宿主共用 `storage.json`）
- 用完可以关掉：控制台会随宿主退出

## 端口

固定 47800。被占用时控制台会安静退出，不影响插件。
