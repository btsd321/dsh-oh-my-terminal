/**
 * @file 终端面板样式与常量模块
 * @description 集中管理浏览器半终端面板的所有 CSS 样式、Campbell 暗色主题配色、
 *              xterm.js 调优常量，以及幂等 CSS 注入逻辑。被 client.tsx 与
 *              term-pane.tsx 引用，自身不依赖任何 React 组件或业务状态。
 *
 *              CSS 注入在模块加载时不会自动执行——由调用方显式调用 injectStyles()，
 *              保证 SSR / Node 环境安全（typeof document 守卫）。
 */

// —— 路由与 DOM 标识常量 ——

/** 宿主半路由前缀（与 index.ts 的 ROUTE_PREFIX 同源——独立插件直接用常量） */
export const PREFIX = '/api/dsh-remote-terminal';

/** xterm.css <link> 标签的 id（幂等注入） */
export const XTERM_CSS_TAG = 'dsh-remote-terminal-xterm-css';

/** 面板样式 <style> 标签的 id（幂等注入） */
export const STYLE_TAG = 'dsh-remote-terminal-styles';

// —— xterm.js 调优常量 ——

/** xterm 字号（像素）——TUI agent 输出密度与可读性的折中 */
export const TERM_FONT_SIZE = 12.5;

/** xterm 行高倍数——紧凑但不挤行 */
export const TERM_LINE_HEIGHT = 1.25;

/** xterm 滚动缓冲行数——agent 会话有大量工具输出，需要较长历史 */
export const TERM_SCROLLBACK = 10_000;

// —— 面板布局常量 ——

/** 右侧终端列表默认宽度（像素） */
export const SIDE_LIST_DEFAULT_WIDTH = 160;

/** 右侧终端列表最小宽度（像素） */
export const SIDE_LIST_MIN_WIDTH = 100;

/** 右侧终端列表最大宽度（像素） */
export const SIDE_LIST_MAX_WIDTH = 300;

/** 拆分终端最小宽度（像素） */
export const SPLIT_PANE_MIN_WIDTH = 80;

// —— Campbell 暗色主题 ——

/*
 * 终端表面恒深色：shell 输出颜色（ConPTY 索引、ls/git/PSReadLine）为深底设计——
 * 例如 ConPTY 对 prompt 发 fg-7（#e5e5e5），在浅色卡片上不可见。深色内嵌表面
 * （如聊天中的代码块）让所有 ANSI 颜色在两种 DSH 主题下都可读。
 */

/** Campbell 暗色主题配色（提亮使每色在 #1e2128 上过 ~4:1 对比度） */
export const TERM_THEME: Record<string, string> = {
  /** 前景色 */
  foreground: '#d7dae0',
  /** 背景色 */
  background: '#1e2128',
  /** 光标颜色 */
  cursor: '#d7dae0',
  /** 光标下方文字颜色 */
  cursorAccent: '#1e2128',
  /** 选区背景色 */
  selectionBackground: '#3b4252aa',
  /* Campbell 色相，提亮使每色在 #1e2128 上过 ~4:1 对比度
   * （原版 Campbell 蓝/红/品红仅 2.0–2.7:1——不可读） */
  /** 标准黑 */
  black: '#0c0c0c',
  /** 标准红 */
  red: '#e74856',
  /** 标准绿 */
  green: '#16c60c',
  /** 标准黄 */
  yellow: '#c19c00',
  /** 标准蓝 */
  blue: '#3b78ff',
  /** 标准品红 */
  magenta: '#d64fa8',
  /** 标准青 */
  cyan: '#3a96dd',
  /** 标准白 */
  white: '#cccccc',
  /** 亮黑 */
  brightBlack: '#8a8a8a',
  /** 亮红 */
  brightRed: '#ff6b6b',
  /** 亮绿 */
  brightGreen: '#2ee62e',
  /** 亮黄 */
  brightYellow: '#f9f1a5',
  /** 亮蓝 */
  brightBlue: '#7aa2ff',
  /** 亮品红 */
  brightMagenta: '#f27fd8',
  /** 亮青 */
  brightCyan: '#61d6d6',
  /** 亮白 */
  brightWhite: '#f2f2f2',
};

// —— 面板 CSS ——

/* VSCode 风格底部面板样式（DSH 设计令牌；终端表面恒深色）。
 * 定义了所有面板样式类，包括下拉菜单、拆分终端、右侧终端列表。 */

/** 面板全局 CSS 字符串（含所有 .dshTerm* 样式规则） */
export const PANEL_CSS = `.dshTermRoot{position:fixed;bottom:0;z-index:50;font-family:Inter,var(--dsw-font-family)}
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
.dshTermHeaderActions{flex:none;display:flex;align-items:center;gap:2px;margin-left:auto}
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
.dshTermSideItemInput{flex:1;min-width:0;height:20px;padding:0 4px;border:1px solid var(--dsw-alias-label-primary);border-radius:3px;background:var(--dsw-specific-tip);color:var(--dsw-alias-label-primary);font-size:12px;font-family:Inter,var(--dsw-font-family);outline:none}
.dshTermContextMenu{position:fixed;z-index:200;min-width:120px;padding:4px 0;background:var(--dsw-specific-tip);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.dshTermContextMenuItem{padding:4px 12px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshTermContextMenuItem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
body.dshTermResizing{cursor:ns-resize!important;user-select:none!important;-webkit-user-select:none!important}`;

// —— CSS 注入（幂等） ——

/**
 * 幂等注入终端面板所需的全部 CSS（xterm.css + 面板样式）。
 *
 * 包含 typeof document 守卫，SSR / Node 环境下安全跳过。
 * 多次调用不会产生重复 <link> 或 <style> 标签。
 */
export function injectStyles(): void {
  if (typeof document === 'undefined') return;

  // 1. 注入 xterm.css <link>（由宿主半的 GET /xterm.css 路由 serve）
  if (document.getElementById(XTERM_CSS_TAG) === null) {
    const link = document.createElement('link');
    link.id = XTERM_CSS_TAG;
    link.rel = 'stylesheet';
    link.href = PREFIX + '/xterm.css';
    document.head.appendChild(link);
  }

  // 2. 注入面板样式 <style>
  if (document.getElementById(STYLE_TAG) === null) {
    const tag = document.createElement('style');
    tag.id = STYLE_TAG;
    tag.textContent = PANEL_CSS;
    document.head.appendChild(tag);
  }
}
