/**
 * @file WebSocket 处理器模块
 * @description 从 index.ts 提取的 WebSocket 升级与消息处理逻辑。提供工厂函数
 *              {@link createWsHandlers}，接收运行时依赖（webServer、sessions Map、
 *              upgradeDisposers Map），返回 handleWsMessage / handleWsConnection /
 *              registerSessionWs 三个闭包函数。
 *
 *              同时导出 webServer 服务的最小接口类型（WebServerService、WebRouteDef、
 *              WebUpgradeRouteDef），供 index.ts 和 routes.ts 引用，避免重复定义。
 *
 * 安全约束：
 * - WebSocket 升级只走已鉴权通道（同源检查），未通过检查的连接直接 destroy
 * - 终端输出数据帧绝不写日志（用户会话内容）
 * - socket error 监听器必须在任何 destroy 之前挂上，未处理 error 事件会直接掀翻进程
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { ROUTE_PREFIX } from './constants.js';
import type { SessionRecord } from './persistence.js';

// —— webServer 类型定义（从 index.ts 提取，供多模块共享）——

/**
 * webServer 服务的最小接口（完整定义见 @deepseek-ai/dsh-host-webserver）。
 * @deepseek-ai/cordis 的公开类型可能不包含 webServer 属性，用局部 interface 扩展
 * Context，使 ctx.webServer.register/registerUpgrade 通过类型检查。
 */
export interface WebServerService {
  /** 注册命名路由（kind: 'exact'|'prefix'）；重复 (kind, path) 抛错 */
  register(route: WebRouteDef): () => void;
  /** 注册精确路径 HTTP 升级路由；重复路径抛错（一个 socket 只能有一个协议拥有者） */
  registerUpgrade(route: WebUpgradeRouteDef): () => void;
}

/** 一条命名路由定义 */
export interface WebRouteDef {
  /** 匹配方式：'exact' 精确匹配路径名；'prefix' 匹配 p 和 p/<anything> */
  kind: 'exact' | 'prefix';
  /** 绝对路径名，无尾斜杠 */
  path: string;
  /** 拥有完整响应生命周期（可 hold 住响应，如 SSE） */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** 一条精确路径 HTTP 升级路由定义 */
export interface WebUpgradeRouteDef {
  /** 绝对路径名，无尾斜杠 */
  path: string;
  /** 拥有协议协商和升级后的 socket 使用权 */
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}

// —— 同源检查工具（WS 升级路由使用）——

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

// —— 工厂函数 ——

/** WebSocket 处理器的依赖 */
export interface WsHandlerDeps {
  /** webServer 服务 */
  webServer: WebServerService;
  /** 会话 Map */
  sessions: Map<string, SessionRecord>;
  /** WS 路由 disposer Map */
  upgradeDisposers: Map<string, () => void>;
}

/** WebSocket 处理器集合 */
export interface WsHandlers {
  /** 处理一条 WebSocket 文本消息 */
  handleWsMessage: (session: SessionRecord, text: string) => void;
  /** 处理一条已升级的 WebSocket 连接 */
  handleWsConnection: (session: SessionRecord, ws: WebSocket) => void;
  /** 注册 per-session WebSocket 升级路由 */
  registerSessionWs: (id: string) => void;
}

/**
 * 创建 WebSocket 处理器集合。
 *
 * 将原先 apply() 闭包内的 handleWsMessage / handleWsConnection / registerSessionWs
 * 提取为独立工厂，通过参数对象注入运行时依赖，消除对闭包变量的隐式捕获。
 *
 * @param deps - 运行时依赖（webServer、sessions、upgradeDisposers）
 * @returns 三个闭包函数组成的处理器集合
 */
export function createWsHandlers(deps: WsHandlerDeps): WsHandlers {
  const { webServer, sessions, upgradeDisposers } = deps;

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

  return { handleWsMessage, handleWsConnection, registerSessionWs };
}
