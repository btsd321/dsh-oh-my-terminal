/**
 * @file 远端终端插件浏览器半入口
 * @description 独立 dsh 插件 `dsh-oh-my-terminal` 的浏览器入口。在远端 dsh 页面的
 *              对话区底部注册终端面板（`conversation.input.dock` 槽），每个终端实例独立
 *              WebSocket 连接到一个 node-pty PTY 会话。支持多终端、拆分终端（Group）、
 *              快捷键切换、拖拽调高、会话恢复（dsh 重启后恢复历史）、可配置 shell 命令
 *              与终端种类选择。VSCode 风格右侧终端列表 + 下拉菜单。
 *              xterm.js 6 渲染，Campbell 暗色主题。
 *
 *              终端输入/输出数据绝不进日志。
 *
 * 架构对齐参考项目 dsh-plugin-terminal：
 * - node-pty PTY 替代 script 命令，原生 resize 支持
 * - WebSocket 实时双向通信替代 HTTP 轮询
 * - 底部固定面板（折叠态 34px bar，展开态向上生长）
 * - 拖拽 grip 调整高度（120px–78% 视口，localStorage 记忆）
 * - 快捷键切换（默认 Ctrl+`，从 /config 读取）
 * - 多终端：+ 新建、✕ 关闭、⟳ 重启；切终端不中断进程
 * - 拆分终端：同一 Group 内水平并排显示多个实例
 * - 右侧终端列表：垂直列表替代水平 tab 栏
 * - 下拉菜单：+号旁倒三角按钮弹出操作菜单
 * - 会话恢复：挂载时 GET /sessions 恢复所有终端（含已退出的历史）
 *
 * 模块结构（按关注点拆分到 src/client/ 子目录，消除 God Component）：
 * - `client/types.ts` — 共享类型定义（TerminalInstance, TerminalGroup, API 响应等）
 * - `client/icons.tsx` — SVG 图标组件集合
 * - `client/clipboard.ts` — 剪贴板纯函数（Async Clipboard API + legacy 回落）
 * - `client/dropdown.tsx` — +号旁下拉菜单组件
 * - `client/side-list.tsx` — 右侧终端列表面板组件
 * - `client/hooks.ts` — 自定义 Hooks（usePanelHeight/usePanelGeometry/useSessionRestore/usePanelShortcut/useTerminalTabs）
 * - 本文件保留：TermPane（xterm + WebSocket 核心）、RestartButton、TerminalPanel（组合壳）、CSS 注入、插件注册
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
// 子模块导入——esbuild 打包浏览器 bundle 时内联进 client.js
import type {
  TerminalInstance, TerminalGroup, TerminalType,
  ConfigResponse, ConversationGeo,
} from './client/types.js';
import {
  TerminalGlyph14, TerminalGlyph12,
  ChevronUp14, ChevronDown14,
  Refresh14, Close14, Plus12,
} from './client/icons.js';
import { createClipboardHandlers } from './client/clipboard.js';
import { DropdownMenu } from './client/dropdown.js';
import { SideList, instanceLabel } from './client/side-list.js';
import {
  usePanelHeight, usePanelGeometry,
  useSessionRestore, usePanelShortcut, useTerminalTabs,
} from './client/hooks.js';
import { createLogger } from './logger.js';

const log = createLogger('terminal-client');

// —— dsh 客户端 slots 服务类型 ——
// dsh-client-ui-slots 与 dsh-client-ui-renderer 是 dsh 浏览器 bundle 运行期注入的
// 服务，非可安装的 npm 包。独立插件无法 import 它们的类型——用本地接口声明
// slots 服务的最小形状，使 ctx.slots.inject/register 通过类型检查。
// esbuild 打包浏览器 bundle 时这些类型声明整体擦除，运行期 slots 实例由 dsh 提供。

/** 槽位注册参数（dsh-client-ui-slots 的 SlotRegisterOptions 最小子集） */
interface SlotRegisterOptions {
  /** 槽位命名空间名 */
  name: string;
  /** 本条目 id（在同一槽内唯一） */
  id: string;
  /** 排序权重（小者先） */
  order: number;
}

/** slots 服务的最小接口（完整定义见 @deepseek-ai/dsh-client-ui-slots） */
interface SlotsService {
  /** 向指定槽位注入一个条目工厂 */
  inject(slot: string, factory: () => unknown): unknown;
  /** 注册一个槽位条目（返回 disposer） */
  register(options: SlotRegisterOptions, component: unknown): unknown;
}

/** 扩展了 slots 属性的 cordis 客户端上下文 */
interface ClientContext extends Context {
  /** dsh 浏览器端的 slots 服务——注入对话区底部面板槽 */
  slots: SlotsService;
}

// —— 常量 ——

/** 宿主半路由前缀（与 index.ts 的 ROUTE_PREFIX 同源——独立插件直接用常量） */
const PREFIX = '/api/dsh-remote-terminal';

/** xterm.css <link> 标签的 id（幂等注入） */
const XTERM_CSS_TAG = 'dsh-remote-terminal-xterm-css';

/** 面板样式 <style> 标签的 id（幂等注入） */
const STYLE_TAG = 'dsh-remote-terminal-styles';

/** xterm 字号（像素）——TUI agent 输出密度与可读性的折中 */
const TERM_FONT_SIZE = 12.5;

/** xterm 行高倍数——紧凑但不挤行 */
const TERM_LINE_HEIGHT = 1.25;

/** xterm 滚动缓冲行数——agent 会话有大量工具输出，需要较长历史 */
const TERM_SCROLLBACK = 10_000;

/** 右侧终端列表默认宽度（像素） */
const SIDE_LIST_DEFAULT_WIDTH = 160;

/** 右侧终端列表最小宽度（像素） */
const SIDE_LIST_MIN_WIDTH = 100;

/** 右侧终端列表最大宽度（像素） */
const SIDE_LIST_MAX_WIDTH = 300;

/** 拆分终端最小宽度（像素） */
const SPLIT_PANE_MIN_WIDTH = 80;

// —— CSS 注入（模块级幂等） ——

/* 模块加载时幂等注入 xterm.css 的 <link>：由宿主半的 GET /xterm.css 路由 serve */
if (typeof document !== 'undefined' && document.getElementById(XTERM_CSS_TAG) === null) {
  const link = document.createElement('link');
  link.id = XTERM_CSS_TAG;
  link.rel = 'stylesheet';
  link.href = PREFIX + '/xterm.css';
  document.head.appendChild(link);
}

/* VSCode 风格底部面板样式（DSH 设计令牌；终端表面恒深色）。
 * 定义了所有面板样式类，包括下拉菜单、拆分终端、右侧终端列表。 */
const PANEL_CSS = `.dshTermRoot{position:fixed;bottom:0;z-index:50;font-family:Inter,var(--dsw-font-family)}
.dshTermBar{box-sizing:border-box;width:100%;height:34px;display:flex;align-items:center;gap:10px;padding:0 14px;background:var(--dsw-specific-tip);border-top:1px solid var(--dsw-alias-border-l1);cursor:pointer;color:var(--dsw-alias-label-primary);text-align:left;user-select:none;-webkit-user-select:none}
.dshTermBar:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.dshTermBarLead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}
.dshTermBarTitle{min-width:0;flex:none;font-size:13px;font-weight:500;line-height:24px}
.dshTermBarState{min-width:0;flex:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshTermBarActions{flex:none;align-items:center;gap:2px;display:flex}
.dshTermBarAction{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}
.dshTermBarAction:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshTermBarAction:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.dshTermBarAction:disabled{cursor:default;opacity:.45}
.dshTermBarChevron{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}
.dshTermBarChevron:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermPanel{box-sizing:border-box;width:100%;display:flex;flex-direction:column;background:var(--dsw-specific-tip);border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden;animation:dshTermIn .16s ease-out}
@keyframes dshTermIn{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}
.dshTermResize{flex:none;height:6px;cursor:ns-resize;touch-action:none;position:relative}
.dshTermResize:after{content:'';position:absolute;left:0;right:0;top:2px;height:2px;border-radius:2px;background:transparent;transition:background .15s}
.dshTermResize:hover:after{background:var(--dsw-alias-interactive-bg-hover)}
.dshTermHeader{flex:none;box-sizing:border-box;height:36px;display:flex;align-items:center;gap:6px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip)}
.dshTermHeaderLead{color:var(--dsw-alias-label-tertiary);flex:none;display:grid;place-items:center;margin-right:2px}
.dshTermHeaderState{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 6px}
.dshTermNewWrap{display:inline-flex;align-items:center;flex:none;border-radius:7px}
.dshTermNew{width:26px;height:26px;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);display:grid;place-items:center;cursor:pointer;padding:0}
.dshTermNew:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermNew:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.dshTermNew:disabled{cursor:default;opacity:.45}
.dshTermNewSep{width:1px;height:16px;background:var(--dsw-alias-border-l1);flex:none}
.dshTermDropdownArrow{width:16px;height:26px;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);display:grid;place-items:center;cursor:pointer;padding:0}
.dshTermDropdownArrow:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermDropdownArrow:disabled{cursor:default;opacity:.45}
.dshTermDropdownWrap{position:relative;display:inline-flex;flex:none}
.dshTermDropdownMenu{position:absolute;top:100%;right:0;z-index:100;min-width:160px;padding:4px 0;background:var(--dsw-specific-tip);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.3);white-space:nowrap}
.dshTermDropdownItem{padding:5px 12px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.dshTermDropdownItem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermDropdownSep{height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1)}
.dshTermCollapse{flex:none;display:grid;place-items:center;width:26px;height:26px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:7px;cursor:pointer;padding:0}
.dshTermCollapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermBodyWithList{display:flex;flex-direction:row;flex:auto;min-height:0;position:relative}
.dshTermTerminalArea{flex:1;min-width:0;position:relative;background:#1e2128;box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.dshTermSplitGroup{display:flex;flex-direction:row;height:100%;width:100%}
.dshTermSplitPane{flex:1 1 0;min-width:${SPLIT_PANE_MIN_WIDTH}px;position:relative;overflow:hidden}
.dshTermSplitDivider{width:1px;background:var(--dsw-alias-border-l1);flex:none;cursor:col-resize}
.dshTermPane{position:absolute;inset:0;display:none;padding:4px 10px 8px;background:#1e2128}
.dshTermPane.isActive{display:block}
.dshTermEmpty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#8b90a0;font-family:Inter,var(--dsw-font-family);font-size:12px}
.dshTermEmptyBtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:#2a2e38;color:#e6e8ee;font-family:Inter,var(--dsw-font-family);font-size:12px;font-weight:500;cursor:pointer}
.dshTermEmptyBtn:hover{background:#343946}
.dshTermSideList{width:${SIDE_LIST_DEFAULT_WIDTH}px;min-width:${SIDE_LIST_MIN_WIDTH}px;max-width:${SIDE_LIST_MAX_WIDTH}px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;background:var(--dsw-specific-tip);flex:none;overflow:hidden}
.dshTermSideListHeader{flex:none;height:28px;display:flex;align-items:center;padding:0 8px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshTermSideListItems{flex:auto;overflow-y:auto;scrollbar-width:thin}
.dshTermSideItem{height:28px;display:flex;align-items:center;gap:6px;padding:0 8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);position:relative;user-select:none;-webkit-user-select:none}
.dshTermSideItem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermSideItem.isActive{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-left:2px solid var(--dsw-alias-label-primary)}
.dshTermSideItem.isExited{opacity:.5}
.dshTermSideItem.isExited .dshTermSideItemLabel{text-decoration:line-through;text-decoration-thickness:1px}
.dshTermSideItemIcon{flex:none;display:grid;place-items:center;opacity:.7}
.dshTermSideItemPrefix{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,monospace;width:10px;text-align:center}
.dshTermSideItemLabel{min-width:0;flex:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshTermSideItemClose{width:18px;height:18px;border:none;background:transparent;color:inherit;border-radius:4px;display:grid;place-items:center;cursor:pointer;padding:0;opacity:0;flex:none}
.dshTermSideItem:hover .dshTermSideItemClose{opacity:.65}
.dshTermSideItemClose:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}
body.dshTermResizing{cursor:ns-resize!important;user-select:none!important;-webkit-user-select:none!important}`;

/* 模块加载时幂等注入面板样式 <style> */
if (typeof document !== 'undefined' && document.getElementById(STYLE_TAG) === null) {
  const tag = document.createElement('style');
  tag.id = STYLE_TAG;
  tag.textContent = PANEL_CSS;
  document.head.appendChild(tag);
}

// —— Campbell 暗色主题（对齐参考项目 TERM_THEME） ——

/*
 * 终端表面恒深色：shell 输出颜色（ConPTY 索引、ls/git/PSReadLine）为深底设计——
 * 例如 ConPTY 对 prompt 发 fg-7（#e5e5e5），在浅色卡片上不可见。深色内嵌表面
 * （如聊天中的代码块）让所有 ANSI 颜色在两种 DSH 主题下都可读。
 */
const TERM_THEME: Record<string, string> = {
  foreground: '#d7dae0',
  background: '#1e2128',
  cursor: '#d7dae0',
  cursorAccent: '#1e2128',
  selectionBackground: '#3b4252aa',
  /* Campbell 色相，提亮使每色在 #1e2128 上过 ~4:1 对比度
   * （原版 Campbell 蓝/红/品红仅 2.0–2.7:1——不可读） */
  black: '#0c0c0c',
  red: '#e74856',
  green: '#16c60c',
  yellow: '#c19c00',
  blue: '#3b78ff',
  magenta: '#d64fa8',
  cyan: '#3a96dd',
  white: '#cccccc',
  brightBlack: '#8a8a8a',
  brightRed: '#ff6b6b',
  brightGreen: '#2ee62e',
  brightYellow: '#f9f1a5',
  brightBlue: '#7aa2ff',
  brightMagenta: '#f27fd8',
  brightCyan: '#61d6d6',
  brightWhite: '#f2f2f2',
};

// —— 插件注册壳 ——

/** 插件包名（与 index.ts 的 PKG_NAME 同值） */
export const name = 'dsh-oh-my-terminal';

/** 注入的 cordis 服务：仅需 slots（文案硬编码中文，不走 locale 服务） */
export const inject = ['slots'];

/**
 * 浏览器半激活入口：在对话区底部注册终端面板。
 *
 * @param ctx - 远端页面的 cordis 上下文
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'terminal', order: 10 },
    TerminalPanel,
  ));
}

// —— TermPane 组件（单个终端面板） ——

/** TermPane 的 props */
interface TermPaneProps {
  /** 本终端实例的元数据 */
  instance: TerminalInstance;
  /** 是否为当前活跃实例 */
  active: boolean;
  /** 会话退出回调（标记实例为 exited） */
  onExit: (id: string) => void;
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
function TermPane(props: TermPaneProps): ReactElement {
  const { instance, active, onExit } = props;
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
      fontFamily: "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, Menlo, 'PingFang SC', 'Noto Sans Mono CJK SC', 'Microsoft YaHei', monospace",
      fontSize: TERM_FONT_SIZE,
      lineHeight: TERM_LINE_HEIGHT,
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

  /* 随面板 resize（只有可见 pane 能 fit） */
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!active) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
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
  }, [active]);

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
interface RestartButtonProps {
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
function RestartButton(props: RestartButtonProps): ReactElement | null {
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

// —— TerminalPanel 主组件 ——

/** TerminalPanel 的 props（从 dsh 框架 slot 系统注入） */
interface TerminalPanelProps {
  /** 当前 dsh 会话 id（SessionStandardProps，scope='session' 自动注入） */
  sessionId?: string;
  /** dsh 工作区状态选择器（GlobalStandardProps，所有 slot 自动注入） */
  useWorkspaces?: <T,>(selector: (s: unknown) => T) => T;
}

/**
 * VSCode 风格底部终端面板：折叠态 34px bar，展开态全宽可拖拽面板。
 * 展开态使用右侧终端列表替代水平 tab 栏，+号旁有下拉菜单支持拆分终端。
 * Ctrl+` 切换（默认，可配置）。高度跨刷新持久化。
 *
 * @param props - dsh 框架注入的 props
 * @returns 面板根元素
 */
function TerminalPanel(props: TerminalPanelProps): ReactElement {
  const { useEffect, useRef, useState, useCallback } = React;
  const { sessionId, useWorkspaces } = props ?? {};

  /** 面板是否展开 */
  const [open, setOpen] = useState(false);
  /*
   * 本面板挂载所在的 DSH 会话的工作区路径。通过 useWorkspaces（GlobalStandardProps）
   * 查找当前 sessionId 所属的工作区，取其 path 作为新终端的 cwd。宿主半在客户端 cwd
   * 查询落空时回退到 workspaceRegistry 或 process.cwd()。
   */
  const workspaceCwd = useWorkspaces?.((s: unknown) => {
    const state = s as { items?: Array<{ sessionIds?: string[]; path?: string }> };
    if (!Array.isArray(state?.items) || typeof sessionId !== 'string') return undefined;
    const ws = state.items.find(w => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId));
    return typeof ws?.path === 'string' && ws.path.length > 0 ? ws.path : undefined;
  });

  /* —— 拖拽调高（高度 state + localStorage 持久化） —— */
  const { height, startResize } = usePanelHeight();

  /** 根元素 ref（测量几何用） */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /* —— 对话列几何测量 + scrollBody paddingBottom —— */
  const { geo } = usePanelGeometry(rootRef);

  /* —— 会话恢复（挂载拉取 /sessions） + 实例/组/activeInstanceId/busy state —— */
  const {
    instances, setInstances,
    groups, setGroups,
    activeInstanceId, setActiveInstanceId,
    busy, setBusy, bootReady,
  } = useSessionRestore();

  const activeInstance = instances.find(t => t.id === activeInstanceId) ?? null;
  const activeGroup = groups.find(g => g.instances.some(i => i.id === activeInstanceId)) ?? null;

  /* —— 终端 CRUD（新建/关闭/重启/拆分/退出标记） —— */
  const { newTab, closeTab, restartActive, splitTerminal, onExit } = useTerminalTabs({
    instances, setInstances,
    groups, setGroups,
    activeInstanceId, setActiveInstanceId,
    setBusy, activeInstance, activeGroup,
    workspaceCwd, sessionId,
  });

  /* —— 快捷键（拉取 /config + 全局 keydown 监听切换） —— */
  const { shortcutLabel } = usePanelShortcut(setOpen);

  /* —— 终端种类列表（从 /config 获取） —— */
  const [terminalTypes, setTerminalTypes] = useState<TerminalType[]>([]);
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const cfg = await fetch(PREFIX + '/config').then(r => r.json()) as ConfigResponse;
        if (Array.isArray(cfg.terminalTypes)) {
          setTerminalTypes(cfg.terminalTypes);
        }
      } catch {
        /* 旧宿主无 /config——保持空列表 */
      }
    })();
  }, []);

  /** 首次打开已处理标记（关闭最后一个终端不自动新建，只有全新打开才建） */
  const openHandled = useRef(false);

  /* 首次打开且无恢复的终端：创建一个会话。openHandled 守卫使关闭最后一个终端
   * 不自动新建——只有全新打开才建。 */
  useEffect(() => {
    if (!open) {
      openHandled.current = false;
      return;
    }
    if (!bootReady || instances.length > 0 || openHandled.current) return;
    openHandled.current = true;
    void newTab();
  }, [open, bootReady, instances.length, newTab]);

  /** 切换展开/折叠 */
  const toggle = useCallback((): void => setOpen(v => !v), []);

  /** 状态标签（bar 与头部共用） */
  const stateLabel = busy
    ? '启动中…'
    : activeInstance === null
      ? (instances.length === 0 ? '无会话' : '空闲')
      : (activeInstance.exited ? instanceLabel(activeInstance) + ' 已退出，点 ⟳ 重启' : instanceLabel(activeInstance));

  /** 按种类新建终端 */
  const handleNewByType = useCallback((typeId: string): void => {
    void newTab(typeId);
  }, [newTab]);

  /** 按种类拆分终端 */
  const handleSplitByType = useCallback((typeId: string): void => {
    void splitTerminal(typeId);
  }, [splitTerminal]);

  /** 选择终端实例（从右侧列表点击） */
  const handleSelectInstance = useCallback((instanceId: string): void => {
    setActiveInstanceId(instanceId);
    /* 同时更新该实例所在组的活跃 id */
    setGroups(cur => cur.map(g => {
      if (g.instances.some(i => i.id === instanceId)) {
        return { ...g, activeInstanceId: instanceId };
      }
      return g;
    }));
  }, [setActiveInstanceId, setGroups]);

  return React.createElement(
    'div',
    {
      className: 'dshTermRoot',
      ref: rootRef,
      style: { left: geo.left + 'px', width: geo.width + 'px' },
    },
    open
      ? React.createElement(
        'div',
        { className: 'dshTermPanel', id: 'dshTermPanel', style: { height: height + 'px' } },
        React.createElement('div', {
          className: 'dshTermResize',
          title: '拖动调整高度',
          onPointerDown: startResize,
        }),
        /* 头部：引导符 + 状态 + 新建组合按钮 + 重启 + 收起 */
        React.createElement(
          'div',
          { className: 'dshTermHeader' },
          React.createElement('span', { className: 'dshTermHeaderLead', 'aria-hidden': true }, TerminalGlyph14()),
          React.createElement('span', { className: 'dshTermHeaderState', title: stateLabel }, stateLabel),
          /* 新建组合按钮：+ 主按钮 + 分隔线 + 下拉箭头 */
          React.createElement(
            'div',
            { className: 'dshTermNewWrap' },
            React.createElement(
              'button',
              {
                className: 'dshTermNew',
                title: '新建终端',
                'aria-label': '新建终端',
                disabled: busy,
                onClick: () => { void newTab(); },
              },
              Plus12(),
            ),
            React.createElement('div', { className: 'dshTermNewSep' }),
            React.createElement(DropdownMenu, {
              busy,
              onNewTerminal: () => { void newTab(); },
              onSplitTerminal: () => { void splitTerminal(); },
              terminalTypes,
              onNewByType: handleNewByType,
              onSplitByType: handleSplitByType,
            }),
          ),
          /* 重启对已退出历史终端也需可达 */
          React.createElement(RestartButton, { active: activeInstance, busy, onRestart: () => { void restartActive(); } }),
          React.createElement(
            'button',
            {
              className: 'dshTermCollapse',
              title: '收起面板（' + shortcutLabel + '）',
              'aria-label': '收起面板',
              onClick: toggle,
            },
            ChevronDown14(),
          ),
        ),
        /* Body：左侧终端显示区域 + 右侧终端列表 */
        React.createElement(
          'div',
          { className: 'dshTermBodyWithList' },
          /* 左侧终端显示区域 */
          React.createElement(
            'div',
            { className: 'dshTermTerminalArea' },
            /* 按组渲染终端实例 */
            ...groups.map(g => {
              if (g.instances.length === 1) {
                /* 单实例组：直接渲染 */
                const inst = g.instances[0];
                return React.createElement(TermPane, {
                  key: inst.id,
                  instance: inst,
                  active: inst.id === activeInstanceId,
                  onExit,
                });
              }
              /* 多实例组：水平并排 */
              return React.createElement(
                'div',
                { key: g.id, className: 'dshTermSplitGroup' },
                ...g.instances.flatMap((inst, idx) => {
                  const elements: ReactElement[] = [];
                  if (idx > 0) {
                    elements.push(React.createElement('div', { key: g.id + '-div-' + idx, className: 'dshTermSplitDivider' }));
                  }
                  elements.push(
                    React.createElement(
                      'div',
                      { key: inst.id, className: 'dshTermSplitPane' },
                      React.createElement(TermPane, {
                        instance: inst,
                        active: inst.id === activeInstanceId,
                        onExit,
                      }),
                    ),
                  );
                  return elements;
                }),
              );
            }),
            instances.length === 0
              ? React.createElement(
                'div',
                { className: 'dshTermEmpty' },
                React.createElement('span', null, '没有终端会话'),
                React.createElement(
                  'button',
                  { className: 'dshTermEmptyBtn', onClick: () => { void newTab(); } },
                  Plus12(),
                  '新建终端',
                ),
              )
              : null,
          ),
          /* 右侧终端列表（仅多于一个终端时显示） */
          instances.length > 1
            ? React.createElement(SideList, {
              groups,
              activeInstanceId,
              onSelect: handleSelectInstance,
              onClose: closeTab,
            })
            : null,
        ),
      )
      : React.createElement(
        'div',
        {
          className: 'dshTermBar',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          'aria-controls': 'dshTermPanel',
          title: '终端面板（' + shortcutLabel + ' 切换）',
          onClick: toggle,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          },
        },
        React.createElement('span', { className: 'dshTermBarLead', 'aria-hidden': true }, TerminalGlyph14()),
        React.createElement('span', { className: 'dshTermBarTitle' }, '终端'),
        React.createElement('span', { className: 'dshTermBarState' }, instances.length > 0 ? instances.length + ' 个终端' : '无会话'),
        React.createElement(
          'span',
          { className: 'dshTermBarActions', onClick: (e: React.MouseEvent) => e.stopPropagation() },
          React.createElement(RestartButton, { active: activeInstance, busy, onRestart: () => { void restartActive(); } }),
        ),
        React.createElement('span', { className: 'dshTermBarChevron', 'aria-hidden': true }, ChevronUp14()),
      ),
  );
}

export { TerminalPanel };
