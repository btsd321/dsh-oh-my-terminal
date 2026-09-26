/**
 * @file 终端插件浏览器半共享类型定义
 * @description 集中定义浏览器半与宿主半之间经 HTTP API 交换的数据结构，以及浏览器半
 *              内部使用的终端实例与终端组模型。所有跨模块共享的类型从此文件导出，
 *              其他模块经 `import type` 引用，编译期强制形状同步。
 *
 *              本文件只包含纯类型定义，不含任何运行时逻辑、常量或函数。
 */

// —— 终端实例与终端组 ——

/** 终端实例——一个独立的 PTY 会话 */
export interface TerminalInstance {
  /** 宿主半分配的终端 id */
  id: string;
  /** 服务端返回的标题（形如 "pwsh.exe #3"） */
  title: string | undefined;
  /** shell 名（如 "bash"、"zsh"、"pwsh.exe"） */
  shell: string | undefined;
  /** 会话的工作目录（新建终端时继承） */
  cwd: string | null;
  /** 是否已退出（展示为历史终端，可重启） */
  exited: boolean;
}

/** 终端组（拆分组）——一个 group 内的实例水平并排显示 */
export interface TerminalGroup {
  /** 组 id（首个实例 id 作为组 id） */
  id: string;
  /** 组内终端实例列表（水平并排） */
  instances: TerminalInstance[];
  /** 当前活跃实例 id */
  activeInstanceId: string | null;
}

// —— HTTP API 响应类型 ——

/** GET /sessions 响应中的单个会话条目 */
export interface SessionEntry {
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
export interface SessionsResponse {
  /** 所有会话列表（含已退出的历史） */
  sessions: SessionEntry[];
}

/** POST /sessions 与 POST /sessions/:id/restart 的响应体 */
export interface CreateSessionResponse {
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
export interface TerminalType {
  /** 种类 id（如 "default"、"bash"、"zsh"） */
  id: string;
  /** 显示标签（如 "默认 Shell"、"Bash"） */
  label: string;
  /** 启动命令（空串表示用默认 shell） */
  command: string;
}

/** GET /config 响应体 */
export interface ConfigResponse {
  /** 切换快捷键字符串（如 "ctrl+`"） */
  toggleShortcut?: string;
  /** 配置的 shell 命令 */
  shellCommand?: string;
  /** 终端字体族（CSS font-family 串；空串或缺省时用内置默认字体栈） */
  fontFamily?: string;
  /** 终端字号（像素；缺省时用内置默认值） */
  fontSize?: number;
  /** 可选的终端种类列表 */
  terminalTypes?: TerminalType[];
}

/** 对话区几何信息（面板宽度对齐对话列，不覆盖侧栏） */
export interface ConversationGeo {
  /** 对话列左边缘（像素） */
  left: number;
  /** 对话列宽度（像素） */
  width: number;
}

/** DELETE /sessions/:id 的响应体 */
export interface DeleteSessionResponse {
  /** 操作是否成功 */
  ok: boolean;
}

// —— useReducer 统一状态管理 ——

/** 终端面板的统一状态（useReducer state） */
export interface TerminalState {
  /** 终端实例列表 */
  instances: TerminalInstance[];
  /** 终端组列表 */
  groups: TerminalGroup[];
  /** 当前活跃实例 id */
  activeInstanceId: string | null;
  /** 操作进行中（禁用按钮） */
  busy: boolean;
  /** 启动恢复完成（实例与组列表就绪） */
  bootReady: boolean;
}

/** 终端状态 action 联合类型（reducer 处理的所有操作） */
export type TerminalAction =
  | { type: 'RESTORE'; instances: TerminalInstance[]; groups: TerminalGroup[]; activeInstanceId: string }
  | { type: 'SET_BUSY'; busy: boolean }
  | { type: 'SET_BOOT_READY' }
  | { type: 'ADD_INSTANCE'; instance: TerminalInstance; group: TerminalGroup }
  | { type: 'SPLIT_INSTANCE'; instance: TerminalInstance; groupId: string; afterInstanceId: string }
  | { type: 'REMOVE_INSTANCE'; id: string }
  | { type: 'RESTART_INSTANCE'; oldId: string; newInstance: TerminalInstance }
  | { type: 'MARK_EXITED'; id: string }
  | { type: 'SET_ACTIVE'; id: string }
  | { type: 'RENAME_INSTANCE'; id: string; title: string };
