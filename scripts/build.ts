/**
 * @file esbuild 构建脚本
 * @description 将 src/ 下的宿主半与浏览器半分别打包为 lib/index.js 与 lib/client.js，
 *              并从 node_modules 复制 xterm.css 到 lib/xterm.css 供宿主半 serve。
 *
 * 构建产物说明：
 * - lib/index.js：宿主半（ESM/Node），external 排除 @deepseek-ai/*、@lydell/node-pty、ws 等原生依赖
 * - lib/client.js：浏览器半（CJS/browser），用 __ModuleLoader__ 注册壳包裹，external 排除 react
 * - lib/xterm.css：从 @xterm/xterm 复制的样式表，由宿主半 serve 给浏览器
 *
 * 约束：
 * - @lydell/node-pty 含原生 .node 二进制，单文件 bundle 带不走，必须留作外部引用（运行期由
 *   node_modules 里的平台子包提供绑定）；另用 .node: empty loader 让 ssh2 的 try/catch 回落纯 JS
 *   （此处为保持一致性同样处理）
 * - lib/ 纳入版本控制，构建后需手动 git add 提交
 */

import { build } from 'esbuild';
import { readFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib');

// 1. 清理并重建 lib/ 目录
rmSync(LIB, { recursive: true, force: true });
mkdirSync(LIB, { recursive: true });

// 2. 宿主半 → lib/index.js（ESM/Node）
await build({
  entryPoints: [join(ROOT, 'src', 'index.ts')],
  outfile: join(LIB, 'index.js'),
  format: 'esm', platform: 'node', target: 'node20',
  bundle: true,
  external: ['@deepseek-ai/*', '@lydell/node-pty', 'ws', 'cpu-features', 'nan'],
  loader: { '.node': 'empty' },
});

// 3. 浏览器半 → lib/client.js（CJS/browser，__ModuleLoader__ 注册壳）
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
await build({
  entryPoints: [join(ROOT, 'src', 'client.tsx')],
  outfile: join(LIB, 'client.js'),
  format: 'cjs', platform: 'browser', target: 'es2020',
  bundle: true, external: ['react'],
  jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
});

// 4. xterm.css → lib/xterm.css（由宿主半 serve）
const xtermCss = join(ROOT, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
if (existsSync(xtermCss)) {
  copyFileSync(xtermCss, join(LIB, 'xterm.css'));
}

console.log('构建完成：lib/index.js + lib/client.js + lib/xterm.css');
