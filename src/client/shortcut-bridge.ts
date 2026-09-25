/**
 * @file 面板快捷键桥接模块
 * @description 浏览器半"DSH shortcuts 服务（0.1.7-rc.2+）↔ 插件面板 React 组件"
 *              之间的运行期信号桥。
 *
 *              插件 apply() 软探测到宿主的 shortcuts 服务并成功注册
 *              terminal-panel.toggle 命令后，经 markShortcutsActive 记录接入
 *              状态并保存 catalog 引用；TerminalPanel 挂载时把切换回调注册进
 *              togglers，命令命中时经 notifyPanelToggle 驱动当前面板。
 *
 *              为什么不把 'shortcuts' 写进插件顶层 inject：硬依赖会让旧宿主
 *              （0.1.7-rc.1 及更早，无 shortcuts 服务）上插件浏览器半直接不
 *              激活、面板消失。软探测 + 本桥保持两代宿主同时兼容——
 *              接入成功则停用裸 keydown 降级路径（避免双重响应），未接入
 *              则维持原有行为。
 *
 *              模块级可变状态是进程唯一的 UI 信号：mark/reset 成对提供
 *              （插件重载 re-apply 时先复位），toggler 注册/注销成对提供
 *              （组件卸载清理，防泄漏）。
 */

// import type：构建期擦除，浏览器 bundle 不携带对官方包的运行时引用
import type { Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client';

/** shortcuts 服务的命令目录快照（官方 ObservableSnapshot 类型，getSnapshot/subscribe） */
export type ShortcutsCatalog = Shortcuts['catalog'];

/**
 * 已挂载面板的切换回调集合。
 * dock 槽 scope='session'，同一时刻通常只有一个面板实例挂载；多实例并存时
 * 全部通知——与旧裸 keydown 路径的广播行为一致。
 */
const panelTogglers = new Set<() => void>();

/** shortcuts 接入状态：true = 命令已注册，裸 keydown 降级路径停用 */
let shortcutsActive = false;

/** shortcuts 服务的 catalog 快照引用；接入后非空，供快捷键标签读取当前生效绑定 */
let shortcutsCatalog: ShortcutsCatalog | undefined;

/**
 * 读取 shortcuts 接入状态。
 *
 * useConfig 据此决定是否挂裸 keydown 监听：apply 先于面板挂载执行，
 * 面板挂载时该值已定格为本轮插件激活的最终状态。
 *
 * @returns 已成功注册 shortcuts 命令时 true
 */
export function isShortcutsActive(): boolean {
  return shortcutsActive;
}

/**
 * 复位接入状态（apply 入口调用）。
 *
 * 插件重载（dispose → re-apply）时上一轮的注册结果不得残留：本轮若注册
 * 失败降级，裸监听路径必须恢复生效。
 */
export function resetShortcutsState(): void {
  shortcutsActive = false;
  shortcutsCatalog = undefined;
}

/**
 * 标记 shortcuts 命令注册成功并保存 catalog 引用。
 *
 * @param catalog - shortcuts 服务实例的 catalog（官方 ObservableSnapshot）
 */
export function markShortcutsActive(catalog: ShortcutsCatalog): void {
  shortcutsActive = true;
  shortcutsCatalog = catalog;
}

/**
 * 取已保存的 catalog 快照引用。
 *
 * @returns 未接入时 undefined
 */
export function getShortcutsCatalog(): ShortcutsCatalog | undefined {
  return shortcutsCatalog;
}

/**
 * 注册一个面板切换回调（TerminalPanel 挂载时调用）。
 *
 * @param toggle - 切换函数（组件内 setOpen(v => !v) 的包装）
 * @returns 注销函数（组件卸载时必须调用，防泄漏）
 */
export function registerPanelToggler(toggle: () => void): () => void {
  panelTogglers.add(toggle);
  return () => { panelTogglers.delete(toggle); };
}

/**
 * 通知所有已挂载面板切换（shortcuts 命令 resolve 的 run 调用）。
 * 无挂载面板时为空操作——面板未挂载即无可切目标，命令仍报 handled。
 */
export function notifyPanelToggle(): void {
  for (const toggle of panelTogglers) toggle();
}
