/**
 * @file 远端终端插件协议与配置常量
 * @description 集中定义宿主半（src/index.ts）与持久化层（src/persistence.ts）
 *              共享的协议常量、终端尺寸约束、快捷键默认值、环境变量名、
 *              持久化文件名。业务模块按需 import 具名常量，避免魔法数字散落各处。
 *
 *              不可单方面修改的协议常量（PKG_NAME、ROUTE_PREFIX、WS_PREFIX、
 *              PROTOCOL_VERSION）改动需同步 cordis.patch.yml 与构建脚本，并在
 *              注释里标明兼容性影响。
 */

// import type：构建期擦除（esbuild 对 import type 100% 剔除），插件产物不携带
// 对 dsh-* 包的运行时引用——宿主半 external @deepseek-ai/*，浏览器半自包含 bundle
import type { ShortcutCommand } from '@deepseek-ai/dsh-client-shortcuts/client';

/** 插件包名（cordis 插件导出名，与 package.json name 一致） */
export const PKG_NAME = 'dsh-oh-my-terminal';

/** 远端组件宿主半在远端 dsh 注册的同源路由前缀 */
export const ROUTE_PREFIX = '/api/dsh-remote-terminal';

/** WebSocket 升级路径前缀（per-session: /ws/<id>） */
export const WS_PREFIX = '/api/dsh-remote-terminal/ws';

/** 终端协议版本（浏览器半与本机构建器各持一份；不一致时远端面板降级禁用） */
export const PROTOCOL_VERSION = 1;

/** 滚动缓冲上限（字符数）——长 agent 会话流大量工具输出，截断保留尾部 */
export const SCROLLBACK_CHARS = 500_000;

/** cols 取值下限 */
export const COLS_MIN = 20;
/** cols 取值上限 */
export const COLS_MAX = 500;
/** rows 取值下限 */
export const ROWS_MIN = 5;
/** rows 取值上限 */
export const ROWS_MAX = 200;

/** 默认列数 */
export const DEFAULT_COLS = 80;
/** 默认行数 */
export const DEFAULT_ROWS = 24;

/** 日志落盘合并窗口（毫秒）——pty.onData 高频回调，合并写盘避免 IO 风暴 */
export const LOG_FLUSH_MS = 250;

/** 默认展开/收起快捷键（裸监听降级路径；DSH 0.1.7-rc.2+ 上由 shortcuts 命令接管） */
export const DEFAULT_TOGGLE_SHORTCUT = 'ctrl+`';

/**
 * 在 DSH shortcuts 系统注册的"切换终端面板"命令 id。
 * DSH 0.1.7-rc.2 起宿主自带终端（terminal.new）占用 Ctrl+`，本插件改注册
 * 独立命令并让键位统一在 DSH 设置界面配置。
 */
export const SHORTCUT_COMMAND_ID = 'terminal-panel.toggle';

/**
 * terminal-panel.toggle 的默认绑定：Ctrl+Shift+`（primary+shift + Backquote）。
 *
 * - 不能用 Ctrl+`：与 terminal.new 冲突，shortcuts 注册时对重叠默认绑定抛错
 * - web:linux 不声明：官方 web 快捷键白名单（isWebBindingAllowed）对 Linux
 *   只放行 Slash/Comma/Period 组合，Backquote 组合会被拒；缺失 profile 表示
 *   该环境无默认键，用户可在 DSH 设置界面自行绑定（web:macos/web:windows
 *   经 primary+shift 双修饰通道放行 Backquote）
 */
export const SHORTCUT_DEFAULTS: ShortcutCommand['defaults'] = {
  'desktop:macos': { code: 'Backquote', modifiers: ['primary', 'shift'] },
  'desktop:windows': { code: 'Backquote', modifiers: ['primary', 'shift'] },
  'desktop:linux': { code: 'Backquote', modifiers: ['primary', 'shift'] },
  'web:macos': { code: 'Backquote', modifiers: ['primary', 'shift'] },
  'web:windows': { code: 'Backquote', modifiers: ['primary', 'shift'] },
};

/** 切换快捷键环境变量名（ops 级覆盖，优先于 settings 文档） */
export const ENV_TOGGLE_SHORTCUT = 'DSH_PLUGIN_TERMINAL_TOGGLE_SHORTCUT';
/** shell 命令环境变量名（ops 级覆盖，优先于 settings 文档） */
export const ENV_SHELL_COMMAND = 'DSH_PLUGIN_TERMINAL_SHELL_COMMAND';
/** 持久化目录环境变量覆盖（测试用） */
export const ENV_DATA_DIR = 'DSH_PLUGIN_TERMINAL_DATA';

/** 会话元数据文件名 */
export const META_FILE = 'sessions.json';
/** 滚动缓冲日志子目录名 */
export const LOG_SUBDIR = 'logs';
