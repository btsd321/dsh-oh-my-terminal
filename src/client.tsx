/**
 * @file 远端终端插件浏览器半入口
 * @description 独立 dsh 插件 `dsh-oh-my-terminal` 的浏览器入口。在远端 dsh 页面的
 *              对话区底部注册终端面板（`conversation.input.dock` 槽），每个终端实例独立
 *              WebSocket 连接到一个 node-pty PTY 会话。支持多终端、拆分终端（Group）、
 *              快捷键切换、拖拽调高、会话恢复（dsh 重启后恢复历史）、可配置 shell 命令
 *              与终端种类选择。VSCode 风格右侧终端列表 + 下拉菜单。
 *              xterm.js 6 渲染，Campbell 暗色主题。
 *
 *              终端输入/输出数据绝不进日志。
 *
 * 架构对齐参考项目 dsh-plugin-terminal：
 * - node-pty PTY 替代 script 命令，原生 resize 支持
 * - WebSocket 实时双向通信替代 HTTP 轮询
 * - 底部固定面板（折叠态 34px bar，展开态向上生长）
 * - 拖拽 grip 调整高度（120px–78% 视口，localStorage 记忆）
 * - 快捷键切换（默认 Ctrl+`，从 /config 读取）
 * - 多终端：+ 新建、✕ 关闭、⟳ 重启；切终端不中断进程
 * - 拆分终端：同一 Group 内水平并排显示多个实例
 * - 右侧终端列表：垂直列表替代水平 tab 栏
 * - 下拉菜单：+号旁倒三角按钮弹出操作菜单
 * - 会话恢复：挂载时 GET /sessions 恢复所有终端（含已退出的历史）
 *
 * 模块结构（按关注点拆分到 src/client/ 子目录，消除 God Component）：
 * - `client/types.ts` — 共享类型定义（TerminalInstance, TerminalGroup, API 响应等）
 * - `client/icons.tsx` — SVG 图标组件集合
 * - `client/clipboard.ts` — 剪贴板纯函数（Async Clipboard API + legacy 回落）
 * - `client/dropdown.tsx` — +号旁下拉菜单组件
 * - `client/side-list.tsx` — 右侧终端列表面板组件
 * - `client/hooks.ts` — 自定义 Hooks（usePanelHeight/usePanelGeometry/useTerminalState/useConfig/useTerminalTabs）
 * - `client/styles.ts` — CSS 常量、Campbell 主题、PANEL_CSS、injectStyles()
 * - `client/term-pane.tsx` — TermPane（xterm + WebSocket 核心）、RestartButton
 * - 本文件保留：TerminalPanel（组合壳）、插件注册
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { Context } from '@deepseek-ai/cordis';
// 子模块导入——esbuild 打包浏览器 bundle 时内联进 client.js
import {
  TerminalGlyph14, TerminalGlyph12,
  ChevronUp14, ChevronDown14,
  Close14, Plus12,
} from './client/icons.js';
import { DropdownMenu } from './client/dropdown.js';
import { SideList, instanceLabel } from './client/side-list.js';
import {
  usePanelHeight, usePanelGeometry,
  useTerminalState, useConfig, useTerminalTabs,
} from './client/hooks.js';
import { injectStyles } from './client/styles.js';
import { TermPane, RestartButton } from './client/term-pane.js';
import { createLogger } from './logger.js';

const log = createLogger('terminal-client');

// —— 模块加载时幂等注入 CSS ——
injectStyles();

// —— dsh 客户端 slots 服务类型 ——
// dsh-client-ui-slots 与 dsh-client-ui-renderer 是 dsh 浏览器 bundle 运行期注入的
// 服务，非可安装的 npm 包。独立插件无法 import 它们的类型——用本地接口声明
// slots 服务的最小形状，使 ctx.slots.inject/register 通过类型检查。
// esbuild 打包浏览器 bundle 时这些类型声明整体擦除，运行期 slots 实例由 dsh 提供。

/** 槽位注册参数（dsh-client-ui-slots 的 SlotRegisterOptions 最小子集） */
interface SlotRegisterOptions {
  /** 槽位命名空间名 */
  name: string;
  /** 本条目 id（在同一槽内唯一） */
  id: string;
  /** 排序权重（小者先） */
  order: number;
}

/** slots 服务的最小接口（完整定义见 @deepseek-ai/dsh-client-ui-slots） */
interface SlotsService {
  /** 向指定槽位注入一个条目工厂 */
  inject(slot: string, factory: () => unknown): unknown;
  /** 注册一个槽位条目（返回 disposer） */
  register(options: SlotRegisterOptions, component: unknown): unknown;
}

/** 扩展了 slots 属性的 cordis 客户端上下文 */
interface ClientContext extends Context {
  /** dsh 浏览器端的 slots 服务——注入对话区底部面板槽 */
  slots: SlotsService;
}

// —— 插件注册壳 ——

/** 插件包名（与 index.ts 的 PKG_NAME 同值） */
export const name = 'dsh-oh-my-terminal';

/** 注入的 cordis 服务：仅需 slots（文案硬编码中文，不走 locale 服务） */
export const inject = ['slots'];

/**
 * 浏览器半激活入口：在对话区底部注册终端面板。
 *
 * @param ctx - 远端页面的 cordis 上下文
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'terminal', order: 10 },
    TerminalPanel,
  ));
}

// —— TerminalPanel 主组件 ——

/** TerminalPanel 的 props（从 dsh 框架 slot 系统注入） */
interface TerminalPanelProps {
  /** 当前 dsh 会话 id（SessionStandardProps，scope='session' 自动注入） */
  sessionId?: string;
  /** dsh 工作区状态选择器（GlobalStandardProps，所有 slot 自动注入） */
  useWorkspaces?: <T,>(selector: (s: unknown) => T) => T;
}

/**
 * VSCode 风格底部终端面板：折叠态 34px bar，展开态全宽可拖拽面板。
 * 展开态使用右侧终端列表替代水平 tab 栏，+号旁有下拉菜单支持拆分终端。
 * Ctrl+` 切换（默认，可配置）。高度跨刷新持久化。
 *
 * @param props - dsh 框架注入的 props
 * @returns 面板根元素
 */
function TerminalPanel(props: TerminalPanelProps): ReactElement {
  const { useEffect, useRef, useState, useCallback } = React;
  const { sessionId, useWorkspaces } = props ?? {};

  /** 面板是否展开 */
  const [open, setOpen] = useState(false);
  /*
   * 本面板挂载所在的 DSH 会话的工作区路径。通过 useWorkspaces（GlobalStandardProps）
   * 查找当前 sessionId 所属的工作区，取其 path 作为新终端的 cwd。
   *
   * 默认工作区（DSH 自动创建的 "默认工作区" / "Default Workspace"）强制不传 cwd，
   * 让宿主半兜底到用户家目录（~）——默认工作区的实际目录是 DSH 内部数据目录，
   * 不适合作为终端工作目录。中英文目录名都匹配。
   */
  const workspaceCwd = useWorkspaces?.((s: unknown) => {
    const state = s as { items?: Array<{ sessionIds?: string[]; path?: string }> };
    if (!Array.isArray(state?.items) || typeof sessionId !== 'string') return undefined;
    const ws = state.items.find(w => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId));
    if (typeof ws?.path !== 'string' || ws.path.length === 0) return undefined;
    // 默认工作区路径最后一段匹配中英文 → 不传 cwd，让宿主半用 ~
    const lastSegment = ws.path.replace(/[/\\]+$/, '').replace(/^.*[/\\]/, '');
    if (lastSegment === '默认工作区' || lastSegment.toLowerCase() === 'default workspace') return undefined;
    return ws.path;
  });

  /* —— 拖拽调高（高度 state + localStorage 持久化） —— */
  const { height, startResize } = usePanelHeight();

  /** 根元素 ref（测量几何用） */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /* —— 对话列几何测量 + scrollBody paddingBottom —— */
  const { geo } = usePanelGeometry(rootRef);

  /* —— 统一状态管理（useReducer 封装 + 按会话过滤恢复） —— */
  const { state, dispatch } = useTerminalState(sessionId);
  const { instances, groups, activeInstanceId, busy, bootReady } = state;

  const activeInstance = instances.find(t => t.id === activeInstanceId) ?? null;
  const activeGroup = groups.find(g => g.instances.some(i => i.id === activeInstanceId)) ?? null;

  /* —— 终端 CRUD（新建/关闭/重启/拆分/退出标记） —— */
  const { newTab, closeTab, restartActive, splitTerminal, onExit } = useTerminalTabs({
    state, dispatch,
    activeInstance, activeGroup,
    workspaceCwd, sessionId,
  });

  /* —— 统一配置拉取（/config：快捷键 + 终端种类，单次请求） + 全局 keydown 监听 —— */
  const { shortcutLabel, terminalTypes } = useConfig(setOpen);

  /** 首次打开已处理标记（关闭最后一个终端不自动新建，只有全新打开才建） */
  const openHandled = useRef(false);

  /* 首次打开且无恢复的终端：创建一个会话。openHandled 守卫使关闭最后一个终端
   * 不自动新建——只有全新打开才建。 */
  useEffect(() => {
    if (!open) {
      openHandled.current = false;
      return;
    }
    if (!bootReady || instances.length > 0 || openHandled.current) return;
    openHandled.current = true;
    void newTab();
  }, [open, bootReady, instances.length, newTab]);

  /** 切换展开/折叠 */
  const toggle = useCallback((): void => setOpen(v => !v), []);

  /** 状态标签（bar 与头部共用） */
  const stateLabel = busy
    ? '启动中…'
    : activeInstance === null
      ? (instances.length === 0 ? '无会话' : '空闲')
      : (activeInstance.exited ? instanceLabel(activeInstance) + ' 已退出，点 ⟳ 重启' : instanceLabel(activeInstance));

  /** 按种类新建终端 */
  const handleNewByType = useCallback((typeId: string): void => {
    void newTab(typeId);
  }, [newTab]);

  /** 重命名终端实例（更新本地 title） */
  const handleRename = useCallback((instanceId: string, newName: string): void => {
    dispatch({ type: 'RENAME_INSTANCE', id: instanceId, title: newName });
  }, [dispatch]);

  /** 选择终端实例（从右侧列表点击） */
  const handleSelectInstance = useCallback((instanceId: string): void => {
    dispatch({ type: 'SET_ACTIVE', id: instanceId });
  }, [dispatch]);

  return React.createElement(
    'div',
    {
      className: 'dshTermRoot',
      ref: rootRef,
      style: { left: geo.left + 'px', width: geo.width + 'px' },
    },
    open
      ? React.createElement(
        'div',
        { className: 'dshTermPanel', id: 'dshTermPanel', style: { height: height + 'px' } },
        React.createElement('div', {
          className: 'dshTermResize',
          title: '拖动调整高度',
          onPointerDown: startResize,
        }),
        /* 头部：引导符 + 状态(flex:1 撑满) + 右侧按钮组(margin-left:auto 右对齐) */
        React.createElement(
          'div',
          { className: 'dshTermHeader' },
          React.createElement('span', { className: 'dshTermHeaderLead', 'aria-hidden': true }, TerminalGlyph14()),
          React.createElement('span', { className: 'dshTermHeaderState', title: stateLabel }, stateLabel),
          /* 右侧按钮组：+号/下拉 + 重启 + 收起，统一右对齐 */
          React.createElement(
            'div',
            { className: 'dshTermHeaderActions' },
            /* 新建组合按钮：+ 主按钮 + 分隔线 + 下拉箭头 */
            React.createElement(
              'div',
              { className: 'dshTermNewWrap' },
              React.createElement(
                'button',
                {
                  className: 'dshTermNew',
                  title: '新建终端',
                  'aria-label': '新建终端',
                  disabled: busy,
                  onClick: () => { void newTab(); },
                },
                Plus12(),
              ),
              React.createElement('div', { className: 'dshTermNewSep' }),
              React.createElement(DropdownMenu, {
                busy,
                onNewTerminal: () => { void newTab(); },
                onSplitTerminal: () => { void splitTerminal(); },
                terminalTypes,
                onNewByType: handleNewByType,
              }),
            ),
            /* 重启对已退出历史终端也需可达 */
            React.createElement(RestartButton, { active: activeInstance, busy, onRestart: () => { void restartActive(); } }),
            React.createElement(
              'button',
              {
                className: 'dshTermCollapse',
                title: '收起面板（' + shortcutLabel + '）',
                'aria-label': '收起面板',
                onClick: toggle,
              },
              ChevronDown14(),
            ),
          ),
        ),
        /* Body：左侧终端显示区域 + 右侧终端列表 */
        React.createElement(
          'div',
          { className: 'dshTermBodyWithList' },
          /* 左侧终端显示区域 */
          React.createElement(
            'div',
            { className: 'dshTermTerminalArea' },
            /* 按组渲染终端实例 */
            ...groups.map(g => {
              if (g.instances.length === 1) {
                /* 单实例组：直接渲染 */
                const inst = g.instances[0];
                return React.createElement(TermPane, {
                  key: inst.id,
                  instance: inst,
                  active: inst.id === activeInstanceId,
                  onExit,
                });
              }
              /* 多实例组：水平并排 */
              return React.createElement(
                'div',
                { key: g.id, className: 'dshTermSplitGroup' },
                ...g.instances.flatMap((inst, idx) => {
                  const elements: ReactElement[] = [];
                  if (idx > 0) {
                    elements.push(React.createElement('div', { key: g.id + '-div-' + idx, className: 'dshTermSplitDivider' }));
                  }
                  elements.push(
                    React.createElement(
                      'div',
                      { key: inst.id, className: 'dshTermSplitPane' },
                      React.createElement(TermPane, {
                        instance: inst,
                        active: inst.id === activeInstanceId,
                        onExit,
                      }),
                    ),
                  );
                  return elements;
                }),
              );
            }),
            instances.length === 0
              ? React.createElement(
                'div',
                { className: 'dshTermEmpty' },
                React.createElement('span', null, '没有终端会话'),
                React.createElement(
                  'button',
                  { className: 'dshTermEmptyBtn', onClick: () => { void newTab(); } },
                  Plus12(),
                  '新建终端',
                ),
              )
              : null,
          ),
          /* 右侧终端列表（仅多于一个终端时显示） */
          instances.length > 1
            ? React.createElement(SideList, {
              groups,
              activeInstanceId,
              onSelect: handleSelectInstance,
              onClose: closeTab,
              onRename: handleRename,
            })
            : null,
        ),
      )
      : React.createElement(
        'div',
        {
          className: 'dshTermBar',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          'aria-controls': 'dshTermPanel',
          title: '终端面板（' + shortcutLabel + ' 切换）',
          onClick: toggle,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          },
        },
        React.createElement('span', { className: 'dshTermBarLead', 'aria-hidden': true }, TerminalGlyph14()),
        React.createElement('span', { className: 'dshTermBarTitle' }, '终端'),
        /* flex:1 spacer 把右侧按钮推到最右 */
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement(
          'span',
          { className: 'dshTermBarActions', onClick: (e: React.MouseEvent) => e.stopPropagation() },
          React.createElement(RestartButton, { active: activeInstance, busy, onRestart: () => { void restartActive(); } }),
        ),
        React.createElement('span', { className: 'dshTermBarChevron', 'aria-hidden': true }, ChevronUp14()),
      ),
  );
}

export { TerminalPanel };
