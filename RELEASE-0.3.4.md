# 小林的音源扩展 v0.3.4 发布说明

> 适用于 YesPlayMusic 3.0 插件 `multisource`。本版修复四处「看起来能用、其实没生效」的问题：音质设置从未生效、控制台删除账号后重载又复活、洛雪音源被误判初始化失败（含异步上报 `inited` 的情况）；并把音质选项搬进宿主插件设置、给控制台加了看日志的入口。

## 一、这一版改了什么

### 1. 音质

| 档位 | 值 | 网易云 level | QQ 音乐 |
| --- | --- | --- | --- |
| 最好音质（无损 / Hi-Res） | `hires` | hires → 逐级回退 | 无损 F000 FLAC |
| 无损 | `lossless` | lossless | 无损 F000 FLAC |
| 高音质 320k | `high` | exhigh | M800 320k MP3 |
| 标准 128k | `standard` | standard | C400 128k MP3 |

- 音质改为**全局一项**，默认「最好音质」。宿主插件设置（设置 → 插件 → 小林的音源扩展 → 音质）和 Web 控制台读写同一个值，没有 Node 环境的用户也能直接切档。
- 去掉原来的「跟随播放器」空值选项：留空等于永远按宿主默认档走，也就是设置无效。
- **修复音质设置从来没生效**：读取设置时把键名拼成了 `qq:quality:undefined`（调用方传的是整键 `qq:quality`），读出来永远为空，两个平台一直用宿主默认档。现在 `setting()` 支持整键，两个平台统一走 `qualityOf()`。
- **QQ 音乐选 Hi-Res 不再退化**：以前 Hi-Res 不在 QQ 档位表里，会静默退回宿主档位（通常是 320k MP3）；现在归一为无损 F000 FLAC 请求，无损码率也不再显示 0。
- **洛雪回落跟随音质**：按设置传 `128k` / `320k` / `flac` / `flac24bit`，并按真实文件后缀回报 `type` / `quality` / `bitRate`——flac 不会再被报成 mp3 320k。
- 在**插件设置**里改完就对之后播放的歌曲生效，不用重载插件；在**控制台**里改仍需重载（或禁用再启用 / 重启 YesPlayMusic），因为宿主只在加载插件时读一次设置文件。

### 2. 账号

- **修复「控制台删掉已登录账号，重载插件又出现」**：宿主进程每 5–6 秒把内存里的插件数据整表写回 `storage.json`，控制台删掉的账号会在下一次写回时复活。现在删除会同时写墓碑（`removedAccounts`，格式 `provider:id@时间戳`，30 天后自动清理），加载与列表时按墓碑过滤；删完又主动登录的账号会记 `updatedAt`，不会被墓碑误杀。
- **登录失效的账号不再静默保留**：刷新 token 失败只标 `invalid: true` 不删除，控制台显示「登录已失效」徽标，并新增「检查登录状态」按钮（`POST /api/accounts/verify`）一次性复核。
- 控制台删除账号后提示「重载插件生效」。

### 3. 洛雪音源

- **修复 #1**：`inited` 判定过严。以前只要脚本没回 `status: true` 就报「音源脚本没有完成初始化」，而 lx-music 生态里绝大多数脚本只发 `{ openDevTools: false, sources }`，`status` 是可选项。新规则：
  - 不带 `status` → 正常导入
  - `status: true` → 正常导入
  - `status: false` → 仍然拒绝，并带出脚本自己给的原因
  - 完全没调用 `inited` → 仍报原错误
- 全项目统一写作「洛雪」（此前文档里把「洛」写成了「落」）。
- **异步上报 `inited` 的脚本不再被误判**：以前脚本一执行完就同步读 `sandbox.inited`，先 `await` 拉配置或用 `setTimeout` 晚一步才 `send(inited)` 的脚本会被判成「没有完成初始化」。现在同步上报的照旧当场完成（不变慢），异步上报的最多等 2 秒（事件驱动，`send` 时立刻兑现，不轮询），超时才报原错。

### 4. 调试

- 控制台新增「查看宿主日志」按钮：在桌面弹一个终端实时跟踪宿主 `logs/app.log`。Windows 用 PowerShell（`Get-Content … -Wait -Tail 20 -Encoding UTF8`），macOS 用系统「终端」，Linux 依次试 `x-terminal-emulator` / `gnome-terminal` / `konsole` / `xfce4-terminal` / `xterm`；全都没有就返回可手动执行的命令。
- 宿主插件设置只支持布尔 / 下拉 / 文本行，没有动作按钮类型，所以按钮放在控制台而不是设置面板。

## 二、验证

- 测试 10 套、155 条断言全部通过：

| 套件 | 断言 | 覆盖 |
| --- | --- | --- |
| accounts | 10 | 多账号表 |
| e2e | 8 | 导入到播放链路 |
| host | 10 | 宿主桥接 |
| logcmd | 22 | 三平台的日志窗口命令 |
| luoxue-inited | 16 | 同步 / 异步上报 inited 的判定 |
| manifest | 32 | 清单与文档一致性 |
| merge | 5 | 搜索结果合并 |
| quality | 24 | 音质档位链路 |
| removed | 18 | 墓碑与复活 |
| signout | 10 | 登出 |

- `quality` 覆盖：全局键盖过按平台键、全空时默认最好音质、网易云请求 level、QQ Hi-Res→F000、洛雪回落档位与真实后缀回报。
- `manifest` 覆盖：版本号、`select` + `default: hires`、无空值选项、全仓没有「洛」字被误写成「落」的残留、控制台写全局 `quality` 键、两个 provider 都走 `qualityOf`。
- 删除链路用临时数据目录冒烟：控制台删账号 → `settings.json` 写入墓碑 → `storage.json` 的 `active` 切到剩余账号。
- 控制台冒烟：`POST /api/settings {"quality":"standard"}` 返回 200 且写入全局键。
- `luoxue-inited` 覆盖：同步上报当场进列表（没变慢）、`status: true` 通过、`status: false` 被拒且带出原因、`setTimeout` 60ms 后上报通过、`await` 之后上报通过、完全不报等满 2 秒后报原错、异步上报但没注册 `request` 仍然拦下、脚本原文照常落盘。
- 日志窗口实测（Windows）：`POST /api/debug/logs` 返回 `{"ok":true,"via":"powershell","exists":true,...}`，桌面确实弹出了跟踪窗口。macOS / Linux 的分支只有命令组装层的单测，没有在真机上跑过。

## 三、安装与回退

**安装（推荐走宿主界面，三个平台都不用记路径）**：设置 → 插件 → 安装插件（贴 `github.com/Linmord/ypm-plugin-lingaiyuelx`），或「从本地文件夹安装…」选解压后的目录。装完到「设置 → 插件 → 音乐来源」选中它，确认版本 0.3.4，并在同一页设置音质，然后重启 YesPlayMusic。

**手动放目录时，插件目录按平台不同**：

| 系统 | 插件目录 |
| --- | --- |
| Windows | `%APPDATA%\YesPlayMusic\plugins\multisource` |
| macOS | `~/Library/Application Support/YesPlayMusic/plugins/multisource` |
| Linux | `$XDG_DATA_HOME/YesPlayMusic/plugins/multisource`（默认 `~/.local/share/YesPlayMusic/plugins/multisource`） |

目录名的大小写以实际为准：Windows 上实测是 `yesplaymusic`（不区分大小写所以无所谓），macOS / Linux 区分大小写，进目录看一眼再动。拿不准就走上面的界面安装，别手抄路径。

插件自己的数据（账号、音源原文、设置）不在插件目录里，而在宿主数据目录旁边的 `plugin-data/multisource`（Windows `%APPDATA%\YesPlayMusic\plugin-data\multisource`，macOS / Linux 同理往下挪）。**覆盖安装、回退都不会碰这个目录**，账号和已导入的音源不用重弄。

**回退**：

- 走宿主界面：设置 → 插件里禁用它，换回旧版本目录再启用，然后重启。
- 手动覆盖：本次从源码更新时，被替换的文件旁边留了 `.bak`。Windows 上 `copy /y <文件>.bak <文件>`，macOS / Linux 上 `cp <文件>.bak <文件>`，然后重启 YesPlayMusic。
- 源码仓库里更简单：`git checkout -- <文件>`，或者 `git stash` 回到干净状态。

## 四、已知限制

- 宿主插件设置只支持布尔 / 下拉 / 文本行三类控件，**没有动作按钮类型**，看日志的按钮只能放在控制台（见「4. 调试」）。
- 插件设置里改音质立即生效，但正在播放的那首不会中途换档，切歌后才按新档位取址。
- 异步上报 `inited` 的脚本，如果在上报之后还要读 `globalThis.lx`（而不是用闭包里存下的那个 `lx`），会拿不到——导入结束时全局已经还原成原样。正常的 `send` 走闭包里的引用，不受影响。
- 「查看宿主日志」的跨平台分支里，macOS / Linux 只在命令组装层有单测，没有在真机上跑过（Windows 已实测）。
- 安装/回退里 macOS 与 Linux 的插件目录是按宿主数据目录规则推出来的（和 `console/server.mjs` 里的解析一致），没有真机核对过大小写与层级；这两个平台建议直接用宿主界面的「安装插件 / 从本地文件夹安装」。
