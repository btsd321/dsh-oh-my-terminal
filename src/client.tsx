/**
 * @file 远端终端插件浏览器半入口
 * @description 独立 dsh 插件 `dsh-oh-my-terminal` 的浏览器入口。在远端 dsh 页面的
 *              对话区底部注册终端面板（`conversation.input.dock` 槽），每个 tab 独立
 *              WebSocket 连接到一个 node-pty PTY 会话。支持多 tab、快捷键切换、拖拽调高、
 *              会话恢复（dsh 重启后恢复历史 tab）、可配置 shell 命令与终端种类选择。
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
 * - 多 tab：+ 新建、✕ 关闭、⟳ 重启；切 tab 不中断进程
 * - 会话恢复：挂载时 GET /sessions 恢复所有 tab（含已退出的历史）
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
// 纯函数工具模块——esbuild 打包浏览器 bundle 时会把 shortcut.ts 内联进 client.js
import { parseShortcut, matchesShortcut, type ShortcutSpec } from './shortcut.js';

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

/** 面板高度在 localStorage 里的键名 */
const HEIGHT_KEY = 'dsh-remote-terminal.height';

/** 面板最小高度（像素） */
const MIN_HEIGHT = 120;

/** 面板最大高度占视口的百分比（拖拽上限） */
const MAX_HEIGHT_RATIO = 0.78;

/** xterm.css <link> 标签的 id（幂等注入） */
const XTERM_CSS_TAG = 'dsh-remote-terminal-xterm-css';

/** 面板样式 <style> 标签的 id（幂等注入） */
const STYLE_TAG = 'dsh-remote-terminal-styles';

/** 默认面板高度占视口的百分比（首次无 localStorage 时） */
const DEFAULT_HEIGHT_RATIO = 0.36;

// —— CSS 注入（模块级幂等） ——

/* 模块加载时幂等注入 xterm.css 的 <link>：由宿主半的 GET /xterm.css 路由 serve */
if (typeof document !== 'undefined' && document.getElementById(XTERM_CSS_TAG) === null) {
  const link = document.createElement('link');
  link.id = XTERM_CSS_TAG;
  link.rel = 'stylesheet';
  link.href = PREFIX + '/xterm.css';
  document.head.appendChild(link);
}

/* Codex 风格底部面板样式（DSH 设计令牌；终端表面恒深色）。
 * 从参考项目 client-main.js 的 PANEL_CSS 完整复制——定义了所有面板样式类。 */
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
.dshTermTabs{flex:none;box-sizing:border-box;height:36px;display:flex;align-items:center;gap:2px;padding:0 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip)}
.dshTermTabsScroll{flex:1;min-width:0;display:flex;align-items:center;gap:2px;height:100%;overflow-x:auto;scrollbar-width:none}
.dshTermTabsScroll::-webkit-scrollbar{display:none}
.dshTermTabsLead{color:var(--dsw-alias-label-tertiary);flex:none;display:grid;place-items:center;margin-right:2px}
.dshTermTabsState{flex:none;max-width:180px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 6px}
.dshTermTab{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 9px;border-radius:7px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:Inter,var(--dsw-font-family);font-size:12px;font-weight:500;cursor:pointer;flex:none;max-width:200px}
.dshTermTab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshTermTab.isActive{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermTab:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.dshTermTab.isExited{opacity:.5}
.dshTermTab.isExited .dshTermTabLabel{text-decoration:line-through;text-decoration-thickness:1px}
.dshTermTabLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshTermTabLead{display:grid;place-items:center;flex:none;opacity:.7}
.dshTermTabClose{width:20px;height:20px;border:none;background:transparent;color:inherit;border-radius:6px;display:grid;place-items:center;cursor:pointer;padding:0;opacity:0;flex:none}
.dshTermTab:hover .dshTermTabClose,.dshTermTab.isActive .dshTermTabClose{opacity:.65}
.dshTermTabClose:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}
.dshTermNew{width:26px;height:26px;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:7px;display:grid;place-items:center;cursor:pointer;padding:0}
.dshTermNew:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermNew:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.dshTermNew:disabled{cursor:default;opacity:.45}
.dshTermCollapse{flex:none;display:grid;place-items:center;width:26px;height:26px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:7px;cursor:pointer;padding:0}
.dshTermCollapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshTermBody{flex:auto;min-height:0;position:relative;background:#1e2128;box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.dshTermPane{position:absolute;inset:0;display:none;padding:4px 10px 8px;background:#1e2128}
.dshTermPane.isActive{display:block}
.dshTermEmpty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#8b90a0;font-family:Inter,var(--dsw-font-family);font-size:12px}
.dshTermEmptyBtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:#2a2e38;color:#e6e8ee;font-family:Inter,var(--dsw-font-family);font-size:12px;font-weight:500;cursor:pointer}
.dshTermEmptyBtn:hover{background:#343946}
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

// —— API 辅助函数 ——

/**
 * 通用 fetch 封装：拼前缀、检查 ok、解析 JSON。
 *
 * @param path - 路由路径（不含前缀）
 * @param opts - fetch 选项
 * @returns 解析后的 JSON
 * @throws Error 非 2xx 状态码
 */
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(PREFIX + path, opts);
  if (!res.ok) throw new Error('dsh-remote-terminal ' + res.status);
  return (await res.json()) as T;
}

/**
 * POST 封装：JSON body。
 *
 * @param path - 路由路径
 * @param body - 请求体（可选，缺省空对象）
 * @returns 解析后的 JSON
 */
const post = <T,>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

/** DELETE /sessions/:id 的响应体 */
interface DeleteSessionResponse {
  /** 操作是否成功 */
  ok: boolean;
}

/**
 * DELETE 封装：静默失败（会话可能已被远端逐出）。
 *
 * @param path - 路由路径
 */
const del = (path: string): Promise<void> =>
  api<DeleteSessionResponse>(path, { method: 'DELETE' })
    .then(() => { /* 删除成功，无需处理 */ })
    .catch(() => { /* 会话可能已删，幂等 */ });

/** 把 shell 名里的 .exe 后缀去掉，做显示用 */
function prettyShell(s: string | undefined): string {
  return (s ?? 'shell').replace(/\.exe$/i, '');
}

/**
 * 生成 tab 标签：服务端 title 形如 "pwsh.exe #3" → 显示 "pwsh 3"。
 *
 * @param tab - 终端 tab
 * @returns 显示标签
 */
function tabLabel(tab: TerminalTab): string {
  const m = /#(\d+)$/.exec(tab.title ?? '');
  const base = prettyShell(tab.shell);
  return m === null ? base : base + ' ' + m[1];
}

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

// —— 类型定义 ——

/** 一个终端会话的本地状态 */
interface TerminalTab {
  /** 宿主半分配的终端 id */
  id: string;
  /** 服务端返回的标题（形如 "pwsh.exe #3"） */
  title: string | undefined;
  /** shell 名（如 "bash"、"zsh"、"pwsh.exe"） */
  shell: string | undefined;
  /** 会话的工作目录（新建 tab 时继承） */
  cwd: string | null;
  /** 是否已退出（展示为历史 tab，可重启） */
  exited: boolean;
}

/** GET /sessions 响应中的单个会话条目 */
interface SessionEntry {
  /** 终端 id */
  id: string;
  /** 标题 */
  title: string;
  /** shell 名 */
  shell: string;
  /** 工作目录 */
  cwd?: string;
  /** 是否已退出 */
  exited?: boolean;
}

/** GET /sessions 响应体 */
interface SessionsResponse {
  /** 所有会话列表（含已退出的历史） */
  sessions: SessionEntry[];
}

/** POST /sessions 与 POST /sessions/:id/restart 的响应体 */
interface CreateSessionResponse {
  /** 终端 id */
  id: string;
  /** 标题 */
  title: string;
  /** shell 名 */
  shell: string;
  /** 工作目录 */
  cwd?: string;
}

/** 终端种类条目（/config 返回的 terminalTypes 数组元素） */
interface TerminalType {
  /** 种类 id（如 "default"、"bash"、"zsh"） */
  id: string;
  /** 显示标签（如 "默认 Shell"、"Bash"） */
  label: string;
  /** 启动命令（空串表示用默认 shell） */
  command: string;
}

/** GET /config 响应体 */
interface ConfigResponse {
  /** 切换快捷键字符串（如 "ctrl+`"） */
  toggleShortcut?: string;
  /** 配置的 shell 命令 */
  shellCommand?: string;
  /** 可选的终端种类列表 */
  terminalTypes?: TerminalType[];
}

/** 对话区几何信息（面板宽度对齐对话列，不覆盖侧栏） */
interface ConversationGeo {
  /** 对话列左边缘（像素） */
  left: number;
  /** 对话列宽度（像素） */
  width: number;
}

// —— SVG 图标组件（从参考项目完整复制，14/16px 网格） ——

/** 终端图标 14px（bar 引导符） */
function TerminalGlyph14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('rect', { x: 1.35, y: 1.35, width: 11.3, height: 11.3, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.05 }),
    React.createElement('path', { d: 'M4.75 4.9L7.05 7L4.75 9.1', stroke: 'currentColor', strokeWidth: 1.05, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    React.createElement('path', { d: 'M7.75 9.1H10.05', stroke: 'currentColor', strokeWidth: 1.05, strokeLinecap: 'round' }),
  );
}

/** 终端图标 12px（tab 引导符） */
function TerminalGlyph12(): ReactElement {
  return React.createElement(
    'svg',
    { width: 12, height: 12, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('rect', { x: 1.35, y: 1.35, width: 11.3, height: 11.3, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.1 }),
    React.createElement('path', { d: 'M4.75 4.9L7.05 7L4.75 9.1', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    React.createElement('path', { d: 'M7.75 9.1H10.05', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' }),
  );
}

/** 上箭头 14px（折叠态 chevron） */
function ChevronUp14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M11.8486 8.5L11.4238 8.07617L8.69727 5.34863C8.44157 5.09294 8.21562 4.86618 8.01172 4.70215C7.79912 4.53117 7.55595 4.38244 7.25 4.33398C7.08435 4.30778 6.91565 4.30778 6.75 4.33398C6.44405 4.38244 6.20088 4.53117 5.98828 4.70215C5.78438 4.86618 5.55843 5.09294 5.30273 5.34863L2.57617 8.07617L2.15137 8.5L3 9.34863L3.42383 8.92383L6.15137 6.19727C6.42595 5.92268 6.59876 5.75151 6.74023 5.6377C6.87291 5.53096 6.92272 5.52187 6.9375 5.51953C6.97895 5.51297 7.02105 5.51297 7.0625 5.51953C7.07728 5.52187 7.12709 5.53096 7.25977 5.6377C7.40124 5.75151 7.57405 5.92268 7.84863 6.19727L10.5762 8.92383L11 9.34863L11.8486 8.5Z', fill: 'currentColor' }),
  );
}

/** 下箭头 14px（展开态收起按钮） */
function ChevronDown14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z', fill: 'currentColor' }),
  );
}

/** 右箭头 14px */
function ChevronRight14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24849 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z', fill: 'currentColor' }),
  );
}

/** 刷新图标 14px（重启按钮） */
function Refresh14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M1.272 6.21348C1.70645 3.08888 4.59169 0.908064 7.71634 1.34239C8.95495 1.51469 10.0438 2.07331 10.8814 2.87755L11.9458 1.81407C12.1347 1.6255 12.4572 1.75911 12.4575 2.02598V5.08751C12.4574 5.25303 12.3233 5.38731 12.1577 5.38731H9.0972C8.82993 5.38731 8.69629 5.06361 8.88528 4.87462L10.0327 3.72618C9.3732 3.09994 8.52006 2.66569 7.5513 2.53087C5.08313 2.18779 2.80376 3.91044 2.46048 6.37852C2.11747 8.84665 3.84009 11.1261 6.30814 11.4693C8.77612 11.8121 11.0557 10.0896 11.399 7.62148L12.728 7.80531C12.2935 10.9299 9.4083 13.1107 6.28366 12.6764C3.159 12.2421 0.977243 9.35731 1.272 6.21348Z', fill: 'currentColor' }),
  );
}

/** 关闭图标 14px（tab 关闭按钮） */
function Close14(): ReactElement {
  return React.createElement(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z', fill: 'currentColor' }),
  );
}

/** 加号图标 12px（新建终端按钮） */
function Plus12(): ReactElement {
  return React.createElement(
    'svg',
    { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z', fill: 'currentColor' }),
  );
}

// —— TermPane 组件（单个终端面板） ——

/** TermPane 的 props */
interface TermPaneProps {
  /** 本 tab 的会话元数据 */
  tab: TerminalTab;
  /** 是否为当前活跃 tab */
  active: boolean;
  /** 会话退出回调（标记 tab 为 exited） */
  onExit: (id: string) => void;
}

/**
 * 单个终端面板：拥有独立的 xterm Terminal + FitAddon + WebLinksAddon + WebSocket。
 *
 * 挂载时创建终端、连接 WebSocket；WebSocket onmessage 写入终端输出，
 * 终端 onData 回传 stdin。resize 经 onResize 发给宿主半。
 * 切 tab 只切显隐，不中断进程与滚动缓冲。
 *
 * @param props - 终端面板 props
 * @returns 终端容器 div
 */
function TermPane(props: TermPaneProps): ReactElement {
  const { tab, active, onExit } = props;
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
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 10000,
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

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + window.location.host + PREFIX + '/ws/' + tab.id);
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
        onExit(tab.id);
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

    /*
     * Xshell/PuTTY 风格鼠标快捷键：选中文本后释放鼠标即复制；右键粘贴剪贴板。
     *
     * 剪贴板访问双层降级：
     * - navigator.clipboard（Async Clipboard API）快但仅安全上下文（https 或
     *   http://localhost/127.0.0.1）存在。从其他机器经纯 http 打开 GUI——「远程」
     *   场景——它是 undefined 且任何调用抛错。复制因此回落到 legacy
     *   document.execCommand("copy")（经临时 textarea），在不安全上下文也工作。
     * - 读剪贴板没有不安全上下文回落 API，故 navigator.clipboard 缺失时不吞原生
     *   右键菜单：其「粘贴」项喂给聚焦的 xterm textarea，xterm 自身的 paste 事件
     *   转发文本进 shell。Ctrl+V 在终端内各上下文都那样工作。
     */
    const legacyCopy = (text: string): boolean => {
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
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    };
    const writeClipboard = (text: string): void => {
      if (typeof navigator.clipboard?.writeText === 'function') {
        navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
      } else {
        legacyCopy(text);
      }
    };
    const copySelection = (ev: MouseEvent): void => {
      /* 仅左键释放：右键是粘贴，不重复复制 */
      if (ev.button !== 0) return;
      if (!term.hasSelection()) return;
      const text = term.getSelection();
      if (text.length === 0) return;
      writeClipboard(text);
    };
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
          /* 权限拒绝；Ctrl+V 仍原生粘贴 */
        });
    };
    /* VS Code 风格 Ctrl+Shift+C / Ctrl+Shift+V——仅在 Async Clipboard API 存在时
     * （安全上下文）尝试；按键绝不到达 shell，故 Ctrl+C 保持 SIGINT、Ctrl+V 保持
     * 原生粘贴。 */
    const onCustomKey = (ev: KeyboardEvent): boolean => {
      if (ev.type !== 'keydown') return true;
      if (!(ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey)) return true;
      const k = ev.key.toLowerCase();
      if (k === 'c') {
        if (typeof navigator.clipboard?.writeText === 'function' && term.hasSelection()) {
          writeClipboard(term.getSelection());
        }
        return false;
      }
      if (k === 'v') {
        if (typeof navigator.clipboard?.readText === 'function') {
          navigator.clipboard
            .readText()
            .then((text: string) => {
              if (text.length > 0) term.paste(text);
            })
            .catch(() => { /* 权限拒绝 */ });
        }
        return false;
      }
      return true;
    };
    term.attachCustomKeyEventHandler(onCustomKey);
    if (term.element !== undefined) {
      term.element.addEventListener('mouseup', copySelection);
      term.element.addEventListener('contextmenu', pasteClipboard);
    }

    return () => {
      if (term.element !== undefined) {
        term.element.removeEventListener('mouseup', copySelection);
        term.element.removeEventListener('contextmenu', pasteClipboard);
      }
      ws.onclose = null;
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [tab.id, onExit]);

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

// —— TerminalPanel 组件（主面板） ——

/** TerminalPanel 的 props（从 dsh 框架注入） */
interface TerminalPanelProps {
  /** 当前 dsh 会话 id（新建 tab 时传给宿主半回查工作区） */
  sessionId?: string;
  /** dsh 会话状态选择器（读取 cwd） */
  useSessions?: <T,>(selector: (s: unknown) => T) => T;
  /** dsh 工作区状态选择器（读取工作区路径） */
  useWorkspaces?: <T,>(selector: (s: unknown) => T) => T;
}

/**
 * Codex 风格底部终端面板：折叠态 34px bar，展开态全宽可拖拽面板。
 * Ctrl+` 切换（默认，可配置）。高度跨刷新持久化。
 *
 * @param props - dsh 框架注入的 props
 * @returns 面板根元素
 */
function TerminalPanel(props: TerminalPanelProps): ReactElement {
  const { useEffect, useRef, useState, useCallback, useLayoutEffect } = React;
  const { sessionId, useSessions, useWorkspaces } = props ?? {};

  /** 面板是否展开 */
  const [open, setOpen] = useState(false);
  /*
   * 本面板挂载所在的 DSH 会话的 cwd。优先工作区成员（用户屏幕所见——会话所在的
   * 工作区），然后会话摘要 cwd，再然后父会话 cwd（子 agent 行无自身 cwd）。新 tab
   * 在此生成而非服务端 process.cwd()，使服务重启不再把新终端困在启动目录。所属
   * sessionId 也随每次创建请求发送，宿主半在所有客户端查询落空时回退到工作区注册表。
   */
  const workspacePath = useWorkspaces?.((s: unknown) => {
    const state = s as { items?: Array<{ sessionIds?: string[]; path?: string }> };
    return Array.isArray(state?.items)
      ? state.items.find(w => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sessionId ?? ''))?.path
      : undefined;
  });
  const sessionCwd = useSessions?.((s: unknown) => {
    const state = s as {
      byId?: Record<string, { cwd?: string; parentId?: string }>;
    };
    const row = state?.byId?.[sessionId ?? ''];
    if (typeof row?.cwd === 'string' && row.cwd.length > 0) return row.cwd;
    if (typeof row?.parentId === 'string') {
      const parent = state.byId?.[row.parentId];
      if (typeof parent?.cwd === 'string' && parent.cwd.length > 0) return parent.cwd;
    }
    return undefined;
  });
  const workspaceCwd = typeof workspacePath === 'string' && workspacePath.length > 0
    ? workspacePath
    : sessionCwd;

  /** tabs: [{id, title, shell, cwd, exited}] 按 strip 顺序 */
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  /** 当前活跃 tab id */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 操作进行中（禁用按钮） */
  const [busy, setBusy] = useState(false);

  /** 面板切换快捷键（从宿主 /config 响应解析） */
  const DEFAULT_SHORTCUT = parseShortcut('ctrl+`');
  const [shortcut, setShortcut] = useState<ShortcutSpec | null>(DEFAULT_SHORTCUT);
  const shortcutLabel = shortcut?.label ?? 'Ctrl+`';

  /** 面板高度（像素），从 localStorage 恢复 */
  const [height, setHeight] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY));
      if (Number.isFinite(saved) && saved >= MIN_HEIGHT) return saved;
    } catch { /* storage 不可用 */ }
    return Math.round(window.innerHeight * DEFAULT_HEIGHT_RATIO);
  });
  const heightRef = useRef(height);
  heightRef.current = height;

  /** 恢复已完成标记（防止 React 18 严格模式双执行重复拉取） */
  const bootOnce = useRef(false);
  /** 启动恢复完成（tab 列表就绪） */
  const [bootReady, setBootReady] = useState(false);
  /** 首次打开已处理标记（关闭最后一个 tab 不自动新建，只有全新打开才建） */
  const openHandled = useRef(false);
  /** 根元素 ref（测量几何用） */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 对话列几何（面板不覆盖侧栏） */
  const [geo, setGeo] = useState<ConversationGeo>({ left: 0, width: window.innerWidth });

  /*
   * 终端 bar/panel 固定在视口底部；持有 textarea 的 composer 卡片获得等于面板高度
   * 的 margin-bottom，使输入框始终在终端上方——折叠 bar（34px）和展开面板 alike。
   */
  useLayoutEffect(() => {
    const rootEl = rootRef.current;
    if (rootEl === null) return;
    const host = (): HTMLElement => rootEl.closest('[data-conversation-scroll]') ?? rootEl.parentElement as HTMLElement;
    const findComposer = (): HTMLElement | null => {
      let el: HTMLElement | null = rootEl.parentElement;
      while (el !== null && el !== document.body) {
        if (el.querySelector('textarea') !== null) return el;
        el = el.parentElement;
      }
      return null;
    };
    let card: HTMLElement | null = null;
    const measure = (): void => {
      const el = host();
      if (el !== null) {
        const r = el.getBoundingClientRect();
        setGeo({ left: r.left, width: r.width });
      }
      const h = Math.round(rootEl.getBoundingClientRect().height);
      if (card !== null) card.style.marginBottom = h > 0 ? h + 'px' : '';
    };
    card = findComposer();
    const el = host();
    const ro = new ResizeObserver(measure);
    if (el !== null) ro.observe(el);
    ro.observe(rootEl);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      if (card !== null) card.style.marginBottom = '';
    };
  }, []);

  const active = tabs.find(t => t.id === activeId) ?? null;

  /*
   * 每次挂载恢复存活会话（页面加载、工作区切换）：面板按对话注入，切换工作区会
   * 重挂本组件，tabs/open 会丢——bar 显示「无会话」但宿主仍持有 PTY。在此恢复
   * （只 attach，绝不 create——无人打开的挂载不产孤儿 PTY）；创建在下方 open
   * effect 里。
   */
  useEffect(() => {
    if (bootOnce.current) return;
    bootOnce.current = true;
    void (async (): Promise<void> => {
      setBusy(true);
      try {
        const list = await api<SessionsResponse>('/sessions');
        /* 恢复宿主仍知的所有会话：存活 PTY 与已退出历史（跨 dsh web 重启持久化）。
         * 已退出 tab 经 WS 回放滚动缓冲并显示为可重启。 */
        const all = list.sessions ?? [];
        if (all.length > 0) {
          setTabs(all.map((x): TerminalTab => ({
            id: x.id,
            title: x.title,
            shell: x.shell,
            cwd: typeof x.cwd === 'string' ? x.cwd : null,
            exited: !!x.exited,
          })));
          const lastLive = [...all].reverse().find(x => !x.exited);
          setActiveId((lastLive ?? all[all.length - 1]).id);
        }
      } catch (err) {
        console.error('[dsh-remote-terminal] 恢复会话失败:', err);
      } finally {
        setBusy(false);
        setBootReady(true);
      }
    })();
  }, []);

  /* 首次打开且无恢复的 tab：创建一个会话。openHandled 守卫使关闭最后一个 tab
   * 不自动新建——只有全新打开才建。 */
  useEffect(() => {
    if (!open) {
      openHandled.current = false;
      return;
    }
    if (!bootReady || tabs.length > 0 || openHandled.current) return;
    openHandled.current = true;
    void newTab();
  }, [open, bootReady, tabs.length]);

  /*
   * 拉取宿主半插件配置：切换快捷键（及未来用的 shell 命令）。路由缺失时（旧宿主）
   * 回落默认值。
   */
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const cfg = await api<ConfigResponse>('/config');
        if (typeof cfg.toggleShortcut === 'string' && cfg.toggleShortcut.trim().length > 0) {
          const parsed = parseShortcut(cfg.toggleShortcut);
          if (parsed !== null) setShortcut(parsed);
          else console.warn('[dsh-remote-terminal] 忽略无效的 toggleShortcut:', cfg.toggleShortcut);
        }
      } catch {
        /* 旧宿主无 /config——保持默认 */
      }
    })();
  }, []);

  /*
   * 可配置切换快捷键（默认 Ctrl+`，如 ctrl+j）。当快捷键是终端也消费的控制字符
   * （Ctrl+J 是 shell 的换行），终端 pane 内的聚焦按键留给 shell 而非切换面板。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!matchesShortcut(shortcut, e)) return;
      if (e.target instanceof HTMLElement && e.target.closest('.dshTermPane') !== null) return;
      e.preventDefault();
      setOpen(v => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  /** 会话退出回调：标记对应 tab 为 exited */
  const onExit = useCallback((id: string): void => {
    setTabs(cur => cur.map(t => (t.id === id ? { ...t, exited: true } : t)));
  }, []);

  /*
   * + 按钮：在当前工作区新开会话，开新 tab。sessionId 随行使宿主半在客户端 cwd
   * 查询失败时经 DSH 工作区注册表解析工作区路径。
   *
   * 终端种类选择接口预留：可选传 shell（终端种类 id，如 "bash"/"zsh"）或
   * cmdline（完整启动命令）；v1 默认不传，用宿主半配置的默认 shell。未来在 +
   * 按钮旁加下拉选择时传入 /config 返回的 terminalTypes 对应 id 即可。
   *
   * @param shell - 终端种类 id（可选，缺省用默认 shell）
   * @param cmdline - 完整启动命令（可选，优先于 shell）
   */
  const newTab = useCallback(async (shell?: string, cmdline?: string): Promise<void> => {
    setBusy(true);
    try {
      const cwd = workspaceCwd ?? active?.cwd ?? null;
      const body: Record<string, unknown> = { cwd, sessionId };
      /* 终端种类选择：传 shell 或 cmdline 让宿主半按指定种类创建 PTY */
      if (typeof shell === 'string' && shell.length > 0) body.shell = shell;
      if (typeof cmdline === 'string' && cmdline.length > 0) body.cmdline = cmdline;
      const s = await post<CreateSessionResponse>('/sessions', body);
      setTabs(cur => [...cur, {
        id: s.id,
        title: s.title,
        shell: s.shell,
        cwd: s.cwd ?? cwd,
        exited: false,
      }]);
      setActiveId(s.id);
    } catch (err) {
      console.error('[dsh-remote-terminal] 新建 tab 失败:', err);
    } finally {
      setBusy(false);
    }
  }, [workspaceCwd, active?.cwd, sessionId]);

  /** ✕ 按钮关闭 tab：删会话、移 tab、激活邻居 */
  const closeTab = useCallback(async (id: string): Promise<void> => {
    setTabs(cur => {
      const idx = cur.findIndex(t => t.id === id);
      if (idx === -1) return cur;
      const next = cur.filter(t => t.id !== id);
      setActiveId(act => {
        if (act !== id) return act;
        if (next.length === 0) return null;
        return (next[Math.min(idx, next.length - 1)] ?? next[0]).id;
      });
      return next;
    });
    await del('/sessions/' + id);
  }, []);

  /*
   * 头部刷新：经宿主 restart 路由原位重启活跃 tab——重新生成 shell 并继承旧滚动
   * 缓冲，终端保留历史与标签名（服务端会话计数器每次生成递增，用新 title 会显得
   * "zsh 1 → zsh 2 → zsh 3"，像新建而非重启）。只有 + 按钮追加真新 tab。
   */
  const restartActive = useCallback(async (): Promise<void> => {
    if (active === null) return;
    setBusy(true);
    try {
      /* 优先用 tab 自身持久化的 cwd（tab 可能属于非当前屏幕工作区）；无持久化 cwd
       * 的遗留 tab 回落当前工作区。 */
      const s = await post<CreateSessionResponse>(
        '/sessions/' + active.id + '/restart',
        { cwd: active.cwd ?? workspaceCwd },
      );
      setTabs(cur => cur.map(t => (t.id === active.id ? {
        id: s.id,
        title: active.title,
        shell: s.shell,
        cwd: s.cwd ?? active.cwd ?? workspaceCwd ?? null,
        exited: false,
      } : t)));
      setActiveId(s.id);
    } catch (err) {
      console.error('[dsh-remote-terminal] 重启失败:', err);
    } finally {
      setBusy(false);
    }
  }, [active, workspaceCwd]);

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

  /** 切换展开/折叠 */
  const toggle = useCallback((): void => setOpen(v => !v), []);

  /** 状态标签（bar 与 tabs 栏共用） */
  const stateLabel = busy
    ? '启动中…'
    : active === null
      ? (tabs.length === 0 ? '无会话' : '空闲')
      : (active.exited ? tabLabel(active) + ' 已退出，点 ⟳ 重启' : tabLabel(active));

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
        /* 单合并头行：引导符 + 可滚动 tabs + 新建 + 状态 + 重启 + 收起 */
        React.createElement(
          'div',
          { className: 'dshTermTabs' },
          React.createElement('span', { className: 'dshTermTabsLead', 'aria-hidden': true }, TerminalGlyph14()),
          React.createElement(
            'div',
            { className: 'dshTermTabsScroll', role: 'tablist' },
            ...tabs.map(t =>
              React.createElement(
                'button',
                {
                  key: t.id,
                  role: 'tab',
                  'aria-selected': t.id === activeId,
                  className: 'dshTermTab' + (t.id === activeId ? ' isActive' : '') + (t.exited ? ' isExited' : ''),
                  title: t.exited ? tabLabel(t) + ' (已退出)' : tabLabel(t),
                  onClick: () => setActiveId(t.id),
                },
                React.createElement('span', { className: 'dshTermTabLead', 'aria-hidden': true }, TerminalGlyph12()),
                React.createElement('span', { className: 'dshTermTabLabel' }, tabLabel(t)),
                React.createElement(
                  'span',
                  {
                    className: 'dshTermTabClose',
                    role: 'button',
                    title: '关闭 ' + tabLabel(t),
                    onClick: (e: React.MouseEvent) => {
                      e.stopPropagation();
                      void closeTab(t.id);
                    },
                  },
                  Close14(),
                ),
              ),
            ),
          ),
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
          React.createElement('span', { className: 'dshTermTabsState', title: stateLabel }, stateLabel),
          /* 重启对已退出历史 tab 也需可达 */
          active !== null
            ? React.createElement(
              'button',
              {
                className: 'dshTermBarAction',
                title: active.exited ? '重启进程（保留标签位）' : '重启当前会话',
                'aria-label': '重启当前会话',
                disabled: busy,
                onClick: () => { void restartActive(); },
              },
              Refresh14(),
            )
            : null,
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
        React.createElement(
          'div',
          { className: 'dshTermBody' },
          ...tabs.map(t =>
            React.createElement(TermPane, {
              key: t.id,
              tab: t,
              active: t.id === activeId,
              onExit,
            }),
          ),
          tabs.length === 0
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
        React.createElement('span', { className: 'dshTermBarTitle' }, '终端' + (tabs.length > 1 ? ' · ' + tabs.length : '')),
        React.createElement('span', { className: 'dshTermBarState' }, stateLabel),
        React.createElement(
          'span',
          { className: 'dshTermBarActions', onClick: (e: React.MouseEvent) => e.stopPropagation() },
          active !== null
            ? React.createElement(
              'button',
              {
                className: 'dshTermBarAction',
                title: active.exited ? '重启进程（保留标签位）' : '重启当前会话',
                'aria-label': '重启当前会话',
                disabled: busy,
                onClick: () => { void restartActive(); },
              },
              Refresh14(),
            )
            : null,
        ),
        React.createElement('span', { className: 'dshTermBarChevron', 'aria-hidden': true }, ChevronUp14()),
      ),
  );
}

export { TerminalPanel };
