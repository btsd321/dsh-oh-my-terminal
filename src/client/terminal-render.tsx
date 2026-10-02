/**
 * @file 终端组渲染共享模块
 * @description 提取独立模式（TerminalPanel）与兼容模式（TerminalSidebarTab）共享的
 *              终端组渲染逻辑——按组渲染终端实例（单实例直接渲染、多实例水平并排），
 *              消除两处逐字复制的 41 行渲染代码（DRY）。
 *
 *              同时提供 findProfile 工具函数，消除 handleNewByType 在三处组件中
 *              重复定义的查找逻辑。
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import { TermPane } from './term-pane.js';
import { SplitGroup } from './split-group.js';
import type { TerminalGroup, TerminalInstance } from './types.js';
import type { TerminalProfile } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('terminal-render');

/** 终端渲染所需的样式参数 */
export interface TerminalRenderParams {
  /** 当前活跃终端实例 id（用于高亮） */
  activeInstanceId: string | null;
  /** 终端字体族（CSS font-family） */
  fontFamily: string;
  /** 终端字号（像素） */
  fontSize: number | undefined;
  /** 终端行高倍数 */
  lineHeight: number | undefined;
  /** WebSocket close 事件回调（标记实例已退出） */
  onExit: (id: string) => void;
}

/**
 * 渲染终端组列表——单实例组直接渲染 TermPane，多实例组水平并排。
 *
 * 独立模式（client.tsx TerminalPanel）与兼容模式（sidebar-tab.tsx TerminalSidebarTab）
 * 共用此函数，消除逐字复制的渲染代码（DRY）。
 *
 * @param groups - 终端组列表
 * @param params - 渲染参数（活跃 id + 样式 + 回调）
 * @returns ReactNode 数组（可直接展开到父容器的 children）
 */
export function renderTerminalGroups(
  groups: TerminalGroup[],
  params: TerminalRenderParams,
): ReactElement[] {
  const { activeInstanceId, fontFamily, fontSize, lineHeight, onExit } = params;
  return groups.map(g => {
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
    /* 多实例组：用 SplitGroup（SplitView + Sash 拖拽）管理 pane 尺寸 */
    return React.createElement(SplitGroup, {
      key: g.id,
      instances: g.instances,
      activeInstanceId,
      fontFamily,
      fontSize,
      lineHeight,
      onExit,
    });
  });
}

/**
 * 按配置 id 查找终端配置——未找到时 warn 日志并返回 undefined。
 *
 * 消除 handleNewByType 在三个组件中重复的查找 + 日志逻辑（DRY）。
 *
 * @param terminalProfiles - /config 下发的终端配置表
 * @param profileId - 配置 id
 * @returns 配置实例，未找到时 undefined
 */
export function findProfile(
  terminalProfiles: TerminalProfile[],
  profileId: string,
): TerminalProfile | undefined {
  const profile = terminalProfiles.find(p => p.id === profileId);
  if (profile === undefined) {
    log.warn(`未知的终端配置 id：${profileId}`);
  }
  return profile;
}

/**
 * 查找活跃终端实例。
 *
 * 消除两处组件重复的 `instances.find(t => t.id === activeInstanceId) ?? null`。
 *
 * @param instances - 终端实例列表
 * @param activeInstanceId - 活跃实例 id
 * @returns 活跃实例，无时 null
 */
export function findActiveInstance(
  instances: TerminalInstance[],
  activeInstanceId: string | null,
): TerminalInstance | null {
  if (activeInstanceId === null) return null;
  return instances.find(t => t.id === activeInstanceId) ?? null;
}

/**
 * 查找活跃终端组。
 *
 * 消除两处组件重复的 `groups.find(g => g.instances.some(i => i.id === activeInstanceId)) ?? null`。
 *
 * @param groups - 终端组列表
 * @param activeInstanceId - 活跃实例 id
 * @returns 活跃组，无时 null
 */
export function findActiveGroup(
  groups: TerminalGroup[],
  activeInstanceId: string | null,
): TerminalGroup | null {
  if (activeInstanceId === null) return null;
  return groups.find(g => g.instances.some(i => i.id === activeInstanceId)) ?? null;
}
