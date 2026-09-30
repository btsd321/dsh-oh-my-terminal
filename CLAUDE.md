# CLAUDE.md

本文件为 `dsh-oh-my-terminal` 仓库提供 Claude Code (claude.ai/code) 的编码指导。

## 必读文档

AI agent 或人类开发者在动手修改任何代码或文档之前，**必须先阅读**以下两份规范：

- [docs/git-workflow.md](docs/git-workflow.md) — Git 分支管理与提交规范（分支创建、合并方向、commit message 格式、agent 检查清单）
- [docs/type_script_style.md](docs/type_script_style.md) — TypeScript 编程规范（注释、命名、模块结构、类型约定）

未读这两份文档就动手改代码视为违规。

## 语言要求

本仓库的所有交流、代码注释、提交信息、文档一律使用**中文**。

## 这是什么

`dsh-oh-my-terminal` 是 DSH Web GUI 的底部终端面板插件，基于 `@lydell/node-pty` 提供多终端交互式面板（Windows ConPTY / POSIX openpty），经 WebSocket 与浏览器端的 xterm.js 前端通信。用户通过 `dsh plugin --profile web add dsh-oh-my-terminal` 安装。

VSCode 风格界面：+号旁下拉菜单（新建/拆分/按种类新建）、拆分终端（同组水平并排）、右侧终端列表（替代水平 tab 栏）、右键重命名。

架构分为两半加共享工具层：

- **宿主半**（`src/index.ts` + `src/routes.ts` + `src/ws-handler.ts`）：Cordis 插件入口、HTTP 路由分发、WebSocket 升级与数据转发、settings 集成、会话生命周期管理
- **浏览器半**（`src/client.tsx` + `src/client/`）：React 组件，xterm.js 底部面板，useReducer 统一状态管理、拆分终端、右侧列表、下拉菜单、快捷键、拖拽调高、剪贴板
- **持久化层**（`src/persistence.ts`）：`SessionStore` 封装会话日志落盘/清理、元数据读写、启动恢复
- **平台适配层**（`src/platform.ts`）：`PlatformAdapter` 接口与 POSIX/Windows 适配器，封装 OS 差异，动态探测 Git Bash 与默认 shell
- **常量**（`src/constants.ts`）：协议前缀、尺寸约束、快捷键默认值、环境变量名等具名常量
- **工具函数**（`src/server-command.ts`、`src/shortcut.ts`、`src/logger.ts`）：命令行解析、快捷键解析、统一日志

**插件形态必须构建**：dsh loader 经纯 ESM import 加载插件、不走 tsx，所以必须用 `scripts/build.ts` 产出 `lib/` 构建产物。`lib/` 纳入版本控制——pnpm 11 对声明了安装类脚本的 git-hosted 包直接报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，且只看 `package.json` 字段、不看脚本内容做什么，所以本仓库**不声明任何生命周期脚本**（`prepare`/`postinstall` 都没有）。构建由开发者手动 `pnpm run build` 完成，产物 `lib/` 随源码一起提交。

## 常用命令

**本机开发默认 pnpm 11.7.0**（`package.json` 的 `packageManager` 钉版本）。不要用 npm——peer 依赖钉死具体版本，npm 在残留旧树上做增量解析必报 ERESOLVE。

```bash
# 类型检查
pnpm run typecheck

# 构建（esbuild 双入口 → lib/index.js + lib/client.js + lib/xterm.css）
pnpm run build

# 单元测试（纯函数模块）
pnpm exec tsx --test tests/unit/*.test.ts
```

`pnpm-workspace.yaml` 的 `allowBuilds` 只放行 `esbuild`——`@lydell/node-pty` 的各平台二进制随子包 tarball 分发，安装期既不编译也不下载，所以不需要（也不应）为它放行构建脚本；`minimumReleaseAge: 0` 避免拦截当天发布的依赖。

## 架构

```
src/
├── index.ts                # 宿主半入口（cordis 插件壳 + settings 集成 + 会话生命周期 + loadPty 懒加载 + prepareProfiles/settleProfiles 配置表落定）
├── routes.ts               # HTTP 路由处理器工厂（createRouteHandler + 辅助函数）
├── ws-handler.ts           # WebSocket 处理器工厂（createWsHandlers + WebServer 类型导出）
├── client.tsx              # 浏览器半入口（TerminalPanel 组合壳 + 插件注册 + shortcuts 命令注册 + injectStyles 调用）
├── client/
│   ├── types.ts            # 共享类型定义（TerminalInstance, TerminalGroup, TerminalState, TerminalAction, API 响应）
│   ├── hooks.ts            # 兼容壳（re-export terminal/ 子模块，保持对外接口不变）
│   ├── term-pane.tsx       # TermPane 组件（xterm + WebSocket + resize）+ RestartButton 组件
│   ├── styles.ts           # CSS 样式常量（PANEL_CSS）+ Campbell 暗色主题 + xterm 调优常量 + injectStyles()
│   ├── dropdown.tsx        # +号旁下拉菜单组件（新建/拆分/按种类新建）
│   ├── side-list.tsx       # 右侧终端列表面板（树形前缀 + 右键重命名 + useMemo 缓存）
│   ├── shortcut-bridge.ts  # shortcuts 服务接入信号桥（命令注册状态 + 面板切换回调，软探测兼容旧宿主）
│   ├── compat.ts          # DSH-better-sidebar 兼容模式检测（软探测 ctx.betterSidebar + 服务最小接口声明）
│   ├── sidebar-tab.tsx    # 侧边栏终端 tab 组件（兼容模式：嵌入 DSH-better-sidebar 底部工作台，不绑定 DSH sessionId）
│   ├── terminal/
│   │   ├── reducer.ts          # 终端状态 reducer（terminalReducer 纯函数 + createInitialState）
│   │   ├── use-terminal-state.ts # 终端状态管理 Hook（useTerminalState：useReducer 封装 + 启动恢复）
│   │   ├── use-panel-geometry.ts # 面板几何与高度管理（usePanelGeometry + usePanelHeight：拖拽调高 + localStorage + 对话列几何测量）
│   │   └── use-tabs.ts         # 终端标签页状态管理（useTerminalTabs + useConfig：newTab/splitTerminal/closeTerminal/renameTerminal + 配置拉取）
│   ├── settings/
│   │   ├── types.ts        # 设置页面类型定义（SettingsPageProps、ConfigWithProfiles）
│   │   ├── store.ts        # 设置页面状态管理（useSettingsState Hook）
│   │   ├── card.tsx        # 设置卡片组件（SettingsCard）
│   │   ├── profile-table.tsx # 终端配置表格组件（TerminalProfile[] CRUD UI：inline 编辑/新增/删除/origin 约束）
│   │   ├── api.ts          # Settings Bridge HTTP 客户端（封装与宿主半 Settings Bridge 的 HTTP 交互）
│   │   └── styles.ts       # 配置表单样式模块（injectSettingsStyles + CSS 自定义属性主题自适应）
│   ├── icons.tsx           # SVG 图标组件集合（10 个纯函数）
│   └── clipboard.ts        # 剪贴板纯函数（Async Clipboard API + legacy 双层降级）
├── terminal/
│   ├── index.ts            # 终端模块统一导出（kinds/detect/resolve/store + settleProfileTable）
│   ├── kinds.ts            # 终端种类定义（TerminalKind 联合类型 + KIND_SPECS 平台映射表）
│   ├── detect.ts           # 终端探测（resolveCommand/detectGitBash/detectTerminalProfiles）
│   ├── resolve.ts          # 配置解析（resolveProfile：TerminalProfile → node-pty spawn 参数）
│   └── store.ts            # 配置表校验（validateAdd/validateUpdate/validateDelete/addProfile/updateProfile/deleteProfile + settleProfileTable 落盘决策）
├── settings/
│   ├── index.ts            # settings bridge 模块入口（registerSettingsIntegration + registerSettingsNamespace + SettingsChannel 读写通道 + volatile 解包）
│   ├── namespace.ts        # Settings 命名空间定义（SettingsNamespace + SETTINGS_NS 常量）
│   ├── bridge.ts           # Settings 桥接路由工厂（createSettingsBridgeRoutes：describe + mutate 路由，SettingsLike 最小接口）
│   └── patch.ts            # JSON Patch 操作类型与构造函数（op:'set' 路径数组形式，零额外依赖）
├── persistence.ts          # 会话持久化层（SessionStore：日志落盘/清理、元数据读写、启动恢复）
├── platform.ts             # 平台适配层（PlatformAdapter 接口 + POSIX/Windows 适配器 + 默认 shell 探测）
├── constants.ts            # 协议/尺寸/快捷键/环境变量/文件名常量
├── server-command.ts       # 命令行解析工具（shell 命令拆分与转义）
├── shortcut.ts             # 快捷键解析工具（toggle 快捷键字符串 → KeyboardEvent 匹配）
└── logger.ts               # 统一日志工具（createLogger：结构化 [时间戳][级别][模块] 内容）
```

### 依赖方向

```
宿主半：
  index.ts → routes.ts → terminal/, settings/, constants.ts, platform.ts, persistence.ts, server-command.ts, logger.ts
  index.ts → ws-handler.ts → constants.ts, persistence.ts
  index.ts → terminal/, settings/, constants.ts, platform.ts, persistence.ts, logger.ts
  settings/index.ts → settings/bridge.ts, settings/namespace.ts, settings/patch.ts
  settings/bridge.ts → settings/namespace.ts, settings/patch.ts
  terminal/detect.ts → terminal/kinds.ts
  terminal/resolve.ts → terminal/kinds.ts, platform.ts
  terminal/store.ts → terminal/kinds.ts, terminal/detect.ts
  platform.ts → terminal/detect.ts（复用 resolveCommand）
  persistence.ts → constants.ts, logger.ts

浏览器半：
  client.tsx → client/types.ts, client/icons.tsx, client/clipboard.ts,
               client/dropdown.tsx, client/side-list.tsx, client/hooks.ts,
               client/styles.ts, client/term-pane.tsx, client/settings/,
               client/shortcut-bridge.ts, client/compat.ts, client/sidebar-tab.tsx,
               logger.ts
  client/hooks.ts → client/terminal/*（re-export 兼容壳：reducer/use-terminal-state/use-panel-geometry/use-tabs）
  client/shortcut-bridge.ts → client/types.ts, constants.ts, logger.ts
  client/compat.ts → logger.ts（软探测 ctx.betterSidebar，声明服务最小接口）
  client/sidebar-tab.tsx → client/hooks.ts, client/term-pane.tsx, client/dropdown.tsx,
                           client/side-list.tsx, client/icons.tsx, client/compat.ts, logger.ts
  client/terminal/reducer.ts → client/types.ts, logger.ts
  client/terminal/use-terminal-state.ts → client/terminal/reducer.ts, client/types.ts, logger.ts
  client/terminal/use-panel-geometry.ts → client/types.ts, constants.ts, logger.ts
  client/terminal/use-tabs.ts → client/types.ts, shortcut.ts, client/shortcut-bridge.ts, constants.ts, logger.ts
  client/settings/card.tsx → client/settings/types.ts, client/settings/api.ts, client/settings/store.ts, client/settings/profile-table.tsx, client/icons.tsx
  client/settings/store.ts → client/settings/types.ts
  client/settings/profile-table.tsx → client/settings/types.ts, client/settings/api.ts
  client/settings/api.ts → client/settings/types.ts
  client/dropdown.tsx → client/types.ts, client/icons.tsx
  client/side-list.tsx → client/types.ts, client/icons.tsx
  client/term-pane.tsx → client/types.ts, client/clipboard.ts, client/icons.tsx, client/styles.ts

两半经 WebSocket 通信，路由前缀 /api/dsh-oh-my-terminal，不直接 import。
@lydell/node-pty 是外部原生依赖，宿主半只在首次创建会话时 await import()。
```

### 状态管理

浏览器半使用 `useReducer` 统一管理终端状态（`TerminalState`），消除原先 instances/groups/activeInstanceId 三轨独立 state 的同步负担。所有 CRUD 操作通过 `dispatch(TerminalAction)` 提交，reducer 是纯函数。`/config` 只拉取一次（`useConfig` Hook），同时获取快捷键配置和终端配置表（`terminalProfiles`）。

### 终端配置模型（type / name / path）

终端种类不再硬编码在 `platform.ts`，而是由配置表驱动：

| 字段 | 说明 |
|------|------|
| `type` | 终端类型（`TerminalKind`）：pwsh / powershell / cmd / bash / zsh / fish / gitbash / nushell / custom。决定 spawn 语义与交互参数 |
| `name` | 下拉菜单显示名。用户可改，跨重启保留 |
| `path` | 可执行文件路径。留空则按 `type` 在 `$PATH` 中解析 |
| `origin` | `auto`（启动探测）/ `user`（手动新增）。`auto` 项不可删除、path 不可改，但可改名 |

**启动流程**（两阶段，读写同通道）：`detectTerminalProfiles()` 在 apply 时跑一次 `$PATH` 探测（`where`/`which` 子进程调用有成本，只跑一次并缓存）；`prepareProfiles()` 读 volatile 配置初值与探测结果合并（`mergeProfiles()`：已保存项全保留，探测到的新 type/path 补进去）产出初值，routes 立即可用；settings 服务就绪后 `settleProfiles()` 经 `SettingsChannel`（`registerSettingsNamespace` 的 `onReady` 回调交出，read/update 同一命名空间）读回持久层已保存表，重算合并结果并 `cachedProfiles.splice(...)` 就地刷新（保持数组身份，routes/bridge 闭包引用同步生效）。首跑（持久层读回为空）时把探测结果落盘，读回非空时绝不写回（用户改过的 name/手动新增项原样保留）。

**读写同通道**：必须读写走同一 settings 通道（owner scope → 服务级 get → describe 扫描，逐能力探测）。旧实现读 cordis loader 的 volatile 引用、写 settings user 层，两通道互不可见导致读回恒空、每次启动判首跑并覆盖用户配置。volatile 字段的稳定引用（cosmokit `Symbol.for('cosmokit.volatile.write')`）需在通道内解包为标量，否则 JSON 序列化后只剩 `{}`、字符串字段永远"读不到"。

**路径解析**：`resolveProfile()` 把 `TerminalProfile` 转成 node-pty 的 `{ file, args }`。**Windows 上 node-pty 不做 PATH/PATHEXT 查找**，裸命令名（`pwsh`、`cmd`）会直接以 `File not found: ` 失败，必须给完整路径——`resolveCommand()` 用 `where`/`which` 解析，并过滤 `WindowsApps` 下的 App Execution Alias 占位符（0 字节重解析点，spawn 必失败）。

**持久化**：配置表在 `Config` schema 里是 **JSON 字符串**（`terminalProfiles`），不是嵌套数组——schemastery 对对象数组的 round-trip 行为不保证，字符串是唯一稳定形态。空串 = 用启动探测结果。

**API 契约**：客户端只传 `profileId`（配置表 id），不传路径与参数。`POST /sessions` 的 `profileId` 字段与宿主半 `routes.ts` 的读取字段名必须一致——曾因客户端发 `terminalType`、宿主半读 `profileId` 导致下拉菜单静默失效（始终回落到默认 shell）。

## 经验教训与硬约束

- **插件形态**：宿主产物必须 ESM；命令名匹配 `/^[a-z][a-z0-9_-]*$/`；defineTool 的 object 节点必须写 `additionalProperties`；路由只走已鉴权通道
- **ESM 合规**：所有源文件是 ESM 模块，**禁止使用 `require()`**——必须用顶层 `import` 或动态 `await import()`。esbuild 会把 `require()` 转成 `__require()` 包装，在 DSH 的 Electron 进程中可能失败（曾导致 Git Bash 探测静默失败）
- **@lydell/node-pty**：`spawn` 时 `cwd` 必须存在且可访问，否则进程立即退出；Windows 上用 ConPTY，POSIX 上用 openpty，不要手动 `fork`
- **原生绑定懒加载**：宿主半不写顶层静态 `import { spawn } from '@lydell/node-pty'`。ESM 的异常发生在模块求值期，原生绑定一旦加载失败，整个 `lib/index.js` 就变成不可导入、dsh 报 `failed to import`，插件连 `apply` 都执行不到；改成首次创建会话时 `await import()`，失败被收敛在会话创建这一步，错误消息可读，插件其余路由仍可用
- **精确钉 `@lydell/node-pty@1.1.0`**：它是 microsoft/node-pty 的预编译分发版（API 同源），N-API 产物一份二进制同时覆盖 ABI 127（Node 22）与 ABI 137（Node 24）；但该包 `dist-tags.latest` 指向 1.2.0-beta 系列，所以必须精确写 `1.1.0`，不能用 `^` 或 `latest`
- **为什么换掉 node-pty**：旧包 tarball 的 `prebuilds/` 只有 darwin 与 win32，Linux 上依赖安装期执行 `node scripts/prebuild.js || node-gyp rebuild`；而 pnpm 10 对未授权的构建脚本只警告并跳过，`build/Release/pty.node` 从未生成。`@lydell/node-pty` 拆六个平台子包、二进制在 tarball 内，运行期不下载不编译，且 `package.json` 连 `scripts` 字段都不存在（不是空对象），pnpm 10/11/12 对没有脚本字段的包都不进入构建授权判断分支
- **WebSocket**：socket error 必须在 destroy 之前挂 error 监听器，未处理 error 事件会直接掀翻进程；关闭时要成对清理 `data`/`close`/`error` 监听器
- **xterm.css**：构建时从 `node_modules/@xterm/xterm/css/xterm.css` 复制到 `lib/xterm.css`，由宿主半 serve
- **终端数据绝不进日志**：pty 输出与 WebSocket 数据帧是用户会话内容，不写日志
- **CSS overflow:hidden 陷阱**：包含 `position:absolute` 浮层（如下拉菜单）的容器不能设 `overflow:hidden`，否则浮层被裁剪不可见
- **Windows 上 spawn 必须给完整路径**：node-pty 的 `spawn` 在 Windows 上**不做 PATH/PATHEXT 查找**，传裸命令名（`pwsh`、`cmd`、`bash`）直接以 `File not found: ` 失败（错误消息里的路径是空串，极易误判为 cwd 问题）。所有终端命令都要先经 `where`/`which` 解析成绝对路径，并过滤 `WindowsApps` 下的 App Execution Alias 占位符
- **跨半字段名必须逐字对齐**：宿主半与浏览器半经 HTTP 通信、无编译期校验，字段名拼写不一致会静默回落到默认分支（曾因客户端发 `terminalType`、宿主半读 `profileId`，导致下拉菜单选了任何类型都开出默认 shell，且无任何报错）
- **单文件行数阈值**：建议 <600 行。超过时按职责边界拆分到子模块，不要按"太长了"随意切半

## 约束

- 客户端可能是 Windows/Linux/macOS，宿主半跑在 dsh 所在机器上。`@lydell/node-pty` 自动按平台选 ConPTY 或 openpty。
- 不落明文凭据：日志和错误消息不打印密钥、令牌、口令内容。
- 新增运行时依赖必须写进 `package.json`，版本锁定或用窄范围；带原生绑定的依赖（如 `@lydell/node-pty`）一律精确钉版本，不留 `^` 浮动空间。
- **禁止声明生命周期脚本**：`prepare`/`postinstall` 等一概不要加——pnpm 11 对声明了安装类脚本的 git-hosted 包直接报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，拦截只看 `package.json` 字段、不看脚本内容。反过来，选依赖时也可以用这条判断：`@lydell/node-pty` 就是这个约束的正面对照——它的 `package.json` 里根本没有 `scripts` 字段，pnpm 10 的只警告并跳过、11 起的默认报错退出、12 的现状，对没有脚本的包都不进入判断分支，因此不产生任何版本差异。这是本仓库能在 pnpm 10-12 上装得上、跑得起来的关键。
