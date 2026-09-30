/**
 * @file 新增终端配置表单组件
 * @description 配置表格底部的新增行表单，输入 type/name/path 后提交。
 *              从 profile-table.tsx 拆分而来（消除 God Object，单文件 <600 行）。
 *
 *              - 类型：下拉选择（kindOptions 第一项默认）
 *              - 名称：文本输入，回车提交
 *              - 路径：文本输入，可空（留空则按 type 在 $PATH 解析）
 *              - 提交后重置表单，Escape 取消
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { TerminalKind, TerminalKindOption } from './types.js';

/** 表格列模板（与 profile-table.tsx 的 GRID_COLS 一致） */
const GRID_COLS = '140px 1fr 300px 80px 100px';

/** AddProfileForm 的 props */
export interface AddProfileFormProps {
  /** 类型选项列表 */
  kindOptions: TerminalKindOption[];
  /** 是否禁用 */
  disabled: boolean;
  /** 新增回调 */
  onAdd: (type: TerminalKind, name: string, path: string) => void;
  /** 取消回调 */
  onCancel: () => void;
}

/**
 * 新增终端配置表单（在表格内最后一行）。
 *
 * @param props - 表单 props
 * @returns 表单行元素
 */
export function AddProfileForm(props: AddProfileFormProps): ReactElement {
  const { kindOptions, disabled, onAdd, onCancel } = props;
  const { useState } = React;

  const [selectedType, setSelectedType] = useState<TerminalKind>(
    kindOptions[0]?.kind ?? 'pwsh',
  );
  const [name, setName] = useState('');
  const [path, setPath] = useState('');

  const handleSubmit = (): void => {
    onAdd(selectedType, name, path);
    // 重置表单
    setName('');
    setPath('');
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_COLS,
        gap: '12px',
        padding: '10px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-interactive-bg-hover)',
        fontSize: '13px',
        alignItems: 'center',
      }}
    >
      {/* 类型下拉 */}
      <select
        value={selectedType}
        disabled={disabled}
        onChange={(e) => setSelectedType(e.target.value as TerminalKind)}
        style={{
          padding: '4px 8px',
          fontSize: '13px',
          borderRadius: '4px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-specific-tip)',
          color: 'var(--dsw-alias-label-primary)',
          outline: 'none',
        }}
      >
        {kindOptions.map(opt => (
          <option key={opt.kind} value={opt.kind}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* 名称输入 */}
      <input
        type="text"
        value={name}
        disabled={disabled}
        placeholder="显示名"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          padding: '4px 8px',
          fontSize: '13px',
          borderRadius: '4px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-specific-tip)',
          color: 'var(--dsw-alias-label-primary)',
          outline: 'none',
        }}
      />

      {/* 路径输入 */}
      <input
        type="text"
        value={path}
        disabled={disabled}
        placeholder="可执行文件路径（可选）"
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          padding: '4px 8px',
          fontSize: '13px',
          borderRadius: '4px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-specific-tip)',
          color: 'var(--dsw-alias-label-primary)',
          fontFamily: 'monospace',
          outline: 'none',
        }}
      />

      {/* 来源占位（新增项始终是 user） */}
      <div />

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: '6px' }}>
        <button
          onClick={handleSubmit}
          disabled={disabled}
          style={{
            padding: '4px 10px',
            fontSize: '12px',
            borderRadius: '4px',
            border: 'none',
            background: 'var(--dsw-semantic-primary-bg)',
            color: 'var(--dsw-semantic-primary-text)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          添加
        </button>
        <button
          onClick={onCancel}
          disabled={disabled}
          style={{
            padding: '4px 10px',
            fontSize: '12px',
            borderRadius: '4px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}
