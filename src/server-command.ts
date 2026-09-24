/**
 * @file 命令行解析工具
 * @description 把配置的 shell 命令行字符串拆成令牌列表，供 node-pty spawn 使用。
 *              纯函数模块（无 Node 运行时依赖），宿主半（index.ts）与测试均 import。
 *
 * 把 `cmd.exe /k "C:\cmder\vendor\init.bat"` 拆成
 * `['cmd.exe', '/k', 'C:\\cmder\\vendor\\init.bat']`——带空格的路径用双引号包裹即可。
 */

/**
 * 按空格拆分命令行，尊重双引号段（不支持转义/单引号——覆盖文档用例即可）。
 *
 * 每个双引号切换引号状态（引号本身不进令牌）；引号内的空格/制表符视为普通字符。
 * 这足以处理 `cmd.exe /k "C:\cmder\vendor\init.bat"` 这类带空格路径的配置命令。
 *
 * @param input - 原始命令行
 * @returns 令牌列表；空串输入返回空数组
 */
export function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of input.trim()) {
    if (ch === '"') {
      // 双引号切换引号状态——引号本身不进令牌
      quoted = !quoted;
      continue;
    }
    if ((ch === ' ' || ch === '\t') && !quoted) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * 取第一个非空非空白字符串（环境变量回退链用）。
 *
 * 用于在「ops 级 env 覆盖 → settings 文档值 → 默认值」之间选择第一个有效值。
 *
 * @param values - 候选值列表（可能含 undefined / 空串 / 全空白串）
 * @returns 第一个非空非空白字符串；全空时 undefined
 */
export function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}
