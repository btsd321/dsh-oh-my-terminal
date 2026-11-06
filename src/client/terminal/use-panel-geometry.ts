/**
 * @file 面板几何与高度管理
 * @description 面板几何与高度管理 Hooks：拖拽调高 + localStorage 持久化 + 对话列几何测量。
 *              从 hooks.ts 抽取 usePanelGeometry 和 usePanelHeight。
 *
 * usePanelHeight：面板高度拖拽调节 + localStorage 持久化。初值从 localStorage 恢复，
 * 拖拽在 MIN_HEIGHT～MAX_HEIGHT_RATIO 视口高之间夹取，松手时写回 localStorage。
 *
 * usePanelGeometry：对话列几何测量，面板宽度对齐对话列，并向滚动容器注入 paddingBottom。
 * 终端 bar/panel 固定在视口底部；对话滚动容器获得等于面板高度的 paddingBottom，
 * 使 composer 座位与上方 dock 条目整体上移，不被 fixed 终端面板遮挡。
 * 可见面板由 client.tsx Portal 到 body（绕开 composerSeat 的 transform 包含块），
 * 因此本 Hook 以留在 dock 槽里的零尺寸锚点定位滚动容器，以面板根读高度。
 */

import * as React from 'react';
import type { ConversationGeo } from '../types.js';

/** 面板高度在 localStorage 里的键名 */
const HEIGHT_KEY = 'dsh-oh-my-terminal.height';

/** 面板最小高度（像素） */
const MIN_HEIGHT = 120;

/** 面板最大高度占视口的百分比（拖拽上限） */
const MAX_HEIGHT_RATIO = 0.78;

/** 默认面板高度占视口的百分比（首次无 localStorage 时） */
const DEFAULT_HEIGHT_RATIO = 0.36;

/** usePanelHeight 返回值 */
export interface PanelHeight {
  /** 当前面板高度（像素） */
  height: number;
  /** 高度 ref（拖拽回调内读最新值，避免闭包陈旧） */
  heightRef: React.MutableRefObject<number>;
  /** 拖拽 grip 的 pointerdown 处理 */
  startResize: (e: React.PointerEvent) => void;
}

/**
 * 面板高度管理：拖拽调高 + localStorage 持久化。
 *
 * 初值从 localStorage 恢复（不小于 MIN_HEIGHT），拖拽在 MIN_HEIGHT～MAX_HEIGHT_RATIO
 * 视口高之间夹取，松手时写回 localStorage。
 *
 * @returns 高度 state、ref、拖拽回调
 */
export function usePanelHeight(): PanelHeight {
  const { useState, useRef, useCallback } = React;

  const [height, setHeight] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY));
      if (Number.isFinite(saved) && saved >= MIN_HEIGHT) return saved;
    } catch { /* storage 不可用（隐私模式 / SSR 探测） */ }
    return Math.round(window.innerHeight * DEFAULT_HEIGHT_RATIO);
  });
  const heightRef = useRef(height);
  heightRef.current = height;

  /* 拖拽 resize grip：向上生长面板 */
  const startResize = useCallback((e: React.PointerEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = heightRef.current;
    const maxH = Math.round(window.innerHeight * MAX_HEIGHT_RATIO);
    const move = (ev: PointerEvent): void => {
      const h = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
      setHeight(Math.round(h));
    };
    const up = (): void => {
      document.body.classList.remove('dshTermResizing');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(heightRef.current));
      } catch { /* storage 不可用 */ }
    };
    document.body.classList.add('dshTermResizing');
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, []);

  return { height, heightRef, startResize };
}

/** usePanelGeometry 返回值 */
export interface PanelGeometry {
  /** 对话列几何（面板不覆盖侧栏） */
  geo: ConversationGeo;
}

/**
 * 对话列几何测量：面板宽度对齐对话列，并向滚动容器注入 paddingBottom。
 *
 * 终端 bar/panel 固定在视口底部；对话滚动容器获得等于面板高度的 paddingBottom，
 * 使 composer 座位与上方 dock 条目整体上移，不被 fixed 终端面板遮挡。
 *
 * 用 scrollBody 的 paddingBottom 而非 composerSeat 的 marginBottom：composer
 * overlay 模式下 composerSeat 是 absolute，marginBottom 不改锚点；paddingBottom
 * 对 sticky/absolute 子元素都生效。
 *
 * **为什么锚点与面板根分开**：可见的面板经 `createPortal` 挂到 document.body
 * （composerSeat 的 `will-change: transform` 会让它成为 fixed 后代的包含块，
 * 面板留在 dock 槽里就会以 composerSeat 为基准错位），因此面板根已不在对话
 * DOM 内——测量起点改用留在槽内的零尺寸锚点，高度仍取面板根。
 *
 * @param anchorRef - 留在 dock 槽内的锚点 ref（用于定位对话滚动容器）
 * @param rootRef - 面板根元素 ref（已 Portal 到 body，用于读取面板高度）
 * @returns 对话列几何 state
 */
export function usePanelGeometry(
  anchorRef: React.RefObject<HTMLElement | null>,
  rootRef: React.RefObject<HTMLElement | null>,
): PanelGeometry {
  const { useLayoutEffect, useState } = React;
  const [geo, setGeo] = useState<ConversationGeo>({ left: 0, width: window.innerWidth });

  useLayoutEffect(() => {
    const anchorEl = anchorRef.current;
    if (anchorEl === null) return;
    const scrollBody = anchorEl.closest<HTMLElement>('[data-conversation-scroll]');
    const measure = (): void => {
      if (scrollBody !== null) {
        const r = scrollBody.getBoundingClientRect();
        /* 只在几何真的变化时提交 state：ResizeObserver 的回调里还会写
         * paddingBottom，不设这道闸每轮都会拿新对象触发一次无意义重渲染 */
        setGeo((prev) => (prev.left === r.left && prev.width === r.width
          ? prev
          : { left: r.left, width: r.width }));
      }
      const rootEl = rootRef.current;
      const h = rootEl === null ? 0 : Math.round(rootEl.getBoundingClientRect().height);
      if (scrollBody !== null) scrollBody.style.paddingBottom = h > 0 ? h + 'px' : '';
    };
    const ro = new ResizeObserver(measure);
    if (scrollBody !== null) ro.observe(scrollBody);
    /* Portal 子节点的 ref 在布局 effect 之前就已挂好，这里必然可观察；
     * 高度变化（展开/收起/拖拽调高）靠它触发 paddingBottom 重算 */
    if (rootRef.current !== null) ro.observe(rootRef.current);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      if (scrollBody !== null) scrollBody.style.paddingBottom = '';
    };
  }, [anchorRef, rootRef]);

  return { geo };
}
