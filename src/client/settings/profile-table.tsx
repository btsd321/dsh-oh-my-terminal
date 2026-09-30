/**
 * @file 终端配置表格组件
 * @description 终端配置表（TerminalProfile[]）的 CRUD UI，支持 inline 编辑、新增行、
 *              删除、origin 约束（auto 项不可删除/path 不可改，name 始终可改）。
 *
 *              表格设计：
 *              - 类型列：显示 kind 对应的 label（如 "PowerShell 7+"）
 *              - 名称列：inline 编辑（点击进入输入框）
 *              - 路径列：origin=auto 只读灰显，origin=user 可编辑
 *              - 来源列：徽章显示"自动"/"手动"
 *              - 操作列：编辑/删除按钮（auto 项删除按钮禁用）
 *              - 新增行：表格底部"+ 新增终端"按钮展开表单
 *
 *              数据流：
 *              - props.profiles 是解析后的 TerminalProfile[]
 *              - 编辑/新增/删除触发 props.onChange(newProfiles)
 *              - 父组件（card.tsx）负责序列化为 JSON 字符串并提交 settings
 *
 *              架构位置：浏览器半配置模块的表格子组件，被 card.tsx 引用。
 */

import * as React from 'react';
import type { ReactElement } from 'react';
import type { TerminalProfile, TerminalKind, TerminalKindOption } from './types.js';
import { fetchTerminalKinds } from './api.js';
import { ProfileRow } from './profile-row.js';
import { AddProfileForm } from './profile-add-form.js';
import { createLogger } from '../../logger.js';

const log = createLogger('settings-table');

// —— 表格列宽定义 ——

/**
 * 表格列模板（grid-template-columns 值）。
 *
 * 路径列用固定宽度（300px）而非 1fr——长路径不会撑开布局把旁边列挤歪，
 * 超出部分在列内水平滚动。类型/名称/来源/操作列也固定宽度，保证各列
 * 比例稳定不受内容长度影响。
 */
const GRID_COLS = '140px 1fr 300px 80px 100px';

// —— Props 类型 ——

/** ProfileTable 组件的 props */
export interface ProfileTableProps {
  /** 终端配置数组（已从 JSON 字符串解析） */
  profiles: TerminalProfile[];
  /** 是否禁用（只读模式或保存中） */
  disabled: boolean;
  /** 配置变更回调（接收新的 profiles 数组） */
  onChange: (profiles: TerminalProfile[]) => void;
}

// —— 工具函数 ——

/**
 * 生成简短的终端配置 id（形如 `t-pwsh-a3f9`）。
 *
 * @param kind - 终端种类
 * @returns 配置 id
 */
function generateProfileId(kind: TerminalKind): string {
  const suffix = Math.random().toString(16).slice(2, 6).padStart(4, '0');
  return `t-${kind}-${suffix}`;
}

// —— 主组件 ——

/**
 * 终端配置表格组件。
 *
 * 显示所有终端配置项，支持 inline 编辑、新增、删除。auto 项不可删除、path 不可改，
 * 但 name 始终可编辑。新增行在表格底部，点击"+ 新增终端"展开表单。
 *
 * @param props - 组件 props
 * @returns 表格根元素
 */
export function ProfileTable(props: ProfileTableProps): ReactElement {
  const { profiles, disabled, onChange } = props;
  const { useState, useEffect } = React;

  /** 终端类型选项列表（从 API 拉取） */
  const [kindOptions, setKindOptions] = useState<TerminalKindOption[]>([]);
  /** 是否正在加载类型列表 */
  const [loadingKinds, setLoadingKinds] = useState(true);
  /** 是否显示新增表单 */
  const [showAddForm, setShowAddForm] = useState(false);

  /** 挂载时拉取类型列表 */
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const kinds = await fetchTerminalKinds();
        setKindOptions(kinds);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('拉取终端类型列表失败', msg);
        // 失败时保持空数组，新增按钮因 kindOptions.length === 0 而禁用
      } finally {
        setLoadingKinds(false);
      }
    })();
  }, []);

  /** 查找类型对应的显示标签 */
  const getKindLabel = (kind: TerminalKind): string => {
    const option = kindOptions.find(o => o.kind === kind);
    return option?.label ?? kind;
  };

  /** 改名回调 */
  const handleRename = (id: string, newName: string): void => {
    const trimmed = newName.trim();
    if (trimmed.length === 0) return; // 空名称不提交
    const updated = profiles.map(p => (p.id === id ? { ...p, name: trimmed } : p));
    onChange(updated);
  };

  /** 修改路径回调 */
  const handleUpdatePath = (id: string, newPath: string): void => {
    const updated = profiles.map(p => (p.id === id ? { ...p, path: newPath.trim() } : p));
    onChange(updated);
  };

  /** 删除回调 */
  const handleDelete = (id: string): void => {
    const target = profiles.find(p => p.id === id);
    if (target === undefined) return;
    if (target.origin === 'auto') return; // auto 项不可删除，按钮应该禁用

    if (!confirm(`确定删除终端配置 "${target.name}"？`)) return;
    const updated = profiles.filter(p => p.id !== id);
    onChange(updated);
  };

  /** 新增回调 */
  const handleAdd = (type: TerminalKind, name: string, path: string): void => {
    const trimmedName = name.trim();
    const trimmedPath = path.trim();

    // 校验：name 非空
    if (trimmedName.length === 0) {
      alert('显示名不能为空');
      return;
    }

    // 校验：name 不重名
    if (profiles.some(p => p.name === trimmedName)) {
      alert(`显示名 "${trimmedName}" 已存在`);
      return;
    }

    // 校验：custom 必须填 path
    if (type === 'custom' && trimmedPath.length === 0) {
      alert('自定义类型必须填写可执行文件路径');
      return;
    }

    const newProfile: TerminalProfile = {
      id: generateProfileId(type),
      type,
      name: trimmedName,
      path: trimmedPath,
      origin: 'user',
    };

    onChange([...profiles, newProfile]);
    setShowAddForm(false); // 关闭新增表单
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* 表格容器 */}
      <div
        style={{
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '6px',
          overflow: 'hidden',
        }}
      >
        {/* 表头 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: GRID_COLS,
            gap: '12px',
            padding: '10px 12px',
            background: 'var(--dsw-alias-interactive-bg-hover)',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            fontSize: '12px',
            fontWeight: 600,
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          <div>类型</div>
          <div>名称</div>
          <div>路径</div>
          <div>来源</div>
          <div>操作</div>
        </div>

        {/* 表格主体 */}
        {profiles.length === 0 ? (
          <div
            style={{
              padding: '32px 12px',
              textAlign: 'center',
              fontSize: '13px',
              color: 'var(--dsw-alias-label-tertiary)',
            }}
          >
            暂无终端配置
          </div>
        ) : (
          profiles.map(profile => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              kindLabel={getKindLabel(profile.type)}
              disabled={disabled}
              onRename={handleRename}
              onUpdatePath={handleUpdatePath}
              onDelete={handleDelete}
            />
          ))
        )}

        {/* 新增表单（在表格内最后一行） */}
        {showAddForm && (
          <AddProfileForm
            kindOptions={kindOptions}
            disabled={disabled}
            onAdd={handleAdd}
            onCancel={() => setShowAddForm(false)}
          />
        )}
      </div>

      {/* 新增按钮（表格下方） */}
      {!showAddForm && (
        <button
          onClick={() => setShowAddForm(true)}
          disabled={disabled || loadingKinds || kindOptions.length === 0}
          style={{
            padding: '8px 12px',
            fontSize: '13px',
            fontWeight: 500,
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary)',
            cursor: disabled || loadingKinds ? 'not-allowed' : 'pointer',
            opacity: disabled || loadingKinds ? 0.6 : 1,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            alignSelf: 'flex-start',
          }}
        >
          <span>+</span>
          <span>{loadingKinds ? '加载中...' : '新增终端'}</span>
        </button>
      )}
    </div>
  );
}
