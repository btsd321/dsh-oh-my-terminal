# dsh-oh-my-terminal

DSH Web GUI 底部终端面板插件——@lydell/node-pty 驱动的多标签交互式终端。

## 安装

```bash
dsh plugin --profile web add dsh-oh-my-terminal
```

## 功能

- **多标签终端**：同时打开多个终端会话，tab 切换
- **WebSocket 实时通信**：@lydell/node-pty 后端 + xterm.js 前端，低延迟输入输出
- **跨平台**：Windows ConPTY / POSIX openpty，由 @lydell/node-pty 自动选择
- **快捷键开关**：可配置快捷键呼出/收起终端面板
- **拖拽调高**：鼠标拖拽面板上边缘调整高度
- **会话持久化**：终端会话跨面板开关保持存活
- **可配置 shell**：自定义 shell 命令与参数

## 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `toggleShortcut` | 呼出/收起终端面板的快捷键 | `` Ctrl+` `` |
| `shellCommand` | 终端使用的 shell 命令 | 系统默认（bash/PowerShell） |

## 开发

```bash
# 安装依赖（@lydell/node-pty 自带各平台预编译二进制，装完即用，无需本地编译）
pnpm install

# 类型检查
pnpm run typecheck

# 构建（esbuild 双入口 → lib/）
pnpm run build

# 单元测试
pnpm exec tsx --test tests/unit/*.test.ts
```

### 原生依赖说明

终端能力来自 `@lydell/node-pty`（microsoft/node-pty 的预编译分发版，API 同源），版本精确钉在 `1.1.0`，不用 `^`：该包 `dist-tags.latest` 指向 1.2.0-beta 系列，浮动范围会取到 beta。

它是 N-API 产物，二进制按平台拆成六个子包随 tarball 分发，安装期不下载、不编译，同一份二进制同时支持 Node 22 与 Node 24。其 `package.json` 中不存在 `scripts` 字段，因此安装时不涉及任何构建脚本授权判断——这正是它在 pnpm 10、11、12 上行为一致、都能装成功的原因。

宿主半对它是懒加载（首次创建会话时才 `import()`）：原生绑定若加载失败，异常只影响会话创建，不会让插件模块本身导入失败。

## License

Apache License 2.0
