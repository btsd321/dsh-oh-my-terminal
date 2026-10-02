/**
 * @file settings bridge 命名空间与常量定义
 * @description 定义 settings 集成的命名空间、路由前缀与可写字段清单。
 *              命名空间是 profile 条目 id（`terminal-panel`），用于在 DSH
 *              settings 系统中定位本插件的配置条目；路由前缀拼接在插件主路由
 *              `/api/dsh-oh-my-terminal` 之后，提供 describe/mutate 两个端点；
 *              可写字段清单用于白名单校验，防止前端写入非预期字段。
 */

/**
 * settings 命名空间（profile 条目 id）
 *
 * DSH settings 系统以 profile 条目 id 作为命名空间索引插件配置。
 * 本插件在 profile patch 中的条目 id 固定为 `terminal-panel`，与包名
 * `dsh-oh-my-terminal` 不同——前者是用户可见的配置 UI 标识，后者是 npm 包名。
 */
export const SETTINGS_NS = 'terminal-panel';

/**
 * settings bridge 路由前缀（相对片段）
 *
 * 这是**相对片段**，必须与插件主路由前缀 {@link ROUTE_PREFIX}
 * （`/api/dsh-oh-my-terminal`）拼接后才构成 webServer 注册所需的绝对路径——
 * `WebRoute.path` 要求绝对路径，直接注册 `/settings/describe` 会导致路由
 * 不匹配任何请求，表现为前端拿 404。完整路径：
 * - GET  /api/dsh-oh-my-terminal/settings/describe
 * - POST /api/dsh-oh-my-terminal/settings/mutate
 */
export const BRIDGE_PREFIX = '/settings';

/**
 * 可写字段名清单（白名单）
 *
 * 列出所有允许通过 settings bridge 写入的配置字段。前端提交的 mutate 操作
 * 必须只涉及这些字段，涉及其他字段的操作将被拒绝。这是纵深防御——防止前端
 * 意外或恶意写入非预期字段（如内部状态标记）。
 *
 * 6 个字段对应插件 Config 的 6 个 volatile 字段：
 * - toggleShortcut: 展开/收起面板的快捷键
 * - terminalProfiles: 终端配置表（JSON 字符串）
 * - fontFamily: 终端字体族
 * - fontSize: 终端字号（像素）
 * - lineHeight: 终端行高倍数
 * - hideHostTerminal: 是否隐藏 DSH 宿主自带终端 tab
 */
export const WRITABLE_FIELDS: readonly string[] = [
  'toggleShortcut',
  'terminalProfiles',
  'fontFamily',
  'fontSize',
  'lineHeight',
  'hideHostTerminal',
];
