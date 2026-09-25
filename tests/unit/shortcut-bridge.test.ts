/**
 * @file shortcut-bridge.ts 单元测试
 * @description 覆盖 shortcuts 接入状态标志（reset/mark/get）与面板切换回调
 *              注册表（成对清理、广播通知、空集安全）的纯逻辑契约。
 *              模块级可变状态使各用例共享同一实例——beforeEach 统一复位。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isShortcutsActive, resetShortcutsState, markShortcutsActive,
  getShortcutsCatalog, registerPanelToggler, notifyPanelToggle,
} from '../../src/client/shortcut-bridge.js';

/** 复位桥状态：用例间互不残留（模拟插件 re-apply 的复位语义） */
beforeEach(() => {
  resetShortcutsState();
});

describe('接入状态标志', () => {
  it('初始未接入', () => {
    assert.equal(isShortcutsActive(), false);
    assert.equal(getShortcutsCatalog(), undefined);
  });

  it('markShortcutsActive 后已接入且 catalog 可读取', () => {
    const catalog = { getSnapshot: () => [], subscribe: () => () => {} };
    markShortcutsActive(catalog);
    assert.equal(isShortcutsActive(), true);
    assert.equal(getShortcutsCatalog(), catalog);
  });

  it('resetShortcutsState 复位接入状态与 catalog（插件重载语义）', () => {
    markShortcutsActive({ getSnapshot: () => [], subscribe: () => () => {} });
    resetShortcutsState();
    assert.equal(isShortcutsActive(), false);
    assert.equal(getShortcutsCatalog(), undefined);
  });
});

describe('面板切换回调注册表', () => {
  it('notifyPanelToggle 调用所有已注册回调（多面板广播）', () => {
    const calls: string[] = [];
    registerPanelToggler(() => calls.push('a'));
    registerPanelToggler(() => calls.push('b'));
    notifyPanelToggle();
    assert.deepEqual(calls, ['a', 'b']);
  });

  it('注销函数成对清理：注销后 notify 不再调用', () => {
    let count = 0;
    const dispose = registerPanelToggler(() => { count += 1; });
    dispose();
    notifyPanelToggle();
    assert.equal(count, 0);
  });

  it('同一回调重复注册只生效一次；注销一次即移除', () => {
    let count = 0;
    const toggle = (): void => { count += 1; };
    const dispose1 = registerPanelToggler(toggle);
    registerPanelToggler(toggle);
    notifyPanelToggle();
    assert.equal(count, 1);
    dispose1();
    notifyPanelToggle();
    assert.equal(count, 1);
  });

  it('无注册回调时 notify 为安全空操作', () => {
    notifyPanelToggle();
    assert.ok(true);
  });

  it('注销函数幂等：重复调用无副作用', () => {
    let count = 0;
    const dispose = registerPanelToggler(() => { count += 1; });
    dispose();
    dispose();
    notifyPanelToggle();
    assert.equal(count, 0);
  });
});
