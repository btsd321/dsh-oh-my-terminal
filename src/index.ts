/**
 * @file 远端终端插件宿主半入口（运行在远端 dsh 进程内）
 * @description 独立 dsh 插件 `dsh-oh-my-terminal` 的宿主入口。用户通过
 *              `dsh plugin --profile web add dsh-oh-my-terminal` 安装本插件后，
 *              在远端 dsh 的 webServer 上注册 HTTP 前缀路由和 per-session WebSocket
 *              升级路由，用 node-pty（经 @lydell/node-pty 分发）管理 PTY shell
 *              会话。终端数据经 WebSocket
 *              实时双向传输（不经 SSH 通道）。支持会话持久化（dsh 重启后恢复历史
 *              tab）、可配置 shell 命令、终端种类选择接口。
 *
 *              独立插件形态（非合成包）：@lydell/node-pty 与 ws 是 package.json
 *              的正常依赖，pnpm install 时装进 node_modules；xterm.css 从
 *              node_modules 读取并 serve。node-pty 含平台原生绑定，采用运行期
 *              懒加载（见 loadPty），避免绑定缺失时整个插件入口不可导入。
 *
 *              职责拆分：协议/尺寸/快捷键/环境变量常量在 {@link module:constants}，
 *              平台适配器在 {@link module:platform}，会话持久化（日志落盘、
 *              元数据读写、启动恢复）在 {@link module:persistence}，
 *              WebSocket 处理在 {@link module:ws-handler}，HTTP 路由处理在
 *              {@link module:routes}。本文件保留 cordis 插件壳、包级 Config
 *              声明（volatile 字段免重启热更新）、会话生命周期管理
 *              （create/kill/restart）与插件销毁清理。
 *
 * 通道拓扑：
 * ```
 * 远端页面 ──同源 Cookie 鉴权──▶ /api/dsh-oh-my-terminal/*（HTTP 路由）
 *   （浏览器）                     └─ /sessions（GET 列表/POST 创建/DELETE 删除）
 *                                  └─ /sessions/:id/restart（POST 重启，继承滚动缓冲）
 *                                  └─ /config（GET 插件配置 + 终端种类列表）
 *                                  └─ /xterm.css（GET xterm 样式表）
 *                               /api/dsh-oh-my-terminal/ws/<id>（WebSocket 升级路由）
 *                                  └─ 连接时回放 buffer → 实时 pty.onData → ws.send
 *                                  └─ 客户端纯文本 = stdin，{"type":"resize"} = resize
 *                                  └─ 同源检查（sameOrigin）
 * ```
 *
 * 终端输入/输出数据绝不进日志——日志只记会话生命周期事件（创建/退出/重启/删除）与 id。
 */

import type { Context, Volatile } from '@deepseek-ai/cordis';
// schemastery 是 dsh 的 peer 依赖；esbuild external 后运行期从 profile 解析。
// 用值导入——包级 Config 声明需要运行时调用 z.string()/z.object()（cordis
// loader 读取插件包的静态 Config 派发配置，settings 表单亦由它投影生成）
import z from '@deepseek-ai/schemastery';
// WebSocket 需作为值导入：ws.readyState === WebSocket.OPEN 用到其静态常量
import { WebSocket } from 'ws';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { createLogger } from './logger.js';
import {
  PKG_NAME, ROUTE_PREFIX, WS_PREFIX, SCROLLBACK_CHARS,
  DEFAULT_COLS, DEFAULT_ROWS,
  DEFAULT_TOGGLE_SHORTCUT, ENV_TOGGLE_SHORTCUT, ENV_SHELL_COMMAND, ENV_DATA_DIR,
  DEFAULT_FONT_SIZE, DEFAULT_LINE_HEIGHT, ENV_FONT_FAMILY, ENV_FONT_SIZE, ENV_LINE_HEIGHT,
  ENV_TERMINAL_PROFILES,
} from './constants.js';
import { platform } from './platform.js';
import { SessionStore } from './persistence.js';
import type { SessionRecord } from './persistence.js';
import { createWsHandlers } from './ws-handler.js';
import { createRouteHandler } from './routes.js';
import type { CreateSessionOptions } from './routes.js';
import { makeId, getSessionCounter, resolveSpawn, resolveSessionCwd } from './routes.js';
import { registerSettingsIntegration, registerSettingsNamespace } from './settings/index.js';
import type { SettingsChannel } from './settings/index.js';
import type { TerminalProfile } from './terminal/index.js';
import { detectTerminalProfiles, mergeProfiles, settleProfileTable } from './terminal/index.js';

const log = createLogger('terminal-host');

// —— 原生绑定懒加载 ——

/**
 * 终端操作错误：保留错误码，便于路由层区分失败原因（如 PTY_UNAVAILABLE）。
 * 仅模块内部使用——loadPty 抛出、路由层 catch 后转 HTTP 响应，无外部消费者，故不导出
 * （type_script_style §2.3：内部辅助不导出，避免无谓扩大插件公开 API 面）。
 */
class TerminalError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

/** node-pty 模块类型（值与类型都从真实包解析，不手写第二份） */
type PtyModule = typeof import('@lydell/node-pty');

/** 已加载的 node-pty 模块缓存；undefined 表示尚未尝试加载 */
let ptyModule: PtyModule | undefined;

/**
 * 懒加载 node-pty 模块（@lydell/node-pty）。
 *
 * 为什么用运行时动态 import 而不在文件顶部静态导入：该包含平台原生绑定
 * （.node 二进制），静态导入会把绑定缺失的异常提前到 ESM 模块求值阶段，
 * 导致整个插件入口不可导入、dsh 报 "failed to import"、插件连 apply 都
 * 执行不到。改成按需加载后，绑定缺失降级为「创建会话时报错」，插件本身
 * 仍能正常启用（type_script_style.md 的动态 import 例外条款正是为此场景）。
 *
 * 加载成功后缓存模块引用。失败不额外缓存：Node 的 ESM 加载器本身会把求值
 * 失败的模块标记为 errored，后续 import 同一 specifier 直接以同一错误拒绝，
 * 因此重复调用不会产生额外开销，也不会因重试而误判为可用。
 *
 * @returns node-pty 模块
 * @throws TerminalError('PTY_UNAVAILABLE') 平台缺少预编译绑定或模块缺失
 */
async function loadPty(): Promise<PtyModule> {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = await import('@lydell/node-pty');
    return ptyModule;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new TerminalError(
      `终端原生绑定加载失败（平台 ${process.platform}-${process.arch}）：` +
      `${msg}。该平台可能没有预编译二进制，请确认 @lydell/node-pty 的对应该平台子包已随依赖安装。`,
      'PTY_UNAVAILABLE',
    );
  }
}

// —— 插件配置（官方 cordis Config 声明模式） ——

/**
 * 插件配置的运行时形状。
 *
 * DSH 官方 settings 集成不经过服务方法注册（SettingsForms 没有
 * register/get API，先前按手写 SettingsService 假想的接口在两代宿主上
 * 均不成立）：插件在包级导出静态 `Config`（schemastery schema），cordis
 * loader 实例化时 resolve profile patch 的 config 覆盖并传给
 * {@link apply}；SettingsForms.describe 自动从 entry 的 schema 投影出
 * GUI 表单（ns 为 profile 条目 id `terminal-panel`），用户编辑写回
 * profile patch。
 *
 * volatile 字段经 schema `.volatile()` 声明：运行期值是稳定引用
 * （`.get()` 读当前值），GUI 表单编辑后免重启即时生效。
 */
export interface Config {
  /** 展开/收起面板的快捷键（裸监听降级路径；rc.2+ 宿主由 shortcuts 系统接管） */
  toggleShortcut: Volatile<string | undefined>;
  /** 终端字体族（CSS font-family 串）；空 = 内置默认字体栈 */
  fontFamily: Volatile<string | undefined>;
  /** 终端字号（像素） */
  fontSize: Volatile<number | undefined>;
  /** 终端行高倍数 */
  lineHeight: Volatile<number | undefined>;
  /**
   * 终端配置表（JSON 字符串，序列化的 TerminalProfile[]）。
   *
   * 空串 = 用启动时探测到的 $PATH 终端；非空 = 以配置表为准（探测结果已合并进来）。
   * 用字符串而非嵌套数组：schemastery 对对象数组的 round-trip 行为不保证，
   * 且配置文件里出现嵌套数组会让 patch 层难以表达。
   */
  terminalProfiles: Volatile<string | undefined>;
  /** 是否隐藏 DSH 宿主自带终端 tab（兼容模式和原生模式均生效） */
  hideHostTerminal: Volatile<boolean | undefined>;
}

/**
 * 插件配置 schema（包级静态声明，cordis loader 消费）。
 *
 * 两字段均 volatile：出现在 DSH 设置界面的插件配置表单（ns =
 * terminal-panel）里，编辑后免插件重启生效；全字段带 default（3.18 无
 * optional API，见 CLAUDE.md 约束）。
 */
export const Config = z.object({
  toggleShortcut: z.string()
    .description('展开/收起终端面板的快捷键。格式：修饰键+键，如 ctrl+` 或 ctrl+j（修饰键：ctrl, shift, alt, meta；键：字母、数字、F1-F12 或命名键如 `、space、enter）。注意：DSH 0.1.7-rc.2 起宿主自带快捷键系统，此处的快捷键仅在旧宿主（无 shortcuts 服务）上生效；新宿主上请在 DSH 设置界面的快捷键页统一配置 terminal-panel.toggle（默认 Ctrl+Shift+`，因为 Ctrl+` 已被自带终端占用）')
    .default(DEFAULT_TOGGLE_SHORTCUT)
    .volatile(),
  fontFamily: z.string()
    .description('终端字体族（CSS font-family 串），如 \'Maple Mono NF CN\', Consolas, monospace。必须用直引号（\' 或 " ）包裹含空格的字体名，中文引号会被 CSS 当作字体名一部分导致永不匹配。留空使用内置默认字体栈（含 CJK 回退）；Nerd Font / Powerline 用户把本机字体填在最前即可正常显示图标字形。配置变更即时生效，已打开的终端自动更新')
    .default('')
    .volatile(),
  fontSize: z.number()
    .description('终端字号（像素）。默认 12.5。配置变更即时生效，已打开的终端自动更新')
    .default(DEFAULT_FONT_SIZE)
    .volatile(),
  lineHeight: z.number()
    .description('终端行高倍数。默认 1.25（紧凑但不挤行）。配置变更即时生效，已打开的终端自动更新')
    .default(DEFAULT_LINE_HEIGHT)
    .volatile(),
  terminalProfiles: z.string()
    .description('终端配置表（JSON 数组）。每项形如 {"id":"t-pwsh-ab12","type":"pwsh","name":"PowerShell 7","path":"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe","origin":"auto"}。type 决定 spawn 语义（pwsh/powershell/cmd/bash/zsh/fish/gitbash/nushell/custom），name 是下拉菜单显示名，path 留空则按 type 在 $PATH 中解析。留空整表（默认）表示用启动时探测到的 $PATH 终端。自动探测项（origin=auto）不可删除、路径不可改，但可改名')
    .default('')
    .volatile(),
  hideHostTerminal: z.boolean()
    .description('是否隐藏 DSH 宿主自带的侧边栏终端 tab（+菜单里的"新建终端"）。开启后只显示本插件的终端。默认开启')
    .default(true)
    .volatile(),
});

// —— cordis 插件导出 ——

export const name = PKG_NAME;

/** 需要 webServer 服务（HTTP 路由 + WebSocket 升级路由） */
export const inject = ['webServer'];

/**
 * bundle 激活入口。
 *
 * @param ctx - 远端 dsh 的 cordis 上下文
 * @param config - cordis loader resolve 后的插件配置（volatile 引用）
 */
export function apply(ctx: Context, config: Config): void {
  // webServer 服务：注册 HTTP 前缀路由 + per-session WebSocket 升级路由。
  // 属性类型来自官方 @deepseek-ai/dsh-host-webserver 的 cordis Context
  // augmentation（经 ws-handler.ts 的 import type 加载）；运行期实例由
  // dsh 宿主的 webServer 服务提供
  const webServer = ctx.webServer;

  /** 可选的 DSH workspace 注册表——权威的 session -> 工作区路径索引。
   *  无 dsh-workspace 的组合中不存在，cwd 解析降级到 process.cwd() */
  const workspaceRegistry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;

  /**
   * 运行时配置视图：env（ops 级覆盖）优先，其次 volatile 引用的当前值
   * （GUI 表单编辑后免重启即时生效，作用于后续会话），最终回落 schema
   * 默认值。getter 每次访问取最新——volatile 引用 .get() 读的就是配置
   * 系统的当前生效值，无需自行 watch。
   */
  const runtimeSettings = {
    /** 展开/收起面板的快捷键 */
    get toggleShortcut(): string {
      const env = process.env[ENV_TOGGLE_SHORTCUT];
      if (env !== undefined) return env;
      const value = config.toggleShortcut.get();
      return typeof value === 'string' && value.length > 0 ? value : DEFAULT_TOGGLE_SHORTCUT;
    },
    /** 终端字体族（空串 = 前端用内置默认字体栈） */
    get fontFamily(): string {
      const env = process.env[ENV_FONT_FAMILY];
      if (env !== undefined) return env;
      const value = config.fontFamily.get();
      return typeof value === 'string' ? value : '';
    },
    /** 终端字号（像素）——env/配置都要求正有限数，非法值回落默认 */
    get fontSize(): number {
      const env = process.env[ENV_FONT_SIZE];
      if (env !== undefined) {
        const parsed = Number.parseFloat(env);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      const value = config.fontSize.get();
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_FONT_SIZE;
    },
    /** 终端行高倍数——env/配置都要求正有限数，非法值回落默认 */
    get lineHeight(): number {
      const env = process.env[ENV_LINE_HEIGHT];
      if (env !== undefined) {
        const parsed = Number.parseFloat(env);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      const value = config.lineHeight.get();
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_LINE_HEIGHT;
    },
    /**
     * 终端配置表（已合并探测结果的完整列表）。
     *
     * 启动时由 prepareProfiles() 求值一次并缓存——探测涉及多次 where/which
     * 子进程调用，不适合每次 /config 请求都重跑。settings 就绪后由
     * settleProfiles() 按持久层读回值重算并就地刷新。
     */
    get profiles(): readonly TerminalProfile[] {
      return cachedProfiles;
    },
    /** 是否隐藏 DSH 宿主自带终端 tab——默认 true（两种模式均生效） */
    get hideHostTerminal(): boolean {
      const value = config.hideHostTerminal.get();
      return typeof value === 'boolean' ? value : true;
    },
  };

  /**
   * 解析配置项字符串为 TerminalProfile[]；解析失败返回空数组。
   *
   * @param raw - 配置项原始值（JSON 字符串）
   * @returns 解析后的配置表
   */
  function parseProfiles(raw: string | undefined): TerminalProfile[] {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TerminalProfile[]) : [];
    } catch {
      /* 配置被手改坏——按空表处理，下次探测会重新填充 */
      return [];
    }
  }

  /**
   * 计算配置表：env 覆盖 > 已保存配置（合并探测结果）> 纯探测结果。
   *
   * 合并语义：已保存的项全部保留（用户改的 name 不丢），探测到的新 type/path
   * 补进去。这样用户装了新终端后重启即可在下拉菜单看到，同时不影响既有改名。
   *
   * @returns 生效的终端配置表
   */
  function computeProfiles(): TerminalProfile[] {
    const envRaw = process.env[ENV_TERMINAL_PROFILES];
    if (typeof envRaw === 'string' && envRaw.length > 0) {
      const fromEnv = parseProfiles(envRaw);
      if (fromEnv.length > 0) return fromEnv;
    }
    const saved = parseProfiles(config.terminalProfiles.get());
    const detected = detectTerminalProfiles();
    return mergeProfiles(saved, detected);
  }

  /**
   * 启动时求值一次配置表并缓存（快路径）。
   *
   * volatile 配置通道这里读不到已保存表也没关系——结果只是初值，settings
   * 就绪后 settleProfiles() 会按持久层读回值重算并就地刷新。
   */
  function prepareProfiles(): TerminalProfile[] {
    const saved = parseProfiles(config.terminalProfiles.get());
    return mergeProfiles(saved, detectedProfiles);
  }

  /**
   * settings 就绪后按持久层落定配置表：读回已保存表 → 合并探测结果 → 仅首跑
   * 落盘 → 就地刷新缓存。
   *
   * 读写必须走同一通道（settings user 层）：旧实现在 apply 期读 volatile 配置、
   * 却把首跑结果写进 settings user 层，两个通道互不可见，saved 恒为空——每次
   * 启动都判首跑，重新生成配置 id 并覆盖用户改过的 name。就地刷新（splice 保持
   * 数组身份）让 routes、settings bridge 与 runtimeSettings.profiles 持有的引用
   * 同步生效。
   *
   * @param channel - settings 命名空间读写通道（settings/index.ts 逐能力探测）
   */
  function settleProfiles(channel: SettingsChannel): void {
    const persisted = channel.read()?.terminalProfiles;
    // 通道值非字符串（宿主异常形态，如未解包的 volatile 引用）时回落 volatile
    // 配置读；空串是合法的"用户清空配置表"，不再回落
    const raw = typeof persisted === 'string' ? persisted : config.terminalProfiles.get();
    const saved = parseProfiles(raw);
    const { merged, persistPayload } = settleProfileTable(saved, detectedProfiles);

    // 首跑落盘：异步写回，失败只降级警告（只读 profile /老宿主不阻断启动）
    if (persistPayload !== null) {
      const persist = async (): Promise<void> => {
        try {
          // 命名空间必须与 settings 集成注册的 SETTINGS_NS 逐字一致——
          // 此前误用包名派生串（PKG_NAME 去前缀 = 'oh-my-terminal'），与注册的
          // 'terminal-panel' 对不上，首次落盘恒报「namespace not registered」
          await channel.update({ terminalProfiles: persistPayload });
          log.info(`终端配置表已初始化：探测到 ${merged.length} 个终端`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          log.warn(`终端配置表写入失败，仅本次运行有效：${msg}`);
        }
      };
      void persist();
    } else if (saved.length > 0) {
      log.info(`终端配置表已读回：持久层 ${saved.length} 项，合并探测后 ${merged.length} 项`);
    }

    cachedProfiles.splice(0, cachedProfiles.length, ...merged);
  }

  /** 启动时探测结果（只探测一次：where/which 子进程调用有成本） */
  const detectedProfiles = detectTerminalProfiles();
  /** 启动时求值的终端配置表（初值；settings 就绪后由 settleProfiles 就地刷新） */
  const cachedProfiles: TerminalProfile[] = prepareProfiles();
  // 命名空间注册与首跑落盘/读回落定同回调内先注册后读写，天然有序——
  // 写回早于注册会报「namespace is not registered」（时序竞态）
  registerSettingsNamespace(ctx, Config, settleProfiles);

  /** id -> 会话记录 */
  const sessions = new Map<string, SessionRecord>();
  /** id -> per-session WS 升级路由 disposer */
  const upgradeDisposers = new Map<string, () => void>();

  // —— 持久化目录与会话存储 ——
  // $DSH_HOME 由远端 dsh 设置为会话目录；缺失时回落 ~/.dsh
  const DATA_DIR = process.env[ENV_DATA_DIR]
    ?? pathJoin(process.env.DSH_HOME ?? pathJoin(homedir(), '.dsh'), 'plugin-data', 'terminal');
  const store = new SessionStore(DATA_DIR, sessions);

  // —— WebSocket 处理器（从 ws-handler.ts 工厂创建）——
  const { registerSessionWs } = createWsHandlers({
    webServer,
    sessions,
    upgradeDisposers,
  });

  /**
   * 创建新终端会话。
   *
   * 流程：解析 spawn 参数 → 解析 cwd → pty spawn → 登记记录 → 注册 WS 路由 →
   *       持久化元数据 → 挂 onData/onExit 回调
   *
   * @param options - 创建参数
   * @returns 会话记录
   * @throws TerminalError('PTY_UNAVAILABLE') 原生绑定不可用（平台缺预编译二进制）
   */
  async function createSession(options: CreateSessionOptions): Promise<SessionRecord> {
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const { file, args, cmdline: effectiveCmdline } = resolveSpawn(
      options.profileId, cachedProfiles,
    );
    const id = makeId();
    const sessionCwd = resolveSessionCwd(options.cwd, options.sessionId, workspaceRegistry);
    log.info(`[createSession] options: cwd=${options.cwd ?? 'undefined'}, sessionId=${options.sessionId ?? 'undefined'} → resolvedCwd=${sessionCwd}, ownerSessionId=${options.sessionId ?? 'null'}`);

    // 懒加载原生绑定：失败时抛 TerminalError，由路由层转成 HTTP 500 中文提示
    const { spawn } = await loadPty();

    const pty = spawn(file, args, {
      name: platform.ptyName,
      cols,
      rows,
      cwd: sessionCwd,
      env: platform.buildSessionEnv(),
    });

    const record: SessionRecord = {
      id,
      pty,
      shell: file,
      cmdline: effectiveCmdline,
      title: `${file.replace(/^.*[/\\]/, '')} #${getSessionCounter()}`,
      cwd: sessionCwd,
      // seed: restart 继承的滚动缓冲——连接时回放 + 预写入新会话日志
      buffer: (options.seed ?? '').slice(-SCROLLBACK_CHARS),
      exited: false,
      exitDetail: null,
      wsClients: new Set(),
      bornAt: Date.now(),
      ownerSessionId: options.sessionId ?? null,
    };

    // seed 预写入日志文件（覆盖写；流式追加由 queueLog 负责）
    if (record.buffer.length > 0) {
      store.writeSeed(id, record.buffer);
    }

    sessions.set(id, record);
    registerSessionWs(id);
    store.persistMeta();

    log.info(`创建会话 ${id}（${file}，${cols}x${rows}，cwd=${sessionCwd}）`);

    // onData → 追加 buffer（截断到 SCROLLBACK_CHARS）+ 落盘 + ws.send
    pty.onData((data) => {
      if (record.dead) return; // restarted：旧 pty 可能还在吐几帧
      record.buffer = (record.buffer + data).slice(-SCROLLBACK_CHARS);
      store.queueLog(record, data);
      for (const ws of record.wsClients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      }
    });

    // onExit → 标记 exited + 持久化 + 关闭所有 WS 客户端
    pty.onExit(({ exitCode }) => {
      record.exited = true;
      record.exitDetail = exitCode;
      if (!record.dead) {
        store.flushLog(record);
        store.persistMeta();
      }
      log.info(`会话 ${id} 已退出（code ${exitCode}）`);
      for (const ws of record.wsClients) {
        try {
          ws.close(1000, 'session exited');
        } catch {
          /* 忽略关闭失败 */
        }
      }
      record.wsClients.clear();
      // 保留已退出记录作为可重启/可回放历史；仅显式 DELETE 或插件销毁时移除
    });

    return record;
  }

  /**
   * 杀掉会话的 PTY 进程。
   *
   * @param id - 会话 id
   * @returns true=会话存在并已尝试杀
   */
  function killSession(id: string): boolean {
    const record = sessions.get(id);
    if (record === undefined) return false;
    try {
      record.pty?.kill();
    } catch {
      /* 进程已退出——忽略 */
    }
    return true;
  }

  /**
   * 重启会话：读旧 buffer 作为 seed → 杀旧 pty → 创建新会话（继承滚动缓冲）。
   *
   * @param id - 旧会话 id
   * @param cwd - 可选的新工作目录（未传时继承旧会话的）
   * @returns 新会话记录
   */
  async function restartSession(id: string, cwd?: string): Promise<SessionRecord | undefined> {
    const old = sessions.get(id);
    if (old === undefined) return undefined;
    const seed = old.buffer;
    const file = old.shell;
    const requestedCwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : old.cwd;

    // 先 detach 旧会话：标记 dead + 清 pending，防止异步 onExit/onData 帧复活日志文件
    store.detachForRestart(old);
    try {
      old.pty?.kill();
    } catch {
      /* 已退出——忽略 */
    }

    // 注销旧 WS 路由 + 删除旧记录 + 删旧日志
    const dispose = upgradeDisposers.get(id);
    if (dispose !== undefined) {
      dispose();
      upgradeDisposers.delete(id);
    }
    sessions.delete(id);
    store.deleteLogFile(id);

    log.info(`重启会话 ${id}（继承 ${seed.length} 字符缓冲）`);

    // 创建新会话——有 cmdline 时重跑原命令，否则用裸 shell 文件；继承 ownerSessionId
    const fresh = await createSession({
      ...(typeof old.cmdline === 'string' && old.cmdline.length > 0 ? { cmdline: old.cmdline } : { shell: file }),
      cwd: requestedCwd,
      seed,
      sessionId: old.ownerSessionId ?? undefined,
    });
    return fresh;
  }

  // —— 启动时恢复持久化会话（已退出历史 tab）——
  store.loadPersisted(registerSessionWs);

  // —— HTTP 前缀路由注册（从 routes.ts 工厂创建）——
  const disposeRoute = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createRouteHandler({
      sessions,
      store,
      runtimeSettings,
      profiles: cachedProfiles,
      workspaceRegistry,
      createSession,
      killSession,
      restartSession,
      registerSessionWs,
      upgradeDisposers,
    }),
  });

  // —— settings 集成（可选，软探测）——
  // 传入 Config schema：auto=false 下命名空间需显式注册（见 settings/index.ts），
  // 缺注册则设置卡片静默不渲染；cachedProfiles 让 describe 端点返回运行时合并
  // 探测结果后的完整配置表，而非配置系统持久化值（可能是空串）
  registerSettingsIntegration(ctx, Config, cachedProfiles);

  // —— 插件销毁清理 ——
  ctx.effect(() => {
    return (): void => {
      disposeRoute();
      for (const [, dispose] of upgradeDisposers) dispose();
      upgradeDisposers.clear();
      for (const id of [...sessions.keys()]) killSession(id);
    };
  }, PKG_NAME + '.routes');

  log.info(`宿主半已激活；路由前缀 ${ROUTE_PREFIX}，WS 前缀 ${WS_PREFIX}，快捷键 ${runtimeSettings.toggleShortcut}，终端配置 ${cachedProfiles.length} 项`);
}
