# dsh-oh-my-terminal

[![version](https://img.shields.io/badge/version-0.2.1-blue)](package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%5E20.19.0%20%7C%7C%20%3E%3D22.0.0-brightgreen)](package.json)

DSH Web GUI 的底部终端面板插件，基于 `@lydell/node-pty` 提供多终端交互式面板，经 WebSocket 与浏览器端的 xterm.js 通信。支持 Windows ConPTY 与 POSIX openpty，无需本地编译。

## 功能特性

- **多标签终端**：同时管理多个会话，右侧列表替代水平 tab 栏，支持右键重命名
- **拆分终端**：同组内水平并排，+号旁下拉菜单（新建 / 拆分 / 按种类新建），VSCode 风格操作
- **会话持久化**：面板收起后会话保持存活，重新打开后自动恢复
- **快捷键开关**：可配置快捷键呼出/收起面板；DSH 0.1.7-rc.2+ 接入宿主统一快捷键系统，在设置界面改键后标签跟随更新
- **拖拽调高**：拖拽面板上边缘调整高度
- **跨平台**：Windows ConPTY / POSIX openpty，由 `@lydell/node-pty` 自动选择，二进制随 tarball 分发，安装即用
- **可配置 shell**：自定义 shell 命令与启动参数

## 安装

本仓库尚未发布到 npm，通过 GitHub 地址安装：

```bash
dsh plugin --profile web add github:btsd321/dsh-oh-my-terminal
```

## 配置

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `toggleShortcut` | 呼出/收起终端面板的快捷键（仅旧宿主生效，见下方适配说明） | `` Ctrl+` `` |
| `shellCommand` | 终端使用的 shell 命令 | 系统默认（bash / PowerShell） |

## DSH 0.1.7-rc.2 快捷键适配说明

DSH 0.1.7-rc.2 起宿主自带全局快捷键系统，其内置终端（右侧栏 `terminal.new` 命令）占用了 `` Ctrl+` ``。为避免同一按键双重响应，本插件自 rc.2 适配版起做出以下调整：

- **接入 shortcuts 系统**：插件注册 `terminal-panel.toggle` 命令，默认绑定 `` Ctrl+Shift+` ``（`web:linux` 无默认键，需在设置界面手动绑定）。改键在 DSH 设置 - 快捷键中进行，面板提示标签跟随当前有效绑定
- **旧宿主（0.1.7-rc.1 及更早）**：自动降级为裸 `` Ctrl+` `` 监听，`toggleShortcut` 配置照常生效
- **迁移指引**：升级宿主后，`` Ctrl+` `` 归内置终端使用，插件面板切换改用 `` Ctrl+Shift+` ``；如需改回 `` Ctrl+` ``，请先在 DSH 快捷键设置中解除内置终端的绑定

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
├── index.ts          # 宿主半入口（Cordis 插件 + settings + 会话生命周期）
├── routes.ts         # HTTP 路由处理器
├── ws-handler.ts     # WebSocket 处理器（pty 数据转发）
├── client.tsx        # 浏览器半入口（React 组件 + 插件注册）
├── client/
│   ├── types.ts      # 共享类型
│   ├── hooks.ts      # useReducer 状态管理 + 自定义 Hooks
│   ├── term-pane.tsx # xterm.js 终端面板组件
│   ├── dropdown.tsx  # +号旁下拉菜单
│   ├── side-list.tsx # 右侧终端列表
│   ├── styles.ts     # CSS 常量 + Campbell 暗色主题
│   ├── icons.tsx     # SVG 图标组件
│   └── clipboard.ts  # 剪贴板工具函数
├── persistence.ts    # 会话持久化层（日志落盘 / 元数据 / 启动恢复）
├── platform.ts       # 平台适配层（POSIX / Windows + shell 探测）
├── constants.ts      # 协议 / 尺寸 / 快捷键 / 环境变量常量
├── server-command.ts # 命令行解析工具
├── shortcut.ts       # 快捷键解析工具
└── logger.ts         # 统一日志工具
```

宿主半与浏览器半经 WebSocket 通信，路由前缀 `/api/dsh-oh-my-terminal`，不直接 import。

## License

[Apache-2.0](LICENSE)
