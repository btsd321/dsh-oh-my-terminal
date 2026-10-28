/**
 * @file 终端剪贴板访问模块
 * @description 封装浏览器剪贴板读写操作，为 xterm.js 终端提供复制/粘贴事件处理。
 *              采用双层降级策略：优先使用 Async Clipboard API（navigator.clipboard），
 *              在不安全上下文（远程 http / iframe 权限策略）下自动回落到
 *              document.execCommand('copy') 旧式方案。
 *
 * 降级策略说明：
 * - navigator.clipboard（Async Clipboard API）快但仅安全上下文（https 或
 *   http://localhost/127.0.0.1）存在。从其他机器经纯 http 打开 GUI——「远程」
 *   场景——它是 undefined 且任何调用抛错。复制因此回落到 legacy
 *   document.execCommand("copy")（经临时 textarea），在不安全上下文也工作。
 * - 读剪贴板没有不安全上下文回落 API，故 navigator.clipboard 缺失时不吞原生
 *   右键菜单：其「粘贴」项喂给聚焦的 xterm textarea，xterm 自身的 paste 事件
 *   转发文本进 shell。Ctrl+V 在终端内各上下文都那样工作。
 * - 安全上下文下 readText 也可能失败（Electron webview sandbox 无 clipboard-read
 *   权限）：不调 preventDefault（同步）+ readText（异步）会因 preventDefault 无法
 *   撤销导致彻底无法粘贴。改用 capture 阶段 paste 监听器 + 短时标志去重——
 *   readText 成功后设标志吞掉原生 paste，失败则放行原生 paste 兜底。
 *
 * 架构位置：
 * - 纯函数模块，可独立单元测试
 * - 被 client.tsx 的 TermPane 组件调用，不直接挂 DOM 监听器
 * - 依赖 @xterm/xterm 的 Terminal 类型（仅类型导入）
 */

import type { Terminal } from '@xterm/xterm';

/**
 * 旧式复制：经临时 textarea + document.execCommand('copy')。
 *
 * Async Clipboard API 缺失或失败时（不安全上下文 / 远程 http）的回落路径。
 * 创建不可见的 textarea 元素，选中文本后执行浏览器原生命令完成复制，
 * 最后清理临时 DOM 节点。
 *
 * @param text - 待复制文本
 * @returns 是否成功执行了复制命令
 */
export function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    /* execCommand 在某些浏览器/上下文中可能抛异常，视为复制失败即可 */
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/**
 * 写剪贴板：优先 Async Clipboard API，失败回落 legacyCopy。
 *
 * 当 navigator.clipboard.writeText 可用时异步写入；若 Promise 被拒绝
 * （如用户未授权、页面失焦），则同步回落到 legacyCopy。
 * 当 API 本身不存在（不安全上下文）时，直接走 legacyCopy。
 *
 * @param text - 待写入剪贴板的文本
 */
export function writeClipboard(text: string): void {
  if (typeof navigator.clipboard?.writeText === 'function') {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  } else {
    legacyCopy(text);
  }
}

/** createClipboardHandlers 返回的剪贴板事件处理集合 */
export interface ClipboardHandlers {
  /** 鼠标释放时复制选区（仅左键触发，右键保留给粘贴） */
  copySelection: (ev: MouseEvent) => void;
  /** 右键点击时粘贴剪贴板内容（不安全上下文下降级为浏览器原生右键菜单） */
  pasteClipboard: (ev: MouseEvent) => void;
  /** Ctrl+Shift+C/V 自定义按键处理；返回 false 表示已拦截、不再传递给终端 */
  onCustomKey: (ev: KeyboardEvent) => boolean;
  /**
   * Capture 阶段 paste 事件监听器。
   *
   * readText 成功后设标志，此监听器在 capture 阶段吞掉原生 paste 事件（防止
   * xterm 内部 handlePasteEvent 与 term.paste() 双发）。readText 失败时不设标志，
   * 原生 paste 正常到达 xterm → handlePasteEvent 单发兜底。
   *
   * 必须以 capture: true 挂到 term.element 上。
   */
  onNativePaste: (ev: ClipboardEvent) => void;
}

/**
 * 为指定终端创建剪贴板事件处理集合。
 *
 * 不直接挂监听——调用方（TermPane 挂载 effect）负责将返回的 handler 挂到
 * `term.element` 与 `term.attachCustomKeyEventHandler`，并在清理时移除。
 * 这样设计使本模块保持纯函数特性，便于测试与复用。
 *
 * @param term - xterm Terminal 实例，用于读取选区和执行粘贴
 * @returns 三个剪贴板事件处理函数组成的对象
 */
export function createClipboardHandlers(term: Terminal): ClipboardHandlers {
  /**
   * readText 成功后设此标志；onNativePaste 在 capture 阶段据此吞掉原生 paste 事件。
   *
   * 不调 preventDefault（同步）+ readText（异步）的方案在 readText 失败时无法撤销
   * preventDefault，导致 Electron webview sandbox（无 clipboard-read 权限）下完全
   * 无法粘贴。改用标志 + capture 阶段监听器：
   * - readText 成功 → term.paste(text) + 设标志 → 原生 paste 被吞 → 单发
   * - readText 失败 → 不设标志 → 原生 paste 放行 → xterm handlePasteEvent 单发兜底
   * - 不安全上下文 → 无 readText → 原生 paste 放行 → xterm 单发兜底
   */
  let suppressNativePaste = false;
  let suppressTimer: ReturnType<typeof setTimeout> | undefined;

  /** 鼠标释放复制选区（仅左键） */
  const copySelection = (ev: MouseEvent): void => {
    /* 仅左键释放：右键是粘贴，不重复复制 */
    if (ev.button !== 0) return;
    if (!term.hasSelection()) return;
    const text = term.getSelection();
    if (text.length === 0) return;
    writeClipboard(text);
  };

  /** 右键粘贴剪贴板（不安全上下文降级为浏览器原生行为） */
  const pasteClipboard = (ev: MouseEvent): void => {
    if (typeof navigator.clipboard?.readText !== 'function') {
      /* 不安全上下文（远程 http / iframe 权限策略）：让浏览器原生右键菜单显示——
       * 其「粘贴」项到达聚焦的 xterm textarea 并粘贴进 shell */
      return;
    }
    ev.preventDefault();
    navigator.clipboard
      .readText()
      .then((text: string) => {
        if (text.length > 0) term.paste(text);
      })
      .catch(() => {
        /* 权限拒绝或读取失败；Ctrl+V 仍可通过原生方式粘贴 */
      });
  };

  /* VS Code 风格 Ctrl+Shift+C / Ctrl+Shift+V——仅在 Async Clipboard API 存在时
   * （安全上下文）尝试；按键绝不到达 shell，故 Ctrl+C 保持 SIGINT、Ctrl+V 保持
   * 原生粘贴。
   *
   * 双发原理：customKeyHandler 返回 false 时 xterm _keyDown 直接 return false，
   * 不调 ev.preventDefault()。Chromium 在 xterm textarea 上把 Ctrl+Shift+V 当作
   * 「粘贴为纯文本」，触发原生 paste 事件，被 xterm 内部的 handlePasteEvent 再发
   * 一次。若我们的 term.paste() 也发了，就双发。
   *
   * 修复方案：v 分支不调 preventDefault（避免 readText 失败时阻断原生 paste 兜底），
   * 改用 capture 阶段 paste 监听器（onNativePaste）+ 短时标志去重：
   * readText 成功 → term.paste(text) + 设标志 → onNativePaste 吞掉原生 paste → 单发；
   * readText 失败（Electron webview sandbox 无 clipboard-read 权限）→ 不设标志 →
   * 原生 paste 放行 → xterm handlePasteEvent 单发兜底。 */
  const onCustomKey = (ev: KeyboardEvent): boolean => {
    if (ev.type !== 'keydown') return true;
    if (!(ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey)) return true;
    const k = ev.key.toLowerCase();
    if (k === 'c') {
      /* 阻断浏览器默认动作（Chrome 下为 DevTools 审查元素）；xterm 自身不会对该
       * 组合键 preventDefault */
      ev.preventDefault();
      /* writeClipboard 内含 legacyCopy 回落（execCommand），keydown 属用户手势，
       * 不安全上下文下也能复制 */
      if (term.hasSelection()) writeClipboard(term.getSelection());
      return false;
    }
    if (k === 'v') {
      if (typeof navigator.clipboard?.readText === 'function') {
        /* 不调 preventDefault：让原生 paste 事件正常触发。readText 成功后设标志，
         * onNativePaste 在 capture 阶段据此吞掉原生 paste 事件 → 单发。
         * readText 失败（webview 权限拒绝）时不设标志 → 原生 paste 放行 →
         * xterm handlePasteEvent 单发兜底 */
        navigator.clipboard
          .readText()
          .then((text: string) => {
            if (text.length > 0) {
              suppressNativePaste = true;
              if (suppressTimer !== undefined) clearTimeout(suppressTimer);
              /* 300ms 后自动清除标志，避免阻塞后续正常 paste（右键粘贴等） */
              suppressTimer = setTimeout(() => { suppressNativePaste = false; }, 300);
              term.paste(text);
            }
          })
          .catch(() => { /* 权限拒绝：原生 paste 将兜底 */ });
      }
      /* 不安全上下文无 readText：原生 paste 正常触发 → xterm 单发 */
      return false;
    }
    return true;
  };

  /**
   * Capture 阶段 paste 监听器：readText 成功后吞掉原生 paste 事件，防双发。
   *
   * xterm 在 textarea（target）和 element（bubble）各注册一个 paste 监听器，都在
   * bubble 阶段。本监听器在 element 上以 capture: true 注册，先于 xterm 的监听器
   * 触发。标志有效时 stopImmediatePropagation + preventDefault 吞掉事件，xterm 的
   * handlePasteEvent 不再触发。标志无效时放行，xterm 正常处理。
   */
  const onNativePaste = (ev: ClipboardEvent): void => {
    if (suppressNativePaste) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      suppressNativePaste = false;
      if (suppressTimer !== undefined) { clearTimeout(suppressTimer); suppressTimer = undefined; }
    }
  };

  return { copySelection, pasteClipboard, onCustomKey, onNativePaste };
}
