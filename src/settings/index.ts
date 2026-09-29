/**
 * @file settings bridge 模块入口
 * @description 统一导出 settings bridge 的所有公开 API（常量/类型/函数），
 *              并提供辅助函数 {@link registerSettingsIntegration} 用于在插件
 *              主入口（{@link module:index}）注册 settings 集成。
 *
 *              settings 集成是可选的——本插件在有 settings 服务的宿主上才激活
 *              settings bridge 路由；旧宿主或未启用 settings 服务的宿主上，
 *              settings 集成不启动，插件其余功能（终端会话管理）不受影响。
 */

import type { Context } from '@deepseek-ai/cordis';
import { createSettingsBridgeRoutes } from './bridge.js';
import { SETTINGS_NS } from './namespace.js';

// —— re-export 所有模块 ——

export { SETTINGS_NS, BRIDGE_PREFIX, WRITABLE_FIELDS } from './namespace.js';
export type { JsonPatchOp } from './patch.js';
export { buildSetOp, buildSetOps, validateOps } from './patch.js';
export type { SettingsLike, SettingsDescriptor } from './bridge.js';
export { createSettingsBridgeRoutes } from './bridge.js';

// —— 插件集成辅助函数 ——

/**
 * settings 命名空间读写通道（{@link registerSettingsNamespace} 就绪回调的入参）。
 *
 * 读走命名空间的解析值（schema 默认 → base → user 层合并），与 update 写入的
 * user 层同源可见——首跑落盘写进去的值下次启动能从这里读回来。volatile 字段
 * 的稳定引用已在通道内解包为标量，调用方按普通配置值使用。不同宿主的
 * settings 服务暴露面不同，read/update 内部逐能力探测：read 探测不到返回
 * undefined（调用方按"读不到"降级），update 探测不到时返回 rejected promise
 * （调用方按写失败降级）。
 */
export interface SettingsChannel {
  /** 读取本命名空间的解析值（volatile 字段已解包）；宿主能力不足时返回 undefined */
  read(): Record<string, unknown> | undefined;
  /** 合并写入本命名空间的 user 层 */
  update(patch: Record<string, unknown>): Promise<void>;
}

/** settings 服务注册命名空间返回的 owner 能力面（按需探测，不同宿主缺项） */
interface SettingsOwnerScope {
  /** 读取本命名空间解析值 */
  get?: () => unknown;
  /** 合并写入本命名空间 user 层 */
  update?: (patch: Record<string, unknown>) => Promise<void>;
}

/** settings 服务能力面（不同宿主版本暴露面不同，逐能力探测） */
interface SettingsFacade {
  /** 新宿主可选能力：关闭自动写回；旧宿主（0.1.5 系）无此方法 */
  configure?: (options: { auto: boolean }, fiber?: unknown) => void;
  /**
   * 注册命名空间 schema；重复注册抛 "already registered"。
   * 可选——宿主 SettingsForms 靠 cordis loader entries 发现命名空间，
   * 不一定提供此方法（如 0.1.7-rc.1 的 SettingsForms 无 register）。
   */
  register?: (ns: string, schema: unknown) => unknown;
  /** 服务级读取命名空间解析值（register 缺失时的读回通道） */
  get?: (ns: string) => unknown;
  /** 服务级命名空间快照列表（register 与 get 都缺失时的兜底读回通道） */
  describe?: () => Array<{ ns: string; value: unknown }>;
  /** 服务级合并写入（owner scope 缺失时的落盘通道） */
  update?: (ns: string, patch: Record<string, unknown>) => Promise<void>;
}

/** cosmokit volatile 引用的跨包识别符（与 cosmokit isVolatile 同一 Symbol.for 键，跨 ESM/CJS 副本一致） */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * 判断值是否为 schemastery volatile 字段的解析产物（cosmokit 稳定引用）。
 *
 * `.volatile()` 字段的解析结果是 `createVolatile(...)` 引用对象而非标量本身
 * （JSON 序列化后只剩 `{}`）；把引用当标量读会让字符串字段永远"读不到"。
 *
 * @param value - 待判断的值
 * @returns 值是稳定引用（可 `.get()` 取当前值）时 true
 */
function isVolatileRef(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null
    && VOLATILE_WRITE in value
    && typeof (value as { get?: unknown }).get === 'function';
}

/**
 * 逐能力探测读取命名空间解析值。
 *
 * 优先 owner scope（注册即所得），其次服务级 get，最后 describe 扫描——
 * 三条通道读到的都是同一份解析值，差别只在宿主暴露面。返回前把 volatile
 * 字段的稳定引用解包成标量，调用方拿到的就是普通配置值。全部探测不到时
 * 返回 undefined，调用方按"读不到"降级，不伪造空配置。
 *
 * @param facade - settings 服务实例
 * @param owner - register 返回的 owner scope（未注册成功时为 undefined）
 * @returns 命名空间解析值对象（volatile 字段已解包）；读不到时 undefined
 */
function readNamespaceValue(
  facade: SettingsFacade,
  owner: SettingsOwnerScope | undefined,
): Record<string, unknown> | undefined {
  const candidates: unknown[] = [];
  if (typeof owner?.get === 'function') {
    candidates.push(owner.get());
  } else {
    if (typeof facade.get === 'function') candidates.push(facade.get(SETTINGS_NS));
    if (typeof facade.describe === 'function') {
      const descriptor = facade.describe().find((d) => d.ns === SETTINGS_NS);
      if (descriptor !== undefined) candidates.push(descriptor.value);
    }
  }
  for (const value of candidates) {
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, item]) => [key, isVolatileRef(item) ? item.get() : item]),
      );
    }
  }
  return undefined;
}

/**
 * 注册 settings 集成（在插件主入口调用）
 *
 * settings 集成分两步：
 * 1. 配置 settings 服务为非自动模式（`{ auto: false }`）——防止 settings 服务
 *    自动从 profile patch 写回配置（本插件的配置已由 cordis loader 注入为
 *    volatile 引用，无需 settings 服务二次写入）
 * 2. 注册 settings bridge 路由（describe + mutate）——提供 HTTP API 供前端读写配置
 *
 * 两步都用 `ctx.inject(['settings'], ...)` 软探测——settings 服务不存在时不激活，
 * 插件其余功能（终端会话管理）不受影响。路由注册返回 disposer 数组，在插件销毁时
 * 逐一调用清理。
 *
 * @param ctx - cordis 上下文（插件主入口的 apply 参数）
 * @param schema - 插件 Config 的 schemastery schema，用于注册 settings 命名空间。
 *   auto=false 下服务不会自动注册，缺了这一步 describe/mutate 恒报「命名空间
 *   不存在」，前端配置卡片静默不渲染（无报错、无入口）
 * @param runtimeProfiles - 运行时终端配置表（探测+合并后的完整数组），传给 bridge
 *   供 describe 端点覆盖持久化的 terminalProfiles 值
 */
/**
 * 注册 settings 命名空间（幂等，须先于任何 settings 读写）。
 *
 * 命名空间注册是 settings 服务注册表的唯一入口；首次配置落盘（prepareProfiles
 * 的首跑写回）等读写都依赖它——必须在 apply 早期调用本函数，晚于首次写回会
 * 报「namespace is not registered」（时序竞态）。重复注册（热重载、重复 apply、
 * 以及 registerSettingsIntegration 的兜底调用）抛 "already registered"，作为幂等
 * 情形吞掉；其余注册失败（如存储段损坏）如实上抛，不把失败包装成成功。
 *
 * @param ctx - cordis 上下文
 * @param schema - 插件 Config 的 schemastery schema
 * @param onReady - settings 就绪回调，在命名空间注册（或确认宿主无 register）
 *   之后同步触发，入参是同命名空间的读写通道——首跑落盘/读回落定用它保证
 *   读写同一通道，避免 apply 期读 volatile、写 settings 的通道错位
 */
export function registerSettingsNamespace(
  ctx: Context,
  schema: unknown,
  onReady?: (channel: SettingsChannel) => void,
): void {
  // 注册命名空间 +（可选）关闭自动模式——软探测，服务不存在时不激活
  ctx.inject(['settings'], (sctx) => {
    const facade = sctx.settings as unknown as SettingsFacade;

    // configure 仅在宿主提供时调用——0.1.5 系宿主的 settings 服务没有该方法，
    // 直接调用会 TypeError 并中断本回调的后续初始化（包括下面的命名空间注册）：
    // - auto=true：settings 服务自动从 profile patch 读配置并写回插件 Config
    // - auto=false：插件自行管理配置（本插件的 Config 字段都是 volatile 引用，
    //   由 cordis loader 注入，无需 settings 服务二次写入）
    //
    // fiber 参数绑定配置生命周期到当前 effect——effect 销毁时配置自动清理
    if (typeof facade.configure === 'function') {
      const configure = facade.configure;
      sctx.effect(() => {
        const cleanup = configure.call(facade, { auto: false }, ctx.fiber);
        // effect 要求回调返回清理函数；configure 的返回值即其注册的清理效应
        return typeof cleanup === 'function' ? cleanup : (): void => undefined;
      });
    }

    // register 同样逐能力探测——宿主 SettingsForms 靠 cordis loader entries
    // （configEditor.configuration()）发现命名空间，不一定提供 register 方法
    // （0.1.7-rc.1 的 SettingsForms 无此方法）。方法不存在时跳过，不抛 TypeError；
    // 方法存在时重复注册（热重载、重复 apply）抛 "already registered"，作为幂等
    // 情形吞掉；其余注册失败（如存储段损坏）如实上抛，不把失败包装成成功。
    let owner: SettingsOwnerScope | undefined;
    if (typeof facade.register === 'function') {
      try {
        owner = facade.register(SETTINGS_NS, schema) as SettingsOwnerScope | undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('already registered')) throw error;
      }
    }

    // 就绪回调在注册之后触发：回调内的任何读写都能看到已注册的命名空间
    if (onReady !== undefined) {
      onReady({
        read: () => readNamespaceValue(facade, owner),
        update: (patch) => {
          if (typeof owner?.update === 'function') return owner.update(patch);
          if (typeof facade.update === 'function') return facade.update(SETTINGS_NS, patch);
          return Promise.reject(new Error('settings 服务不提供 update，配置无法落盘'));
        },
      });
    }
  });
}

export function registerSettingsIntegration(
  ctx: Context,
  schema: unknown,
  runtimeProfiles?: unknown[],
): void {
  // 0. 命名空间注册兜底（幂等）——正常由调用方在 apply 早期先行调用
  //    registerSettingsNamespace，此处重复注册被吞
  registerSettingsNamespace(ctx, schema);

  // 2. 注册 settings bridge 路由（describe + mutate）——软探测，服务不存在时不激活
  ctx.inject(['webServer', 'settings'], (sctx) => {
    sctx.effect(() => {
      // 从 bridge.ts 工厂创建两个路由配置对象
      const routes = createSettingsBridgeRoutes(sctx.settings, SETTINGS_NS, runtimeProfiles);

      // 逐个注册路由，webServer.register() 返回 disposer 函数
      const disposers = routes.map((routeConfig) => sctx.webServer.register(routeConfig));

      // effect 返回的 cleanup 函数——插件销毁时逐一调用 disposer 注销路由
      return (): void => {
        for (const dispose of disposers) dispose();
      };
    }, 'oh-my-terminal: settings bridge');
  });
}
