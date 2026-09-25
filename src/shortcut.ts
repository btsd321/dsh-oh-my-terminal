/**
 * @file 快捷键字符串解析工具
 * @description 解析 "ctrl+`"、"ctrl+j"、"ctrl+shift+f1" 这类快捷键字符串为可匹配的规格。
 *              纯函数模块（无 DOM、无 React、无 Node 依赖），可被宿主半（index.ts）
 *              与浏览器半（client.tsx）同时 import——esbuild 打包浏览器 bundle 时会
 *              把本模块内联进 client.js。匹配基于 KeyboardEvent.code（布局无关）。
 *
 * 接受格式："mod1+mod2+key"，修饰键大小写不敏感、顺序任意；键：字母、数字、
 * F1–F12 或下列命名键。
 */

/** 修饰键规范名 */
type ModName = 'ctrl' | 'shift' | 'alt' | 'meta';

/** 命名键到 KeyboardEvent.code 的映射表（部分键名别名） */
const NAMED_KEYS: Record<string, string> = {
  '`': 'Backquote', backquote: 'Backquote', grave: 'Backquote',
  '-': 'Minus', '=': 'Equal',
  '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote',
  ',': 'Comma', '.': 'Period', '/': 'Slash',
  space: 'Space', enter: 'Enter', return: 'Enter',
  escape: 'Escape', esc: 'Escape', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
};

/** 修饰键别名到规范名的映射表 */
const MODIFIERS: Record<string, ModName> = {
  ctrl: 'ctrl', control: 'ctrl',
  shift: 'shift',
  alt: 'alt', option: 'alt',
  meta: 'meta', cmd: 'meta', win: 'meta', command: 'meta',
};

/** 修饰键显示标签 */
const MOD_LABEL: Record<ModName, string> = {
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  meta: 'Meta',
};

/** 快捷键解析结果 */
export interface ShortcutSpec {
  /** 是否需 Ctrl 键 */
  ctrl: boolean;
  /** 是否需 Shift 键 */
  shift: boolean;
  /** 是否需 Alt 键 */
  alt: boolean;
  /** 是否需 Meta 键（Win/Cmd） */
  meta: boolean;
  /** KeyboardEvent.code（布局无关；null = 不可解析） */
  code: string | null;
  /** 显示标签（如 "Ctrl+`"；null = 不可解析） */
  label: string | null;
}

/**
 * 解析快捷键字符串为可匹配的规格。
 *
 * 接受 "mod1+mod2+key" 格式，如 "ctrl+`"、"ctrl+j"、"ctrl+shift+f1"。
 * 修饰键不区分大小写、可任意顺序，支持 control/option/cmd/win/command 别名。
 * 键位匹配在 KeyboardEvent.code 上做（布局无关），故德语布局的 ctrl+j 仍匹配 KeyJ。
 *
 * @param input - 快捷键字符串
 * @returns 解析结果；不可解析时 null
 */
export function parseShortcut(input: string): ShortcutSpec | null {
  if (typeof input !== 'string') return null;
  const parts = input.split('+').map(p => p.trim().toLowerCase()).filter(p => p.length > 0);
  if (parts.length === 0) return null;
  const spec: ShortcutSpec = { ctrl: false, shift: false, alt: false, meta: false, code: null, label: null };
  const mods: ModName[] = [];
  while (parts.length > 1) {
    const mod = MODIFIERS[parts.shift() ?? ''];
    if (mod === undefined || spec[mod]) return null;
    spec[mod] = true;
    mods.push(mod);
  }
  const keyToken = parts[0];
  if (keyToken === undefined) return null;
  let code: string | null = null;
  let keyLabel: string | null = null;
  if (/^[a-z]$/.test(keyToken)) {
    code = 'Key' + keyToken.toUpperCase();
    keyLabel = keyToken.toUpperCase();
  } else if (/^[0-9]$/.test(keyToken)) {
    code = 'Digit' + keyToken;
    keyLabel = keyToken;
  } else if (NAMED_KEYS[keyToken] !== undefined) {
    code = NAMED_KEYS[keyToken];
    keyLabel = code === 'Backquote' ? '`' : code;
  } else if (/^f([1-9]|1[0-2])$/.test(keyToken)) {
    code = 'F' + keyToken.slice(1);
    keyLabel = code;
  } else {
    return null;
  }
  spec.code = code;
  spec.label = [...mods.map(m => MOD_LABEL[m]), keyLabel].join('+');
  return spec;
}

/**
 * 判断一个 KeyboardEvent 是否匹配解析后的规格。
 *
 * 浏览器半的 keydown 监听器调用本函数判断是否应切换面板。
 *
 * @param spec - parseShortcut 的返回值
 * @param ev - keydown 事件
 * @returns 所有修饰键与键码都吻合时 true
 */
export function matchesShortcut(spec: ShortcutSpec | null, ev: KeyboardEvent): boolean {
  if (spec === null) return false;
  if (spec.code !== null && ev.code !== spec.code) return false;
  return ev.ctrlKey === spec.ctrl
    && ev.shiftKey === spec.shift
    && ev.altKey === spec.alt
    && ev.metaKey === spec.meta;
}

/**
 * 判断一个 KeyboardEvent 是否应由本插件响应（命中且未被其他组件消费）。
 *
 * DSH 0.1.7-rc.2 起宿主自带全局快捷键系统（dsh-client-shortcuts），其 window
 * 级 keydown 监听先于本插件面板挂载注册，命中命令后会调用 preventDefault。
 * 已被消费的事件（defaultPrevented=true）不得再触发本插件的裸监听降级路径
 * ——否则同一按键双重响应（如 Ctrl+` 同时切换本面板与 DSH 自带终端侧栏）。
 * 与官方 ShortcutRegistry.dispatch 的 gesture.defaultPrevented 前置检查同
 * 一契约，此处是插件裸监听路径的对应实现。
 *
 * @param spec - parseShortcut 的返回值
 * @param ev - keydown 事件
 * @returns 命中快捷键且事件未被消费时 true
 */
export function shouldHandleShortcut(spec: ShortcutSpec | null, ev: KeyboardEvent): boolean {
  if (ev.defaultPrevented) return false;
  return matchesShortcut(spec, ev);
}
