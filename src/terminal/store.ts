/**
 * @file 终端配置表的增删改校验
 * @description 封装配置表的业务规则：新增（type 合法、name 非空去重、path 可选）、
 *              改名（允许）、删除（origin: 'user' 可删，'auto' 拒绝）、
 *              path 变更（拒绝——已有项锁 path）。
 *
 *              纯函数模块，不碰磁盘、不碰 settings API，只做数据校验。
 */

import type { TerminalProfile } from './detect.js';
import type { TerminalKind } from './kinds.js';
import { getKindSpec } from './kinds.js';

/** 校验错误类型 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * 生成一个简短的终端配置 id（形如 `t-custom-x3y9`）。
 *
 * 格式：`t-<kind>-<4位随机十六进制>`。
 *
 * @param kind - 终端种类
 * @returns 配置 id
 */
function generateProfileId(kind: TerminalKind): string {
  const suffix = Math.random().toString(16).slice(2, 6).padStart(4, '0');
  return `t-${kind}-${suffix}`;
}

/**
 * 校验新增的 profile 是否合法。
 *
 * 规则：
 * 1. type 必须是已知的 TerminalKind（在 KIND_SPECS 中）
 * 2. name 非空且不与现有配置重名
 * 3. path 可为空（按 type 自动补全）；type = custom 时 path 不能空
 *
 * @param profiles - 现有配置表
 * @param type - 新增的终端类型
 * @param name - 新增的显示名
 * @param path - 新增的可执行文件路径（可空）
 * @throws ValidationError 校验失败时抛错
 */
export function validateAdd(
  profiles: TerminalProfile[],
  type: string,
  name: string,
  path: string,
): void {
  // 1. type 合法性
  const spec = getKindSpec(type as TerminalKind);
  if (spec === undefined) {
    throw new ValidationError(`不支持的终端类型：${type}`);
  }

  // 2. name 非空
  if (name.trim().length === 0) {
    throw new ValidationError('显示名不能为空');
  }

  // 3. name 不重名
  if (profiles.some(p => p.name === name)) {
    throw new ValidationError(`显示名 "${name}" 已存在`);
  }

  // 4. custom 必须填 path
  if (type === 'custom' && path.trim().length === 0) {
    throw new ValidationError('自定义类型必须填写可执行文件路径');
  }
}

/**
 * 新增一个终端配置项。
 *
 * @param profiles - 现有配置表
 * @param type - 终端类型
 * @param name - 显示名
 * @param path - 可执行文件路径（可空）
 * @returns 新配置表（含新增项）
 * @throws ValidationError 校验失败时抛错
 */
export function addProfile(
  profiles: TerminalProfile[],
  type: TerminalKind,
  name: string,
  path: string,
): TerminalProfile[] {
  validateAdd(profiles, type, name, path);
  const newProfile: TerminalProfile = {
    id: generateProfileId(type),
    type,
    name: name.trim(),
    path: path.trim(),
    origin: 'user',
  };
  return [...profiles, newProfile];
}

/**
 * 校验改名操作是否合法。
 *
 * 规则：
 * 1. id 必须存在
 * 2. 新 name 非空
 * 3. 新 name 不与其他配置重名
 *
 * @param profiles - 现有配置表
 * @param id - 要改名的配置 id
 * @param newName - 新显示名
 * @throws ValidationError 校验失败时抛错
 */
export function validateRename(profiles: TerminalProfile[], id: string, newName: string): void {
  // 1. id 存在
  const target = profiles.find(p => p.id === id);
  if (target === undefined) {
    throw new ValidationError(`配置 id "${id}" 不存在`);
  }

  // 2. 新 name 非空
  if (newName.trim().length === 0) {
    throw new ValidationError('显示名不能为空');
  }

  // 3. 新 name 不与其他配置重名（允许改成自己的名字 = 无操作）
  const duplicate = profiles.find(p => p.id !== id && p.name === newName);
  if (duplicate !== undefined) {
    throw new ValidationError(`显示名 "${newName}" 已被其他配置占用`);
  }
}

/**
 * 改名一个终端配置项。
 *
 * @param profiles - 现有配置表
 * @param id - 要改名的配置 id
 * @param newName - 新显示名
 * @returns 新配置表（改名后）
 * @throws ValidationError 校验失败时抛错
 */
export function renameProfile(
  profiles: TerminalProfile[],
  id: string,
  newName: string,
): TerminalProfile[] {
  validateRename(profiles, id, newName);
  return profiles.map(p => (p.id === id ? { ...p, name: newName.trim() } : p));
}

/**
 * 校验删除操作是否合法。
 *
 * 规则：
 * 1. id 必须存在
 * 2. origin = 'auto' 不可删除（自动探测的终端不允许删除）
 *
 * @param profiles - 现有配置表
 * @param id - 要删除的配置 id
 * @throws ValidationError 校验失败时抛错
 */
export function validateDelete(profiles: TerminalProfile[], id: string): void {
  // 1. id 存在
  const target = profiles.find(p => p.id === id);
  if (target === undefined) {
    throw new ValidationError(`配置 id "${id}" 不存在`);
  }

  // 2. origin = 'auto' 不可删除
  if (target.origin === 'auto') {
    throw new ValidationError(`自动探测的终端 "${target.name}" 不允许删除`);
  }
}

/**
 * 删除一个终端配置项。
 *
 * @param profiles - 现有配置表
 * @param id - 要删除的配置 id
 * @returns 新配置表（删除后）
 * @throws ValidationError 校验失败时抛错
 */
export function deleteProfile(profiles: TerminalProfile[], id: string): TerminalProfile[] {
  validateDelete(profiles, id);
  return profiles.filter(p => p.id !== id);
}

/**
 * 校验修改 path 操作是否合法。
 *
 * 规则：
 * 1. id 必须存在
 * 2. origin = 'auto' 不可改 path（已有项锁 path）
 * 3. type = custom 时 path 不能空
 *
 * @param profiles - 现有配置表
 * @param id - 要修改的配置 id
 * @param newPath - 新路径
 * @throws ValidationError 校验失败时抛错
 */
export function validateUpdatePath(profiles: TerminalProfile[], id: string, newPath: string): void {
  // 1. id 存在
  const target = profiles.find(p => p.id === id);
  if (target === undefined) {
    throw new ValidationError(`配置 id "${id}" 不存在`);
  }

  // 2. origin = 'auto' 不可改 path
  if (target.origin === 'auto') {
    throw new ValidationError(`自动探测的终端 "${target.name}" 的路径不允许修改`);
  }

  // 3. custom 必须填 path
  if (target.type === 'custom' && newPath.trim().length === 0) {
    throw new ValidationError('自定义类型必须填写可执行文件路径');
  }
}

/**
 * 修改一个终端配置项的 path。
 *
 * @param profiles - 现有配置表
 * @param id - 要修改的配置 id
 * @param newPath - 新路径
 * @returns 新配置表（修改后）
 * @throws ValidationError 校验失败时抛错
 */
export function updatePath(
  profiles: TerminalProfile[],
  id: string,
  newPath: string,
): TerminalProfile[] {
  validateUpdatePath(profiles, id, newPath);
  return profiles.map(p => (p.id === id ? { ...p, path: newPath.trim() } : p));
}

/**
 * 合并探测结果与已保存配置表：
 * - 已保存的配置全部保留（用户改过的 name 不丢）
 * - 探测到的新 type（不在已保存表中）补进去
 *
 * 判断"已有"的依据：type 相同且 path 相同（用户可能手动加了同类型的不同路径）。
 *
 * @param saved - 已保存的配置表
 * @param detected - 启动时探测到的配置表
 * @returns 合并后的配置表
 */
export function mergeProfiles(
  saved: TerminalProfile[],
  detected: TerminalProfile[],
): TerminalProfile[] {
  const result = [...saved];

  for (const detectedItem of detected) {
    // 判断是否已存在：type + path 双重匹配（用户可能装了两个 bash）
    const exists = result.some(
      s => s.type === detectedItem.type && s.path === detectedItem.path,
    );
    if (!exists) {
      result.push(detectedItem);
    }
  }

  return result;
}

/**
 * 配置表持久层落定：合并探测结果，并决定是否需要首跑落盘。
 *
 * 落盘只在持久层读回为空且探测有结果时发生（首跑安装）。读回非空说明持久层
 * 已有配置表，用户改过的 name、手动新增的项都存在里面，任何写回都会覆盖它们，
 * 因此一律不写——这也是"值跨重启保留"的唯一保障。
 *
 * @param saved - 持久层读回的配置表（读不到按空表传入）
 * @param detected - 启动时探测到的配置表
 * @returns merged 合并后的配置表；persistPayload 首跑落盘的 JSON 串，无需落盘时为 null
 */
export function settleProfileTable(
  saved: TerminalProfile[],
  detected: TerminalProfile[],
): { merged: TerminalProfile[]; persistPayload: string | null } {
  const merged = mergeProfiles(saved, detected);
  const persistPayload = saved.length === 0 && merged.length > 0 ? JSON.stringify(merged) : null;
  return { merged, persistPayload };
}
