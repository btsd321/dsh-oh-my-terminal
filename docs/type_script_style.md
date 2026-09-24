# TypeScript 编程规范（AI 编程约定）

本文档是 `dsh-oh-my-terminal` 仓库的代码风格与工程约定。AI 与人类开发者写任何 TypeScript 代码前都应遵循本规范。

核心原则：**模块化、工程化、注释完备**。新代码要读起来像仓库里已有的代码，而不是像另一个人写的。

---

## 一、注释规范

注释一律用**中文**。注释解释"为什么"和"约束是什么"，不重复代码已经说清楚的"做了什么"。

### 1.1 文件头（必需）

每个 `.ts` 文件开头必须有文件级 JSDoc，包含 `@file` 和 `@description`。`@description` 要写清这个模块在整体架构中的位置和职责边界，而非罗列函数名。

涉及协议、安全、跨模块契约的文件，在 `@description` 之后追加分节说明（流程、约束、兼容性要求）。

```typescript
/**
 * @file 宿主半终端管理模块
 * @description 管理 @lydell/node-pty 进程的创建、销毁与 WebSocket 数据转发。
 *              pty 进程与 WebSocket 一一绑定，面板关闭时同时销毁两者。
 *
 * 安全约束：
 * - WebSocket 升级只走已鉴权通道，未鉴权连接直接拒绝
 * - 终端输出数据帧绝不写日志（用户会话内容）
 * - socket error 监听器必须在任何 destroy 之前挂上，未处理 error 事件会直接掀翻进程
 */
```

插件主入口这类需要被外部理解的模块，额外标注 `@module`。

### 1.2 接口与类型（必需）

接口本身要有 JSDoc 说明用途；**每个字段都要有单行 `/** */` 注释**。不要用 `//` 行注释代替字段文档，前者不会被 IDE 悬浮提示采集。

```typescript
/** 终端会话配置 */
export interface TerminalSessionConfig {
  /** shell 命令（如 bash、powershell） */
  shellCommand: string;
  /** shell 启动参数 */
  shellArgs: string[];
  /** 工作目录，省略时用进程 cwd */
  cwd?: string;
  /** 初始列数 */
  cols: number;
  /** 初始行数 */
  rows: number;
}
```

字段含义有歧义时（单位、是否可空、默认值、取值范围）必须在注释里写明：

```typescript
/** WebSocket 心跳间隔（毫秒） */
heartbeatIntervalMs?: number;
```

类型别名同样要有注释：

```typescript
/** 终端面板展开状态标签 */
export type PanelState = 'collapsed' | 'expanding' | 'expanded' | 'collapsing';
```

### 1.3 类（必需）

类的 JSDoc 说明它的职责和设计取舍。设计上有多个要点时用列表展开，让后来者不必读完整个类才知道边界在哪。

```typescript
/**
 * 终端会话管理器：一个 pty 进程 + 一个 WebSocket 的生命周期绑定。
 *
 * 核心设计：
 * - pty 与 WebSocket 一一绑定，任一关闭时同时销毁另一个
 * - 数据双向转发：pty 输出 → WebSocket 帧，WebSocket 帧 → pty 输入
 * - 面板关闭不销毁会话（持久化），仅断开 WebSocket；重新打开时复用 pty
 */
export class TerminalSession {
```

构造函数参数用 `@param` 标注。公开的 getter 用单行注释说明取值时机：

```typescript
/** pty 进程是否仍存活；`spawn()` 之后可用 */
get isAlive(): boolean {
```

### 1.4 函数与方法（必需）

所有函数——包括 `private` 方法和模块内的辅助函数——都要有 JSDoc。公开 API 必须写全 `@param` 和 `@returns`；会抛错的写 `@throws`。

```typescript
/**
 * 解析快捷键字符串为可匹配的键位组合
 *
 * 快捷键格式："Ctrl+`" 或 "Cmd+Shift+P"（修饰键 + 主键，加号分隔）
 * 修饰键不区分大小写，主键区分（字母键转大写匹配 KeyboardEvent.key）。
 *
 * @param shortcut - 快捷键字符串
 * @returns 可与 KeyboardEvent 匹配的键位组合，解析失败返回 null
 */
export function parseShortcut(shortcut: string): ParsedShortcut | null {
```

一行就说得清的私有方法可以用单行 JSDoc：

```typescript
/** 断言 pty 进程仍然存活 */
private assertAlive(): void {
```

`@param` 用 ` - ` 连接参数名和说明，保持全仓库一致。

### 1.5 函数体内注释

关键步骤用编号注释串起流程，让人能顺着读完主干：

```typescript
// 1. 解析快捷键配置
// 2. 注册全局 keydown 监听器
// 3. 匹配命中时切换面板状态
```

以下三种情况**必须**写行内注释：

- **绕过常规做法的地方**——写清为什么

  ```typescript
  // 不用 pty.kill()：Windows 上 ConPTY 有时无法干净终止子进程
  // WebSocket 关闭码 1000 是正常关闭，不作为异常处理
  ```

- **与外部系统的契约**——写清对方的行为

  ```typescript
  // @lydell/node-pty 的 onData 回调在进程输出时触发，高频调用
  // xterm.js 的 write 接受 Uint8Array 或 string，二进制帧用 Uint8Array 更高效
  ```

- **空的 catch 块**——必须说明为什么可以忽略，不允许留空白 `catch {}`

  ```typescript
  } catch { /* 面板已卸载，写状态失败可忽略 */ }
  } catch { /* pty 已退出，销毁时再报错无意义 */ }
  ```

---

## 二、模块化

### 2.1 一个文件一个职责

文件名用 kebab-case，名字直接反映职责：`server-command.ts`、`shortcut.ts`。

单文件超过约 600 行就该考虑拆分。拆分沿职责边界切，不要按"太长了"随意切半。

### 2.2 分层与依赖方向

依赖必须单向向下，不允许反向或环形引用：

```
宿主半        index.ts（入口 + 路由分发 + pty 生命周期 + WebSocket 升级 + settings 集成）
持久化层      persistence.ts（SessionStore：日志落盘/清理、元数据读写、启动恢复）
平台适配层    platform.ts（PlatformAdapter 接口 + POSIX/Windows 适配器）
浏览器半      client.tsx（xterm 面板 + 多 tab + 快捷键 + 拖拽 + 剪贴板 + 自定义 Hooks）
常量          constants.ts（协议/尺寸/快捷键/环境变量/文件名常量）
工具函数      server-command.ts、shortcut.ts、logger.ts
```

依赖方向：`index.ts` 依赖 `constants.ts`、`platform.ts`、`persistence.ts`、`server-command.ts`、`logger.ts`；`persistence.ts` 依赖 `constants.ts` 与 `logger.ts`；`client.tsx` 依赖 `shortcut.ts` 与 `logger.ts`，独立运行在浏览器侧。两半经 WebSocket 通信，不直接 import。

### 2.3 导出约定

- 只用**命名导出**，不用 `export default`
- `src/index.ts` 是宿主半的对外入口（Cordis 插件 `apply`/`inject`/`name`）
- 内部辅助函数不导出；仅为测试而导出是不可接受的理由——测试走公开 API

```typescript
export { parseShortcut } from './shortcut.js';
export type { ParsedShortcut } from './shortcut.js';
```

### 2.4 导入约定

- `src/` 内的相对导入**一律带 `.js` 后缀**（ESM 要求），即使源文件是 `.ts`
- `tests/` 下的脚本用 `.ts` 后缀（靠 `allowImportingTsExtensions`）
- Node 内置模块带 `node:` 前缀：`node:fs`、`node:path`、`node:crypto`
- 只用于类型的导入写 `import type`
- 导入顺序：第三方 → Node 内置 → 本仓库模块
- 避免运行时动态 `import()`，除非确实要延迟加载重依赖并在注释里说明原因。本仓库唯一的例外是宿主半的 `@lydell/node-pty`：它带原生绑定，顶层静态导入一旦失败会让整个模块在求值期不可导入，懒加载把失败收敛到会话创建那一步

```typescript
// @lydell/node-pty 是上面那条的例外：懒加载，故不出现在导入块里
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { parseShortcut } from './shortcut.js';
import type { ParsedShortcut } from './shortcut.js';
```

### 2.5 状态封装

模块级可变状态只用于确实进程唯一的东西（配置缓存），且必须配套提供刷新/失效函数：

```typescript
let cachedConfig: TerminalConfig | undefined;

/** 刷新缓存（配置变更后调用） */
export function refreshConfig(): void {
  cachedConfig = undefined;
}
```

其余状态放进类的 `private` 字段。对外暴露只读视图，不要把可变引用递出去：

```typescript
get sessions(): readonly TerminalSession[] { return this._sessions; }
get currentSession(): TerminalSession | undefined {
  return this._currentIndex >= 0 ? this._sessions[this._currentIndex] : undefined;
}
```

---

## 三、类型安全

`tsconfig.json` 已开 `strict` + `noImplicitAny`，不要放宽。

- **不用 `any` 逃避类型**。第三方库确实缺类型时，在使用点就近断言并注释说明，不要让 `any` 顺着调用链扩散。
- **不用 `@ts-ignore`**；万不得已用 `@ts-expect-error` 并写明原因。
- **不用非空断言 `!` 绕过检查**，改用显式判断并抛出带上下文的错误。
- **可选属性用条件展开**，避免把 `undefined` 显式写进对象（配合 `exactOptionalPropertyTypes` 风格）：

  ```typescript
  ...(config.shellArgs ? { shellArgs: config.shellArgs } : {}),
  ...(config.cwd ? { cwd: config.cwd } : {}),
  ```

- **联合字面量优先于 enum**：`type PanelState = 'collapsed' | 'expanded'`
- **枚举值到配置的映射用 `Record` 收口**，新增成员时编译器会提醒补齐：

  ```typescript
  const SHELL_DEFAULTS: Record<NodeJS.Platform, string> = { /* ... */ };
  ```

### 3.1 外部数据必须校验

- **插件 Config 用 schemastery**（`@deepseek-ai/schemastery`，zod 风格 API；dsh loader 拒绝真 zod），全字段给 default（3.18 无 enum/optional API）
- **跨进程边界的其余数据**（WebSocket 消息帧、命令行输入）用校验函数与容错解析——解析失败要么明确报错要么明确降级，不静默吞掉
- **形状同步靠 `import type`**：宿主半与浏览器半共享的类型从公共模块类型导入，编译期强制同步，不手写第二份

---

## 四、错误处理

- **错误消息用中文**，且必须带定位信息：哪个会话、哪个路由、期望值与实际值。

  ```typescript
  throw new Error(`终端会话 ${sessionId} 启动失败：pty 进程立即退出，退出码 ${code}`);
  throw new TerminalError('SPAWN_FAILED', `shell 命令 ${shell} 不存在`, { sessionId });
  ```

- **需要携带错误码时定义专用错误类**，并设置 `name`：

  ```typescript
  /** 终端操作错误：保留错误码 */
  export class TerminalError extends Error {
    constructor(message: string, readonly code?: string) {
      super(message);
      this.name = 'TerminalError';
    }
  }
  ```

- **`catch (e: unknown)` 后统一归一化**，不要假设捕获到的是 `Error`：

  ```typescript
  const msg = error instanceof Error ? error.message : String(error);
  ```

- **资源释放用 `try/finally`**，失败路径也要清理 WebSocket 连接、pty 进程、定时器：

  ```typescript
  const pty = spawn(shell, args, opts);
  try {
    await setupWebSocket(pty, ws);
  } finally {
    pty.kill();
  }
  ```

- **后台定时器一律 `unref()`**，避免阻止进程退出：

  ```typescript
  this.heartbeat = setInterval(/* ... */, interval);
  this.heartbeat.unref();
  ```

- **有意忽略的 Promise 用 `void` 标注**，表明不是漏写 `await`：`void this.ready.catch(() => {});`

---

## 五、异步

- 一律 `async/await`，不写 `.then()` 链
- 包装回调式 API 时用 `new Promise`，并**同时处理 `error` 事件**，不要只接成功回调
- 事件监听器要成对清理，用 `once` 或在 `finally`/`cleanup` 里 `off`

  ```typescript
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => { pty.off('exit', onExit); ws.off('error', onError); };
    const onExit = (): void => { cleanup(); resolve(); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    pty.once('exit', onExit);
    ws.once('error', onError);
  });
  ```

- 超时用 `AbortSignal.timeout()` / `AbortSignal.any()`，不要自己搭 `setTimeout` 竞速
- 可取消的长操作接受可选 `signal?: AbortSignal` 参数，入口处 `signal?.throwIfAborted()`

---

## 六、命名与格式

| 对象 | 约定 | 示例 |
|---|---|---|
| 文件 | kebab-case | `server-command.ts` |
| 类 / 接口 / 类型 | PascalCase | `TerminalSession`、`ParsedShortcut` |
| 函数 / 变量 / 方法 | camelCase | `parseShortcut`、`createSession` |
| 模块级常量 | UPPER_SNAKE_CASE | `ROUTE_PREFIX`、`DEFAULT_COLS` |
| 私有字段 | camelCase；与 getter 同名时前缀 `_` | `private _state` + `get state()` |
| 布尔值 | `is`/`has`/`enabled` 前缀或后缀 | `isAlive`、`hasResize` |

- 缩进 2 空格，单引号，语句末加分号
- 数字字面量用下划线分隔：`30_000`、`64 * 1024`
- 用 `===`，不用 `==`
- 默认值用 `??`，不用 `||`（除了确实要把空串一起兜掉的场合）
- 显式写返回类型，包括 `: void`
- 提前 return / continue 收窄分支，避免深层嵌套
- **不要引入魔法数字**。超时、重试次数、终端尺寸都提成具名常量放文件顶部：

  ```typescript
  /** 默认终端列数 */
  const DEFAULT_COLS = 80;
  /** 默认终端行数 */
  const DEFAULT_ROWS = 24;
  ```

---

## 七、工程化约束

1. **插件形态必须构建。** dsh loader 经纯 ESM import 加载插件、不走 tsx，所以必须用 `scripts/build.ts` 产出 `lib/`（含 `index.js` + `client.js` + `xterm.css`）。`lib/` 纳入版本控制——**禁止声明生命周期脚本**（`prepare`/`postinstall` 等一概不加），pnpm 11 对声明了安装类脚本的 git-hosted 包直接报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，拦截只看 `package.json` 字段、不看脚本内容。选依赖同理——`@lydell/node-pty` 的 `package.json` 连 `scripts` 字段都不存在，pnpm 10/11/12 都不会对它做构建授权判断。构建由开发者手动 `pnpm run build`，产物随源码一起提交。
2. **改代码后跑类型检查**：`pnpm run typecheck`。不要让类型错误总数变多。
3. **新增运行时依赖必须写进 `package.json`**，版本锁定或用窄范围。`node_modules` 里有不等于已声明。
4. **协议与命名常量不可单方面修改**：路由前缀（`/api/dsh-remote-terminal`）、slash 命令名、插件 id 改动必须同步 cordis.patch.yml 与构建脚本，并在注释里标明兼容性影响。
5. **跨平台**：`@lydell/node-pty` 自动按平台选 ConPTY（Windows）或 openpty（POSIX），不需要手动处理平台差异。该包版本精确钉在 `1.1.0`（上游 `latest` 指向 beta），六个平台子包自带 N-API 二进制，安装期不编译。
6. **不落明文凭据**：日志和错误消息不打印密钥、口令内容。
7. **终端数据绝不进日志**：pty 输出与 WebSocket 数据帧是用户会话内容，不写日志。
8. **日志统一使用 `src/logger.ts` 的 `createLogger`**。不直接调用 `console.*`。
   每个模块在文件顶部创建日志器：`const log = createLogger('模块名');`，模块名用
   kebab-case 取自文件名（如 `'terminal-host'`、`'terminal-client'`）。级别语义：
   debug（开发排查）、info（关键流程节点）、warn（可恢复异常/降级）、error（不可恢复失败）。
   输出格式固定为 `[时间戳] [级别] [模块] 内容`，便于跨模块日志检索与过滤。
   Node 环境下 `console.info/warn/error` 默认输出到 stderr；浏览器端输出到 DevTools
   Console——两端 API 一致，无需环境判断。附加数据可选第二参数，自动 JSON 序列化。

   ```typescript
   import { createLogger } from './logger.js';
   const log = createLogger('terminal-host');
   log.info('创建会话', { id, cols, rows });
   log.error('持久化失败', err);
   ```

   **高频路径日志纪律**：WebSocket 消息转发、pty onData 等周期性代码路径中，
   只在状态变化时输出 info 日志；重复性诊断信息用 debug 级别。避免每条数据帧
   都输出日志。

---

## 八、提交信息

中文，一句话说清做了什么。修 bug 用 `修复:` 前缀，重构用 `重构:` 前缀。

```
feat: 添加多标签终端会话切换功能
修复: WebSocket 关闭时未清理 pty 导致进程泄漏
重构: 提取 shortcut.ts 独立快捷键解析模块
```
