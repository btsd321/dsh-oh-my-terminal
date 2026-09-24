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

`dsh-oh-my-terminal` 是 DSH Web GUI 的底部终端面板插件，基于 node-pty 提供多标签交互式终端（Windows ConPTY / POSIX openpty），经 WebSocket 与浏览器端的 xterm.js 前端通信。用户通过 `dsh plugin --profile web add dsh-oh-my-terminal` 安装。

架构分为两半加共享工具层：

- **宿主半**（`src/index.ts`）：Cordis 插件入口，注册路由、管理 node-pty 进程、WebSocket 升级与数据转发、settings 集成
- **浏览器半**（`src/client.tsx`）：React 组件，xterm.js 底部面板，多 tab 管理、快捷键、拖拽调高、剪贴板
- **持久化层**（`src/persistence.ts`）：`SessionStore` 封装会话日志落盘/清理、元数据读写、启动恢复
- **平台适配层**（`src/platform.ts`）：`PlatformAdapter` 接口与 POSIX/Windows 适配器，封装 OS 差异
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

`pnpm-workspace.yaml` 的 `allowBuilds` 放行了 `node-pty`（原生编译）；`minimumReleaseAge: 0` 避免拦截当天发布的依赖。

## 架构

```
src/
├── index.ts           # 宿主半入口（cordis 插件：apply/inject/name + 路由分发 + pty 生命周期 + WebSocket 升级 + settings 集成）
├── client.tsx          # 浏览器半入口（xterm 底部面板 + 多 tab + 快捷键 + 拖拽调高 + 剪贴板 + 自定义 Hooks）
├── persistence.ts      # 会话持久化层（SessionStore：日志落盘/清理、元数据读写、启动恢复）
├── platform.ts         # 平台适配层（PlatformAdapter 接口 + POSIX/Windows 适配器 + envPick）
├── constants.ts        # 协议/尺寸/快捷键/环境变量/文件名常量
├── server-command.ts   # 命令行解析工具（shell 命令拆分与转义）
├── shortcut.ts         # 快捷键解析工具（toggle 快捷键字符串 → KeyboardEvent 匹配）
└── logger.ts           # 统一日志工具（createLogger：结构化 [时间戳][级别][模块] 内容）
```

依赖方向：`index.ts` 依赖 `constants.ts`、`platform.ts`、`persistence.ts`、`server-command.ts`、`logger.ts`；`persistence.ts` 依赖 `constants.ts` 与 `logger.ts`；`client.tsx` 依赖 `shortcut.ts` 与 `logger.ts`，独立运行在浏览器侧。两半经 WebSocket 通信，路由前缀 `/api/dsh-remote-terminal`。

## 经验教训与硬约束

- **插件形态**：宿主产物必须 ESM；命令名匹配 `/^[a-z][a-z0-9_-]*$/`；defineTool 的 object 节点必须写 `additionalProperties`；路由只走已鉴权通道
- **node-pty**：`spawn` 时 `cwd` 必须存在且可访问，否则进程立即退出；Windows 上用 ConPTY，POSIX 上用 openpty，不要手动 `fork`
- **WebSocket**：socket error 必须在 destroy 之前挂 error 监听器，未处理 error 事件会直接掀翻进程；关闭时要成对清理 `data`/`close`/`error` 监听器
- **xterm.css**：构建时从 `node_modules/@xterm/xterm/css/xterm.css` 复制到 `lib/xterm.css`，由宿主半 serve
- **终端数据绝不进日志**：pty 输出与 WebSocket 数据帧是用户会话内容，不写日志

## 约束

- 客户端可能是 Windows/Linux/macOS，宿主半跑在 dsh 所在机器上。node-pty 自动按平台选 ConPTY 或 openpty。
- 不落明文凭据：日志和错误消息不打印密钥、令牌、口令内容。
- 新增运行时依赖必须写进 `package.json`，版本锁定或用窄范围。
- **禁止声明生命周期脚本**：`prepare`/`postinstall` 等一概不要加——pnpm 11 对声明了安装类脚本的 git-hosted 包直接报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，拦截只看 `package.json` 字段、不看脚本内容。
