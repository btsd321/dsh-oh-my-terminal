/**
 * @file server-command.ts 单元测试
 * @description 覆盖 splitCommandLine 的基本功能、引号处理、多空格、边界情况，
 *              以及 firstNonEmpty 的回退链选择逻辑。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommandLine, firstNonEmpty } from '../../src/server-command.js';

describe('splitCommandLine', () => {
  // ─── 基本功能 ───────────────────────────────────────────────
  describe('基本功能', () => {
    it('普通命令按空格拆分', () => {
      assert.deepEqual(splitCommandLine('bash -l'), ['bash', '-l']);
    });

    it('多参数命令', () => {
      assert.deepEqual(splitCommandLine('git status --short'), ['git', 'status', '--short']);
    });

    it('单个命令无参数', () => {
      assert.deepEqual(splitCommandLine('bash'), ['bash']);
    });
  });

  // ─── 空串与空白 ─────────────────────────────────────────────
  describe('空串与空白', () => {
    it('空字符串返回空数组', () => {
      assert.deepEqual(splitCommandLine(''), []);
    });

    it('纯空格字符串返回空数组', () => {
      assert.deepEqual(splitCommandLine('   '), []);
    });

    it('纯制表符字符串返回空数组', () => {
      assert.deepEqual(splitCommandLine('\t\t'), []);
    });

    it('前后空格被 trim', () => {
      assert.deepEqual(splitCommandLine('  bash -l  '), ['bash', '-l']);
    });
  });

  // ─── 引号处理 ───────────────────────────────────────────────
  describe('引号处理', () => {
    it('双引号内的空格不拆分', () => {
      assert.deepEqual(
        splitCommandLine('echo "hello world"'),
        ['echo', 'hello world'],
      );
    });

    it('带空格路径用双引号包裹', () => {
      assert.deepEqual(
        splitCommandLine('cmd.exe /k "C:\\cmder\\vendor\\init.bat"'),
        ['cmd.exe', '/k', 'C:\\cmder\\vendor\\init.bat'],
      );
    });

    it('引号本身不进令牌', () => {
      const tokens = splitCommandLine('"quoted"');
      assert.deepEqual(tokens, ['quoted']);
    });

    it('多个双引号段', () => {
      assert.deepEqual(
        splitCommandLine('echo "a b" "c d"'),
        ['echo', 'a b', 'c d'],
      );
    });

    it('空引号段产生空令牌（双引号内无内容）', () => {
      // "" → 引号内为空，current 仍为 ''，但长度为 0 不 push
      // 实际行为：两个相邻双引号只切换状态，不产生令牌
      assert.deepEqual(splitCommandLine('echo ""'), ['echo']);
    });
  });

  // ─── 多空格 ─────────────────────────────────────────────────
  describe('多空格', () => {
    it('连续空格不产生空令牌', () => {
      assert.deepEqual(splitCommandLine('a   b'), ['a', 'b']);
    });

    it('空格与制表符混用不产生空令牌', () => {
      assert.deepEqual(splitCommandLine('a \t b'), ['a', 'b']);
    });

    it('引号外的连续空格在引号前', () => {
      assert.deepEqual(splitCommandLine('echo   "hello"'), ['echo', 'hello']);
    });
  });

  // ─── 边界情况 ───────────────────────────────────────────────
  describe('边界情况', () => {
    it('仅一个空格', () => {
      assert.deepEqual(splitCommandLine(' '), []);
    });

    it('带 flags 的复杂命令', () => {
      assert.deepEqual(
        splitCommandLine('docker run --rm -it ubuntu:latest bash'),
        ['docker', 'run', '--rm', '-it', 'ubuntu:latest', 'bash'],
      );
    });

    it('路径含正斜杠（POSIX 路径）', () => {
      assert.deepEqual(
        splitCommandLine('/bin/bash -c "ls -la"'),
        ['/bin/bash', '-c', 'ls -la'],
      );
    });

    it('未闭合引号（引号状态持续到末尾）', () => {
      // 未闭合引号——引号内内容作为一个令牌
      assert.deepEqual(splitCommandLine('echo "unclosed'), ['echo', 'unclosed']);
    });

    it('等号参数不被拆分', () => {
      assert.deepEqual(splitCommandLine('env FOO=bar bash'), ['env', 'FOO=bar', 'bash']);
    });
  });
});

describe('firstNonEmpty', () => {
  // ─── 基本功能 ───────────────────────────────────────────────
  describe('基本功能', () => {
    it('返回第一个非空字符串', () => {
      assert.equal(firstNonEmpty('a', 'b', 'c'), 'a');
    });

    it('跳过 undefined', () => {
      assert.equal(firstNonEmpty(undefined, 'b', 'c'), 'b');
    });

    it('跳过空字符串', () => {
      assert.equal(firstNonEmpty('', 'b', 'c'), 'b');
    });

    it('跳过全空白字符串', () => {
      assert.equal(firstNonEmpty('   ', 'b'), 'b');
    });

    it('跳过制表符字符串', () => {
      assert.equal(firstNonEmpty('\t', 'b'), 'b');
    });
  });

  // ─── 回退链 ─────────────────────────────────────────────────
  describe('回退链', () => {
    it('env → settings → 默认值 回退', () => {
      const env = undefined;
      const settings = '';
      const def = '/bin/bash';
      assert.equal(firstNonEmpty(env, settings, def), '/bin/bash');
    });

    it('env 优先于 settings', () => {
      const env = 'zsh';
      const settings = 'bash';
      assert.equal(firstNonEmpty(env, settings), 'zsh');
    });

    it('settings 优先于默认值', () => {
      const env = undefined;
      const settings = 'bash -l';
      assert.equal(firstNonEmpty(env, settings), 'bash -l');
    });

    it('全 undefined 返回 undefined', () => {
      assert.equal(firstNonEmpty(undefined, undefined), undefined);
    });

    it('全空字符串返回 undefined', () => {
      assert.equal(firstNonEmpty('', '', ''), undefined);
    });

    it('无参数返回 undefined', () => {
      assert.equal(firstNonEmpty(), undefined);
    });

    it('含空白但非全空白的字符串被选中', () => {
      assert.equal(firstNonEmpty(' a '), ' a ');
    });
  });
});
