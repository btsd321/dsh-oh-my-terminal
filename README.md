# dsh-oh-my-terminal

DSH Web GUI 底部终端面板插件——node-pty 驱动的多标签交互式终端。

## 安装

```bash
dsh plugin --profile web add dsh-oh-my-terminal
```

## 功能

- **多标签终端**：同时打开多个终端会话，tab 切换
- **WebSocket 实时通信**：node-pty 后端 + xterm.js 前端，低延迟输入输出
- **跨平台**：Windows ConPTY / POSIX openpty，由 node-pty 自动选择
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
# 安装依赖（含 node-pty 原生编译）
pnpm install

# 类型检查
pnpm run typecheck

# 构建（esbuild 双入口 → lib/）
pnpm run build

# 单元测试
pnpm exec tsx --test tests/unit/*.test.ts
```

## License

Apache License 2.0
