/**
 * @file 终端列表面板组件
 * @description 右侧终端列表面板，垂直展示所有终端实例并按组显示树形拆分前缀。
 *              支持点击切换活跃终端、中键关闭、活跃高亮与已退出样式。
 *              纯渲染组件，通过 props 回调与父组件通信，不包含任何状态管理逻辑。
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { TerminalInstance, TerminalGroup } from './types.js';
import { TerminalGlyph12, Close14 } from './icons.js';

// —— 辅助函数 ——

/**
 * 把 shell 完整路径取文件名并去掉 .exe 后缀，做显示用。
 *
 * @param s - shell 路径或名称（可能为 undefined）
 * @returns 处理后的 shell 显示名
 */
function prettyShell(s: string | undefined): string {
  const base = (s ?? 'shell').replace(/^.*[/\\]/, '');
  return base.replace(/\.exe$/i, '');
}

/**
 * 生成终端实例标签：服务端 title 形如 "pwsh.exe #3" → 显示 "pwsh 3"。
 *
 * @param inst - 终端实例
 * @returns 显示标签字符串
 */
export function instanceLabel(inst: TerminalInstance): string {
  const m = /#(\d+)$/.exec(inst.title ?? '');
  const base = prettyShell(inst.shell);
  return m === null ? base : base + ' ' + m[1];
}

// —— SideList 组件 ——

/** SideList 的 props */
export interface SideListProps {
  /** 终端组列表 */
  groups: TerminalGroup[];
  /** 当前全局活跃实例 id */
  activeInstanceId: string | null;
  /** 切换活跃实例回调 */
  onSelect: (instanceId: string) => void;
  /** 关闭终端回调 */
  onClose: (instanceId: string) => void;
}

/** 树形前缀字符映射 */
const PREFIX_FIRST = '\u250C';   // ┌
const PREFIX_MIDDLE = '\u251C';  // ├
const PREFIX_LAST = '\u2514';    // └

/**
 * 获取实例在组内的树形前缀字符。
 *
 * 单独一个实例无前缀；多个实例时按位置返回 ┌/├/└。
 *
 * @param index - 实例在组内的索引
 * @param total - 组内实例总数
 * @returns 前缀字符，单独实例返回空串
 */
function treePrefix(index: number, total: number): string {
  if (total <= 1) return '';
  if (index === 0) return PREFIX_FIRST;
  if (index === total - 1) return PREFIX_LAST;
  return PREFIX_MIDDLE;
}

/**
 * 右侧终端列表面板：垂直展示所有终端实例，同组实例用树形前缀表示拆分关系。
 *
 * 交互：
 * - 左键点击切换活跃终端
 * - 中键点击（button === 1）关闭终端
 * - hover 显示关闭按钮
 *
 * @param props - 列表 props
 * @returns 列表面板根元素
 */
export function SideList(props: SideListProps): ReactElement {
  const { groups, activeInstanceId, onSelect, onClose } = props;

  /**
   * 处理列表项鼠标按下事件：中键关闭终端。
   *
   * @param e - 鼠标事件
   * @param instanceId - 终端实例 id
   */
  const handleMouseDown = (e: React.MouseEvent, instanceId: string): void => {
    // 中键（button === 1）关闭终端
    if (e.button === 1) {
      e.preventDefault();
      onClose(instanceId);
    }
  };

  /**
   * 渲染单个终端列表项。
   *
   * @param inst - 终端实例
   * @param prefix - 树形前缀字符
   * @returns 列表项元素
   */
  const renderItem = (inst: TerminalInstance, prefix: string): ReactElement => {
    const isActive = inst.id === activeInstanceId;
    const isExited = inst.exited;
    const label = instanceLabel(inst);

    // 拼接 CSS 类名
    let className = 'dshTermSideItem';
    if (isActive) className += ' isActive';
    if (isExited) className += ' isExited';

    return React.createElement(
      'div',
      {
        key: inst.id,
        className,
        title: label,
        onMouseDown: (e: React.MouseEvent) => handleMouseDown(e, inst.id),
        onClick: () => onSelect(inst.id),
      },
      // 终端图标
      React.createElement('span', { className: 'dshTermSideItemIcon', 'aria-hidden': true },
        TerminalGlyph12(),
      ),
      // 树形前缀（仅多实例组显示）
      prefix.length > 0
        ? React.createElement('span', { className: 'dshTermSideItemPrefix' }, prefix)
        : null,
      // 名称标签
      React.createElement('span', { className: 'dshTermSideItemLabel' }, label),
      // 关闭按钮（默认隐藏，hover 经 CSS 显示）
      React.createElement(
        'span',
        {
          className: 'dshTermSideItemClose',
          role: 'button',
          title: '关闭 ' + label,
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation();
            onClose(inst.id);
          },
        },
        Close14(),
      ),
    );
  };

  // 展开所有组为扁平列表项（保留组内顺序与前缀信息）
  const items: Array<{ inst: TerminalInstance; prefix: string }> = [];
  for (const group of groups) {
    const total = group.instances.length;
    for (let i = 0; i < total; i++) {
      items.push({
        inst: group.instances[i],
        prefix: treePrefix(i, total),
      });
    }
  }

  return React.createElement(
    'div',
    { className: 'dshTermSideList' },
    // 标题头
    React.createElement('div', { className: 'dshTermSideListHeader' }, '终端'),
    // 可滚动列表项容器
    React.createElement(
      'div',
      { className: 'dshTermSideListItems' },
      ...items.map(({ inst, prefix }) => renderItem(inst, prefix)),
    ),
  );
}
