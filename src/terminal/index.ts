/**
 * @file 终端配置模块入口
 * @description 统一导出终端种类定义、自动探测、spawn 解析、配置表校验的公开 API。
 *              宿主半（index.ts / routes.ts）从此模块 import，不直接引用子文件。
 *
 * 模块结构：
 * - kinds.ts   — 终端种类定义与平台映射表（KIND_SPECS）
 * - detect.ts  — 启动时探测 $PATH 中的可用终端
 * - resolve.ts — 将配置项解析为 node-pty spawn 参数
 * - store.ts   — 配置表的增删改校验（纯函数）
 */

// —— 终端种类 ——
export type { TerminalKind } from './kinds.js';
export {
  KIND_SPECS,
  getKindSpec,
  getKindOptions,
  isDetectableOnPlatform,
  getBinaryName,
  getInteractiveArgs,
} from './kinds.js';

// —— 自动探测 ——
export type { TerminalProfile } from './detect.js';
export { detectTerminalProfiles, resolveCommand, detectGitBash } from './detect.js';

// —— spawn 解析 ——
export type { SpawnArgs } from './resolve.js';
export { resolveProfile } from './resolve.js';

// —— 配置表操作 ——
export {
  ValidationError,
  validateAdd,
  addProfile,
  validateRename,
  renameProfile,
  validateDelete,
  deleteProfile,
  validateUpdatePath,
  updatePath,
  mergeProfiles,
  settleProfileTable,
} from './store.js';
