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

/**
 * settings 服务能力面（不同宿主版本暴露面不同，逐能力探测）。
 *
 * dsh 0.2.0-rc.2 起的 SettingsForms 无运行时命名空间注册（register）方法——
 * 命名空间由 cordis loader entries（configEditor.configuration()）按 entry id
 * 自动发现。读写统一走服务级 describe/update，不再有 owner scope 二级句柄。
 */
interface SettingsFacade {
  /** 关闭自动写回；旧宿主（0.1.5 系）无此方法 */
  configure?: (options: { auto: boolean }, fiber?: unknown) => void;
  /**
   * 列出所有命名空间的当前快照。
   * 接受可选 { redactSecrets?: boolean }；不带该选项时默认 redactSecrets=true。
   */
  describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string; value: unknown }>;
  /** 服务级合并写入（原子提交到指定命名空间的 user 层） */
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
 * 读取命名空间解析值。
 *
 * dsh 0.2.0-rc.2/0.2.1-rc.2 的 SettingsForms 无运行时 register 与服务级
 * get——命名空间由 cordis loader entry id 自动发现，读取统一走
 * describe().find(ns).value。返回前把 volatile 字段的稳定引用解包成标量，
 * 调用方拿到的就是普通配置值。读不到时返回 undefined，调用方按"读不到"降级。
 *
 * @param facade - settings 服务实例
 * @returns 命名空间解析值对象（volatile 字段已解包）；读不到时 undefined
 */
function readNamespaceValue(
  facade: SettingsFacade,
): Record<string, unknown> | undefined {
  if (typeof facade.describe !== 'function') return undefined;
  const descriptor = facade.describe({ redactSecrets: false })
    .find((d) => d.ns === SETTINGS_NS);
  if (descriptor === undefined) return undefined;
  const value = descriptor.value;
  if (value === null || typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, isVolatileRef(item) ? item.get() : item]),
  );
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
 * @param schema - 插件 Config 的 schemastery schema（保留兼容旧签名；新版
 *   SettingsForms 靠 loader entry 自动发现命名空间，不消费此参数）
 * @param runtimeProfiles - 运行时终端配置表（探测+合并后的完整数组），传给 bridge
 *   供 describe 端点覆盖持久化的 terminalProfiles 值
 */
/**
 * 注册 settings 命名空间（幂等，须先于任何 settings 读写）。
 *
 * dsh 0.2.0-rc.2/0.2.1-rc.2 的 SettingsForms 无运行时命名空间注册方法——
 * 命名空间由 cordis loader entries 按 entry id（本插件的 `terminal-panel`）
 * 自动发现，无需也不可运行时 register。本函数仅配置非自动模式（configure）
 * 并在 settings 服务注入后触发就绪回调，交出同命名空间的读写通道——
 * 首跑落盘/读回落定用它保证读写同一通道，避免 apply 期读 volatile、
 * 写 settings 的通道错位。
 *
 * @param ctx - cordis 上下文
 * @param _schema - 插件 Config 的 schemastery schema（保留参数兼容旧签名；
 *   新版 SettingsForms 靠 loader entry 自动发现命名空间，不消费此参数）
 * @param onReady - settings 就绪回调，在 configure 之后同步触发，入参是同
 *   命名空间的读写通道——read 走 describe().find(ns)，update 走 facade.update
 */
export function registerSettingsNamespace(
  ctx: Context,
  _schema: unknown,
  onReady?: (channel: SettingsChannel) => void,
): void {
  // 配置非自动模式 + 就绪回调——软探测，服务不存在时不激活
  ctx.inject(['settings'], (sctx) => {
    const facade = sctx.settings as unknown as SettingsFacade;

    // configure 仅在宿主提供时调用——0.1.5 系宿主的 settings 服务没有该方法，
    // 直接调用会 TypeError 并中断本回调的后续初始化：
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

    // 就绪回调在 configure 之后触发：回调内的任何读写都经服务级
    // describe/update（命名空间已由 loader entry 自动发现）
    if (onReady !== undefined) {
      onReady({
        read: () => readNamespaceValue(facade),
        update: (patch) => {
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
