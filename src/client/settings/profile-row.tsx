/**
 * @file 终端配置表格行组件
 * @description 配置表格的单行组件，支持 inline 编辑 name/path 字段。
 *              从 profile-table.tsx 拆分而来（消除 God Object，单文件 <600 行）。
 *
 *              - name 字段：点击进入输入框，失焦/回车提交，Escape 取消
 *              - path 字段：origin=auto 只读灰显，origin=user 可编辑
 *              - 删除按钮：origin=auto 禁用（自动探测项不可删除）
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { TerminalProfile } from './types.js';

/** 表格列模板（与 profile-table.tsx 的 GRID_COLS 一致） */
const GRID_COLS = '140px 1fr 300px 80px 100px';

/** 路径列固定宽度（像素），与 GRID_COLS 中路径列一致 */
const PATH_COL_WIDTH = 300;

/** ProfileRow 组件的 props */
export interface ProfileRowProps {
  /** 配置项 */
  profile: TerminalProfile;
  /** 类型显示标签 */
  kindLabel: string;
  /** 是否禁用 */
  disabled: boolean;
  /** 改名回调 */
  onRename: (id: string, newName: string) => void;
  /** 修改路径回调 */
  onUpdatePath: (id: string, newPath: string) => void;
  /** 删除回调 */
  onDelete: (id: string) => void;
}

/**
 * 配置表格行组件。
 *
 * 支持 inline 编辑：点击 name/path 字段进入输入框，失焦或回车提交。
 * origin=auto 的 path 字段只读灰显。
 *
 * @param props - 行 props
 * @returns 表格行元素
 */
export function ProfileRow(props: ProfileRowProps): ReactElement {
  const { profile, kindLabel, disabled, onRename, onUpdatePath, onDelete } = props;
  const { useState } = React;

  /** name 编辑态 */
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(profile.name);

  /** path 编辑态 */
  const [editingPath, setEditingPath] = useState(false);
  const [pathValue, setPathValue] = useState(profile.path);

  /** 提交 name 修改 */
  const submitName = (): void => {
    setEditingName(false);
    if (nameValue.trim() !== profile.name) {
      onRename(profile.id, nameValue);
    } else {
      setNameValue(profile.name); // 恢复原值
    }
  };

  /** 提交 path 修改 */
  const submitPath = (): void => {
    setEditingPath(false);
    if (pathValue.trim() !== profile.path) {
      onUpdatePath(profile.id, pathValue);
    } else {
      setPathValue(profile.path); // 恢复原值
    }
  };

  const canEditPath = profile.origin === 'user';
  const canDelete = profile.origin === 'user';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_COLS,
        gap: '12px',
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        fontSize: '13px',
        alignItems: 'center',
      }}
    >
      {/* 类型列 */}
      <div style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 500 }}>
        {kindLabel}
      </div>

      {/* 名称列（inline 编辑） */}
      <div>
        {editingName ? (
          <input
            type="text"
            value={nameValue}
            disabled={disabled}
            autoFocus
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={submitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitName();
              if (e.key === 'Escape') {
                setNameValue(profile.name);
                setEditingName(false);
              }
            }}
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: '13px',
              borderRadius: '4px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-specific-tip)',
              color: 'var(--dsw-alias-label-primary)',
              outline: 'none',
            }}
          />
        ) : (
          <div
            onClick={() => !disabled && setEditingName(true)}
            style={{
              padding: '4px 8px',
              cursor: disabled ? 'not-allowed' : 'pointer',
              borderRadius: '4px',
              color: 'var(--dsw-alias-label-primary)',
            }}
            title="点击编辑"
          >
            {profile.name}
          </div>
        )}
      </div>

      {/* 路径列（origin=auto 只读，origin=user 可编辑）
          固定宽度 + overflow:hidden 防止长路径撑开布局；显示态用
          overflow-x:auto 让长路径可水平滚动而不挤歪旁边的列 */}
      <div style={{ maxWidth: PATH_COL_WIDTH + 'px', overflow: 'hidden' }}>
        {canEditPath && editingPath ? (
          <input
            type="text"
            value={pathValue}
            disabled={disabled}
            autoFocus
            onChange={(e) => setPathValue(e.target.value)}
            onBlur={submitPath}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPath();
              if (e.key === 'Escape') {
                setPathValue(profile.path);
                setEditingPath(false);
              }
            }}
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: '13px',
              borderRadius: '4px',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-specific-tip)',
              color: 'var(--dsw-alias-label-primary)',
              outline: 'none',
            }}
          />
        ) : (
          <div
            onClick={() => canEditPath && !disabled && setEditingPath(true)}
            style={{
              padding: '4px 8px',
              cursor: canEditPath && !disabled ? 'pointer' : 'default',
              borderRadius: '4px',
              color: canEditPath
                ? 'var(--dsw-alias-label-primary)'
                : 'var(--dsw-alias-label-tertiary)',
              fontFamily: 'monospace',
              fontSize: '12px',
              /* 水平滚动：长路径不换行，超出部分可拖动滚动条查看 */
              overflowX: 'auto',
              whiteSpace: 'nowrap',
            }}
            title={canEditPath ? '点击编辑' : '自动探测的路径不可修改'}
          >
            {profile.path || '（自动解析）'}
          </div>
        )}
      </div>

      {/* 来源列（徽章） */}
      <div>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            fontSize: '11px',
            fontWeight: 500,
            borderRadius: '3px',
            background:
              profile.origin === 'auto'
                ? 'var(--dsw-semantic-primary-bg)'
                : 'var(--dsw-alias-interactive-bg-hover)',
            color:
              profile.origin === 'auto'
                ? 'var(--dsw-semantic-primary-text)'
                : 'var(--dsw-alias-label-secondary)',
          }}
        >
          {profile.origin === 'auto' ? '自动' : '手动'}
        </span>
      </div>

      {/* 操作列（删除按钮） */}
      <div>
        <button
          onClick={() => onDelete(profile.id)}
          disabled={disabled || !canDelete}
          style={{
            padding: '4px 12px',
            fontSize: '12px',
            borderRadius: '4px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent',
            color: canDelete
              ? 'var(--dsw-semantic-error-text)'
              : 'var(--dsw-alias-label-disabled)',
            cursor: disabled || !canDelete ? 'not-allowed' : 'pointer',
            opacity: disabled || !canDelete ? 0.6 : 1,
          }}
          title={canDelete ? '删除' : '自动探测的配置不可删除'}
        >
          删除
        </button>
      </div>
    </div>
  );
}
