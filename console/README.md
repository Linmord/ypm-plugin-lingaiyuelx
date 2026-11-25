# ypm-console（Go 版）

小林的音源扩展 · 本地管理控制台。

单文件可执行程序，内置 QuickJS 跑插件自己的登录/音源逻辑，**用户不需要装 Node 或任何运行时**。

## 为什么重写

原来的 Node 版要求用户装 Node.js 才能用。Go 编译成静态二进制后：

| | Node 版 | Go 版 |
| --- | --- | --- |
| 用户依赖 | 必须装 Node | 无 |
| 分发 | 一个文件夹 + `npm install` | 一个 exe |
| 体积 | 0（靠系统 Node） | 7.4 MB |
| 启动 | `node server.mjs` | 双击 |

## 技术方案

控制台要复用插件里的登录、加密、落雪音源运行时，这些都是 JS 代码。所以：

```
console.exe
  ├── HTTP 服务（Go 标准库）
  ├── 静态页（go:embed 打进二进制）
  └── QuickJS（cgo 绑定）
        ├── host.storage / host.crypto / host.setting 模拟
        ├── fetch 桥接（Go 发请求，结果回填）
        └── 插件模块（打包后求值）
```

### 模块打包

QuickJS 的模块加载器没有路径规范化函数，`import { x } from '../shared/storage.js'` 解析不了。

`internal/bundle` 在 Go 侧做静态展开：

```js
globalThis.__mod = globalThis.__mod || {};
// ---- shared/storage.js ----
__mod["shared/storage.js"] = (function(){
  const __e = {};
  function scoped(provider) { ... }
  __e["scoped"] = scoped;
  return __e;
})();

// ---- shared/accounts.js ----
__mod["shared/accounts.js"] = (function(){
  const __e = {};
  const { scoped } = __mod["shared/storage.js"];   // import 改写成解构
  function upsert(...) { ... }
  __e["upsert"] = upsert;
  return __e;
})();
```

每个模块包一层 IIFE，因为 `wxlogin.js` 和 `qqlogin.js` 都有 `const UA`，直接拼会撞名。

### 线程模型

QuickJS 的 JSRuntime 绑定在创建它的 OS 线程上。HTTP handler 是并发跑的，
所以所有 JS 调用都排队到同一个 worker goroutine：

```go
runtime.LockOSThread()   // worker 启动时锁一次
for t := range queue {   // 之后所有调用都在这个线程上
    t.done <- t.fn()
}
```

不这么做的话，并发请求下 `ctx.Eval` 会返回 nil。

## 构建

需要 Go 1.22+ 和 cgo 工具链（Windows 上装 MSYS2 的 gcc）。

```powershell
# 设好环境
$env:CGO_ENABLED = '1'
$env:PATH = 'C:\msys64\mingw64\bin;' + $env:PATH
$env:CC = 'C:\msys64\mingw64\bin\gcc.exe'

go build -trimpath -ldflags "-s -w -X main.version=0.1.0" -o dist\ypm-console.exe .
```

产物是 7.4 MB 的单个 exe，不依赖任何 DLL。

## 运行

```powershell
.\ypm-console.exe
```

自动打开 http://127.0.0.1:47800。

参数：

| 参数 | 说明 |
| --- | --- |
| `-port` | 监听端口，默认 47800 |
| `-plugin` | 插件目录，默认 `%APPDATA%\YesPlayMusic\plugins\multisource` |
| `-data` | 数据目录，默认 `%APPDATA%\YesPlayMusic\plugin-data\multisource` |
| `-open` | 启动后是否开浏览器，默认 true |

## 目录

```
main.go              启动、参数、优雅退出
internal/
  bundle/            模块打包器（ES module → 单段脚本）
  hostjs/            host 全局模拟（storage/crypto/spawn/fetch/console）
  jsrt/              QuickJS 运行时 + worker 线程模型
  server/            16 个 API 路由 + 静态页
web/
  index.html         前端（go:embed 打进二进制）
```

## 测试

```powershell
go test ./...
```

- `bundle`：打包真实插件模块，验证 15 个依赖按序展开
- `hostjs`：host 环境完整性、storage 往返、md5 对标准值、真实模块求值
- `jsrt`：运行时创建、未登录状态、并发调用

## API

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/status` | GET | 账号、音源、设置、版本 |
| `/api/settings` | POST | 更新设置 |
| `/api/login` | POST | 开始扫码登录 |
| `/api/logout` | POST | 退出登录 |
| `/api/loginCookie` | POST | QQ 手动填 cookie |
| `/api/prompt` | GET | 轮询二维码 |
| `/api/cancel` | POST | 取消登录 |
| `/api/accounts` | GET | QQ 已保存账号 |
| `/api/accounts/switch` | POST | 切换账号 |
| `/api/accounts/remove` | POST | 删除账号 |
| `/api/activeProvider` | POST | 切换当前音源 |
| `/api/loginMode` | POST | 设置 QQ 登录方式 |
| `/api/sources/luoxue` | GET | 列出落雪音源 |
| `/api/sources/import` | POST | 从源码导入 |
| `/api/sources/importUrl` | POST | 从网络导入 |
| `/api/sources/reorder` | POST | 调整顺序 |
| `/api/sources/remove` | POST | 删除音源 |
| `/api/capabilities` | GET | 探测运行环境 |

## 安全

- 只监听 `127.0.0.1`，不对外网开放
- **没有鉴权**，本机任何程序都能访问
- 持有明文凭据（和宿主共用 `storage.json`）
- 用完请关掉

## 许可

与插件本体一致。
