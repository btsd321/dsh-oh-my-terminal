/**
 * @file 侧边栏终端 tab 组件（DSH-better-sidebar 兼容模式）
 * @description 当检测到 DSH-better-sidebar 已安装时，本插件不再注册
 *              `conversation.input.dock` 底部面板，改为通过
 *              `ctx.betterSidebar.registerTab()` 注册一个"终端"tab，
 *              嵌入 DSH-better-sidebar 的底部工作台。
 *
 *              本组件是该 tab 的内容渲染器：复用现有 hooks
 *              （useTerminalState/useConfig/useTerminalTabs），但与独立模式的
 *              TerminalPanel 有三处关键差异：
 *
 *              1. 不绑定 DSH sessionId——`useTerminalState(undefined)` 与
 *                 `useTerminalTabs` 的 sessionId 传 undefined，PTY session 的
 *                 ownerSessionId 为 null，不进入 DSH session 的 write handle
 *                 管理体系，从根源上消除与 DSH-better-sidebar 终端的 session 冲突
 *              2. 工作目录从 tab 接收的 scope.cwd 取值（DSH-better-sidebar
 *                 传入当前工作区路径），而非 useWorkspaces 查询
 *              3. 布局适配 tab 内容区：去掉折叠 bar 与拖拽调高（DSH-better-sidebar
 *                 底部工作台有自己的展开/折叠与 resize 控制），终端填满 tab 内容区
 *
 *              终端输入/输出数据绝不进日志。
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import {
  useTerminalState, useConfig, useTerminalTabs,
} from './hooks.js';
import { TermPane, RestartButton } from './term-pane.js';
import { DropdownMenu } from './dropdown.js';
import { SideList, instanceLabel } from './side-list.js';
import { Plus12 } from './icons.js';
import type { TabComponentPropsLike, BetterSidebarTabDescriptorLike } from './compat.js';
import { createLogger } from '../logger.js';

const log = createLogger('terminal-sidebar-tab');

/** 侧边栏终端 tab 在 + 菜单中的排序权重（排在内置 tab 之后） */
const SIDEBAR_TAB_ORDER = 40;

/**
 * 侧边栏终端 tab 内容组件。
 *
 * 复用独立模式 TerminalPanel 的核心 hooks，但适配 DSH-better-sidebar 底部
 * 工作台的 tab 内容区布局，且不绑定 DSH sessionId（防 write handle 冲突）。
 *
 * @param props - DSH-better-sidebar 注入的 tab 组件 props
 * @returns 终端 tab 内容根元素
 */
function TerminalSidebarTab(props: TabComponentPropsLike): ReactElement {
  const { scope, visible } = props;
  const { useEffect, useRef, useCallback } = React;

  /*
   * 兼容模式防冲突核心：sessionId 传 undefined。
   *
   * useTerminalState(undefined)：/sessions 恢复时不按 DSH 会话过滤（恢复全部
   * 存活终端）；useTerminalTabs 的 sessionId 为 undefined 时，POST /sessions
   * 不带 sessionId 字段，宿主半 createSession 的 ownerSessionId 为 null——
   * PTY session 完全由本插件独立管理，不进入 DSH session 的 write handle
   * 体系，从根源上消除与 DSH-better-sidebar 终端的 session 冲突。
   */
  const sessionId = undefined;

  /** 工作目录：从 tab 接收的 scope.cwd 取值（DSH-better-sidebar 传入工作区路径） */
  const workspaceCwd = scope.cwd;

  /* —— 侧边栏 tab 高度：填满 DSH-better-sidebar 底部工作台的 tab 内容区 ——
   * 不使用 usePanelHeight（拖拽调高）——底部工作台自带 resize 控制 */

  /** 根元素 ref */
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* —— 统一状态管理（useReducer 封装 + 不按会话过滤恢复） —— */
  const { state, dispatch } = useTerminalState(sessionId);
  const { instances, groups, activeInstanceId, busy, bootReady } = state;

  const activeInstance = instances.find(t => t.id === activeInstanceId) ?? null;
  const activeGroup = groups.find(g => g.instances.some(i => i.id === activeInstanceId)) ?? null;

  /* —— 终端 CRUD —— */
  const { newTab, closeTab, restartActive, splitTerminal, onExit } = useTerminalTabs({
    state, dispatch,
    activeInstance, activeGroup,
    workspaceCwd, sessionId,
  });

  /* —— 统一配置拉取（/config） —— */
  const { shortcutLabel, fontFamily, fontSize, lineHeight, terminalProfiles } = useConfig(
    /* setOpen 在侧边栏模式下无意义（展开/折叠由 DSH-better-sidebar 工作台控制），
     * 传一个空操作 setter 满足 useConfig 签名 */
    () => { /* 侧边栏模式下快捷键不切换面板 */ },
  );

  /** 首次可见已处理标记（只在首次可见时创建终端，避免每次切 tab 都新建） */
  const openHandled = useRef(false);

  /* 首次可见且无恢复的终端：创建一个会话。tab 切换隐藏→显示时不重复创建 */
  useEffect(() => {
    if (!visible) {
      openHandled.current = false;
      return;
    }
    if (!bootReady || instances.length > 0 || openHandled.current) return;
    openHandled.current = true;
    void newTab();
  }, [visible, bootReady, instances.length, newTab]);

  /** 状态标签 */
  const stateLabel = busy
    ? '启动中…'
    : activeInstance === null
      ? (instances.length === 0 ? '无会话' : '空闲')
      : (activeInstance.exited ? instanceLabel(activeInstance) + ' 已退出，点 ⟳ 重启' : instanceLabel(activeInstance));

  /**
   * 按配置 id 新建终端。
   *
   * 下拉菜单传进来的是配置 id，从 /config 下发的 terminalProfiles 里找到该配置，
   * 调用宿主半的 POST /sessions 新建终端。
   */
  const handleNewByType = useCallback((profileId: string): void => {
    const profile = terminalProfiles.find(p => p.id === profileId);
    if (profile === undefined) {
      log.warn(`未知的终端配置 id：${profileId}`);
      return;
    }
    void newTab(profile.id);
  }, [newTab, terminalProfiles]);

  /** 重命名终端实例 */
  const handleRename = useCallback((instanceId: string, newName: string): void => {
    dispatch({ type: 'RENAME_INSTANCE', id: instanceId, title: newName });
  }, [dispatch]);

  /** 选择终端实例（从右侧列表点击） */
  const handleSelectInstance = useCallback((instanceId: string): void => {
    dispatch({ type: 'SET_ACTIVE', id: instanceId });
  }, [dispatch]);

  /*
   * 侧边栏 tab 布局：填满 DSH-better-sidebar 底部工作台的 tab 内容区。
   * 不渲染折叠 bar 与拖拽 grip（工作台自带展开/折叠与 resize）。
   * 高度 100% 适配容器；内部用 flex 列布局：头部（固定高）+ Body（flex:1）。
   */
  return React.createElement(
    'div',
    {
      className: 'dshTermRoot dshTermSidebarRoot',
      ref: rootRef,
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      },
    },
    /* 头部：引导符 + 状态 + 右侧按钮组 */
    React.createElement(
      'div',
      { className: 'dshTermHeader', style: { flexShrink: 0 } },
      React.createElement('span', { className: 'dshTermHeaderState', title: stateLabel }, stateLabel),
      React.createElement(
        'div',
        { className: 'dshTermHeaderActions' },
        /* 新建组合按钮 */
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
            terminalProfiles,
            onNewByType: handleNewByType,
          }),
        ),
        /* 重启按钮 */
        React.createElement(RestartButton, { active: activeInstance, busy, onRestart: () => { void restartActive(); } }),
      ),
    ),
    /* Body：左侧终端显示区域 + 右侧终端列表 */
    React.createElement(
      'div',
      {
        className: 'dshTermBodyWithList',
        style: { flex: 1, minHeight: 0, overflow: 'hidden' },
      },
      /* 左侧终端显示区域 */
      React.createElement(
        'div',
        { className: 'dshTermTerminalArea' },
        ...groups.map(g => {
          if (g.instances.length === 1) {
            const inst = g.instances[0];
            return React.createElement(TermPane, {
              key: inst.id,
              instance: inst,
              active: inst.id === activeInstanceId,
              fontFamily,
              fontSize,
              lineHeight,
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
                    fontFamily,
                    fontSize,
                    lineHeight,
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
  );
}

/**
 * 创建侧边栏终端 tab 的描述符，供 DSH-better-sidebar 的 registerTab 注册。
 *
 * 描述符字段说明：
 * - id: 'dsh-oh-my-terminal'（与插件包名一致，避免与其他插件 tab 冲突）
 * - title: '终端'（中文，与独立模式 bar 标题一致）
 * - single: true（单实例 tab——打开时聚焦已有而非重复创建）
 * - order: 40（排在 DSH-better-sidebar 内置 tab 之后：editor 10 / git 20 / subagent 30 / sidechat 35）
 *
 * @returns tab 描述符
 */
export function createTerminalTabDescriptor(): BetterSidebarTabDescriptorLike {
  return {
    id: 'dsh-oh-my-terminal',
    title: () => '终端',
    order: SIDEBAR_TAB_ORDER,
    single: true,
    component: (props) => React.createElement(TerminalSidebarTab, props),
  };
}
