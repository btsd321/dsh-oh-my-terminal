/**
 * @file 配置表单样式模块
 * @description 集中管理浏览器半配置表单的所有 CSS 样式。CSS 注入在模块加载时不会
 *              自动执行——由调用方显式调用 injectSettingsStyles()，保证 SSR / Node
 *              环境安全（typeof document 守卫）。
 *
 *              样式设计参考现有 client/styles.ts 的 PANEL_CSS 模式，使用 DSH 设计令牌
 *              （CSS 自定义属性）实现主题自适应，表单布局遵循 DSW 一致性规范。
 *
 *              本模块只提供样式常量与幂等注入函数，不包含任何 React 组件或状态逻辑。
 */

// —— 常量 ——

/** 配置表单样式 <style> 标签的 id（幂等注入） */
export const SETTINGS_STYLE_TAG = 'dsh-oh-my-terminal-settings-styles';

// —— CSS 样式常量 ——

/**
 * 配置表单全局 CSS 字符串。
 *
 * 包含表单布局、输入框、按钮、错误提示、冲突横幅的完整样式规则。
 *
 * 颜色统一消费 PANEL_CSS 顶部定义的内部配对令牌（--dshTermText / TextDim /
 * Popup / Border / Hover）：表面与文字同源成对，第三方皮肤改写宿主角色令牌
 * 时也不会出现"白底白字"（详见 client/styles.ts 令牌块注释）。语义提示（警告/
 * 错误/主按钮）仍用宿主成对的 semantic-* 令牌。
 *
 * 样式类命名约定：
 * - .dshTermSettings* 前缀与现有终端面板样式保持一致
 * - 语义化类名（Container/Field/Label/Input/Button/Banner）便于维护
 */
export const SETTINGS_CARD_CSS = `.dshTermSettingsContainer{box-sizing:border-box;padding:20px;font-family:Inter,var(--dsw-font-family);color:var(--dshTermText)}
.dshTermSettingsLoading{color:var(--dshTermTextMuted);font-size:13px;line-height:1.5}
.dshTermSettingsBanner{padding:12px 16px;margin-bottom:16px;border-radius:6px;font-size:13px;line-height:1.5}
.dshTermSettingsBanner.isWarning{background:var(--dsw-semantic-warning-bg);border:1px solid var(--dsw-semantic-warning-border);color:var(--dsw-semantic-warning-text)}
.dshTermSettingsBanner.isError{background:var(--dsw-semantic-error-bg);border:1px solid var(--dsw-semantic-error-border);color:var(--dsw-semantic-error-text)}
.dshTermSettingsForm{display:flex;flex-direction:column;gap:16px}
.dshTermSettingsField{display:flex;flex-direction:column;gap:6px}
.dshTermSettingsLabel{font-size:13px;font-weight:500;color:var(--dshTermText)}
.dshTermSettingsInput{box-sizing:border-box;padding:8px 12px;font-size:13px;border-radius:6px;border:1px solid var(--dshTermBorder);background:var(--dshTermPopup);color:var(--dshTermText);font-family:inherit;outline:none;transition:border-color .15s}
.dshTermSettingsInput:focus{border-color:var(--dshTermText)}
.dshTermSettingsInput:disabled{background:var(--dsw-alias-interactive-bg-disabled);color:var(--dsw-alias-label-disabled);cursor:not-allowed}
.dshTermSettingsInput::placeholder{color:var(--dshTermTextMuted)}
.dshTermSettingsActions{display:flex;gap:10px;margin-top:8px}
.dshTermSettingsButton{padding:8px 16px;font-size:13px;font-weight:500;border-radius:6px;border:none;font-family:inherit;cursor:pointer;transition:background .15s,opacity .15s}
.dshTermSettingsButton.isPrimary{background:var(--dsw-semantic-primary-bg);color:var(--dsw-semantic-primary-text)}
.dshTermSettingsButton.isPrimary:hover:not(:disabled){opacity:.9}
.dshTermSettingsButton.isPrimary:disabled{background:var(--dsw-alias-interactive-bg-disabled);color:var(--dsw-alias-label-disabled);cursor:not-allowed;opacity:.6}
.dshTermSettingsButton.isSecondary{border:1px solid var(--dshTermBorder);background:transparent;color:var(--dshTermTextDim)}
.dshTermSettingsButton.isSecondary:hover:not(:disabled){background:var(--dshTermHover)}
.dshTermSettingsButton.isSecondary:disabled{opacity:.6;cursor:not-allowed}
.dshTermSettingsReadonly{margin-top:8px;font-size:12px;color:var(--dshTermTextMuted);line-height:1.5}`;

// —— CSS 注入（幂等） ——

/**
 * 幂等注入配置表单所需的全部 CSS。
 *
 * 包含 typeof document 守卫，SSR / Node 环境下安全跳过。
 * 多次调用不会产生重复 <style> 标签——检查 id 已存在则跳过。
 *
 * 调用时机：配置表单组件挂载前（如 client.tsx 的模块初始化阶段），
 * 或组件内部 useEffect 首次执行时。
 */
export function injectSettingsStyles(): void {
  if (typeof document === 'undefined') return;

  /* 检查样式标签是否已存在 */
  if (document.getElementById(SETTINGS_STYLE_TAG) !== null) return;

  /* 创建并注入样式标签 */
  const tag = document.createElement('style');
  tag.id = SETTINGS_STYLE_TAG;
  tag.textContent = SETTINGS_CARD_CSS;
  document.head.appendChild(tag);
}
