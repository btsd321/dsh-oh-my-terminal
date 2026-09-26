/**
 * @file HTTP 路由处理器模块
 * @description 从 index.ts 提取的 HTTP 前缀路由 handler 及其辅助函数。提供工厂函数
 *              {@link createRouteHandler}，接收运行时依赖（sessions、store、
 *              runtimeSettings、会话生命周期回调等），返回一个 async handler 供
 *              webServer.register 注册为 prefix 路由。
 *
 *              辅助函数 sameOrigin / json / readBody / clampInt / resolveSessionCwd /
 *              resolveSpawn / makeId 一并提取到本模块，它们是路由处理的纯工具函数，
 *              不依赖 apply() 闭包状态。
 *
 * 安全约束：
 * - 所有请求经同源检查（sameOrigin），跨源请求直接 403
 * - 终端数据绝不进日志——日志只记会话生命周期事件与 id
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { splitCommandLine, firstNonEmpty } from './server-command.js';
import { createLogger } from './logger.js';
import {
  ROUTE_PREFIX, PROTOCOL_VERSION,
  COLS_MIN, COLS_MAX, ROWS_MIN, ROWS_MAX, DEFAULT_COLS, DEFAULT_ROWS,
} from './constants.js';
import { platform } from './platform.js';
import type { SessionStore } from './persistence.js';
import type { SessionRecord } from './persistence.js';

const log = createLogger('terminal-host');

// —— 创建会话选项类型（与 index.ts createSession 参数对齐）——

/** 创建会话的参数 */
export interface CreateSessionOptions {
  /** 初始列数 */
  cols?: number;
  /** 初始行数 */
  rows?: number;
  /** 工作目录 */
  cwd?: string;
  /** 裸 shell 文件覆盖 */
  shell?: string;
  /** 完整命令行覆盖 */
  cmdline?: string;
  /** restart 继承的滚动缓冲 seed */
  seed?: string;
  /** 所属 DSH 会话 id（用于 workspaceRegistry 查工作区路径） */
  sessionId?: string;
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
 * 判断路径是否是 DSH 默认工作区目录。
 *
 * DSH 自动创建的默认工作区目录名固定为 "默认工作区"（中文）或 "Default Workspace"（英文），
 * 位于 Documents/deepseek-harness/ 下。该目录是 DSH 内部数据目录，不适合作为终端工作目录，
 * 终端应在用户家目录（~）启动。
 *
 * @param path - 待检查的路径
 * @returns 是否是默认工作区目录
 */
function isDefaultWorkspace(path: string): boolean {
  const lastSegment = path.replace(/[/\\]+$/, '').replace(/^.*[/\\]/, '');
  return lastSegment === '默认工作区' || lastSegment.toLowerCase() === 'default workspace';
}

/**
 * 解析会话工作目录：优先客户端传的 cwd → workspaceRegistry 查 sessionId → 用户家目录兜底。
 *
 * 默认工作区会话没有绑定具体项目目录，此时终端应在用户家目录（~）启动，
 * 而非 DSH 进程的 process.cwd()（可能是安装目录或其他非预期路径）。
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
  if (typeof cwd === 'string' && cwd.length > 0 && !isDefaultWorkspace(cwd)) candidates.push(cwd);
  if (typeof sessionId === 'string' && sessionId.length > 0 && workspaceRegistry !== undefined) {
    try {
      // workspaceRegistry.host.sessionPath(sessionId) 返回工作区路径——dsh-workspace 服务提供
      const reg = workspaceRegistry as { host?: { sessionPath?: (id: string) => string | undefined } };
      const path = reg.host?.sessionPath?.(sessionId);
      if (typeof path === 'string' && path.length > 0 && !isDefaultWorkspace(path)) candidates.push(path);
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
  // 兜底用用户家目录（~），而非 process.cwd()——默认工作区会话应在 ~ 下启动终端
  return homedir();
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

// —— xterm.css 读取 ——

import { readFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// —— 工厂函数 ——

/** 路由处理器的依赖 */
export interface RouteHandlerDeps {
  /** 会话 Map */
  sessions: Map<string, SessionRecord>;
  /** 持久化存储 */
  store: SessionStore;
  /** 运行时配置（快捷键 + shell 命令行） */
  runtimeSettings: { toggleShortcut: string; shellCommand: string; fontFamily: string; fontSize: number };
  /** 可选的 DSH 工作区注册表 */
  workspaceRegistry: unknown;
  /** 创建新会话 */
  createSession: (options: CreateSessionOptions) => Promise<SessionRecord>;
  /** 杀掉会话 PTY 进程 */
  killSession: (id: string) => boolean;
  /** 重启会话（继承滚动缓冲） */
  restartSession: (id: string, cwd?: string) => Promise<SessionRecord | undefined>;
  /** 注册 per-session WS 升级路由 */
  registerSessionWs: (id: string) => void;
  /** WS 路由 disposer Map（DELETE 时注销） */
  upgradeDisposers: Map<string, () => void>;
}

/**
 * 创建 HTTP 路由 handler。
 *
 * 将原先 apply() 内的大 async handler（含多个 if 分支处理不同路径）提取为
 * 独立工厂，通过参数对象注入运行时依赖。返回的 handler 可直接传给
 * webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })。
 *
 * @param deps - 运行时依赖
 * @returns async HTTP handler
 */
export function createRouteHandler(
  deps: RouteHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const {
    sessions, store, runtimeSettings, workspaceRegistry,
    createSession, killSession, restartSession, upgradeDisposers,
  } = deps;

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin rejected' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const rest = path.slice(ROUTE_PREFIX.length);
    const method = req.method ?? 'GET';

    try {
      // GET /sessions — 列出所有会话（含已退出的历史），支持 ?sessionId= 过滤
      if (rest === '/sessions' && method === 'GET') {
        const querySessionId = url.searchParams.get('sessionId');
        const filtered = querySessionId !== null
          ? [...sessions.values()].filter(s => s.ownerSessionId === querySessionId)
          : [...sessions.values()];
        json(res, 200, {
          sessions: filtered.map(s => ({
            id: s.id,
            title: s.title,
            shell: s.shell,
            cmdline: s.cmdline ?? null,
            cwd: s.cwd,
            exited: s.exited,
            bornAt: s.bornAt,
            ownerSessionId: s.ownerSessionId ?? null,
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
          fontFamily: runtimeSettings.fontFamily,
          fontSize: runtimeSettings.fontSize,
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
      // 「原生绑定不可用」与其它 500 并针对性提示（如引导重装插件）。
      // TerminalError 定义在 index.ts 中未导出，但错误对象的 code 属性仍可读取。
      const code = (error as { code?: string }).code;
      json(res, 500, { error: msg, ...(code !== undefined ? { code } : {}) });
    }
  };
}

/**
 * 获取当前会话计数器值（makeId 每次调用后自增）。
 * 供 index.ts createSession 构建会话标题时使用。
 *
 * @returns 当前计数器值
 */
function getSessionCounter(): number {
  return sessionCounter;
}

// —— 导出辅助函数（供 index.ts createSession 使用）——

export { makeId, getSessionCounter, resolveSpawn, resolveSessionCwd };
