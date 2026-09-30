/**
 * @file terminal/reducer.ts 单元测试
 * @description 覆盖 terminalReducer 纯函数的所有 action 类型：
 *              RESTORE / SET_BUSY / SET_BOOT_READY / ADD_INSTANCE / SPLIT_INSTANCE /
 *              REMOVE_INSTANCE / RESTART_INSTANCE / MARK_EXITED / SET_ACTIVE / RENAME_INSTANCE。
 *
 *              重点验证：
 *              - 不可变更新（返回新对象，不修改原 state）
 *              - REMOVE_INSTANCE 的空组移除与活跃位维护
 *              - SPLIT_INSTANCE 的插入位置（afterInstanceId 之后）
 *              - RESTART_INSTANCE 的引用替换与 title 保留
 *              - MARK_EXITED 的 instances + groups 同步更新
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { terminalReducer, createInitialState } from '../../src/client/terminal/reducer.js';
import type { TerminalInstance, TerminalGroup, TerminalState } from '../../src/client/types.js';

// —— 测试数据工厂 ——

/** 构造一个终端实例 */
function makeInstance(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: `terminal-${id}`,
    shell: 'pwsh.exe',
    cwd: 'C:\\project',
    exited: false,
    ...overrides,
  };
}

/** 构造一个单实例组 */
function makeGroup(id: string, instances: TerminalInstance[], activeInstanceId: string | null = null): TerminalGroup {
  return {
    id,
    instances,
    activeInstanceId: activeInstanceId ?? instances[0]?.id ?? null,
  };
}

/** 构造包含多个实例/组的状态 */
function makeState(
  instances: TerminalInstance[],
  groups: TerminalGroup[],
  activeInstanceId: string | null = null,
  extra: Partial<TerminalState> = {},
): TerminalState {
  return {
    instances,
    groups,
    activeInstanceId: activeInstanceId ?? instances[0]?.id ?? null,
    busy: false,
    bootReady: false,
    ...extra,
  };
}

// —— 测试用例 ——

describe('terminalReducer', () => {
  describe('createInitialState', () => {
    it('返回空状态', () => {
      const state = createInitialState();
      assert.deepEqual(state.instances, []);
      assert.deepEqual(state.groups, []);
      assert.equal(state.activeInstanceId, null);
      assert.equal(state.busy, false);
      assert.equal(state.bootReady, false);
    });
  });

  describe('RESTORE', () => {
    it('替换 instances、groups、activeInstanceId', () => {
      const inst = makeInstance('t1');
      const group = makeGroup('g1', [inst]);
      const state = createInitialState();
      const result = terminalReducer(state, {
        type: 'RESTORE',
        instances: [inst],
        groups: [group],
        activeInstanceId: 't1',
      });
      assert.equal(result.instances.length, 1);
      assert.equal(result.groups.length, 1);
      assert.equal(result.activeInstanceId, 't1');
    });

    it('保留 busy 和 bootReady', () => {
      const state = makeState([], [], null, { busy: true, bootReady: true });
      const result = terminalReducer(state, {
        type: 'RESTORE',
        instances: [makeInstance('t1')],
        groups: [makeGroup('g1', [makeInstance('t1')])],
        activeInstanceId: 't1',
      });
      assert.equal(result.busy, true);
      assert.equal(result.bootReady, true);
    });
  });

  describe('SET_BUSY', () => {
    it('设置 busy=true', () => {
      const state = makeState([makeInstance('t1')], [makeGroup('g1', [makeInstance('t1')])], 't1');
      const result = terminalReducer(state, { type: 'SET_BUSY', busy: true });
      assert.equal(result.busy, true);
    });

    it('不修改其他字段', () => {
      const state = makeState([makeInstance('t1')], [makeGroup('g1', [makeInstance('t1')])], 't1');
      const result = terminalReducer(state, { type: 'SET_BUSY', busy: true });
      assert.equal(result.instances.length, 1);
      assert.equal(result.activeInstanceId, 't1');
    });
  });

  describe('SET_BOOT_READY', () => {
    it('设置 bootReady=true 且 busy=false', () => {
      const state = makeState([], [], null, { busy: true, bootReady: false });
      const result = terminalReducer(state, { type: 'SET_BOOT_READY' });
      assert.equal(result.bootReady, true);
      assert.equal(result.busy, false);
    });
  });

  describe('ADD_INSTANCE', () => {
    it('追加实例和组，设为活跃', () => {
      const inst1 = makeInstance('t1');
      const state = makeState([inst1], [makeGroup('g1', [inst1])], 't1');
      const inst2 = makeInstance('t2');
      const group2 = makeGroup('t2', [inst2]);
      const result = terminalReducer(state, {
        type: 'ADD_INSTANCE',
        instance: inst2,
        group: group2,
      });
      assert.equal(result.instances.length, 2);
      assert.equal(result.groups.length, 2);
      assert.equal(result.activeInstanceId, 't2');
    });

    it('不修改原 state（不可变）', () => {
      const inst1 = makeInstance('t1');
      const original = makeState([inst1], [makeGroup('g1', [inst1])], 't1');
      const inst2 = makeInstance('t2');
      const group2 = makeGroup('t2', [inst2]);
      terminalReducer(original, { type: 'ADD_INSTANCE', instance: inst2, group: group2 });
      assert.equal(original.instances.length, 1);
      assert.equal(original.groups.length, 1);
    });
  });

  describe('SPLIT_INSTANCE', () => {
    it('插入到 afterInstanceId 之后', () => {
      const inst1 = makeInstance('t1');
      const inst2 = makeInstance('t2');
      const group = makeGroup('g1', [inst1, inst2], 't2');
      const state = makeState([inst1, inst2], [group], 't2');
      const inst3 = makeInstance('t3');
      const result = terminalReducer(state, {
        type: 'SPLIT_INSTANCE',
        instance: inst3,
        groupId: 'g1',
        afterInstanceId: 't1',
      });
      // 组内顺序应为 t1, t3, t2
      const g = result.groups[0]!;
      assert.equal(g.instances[0]!.id, 't1');
      assert.equal(g.instances[1]!.id, 't3');
      assert.equal(g.instances[2]!.id, 't2');
      assert.equal(result.activeInstanceId, 't3');
    });

    it('全局 instances 追加新实例', () => {
      const inst1 = makeInstance('t1');
      const state = makeState([inst1], [makeGroup('g1', [inst1])], 't1');
      const inst2 = makeInstance('t2');
      const result = terminalReducer(state, {
        type: 'SPLIT_INSTANCE',
        instance: inst2,
        groupId: 'g1',
        afterInstanceId: 't1',
      });
      assert.equal(result.instances.length, 2);
    });
  });

  describe('REMOVE_INSTANCE', () => {
    it('移除实例并设活跃位为相邻实例', () => {
      const inst1 = makeInstance('t1');
      const inst2 = makeInstance('t2');
      const inst3 = makeInstance('t3');
      const group = makeGroup('g1', [inst1, inst2, inst3], 't2');
      const state = makeState([inst1, inst2, inst3], [group], 't2');
      const result = terminalReducer(state, { type: 'REMOVE_INSTANCE', id: 't2' });
      assert.equal(result.instances.length, 2);
      // 移除 t2 后活跃位应回退到 t1（idx 0）或 t3（idx 1）
      assert.notEqual(result.activeInstanceId, 't2');
    });

    it('空组整体移除', () => {
      const inst1 = makeInstance('t1');
      const group1 = makeGroup('g1', [inst1]);
      const inst2 = makeInstance('t2');
      const group2 = makeGroup('g2', [inst2]);
      const state = makeState([inst1, inst2], [group1, group2], 't1');
      const result = terminalReducer(state, { type: 'REMOVE_INSTANCE', id: 't2' });
      assert.equal(result.groups.length, 1);
      assert.equal(result.groups[0]!.id, 'g1');
    });

    it('移除最后一个实例时 activeInstanceId 为 null', () => {
      const inst1 = makeInstance('t1');
      const group = makeGroup('g1', [inst1]);
      const state = makeState([inst1], [group], 't1');
      const result = terminalReducer(state, { type: 'REMOVE_INSTANCE', id: 't1' });
      assert.equal(result.instances.length, 0);
      assert.equal(result.groups.length, 0);
      assert.equal(result.activeInstanceId, null);
    });
  });

  describe('RESTART_INSTANCE', () => {
    it('替换实例引用，保留新实例的 title', () => {
      const inst1 = makeInstance('t1', { title: 'old-title' });
      const group = makeGroup('g1', [inst1]);
      const state = makeState([inst1], [group], 't1');
      const newInst = makeInstance('t1-new', { title: 'new-title' });
      const result = terminalReducer(state, {
        type: 'RESTART_INSTANCE',
        oldId: 't1',
        newInstance: newInst,
      });
      assert.equal(result.instances[0]!.id, 't1-new');
      assert.equal(result.instances[0]!.title, 'new-title');
      assert.equal(result.activeInstanceId, 't1-new');
    });

    it('组内引用同步更新', () => {
      const inst1 = makeInstance('t1');
      const inst2 = makeInstance('t2');
      const group = makeGroup('g1', [inst1, inst2], 't1');
      const state = makeState([inst1, inst2], [group], 't1');
      const newInst = makeInstance('t1-new');
      const result = terminalReducer(state, {
        type: 'RESTART_INSTANCE',
        oldId: 't1',
        newInstance: newInst,
      });
      const g = result.groups[0]!;
      assert.equal(g.instances[0]!.id, 't1-new');
      assert.equal(g.instances[1]!.id, 't2');
      assert.equal(g.activeInstanceId, 't1-new');
    });
  });

  describe('MARK_EXITED', () => {
    it('标记实例为已退出', () => {
      const inst1 = makeInstance('t1');
      const group = makeGroup('g1', [inst1]);
      const state = makeState([inst1], [group], 't1');
      const result = terminalReducer(state, { type: 'MARK_EXITED', id: 't1' });
      assert.equal(result.instances[0]!.exited, true);
    });

    it('组内实例同步标记', () => {
      const inst1 = makeInstance('t1');
      const inst2 = makeInstance('t2');
      const group = makeGroup('g1', [inst1, inst2], 't1');
      const state = makeState([inst1, inst2], [group], 't1');
      const result = terminalReducer(state, { type: 'MARK_EXITED', id: 't2' });
      assert.equal(result.groups[0]!.instances[1]!.exited, true);
      assert.equal(result.groups[0]!.instances[0]!.exited, false);
    });
  });

  describe('SET_ACTIVE', () => {
    it('更新全局活跃位', () => {
      const inst1 = makeInstance('t1');
      const inst2 = makeInstance('t2');
      const state = makeState([inst1, inst2], [makeGroup('g1', [inst1, inst2])], 't1');
      const result = terminalReducer(state, { type: 'SET_ACTIVE', id: 't2' });
      assert.equal(result.activeInstanceId, 't2');
    });

    it('更新所在组的组内活跃位', () => {
      const inst1 = makeInstance('t1');
      const inst2 = makeInstance('t2');
      const group = makeGroup('g1', [inst1, inst2], 't1');
      const state = makeState([inst1, inst2], [group], 't1');
      const result = terminalReducer(state, { type: 'SET_ACTIVE', id: 't2' });
      assert.equal(result.groups[0]!.activeInstanceId, 't2');
    });
  });

  describe('RENAME_INSTANCE', () => {
    it('更新实例 title', () => {
      const inst1 = makeInstance('t1', { title: 'old' });
      const group = makeGroup('g1', [inst1]);
      const state = makeState([inst1], [group], 't1');
      const result = terminalReducer(state, { type: 'RENAME_INSTANCE', id: 't1', title: 'new-name' });
      assert.equal(result.instances[0]!.title, 'new-name');
    });

    it('组内 title 同步更新', () => {
      const inst1 = makeInstance('t1', { title: 'old' });
      const inst2 = makeInstance('t2');
      const group = makeGroup('g1', [inst1, inst2]);
      const state = makeState([inst1, inst2], [group], 't1');
      const result = terminalReducer(state, { type: 'RENAME_INSTANCE', id: 't1', title: 'renamed' });
      assert.equal(result.groups[0]!.instances[0]!.title, 'renamed');
    });
  });

  describe('不可变性', () => {
    it('所有 action 返回新对象（不修改原 state）', () => {
      const inst1 = makeInstance('t1');
      const group = makeGroup('g1', [inst1]);
      const original = makeState([inst1], [group], 't1');
      const originalSnapshot = JSON.stringify(original);

      // 执行多个 action
      terminalReducer(original, { type: 'SET_BUSY', busy: true });
      terminalReducer(original, { type: 'SET_ACTIVE', id: 't1' });
      terminalReducer(original, { type: 'MARK_EXITED', id: 't1' });
      terminalReducer(original, { type: 'RENAME_INSTANCE', id: 't1', title: 'x' });

      assert.equal(JSON.stringify(original), originalSnapshot);
    });
  });
});
