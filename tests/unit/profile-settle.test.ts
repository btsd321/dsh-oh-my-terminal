/**
 * @file 配置表持久层落定单元测试
 * @description 回归锁定 settleProfileTable 的合并与落盘决策语义：
 *              读回非空时绝不写回（用户改过的 name/手动新增项必须原样保留，
 *              任何写回都会覆盖它们）；仅首跑（读回为空且探测有结果）产出落盘
 *              载荷；合并语义与 mergeProfiles 一致（已保存项全保留，探测到的
 *              新 type/path 补进去，type+path 双匹配视为同一项）。
 *
 *              曾因读写通道错位（apply 期读 volatile 配置、写 settings user 层）
 *              导致 saved 恒为空，每次启动都判首跑并覆盖用户配置——本组用例
 *              锁住"读回非空不落盘"这条保命语义。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TerminalProfile } from '../../src/terminal/detect.js';
import { settleProfileTable } from '../../src/terminal/store.js';

/** 构造一个自动探测项（origin 固定 auto，id 按入参钉死便于断言） */
function detectedProfile(id: string, type: TerminalProfile['type'], path: string): TerminalProfile {
  return { id, type, name: type, path, origin: 'auto' };
}

describe('settleProfileTable', () => {
  it('首跑（读回为空）产出落盘载荷，内容与合并结果一致', () => {
    const detected = [detectedProfile('t-pwsh-1111', 'pwsh', 'C:\\pwsh.exe')];
    const { merged, persistPayload } = settleProfileTable([], detected);
    assert.equal(merged.length, 1);
    assert.notEqual(persistPayload, null);
    assert.deepEqual(JSON.parse(persistPayload ?? '[]'), merged);
  });

  it('读回非空时不落盘，用户改过的 name 原样保留', () => {
    const saved: TerminalProfile[] = [
      { id: 't-pwsh-8bd5', type: 'pwsh', name: '我的主力终端', path: 'C:\\pwsh.exe', origin: 'auto' },
    ];
    const detected = [detectedProfile('t-pwsh-2222', 'pwsh', 'C:\\pwsh.exe')];
    const { merged, persistPayload } = settleProfileTable(saved, detected);
    assert.equal(persistPayload, null);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.id, 't-pwsh-8bd5');
    assert.equal(merged[0]?.name, '我的主力终端');
  });

  it('读回非空时探测到的新终端补进末尾，不覆盖既有项', () => {
    const saved: TerminalProfile[] = [
      { id: 't-pwsh-8bd5', type: 'pwsh', name: '我的主力终端', path: 'C:\\pwsh.exe', origin: 'auto' },
    ];
    const detected = [
      detectedProfile('t-pwsh-2222', 'pwsh', 'C:\\pwsh.exe'),
      detectedProfile('t-cmd-3333', 'cmd', 'C:\\Windows\\System32\\cmd.exe'),
    ];
    const { merged, persistPayload } = settleProfileTable(saved, detected);
    assert.equal(persistPayload, null);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.name, '我的主力终端');
    assert.equal(merged[1]?.type, 'cmd');
  });

  it('type 相同但 path 不同视为不同项（用户可能装了两个同类型终端）', () => {
    const saved: TerminalProfile[] = [
      { id: 't-bash-aaaa', type: 'bash', name: '旧 bash', path: 'C:\\old\\bash.exe', origin: 'user' },
    ];
    const detected = [detectedProfile('t-bash-bbbb', 'bash', 'C:\\new\\bash.exe')];
    const { merged } = settleProfileTable(saved, detected);
    assert.equal(merged.length, 2);
  });

  it('读回与探测都为空时不落盘（没有内容可写）', () => {
    const { merged, persistPayload } = settleProfileTable([], []);
    assert.equal(merged.length, 0);
    assert.equal(persistPayload, null);
  });
});
