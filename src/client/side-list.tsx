/**
 * @file 终端列表面板组件
 * @description 右侧终端列表面板，垂直展示所有终端实例并按组显示树形拆分前缀。
 *              支持点击切换活跃终端、中键关闭、右键重命名、活跃高亮与已退出样式。
 *              通过 props 回调与父组件通信，内部仅管理重命名编辑态。
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
  /** 重命名终端回调 */
  onRename: (instanceId: string, newName: string) => void;
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
 * - 右键弹出上下文菜单（重命名）
 * - hover 显示关闭按钮
 *
 * @param props - 列表 props
 * @returns 列表面板根元素
 */
export function SideList(props: SideListProps): ReactElement {
  const { groups, activeInstanceId, onSelect, onClose, onRename } = props;
  const { useState, useRef, useEffect, useCallback } = React;

  /** 正在重命名的实例 id（null 表示无） */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** 重命名输入框的临时值 */
  const [renameValue, setRenameValue] = useState('');
  /** 右键菜单状态 */
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; instanceId: string } | null>(null);
  /** 重命名 input ref（自动聚焦） */
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  /* 重命名 input 挂载时自动聚焦并全选 */
  useEffect(() => {
    if (renamingId !== null && renameInputRef.current !== null) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  /* 点击外部关闭右键菜单 */
  useEffect(() => {
    if (contextMenu === null) return;
    const onClickOutside = (): void => setContextMenu(null);
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [contextMenu]);

  /**
   * 提交重命名：调用 onRename 回调并退出编辑态。
   *
   * @param instanceId - 终端实例 id
   */
  const commitRename = useCallback((instanceId: string): void => {
    const trimmed = renameValue.trim();
    if (trimmed.length > 0) {
      onRename(instanceId, trimmed);
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renameValue, onRename]);

  /**
   * 开始重命名：从右键菜单触发。
   *
   * @param instanceId - 终端实例 id
   * @param currentLabel - 当前显示标签
   */
  const startRename = useCallback((instanceId: string, currentLabel: string): void => {
    setRenamingId(instanceId);
    setRenameValue(currentLabel);
    setContextMenu(null);
  }, []);

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
   * 处理右键菜单。
   *
   * @param e - 鼠标事件
   * @param instanceId - 终端实例 id
   * @param label - 当前显示标签
   */
  const handleContextMenu = (e: React.MouseEvent, instanceId: string, label: string): void => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, instanceId });
    /* 保存 label 供 startRename 使用——通过 data attribute 传递 */
    const target = e.currentTarget as HTMLElement;
    target.dataset.label = label;
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
    const isRenaming = inst.id === renamingId;

    // 拼接 CSS 类名
    let className = 'dshTermSideItem';
    if (isActive) className += ' isActive';
    if (isExited) className += ' isExited';

    return React.createElement(
      'div',
      {
        key: inst.id,
        className,
        title: isRenaming ? undefined : label,
        onMouseDown: (e: React.MouseEvent) => handleMouseDown(e, inst.id),
        onClick: () => { if (!isRenaming) onSelect(inst.id); },
        onContextMenu: (e: React.MouseEvent) => handleContextMenu(e, inst.id, label),
      },
      // 终端图标
      React.createElement('span', { className: 'dshTermSideItemIcon', 'aria-hidden': true },
        TerminalGlyph12(),
      ),
      // 树形前缀（仅多实例组显示）
      prefix.length > 0
        ? React.createElement('span', { className: 'dshTermSideItemPrefix' }, prefix)
        : null,
      // 名称标签或重命名输入框
      isRenaming
        ? React.createElement('input', {
          className: 'dshTermSideItemInput',
          ref: renameInputRef,
          value: renameValue,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRenameValue(e.target.value),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename(inst.id);
            } else if (e.key === 'Escape') {
              setRenamingId(null);
              setRenameValue('');
            }
          },
          onBlur: () => commitRename(inst.id),
        })
        : React.createElement('span', { className: 'dshTermSideItemLabel' }, label),
      // 关闭按钮（默认隐藏，hover 经 CSS 显示）
      !isRenaming
        ? React.createElement(
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
        )
        : null,
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
    // 右键上下文菜单
    contextMenu !== null
      ? React.createElement(
        'div',
        {
          className: 'dshTermContextMenu',
          style: { left: contextMenu.x + 'px', top: contextMenu.y + 'px' },
        },
        React.createElement(
          'div',
          {
            className: 'dshTermContextMenuItem',
            onClick: () => {
              const label = instanceLabel(
                items.find(it => it.inst.id === contextMenu.instanceId)?.inst ??
                { id: '', title: undefined, shell: undefined, cwd: null, exited: false },
              );
              startRename(contextMenu.instanceId, label);
            },
          },
          '重命名',
        ),
      )
      : null,
  );
}
