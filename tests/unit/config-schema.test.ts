/**
 * @file 插件 Config schema 单元测试
 * @description 校验包级 Config 声明的形状契约——DSH settings 系统依赖的
 *              volatile 标记（volatileForm 据此把字段投影进 GUI 表单）、
 *              字段默认值与 description、toJSON 可序列化（SettingsForms
 *              describe 用它生成表单描述）。任一契约破坏都会让配置表单
 *              在 DSH 设置界面消失或字段不可编辑。
 *
 *              终端配置表（terminalProfiles）以 JSON 字符串承载：schemastery
 *              对对象数组的 round-trip 行为不保证，字符串是唯一稳定形态，
 *              因此本测试锁定其类型为 string 且默认为空串。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type z from '@deepseek-ai/schemastery';
import { Config } from '../../src/index.js';
import { DEFAULT_TOGGLE_SHORTCUT, DEFAULT_FONT_SIZE, DEFAULT_LINE_HEIGHT } from '../../src/constants.js';

// Config 的值导出是 schemastery 实例；interface Config 与 const Config 同名
// （值/类型空间分离），测试里以 unknown 收窄后再断言最小形状
const schema = Config as unknown as z;

/** 配置表的六个字段名（与 Config schema 声明一致） */
const FIELD_NAMES = ['fontFamily', 'fontSize', 'hideHostTerminal', 'lineHeight', 'terminalProfiles', 'toggleShortcut'] as const;

/** object schema 的字段表（schemastery 实例的 dict 成员） */
function field(name: string): { meta: Record<string, unknown> } | undefined {
  const dict = (schema as unknown as { dict?: Record<string, unknown> }).dict;
  const node = dict?.[name];
  return node === undefined ? undefined : node as { meta: Record<string, unknown> };
}

/** 取字段 description 文本（非 string 时返回空串，便于断言安全展开） */
function description(name: string): string {
  const value = field(name)?.meta.description;
  return typeof value === 'string' ? value : '';
}

describe('Config schema 形状', () => {
  it('是 object schema 且声明六个字段', () => {
    assert.equal((schema as unknown as { type?: string }).type, 'object');
    const dict = (schema as unknown as { dict?: Record<string, unknown> }).dict;
    assert.deepEqual(Object.keys(dict ?? {}).sort(), [...FIELD_NAMES]);
  });

  it('toggleShortcut 带 volatile 标记（GUI 表单可见 + 免重启热更新）', () => {
    const node = field('toggleShortcut');
    assert.notEqual(node, undefined);
    assert.equal(node?.meta.volatile, true);
  });

  it('terminalProfiles 带 volatile 标记', () => {
    const node = field('terminalProfiles');
    assert.notEqual(node, undefined);
    assert.equal(node?.meta.volatile, true);
  });

  it('fontFamily 带 volatile 标记', () => {
    const node = field('fontFamily');
    assert.notEqual(node, undefined);
    assert.equal(node?.meta.volatile, true);
  });

  it('fontSize 带 volatile 标记', () => {
    const node = field('fontSize');
    assert.notEqual(node, undefined);
    assert.equal(node?.meta.volatile, true);
  });

  it('lineHeight 带 volatile 标记', () => {
    const node = field('lineHeight');
    assert.notEqual(node, undefined);
    assert.equal(node?.meta.volatile, true);
  });

  it('hideHostTerminal 带 volatile 标记', () => {
    const node = field('hideHostTerminal');
    assert.notEqual(node, undefined);
    assert.equal(node?.meta.volatile, true);
  });

  it('六字段带默认值（空配置时回落），符合全字段给 default 的约束', () => {
    assert.equal(field('toggleShortcut')?.meta.default, DEFAULT_TOGGLE_SHORTCUT);
    assert.equal(field('terminalProfiles')?.meta.default, '');
    assert.equal(field('fontFamily')?.meta.default, '');
    assert.equal(field('fontSize')?.meta.default, DEFAULT_FONT_SIZE);
    assert.equal(field('lineHeight')?.meta.default, DEFAULT_LINE_HEIGHT);
    assert.equal(field('hideHostTerminal')?.meta.default, true);
  });

  it('terminalProfiles 默认值为空串（空表表示用启动探测结果）', () => {
    // 空串语义：宿主半的 prepareProfiles() 见到空表会跑一次 $PATH 探测；
    // 若默认值改成 '[]'，探测分支永不触发，首次安装会得到空的下拉菜单
    assert.equal(field('terminalProfiles')?.meta.default, '');
  });

  it('六字段带 description（GUI 表单的字段说明）', () => {
    for (const name of FIELD_NAMES) {
      assert.equal(typeof field(name)?.meta.description, 'string', `${name} 缺 description`);
    }
  });

  it('fontFamily 的 description 不含中文弯引号（会被 CSS 当作字体名一部分）', () => {
    // 字段说明里的示例字体名是给用户直接复制的——弯引号 U+2018/U+2019 会让
    // CSS 解析出一个永不匹配的字体名，表现为「照抄后图标依旧乱码且无报错」
    const text = description('fontFamily');
    assert.ok(!text.includes('\u2018'), 'fontFamily description 含左弯引号 U+2018');
    assert.ok(!text.includes('\u2019'), 'fontFamily description 含右弯引号 U+2019');
  });

  it('字体三项的 description 说明配置即时生效（运行期热更新契约）', () => {
    // 三项均经 xterm options 运行期更新，已在说明里承诺「即时生效」——
    // 若前端退回 init-only 取值，这段文案会失真，故在此锁定契约
    for (const name of ['fontFamily', 'fontSize', 'lineHeight']) {
      assert.ok(description(name).includes('即时生效'), `${name} description 未声明即时生效`);
    }
  });

  it('toJSON 可序列化（SettingsForms.describe 生成表单的输入）', () => {
    const json = JSON.stringify(schema.toJSON());
    for (const name of FIELD_NAMES) {
      assert.ok(json.includes(name), `${name} 未出现在 toJSON 输出`);
    }
  });
});
