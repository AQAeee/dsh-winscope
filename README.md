# dsh-winscope

[English](README.en.md) | **简体中文**

一个 DSH Web 插件：把 [WinScope](https://source.android.com/docs/core/graphics/winscope)
（Android 图形调试工具）嵌入 DSH 右侧栏，提供两个彼此独立的
**WinScope A** 与 **WinScope B** 面板，并暴露一组 `winscope_*` AI 工具，
让 Agent 能读取已加载的 trace 并驱动时间轴。

你可以并排加载两份 trace（两台设备，或改动前后各一份），然后让 Agent
解释两者之间发生了什么变化。

## 特性

- **两个侧栏面板。** 每个面板承载自己的 WinScope iframe，因此 A / B 各自
  保有独立的 trace 集合、选中节点与时间轴位置。
- **内置 ADB 代理。** 用 Node 重新实现了 Python 版 `winscope_proxy.py` 的
  完整流程，并以同源方式挂在 `/winscope-proxy` 下。无需额外启动 Python 代理，
  也没有跨域配置。
- **Agent 工具桥。** 通过长轮询 + `postMessage` 把 AI 工具调用转发进真实的
  WinScope 界面，Agent 读到的就是你看到的那份数据。
- **自带 WinScope 构建。** Release 包内附带可直接服务的 WinScope 构建；
  也可以通过配置改为指向外部构建目录。

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| Node.js >= 20 | 宿主端运行在 DSH profile 进程内。 |
| `adb` 在 `PATH` 上 | 唯一的硬运行时依赖。设备抓取（`/devices`、`/start`、`/end`、`/dump`、`/fetch`）需要它；仅从文件加载 trace 时不需要。 |
| DSH web profile | 插件会在 `webServer` 上注册路由、在 `tools` 上注册工具。 |
| [dsh-better-sidebar](https://github.com/omdsh-dev/dsh-better-sidebar) | 可选。未安装时插件仍能正常加载，只是不注册侧栏 Tab。 |

## 安装

Git 仓库**只跟踪源码**（`src/`、构建配置、清单文件）。`lib/`（编译产物）与
`winscope-dist/`（自带的 WinScope 构建）不在仓库内——它们由构建产生，并随
Release 包一起分发。因此请从 Release 包安装，而不要直接安装 Git 仓库：

```bash
# 1. 从最新 Release 下载 tarball
#    https://github.com/AQAeee/dsh-winscope/releases

# 2. 加入 web profile
dsh plugin --profile web add ./dsh-winscope-0.1.0.tgz
```

包内的 `cordis.patch.yml` 已声明 bundle 行，profile 会自动识别该插件，
无需手工改动 profile 文件。

如果要发布到自己作用域下的 registry，可从源码构建并打包：

```bash
npm install
npm run build          # 编译 src/ -> lib/
npm pack               # 产出 dsh-winscope-<version>.tgz
```

打包时 `winscope-dist/` 必须存在（它已在 `files` 中声明）。

## 配置

配置通过 profile 中的插件行传入。两个键都是可选的。

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `winscopeDist` | `string` | `''` | 要对外服务的外部 WinScope 构建目录的绝对路径。为空表示「使用本插件自带的构建」。 |
| `toolTimeoutMs` | `number` | `30000` | 一次 AI 工具调用等待浏览器面板应答的超时毫秒数。 |

示例——在 profile patch 层指定外部 WinScope 构建：

```yaml
- id: dsh-winscope
  config:
    winscopeDist: /absolute/path/to/winscope/dist
```

## 使用

1. 打开右侧栏的 `+` 菜单，选择 **WinScope A**（如有需要再选 **WinScope B**）。
2. 等待面板角标显示 `已连接 (connected)`——WinScope 是 Angular 应用，
   启动需要一点时间。
3. 加载 trace：在面板内上传 `.winscope` 文件，或通过内置代理从已连接设备抓取。
4. 让 Agent 分析。要做对比时，把第二份 trace 加载到 **WinScope B**，
   并告诉 Agent 使用哪个面板：

   > 对比面板 A 和面板 B 中图层 X 在 12.5s 附近的 visibleRegion。

## AI 工具

每个工具都作用于一个面板（`A` 或 `B`），并把 WinScope 的应答以 JSON 返回。

| 工具 | 用途 |
| --- | --- |
| `winscope_list_traces` | 列出已加载的 trace：trace 类型、来源文件、条目数、首/末时间戳（ns）、是否为 dump。**应先调用它**以确认有效时间范围。 |
| `winscope_get_position` | 读取面板当前选中的时间轴位置。 |
| `winscope_get_hierarchy` | 获取某一时刻的层级（或属性）树**骨架**——id、名称、子节点数。 |
| `winscope_get_hierarchy_range` | 获取一段时间范围内的多个层级快照。 |
| `winscope_get_properties` | 获取某一时刻某个节点的完整属性树。 |
| `winscope_get_property_timeline` | 跟踪某个节点单个属性在时间范围内的取值（`{timestampNs, present, value}` 序列）。 |
| `winscope_get_node_timeline` | 跟踪某个节点多个属性在时间范围内的取值。 |
| `winscope_seek` | 把面板时间轴移动到指定时间戳（界面会同步跟随）。 |

工具描述里已经写入了两个 WinScope 特有的坑：在 `SURFACE_FLINGER` trace 中
节点 id 会**跨快照不稳定**，应传 `node_name` 作为兜底；快照是抽样得到的，
时间范围应尽量收窄到关注点附近。

一次典型的排查链路：`winscope_list_traces` → `winscope_get_hierarchy` →
`winscope_get_properties` → `winscope_get_property_timeline`。

## 工作原理

```
AI 工具调用（Node）
   │  Bridge.request()  ── 入队
   ▼
GET /winscope-bridge/poll   （浏览器长轮询，约 15s）
   │  经 postMessage 送入该面板的 WinScope iframe
   ▼
WinScope cross-tool 应答
   │  POST /winscope-bridge/respond
   ▼
Bridge.respond() ── 解析工具 Promise
```

注册在 DSH Web 服务器上的路由：

| 路径 | 用途 |
| --- | --- |
| `/winscope/*` | WinScope 静态构建（`index.html`、带哈希的 JS、`trace_processor.wasm`）。会拒绝路径穿越；响应为 `no-cache`。 |
| `/winscope-bridge/*` | `poll`、`respond`、`heartbeat`——AI 工具桥。只要心跳持续到达，面板即视为在线（30s 窗口）。 |
| `/winscope-proxy/*` | ADB 代理：`config`、`devices`、`checkwayland`、`status`、`fetch`、`start`、`end`、`dump`。 |

除 `config` 外，代理的每个调用都需要 `Winscope-Token` 请求头。token 在首次
启动时生成并持久化到 `~/.config/winscope/.token`（Windows 下为
`%USERPROFILE%\.config\winscope\.token`）；若已存在 Python 代理留下的 token
则直接复用。`GET /winscope-proxy/config` 会把 token 交给浏览器以便拼出 iframe
地址；该端点刻意不做鉴权，不应暴露到 localhost 之外。

## 开发

```bash
npm install
npm run build       # tsdown：lib/index.js（宿主，ESM）+ lib/client.js（浏览器）
npm run watch       # 变更时自动重建
npm run typecheck   # tsc --noEmit
```

源码结构：

| 路径 | 内容 |
| --- | --- |
| `src/index.ts` | 宿主入口：Web 路由、静态服务、token 处理、工具注册。 |
| `src/tools.ts` | 八个 `winscope_*` 工具定义。 |
| `src/bridge.ts` | 宿主侧请求队列、长轮询 drain、应答匹配、心跳跟踪。 |
| `src/shared.ts` | 两端共享的通信类型，以及 WinScope 的 `MsgType` id。 |
| `src/client/index.tsx` | 浏览器端：侧栏 Tab 注册、iframe 嵌入、poll/postMessage 桥。 |
| `src/proxy/` | `winscope_proxy.py` 的 Node 移植：`adb`、`sessions`、`targets`、`traceConfigs`、`server`、`config`。 |

构建说明：宿主端是普通 ESM，`@deepseek-ai/*` 与 `cordis` 保持 external
（它们在 profile 内解析）。客户端是 CJS 闭包 bundle，仅把平台 seed 模块列为
external，并通过 `window.__ModuleLoader__.load({ id: 'dsh-winscope', ... })`
自注册——该 id 必须与 `cordis.patch.yml` 中的 loader 条目名一致。

`src/shared.ts` 里的 WinScope cross-tool 消息 id 对应
`winscope/src/cross_tool/messages.ts`；`src/proxy/config.ts` 中的代理
`VERSION` 对应 `ProxyConnection#VERSION`。升级自带的 WinScope 构建时，
两者都需要同步更新。

## 致谢

WinScope 是 Android Open Source Project 的工具。包内自带的构建，以及本插件
所移植的 `winscope_proxy.py` 参考实现，均属于该项目。

## 许可证

GPL-3.0-only，详见 [LICENSE](LICENSE)。