/**
 * @file DSH-better-sidebar 兼容模式检测模块
 * @description 当本插件与 DSH-better-sidebar 同时安装时，两者都会在底部区域管理终端，
 *              竞争同一个 DSH session 的 write handle，导致
 *              `session "xxx" is already owned by an active write handle` 报错。
 *
 *              本模块软探测 DSH-better-sidebar 发布的 `ctx.betterSidebar` 服务：
 *              命中时本插件切换为兼容模式——不再注册 `conversation.input.dock`
 *              底部面板，改为通过 `service.registerTab()` 注册"终端"tab 嵌入
 *              DSH-better-sidebar 的底部工作台。
 *
 *              兼容模式下 PTY session 绑定 scope.sessionId（ownerSessionId = scope.sessionId），
 *              实现每个工作区有自己的终端组——切换工作区时只恢复该工作区的终端。
 *              tab 模式不走 dock，不获取 DSH write handle，ownerSessionId 只是本插件
 *              元数据（用于 GET /sessions 按工作区过滤），不进入 DSH write handle 体系——
 *              从根源上消除两个终端插件的 session 冲突。
 *
 *              软探测模式与 shortcuts 服务接入（shortcut-bridge.ts）一致：
 *              不写入顶层 inject，旧宿主或未安装 DSH-better-sidebar 时降级为
 *              原有独立模式，面板功能不受影响。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ReactNode } from 'react';

// —— DSH-better-sidebar 服务的最小本地接口声明 ——
// DSH-better-sidebar 通过 ctx.provide('betterSidebar', service) 发布注册服务，
// 非 npm 包依赖——独立插件无法 import 它的类型。用本地接口声明其最小形状，
// 使 ctx.get('betterSidebar') 通过类型检查。esbuild 打包时整体擦除，运行期
// 服务实例由 DSH-better-sidebar 提供。

/** DSH-better-sidebar 的会话作用域（TabComponentProps.scope 的形状） */
export interface SessionScopeLike {
  /** 当前 DSH 会话 id */
  sessionId: string;
  /** 会话工作目录（可能缺省） */
  cwd?: string;
}

/** tab 组件接收的 props 子集（本插件实际消费的字段） */
export interface TabComponentPropsLike {
  /** cordis 客户端上下文 */
  ctx: Context;
  /** 会话作用域（含 sessionId 与 cwd） */
  scope: SessionScopeLike;
  /** 当前 tab 是否可见（面板展开且 tab 活跃） */
  visible: boolean;
  /** tab 记录（含 id/type/title） */
  tab: { id: string; type: string; title: string };
}

/** 注册 tab 时需提供的描述符（本插件用到的字段子集） */
export interface BetterSidebarTabDescriptorLike {
  /** tab 类型唯一 id（也是 SidebarTab.type 值） */
  id: string;
  /** tab 标题（字符串或返回字符串的函数） */
  title: string | (() => string);
  /** tab 图标（ReactNode 或返回 ReactNode 的函数） */
  icon?: ReactNode | ((size: number) => ReactNode);
  /** + 菜单排序权重（小者先） */
  order?: number;
  /** 单实例：true = 同类型只保留一个 tab */
  single?: boolean;
  /** tab 内容渲染组件 */
  component: (props: TabComponentPropsLike) => ReactNode;
  /**
   * tab 栏右侧操作区（v0.25.0+）：tab 激活时，返回的 ReactNode 渲染在 tab 栏
   * 右端（+ 按钮右侧、面板关闭按钮左侧，右对齐）。让 tab 把自己的工具栏直接
   * 放进 tab 标签条，不在内容区顶部单独渲染头部行。
   *
   * 签名与 DSH-better-sidebar 的 TabDescriptor.rightActions 一致：
   * `(ctx, scope, state) => ReactNode`，三个独立参数（不是 props 对象）。
   */
  rightActions?: (ctx: unknown, scope: SessionScopeLike, state: unknown) => ReactNode;
}

/** DSH-better-sidebar 注册服务的最小接口 */
export interface BetterSidebarServiceLike {
  /** 注册一个 tab 类型，返回注销函数 */
  registerTab(descriptor: BetterSidebarTabDescriptorLike): () => void;
  /**
   * 能力列表（v0.12.0+）：单调递增，能力只增不删。消费方用 includes 探测
   * 新能力是否可用，不可用时降级。本插件用 'rightActions' 探测 tab 栏
   * 右侧操作注入是否可用，不可用时回退到内容区顶部两层显示方案。
   */
  readonly features?: readonly string[];
}

/** DSH-better-sidebar 发布到 cordis 上下文的服务名 */
export const BETTER_SIDEBAR_SERVICE = 'betterSidebar';

/**
 * 软探测 DSH-better-sidebar 是否已安装并发布服务。
 *
 * 与 shortcuts 服务接入模式一致：不写入顶层 inject（硬依赖会让未安装
 * DSH-better-sidebar 的宿主上插件浏览器半直接不激活），用 ctx.get 软探测。
 * 命中时返回服务实例，未命中时返回 undefined（调用方降级为独立模式）。
 *
 * @param ctx - 远端页面的 cordis 上下文
 * @returns betterSidebar 服务实例，未安装时 undefined
 */
export function detectBetterSidebar(ctx: Context): BetterSidebarServiceLike | undefined {
  if (typeof ctx.get !== 'function') return undefined;
  const service = ctx.get(BETTER_SIDEBAR_SERVICE);
  if (service === undefined) return undefined;
  // 形状校验：只认有 registerTab 方法的对象，避免误判
  if (typeof (service as BetterSidebarServiceLike).registerTab !== 'function') return undefined;
  return service as BetterSidebarServiceLike;
}
