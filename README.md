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
- **快捷键开关**：可配置快捷键呼出/收起终端面板；DSH 0.1.7-rc.2+ 上接入宿主统一快捷键系统，可在 DSH 设置界面改键
- **拖拽调高**：鼠标拖拽面板上边缘调整高度
- **会话持久化**：终端会话跨面板开关保持存活
- **可配置 shell**：自定义 shell 命令与参数

## 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `toggleShortcut` | 呼出/收起终端面板的快捷键（仅旧宿主生效，见下方适配说明） | `` Ctrl+` `` |
| `shellCommand` | 终端使用的 shell 命令 | 系统默认（bash/PowerShell） |

## DSH 0.1.7-rc.2 快捷键适配说明

DSH 0.1.7-rc.2 起宿主自带全局快捷键系统，其自带终端（右侧栏 `terminal.new` 命令）占用了 `Ctrl+\``。为避免同一按键双重响应，本插件自 rc.2 适配版起：

- **接入 shortcuts 系统**：插件注册 `terminal-panel.toggle` 命令，默认绑定 **`Ctrl+Shift+\``**（`web:linux` 无默认键，需在设置界面自行绑定）。改键统一在 DSH 设置 → 快捷键中进行，面板提示标签跟随当前生效绑定
- **旧宿主（0.1.7-rc.1 及更早）**：自动降级为裸 `Ctrl+\`` 监听，`toggleShortcut` 配置（settings 文档 / 环境变量）照常生效
- **迁移指引**：旧宿主上配置过 `ctrl+\`` 的用户升级宿主后，`Ctrl+\`` 归自带终端（侧栏新开终端 tab），插件面板切换用 `Ctrl+Shift+\``；如需改回 `Ctrl+\``，请先在 DSH 快捷键设置中解除自带终端的绑定

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
