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
 */
export function registerSettingsNamespace(ctx: Context, schema: unknown): void {
  // 注册命名空间 +（可选）关闭自动模式——软探测，服务不存在时不激活
  ctx.inject(['settings'], (sctx) => {
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
    }
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
    if (typeof facade.register === 'function') {
      try {
        facade.register(SETTINGS_NS, schema);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('already registered')) throw error;
      }
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
