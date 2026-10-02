/**
 * @file 配置表单状态管理模块
 * @description 定义配置表单的状态类型、action 类型、纯函数 reducer 与辅助工具函数。
 *              浏览器半配置表单的状态管理采用 useReducer 模式，将加载/编辑/保存/
 *              冲突/重置等所有状态转换集中在单一 reducer 中处理，避免多 setter
 *              同步遗漏。
 *
 *              本模块只提供纯函数与类型定义，不包含任何 React Hook 或副作用——
 *              符合状态管理与 UI 层分离的架构原则。副作用（HTTP 请求）在 card.tsx
 *              的 useEffect 中触发，reducer 只处理同步状态转换。
 *
 * 设计要点：
 * - FormState 包含配置值、dirty 字段追踪、加载/保存状态、错误与冲突信息
 * - FormAction 覆盖完整生命周期：加载开始/成功/失败、字段编辑、保存开始/成功/
 *   失败、冲突检测、表单重置
 * - formReducer 是纯函数，所有状态转换可测试、可预测、可追溯
 * - buildOpsFromDirty 工具函数将 dirty 字段集合转换为 JSON Patch 操作序列
 */

import type {
  TerminalSettingsValues,
  SettingsDescriptor,
  JsonPatchOp,
  ConflictState,
} from './types.js';

// —— 表单状态类型 ——

/** 表单加载/保存状态 */
export type FormStatus = 'idle' | 'loading' | 'saving' | 'error';

/** 配置表单完整状态 */
export interface FormState {
  /** 当前操作状态 */
  status: FormStatus;
  /** 当前表单值（与原始值可能不同） */
  values: TerminalSettingsValues;
  /** 原始值（加载时的初始值，用于重置与 dirty 判断） */
  originalValues: TerminalSettingsValues;
  /** 被修改的字段名集合 */
  dirtyFields: Set<string>;
  /** 当前配置版本号（乐观锁） */
  revision: number;
  /** 配置命名空间 */
  namespace: string;
  /** 是否可写（只读模式下禁用保存） */
  writable: boolean;
  /** 错误消息（加载或保存失败时填充） */
  errorMessage: string | null;
  /** 版本冲突状态 */
  conflict: ConflictState;
}

// —— Action 类型 ——

/** 表单状态 action 联合类型 */
export type FormAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; descriptor: SettingsDescriptor }
  | { type: 'LOAD_FAILURE'; message: string }
  | { type: 'EDIT_FIELD'; field: keyof TerminalSettingsValues; value: string | number }
  | { type: 'SAVE_START' }
  | { type: 'SAVE_SUCCESS'; descriptor: SettingsDescriptor }
  | { type: 'SAVE_FAILURE'; message: string; code?: string }
  | { type: 'RESET' }
  | { type: 'CLEAR_ERROR' };

// —— 初始状态工厂 ——

/**
 * 创建表单初始状态。
 *
 * 用于 useReducer 的 initializer 或测试中的状态基准。初始状态下所有字段
 * 为空值，status 为 idle，无错误与冲突。
 *
 * @returns 表单初始状态
 */
export function createInitialFormState(): FormState {
  const emptyValues: TerminalSettingsValues = {
    toggleShortcut: '',
    fontFamily: '',
    fontSize: 0,
    lineHeight: 0,
    /* 空串 = 宿主半用启动探测结果（与 Config schema 的默认值语义一致） */
    terminalProfiles: '',
    hideHostTerminal: true,
  };
  return {
    status: 'idle',
    values: emptyValues,
    originalValues: emptyValues,
    dirtyFields: new Set(),
    revision: 0,
    namespace: '',
    writable: false,
    errorMessage: null,
    conflict: { isConflict: false },
  };
}

// —— Reducer ——

/**
 * 配置表单 reducer——处理所有状态转换的纯函数。
 *
 * 状态转换逻辑：
 * - LOAD_START：进入 loading 状态，清空错误
 * - LOAD_SUCCESS：填充原始值与表单值，清空 dirty，进入 idle
 * - LOAD_FAILURE：进入 error 状态，记录错误消息
 * - EDIT_FIELD：更新字段值，追踪 dirty 字段（与原始值比较）
 * - SAVE_START：进入 saving 状态，清空错误与冲突
 * - SAVE_SUCCESS：更新原始值与表单值（以服务端最新值为准），清空 dirty，进入 idle
 * - SAVE_FAILURE：进入 error 状态，检测版本冲突（code === 'settings-conflict'）
 * - RESET：恢复表单值为原始值，清空 dirty 与错误
 * - CLEAR_ERROR：清空错误消息与冲突状态，恢复 idle
 *
 * @param state - 当前状态
 * @param action - 触发的 action
 * @returns 新状态（遵循不可变更新）
 */
export function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'LOAD_START':
      /* 加载开始：进入 loading 状态，清空错误与冲突 */
      return {
        ...state,
        status: 'loading',
        errorMessage: null,
        conflict: { isConflict: false },
      };

    case 'LOAD_SUCCESS':
      /* 加载成功：填充配置描述符到状态，清空 dirty 集合 */
      return {
        ...state,
        status: 'idle',
        values: { ...action.descriptor.value },
        originalValues: { ...action.descriptor.value },
        dirtyFields: new Set(),
        revision: action.descriptor.revision,
        namespace: action.descriptor.namespace,
        writable: action.descriptor.writable,
        errorMessage: null,
        conflict: { isConflict: false },
      };

    case 'LOAD_FAILURE':
      /* 加载失败：进入 error 状态，记录错误消息 */
      return {
        ...state,
        status: 'error',
        errorMessage: action.message,
      };

    case 'EDIT_FIELD': {
      /* 字段编辑：更新字段值，追踪 dirty 状态 */
      const newValues = { ...state.values, [action.field]: action.value };
      const newDirty = new Set(state.dirtyFields);

      /* 与原始值比较，决定是否标记为 dirty */
      if (newValues[action.field] !== state.originalValues[action.field]) {
        newDirty.add(action.field);
      } else {
        newDirty.delete(action.field);
      }

      return {
        ...state,
        values: newValues,
        dirtyFields: newDirty,
      };
    }

    case 'SAVE_START':
      /* 保存开始：进入 saving 状态，清空错误与冲突 */
      return {
        ...state,
        status: 'saving',
        errorMessage: null,
        conflict: { isConflict: false },
      };

    case 'SAVE_SUCCESS':
      /* 保存成功：更新原始值与表单值为服务端最新值，清空 dirty */
      return {
        ...state,
        status: 'idle',
        values: { ...action.descriptor.value },
        originalValues: { ...action.descriptor.value },
        dirtyFields: new Set(),
        revision: action.descriptor.revision,
        namespace: action.descriptor.namespace,
        writable: action.descriptor.writable,
        errorMessage: null,
        conflict: { isConflict: false },
      };

    case 'SAVE_FAILURE': {
      /* 保存失败：进入 error 状态，检测版本冲突 */
      const isConflict = action.code === 'settings-conflict';
      return {
        ...state,
        status: 'error',
        errorMessage: action.message,
        conflict: {
          isConflict,
          message: isConflict ? '配置已被其他页面修改，请刷新页面重新加载' : undefined,
        },
      };
    }

    case 'RESET':
      /* 表单重置：恢复为原始值，清空 dirty、错误与冲突 */
      return {
        ...state,
        values: { ...state.originalValues },
        dirtyFields: new Set(),
        errorMessage: null,
        conflict: { isConflict: false },
      };

    case 'CLEAR_ERROR':
      /* 清空错误：恢复 idle 状态，清空错误消息与冲突 */
      return {
        ...state,
        status: 'idle',
        errorMessage: null,
        conflict: { isConflict: false },
      };

    default:
      return state;
  }
}

// —— 辅助工具函数 ——

/**
 * 从 dirty 字段集合构建 JSON Patch 操作序列。
 *
 * 遍历 dirty 字段，为每个字段生成一个 `replace` 操作。path 格式为
 * `/fieldName`（RFC 6902 JSON Pointer）。宿主半 Settings Bridge 使用
 * 这些操作更新配置对象。
 *
 * @param dirtyFields - 被修改的字段名集合
 * @param values - 当前表单值
 * @returns JSON Patch 操作数组
 */
export function buildOpsFromDirty(
  dirtyFields: Set<string>,
  values: TerminalSettingsValues,
): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  for (const field of dirtyFields) {
    /* 字段名是 TerminalSettingsValues 的键，path 是字符串数组 [fieldName] */
    const path = [field];
    const value = values[field as keyof TerminalSettingsValues];
    ops.push({ op: 'set', path, value });
  }
  return ops;
}
