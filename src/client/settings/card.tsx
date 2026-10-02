/**
 * @file 配置表单 React 组件
 * @description 终端配置表单的完整 UI 实现，包含两种视图模式：summary（摘要文本）
 *              与 page（完整表单）。采用 useReducer 统一管理表单状态，支持加载/
 *              编辑/保存/重置/冲突检测，与宿主半 Settings Bridge 经 HTTP 交互。
 *
 *              本组件是浏览器半配置模块的顶层 UI 入口，集成了 api.ts、store.ts
 *              与 types.ts 的全部逻辑。表单只在有改动（dirty）且可写（writable）
 *              时允许保存；版本冲突时展示明确提示，引导用户刷新页面。
 *
 * 依赖模块：
 * - `./types.js` — TerminalSettingsValues, SettingsDescriptor, ConflictState 类型
 * - `./api.js` — fetchSettings, saveSettings HTTP 客户端
 * - `./store.js` — formReducer, createInitialFormState, buildOpsFromDirty 状态管理
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { TerminalSettingsValues, TerminalProfile } from './types.js';
import { fetchSettings, saveSettings } from './api.js';
import {
  formReducer,
  createInitialFormState,
  buildOpsFromDirty,
  type FormState,
} from './store.js';
import { ProfileTable } from './profile-table.js';

// —— Props 类型 ——

/** TerminalSettingsCard 组件的 props */
export interface TerminalSettingsCardProps {
  /** 视图模式：summary = 摘要文本，page = 完整表单 */
  view: 'summary' | 'page';
}

// —— 组件实现 ——

/**
 * 终端配置卡片组件。
 *
 * 根据 view props 渲染不同内容：
 * - view === 'summary'：返回一行摘要文本（如"终端面板配置 — 5 项设置"）
 * - view === 'page'：返回完整表单，包含 5 个输入框、保存/重置按钮、加载/
 *   保存/错误状态展示、版本冲突提示
 *
 * 表单状态管理采用 useReducer，初始化时自动加载配置（useEffect 依赖 []），
 * 字段编辑触发 EDIT_FIELD action，保存按钮触发 SAVE_START → API 调用 →
 * SAVE_SUCCESS/SAVE_FAILURE，重置按钮触发 RESET action。
 *
 * @param props - 组件 props
 * @returns 配置卡片根元素
 */
export function TerminalSettingsCard(props: TerminalSettingsCardProps): ReactElement {
  const { view } = props;
  const { useReducer, useEffect, useCallback } = React;

  /* useReducer 管理表单状态 */
  const [state, dispatch] = useReducer(formReducer, undefined, createInitialFormState);

  /* 挂载时加载配置 */
  useEffect(() => {
    void (async (): Promise<void> => {
      dispatch({ type: 'LOAD_START' });
      try {
        const descriptor = await fetchSettings();
        dispatch({ type: 'LOAD_SUCCESS', descriptor });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: 'LOAD_FAILURE', message });
      }
    })();
  }, []);

  /* summary 视图：返回摘要文本 */
  if (view === 'summary') {
    return (
      <div style={{ fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' }}>
        终端面板配置 — 5 项设置
      </div>
    );
  }

  /* page 视图：完整表单 */
  return <SettingsForm state={state} dispatch={dispatch} />;
}

// —— 工具函数 ——

/**
 * 解析 terminalProfiles JSON 字符串为数组。
 *
 * @param json - JSON 字符串
 * @returns 配置数组；空串或非法 JSON 返回空数组
 */
function parseProfiles(json: string): TerminalProfile[] {
  if (json === '') return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    /* 非法 JSON（配置被外部改坏）——降级为空表，不阻塞其余字段编辑 */
    return [];
  }
}

// —— 内部子组件 ——

/** SettingsForm 的 props */
interface SettingsFormProps {
  /** 表单状态 */
  state: FormState;
  /** dispatch 函数 */
  dispatch: React.Dispatch<React.ReducerAction<typeof formReducer>>;
}

/**
 * 配置表单完整 UI。
 *
 * 包含 5 个输入框（切换快捷键、Shell 命令、字体族、字号、行高），
 * 保存与重置按钮，加载/保存/错误状态展示，版本冲突横幅。
 *
 * @param props - 表单 props
 * @returns 表单根元素
 */
function SettingsForm(props: SettingsFormProps): ReactElement {
  const { state, dispatch } = props;
  const { useCallback } = React;

  /* 字段编辑回调 */
  const handleEdit = useCallback(
    (field: keyof TerminalSettingsValues, value: string | number | boolean): void => {
      dispatch({ type: 'EDIT_FIELD', field, value });
    },
    [dispatch],
  );

  /* 保存按钮回调 */
  const handleSave = useCallback((): void => {
    void (async (): Promise<void> => {
      dispatch({ type: 'SAVE_START' });
      const ops = buildOpsFromDirty(state.dirtyFields, state.values);
      const result = await saveSettings(state.namespace, ops, state.revision);
      if (result.ok) {
        dispatch({ type: 'SAVE_SUCCESS', descriptor: result.value });
      } else {
        dispatch({ type: 'SAVE_FAILURE', message: result.message, code: result.code });
      }
    })();
  }, [dispatch, state.dirtyFields, state.values, state.namespace, state.revision]);

  /* 重置按钮回调 */
  const handleReset = useCallback((): void => {
    dispatch({ type: 'RESET' });
  }, [dispatch]);

  const { status, values, writable, errorMessage, conflict, dirtyFields } = state;
  const isBusy = status === 'loading' || status === 'saving';
  const isDirty = dirtyFields.size > 0;
  const canSave = writable && isDirty && !isBusy;

  return (
    <div style={{ padding: '20px', fontFamily: 'Inter, var(--dsw-font-family)' }}>
      {/* 加载状态 */}
      {status === 'loading' && (
        <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' }}>
          正在加载配置...
        </div>
      )}

      {/* 版本冲突横幅 */}
      {conflict.isConflict && (
        <div
          style={{
            padding: '12px 16px',
            marginBottom: '16px',
            borderRadius: '6px',
            background: 'var(--dsw-semantic-warning-bg)',
            border: '1px solid var(--dsw-semantic-warning-border)',
            color: 'var(--dsw-semantic-warning-text)',
            fontSize: '13px',
            lineHeight: '1.5',
          }}
        >
          ⚠️ {conflict.message}
        </div>
      )}

      {/* 错误提示 */}
      {status === 'error' && errorMessage !== null && !conflict.isConflict && (
        <div
          style={{
            padding: '12px 16px',
            marginBottom: '16px',
            borderRadius: '6px',
            background: 'var(--dsw-semantic-error-bg)',
            border: '1px solid var(--dsw-semantic-error-border)',
            color: 'var(--dsw-semantic-error-text)',
            fontSize: '13px',
            lineHeight: '1.5',
          }}
        >
          错误：{errorMessage}
        </div>
      )}

      {/* 表单字段 */}
      {status !== 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* 切换快捷键 */}
          <FormField
            label="切换快捷键"
            value={values.toggleShortcut}
            disabled={!writable || isBusy}
            onChange={(v) => handleEdit('toggleShortcut', v)}
            placeholder="ctrl+shift+`"
          />

          {/* 字体族 */}
          <FormField
            label="字体族"
            value={values.fontFamily}
            disabled={!writable || isBusy}
            onChange={(v) => handleEdit('fontFamily', v)}
            placeholder="Consolas, monospace"
          />

          {/* 字号 */}
          <FormField
            label="字号（像素）"
            type="number"
            value={String(values.fontSize)}
            disabled={!writable || isBusy}
            onChange={(v) => handleEdit('fontSize', Number(v))}
            placeholder="14"
          />

          {/* 行高 */}
          <FormField
            label="行高倍数"
            type="number"
            value={String(values.lineHeight)}
            disabled={!writable || isBusy}
            onChange={(v) => handleEdit('lineHeight', Number(v))}
            placeholder="1.2"
            step="0.1"
          />

          {/* 终端配置表 */}
          <div style={{ marginTop: '24px' }}>
            <label
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--dsw-alias-label-primary)',
                display: 'block',
                marginBottom: '12px',
              }}
            >
              终端配置表
            </label>
            <ProfileTable
              profiles={parseProfiles(values.terminalProfiles)}
              disabled={!writable || isBusy}
              onChange={(newProfiles) => {
                handleEdit('terminalProfiles', JSON.stringify(newProfiles));
              }}
            />
          </div>

          {/* 隐藏 DSH 宿主终端开关 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type="checkbox"
              id="hideHostTerminal"
              checked={values.hideHostTerminal}
              disabled={!writable || isBusy}
              onChange={(e) => handleEdit('hideHostTerminal', e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <label
              htmlFor="hideHostTerminal"
              style={{
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--dsw-alias-label-primary)',
                cursor: 'pointer',
              }}
            >
              隐藏 DSH 宿主自带终端
            </label>
            <span
              style={{
                fontSize: '12px',
                color: 'var(--dsw-alias-label-tertiary)',
              }}
            >
              （开启后隐藏侧边栏 + 菜单里的"新建终端"，并拦截 Ctrl+` 快捷键改为打开本插件终端）
            </span>
          </div>

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
            <button
              onClick={handleSave}
              disabled={!canSave}
              style={{
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 500,
                borderRadius: '6px',
                border: 'none',
                background: canSave
                  ? 'var(--dsw-semantic-primary-bg)'
                  : 'var(--dsw-alias-interactive-bg-disabled)',
                color: canSave
                  ? 'var(--dsw-semantic-primary-text)'
                  : 'var(--dsw-alias-label-disabled)',
                cursor: canSave ? 'pointer' : 'not-allowed',
                opacity: canSave ? 1 : 0.6,
              }}
            >
              {status === 'saving' ? '保存中...' : '保存'}
            </button>

            <button
              onClick={handleReset}
              disabled={!isDirty || isBusy}
              style={{
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 500,
                borderRadius: '6px',
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                cursor: isDirty && !isBusy ? 'pointer' : 'not-allowed',
                opacity: isDirty && !isBusy ? 1 : 0.6,
              }}
            >
              重置
            </button>
          </div>

          {/* 只读提示 */}
          {!writable && (
            <div
              style={{
                marginTop: '8px',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-tertiary)',
              }}
            >
              配置处于只读模式，无法保存更改
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// —— 表单字段组件 ——

/** FormField 的 props */
interface FormFieldProps {
  /** 字段标签 */
  label: string;
  /** 字段值 */
  value: string;
  /** 是否禁用 */
  disabled: boolean;
  /** 值变更回调 */
  onChange: (value: string) => void;
  /** 占位符 */
  placeholder?: string;
  /** 输入类型（默认 text） */
  type?: 'text' | 'number';
  /** 数字输入的步进值 */
  step?: string;
}

/**
 * 表单字段组件：标签 + 输入框。
 *
 * @param props - 字段 props
 * @returns 字段容器 div
 */
function FormField(props: FormFieldProps): ReactElement {
  const { label, value, disabled, onChange, placeholder, type = 'text', step } = props;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <label
        style={{
          fontSize: '13px',
          fontWeight: 500,
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        {label}
      </label>
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        step={step}
        style={{
          padding: '8px 12px',
          fontSize: '13px',
          borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: disabled
            ? 'var(--dsw-alias-interactive-bg-disabled)'
            : 'var(--dsw-specific-tip)',
          color: 'var(--dsw-alias-label-primary)',
          outline: 'none',
        }}
      />
    </div>
  );
}
