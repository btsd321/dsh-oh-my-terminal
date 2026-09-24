/**
 * @file 平台适配器
 * @description 封装 OS 差异，业务逻辑不关心平台。
 *              新增平台只需实现 {@link PlatformAdapter} 接口并在 `platform`
 *              选择器里注册，不需要修改 resolveSpawn / buildSessionEnv /
 *              builtinTerminalTypes 等业务代码。
 *
 *              POSIX 适配器处理 openpty 环境（TERM/COLORTERM/LANG/LC_ALL 等），
 *              Windows 适配器处理 ConPTY 环境（仅 PYTHONIOENCODING）。
 *              node-pty 自动按平台选 ConPTY 或 openpty，本模块不手动 fork。
 */

/** spawn 参数：node-pty spawn(file, args, opts) 的 file 和 args */
export interface SpawnArgs {
  /** 可执行文件路径 */
  file: string;
  /** 命令行参数（不含 file 本身） */
  args: string[];
}

/** 终端种类条目（/config 返回给浏览器半，未来扩展 bash/zsh/fish 只需加条目） */
export interface TerminalType {
  /** 种类 id */
  id: string;
  /** 显示标签 */
  label: string;
  /** shell 命令行（空串 = 平台默认） */
  command: string;
}

/**
 * 平台适配器接口——封装所有 OS 差异，业务逻辑不关心平台。
 *
 * 新增平台只需实现此接口并在 `platform` 选择器里注册，不需要修改 resolveSpawn /
 * platform.buildSessionEnv / platform.builtinTerminalTypes 等业务代码。
 */
export interface PlatformAdapter {
  /** 探测平台默认 shell 可执行文件路径 */
  detectDefaultShell(): string;
  /**
   * 为裸 shell 文件构建 spawn 参数（含交互标志等平台特定参数）。
   * @param file - shell 可执行文件路径
   */
  buildBareSpawnArgs(file: string): SpawnArgs;
  /** 构建 PTY 子进程环境变量（在 process.env 基础上补充/覆盖平台特定变量） */
  buildSessionEnv(): Record<string, string>;
  /** node-pty spawn 的 name 参数（终端类型描述符） */
  ptyName: string;
  /** 内置终端种类列表（/config 返回给浏览器半） */
  builtinTerminalTypes: TerminalType[];
}

/**
 * 从 process.env 取值：值为 undefined 或空串时回落 fallback。
 *
 * 两适配器的 buildSessionEnv 原先各自定义完全相同的 `pick` 闭包，提取为模块级
 * 函数共用以消除重复。
 *
 * @param key - 环境变量名
 * @param fallback - 值缺失时的回落
 * @returns 取到的环境变量值或 fallback
 */
function envPick(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** POSIX 适配器——处理 openpty 环境（SHELL/TERM/COLORTERM/LANG/LC_ALL） */
const posixAdapter: PlatformAdapter = {
  detectDefaultShell(): string {
    return process.env.SHELL ?? '/bin/bash';
  },
  buildBareSpawnArgs(file: string): SpawnArgs {
    // POSIX shell 需要 -i 进入交互模式
    return { file, args: ['-i'] };
  },
  buildSessionEnv(): Record<string, string> {
    return {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: envPick('COLORTERM', 'truecolor'),
      PYTHONIOENCODING: envPick('PYTHONIOENCODING', 'utf-8'),
      LANG: envPick('LANG', 'en_US.UTF-8'),
      LC_ALL: envPick('LC_ALL', 'en_US.UTF-8'),
    } as Record<string, string>;
  },
  ptyName: 'xterm-256color',
  builtinTerminalTypes: [
    { id: 'default', label: '默认 Shell', command: '' },
    { id: 'bash', label: 'Bash', command: 'bash -l' },
    { id: 'zsh', label: 'Zsh', command: 'zsh -l' },
  ],
};

/** Windows 适配器——处理 ConPTY 环境（仅 PYTHONIOENCODING，无需 POSIX 变量） */
const win32Adapter: PlatformAdapter = {
  detectDefaultShell(): string {
    // COMSPEC 是 Windows 系统环境变量，指向 cmd.exe
    const comspec = process.env.COMSPEC;
    if (typeof comspec === 'string' && comspec.length > 0) return comspec;
    return 'cmd.exe';
  },
  buildBareSpawnArgs(file: string): SpawnArgs {
    // Windows shell（cmd.exe / pwsh.exe / powershell.exe）默认就是交互模式，无需额外参数
    return { file, args: [] };
  },
  buildSessionEnv(): Record<string, string> {
    // Windows ConPTY 不需要 TERM/COLORTERM/LANG/LC_ALL 等 POSIX 变量
    // 只补充 PYTHONIOENCODING 确保 Python 输出 UTF-8
    return {
      ...process.env,
      PYTHONIOENCODING: envPick('PYTHONIOENCODING', 'utf-8'),
    } as Record<string, string>;
  },
  ptyName: 'xterm-256color',
  builtinTerminalTypes: [
    { id: 'default', label: '默认 Shell', command: '' },
    { id: 'pwsh', label: 'PowerShell', command: 'pwsh' },
    { id: 'cmd', label: 'CMD', command: 'cmd' },
  ],
};

/** 按 process.platform 选择适配器——未知平台回落 POSIX */
export const platform: PlatformAdapter = process.platform === 'win32' ? win32Adapter : posixAdapter;
