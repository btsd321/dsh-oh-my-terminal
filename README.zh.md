# dsh-oh-my-terminal

[![version](https://img.shields.io/badge/version-0.2.9-blue)](package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%5E20.19.0%20%7C%7C%20%3E%3D22.0.0-brightgreen)](package.json)

DSH Web GUI 的底部终端面板插件，基于 `@lydell/node-pty` 提供多终端交互式面板，经 WebSocket 与浏览器端的 xterm.js 通信。支持 Windows ConPTY 与 POSIX openpty，无需本地编译。

## 功能特性

- **多标签终端**：同时管理多个会话，右侧列表替代水平 tab 栏，支持右键重命名
- **拆分终端**：同组内水平并排，+号旁下拉菜单（新建 / 拆分 / 按种类新建），VSCode 风格操作
- **会话持久化**：面板收起后会话保持存活，重新打开后自动恢复
- **快捷键开关**：可配置快捷键呼出/收起面板；接入宿主统一快捷键系统，在设置界面改键后标签跟随更新
- **拖拽调高**：拖拽面板上边缘调整高度
- **跨平台**：Windows ConPTY / POSIX openpty，由 `@lydell/node-pty` 自动选择，二进制随 tarball 分发，安装即用
- **配置表驱动终端**：终端配置表（type / name / path）驱动新建终端；启动时自动探测 $PATH 中的终端，可在设置界面新增、改名、编辑路径
- **字体可配置**：字体族、字号、行高可配置，配置变更对已打开终端即时生效
- **DSH-better-sidebar 兼容**：运行时自动检测 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)，检测到时切换为兼容模式——通过 `ctx.betterSidebar.registerTab()` 注册"终端"tab 嵌入其底部工作台，替代独立底部面板；PTY 会话不绑定 DSH session 的 write handle，从根源消除与 DSH-better-sidebar 自带终端的冲突。当宿主支持 `TabDescriptor.rightActions`（v0.25.0+）时，终端操作按钮（新建 / 拆分 / 重启）注入 tab 标签条右端，VSCode 风格单层栏；不支持时回退为 tab 内容区顶部头部栏（两层显示）

## 安装

本仓库尚未发布到 npm，通过 GitHub 地址安装：

```bash
dsh plugin --profile web add github:btsd321/dsh-oh-my-terminal
```

## 配置

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `toggleShortcut` | 呼出/收起终端面板的快捷键（仅旧宿主生效，见下方适配说明） | `` Ctrl+Shift+` `` |
| `fontFamily` | 终端字体族（CSS `font-family` 串）；留空使用内置默认字体栈（含 CJK 回退） | `''` |
| `fontSize` | 终端字号（像素） | `12.5` |
| `lineHeight` | 终端行高倍数 | `1.25` |
| `terminalProfiles` | 终端配置表（JSON 数组）；留空 = 用启动时探测到的 $PATH 终端 | `''` |

### 终端配置表

终端配置表是 `{ id, type, name, path, origin }` 条目的 JSON 数组：

- **type**：决定 spawn 语义 — `pwsh` / `powershell` / `cmd` / `bash` / `zsh` / `fish` / `gitbash` / `nushell` / `custom`
- **name**：下拉菜单显示名（用户可改）
- **path**：可执行文件路径；留空 = 按 type 在 `$PATH` 中解析
- **origin**：`auto`（启动探测）/ `user`（手动新增）

自动探测项（`origin: auto`）不可删除、路径不可改，但名称始终可编辑。配置表可在设置界面内 inline 编辑、新增行、删除。

## 开发

```bash
# 安装依赖（@lydell/node-pty 自带各平台预编译二进制，装完即用，无需本地编译）
pnpm install

# 类型检查
pnpm run typecheck

# 构建（esbuild 双入口，产物输出到 lib/）
pnpm run build

# 单元测试
pnpm exec tsx --test tests/unit/*.test.ts
```

> 请使用 `pnpm`，不要用 `npm`。peer 依赖钉死具体版本，npm 在旧依赖树上做增量解析会报 ERESOLVE。

### 关于构建产物

`lib/` 已纳入版本控制。DSH loader 通过纯 ESM import 加载插件，不走 tsx；同时本仓库不声明 `prepare`/`postinstall` 等生命周期脚本（pnpm 11 对声明了安装类脚本的 git-hosted 包直接报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），因此构建产物需开发者手动执行 `pnpm run build` 后随源码一起提交。

### 原生依赖说明

终端能力来自 `@lydell/node-pty`（microsoft/node-pty 的预编译分发版，API 同源），版本精确钉在 `1.1.0`：该包 `dist-tags.latest` 指向 1.2.0-beta 系列，用 `^` 会取到 beta。

它是 N-API 产物，二进制按平台拆成六个子包随 tarball 分发，安装期不下载、不编译，同一份二进制同时支持 Node 22 与 Node 24。其 `package.json` 中不存在 `scripts` 字段，pnpm 10/11/12 对没有脚本字段的包不进入构建授权判断分支，行为一致。

宿主半对它是懒加载（首次创建会话时才 `await import()`）：原生绑定若加载失败，异常只影响会话创建，不会让插件模块本身导入失败。

## 架构概览

```
src/
├── index.ts              # 宿主半入口（Cordis 插件 + settings + 会话生命周期）
├── routes.ts             # HTTP 路由处理器
├── ws-handler.ts         # WebSocket 处理器（pty 数据转发）
├── client.tsx            # 浏览器半入口（React 组件 + 插件注册）
├── client/
│   ├── types.ts          # 共享类型
│   ├── hooks.ts          # useReducer 状态管理 + 自定义 Hooks
│   ├── term-pane.tsx     # xterm.js 终端面板组件
│   ├── dropdown.tsx      # +号旁下拉菜单
│   ├── side-list.tsx     # 右侧终端列表
│   ├── styles.ts         # CSS 常量 + Campbell 暗色主题
│   ├── icons.tsx         # SVG 图标组件
│   ├── clipboard.ts      # 剪贴板工具函数
│   ├── shortcut-bridge.ts # shortcuts 服务接入桥（命令注册 + 面板切换回调）
│   ├── compat.ts          # DSH-better-sidebar 兼容模式检测（软探测 ctx.betterSidebar + 服务最小接口声明）
│   ├── sidebar-tab.tsx    # 侧边栏终端 tab 组件（兼容模式：嵌入 DSH-better-sidebar 底部工作台，不绑定 DSH sessionId）
│   ├── settings/         # 设置界面（types / store / card / profile-table / api / styles）
│   └── terminal/         # 终端标签页状态（use-tabs / reducer / use-terminal-state / geometry）
├── persistence.ts        # 会话持久化层（日志落盘 / 元数据 / 启动恢复）
├── platform.ts           # 平台适配层（POSIX / Windows + shell 探测）
├── terminal/             # 终端种类、探测、解析、配置表校验
├── settings/             # Settings 桥接层（命名空间 / 路由 / patch 操作）
├── constants.ts          # 协议 / 尺寸 / 快捷键 / 环境变量常量
├── server-command.ts     # 命令行解析工具
├── shortcut.ts           # 快捷键解析工具
└── logger.ts             # 统一日志工具
```

宿主半与浏览器半经 WebSocket 通信，路由前缀 `/api/dsh-oh-my-terminal`，不直接 import。

## License

[Apache-2.0](LICENSE)
