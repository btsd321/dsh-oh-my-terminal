/**
 * @file 远端终端插件宿主半入口（运行在远端 dsh 进程内）
 * @description 独立 dsh 插件 `dsh-oh-my-terminal` 的宿主入口。用户通过
 *              `dsh plugin --profile web add dsh-oh-my-terminal` 安装本插件后，
 *              在远端 dsh 的 webServer 上注册 HTTP 前缀路由和 per-session WebSocket
 *              升级路由，用 node-pty（经 @lydell/node-pty 分发）管理 PTY shell
 *              会话。终端数据经 WebSocket
 *              实时双向传输（不经 SSH 通道）。支持会话持久化（dsh 重启后恢复历史
 *              tab）、可配置 shell 命令、终端种类选择接口。
 *
 *              独立插件形态（非合成包）：@lydell/node-pty 与 ws 是 package.json
 *              的正常依赖，pnpm install 时装进 node_modules；xterm.css 从
 *              node_modules 读取并 serve。node-pty 含平台原生绑定，采用运行期
 *              懒加载（见 loadPty），避免绑定缺失时整个插件入口不可导入。
 *
 *              职责拆分：协议/尺寸/快捷键/环境变量常量在 {@link module:constants}，
 *              平台适配器在 {@link module:platform}，会话持久化（日志落盘、
 *              元数据读写、启动恢复）在 {@link module:persistence}。本文件仅
 *              保留 cordis 插件壳、HTTP 路由分发、WebSocket 升级注册、settings
 *              集成与会话生命周期管理（create/kill/restart）。
 *
 * 通道拓扑：
 * ```
 * 远端页面 ──同源 Cookie 鉴权──▶ /api/dsh-remote-terminal/*（HTTP 路由）
 *   （浏览器）                     └─ /sessions（GET 列表/POST 创建/DELETE 删除）
 *                                  └─ /sessions/:id/restart（POST 重启，继承滚动缓冲）
 *                                  └─ /config（GET 插件配置 + 终端种类列表）
 *                                  └─ /xterm.css（GET xterm 样式表）
 *                               /api/dsh-remote-terminal/ws/<id>（WebSocket 升级路由）
 *                                  └─ 连接时回放 buffer → 实时 pty.onData → ws.send
 *                                  └─ 客户端纯文本 = stdin，{"type":"resize"} = resize
 *                                  └─ 同源检查（sameOrigin）
 * ```
 *
 * 终端输入/输出数据绝不进日志——日志只记会话生命周期事件（创建/退出/重启/删除）与 id。
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Context } from '@deepseek-ai/cordis';
// schemastery 是 dsh 的 peer 依赖；esbuild external 后运行期从 profile 解析。
// 用值导入——settings schema 注册需要运行时调用 z.string()/z.object()
import z from '@deepseek-ai/schemastery';
// WebSocket 需作为值导入：ws.readyState === WebSocket.OPEN 用到其静态常量
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
// 纯函数工具模块——宿主半与浏览器半共用（esbuild 打包浏览器 bundle 时内联）
import { splitCommandLine, firstNonEmpty } from './server-command.js';
import { createLogger } from './logger.js';
import {
  PKG_NAME, ROUTE_PREFIX, WS_PREFIX, PROTOCOL_VERSION,
  SCROLLBACK_CHARS, COLS_MIN, COLS_MAX, ROWS_MIN, ROWS_MAX, DEFAULT_COLS, DEFAULT_ROWS,
  DEFAULT_TOGGLE_SHORTCUT, ENV_TOGGLE_SHORTCUT, ENV_SHELL_COMMAND, ENV_DATA_DIR,
} from './constants.js';
import { platform } from './platform.js';
import { SessionStore } from './persistence.js';
import type { SessionRecord } from './persistence.js';

const log = createLogger('terminal-host');

// —— 原生绑定懒加载 ——

/**
 * 终端操作错误：保留错误码，便于路由层区分失败原因（如 PTY_UNAVAILABLE）。
 * 仅模块内部使用——loadPty 抛出、路由层 catch 后转 HTTP 响应，无外部消费者，故不导出
 * （type_script_style §2.3：内部辅助不导出，避免无谓扩大插件公开 API 面）。
 */
class TerminalError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

/** node-pty 模块类型（值与类型都从真实包解析，不手写第二份） */
type PtyModule = typeof import('@lydell/node-pty');

/** 已加载的 node-pty 模块缓存；undefined 表示尚未尝试加载 */
let ptyModule: PtyModule | undefined;

/**
 * 懒加载 node-pty 模块（@lydell/node-pty）。
 *
 * 为什么用运行时动态 import 而不在文件顶部静态导入：该包含平台原生绑定
 * （.node 二进制），静态导入会把绑定缺失的异常提前到 ESM 模块求值阶段，
 * 导致整个插件入口不可导入、dsh 报 "failed to import"、插件连 apply 都
 * 执行不到。改成按需加载后，绑定缺失降级为「创建会话时报错」，插件本身
 * 仍能正常启用（type_script_style.md 的动态 import 例外条款正是为此场景）。
 *
 * 加载成功后缓存模块引用。失败不额外缓存：Node 的 ESM 加载器本身会把求值
 * 失败的模块标记为 errored，后续 import 同一 specifier 直接以同一错误拒绝，
 * 因此重复调用不会产生额外开销，也不会因重试而误判为可用。
 *
 * @returns node-pty 模块
 * @throws TerminalError('PTY_UNAVAILABLE') 平台缺少预编译绑定或模块缺失
 */
async function loadPty(): Promise<PtyModule> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = await import('@lydell/node-pty');
    return ptyModule;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new TerminalError(
      `终端原生绑定加载失败（平台 ${process.platform}-${process.arch}）：` +
      `${msg}。该平台可能没有预编译二进制，请确认 @lydell/node-pty 的对应该平台子包已随依赖安装。`,
      'PTY_UNAVAILABLE',
    );
  }
}

// —— webServer 类型增广 ——

/**
 * webServer 服务的最小接口（完整定义见 @deepseek-ai/dsh-host-webserver）。
 * @deepseek-ai/cordis 的公开类型可能不包含 webServer 属性，用局部 interface 扩展
 * Context，使 ctx.webServer.register/registerUpgrade 通过类型检查。
 */
interface WebServerService {
  /** 注册命名路由（kind: 'exact'|'prefix'）；重复 (kind, path) 抛错 */
  register(route: WebRouteDef): () => void;
  /** 注册精确路径 HTTP 升级路由；重复路径抛错（一个 socket 只能有一个协议拥有者） */
  registerUpgrade(route: WebUpgradeRouteDef): () => void;
}

/** 一条命名路由定义 */
interface WebRouteDef {
  /** 匹配方式：'exact' 精确匹配路径名；'prefix' 匹配 p 和 p/<anything> */
  kind: 'exact' | 'prefix';
  /** 绝对路径名，无尾斜杠 */
  path: string;
  /** 拥有完整响应生命周期（可 hold 住响应，如 SSE） */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** 一条精确路径 HTTP 升级路由定义 */
interface WebUpgradeRouteDef {
  /** 绝对路径名，无尾斜杠 */
  path: string;
  /** 拥有协议协商和升级后的 socket 使用权 */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}

/** 扩展了 webServer 属性的 cordis 上下文 */
interface TerminalContext extends Context {
  /** 远端 dsh 的 HTTP/WebSocket 服务 */
  webServer: WebServerService;
}

/**
 * settings 服务的最小接口——收口原先 3 层 `as unknown as` 断言链。
 * register 注册 schema 并返回带 watch 的 scope；get 读取当前值。
 */
interface SettingsService {
  /** 注册命名空间配置 schema，返回可监听变更的 scope */
  register(ns: string, schema: unknown): { watch(cb: () => void): void };
  /** 读取命名空间当前值（未注册时 undefined） */
  get(ns: string): Record<string, unknown> | undefined;
}

// —— xterm.css 读取（独立插件从 node_modules 读取，替代合成包的 define 注入）——

/** 构建产物目录（lib/）——getXtermCss 在此找 xterm.css，找不到回退到 node_modules */
const PKG_DIR = dirname(fileURLToPath(import.meta.url));

/** xterm.css 内容缓存（首次读取后缓存，避免重复 IO） */
let xtermCssCache: string | undefined;

/**
 * 读取 xterm.css 内容。
 *
 * 独立插件形态不再用构建期 define 注入 CSS——改为从文件系统读取：
 * 1. 先找构建产物同级的 xterm.css（build.ts 从 node_modules 复制到 lib/）
 * 2. dev 流程（tsx 直跑 src/）回退读 node_modules 里的 @xterm/xterm/css/xterm.css
 * 3. 都找不到时返回空串（/xterm.css 路由返回 404）
 *
 * @returns xterm.css 文本内容
 */
function getXtermCss(): string {
  if (xtermCssCache !== undefined) return xtermCssCache;
  try {
    // 构建产物 lib/index.js 的同级目录有 xterm.css（build.ts 复制过去）
    xtermCssCache = readFileSync(pathJoin(PKG_DIR, 'xterm.css'), 'utf8');
  } catch {
    // dev 流程回退读 node_modules
    try {
      xtermCssCache = readFileSync(pathJoin(PKG_DIR, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8');
    } catch {
      xtermCssCache = '';
    }
  }
  return xtermCssCache;
}

// —— 辅助函数 ——

/**
 * 将整数钳制到 [min, max] 范围；非有限值回落 fallback。
 *
 * @param value - 输入值（可能是 number 或字符串）
 * @param min - 下限
 * @param max - 上限
 * @param fallback - 非法值时的回落
 * @returns 钳制后的整数
 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * 同源检查：拒绝跨源请求驱动终端。
 * DSH webserver 无鉴权设计，至少不让另一个 origin 挂到会话上。
 * 非浏览器客户端（curl）不发 Origin——放行。
 *
 * @param req - HTTP 请求
 * @returns 同源或非浏览器客户端时 true
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * JSON 响应快捷构造。
 *
 * @param res - HTTP 响应对象
 * @param status - 状态码
 * @param body - 可序列化对象
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 读取 POST 请求体并解析为 JSON 对象。body 过大或非 JSON 时返回空对象。
 *
 * @param req - HTTP 请求
 * @returns 解析后的字段字典
 */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    // 防止超大 body 耗尽内存
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 1_000_000) return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 会话 id 自增计数器 */
let sessionCounter = 0;

/**
 * 生成不可猜测的会话 id：可读计数器前缀 + crypto-random 后缀。
 * id 保密性不是安全边界（WS 路由已同源门控），随机后缀是对枚举的纵深防御。
 *
 * @returns 会话 id
 */
function makeId(): string {
  sessionCounter += 1;
  return `t${sessionCounter}-${randomUUID()}`;
}

/**
 * 解析会话工作目录：优先客户端传的 cwd → workspaceRegistry 查 sessionId → process.cwd() 兜底。
 *
 * @param cwd - 客户端传的工作目录
 * @param sessionId - 所属 DSH 会话 id（用于 workspaceRegistry 查工作区路径）
 * @param workspaceRegistry - 可选的 DSH 工作区注册表
 * @returns 解析后的工作目录
 */
function resolveSessionCwd(
  cwd: string | undefined,
  sessionId: string | undefined,
  workspaceRegistry: unknown,
): string {
  const candidates: string[] = [];
  if (typeof cwd === 'string' && cwd.length > 0) candidates.push(cwd);
  if (typeof sessionId === 'string' && sessionId.length > 0 && workspaceRegistry !== undefined) {
    try {
      // workspaceRegistry.host.sessionPath(sessionId) 返回工作区路径——dsh-workspace 服务提供
      const reg = workspaceRegistry as { host?: { sessionPath?: (id: string) => string | undefined } };
      const path = reg.host?.sessionPath?.(sessionId);
      if (typeof path === 'string' && path.length > 0) candidates.push(path);
    } catch {
      /* workspace 服务不存在或未就绪——降级到下一候选 */
    }
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* 路径缺失或不可访问——试下一候选 */
    }
  }
  return process.cwd();
}

/**
 * 解析 spawn 参数：从 shell/cmdline/settings 解析出 (file, args, cmdline)。
 *
 * 来源优先级（高到低）：
 * 1. shell——裸 shell 文件，per-request 覆盖（legacy API）
 * 2. cmdline——完整命令行（restart 重跑原命令）
 * 3. runtimeSettings.shellCommand——用户配置的命令行
 * 4. 平台默认（经 platform.detectDefaultShell()）
 *
 * 完整命令行原样使用（不注入平台特定标志）；裸 shell 文件经平台适配器构建参数。
 *
 * @param shell - 裸 shell 文件覆盖
 * @param cmdline - 完整命令行覆盖
 * @param runtimeShellCommand - settings 配置的命令行
 * @returns spawn 参数 + 生效命令行
 */
function resolveSpawn(
  shell: string | undefined,
  cmdline: string | undefined,
  runtimeShellCommand: string,
): { file: string; args: string[]; cmdline: string | null } {
  // 裸 shell 文件覆盖——经平台适配器构建参数（POSIX 加 -i，Windows 不加）
  const bare = firstNonEmpty(shell) ?? null;
  if (bare !== null) {
    const { file, args } = platform.buildBareSpawnArgs(bare);
    return { file, args, cmdline: null };
  }
  // 完整命令行（per-request 覆盖 > settings 配置）——原样拆分，不注入平台标志
  const full = firstNonEmpty(cmdline, runtimeShellCommand) ?? null;
  if (full !== null) {
    const parts = splitCommandLine(full);
    const file = parts[0] ?? platform.detectDefaultShell();
    return { file, args: parts.slice(1), cmdline: full };
  }
  // 平台默认——经平台适配器构建参数
  const file = platform.detectDefaultShell();
  const { args } = platform.buildBareSpawnArgs(file);
  return { file, args, cmdline: null };
}

// —— cordis 插件导出 ——

export const name = PKG_NAME;

/** 需要 webServer 服务（HTTP 路由 + WebSocket 升级路由） */
export const inject = ['webServer'];

/**
 * bundle 激活入口。
 *
 * @param ctx - 远端 dsh 的 cordis 上下文
 */
export function apply(ctx: Context): void {
  // webServer 服务可能不在 cordis 公开类型里——用局部 interface 扩展的 ctx2 访问
  const ctx2 = ctx as TerminalContext;
  // webServer 服务：注册 HTTP 前缀路由 + per-session WebSocket 升级路由
  const webServer = ctx2.webServer;

  /** 可选的 DSH workspace 注册表——权威的 session -> 工作区路径索引。
   *  无 dsh-workspace 的组合中不存在，cwd 解析降级到 process.cwd() */
  const workspaceRegistry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;

  /** 运行时配置：env（ops 覆盖）优先，随后被 settings 文档热更新（未设 env 时） */
  const runtimeSettings = {
    /** 展开/收起面板的快捷键 */
    toggleShortcut: process.env[ENV_TOGGLE_SHORTCUT] ?? DEFAULT_TOGGLE_SHORTCUT,
    /** 新终端的 shell 命令行（空 = 自动探测） */
    shellCommand: process.env[ENV_SHELL_COMMAND] ?? '',
  };

  // —— 可选 settings 集成：注册 schema 让 GUI 显示配置表单，编辑热应用到后续会话 ——
  // env 覆盖故意优先：ops 级覆盖不能被文档编辑静默覆盖
  ctx.inject(['settings'], (settingsCtx) => {
    // schemastery 的 z.string()/z.object()——z 是 Schemastery.Static（peer，dsh 提供）
    const schema = z.object({
      toggleShortcut: z.string()
        .description('展开/收起终端面板的快捷键。格式：修饰键+键，如 ctrl+` 或 ctrl+j（修饰键：ctrl, shift, alt, meta；键：字母、数字、F1-F12 或命名键如 `、space、enter）')
        .default(DEFAULT_TOGGLE_SHORTCUT),
      shellCommand: z.string()
        .description('新建终端使用的 shell 命令行，如 bash -l。留空自动探测平台 shell（$SHELL || /bin/bash）。仅应用于新建会话及其重启；已有会话保留其启动命令')
        .default(''),
    });
    const settingsNs = 'terminal';
    // 单次断言收口原先 3 层 as unknown as 断言链——后续用类型化变量操作
    const settings = (settingsCtx as unknown as { settings: SettingsService }).settings;
    const scope = settings.register(settingsNs, schema);
    const sync = (): void => {
      const value = settings.get(settingsNs);
      if (value === undefined) return;
      // env 未设时才接受文档值——env 是 ops 级覆盖，不能被文档编辑覆盖
      if (process.env[ENV_TOGGLE_SHORTCUT] === undefined && typeof value.toggleShortcut === 'string') {
        runtimeSettings.toggleShortcut = value.toggleShortcut;
      }
      if (process.env[ENV_SHELL_COMMAND] === undefined && typeof value.shellCommand === 'string') {
        runtimeSettings.shellCommand = value.shellCommand;
      }
    };
    sync();
    scope.watch(sync);
  });

  /** id -> 会话记录 */
  const sessions = new Map<string, SessionRecord>();
  /** id -> per-session WS 升级路由 disposer */
  const upgradeDisposers = new Map<string, () => void>();

  // —— 持久化目录与会话存储 ——
  // $DSH_HOME 由远端 dsh 设置为会话目录；缺失时回落 ~/.dsh
  const DATA_DIR = process.env[ENV_DATA_DIR]
    ?? pathJoin(process.env.DSH_HOME ?? pathJoin(homedir(), '.dsh'), 'plugin-data', 'terminal');
  const store = new SessionStore(DATA_DIR, sessions);

  /**
   * 处理一条 WebSocket 文本消息：纯文本 = stdin，JSON resize = 调整尺寸。
   *
   * @param session - 目标会话
   * @param text - 原始消息文本
   */
  function handleWsMessage(session: SessionRecord, text: string): void {
    if (session.exited || session.pty === null) return;
    if (text.startsWith('{"type":"resize"')) {
      try {
        const body = JSON.parse(text) as { cols?: number; rows?: number };
        if (typeof body.cols === 'number' && typeof body.rows === 'number') {
          session.pty.resize(body.cols, body.rows);
        }
      } catch {
        /* 忽略畸形 resize 消息 */
      }
    } else {
      session.pty.write(text);
    }
  }

  /**
   * 处理一条已升级的 WebSocket 连接：登记客户端 → 回放 buffer → 接收消息 →
   * 关闭/出错时移除客户端。
   *
   * @param session - 目标会话
   * @param ws - 已升级的 WebSocket 连接
   */
  function handleWsConnection(session: SessionRecord, ws: WebSocket): void {
    session.wsClients.add(ws);
    // 连接时回放历史 buffer
    if (session.buffer.length > 0) ws.send(session.buffer);
    // 已退出会话：回放后立即关闭
    if (session.exited) {
      ws.close(1000, 'session exited');
      return;
    }
    ws.on('message', (data) => handleWsMessage(session, String(data)));
    ws.on('close', () => session.wsClients.delete(ws));
    ws.on('error', () => session.wsClients.delete(ws));
  }

  /**
   * 注册 per-session WebSocket 升级路由。
   * 活跃会话流式传输 + 接受输入；已退出/已恢复会话回放 buffer 后关闭。
   *
   * @param id - 会话 id
   */
  function registerSessionWs(id: string): void {
    upgradeDisposers.set(id, webServer.registerUpgrade({
      path: `${ROUTE_PREFIX}/ws/${id}`,
      handler(req: IncomingMessage, socket: Duplex, head: Buffer): void {
        // 同源门控：DSH webserver 无鉴权设计，跨源页面绝不能挂到会话上。
        // 浏览器 WS 握手必发 Origin；非浏览器客户端（curl）不发——放行。
        // 在会话存在性探测之前检查——路由不向跨源调用者暴露 id 是否存在。
        if (!sameOrigin(req)) {
          socket.destroy();
          return;
        }
        const session = sessions.get(id);
        if (session === undefined) {
          socket.destroy();
          return;
        }
        const wss = new WebSocketServer({ noServer: true });
        wss.on('connection', (ws: WebSocket) => handleWsConnection(session, ws));
        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => wss.emit('connection', ws, req));
      },
    }));
  }

  /**
   * 创建新终端会话。
   *
   * 流程：解析 spawn 参数 → 解析 cwd → pty spawn → 登记记录 → 注册 WS 路由 →
   *       持久化元数据 → 挂 onData/onExit 回调
   *
   * @param options - 创建参数
   * @returns 会话记录
   * @throws TerminalError('PTY_UNAVAILABLE') 原生绑定不可用（平台缺预编译二进制）
   */
  async function createSession(options: {
    cols?: number;
    rows?: number;
    cwd?: string;
    shell?: string;
    cmdline?: string;
    seed?: string;
    sessionId?: string;
  }): Promise<SessionRecord> {
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const { file, args, cmdline: effectiveCmdline } = resolveSpawn(
      options.shell, options.cmdline, runtimeSettings.shellCommand,
    );
    const id = makeId();
    const sessionCwd = resolveSessionCwd(options.cwd, options.sessionId, workspaceRegistry);

    // 懒加载原生绑定：失败时抛 TerminalError，由路由层转成 HTTP 500 中文提示
    const { spawn } = await loadPty();

    const pty = spawn(file, args, {
      name: platform.ptyName,
      cols,
      rows,
      cwd: sessionCwd,
      env: platform.buildSessionEnv(),
    });

    const record: SessionRecord = {
      id,
      pty,
      shell: file,
      cmdline: effectiveCmdline,
      title: `${file.replace(/^.*[/\\]/, '')} #${sessionCounter}`,
      cwd: sessionCwd,
      // seed: restart 继承的滚动缓冲——连接时回放 + 预写入新会话日志
      buffer: (options.seed ?? '').slice(-SCROLLBACK_CHARS),
      exited: false,
      exitDetail: null,
      wsClients: new Set(),
      bornAt: Date.now(),
    };

    // seed 预写入日志文件（覆盖写；流式追加由 queueLog 负责）
    if (record.buffer.length > 0) {
      store.writeSeed(id, record.buffer);
    }

    sessions.set(id, record);
    registerSessionWs(id);
    store.persistMeta();

    log.info(`创建会话 ${id}（${file}，${cols}x${rows}，cwd=${sessionCwd}）`);

    // onData → 追加 buffer（截断到 SCROLLBACK_CHARS）+ 落盘 + ws.send
    pty.onData((data) => {
      if (record.dead) return; // restarted：旧 pty 可能还在吐几帧
      record.buffer = (record.buffer + data).slice(-SCROLLBACK_CHARS);
      store.queueLog(record, data);
      for (const ws of record.wsClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      }
    });

    // onExit → 标记 exited + 持久化 + 关闭所有 WS 客户端
    pty.onExit(({ exitCode }) => {
      record.exited = true;
      record.exitDetail = exitCode;
      if (!record.dead) {
        store.flushLog(record);
        store.persistMeta();
      }
      log.info(`会话 ${id} 已退出（code ${exitCode}）`);
      for (const ws of record.wsClients) {
        try {
          ws.close(1000, 'session exited');
        } catch {
          /* 忽略关闭失败 */
        }
      }
      record.wsClients.clear();
      // 保留已退出记录作为可重启/可回放历史；仅显式 DELETE 或插件销毁时移除
    });

    return record;
  }

  /**
   * 杀掉会话的 PTY 进程。
   *
   * @param id - 会话 id
   * @returns true=会话存在并已尝试杀
   */
  function killSession(id: string): boolean {
    const record = sessions.get(id);
    if (record === undefined) return false;
    try {
      record.pty?.kill();
    } catch {
      /* 进程已退出——忽略 */
    }
    return true;
  }

  /**
   * 重启会话：读旧 buffer 作为 seed → 杀旧 pty → 创建新会话（继承滚动缓冲）。
   *
   * @param id - 旧会话 id
   * @param cwd - 可选的新工作目录（未传时继承旧会话的）
   * @returns 新会话记录
   */
  async function restartSession(id: string, cwd?: string): Promise<SessionRecord | undefined> {
    const old = sessions.get(id);
    if (old === undefined) return undefined;
    const seed = old.buffer;
    const file = old.shell;
    const requestedCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : old.cwd;

    // 先 detach 旧会话：标记 dead + 清 pending，防止异步 onExit/onData 帧复活日志文件
    store.detachForRestart(old);
    try {
      old.pty?.kill();
    } catch {
      /* 已退出——忽略 */
    }

    // 注销旧 WS 路由 + 删除旧记录 + 删旧日志
    const dispose = upgradeDisposers.get(id);
    if (dispose !== undefined) {
      dispose();
      upgradeDisposers.delete(id);
    }
    sessions.delete(id);
    store.deleteLogFile(id);

    log.info(`重启会话 ${id}（继承 ${seed.length} 字符缓冲）`);

    // 创建新会话——有 cmdline 时重跑原命令，否则用裸 shell 文件
    const fresh = await createSession({
      ...(typeof old.cmdline === 'string' && old.cmdline.length > 0 ? { cmdline: old.cmdline } : { shell: file }),
      cwd: requestedCwd,
      seed,
    });
    return fresh;
  }

  // —— 启动时恢复持久化会话（已退出历史 tab）——
  store.loadPersisted(registerSessionWs);

  // —— HTTP 前缀路由注册 ——
  const disposeRoute = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    async handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (!sameOrigin(req)) {
        json(res, 403, { error: 'cross-origin rejected' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      const rest = path.slice(ROUTE_PREFIX.length);
      const method = req.method ?? 'GET';

      try {
        // GET /sessions — 列出所有会话（含已退出的历史）
        if (rest === '/sessions' && method === 'GET') {
          json(res, 200, {
            sessions: [...sessions.values()].map(s => ({
              id: s.id,
              title: s.title,
              shell: s.shell,
              cmdline: s.cmdline ?? null,
              cwd: s.cwd,
              exited: s.exited,
              bornAt: s.bornAt,
            })),
          });
          return;
        }

        // POST /sessions — 创建新终端会话
        if (rest === '/sessions' && method === 'POST') {
          const body = await readBody(req);
          const record = await createSession({
            cols: clampInt(body.cols, COLS_MIN, COLS_MAX, DEFAULT_COLS),
            rows: clampInt(body.rows, ROWS_MIN, ROWS_MAX, DEFAULT_ROWS),
            cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
            shell: typeof body.shell === 'string' ? body.shell : undefined,
            cmdline: typeof body.cmdline === 'string' ? body.cmdline : undefined,
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          });
          json(res, 200, { id: record.id, title: record.title, shell: record.shell, cwd: record.cwd });
          return;
        }

        // GET /config — 插件配置（含终端种类列表）
        if (rest === '/config' && method === 'GET') {
          json(res, 200, {
            toggleShortcut: runtimeSettings.toggleShortcut,
            shellCommand: runtimeSettings.shellCommand,
            terminalTypes: platform.builtinTerminalTypes,
            protocolVersion: PROTOCOL_VERSION,
          });
          return;
        }

        // GET /xterm.css — xterm 样式表（从 node_modules 读取 serve）
        if (rest === '/xterm.css' && method === 'GET') {
          const css = getXtermCss();
          if (css.length === 0) {
            json(res, 404, { error: 'xterm.css not found' });
            return;
          }
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
          res.end(css);
          return;
        }

        // /sessions/:id 和 /sessions/:id/restart 路由
        const match = rest.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
        if (match === null) {
          json(res, 404, { error: 'not found' });
          return;
        }
        const id = match[1] ?? '';
        const action = match[2] ?? '';
        const record = sessions.get(id);
        if (record === undefined) {
          json(res, 404, { error: 'no such session' });
          return;
        }

        // DELETE /sessions/:id — 杀进程 + 清持久化
        if (action === '' && method === 'DELETE') {
          killSession(id);
          // 注销 WS 路由
          const dispose = upgradeDisposers.get(id);
          if (dispose !== undefined) {
            dispose();
            upgradeDisposers.delete(id);
          }
          store.forgetSession(id);
          log.info(`删除会话 ${id}`);
          json(res, 200, { ok: true });
          return;
        }

        // POST /sessions/:id/restart — 重启（继承滚动缓冲）
        if (action === 'restart' && method === 'POST') {
          const body = await readBody(req);
          const fresh = await restartSession(id, typeof body.cwd === 'string' ? body.cwd : undefined);
          if (fresh === undefined) {
            json(res, 404, { error: 'no such session' });
            return;
          }
          json(res, 200, { id: fresh.id, title: fresh.title, shell: fresh.shell, cwd: fresh.cwd });
          return;
        }

        json(res, 404, { error: 'not found' });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // TerminalError 携带错误码（如 PTY_UNAVAILABLE）——一并返回，便于前端区分
        // 「原生绑定不可用」与其它 500 并针对性提示（如引导重装插件）。TerminalError
        // 未导出，但同模块内仍可 instanceof 判断并读取其 code 字段。
        const code = error instanceof TerminalError ? error.code : undefined;
        json(res, 500, { error: msg, ...(code !== undefined ? { code } : {}) });
      }
    },
  });

  // —— 插件销毁清理 ——
  ctx.effect(() => {
    return (): void => {
      disposeRoute();
      for (const [, dispose] of upgradeDisposers) dispose();
      upgradeDisposers.clear();
      for (const id of [...sessions.keys()]) killSession(id);
    };
  }, PKG_NAME + '.routes');

  log.info(`宿主半已激活；路由前缀 ${ROUTE_PREFIX}，WS 前缀 ${WS_PREFIX}，快捷键 ${runtimeSettings.toggleShortcut}，shell ${runtimeSettings.shellCommand || '(自动)'}`);
}
