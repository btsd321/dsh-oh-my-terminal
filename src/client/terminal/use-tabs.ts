/**
 * @file 终端标签页管理 Hook
 * @description 终端 CRUD（新建/关闭/重启/拆分）+ 快捷键配置拉取。
 *              从 hooks.ts 抽取 useTerminalTabs 和 useConfig。
 *
 * useConfig：统一拉取 /config，一次请求同时获取 toggleShortcut 和 terminalTypes。
 * 消除原先 usePanelShortcut 与 client.tsx 分别拉取 /config 的双次请求问题。
 * 包含快捷键双轨逻辑（shortcuts 接入 / keydown 降级）。
 *
 * useTerminalTabs：终端 CRUD（+ 按钮新建、拆分、✕ 关闭、⟳ 重启、onExit 退出标记）。
 * 包含客户端 cwd 查询逻辑和终端种类选择接口。
 */

import * as React from 'react';
import { parseShortcut, shouldHandleShortcut, type ShortcutSpec } from '../../shortcut.js';
import { isShortcutsActive, getShortcutsCatalog } from '../shortcut-bridge.js';
import { SHORTCUT_COMMAND_ID } from '../../constants.js';
import { createLogger } from '../../logger.js';
import type {
  TerminalInstance, TerminalGroup, TerminalState, TerminalAction,
  CreateSessionResponse, ConfigResponse, DeleteSessionResponse, TerminalProfile,
} from '../types.js';

const log = createLogger('terminal-client');

/** 宿主半路由前缀（与 index.ts 的 ROUTE_PREFIX 同源） */
const PREFIX = '/api/dsh-oh-my-terminal';

/** 默认切换快捷键字符串 */
const DEFAULT_SHORTCUT_STR = 'ctrl+shift+`';

/**
 * HTTP 请求封装：非 2xx 时抛出带后端错误详情的异常。
 *
 * 宿主半的失败响应体形如 `{ error: string, code?: string }`（见 routes.ts 的
 * 错误分支）。此前的实现只抛状态码，把后端的中文诊断（如「终端原生绑定加载
 * 失败（平台 win32-x64）…」）整个丢掉，排查时只剩一个 500——这里读回响应体，
 * 把错误消息接进异常，浏览器控制台才有可用的定位信息。
 *
 * @param path - 路由路径（不含 PREFIX）
 * @param opts - fetch 选项
 * @returns 解析后的 JSON
 * @throws Error 状态码非 2xx，消息含后端 error 字段（解析失败时回落状态码）
 */
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(PREFIX + path, opts);
  if (!res.ok) {
    /* 响应体可能不是 JSON（网关拦截等），解析失败时回落到状态码 */
    let detail = '';
    try {
      const body = (await res.json()) as { error?: unknown; code?: unknown };
      if (typeof body.error === 'string' && body.error.length > 0) detail = body.error;
    } catch { /* 非 JSON 响应体——用状态码兜底 */ }
    throw new Error(detail.length > 0 ? detail : 'dsh-oh-my-terminal ' + res.status);
  }
  return (await res.json()) as T;
}

/**
 * POST 封装：JSON body。
 *
 * @param path - 路由路径
 * @param body - 请求体（可选，缺省空对象）
 * @returns 解析后的 JSON
 */
const post = <T,>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

/**
 * DELETE 封装：静默失败（会话可能已被远端逐出）。
 *
 * @param path - 路由路径
 */
const del = (path: string): Promise<void> =>
  api<DeleteSessionResponse>(path, { method: 'DELETE' })
    .then(() => { /* 删除成功，无需处理 */ })
    .catch(() => { /* 会话可能已删，幂等 */ });

/** useConfig 返回值 */
export interface ConfigResult {
  /** 解析后的快捷键 spec */
  shortcut: ShortcutSpec | null;
  /** 展示标签（catalog 或回落 shortcut.label） */
  shortcutLabel: string;
  /** 终端字体族（空串时 TermPane 用内置默认） */
  fontFamily: string;
  /** 终端字号（undefined 时 TermPane 用内置默认） */
  fontSize: number | undefined;
  /** 终端行高（undefined 时 TermPane 用内置默认） */
  lineHeight: number | undefined;
  /** 终端配置列表 */
  terminalProfiles: TerminalProfile[];
}

/**
 * 统一拉取 /config：一次请求同时获取 toggleShortcut 和 terminalProfiles。
 *
 * 消除原先 usePanelShortcut 与 client.tsx 分别拉取 /config 的双次请求问题。
 * 路由缺失时（旧宿主）回落默认值。
 *
 * 快捷键双轨：
 * - DSH 0.1.7-rc.2+ 且 shortcuts 命令注册成功：实际生效绑定以官方 catalog
 *   为准（用户可在 DSH 设置界面改键），裸 keydown 监听停用
 * - 未接入（旧宿主或注册失败降级）：裸 keydown 监听 /config 下发的
 *   toggleShortcut（settings/env 依旧生效）
 *
 * @param setOpen - 展开/折叠 state setter（keydown 命中时切换）
 * @returns 快捷键 spec、显示标签、终端配置列表
 */
export function useConfig(setOpen: React.Dispatch<React.SetStateAction<boolean>>): ConfigResult {
  const { useEffect, useState } = React;
  const defaultShortcut = parseShortcut(DEFAULT_SHORTCUT_STR);
  const [shortcut, setShortcut] = useState<ShortcutSpec | null>(defaultShortcut);
  const [terminalProfiles, setTerminalProfiles] = useState<TerminalProfile[]>([]);
  /* 终端字体族/字号/行高：/config 下发；空串/未下发时 TermPane 用内置默认 */
  const [fontFamily, setFontFamily] = useState('');
  const [fontSize, setFontSize] = useState<number | undefined>(undefined);
  const [lineHeight, setLineHeight] = useState<number | undefined>(undefined);
  /* shortcuts 接入后的当前生效绑定标签；未接入时 null（走 shortcut.label） */
  const [catalogLabel, setCatalogLabel] = useState<string | null>(null);
  const shortcutLabel = catalogLabel ?? shortcut?.label ?? 'Ctrl+Shift+`';

  /* 一次拉取 /config，同时填充快捷键和终端配置表 */
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const cfg = await api<ConfigResponse>('/config');
        // 1. 解析切换快捷键
        if (typeof cfg.toggleShortcut === 'string' && cfg.toggleShortcut.trim().length > 0) {
          const parsed = parseShortcut(cfg.toggleShortcut);
          if (parsed !== null) setShortcut(parsed);
          else log.warn('忽略无效的 toggleShortcut', cfg.toggleShortcut);
        }
        // 2. 取字体族、字号、行高（空串/缺省时 TermPane 回落内置默认）
        if (typeof cfg.fontFamily === 'string') setFontFamily(cfg.fontFamily);
        if (typeof cfg.fontSize === 'number' && Number.isFinite(cfg.fontSize) && cfg.fontSize > 0) setFontSize(cfg.fontSize);
        if (typeof cfg.lineHeight === 'number' && Number.isFinite(cfg.lineHeight) && cfg.lineHeight > 0) setLineHeight(cfg.lineHeight);
        // 3. 填充终端配置表
        if (Array.isArray(cfg.terminalProfiles)) {
          setTerminalProfiles(cfg.terminalProfiles);
        }
      } catch {
        /* 旧宿主无 /config——保持默认 */
      }
    })();
  }, []);

  /* 接入 shortcuts 后实际生效绑定以官方 catalog 为准（用户改键即时反映）。
   * 官方 entry.keys 是预格式化键帽数组（Windows 平台内含 '+' 分隔元素），
   * 过滤分隔元素后 '+' 连接即为展示标签——无需自行格式化绑定 */
  useEffect(() => {
    const catalog = getShortcutsCatalog();
    if (catalog === undefined) return;
    const read = (): void => {
      const row = catalog.getSnapshot().find(entry => entry.id === SHORTCUT_COMMAND_ID);
      // 未绑定（用户清空或 web:linux 无默认键）给出提示而非空标签
      setCatalogLabel(row === undefined || row.binding === null
        ? '未绑定'
        : row.keys.filter(k => k !== '+').join('+'));
    };
    read();
    const unsubscribe = catalog.subscribe(read);
    return () => { unsubscribe(); };
  }, []);

  /* 全局 keydown 监听：命中快捷键时切换面板（未接入 shortcuts 的降级路径）。
   * shouldHandleShortcut 先短路 defaultPrevented——DSH shortcuts 或其他组件
   * 已消费的键不再触发，避免同一按键双重响应；接入 shortcuts 后命令由
   * 官方系统分发（面板切换经 shortcut-bridge 的 togglers 驱动），本监听停用 */
  useEffect(() => {
    if (isShortcutsActive()) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!shouldHandleShortcut(shortcut, e)) return;
      /* 终端 pane 内聚焦时不触发（留给 shell）——当快捷键是终端也消费的控制字符
       * （如 Ctrl+J 换行）时避免误切面板 */
      if (e.target instanceof HTMLElement && e.target.closest('.dshTermPane') !== null) return;
      e.preventDefault();
      setOpen(v => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut, setOpen]);

  return { shortcut, shortcutLabel, fontFamily, fontSize, lineHeight, terminalProfiles };
}

/** useTerminalTabs 的入参 */
export interface TerminalTabsParams {
  /** 当前终端状态 */
  state: TerminalState;
  /** dispatch 函数 */
  dispatch: React.Dispatch<TerminalAction>;
  /** 当前活跃实例（instances.find 结果） */
  activeInstance: TerminalInstance | null;
  /** 当前活跃实例所在的组 */
  activeGroup: TerminalGroup | null;
  /** 本面板挂载所在 DSH 会话的工作区路径 */
  workspaceCwd: string | undefined;
  /** 当前 dsh 会话 id */
  sessionId: string | undefined;
}

/** useTerminalTabs 返回值 */
export interface TerminalTabs {
  /** + 按钮新建终端（创建新实例 + 独立组）。cwdOverride 优先于 workspaceCwd */
  newTab: (profileId?: string, cmdline?: string, cwdOverride?: string | null) => Promise<void>;
  /** ✕ 按钮关闭终端（从 instances 和 groups 中同时移除） */
  closeTab: (id: string) => Promise<void>;
  /** ⟳ 重启活跃终端（更新 instances 和 groups 中的引用） */
  restartActive: () => Promise<void>;
  /** 拆分终端（在当前活跃实例所在 group 中插入新实例）。cwdOverride 优先于 workspaceCwd */
  splitTerminal: (profileId?: string, cmdline?: string, cwdOverride?: string | null) => Promise<void>;
  /** WebSocket close 事件回调（标记实例已退出） */
  onExit: (id: string) => void;
}

/**
 * 终端 CRUD：+ 按钮新建、拆分、✕ 关闭、⟳ 重启、onExit 退出标记。
 *
 * 新建与拆分会尝试从当前 DOM 读取 .dshTermPane textarea 的 data-cwd，
 * 回落 activeInstance.cwd 或 workspaceCwd。客户端 cwd 查询失败时经 DSH
 * 工作区注册表解析工作区路径。
 *
 * @param params - 入参（state/dispatch/activeInstance/activeGroup/workspaceCwd/sessionId）
 * @returns 新建/关闭/重启/拆分/onExit 回调
 */
export function useTerminalTabs(params: TerminalTabsParams): TerminalTabs {
  const { state, dispatch, activeInstance, activeGroup, workspaceCwd, sessionId } = params;
  const { useCallback } = React;

  /**
   * + 按钮新建终端：创建新实例 + 独立组（单实例组）。
   *
   * 新建时尝试从当前 DOM 读取活跃终端的 data-cwd，回落 activeInstance.cwd 或
   * workspaceCwd。客户端 cwd 查询失败时经 DSH 工作区注册表解析工作区路径。
   *
   * 终端种类选择：可选传 terminalType（/config 下发的种类 id，如 "pwsh"）
   * 或 cmdline（完整启动命令）；都不传时用宿主半配置的默认 shell。
   *
   * 只传 id、不传命令本身——id 到命令的映射在宿主半（platform 适配器），
   * 前端复制一份既会漂移，也拿不到 Windows 上裸命令名的 PATH 解析结果。
   *
   * @param terminalType - 终端种类 id（可选，缺省用默认 shell）
   * @param cmdline - 完整启动命令（可选，优先于 terminalType）
   */
  const newTab = useCallback(async (profileId?: string, cmdline?: string, cwdOverride?: string | null): Promise<void> => {
    dispatch({ type: 'SET_BUSY', busy: true });
    try {
      const cwd = cwdOverride ?? workspaceCwd ?? activeInstance?.cwd ?? null;
      const body: Record<string, unknown> = { cwd, sessionId };
      /* 终端配置 id：宿主半按 id 查表解析 path 与交互参数 */
      if (typeof profileId === 'string' && profileId.length > 0) body.profileId = profileId;
      if (typeof cmdline === 'string' && cmdline.length > 0) body.cmdline = cmdline;
      const s = await post<CreateSessionResponse>('/sessions', body);

      // 1. 创建新实例
      const newInstance: TerminalInstance = {
        id: s.id,
        title: s.title,
        shell: s.shell,
        cwd: s.cwd ?? cwd,
        exited: false,
      };

      // 2. 创建独立组（单实例组）
      const newGroup: TerminalGroup = {
        id: s.id,
        instances: [newInstance],
        activeInstanceId: s.id,
      };

      dispatch({ type: 'ADD_INSTANCE', instance: newInstance, group: newGroup });
    } catch (err) {
      log.error('新建终端失败', err instanceof Error ? err.message : String(err));
    } finally {
      dispatch({ type: 'SET_BUSY', busy: false });
    }
  }, [workspaceCwd, activeInstance, sessionId, dispatch]);

  /**
   * 拆分终端：在当前活跃实例所在 group 中插入新实例。
   *
   * 新实例与活跃实例同属一个 group，水平并排显示。若当前无活跃实例或无活跃组，
   * 退化为 newTab 行为（创建独立组）。
   *
   * @param profileId - 终端配置 id（可选，缺省用默认 shell）
   * @param cmdline - 完整启动命令（可选，优先于 profileId）
   */
  const splitTerminal = useCallback(async (profileId?: string, cmdline?: string, cwdOverride?: string | null): Promise<void> => {
    /* 无活跃组时退化为新建独立组 */
    if (activeGroup === null) {
      await newTab(profileId, cmdline, cwdOverride);
      return;
    }
    dispatch({ type: 'SET_BUSY', busy: true });
    try {
      const cwd = cwdOverride ?? workspaceCwd ?? activeInstance?.cwd ?? null;
      const body: Record<string, unknown> = { cwd, sessionId };
      if (typeof profileId === 'string' && profileId.length > 0) body.profileId = profileId;
      if (typeof cmdline === 'string' && cmdline.length > 0) body.cmdline = cmdline;
      const s = await post<CreateSessionResponse>('/sessions', body);

      // 1. 创建新实例
      const newInstance: TerminalInstance = {
        id: s.id,
        title: s.title,
        shell: s.shell,
        cwd: s.cwd ?? cwd,
        exited: false,
      };

      // 2. 通过 SPLIT_INSTANCE 插入到活跃实例之后
      dispatch({
        type: 'SPLIT_INSTANCE',
        instance: newInstance,
        groupId: activeGroup.id,
        afterInstanceId: state.activeInstanceId ?? activeGroup.instances[0].id,
      });
    } catch (err) {
      log.error('拆分终端失败', err);
    } finally {
      dispatch({ type: 'SET_BUSY', busy: false });
    }
  }, [activeGroup, activeInstance, workspaceCwd, sessionId, dispatch, state.activeInstanceId, newTab]);

  /**
   * ✕ 按钮关闭终端：删会话、从 instances 和 groups 中同时移除、激活邻居。
   *
   * 组内只剩一个实例时整个组被移除；组内有多个实例时只移除目标实例，
   * 活跃位切换到组内相邻实例。
   *
   * @param id - 要关闭的终端实例 id
   */
  const closeTab = useCallback(async (id: string): Promise<void> => {
    dispatch({ type: 'REMOVE_INSTANCE', id });
    await del('/sessions/' + id);
  }, [dispatch]);

  /*
   * 头部刷新：经宿主 restart 路由原位重启活跃终端——重新生成 shell 并继承旧滚动
   * 缓冲，终端保留历史与标签名（服务端会话计数器每次生成递增，用新 title 会显得
   * "zsh 1 → zsh 2 → zsh 3"，像新建而非重启）。只有 + 按钮追加真新终端。
   */
  const restartActive = useCallback(async (): Promise<void> => {
    if (activeInstance === null) return;
    dispatch({ type: 'SET_BUSY', busy: true });
    try {
      /* 优先用实例自身持久化的 cwd（实例可能属于非当前屏幕工作区）；无持久化 cwd
       * 的遗留实例回落当前工作区。 */
      const s = await post<CreateSessionResponse>(
        '/sessions/' + activeInstance.id + '/restart',
        { cwd: activeInstance.cwd ?? workspaceCwd },
      );

      // 构建重启后的实例（保留旧 title）
      const restartedInstance: TerminalInstance = {
        id: s.id,
        title: activeInstance.title,
        shell: s.shell,
        cwd: s.cwd ?? activeInstance.cwd ?? workspaceCwd ?? null,
        exited: false,
      };

      dispatch({ type: 'RESTART_INSTANCE', oldId: activeInstance.id, newInstance: restartedInstance });
    } catch (err) {
      log.error('重启失败', err);
    } finally {
      dispatch({ type: 'SET_BUSY', busy: false });
    }
  }, [activeInstance, workspaceCwd, dispatch]);

  /**
   * WebSocket close 事件回调：标记实例已退出，右侧列表显示横杠前缀。
   *
   * @param id - 已退出的终端实例 id
   */
  const onExit = useCallback((id: string): void => {
    dispatch({ type: 'MARK_EXITED', id });
  }, [dispatch]);

  return { newTab, closeTab, restartActive, splitTerminal, onExit };
}
