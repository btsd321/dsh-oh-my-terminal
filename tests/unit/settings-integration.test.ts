/**
 * @file settings 集成注册单元测试
 * @description 回归锁定 registerSettingsIntegration 的命名空间注册契约：
 *              注册是 settings 服务注册表的唯一入口，缺注册时 describe/mutate
 *              恒报「命名空间不存在」，前端配置卡片静默不渲染（无报错、无入口）。
 *              同时锁定宿主兼容面：旧宿主（0.1.5 系）的 settings 服务没有
 *              configure 方法，集成不得因此抛错中断注册——曾因无守卫调用
 *              configure 抛 TypeError，把随后的 register 一并挡掉。
 *              本测试用假 settings 服务断言：注册确实发生且 schema 原样透传、
 *              无 configure 的宿主不炸、有 configure 时才调用、重复注册幂等、
 *              其余注册失败如实上抛（不把失败包装成成功）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { registerSettingsIntegration, SETTINGS_NS } from '../../src/settings/index.js';

/** register 调用记录 */
interface RegisterCall {
  /** 被注册的命名空间 */
  ns: string;
  /** 传入的 schema 引用 */
  schema: unknown;
}

/** 假 settings 服务：可选 configure/register 模拟不同宿主版本的暴露面 */
function makeFakeSettings(options: {
  withConfigure?: boolean;
  withRegister?: boolean;
  failRegisterWith?: Error;
} = {}): {
  settings: Record<string, unknown>;
  registerCalls: RegisterCall[];
  configureCalls: unknown[];
} {
  const registerCalls: RegisterCall[] = [];
  const configureCalls: unknown[] = [];
  const settings: Record<string, unknown> = {
    describe: async (): Promise<unknown> => [],
    mutate: async (): Promise<unknown> => undefined,
    writable: true,
  };
  // register 可选——0.1.7-rc.1 的 SettingsForms 靠 cordis loader entries 发现
  // 命名空间，不提供 register 方法
  if (options.withRegister !== false) {
    settings.register = (ns: string, schema: unknown): unknown => {
      if (options.failRegisterWith !== undefined) throw options.failRegisterWith;
      registerCalls.push({ ns, schema });
      return {
        get: () => ({}),
        watch: () => (): void => undefined,
        update: async (): Promise<void> => undefined,
        replace: async (): Promise<void> => undefined,
      };
    };
  }
  if (options.withConfigure === true) {
    settings.configure = (value: unknown): void => {
      configureCalls.push(value);
    };
  }
  return { settings, registerCalls, configureCalls };
}

/** 假 cordis 上下文：inject 直接回调，effect 立即执行并回收 cleanup */
function makeFakeContext(settings: unknown): Context {
  const ctx = {
    fiber: {},
    inject(_deps: string[], callback: (sctx: Record<string, unknown>) => void): void {
      callback({
        settings,
        webServer: { register: () => (): void => undefined },
        effect: (fn: () => unknown): void => {
          const returned = fn();
          if (typeof returned === 'function') returned();
        },
      });
    },
  };
  return ctx as unknown as Context;
}

describe('settings 集成注册', () => {
  it('旧宿主（无 configure）下仍完成命名空间注册，不抛错', () => {
    const { settings, registerCalls, configureCalls } = makeFakeSettings();
    const schema = { marker: 'config-schema' };
    assert.doesNotThrow(() => {
      registerSettingsIntegration(makeFakeContext(settings), schema, []);
    });
    assert.equal(registerCalls.length, 1);
    assert.equal(registerCalls[0]?.ns, SETTINGS_NS);
    assert.equal(registerCalls[0]?.schema, schema);
    assert.deepEqual(configureCalls, []);
  });

  it('新宿主（有 configure）时调用 auto:false 并照常注册', () => {
    const { settings, registerCalls, configureCalls } = makeFakeSettings({ withConfigure: true });
    registerSettingsIntegration(makeFakeContext(settings), { marker: 'x' });
    assert.deepEqual(configureCalls, [{ auto: false }]);
    assert.equal(registerCalls.length, 1);
    assert.equal(registerCalls[0]?.ns, SETTINGS_NS);
  });

  it('重复注册视为幂等情形，吞掉 already registered 不上抛', () => {
    const { settings } = makeFakeSettings({
      failRegisterWith: new Error('settings namespace "terminal-panel" is already registered'),
    });
    assert.doesNotThrow(() => {
      registerSettingsIntegration(makeFakeContext(settings), { marker: 'x' });
    });
  });

  it('其他注册失败如实上抛，不把失败包装成成功', () => {
    const { settings } = makeFakeSettings({
      failRegisterWith: new Error('settings namespace "terminal-panel" 存储段损坏'),
    });
    assert.throws(
      () => registerSettingsIntegration(makeFakeContext(settings), { marker: 'x' }),
      /存储段损坏/u,
    );
  });

  it('宿主无 register 方法时不抛 TypeError（靠 cordis loader entries 发现命名空间）', () => {
    const { settings, registerCalls } = makeFakeSettings({ withRegister: false });
    assert.doesNotThrow(() => {
      registerSettingsIntegration(makeFakeContext(settings), { marker: 'x' });
    });
    // 宿主无 register——registerCalls 为空，但不抛错
    assert.equal(registerCalls.length, 0);
  });
});
