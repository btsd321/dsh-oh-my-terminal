/**
 * @file 终端面板核心组件模块
 * @description 包含 TermPane（单个 xterm.js 终端面板）与 RestartButton（重启按钮）
 *              两个 React 组件。TermPane 拥有独立的 Terminal + FitAddon + WebLinksAddon
 *              + WebSocket 连接，负责终端渲染、stdin/stdout 双向通信、resize 同步与
 *              剪贴板操作。RestartButton 是展开态头部与折叠态 bar 共用的重启按钮。
 *
 *              本模块从 client.tsx 提取，降低主文件行数，聚焦终端实例的生命周期管理。
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TerminalInstance } from './types.js';
import { createClipboardHandlers } from './clipboard.js';
import { Refresh14 } from './icons.js';
import {
  PREFIX, TERM_FONT_FAMILY, TERM_FONT_SIZE, TERM_LINE_HEIGHT, TERM_SCROLLBACK, TERM_THEME,
} from './styles.js';

// —— TermPane 组件 ——

/** TermPane 的 props */
export interface TermPaneProps {
  /** 本终端实例的元数据 */
  instance: TerminalInstance;
  /** 是否为当前活跃实例 */
  active: boolean;
  /** 终端字体族（空串 = 内置默认字体栈）；经 Config 下发，支持运行期热更新 */
  fontFamily: string;
  /** 终端字号（像素）；undefined = 用内置默认值；支持运行期热更新 */
  fontSize: number | undefined;
  /** 终端行高倍数；undefined = 用内置默认值；支持运行期热更新 */
  lineHeight: number | undefined;
  /** 会话退出回调（标记实例为 exited） */
  onExit: (id: string) => void;
  /**
   * 是否始终可见（拆分组内的 pane 为 true）。
   *
   * 拆分组内所有 pane 水平并排同时显示，非活跃 pane 也需要 fit 与响应 resize
   *（参考 VSCode 的 SplitPaneContainer.layout：遍历所有子 pane 调用
   * instance.layout()，不按 active 过滤）。
   *
   * 单实例组（多 tab 切换）为 false：非活跃 tab 用 display:none 隐藏，
   * 不 fit（display:none 的容器 fit 会算出 0 尺寸，参考 VSCode
   * TerminalInstance.layout 的 `dimension.width <= 0` 守卫）。
   */
  alwaysVisible?: boolean;
}

/**
 * 单个终端面板：拥有独立的 xterm Terminal + FitAddon + WebLinksAddon + WebSocket。
 *
 * 挂载时创建终端、连接 WebSocket；WebSocket onmessage 写入终端输出，
 * 终端 onData 回传 stdin。resize 经 onResize 发给宿主半。
 * 切实例只切显隐，不中断进程与滚动缓冲。
 *
 * @param props - 终端面板 props
 * @returns 终端容器 div
 */
export function TermPane(props: TermPaneProps): ReactElement {
  const { instance, active, onExit, fontFamily, fontSize, lineHeight, alwaysVisible = false } = props;
  const { useEffect, useRef } = React;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  /* 挂载：创建终端、连接 WS */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    /*
     * TUI agent 调优选项（codex / claude code）：
     * - unicodeVersion "11"：现代 CJK/emoji 宽度表——中英混合 agent 输出不重叠错位
     * - drawBoldTextInBrightColors false：粗体保持真实 ANSI 颜色
     *   （true 会把粗红换成亮红——Claude Code 标题漂色）
     * - scrollback 10000：agent 会话有大量工具输出
     * - CJK 字体回退使中文不脱离等宽栈
     */
    /*
     * unicodeVersion 是 xterm 的提议 API（类型定义未收录但运行时有效）——
     * 用类型断言绕过类型检查（对齐参考项目 client-main.js 的用法）。设 "11"
     * 启用现代 CJK/emoji 宽度表，使中英混合 agent 输出不重叠错位。
     * 必须在构造时传入（init-only 选项），故用构造参数类型断言。
     */
    const term = new Terminal({
      cursorBlink: true,
      /* 字体族/字号/行高经 Config（或 env）下发，空串/缺省回落内置默认——字体栈
       * 最前放本机 Nerd Font（如 Maple Mono NF CN）即可正确显示图标字形 */
      fontFamily: fontFamily !== '' ? fontFamily : TERM_FONT_FAMILY,
      fontSize: fontSize ?? TERM_FONT_SIZE,
      lineHeight: lineHeight ?? TERM_LINE_HEIGHT,
      scrollback: TERM_SCROLLBACK,
      drawBoldTextInBrightColors: false,
      theme: TERM_THEME,
      /* unicodeVersion 是运行时有效的提议属性，类型定义未收录——经断言补入 */
      unicodeVersion: '11',
    } as ConstructorParameters<typeof Terminal>[0]);
    const fit = new FitAddon();
    term.loadAddon(fit);
    /* Ctrl+click（macOS Cmd+click）在新标签打开 http(s) 链接。
     * 普通点击仍选中文本，不窃取选区。 */
    term.loadAddon(new WebLinksAddon((_event: MouseEvent, uri: string) => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    term.open(host);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch { /* 零尺寸守卫 */ }
    });
    termRef.current = term;
    fitRef.current = fit;

    /*
     * DSH 桌面端页面运行在自定义协议 dsh-app://app/ 下，window.location.host
     * 返回 "app" 而非实际后端地址。DSH 通过 window.__DSH_TRANSPORT__.streamBaseUrl
     * 注入真实后端 HTTP origin（如 http://127.0.0.1:19387），Gateway 的 WebSocket
     * 也用此 origin。回退到 window.location.origin 兼容纯浏览器部署。
     */
    const transportGlobals = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } };
    const wsOrigin = transportGlobals.__DSH_TRANSPORT__?.streamBaseUrl ?? window.location.origin;
    const wsProto = wsOrigin.startsWith('https') ? 'wss:' : 'ws:';
    const wsHost = wsOrigin.replace(/^https?:\/\//, '');
    const wsUrl = wsProto + '//' + wsHost + PREFIX + '/ws/' + instance.id;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      /* 挂载 effect 的 fit() 在 rAF 里跑，可能先于 socket 打开——此时 onResize 被
       * 丢弃（readyState !== OPEN），PTY 停在生成默认值（80x24）。连接后重放当前
       * 尺寸让 shell 按面板真实大小重绘——否则 PSReadLine 的「清除 prompt 下方行」
       * 序列在矮面板里溢出，光标滞留底行。 */
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    ws.onmessage = (ev: MessageEvent) => {
      term.write(ev.data as string);
    };
    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
        onExit(instance.id);
      }
    };
    ws.onerror = () => ws.close();
    wsRef.current = ws;
    term.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    /* 剪贴板：选中复制、右键粘贴、Ctrl+Shift+C/V（双层降级逻辑见 client/clipboard.ts） */
    const cb = createClipboardHandlers(term);
    term.attachCustomKeyEventHandler(cb.onCustomKey);
    if (term.element !== undefined) {
      term.element.addEventListener('mouseup', cb.copySelection);
      term.element.addEventListener('contextmenu', cb.pasteClipboard);
    }

    return () => {
      if (term.element !== undefined) {
        term.element.removeEventListener('mouseup', cb.copySelection);
        term.element.removeEventListener('contextmenu', cb.pasteClipboard);
      }
      ws.onclose = null;
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [instance.id, onExit]);

  /* 字体热更新：fontFamily/fontSize/lineHeight 变更时更新 xterm options 并重算尺寸 */
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (term === null || fit === null) return;
    
    /* 解析生效值：空串/undefined 回落内置默认 */
    const effectiveFamily = fontFamily !== '' ? fontFamily : TERM_FONT_FAMILY;
    const effectiveSize = fontSize ?? TERM_FONT_SIZE;
    const effectiveLineHeight = lineHeight ?? TERM_LINE_HEIGHT;
    
    /* 只在值真正变化时更新（避免初始挂载时重复设置） */
    let changed = false;
    if (term.options.fontFamily !== effectiveFamily) {
      term.options.fontFamily = effectiveFamily;
      changed = true;
    }
    if (term.options.fontSize !== effectiveSize) {
      term.options.fontSize = effectiveSize;
      changed = true;
    }
    if (term.options.lineHeight !== effectiveLineHeight) {
      term.options.lineHeight = effectiveLineHeight;
      changed = true;
    }
    
    if (changed) {
      /* clearTextureAtlas 清除字体测量缓存，让 xterm 用新字体重测字符尺寸 */
      term.clearTextureAtlas();
      /* 重新 fit 让行列数按新字符尺寸重算，避免 PTY 尺寸与渲染错位 */
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch { /* 面板可能已卸载 */ }
      });
    }
  }, [fontFamily, fontSize, lineHeight]);

  /* 激活：fit（尺寸可能已变）+ 聚焦 */
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch { /* 未挂载 */ }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  /* 随面板 resize：始终可见的 pane（拆分组）始终响应 resize，
   * 单实例组的 pane 只有可见（active）时才 fit——display:none 的容器
   * fit 会算出 0 尺寸（参考 VSCode TerminalInstance.layout 的
   * `dimension.width <= 0` 守卫），所以非活跃 tab 不 fit */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      /* alwaysVisible 的拆分 pane 始终 fit；否则仅 active 时 fit */
      if (!active && !alwaysVisible) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        /* 零尺寸守卫：display:none 或未挂载的容器 clientWidth/Height 为 0，
         * fit 会算出 0 列 0 行导致 PTY 尺寸错乱（参考 VScode
         * TerminalInstance.layout 的 dimension 守卫） */
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        try {
          fitRef.current?.fit();
        } catch { /* 未挂载 */ }
      });
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active, alwaysVisible]);

  return React.createElement('div', {
    className: 'dshTermPane' + (active ? ' isActive' : ''),
    ref: hostRef,
    onMouseDown: () => {
      if (active) termRef.current?.focus();
    },
  });
}

// —— RestartButton 组件 ——

/** RestartButton 的 props */
export interface RestartButtonProps {
  /** 当前活跃实例（为 null 时不渲染按钮） */
  active: TerminalInstance | null;
  /** 操作进行中（禁用按钮） */
  busy: boolean;
  /** 重启回调 */
  onRestart: () => void;
}

/**
 * 重启按钮：展开态头部与折叠态 bar 共用。
 *
 * 已退出实例的 title 提示「重启进程（保留标签位）」，活跃态提示「重启当前会话」。
 *
 * @param props - 重启按钮 props
 * @returns 按钮元素，无活跃实例时返回 null
 */
export function RestartButton(props: RestartButtonProps): ReactElement | null {
  const { active, busy, onRestart } = props;
  if (active === null) return null;
  return React.createElement(
    'button',
    {
      className: 'dshTermBarAction',
      title: active.exited ? '重启进程（保留标签位）' : '重启当前会话',
      'aria-label': '重启当前会话',
      disabled: busy,
      onClick: onRestart,
    },
    Refresh14(),
  );
}
