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
export function registerSettingsIntegration(
  ctx: Context,
  schema: unknown,
  runtimeProfiles?: unknown[],
): void {
  // 1. 注册 settings 命名空间 + 关闭自动模式——软探测，服务不存在时不激活
  ctx.inject(['settings'], (sctx) => {
    // settings.configure({ auto: false }, fiber) 关闭自动模式：
    // - auto=true：settings 服务自动从 profile patch 读配置并写回插件 Config
    // - auto=false：插件自行管理配置（本插件的 Config 字段都是 volatile 引用，
    //   由 cordis loader 注入，无需 settings 服务二次写入）
    //
    // fiber 参数绑定配置生命周期到当前 effect——effect 销毁时配置自动清理
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));

    // auto=false 同时关闭了命名空间的自动注册——必须在此显式 register，否则
    // describe/mutate 恒报「命名空间不存在」，前端配置卡片静默不渲染。重复注册
    // （热重载、重复 apply）抛 "already registered"，作为幂等情形吞掉；其余注册
    // 失败如实上抛，不把失败包装成成功。
    /** settings 服务注册面的最小鸭子类型（对齐官方 SettingsProvider.register） */
    interface SettingsRegistrar {
      /** 注册命名空间 schema；重复注册抛 "already registered" */
      register(ns: string, schema: unknown): unknown;
    }
    const registrar = sctx.settings as unknown as SettingsRegistrar;
    try {
      registrar.register(SETTINGS_NS, schema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already registered')) throw error;
    }
  });

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
