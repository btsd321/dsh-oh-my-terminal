/**
 * @file WebSocket 处理器模块
 * @description 从 index.ts 提取的 WebSocket 升级与消息处理逻辑。提供工厂函数
 *              {@link createWsHandlers}，接收运行时依赖（webServer、sessions Map、
 *              upgradeDisposers Map），返回 handleWsMessage / handleWsConnection /
 *              registerSessionWs 三个闭包函数。
 *
 *              webServer 服务的路由与升级路由类型直接采用官方
 *              @deepseek-ai/dsh-host-webserver（0.1.7-rc.2，devDependencies 提供
 *              类型源）并 re-export 供 index.ts 等模块共享——import type 构建
 *              期擦除，插件产物不携带对该包的运行时引用，运行期由宿主提供
 *              webServer 服务实例。官方 d.ts 同时声明 cordis Context 的
 *              webServer 属性增强（augmentation），index.ts 据此直接访问
 *              ctx.webServer，无需本地 interface 扩展。
 *
 * 安全约束：
 * - WebSocket 升级只走已鉴权通道（同源检查），未通过检查的连接直接 destroy
 * - 终端输出数据帧绝不写日志（用户会话内容）
 * - socket error 监听器必须在任何 destroy 之前挂上，未处理 error 事件会直接掀翻进程
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
// import type：构建期擦除（esbuild 对 import type 100% 剔除），宿主半构建的
// external @deepseek-ai/* 双保险——运行期服务实例由 dsh 宿主提供
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver';
import { WebSocketServer, WebSocket } from 'ws';
import { ROUTE_PREFIX } from './constants.js';
import type { SessionRecord } from './persistence.js';

// —— webServer 类型（官方定义，re-export 供多模块共享）——

export type { WebServer, WebRoute, WebUpgradeRoute };

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
  /** webServer 服务（官方 @deepseek-ai/dsh-host-webserver 的 WebServer 类型） */
  webServer: WebServer;
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
