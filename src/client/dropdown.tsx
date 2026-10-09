/**
 * @file 终端下拉菜单组件
 * @description 浏览器半终端面板 tabs 栏的下拉菜单，位于 + 按钮旁。提供新建终端、
 *              拆分终端、按终端配置新建/拆分等操作入口。通过 props 回调与父组件
 *              （TerminalPanel）通信，自身仅负责菜单渲染与交互状态管理。
 *
 *              浮层通过 React Portal 渲染到 document.body，使用 position:fixed +
 *              getBoundingClientRect() 动态计算位置。兼容模式下 DSH-better-sidebar
 *              的 .bottomPanel 设了 contain:layout（创建新的 containing block，使
 *              position:fixed 退化为相对于该容器定位），加上 .tabBarRightActions 的
 *              overflow:hidden 和宿主层的 overflow:clip，任何留在 DOM 树内的浮层都
 *              会被裁剪不可见。Portal 到 body 后浮层彻底脱离 DSH-better-sidebar 的
 *              DOM 子树，不受任何祖先的 contain/overflow/transform 影响。
 *
 *              自适应弹出方向（flip 策略，参考 Floating UI / Radix UI / GitHub Primer）：
 *              先以不可见方式渲染菜单测量实际高度，比较下方可用空间与菜单高度——
 *              下方空间足够则向下弹出，否则向上弹出。同时限制 maxHeight 为可用空间，
 *              超出部分 overflow-y:auto 滚动。
 *
 * 依赖模块：
 * - `./types.js` — TerminalProfile 类型定义
 * - `./icons.js` — Plus12 / ChevronDownSmall10 / Split14 图标组件
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import type { ReactElement, CSSProperties } from 'react';
import type { TerminalProfile } from './types.js';
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
  /** 终端配置列表（来自 /config） */
  terminalProfiles: TerminalProfile[];
  /** 按配置 id 新建终端 */
  onNewByType: (profileId: string) => void;
}

// —— 常量 ——

/** 浮层与触发按钮之间的间距（像素） */
const MENU_GAP = 4;

/** 浮层与视口边缘的最小安全边距（像素） */
const VIEWPORT_PADDING = 8;

// —— 组件实现 ——

/**
 * 终端下拉菜单：倒三角按钮 + 浮层菜单。
 *
 * 点击按钮切换菜单显隐；点击菜单项执行对应回调并关闭菜单；点击菜单外部区域
 * 经 document mousedown 监听器关闭菜单。
 *
 * 浮层通过 React Portal 渲染到 document.body，使用 position:fixed +
 * getBoundingClientRect() 动态计算位置。兼容模式下 DSH-better-sidebar 的
 * .bottomPanel 设了 contain:layout（CSS Containment 规范：contain:layout 使元素
 * 成为 fixed 定位后代的 containing block，position:fixed 退化为相对于该容器定位），
 * 加上 .tabBarRightActions 的 overflow:hidden 和宿主层的 overflow:clip，任何留在
 * DOM 树内的浮层都会被裁剪不可见。Portal 到 body 后浮层彻底脱离 DSH-better-sidebar
 * 的 DOM 子树，不受任何祖先的 contain/overflow/transform 影响。
 *
 * 自适应弹出方向（flip 策略）：先以不可见方式渲染菜单测量实际高度，比较下方
 * 可用空间与菜单高度——下方空间足够则向下弹出，否则向上弹出。同时限制 maxHeight
 * 为可用空间，超出部分 overflow-y:auto 滚动。参考 Floating UI / Radix UI /
 * GitHub Primer 的 dropdown 定位策略。
 *
 * 外部点击关闭：浮层 Portal 到 body 后不再是 wrapRef 的子节点，mousedown 监听器
 * 需同时检查 wrapRef（按钮区域）和 menuRef（浮层区域）两个 ref。
 *
 * @param props - 下拉菜单 props
 * @returns 下拉菜单根元素
 */
export function DropdownMenu(props: DropdownMenuProps): ReactElement {
  const { busy, onNewTerminal, onSplitTerminal, terminalProfiles, onNewByType } = props;
  const { useState, useEffect, useRef, useCallback, useLayoutEffect } = React;

  /** 菜单是否展开 */
  const [isOpen, setIsOpen] = useState(false);
  /** 容器 ref（用于外部点击判断——按钮区域） */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** 触发按钮 ref（用于 getBoundingClientRect 计算浮层位置） */
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** 浮层菜单 ref（用于外部点击判断 + 测量实际高度） */
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 浮层菜单的定位样式（运行时计算，含 flip 方向和 maxHeight） */
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  /**
   * 测量阶段标记：true 时浮层以 visibility:hidden 渲染用于测量高度，
   * 测量完成后设为 false 并应用最终定位样式。避免用户看到菜单闪现。
   */
  const [measuring, setMeasuring] = useState(false);
  /** 触发按钮的视口位置快照（测量阶段使用，避免重复读取 DOM） */
  const triggerRectRef = useRef<DOMRect | null>(null);

  /** 关闭菜单 */
  const close = useCallback((): void => {
    setIsOpen(false);
    setMeasuring(false);
    triggerRectRef.current = null;
  }, []);

  /**
   * 切换菜单显隐。
   *
   * 打开时进入测量阶段：先记录触发按钮位置，以 visibility:hidden 渲染菜单，
   * useLayoutEffect 中测量实际高度后计算最终位置（含 flip 方向判断）。
   * 关闭时直接重置状态。
   */
  const toggle = useCallback((): void => {
    if (busy) return;
    if (!isOpen) {
      // 记录触发按钮位置，进入测量阶段
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect !== undefined) {
        triggerRectRef.current = rect;
        setMeasuring(true);
        setIsOpen(true);
      }
    } else {
      close();
    }
  }, [busy, isOpen, close]);

  /**
   * 测量阶段：useLayoutEffect 在 DOM 更新后、浏览器绘制前同步执行。
   *
   * 读取菜单实际高度，与触发按钮位置和视口尺寸比较，决定弹出方向和最大高度：
   * - 下方空间 >= 菜单高度 + 间距 → 向下弹出（top = triggerBottom + gap）
   * - 下方空间不足 → 向上弹出（bottom = viewportHeight - triggerTop + gap）
   * - maxHeight = 可用空间 - 安全边距，超出部分 overflow-y:auto 滚动
   *
   * 这是 Floating UI / Radix UI / GitHub Primer 的标准 flip + clamp 策略。
   */
  useLayoutEffect(() => {
    if (!measuring || !isOpen) return;
    const menu = menuRef.current;
    const rect = triggerRectRef.current;
    if (menu === null || rect === null) return;

    const menuHeight = menu.offsetHeight;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    // 下方可用空间（从按钮底部到视口底部，减去安全边距）
    const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_PADDING;
    // 上方可用空间（从视口顶部到按钮顶部，减去安全边距）
    const spaceAbove = rect.top - VIEWPORT_PADDING;

    // flip 判断：下方空间够放菜单则向下，否则向上
    const flipUp = menuHeight + MENU_GAP > spaceBelow && spaceAbove > spaceBelow;

    // maxHeight：取弹出方向的可用空间，确保菜单不超出视口
    const maxHeight = flipUp
      ? Math.max(spaceAbove - MENU_GAP, 0)
      : Math.max(spaceBelow - MENU_GAP, 0);

    const style: CSSProperties = {
      position: 'fixed',
      right: viewportWidth - rect.right,
      zIndex: 200,
      maxHeight,
      overflowY: maxHeight < menuHeight ? 'auto' : undefined,
    };

    if (flipUp) {
      // 向上弹出：bottom 锚定到按钮顶部上方
      style.bottom = viewportHeight - rect.top + MENU_GAP;
    } else {
      // 向下弹出：top 锚定到按钮底部下方
      style.top = rect.bottom + MENU_GAP;
    }

    setMenuStyle(style);
    setMeasuring(false);
    triggerRectRef.current = null;
  }, [measuring, isOpen]);

  /* 点击菜单外部区域关闭 + Escape 键关闭：document 事件监听器。
   * 浮层 Portal 到 body 后不再是 wrapRef 的子节点，mousedown 需同时检查
   * wrapRef（按钮区域）和 menuRef（浮层区域）两个 ref——点击在任一区域内则忽略。
   * Escape 键是下拉菜单的标准无障碍交互，Portal 后键盘焦点不在菜单内，
   * 必须在 document 级别捕获 */
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      const wrap = wrapRef.current;
      const menu = menuRef.current;
      /* 点击在按钮容器或浮层菜单内部则忽略 */
      if ((wrap !== null && wrap.contains(target)) || (menu !== null && menu.contains(target))) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
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

  /* 终端配置菜单项（有配置时显示分隔线与列表，每项按该配置新建终端） */
  if (terminalProfiles.length > 0) {
    menuItems.push(
      React.createElement('div', { key: 'sep', className: 'dshTermDropdownSep' }),
    );

    for (const profile of terminalProfiles) {
      menuItems.push(
        React.createElement(
          'div',
          {
            key: profile.id,
            className: 'dshTermDropdownItem',
            onClick: handleItemClick(() => onNewByType(profile.id)),
          },
          Plus12(),
          React.createElement('span', null, profile.name),
        ),
      );
    }
  }

  /*
   * 浮层菜单元素（Portal 到 document.body）。
   *
   * 测量阶段（measuring=true）：visibility:hidden 渲染，占位但不可见，
   * useLayoutEffect 同步测量高度后计算最终位置。测量完成后 measuring=false，
   * 应用最终 menuStyle（含 flip 方向和 maxHeight），菜单变为可见。
   *
   * 两阶段渲染保证用户不会看到菜单在错误位置闪现——useLayoutEffect 在
   * 浏览器绘制前执行，测量和定位在同一帧内完成。
   */
  const menuElement = isOpen
    ? createPortal(
        React.createElement(
          'div',
          {
            className: 'dshTermDropdownMenu',
            style: measuring
              ? { position: 'fixed', visibility: 'hidden', zIndex: -1 }
              : menuStyle,
            ref: menuRef,
          },
          ...menuItems,
        ),
        document.body,
      )
    : null;

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
        ref: triggerRef,
      },
      ChevronDownSmall10(),
    ),
    /* 浮层通过 Portal 渲染到 document.body */
    menuElement,
  );
}
