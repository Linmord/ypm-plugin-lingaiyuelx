## 控制台随插件启停

插件加载时自动拉起控制台，宿主退出时跟着退出。**不用再手动双击 bat。**

- 插件侧 `shared/console-launcher.js` 在模块加载时 `host.spawn` 拉起
- 控制台盯 `process.ppid`，父进程没了就自己退出（宿主被强杀时也能收）
- 端口被占用时安静退出，不会重复开进程

需要 Node.js 18+。没装的话控制台起不来，但**插件本身照常工作**。

## 支持 macOS / Linux

之前写死了 Windows 路径，这版按平台解析：

| 系统 | 宿主数据目录 |
| --- | --- |
| Windows | `%APPDATA%\YesPlayMusic` |
| macOS | `~/Library/Application Support/YesPlayMusic` |
| Linux | `$XDG_DATA_HOME/YesPlayMusic` |

node 位置依次尝试 PATH、`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、`/snap/bin`。
补了 `启动管理控制台.sh`。

> macOS / Linux 未实测，按文档写的。有问题请提 issue。

## 前端改进

- **二维码本地生成**：不再依赖 `api.qrserver.com`，离线可用
- **表单不再被刷新掉**：填了内容就跳过重绘；必须重绘时保存并恢复焦点与光标
- **首屏加载占位**：不再白屏
- **连不上时给明确提示** + 重试按钮

## 修复

- 登录取消后重新登录，状态会被旧回调改回「已取消」
- 扫码长任务独占 JS 线程，导致其他请求全部超时

## 安装

1. 下载 `YesPlayMusic-multisource-0.2.0.zip` 解压
2. 设置 → 插件 → 「从本地文件夹安装…」，选解压后的目录
3. 设置 → 插件 → 音乐来源，选中「小林的音源扩展」
4. 首次启动如果控制台没起来，去 插件 ⋯ 菜单勾选「允许运行本机程序」

控制台：http://127.0.0.1:47800
