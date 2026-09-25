/**
 * @file shortcut.ts 单元测试
 * @description 覆盖 parseShortcut 与 matchesShortcut 的基本功能、修饰键别名、
 *              命名键、功能键、无效输入与边界情况，以及 shouldHandleShortcut
 *              的 defaultPrevented 短路契约。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseShortcut, matchesShortcut, shouldHandleShortcut, type ShortcutSpec } from '../../src/shortcut.js';

// —— 构造 KeyboardEvent 的辅助函数（node:test 环境无 DOM，手动构造最小对象） ——

/**
 * 构造一个 matchesShortcut 能消费的伪 KeyboardEvent 对象。
 *
 * @param code - KeyboardEvent.code
 * @param mods - 修饰键状态
 * @param defaultPrevented - 事件是否已被其他组件消费
 * @returns 伪事件对象
 */
function fakeEvent(
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
  defaultPrevented = false,
): KeyboardEvent {
  return {
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    defaultPrevented,
  } as KeyboardEvent;
}

describe('parseShortcut', () => {
  // ─── 基本功能 ───────────────────────────────────────────────
  describe('基本功能', () => {
    it('ctrl+` 解析为 ctrl + Backquote', () => {
      const spec = parseShortcut('ctrl+`');
      assert.notEqual(spec, null);
      assert.equal(spec?.ctrl, true);
      assert.equal(spec?.shift, false);
      assert.equal(spec?.alt, false);
      assert.equal(spec?.meta, false);
      assert.equal(spec?.code, 'Backquote');
      assert.equal(spec?.label, 'Ctrl+`');
    });

    it('ctrl+j 解析为 ctrl + KeyJ', () => {
      const spec = parseShortcut('ctrl+j');
      assert.notEqual(spec, null);
      assert.equal(spec?.ctrl, true);
      assert.equal(spec?.code, 'KeyJ');
      assert.equal(spec?.label, 'Ctrl+J');
    });

    it('ctrl+shift+f1 解析为 ctrl+shift + F1', () => {
      const spec = parseShortcut('ctrl+shift+f1');
      assert.notEqual(spec, null);
      assert.equal(spec?.ctrl, true);
      assert.equal(spec?.shift, true);
      assert.equal(spec?.alt, false);
      assert.equal(spec?.meta, false);
      assert.equal(spec?.code, 'F1');
      assert.equal(spec?.label, 'Ctrl+Shift+F1');
    });

    it('字母键大写化（KeyA），标签大写', () => {
      const spec = parseShortcut('a');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'KeyA');
      assert.equal(spec?.label, 'A');
    });

    it('数字键映射到 Digit 前缀', () => {
      const spec = parseShortcut('ctrl+5');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Digit5');
      assert.equal(spec?.label, 'Ctrl+5');
    });
  });

  // ─── 修饰键别名 ─────────────────────────────────────────────
  describe('修饰键别名', () => {
    it('control 别名等价于 ctrl', () => {
      const spec = parseShortcut('control+`');
      assert.notEqual(spec, null);
      assert.equal(spec?.ctrl, true);
      assert.equal(spec?.code, 'Backquote');
    });

    it('option 别名等价于 alt', () => {
      const spec = parseShortcut('option+x');
      assert.notEqual(spec, null);
      assert.equal(spec?.alt, true);
      assert.equal(spec?.code, 'KeyX');
    });

    it('cmd 别名等价于 meta', () => {
      const spec = parseShortcut('cmd+k');
      assert.notEqual(spec, null);
      assert.equal(spec?.meta, true);
      assert.equal(spec?.code, 'KeyK');
    });

    it('win 别名等价于 meta', () => {
      const spec = parseShortcut('win+l');
      assert.notEqual(spec, null);
      assert.equal(spec?.meta, true);
      assert.equal(spec?.code, 'KeyL');
    });

    it('command 别名等价于 meta', () => {
      const spec = parseShortcut('command+q');
      assert.notEqual(spec, null);
      assert.equal(spec?.meta, true);
      assert.equal(spec?.code, 'KeyQ');
    });

    it('修饰键大小写不敏感（CTRL+SHIFT+A）', () => {
      const spec = parseShortcut('CTRL+SHIFT+A');
      assert.notEqual(spec, null);
      assert.equal(spec?.ctrl, true);
      assert.equal(spec?.shift, true);
      assert.equal(spec?.code, 'KeyA');
    });

    it('修饰键顺序任意', () => {
      const a = parseShortcut('ctrl+shift+f1');
      const b = parseShortcut('shift+ctrl+f1');
      assert.notEqual(a, null);
      assert.notEqual(b, null);
      assert.equal(a?.code, b?.code);
      assert.equal(a?.ctrl, b?.ctrl);
      assert.equal(a?.shift, b?.shift);
    });
  });

  // ─── 命名键 ─────────────────────────────────────────────────
  describe('命名键', () => {
    it('space 映射到 Space', () => {
      const spec = parseShortcut('ctrl+space');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Space');
    });

    it('enter 映射到 Enter', () => {
      const spec = parseShortcut('ctrl+enter');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Enter');
    });

    it('return 别名映射到 Enter', () => {
      const spec = parseShortcut('ctrl+return');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Enter');
    });

    it('esc 映射到 Escape', () => {
      const spec = parseShortcut('ctrl+esc');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Escape');
    });

    it('tab 映射到 Tab', () => {
      const spec = parseShortcut('ctrl+tab');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Tab');
    });

    it('up 映射到 ArrowUp', () => {
      const spec = parseShortcut('ctrl+up');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'ArrowUp');
    });

    it('grave 别名映射到 Backquote', () => {
      const spec = parseShortcut('ctrl+grave');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Backquote');
      assert.equal(spec?.label, 'Ctrl+`');
    });

    it('backquote 别名映射到 Backquote', () => {
      const spec = parseShortcut('ctrl+backquote');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Backquote');
    });
  });

  // ─── 功能键 F1-F12 ──────────────────────────────────────────
  describe('功能键 F1-F12', () => {
    it('F1 解析正确', () => {
      const spec = parseShortcut('f1');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'F1');
    });

    it('F12 解析正确', () => {
      const spec = parseShortcut('f12');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'F12');
    });

    it('ctrl+shift+F10 解析正确', () => {
      const spec = parseShortcut('ctrl+shift+f10');
      assert.notEqual(spec, null);
      assert.equal(spec?.ctrl, true);
      assert.equal(spec?.shift, true);
      assert.equal(spec?.code, 'F10');
    });
  });

  // ─── 无效输入 ───────────────────────────────────────────────
  describe('无效输入', () => {
    it('空字符串返回 null', () => {
      assert.equal(parseShortcut(''), null);
    });

    it('只有修饰键无键位返回 null', () => {
      assert.equal(parseShortcut('ctrl'), null);
      assert.equal(parseShortcut('ctrl+shift'), null);
    });

    it('未知键返回 null', () => {
      assert.equal(parseShortcut('ctrl+xyz'), null);
      assert.equal(parseShortcut('ctrl+f13'), null);
      assert.equal(parseShortcut('ctrl+!'), null);
    });

    it('重复修饰键返回 null', () => {
      assert.equal(parseShortcut('ctrl+ctrl+`'), null);
      assert.equal(parseShortcut('ctrl+control+`'), null);
    });

    it('非字符串输入返回 null', () => {
      assert.equal(parseShortcut(undefined as unknown as string), null);
      assert.equal(parseShortcut(123 as unknown as string), null);
    });
  });

  // ─── 边界情况 ───────────────────────────────────────────────
  describe('边界情况', () => {
    it('前后空格被 trim', () => {
      const spec = parseShortcut('  ctrl+`  ');
      assert.notEqual(spec, null);
      assert.equal(spec?.code, 'Backquote');
    });

    it('修饰键间多余空格被忽略', () => {
      const spec = parseShortcut('ctrl + `');
      assert.notEqual(spec, null);
      assert.equal(spec?.ctrl, true);
      assert.equal(spec?.code, 'Backquote');
    });

    it('仅有键位无修饰键（无修饰的裸键）', () => {
      const spec = parseShortcut('f5');
      assert.notEqual(spec, null);
      assert.equal(spec?.ctrl, false);
      assert.equal(spec?.shift, false);
      assert.equal(spec?.alt, false);
      assert.equal(spec?.meta, false);
      assert.equal(spec?.code, 'F5');
    });
  });
});

describe('matchesShortcut', () => {
  // ─── 匹配成功 ───────────────────────────────────────────────
  describe('匹配成功', () => {
    it('ctrl+` 匹配 ctrl+Backquote 事件', () => {
      const spec = parseShortcut('ctrl+`');
      const ev = fakeEvent('Backquote', { ctrl: true });
      assert.equal(matchesShortcut(spec, ev), true);
    });

    it('ctrl+shift+f1 匹配 ctrl+shift+F1 事件', () => {
      const spec = parseShortcut('ctrl+shift+f1');
      const ev = fakeEvent('F1', { ctrl: true, shift: true });
      assert.equal(matchesShortcut(spec, ev), true);
    });

    it('无修饰键的裸键匹配', () => {
      const spec = parseShortcut('f5');
      const ev = fakeEvent('F5', {});
      assert.equal(matchesShortcut(spec, ev), true);
    });
  });

  // ─── 匹配失败 ───────────────────────────────────────────────
  describe('匹配失败', () => {
    it('键码不匹配', () => {
      const spec = parseShortcut('ctrl+`');
      const ev = fakeEvent('KeyJ', { ctrl: true });
      assert.equal(matchesShortcut(spec, ev), false);
    });

    it('缺修饰键', () => {
      const spec = parseShortcut('ctrl+`');
      const ev = fakeEvent('Backquote', {});
      assert.equal(matchesShortcut(spec, ev), false);
    });

    it('多余修饰键', () => {
      const spec = parseShortcut('ctrl+`');
      const ev = fakeEvent('Backquote', { ctrl: true, shift: true });
      assert.equal(matchesShortcut(spec, ev), false);
    });

    it('错误的修饰键', () => {
      const spec = parseShortcut('ctrl+`');
      const ev = fakeEvent('Backquote', { alt: true });
      assert.equal(matchesShortcut(spec, ev), false);
    });

    it('null spec 永不匹配', () => {
      const ev = fakeEvent('Backquote', { ctrl: true });
      assert.equal(matchesShortcut(null, ev), false);
    });
  });

  // ─── spec code 为 null ─────────────────────────────────────
  describe('spec code 为 null', () => {
    it('code 为 null 的 spec 匹配任意键码（仅校验修饰键）', () => {
      // 构造一个 code 为 null 的 spec（模拟无效快捷键配置降级）
      const spec: ShortcutSpec = { ctrl: true, shift: false, alt: false, meta: false, code: null, label: null };
      const ev = fakeEvent('KeyJ', { ctrl: true });
      assert.equal(matchesShortcut(spec, ev), true);
    });
  });
});

describe('shouldHandleShortcut', () => {
  // ─── 未被消费的事件：透传 matchesShortcut ──────────────────
  describe('未被消费的事件', () => {
    it('命中的未消费事件返回 true', () => {
      const spec = parseShortcut('ctrl+`');
      const ev = fakeEvent('Backquote', { ctrl: true });
      assert.equal(shouldHandleShortcut(spec, ev), true);
    });

    it('未命中的事件返回 false', () => {
      const spec = parseShortcut('ctrl+`');
      const ev = fakeEvent('KeyJ', { ctrl: true });
      assert.equal(shouldHandleShortcut(spec, ev), false);
    });

    it('null spec 返回 false', () => {
      const ev = fakeEvent('Backquote', { ctrl: true });
      assert.equal(shouldHandleShortcut(null, ev), false);
    });
  });

  // ─── 已被消费的事件：无条件短路 ───────────────────────────
  describe('已被消费的事件（defaultPrevented）', () => {
    it('DSH shortcuts 已消费的键不再触发插件（防 Ctrl+` 双重响应）', () => {
      const spec = parseShortcut('ctrl+`');
      const ev = fakeEvent('Backquote', { ctrl: true }, true);
      assert.equal(shouldHandleShortcut(spec, ev), false);
    });

    it('其他组件消费过的任意命中组合均短路', () => {
      const spec = parseShortcut('ctrl+j');
      const ev = fakeEvent('KeyJ', { ctrl: true }, true);
      assert.equal(shouldHandleShortcut(spec, ev), false);
    });
  });
});
