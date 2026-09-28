/**
 * @file settings 集成注册单元测试
 * @description 回归锁定 registerSettingsIntegration 的命名空间注册契约：
 *              auto=false 下 settings 服务不会自动注册命名空间，插件必须显式
 *              register(SETTINGS_NS, schema)，否则 describe/mutate 恒报
 *              「命名空间不存在」——前端配置卡片静默不渲染（无报错、无入口）。
 *              本测试用假 settings 服务断言：注册确实发生且 schema 原样透传、
 *              重复注册幂等吞掉、其余注册失败如实上抛（不把失败包装成成功）。
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

/** 假 settings 服务：只实现集成代码用到的 configure / register / describe / mutate */
function makeFakeSettings(options: { failRegisterWith?: Error } = {}): {
  settings: Record<string, unknown>;
  registerCalls: RegisterCall[];
  configureCalls: unknown[];
} {
  const registerCalls: RegisterCall[] = [];
  const configureCalls: unknown[] = [];
  const settings = {
    configure(value: unknown): void {
      configureCalls.push(value);
    },
    register(ns: string, schema: unknown): unknown {
      if (options.failRegisterWith !== undefined) throw options.failRegisterWith;
      registerCalls.push({ ns, schema });
      return {
        get: () => ({}),
        watch: () => (): void => undefined,
        update: async (): Promise<void> => undefined,
        replace: async (): Promise<void> => undefined,
      };
    },
    describe: async (): Promise<unknown> => ({ ok: true }),
    mutate: async (): Promise<unknown> => ({ ok: true }),
  };
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
  it('settings 服务就位时显式注册命名空间并透传 schema', () => {
    const { settings, registerCalls, configureCalls } = makeFakeSettings();
    const schema = { marker: 'config-schema' };
    registerSettingsIntegration(makeFakeContext(settings), schema, []);
    assert.equal(registerCalls.length, 1);
    assert.equal(registerCalls[0]?.ns, SETTINGS_NS);
    assert.equal(registerCalls[0]?.schema, schema);
    assert.deepEqual(configureCalls, [{ auto: false }]);
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
});
