/**
 * @file 终端面板 SVG 图标组件集
 * @description 提供终端面板 UI 所需的全部 SVG 图标纯函数组件。
 *              每个组件返回 ReactElement，使用 React.createElement 构建 SVG，
 *              不包含任何业务逻辑，仅负责图标渲染（SRP）。
 */

import * as React from 'react';
import type { ReactElement } from 'react';

/**
 * 终端图标 14px（bar 引导符）
 *
 * @returns 14×14 终端 glyph SVG 元素
 */
export function TerminalGlyph14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('rect', { x: 1.35, y: 1.35, width: 11.3, height: 11.3, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.05 }),
    React.createElement('path', { d: 'M4.75 4.9L7.05 7L4.75 9.1', stroke: 'currentColor', strokeWidth: 1.05, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    React.createElement('path', { d: 'M7.75 9.1H10.05', stroke: 'currentColor', strokeWidth: 1.05, strokeLinecap: 'round' }),
  );
}

/**
 * 终端图标 12px（列表项引导符）
 *
 * @returns 12×12 终端 glyph SVG 元素（viewBox 仍为 14×14，缩放至 12px）
 */
export function TerminalGlyph12(): ReactElement {
  return React.createElement(
    'svg',
    { width: 12, height: 12, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('rect', { x: 1.35, y: 1.35, width: 11.3, height: 11.3, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.1 }),
    React.createElement('path', { d: 'M4.75 4.9L7.05 7L4.75 9.1', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    React.createElement('path', { d: 'M7.75 9.1H10.05', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
  );
}

/**
 * 上箭头 14px（折叠态 chevron）
 *
 * @returns 14×14 向上 chevron SVG 元素
 */
export function ChevronUp14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M11.8486 8.5L11.4238 8.07617L8.69727 5.34863C8.44157 5.09294 8.21562 4.86618 8.01172 4.70215C7.79912 4.53117 7.55595 4.38244 7.25 4.33398C7.08435 4.30778 6.91565 4.30778 6.75 4.33398C6.44405 4.38244 6.20088 4.53117 5.98828 4.70215C5.78438 4.86618 5.55843 5.09294 5.30273 5.34863L2.57617 8.07617L2.15137 8.5L3 9.34863L3.42383 8.92383L6.15137 6.19727C6.42595 5.92268 6.59876 5.75151 6.74023 5.6377C6.87291 5.53096 6.92272 5.52187 6.9375 5.51953C6.97895 5.51297 7.02105 5.51297 7.0625 5.51953C7.07728 5.52187 7.12709 5.53096 7.25977 5.6377C7.40124 5.75151 7.57405 5.92268 7.84863 6.19727L10.5762 8.92383L11 9.34863L11.8486 8.5Z', fill: 'currentColor' }),
  );
}

/**
 * 下箭头 14px（展开态收起按钮）
 *
 * @returns 14×14 向下 chevron SVG 元素
 */
export function ChevronDown14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z', fill: 'currentColor' }),
  );
}

/**
 * 右箭头 14px（列表项展开指示器）
 *
 * @returns 14×14 向右 chevron SVG 元素
 */
export function ChevronRight14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24849 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z', fill: 'currentColor' }),
  );
}

/**
 * 刷新图标 14px（重启按钮）
 *
 * @returns 14×14 循环箭头 SVG 元素
 */
export function Refresh14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M1.272 6.21348C1.70645 3.08888 4.59169 0.908064 7.71634 1.34239C8.95495 1.51469 10.0438 2.07331 10.8814 2.87755L11.9458 1.81407C12.1347 1.6255 12.4572 1.75911 12.4575 2.02598V5.08751C12.4574 5.25303 12.3233 5.38731 12.1577 5.38731H9.0972C8.82993 5.38731 8.69629 5.06361 8.88528 4.87462L10.0327 3.72618C9.3732 3.09994 8.52006 2.66569 7.5513 2.53087C5.08313 2.18779 2.80376 3.91044 2.46048 6.37852C2.11747 8.84665 3.84009 11.1261 6.30814 11.4693C8.77612 11.8121 11.0557 10.0896 11.399 7.62148L12.728 7.80531C12.2935 10.9299 9.4083 13.1107 6.28366 12.6764C3.159 12.2421 0.977243 9.35731 1.272 6.21348Z', fill: 'currentColor' }),
  );
}

/**
 * 关闭图标 14px（关闭按钮）
 *
 * @returns 14×14 × 形 SVG 元素
 */
export function Close14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z', fill: 'currentColor' }),
  );
}

/**
 * 加号图标 12px（新建终端按钮）
 *
 * @returns 12×12 + 形 SVG 元素（viewBox 为 16×16，缩放至 12px）
 */
export function Plus12(): ReactElement {
  return React.createElement(
    'svg',
    { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z', fill: 'currentColor' }),
  );
}

/**
 * 下三角图标 10px（下拉箭头）
 *
 * 比 ChevronDown14 更紧凑的实心三角形，用于下拉菜单触发器等空间受限场景。
 *
 * @returns 10×10 向下小三角 SVG 元素
 */
export function ChevronDownSmall10(): ReactElement {
  return React.createElement(
    'svg',
    { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M2 3.5L5 6.5L8 3.5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  );
}

/**
 * 拆分图标 14px（拆分终端菜单项）
 *
 * 表示将当前终端面板水平拆分为两个并排窗格的图标。
 *
 * @returns 14×14 拆分 SVG 元素
 */
export function Split14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('rect', { x: 1.5, y: 2.5, width: 11, height: 9, rx: 1.5, stroke: 'currentColor', strokeWidth: 1 }),
    React.createElement('line', { x1: 7, y1: 2.5, x2: 7, y2: 11.5, stroke: 'currentColor', strokeWidth: 1 }),
  );
}
