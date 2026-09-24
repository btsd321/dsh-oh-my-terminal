/**
 * @file 终端下拉菜单组件
 * @description 浏览器半终端面板 tabs 栏的下拉菜单，位于 + 按钮旁。提供新建终端、
 *              拆分终端、按终端种类新建/拆分等操作入口。通过 props 回调与父组件
 *              （TerminalPanel）通信，自身仅负责菜单渲染与交互状态管理。
 *
 * 依赖模块：
 * - `./types.js` — TerminalType 类型定义
 * - `./icons.js` — Plus12 / ChevronDownSmall10 / Split14 图标组件
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { TerminalType } from './types.js';
import { Plus12, ChevronDownSmall10, Split14 } from './icons.js';

// —— 类型定义 ——

/** DropdownMenu 的 props */
export interface DropdownMenuProps {
  /** 操作进行中（禁用按钮） */
  busy: boolean;
  /** 新建终端回调 */
  onNewTerminal: () => void;
  /** 拆分终端回调 */
  onSplitTerminal: () => void;
  /** 终端种类列表（来自 /config） */
  terminalTypes: TerminalType[];
  /** 按种类新建终端 */
  onNewByType: (typeId: string) => void;
}

// —— 组件实现 ——

/**
 * 终端下拉菜单：倒三角按钮 + 浮层菜单。
 *
 * 点击按钮切换菜单显隐；点击菜单项执行对应回调并关闭菜单；点击菜单外部区域
 * 经 document mousedown 监听器关闭菜单。使用 position: relative 容器 +
 * position: absolute 浮层的经典定位方案。
 *
 * @param props - 下拉菜单 props
 * @returns 下拉菜单根元素
 */
export function DropdownMenu(props: DropdownMenuProps): ReactElement {
  const { busy, onNewTerminal, onSplitTerminal, terminalTypes, onNewByType } = props;
  const { useState, useEffect, useRef, useCallback } = React;

  /** 菜单是否展开 */
  const [isOpen, setIsOpen] = useState(false);
  /** 容器 ref（用于外部点击判断） */
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /** 关闭菜单 */
  const close = useCallback((): void => {
    setIsOpen(false);
  }, []);

  /** 切换菜单显隐 */
  const toggle = useCallback((): void => {
    if (busy) return;
    setIsOpen(prev => !prev);
  }, [busy]);

  /* 点击菜单外部区域关闭：document mousedown 监听器 */
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent): void => {
      const wrap = wrapRef.current;
      if (wrap === null) return;
      /* 点击在容器内部则忽略（按钮自身的 click 会处理 toggle） */
      if (wrap.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [isOpen, close]);

  /**
   * 包装菜单项点击：执行回调后关闭菜单。
   *
   * @param action - 菜单项对应的操作回调
   * @returns 绑定到 onClick 的处理函数
   */
  const handleItemClick = useCallback((action: () => void): () => void => {
    return (): void => {
      action();
      close();
    };
  }, [close]);

  /* 构建菜单项列表 */
  const menuItems: ReactElement[] = [];

  /* 新建终端 */
  menuItems.push(
    React.createElement(
      'div',
      {
        key: 'new',
        className: 'dshTermDropdownItem',
        onClick: handleItemClick(onNewTerminal),
      },
      Plus12(),
      React.createElement('span', null, '新建终端'),
    ),
  );

  /* 拆分终端 */
  menuItems.push(
    React.createElement(
      'div',
      {
        key: 'split',
        className: 'dshTermDropdownItem',
        onClick: handleItemClick(onSplitTerminal),
      },
      Split14(),
      React.createElement('span', null, '拆分终端'),
    ),
  );

  /* 终端种类菜单项（仅有种类时显示分隔线与种类列表，每项直接新建对应终端） */
  if (terminalTypes.length > 0) {
    menuItems.push(
      React.createElement('div', { key: 'sep', className: 'dshTermDropdownSep' }),
    );

    for (const tt of terminalTypes) {
      /* 跳过 "默认 Shell"——已在上方"新建终端"中覆盖 */
      if (tt.id === 'default') continue;
      menuItems.push(
        React.createElement(
          'div',
          {
            key: tt.id,
            className: 'dshTermDropdownItem',
            onClick: handleItemClick(() => onNewByType(tt.id)),
          },
          Plus12(),
          React.createElement('span', null, tt.label),
        ),
      );
    }
  }

  return React.createElement(
    'div',
    { className: 'dshTermDropdownWrap', ref: wrapRef },
    /* 倒三角触发按钮 */
    React.createElement(
      'button',
      {
        className: 'dshTermDropdownArrow',
        title: '终端操作菜单',
        'aria-label': '终端操作菜单',
        'aria-expanded': isOpen,
        disabled: busy,
        onClick: toggle,
      },
      ChevronDownSmall10(),
    ),
    /* 菜单浮层（仅在展开时渲染） */
    isOpen
      ? React.createElement(
          'div',
          { className: 'dshTermDropdownMenu' },
          ...menuItems,
        )
      : null,
  );
}
