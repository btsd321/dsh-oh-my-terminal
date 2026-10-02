/**
 * @file 拆分组 React 组件
 * @description 用 SplitView 管理拆分组内各 pane 的尺寸——SplitView 用绝对定位 +
 *              显式像素宽度布局 pane，Sash 拖拽时通过 resize() 算法分配 delta。
 *
 *              与 terminal-render.tsx 的 renderTerminalGroups 配合：
 *              单实例组直接渲染 TermPane（flex:1 等分），多实例组用 SplitGroup
 *              （SplitView 绝对定位 + Sash 拖拽）。
 *
 *              每个 TermPane 通过 React.createPortal 渲染到 SplitView 管理的
 *              view.element div 中——SplitView 负责定位和尺寸（绝对定位 left/width），
 *              React 负责内容渲染（TermPane + xterm + WebSocket）。
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { SplitView, type IView } from './split-view.js';
import { TermPane } from './term-pane.js';
import type { TerminalInstance } from './types.js';
import { SPLIT_PANE_MIN_WIDTH } from './styles.js';

/** SplitGroup 的 props（与 renderTerminalGroups 的多实例组参数一致） */
export interface SplitGroupProps {
  /** 组内终端实例列表 */
  instances: TerminalInstance[];
  /** 当前活跃终端实例 id（用于高亮） */
  activeInstanceId: string | null;
  /** 终端字体族 */
  fontFamily: string;
  /** 终端字号 */
  fontSize: number | undefined;
  /** 终端行高倍数 */
  lineHeight: number | undefined;
  /** 会话退出回调 */
  onExit: (id: string) => void;
}

/**
 * 拆分组：用 SplitView 管理 pane 尺寸，支持 Sash 拖拽调整宽度。
 *
 * 挂载时创建 SplitView，为每个实例创建一个 IView（host div）。
 * 实例增删时同步增删 View。容器 resize 时调用 SplitView.layout(newSize)。
 * 每个 TermPane 通过 React.createPortal 渲染到 SplitView 管理的 host div 中。
 *
 * @param props - 拆分组 props
 * @returns 拆分组容器 div
 */
export function SplitGroup(props: SplitGroupProps): ReactElement {
  const { instances, activeInstanceId, fontFamily, fontSize, lineHeight, onExit } = props;
  const { useEffect, useRef, useState } = React;

  /** SplitView 容器 ref */
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** SplitView 实例（跨渲染保持） */
  const splitViewRef = useRef<SplitView | null>(null);
  /** 每个 instance.id → host div 的映射（管理增删 + portal 渲染） */
  const hostMapRef = useRef<Map<string, HTMLDivElement>>(new Map());
  /** 递增 key，用于触发 portal 列表重新渲染 */
  const [portalVersion, setPortalVersion] = useState(0);

  /* 1. 挂载：创建 SplitView，布局初始尺寸 */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const sv = new SplitView(container);
    splitViewRef.current = sv;

    /* 初始布局：用 rAF 延迟一帧确保容器尺寸已就绪（兼容模式 tab 切换时容器
     * 挂载后可能还没完成 flex 布局，直接读 offsetWidth 可能得到 0） */
    const raf = requestAnimationFrame(() => {
      sv.layout(container.offsetWidth);
    });

    /* 容器 resize 时重新布局 */
    const ro = new ResizeObserver(() => {
      sv.layout(container.offsetWidth);
    });
    ro.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      sv.dispose();
      splitViewRef.current = null;
      hostMapRef.current.clear();
    };
  }, []);

  /* 2. 同步 instances → SplitView views（增删） */
  useEffect(() => {
    const sv = splitViewRef.current;
    if (sv === null) return;

    const currentIds = new Set(instances.map((i) => i.id));
    const hostMap = hostMapRef.current;

    /* 删除不在当前 instances 中的 view（倒序删除避免索引移位） */
    const existingIds = Array.from(hostMap.keys());
    for (let i = existingIds.length - 1; i >= 0; i--) {
      const id = existingIds[i];
      if (!currentIds.has(id)) {
        if (i >= 0 && i < sv.length) {
          sv.removeView(i);
        }
        hostMap.delete(id);
      }
    }

    /* 添加新 instance 的 view */
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      if (!hostMap.has(inst.id)) {
        /* 创建 host div——SplitView.addView 会把它挂到 viewContainer 中 */
        const element = document.createElement('div');
        element.className = 'dshTermSplitViewPaneHost';

        const view: IView = {
          element,
          minimumSize: SPLIT_PANE_MIN_WIDTH,
          maximumSize: Number.POSITIVE_INFINITY,
          onDidChange: () => ({ dispose: () => {} }),
          layout: (_size: number, _offset: number) => {
            /* SplitView 分配尺寸后调用——pane 尺寸已通过 container.style.width 设置，
             * TermPane 内的 ResizeObserver 会检测到尺寸变化并 fit */
          },
        };

        sv.addView(view, undefined, i);
        hostMap.set(inst.id, element);
      }
    }

    /* 容器尺寸变化后重新布局 */
    const container = containerRef.current;
    if (container !== null) {
      sv.layout(container.offsetWidth);
    }

    /* 触发 portal 列表重新渲染 */
    setPortalVersion((v) => v + 1);
  }, [instances]);

  /* 3. 渲染：SplitView 的 DOM 由它自己管理，React 通过 portal 渲染 TermPane */
  const portals: ReactElement[] = [];
  for (const inst of instances) {
    const host = hostMapRef.current.get(inst.id);
    if (host !== undefined) {
      portals.push(
        createPortal(
          React.createElement(TermPane, {
            instance: inst,
            active: inst.id === activeInstanceId,
            alwaysVisible: true,
            fontFamily,
            fontSize,
            lineHeight,
            onExit,
          }),
          host,
          inst.id,
        ),
      );
    }
  }

  /* portalVersion 只用于触发重新渲染，不直接使用 */
  void portalVersion;

  return React.createElement('div', {
    ref: containerRef,
    className: 'dshTermSplitGroupContainer',
    style: { position: 'absolute', inset: 0, overflow: 'hidden' },
  }, ...portals);
}
