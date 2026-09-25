/**
 * @file 插件 Config schema 单元测试
 * @description 校验包级 Config 声明的形状契约——DSH settings 系统依赖的
 *              volatile 标记（volatileForm 据此把字段投影进 GUI 表单）、
 *              字段默认值与 description、toJSON 可序列化（SettingsForms
 *              describe 用它生成表单描述）。任一契约破坏都会让配置表单
 *              在 DSH 设置界面消失或字段不可编辑。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type z from '@deepseek-ai/schemastery';
import { Config } from '../../src/index.js';
import { DEFAULT_TOGGLE_SHORTCUT } from '../../src/constants.js';

// Config 的值导出是 schemastery 实例；interface Config 与 const Config 同名
// （值/类型空间分离），测试里以 unknown 收窄后再断言最小形状
const schema = Config as unknown as z;

/** object schema 的字段表（schemastery 实例的 dict 成员） */
function field(name: string): { meta: Record<string, unknown> } | undefined {
  const dict = (schema as unknown as { dict?: Record<string, unknown> }).dict;
  const node = dict?.[name];
  return node === undefined ? undefined : node as { meta: Record<string, unknown> };
}

describe('Config schema 形状', () => {
  it('是 object schema 且声明两个字段', () => {
    assert.equal((schema as unknown as { type?: string }).type, 'object');
    const dict = (schema as unknown as { dict?: Record<string, unknown> }).dict;
    assert.deepEqual(Object.keys(dict ?? {}).sort(), ['shellCommand', 'toggleShortcut']);
  });

  it('toggleShortcut 带 volatile 标记（GUI 表单可见 + 免重启热更新）', () => {
    const node = field('toggleShortcut');
    assert.notEqual(node, undefined);
    assert.equal(node?.meta.volatile, true);
  });

  it('shellCommand 带 volatile 标记', () => {
    const node = field('shellCommand');
    assert.notEqual(node, undefined);
    assert.equal(node?.meta.volatile, true);
  });

  it('两字段带默认值（空配置时回落），符合全字段给 default 的约束', () => {
    assert.equal(field('toggleShortcut')?.meta.default, DEFAULT_TOGGLE_SHORTCUT);
    assert.equal(field('shellCommand')?.meta.default, '');
  });

  it('两字段带 description（GUI 表单的字段说明）', () => {
    assert.equal(typeof field('toggleShortcut')?.meta.description, 'string');
    assert.equal(typeof field('shellCommand')?.meta.description, 'string');
  });

  it('toJSON 可序列化（SettingsForms.describe 生成表单的输入）', () => {
    const json = JSON.stringify(schema.toJSON());
    assert.ok(json.includes('toggleShortcut'));
    assert.ok(json.includes('shellCommand'));
  });
});
