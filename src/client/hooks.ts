/**
 * @file 终端面板自定义 Hooks
 * @description 浏览器半终端面板的状态管理逻辑层。从 client.tsx 提取并改造，数据模型
 *              从扁平 TerminalTab 列表升级为 TerminalInstance + TerminalGroup 二层结构，
 *              支持终端拆分（split）与组内水平并排显示。
 *
 *              状态管理采用 useReducer 将 instances/groups/activeInstanceId/busy/bootReady
 *              合并为单一 TerminalState，避免多 setter 同步遗漏。配置拉取（/config）
 *              统一在 useConfig Hook 中完成，消除双次请求。
 *
 *              本文件只负责状态管理（Hooks），不包含 UI 渲染——遵循 SRP 原则。
 *              所有 API 调用经内部辅助函数集中处理，不暴露给组件层。
 *
 * 模块职责边界：
 * - terminalReducer：纯函数 reducer，处理所有 TerminalAction
 * - usePanelHeight：拖拽调高 + localStorage 持久化
 * - usePanelGeometry：对话列几何测量 + scrollBody paddingBottom 注入
 * - useTerminalState：useReducer 封装 + 启动恢复（替代旧 useSessionRestore）
 * - useConfig：统一拉取 /config（快捷键 + 终端种类），消除双次请求
 * - usePanelShortcut：全局 keydown 监听（消费 useConfig 返回的 shortcut）
 * - useTerminalTabs：终端 CRUD（新建/关闭/重启/拆分/退出标记），接收 dispatch
 */

import * as React from 'react';
import { parseShortcut, matchesShortcut, type ShortcutSpec } from '../shortcut.js';
import { createLogger } from '../logger.js';
import type {
  TerminalInstance, TerminalGroup,
  SessionEntry, SessionsResponse, CreateSessionResponse,
  ConfigResponse, ConversationGeo, DeleteSessionResponse,
  TerminalState, TerminalAction, TerminalType,
} from './types.js';

const log = createLogger('terminal-client');

// —— 常量 ——

/** 宿主半路由前缀（与 index.ts 的 ROUTE_PREFIX 同源） */
const PREFIX = '/api/dsh-remote-terminal';

/** 面板高度在 localStorage 里的键名 */
const HEIGHT_KEY = 'dsh-remote-terminal.height';

/** 面板最小高度（像素） */
const MIN_HEIGHT = 120;

/** 面板最大高度占视口的百分比（拖拽上限） */
const MAX_HEIGHT_RATIO = 0.78;

/** 默认面板高度占视口的百分比（首次无 localStorage 时） */
const DEFAULT_HEIGHT_RATIO = 0.36;

/** 默认切换快捷键字符串 */
const DEFAULT_SHORTCUT_STR = 'ctrl+`';

// —— API 辅助函数（仅 hooks 内部使用） ——

/**
 * 通用 fetch 封装：拼前缀、检查 ok、解析 JSON。
 *
 * @param path - 路由路径（不含前缀）
 * @param opts - fetch 选项
 * @returns 解析后的 JSON
 * @throws Error 非 2xx 状态码
 */
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(PREFIX + path, opts);
  if (!res.ok) throw new Error('dsh-remote-terminal ' + res.status);
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

// —— Reducer ——

/** 终端状态初始值 */
const INITIAL_STATE: TerminalState = {
  instances: [],
  groups: [],
  activeInstanceId: null,
  busy: false,
  bootReady: false,
};

/**
 * 终端面板状态 reducer：纯函数处理所有 TerminalAction。
 *
 * 设计要点：
 * - REMOVE_INSTANCE：同时从 instances 和 groups 移除，空组整体移除，维护活跃位
 * - SPLIT_INSTANCE：插入到 afterInstanceId 之后（不是末尾），保持拆分位置直觉
 * - RESTART_INSTANCE：更新 instances 和 groups 中的引用，保留 title
 * - MARK_EXITED：同步更新 instances 和 groups 中的 exited 标记
 *
 * @param state - 当前状态
 * @param action - 要处理的 action
 * @returns 新状态（不可变更新）
 */
export function terminalReducer(state: TerminalState, action: TerminalAction): TerminalState {
  switch (action.type) {
    case 'RESTORE': {
      return {
        ...state,
        instances: action.instances,
        groups: action.groups,
        activeInstanceId: action.activeInstanceId,
      };
    }

    case 'SET_BUSY': {
      return { ...state, busy: action.busy };
    }

    case 'SET_BOOT_READY': {
      return { ...state, bootReady: true, busy: false };
    }

    case 'ADD_INSTANCE': {
      return {
        ...state,
        instances: [...state.instances, action.instance],
        groups: [...state.groups, action.group],
        activeInstanceId: action.instance.id,
      };
    }

    case 'SPLIT_INSTANCE': {
      // 1. 追加到全局实例列表
      const nextInstances = [...state.instances, action.instance];
      // 2. 在目标组内插入到 afterInstanceId 之后
      const nextGroups = state.groups.map(g => {
        if (g.id !== action.groupId) return g;
        const idx = g.instances.findIndex(i => i.id === action.afterInstanceId);
        const newGroupInstances = [...g.instances];
        newGroupInstances.splice(idx + 1, 0, action.instance);
        return {
          ...g,
          instances: newGroupInstances,
          activeInstanceId: action.instance.id,
        };
      });
      return {
        ...state,
        instances: nextInstances,
        groups: nextGroups,
        activeInstanceId: action.instance.id,
      };
    }

    case 'REMOVE_INSTANCE': {
      const id = action.id;
      // 1. 从全局实例列表中移除，计算新的全局活跃位
      const curIdx = state.instances.findIndex(t => t.id === id);
      const nextInstances = state.instances.filter(t => t.id !== id);
      let nextActiveId = state.activeInstanceId;
      if (nextActiveId === id) {
        if (nextInstances.length === 0) {
          nextActiveId = null;
        } else {
          nextActiveId = (nextInstances[Math.min(curIdx, nextInstances.length - 1)] ?? nextInstances[0]).id;
        }
      }
      // 2. 从 groups 中移除实例，空组整体移除，维护组内活跃位
      const nextGroups: TerminalGroup[] = [];
      for (const g of state.groups) {
        const filtered = g.instances.filter(t => t.id !== id);
        if (filtered.length === 0) continue; // 空组移除
        if (filtered.length === g.instances.length) {
          // 该组不含目标实例，保持不变
          nextGroups.push(g);
        } else {
          // 组内含目标实例，更新组内活跃位
          let groupActiveId = g.activeInstanceId;
          if (groupActiveId === id) {
            const removedIdx = g.instances.findIndex(t => t.id === id);
            groupActiveId = (filtered[Math.min(removedIdx, filtered.length - 1)] ?? filtered[0]).id;
          }
          nextGroups.push({ ...g, instances: filtered, activeInstanceId: groupActiveId });
        }
      }
      return {
        ...state,
        instances: nextInstances,
        groups: nextGroups,
        activeInstanceId: nextActiveId,
      };
    }

    case 'RESTART_INSTANCE': {
      const { oldId, newInstance } = action;
      // 1. 更新全局实例列表中的引用
      const nextInstances = state.instances.map(t => (t.id === oldId ? newInstance : t));
      // 2. 更新 groups 中该实例的引用及组内活跃位
      const nextGroups = state.groups.map(g => ({
        ...g,
        instances: g.instances.map(t => (t.id === oldId ? newInstance : t)),
        activeInstanceId: g.activeInstanceId === oldId ? newInstance.id : g.activeInstanceId,
      }));
      return {
        ...state,
        instances: nextInstances,
        groups: nextGroups,
        activeInstanceId: state.activeInstanceId === oldId ? newInstance.id : state.activeInstanceId,
      };
    }

    case 'MARK_EXITED': {
      const id = action.id;
      return {
        ...state,
        instances: state.instances.map(t => (t.id === id ? { ...t, exited: true } : t)),
        groups: state.groups.map(g => ({
          ...g,
          instances: g.instances.map(t => (t.id === id ? { ...t, exited: true } : t)),
        })),
      };
    }

    case 'SET_ACTIVE': {
      const id = action.id;
      // 同时更新全局活跃位和所在组的组内活跃位
      const nextGroups = state.groups.map(g => {
        if (g.instances.some(i => i.id === id)) {
          return { ...g, activeInstanceId: id };
        }
        return g;
      });
      return {
        ...state,
        activeInstanceId: id,
        groups: nextGroups,
      };
    }

    case 'RENAME_INSTANCE': {
      const { id, title } = action;
      return {
        ...state,
        instances: state.instances.map(t => (t.id === id ? { ...t, title } : t)),
        groups: state.groups.map(g => ({
          ...g,
          instances: g.instances.map(t => (t.id === id ? { ...t, title } : t)),
        })),
      };
    }

    default: {
      // 穷尽检查：确保所有 action 类型都已处理
      const _exhaustive: never = action;
      return state;
    }
  }
}

// —— Hook 1: usePanelHeight ——

/** usePanelHeight 返回值 */
export interface PanelHeight {
  /** 当前面板高度（像素） */
  height: number;
  /** 高度 ref（拖拽回调内读最新值，避免闭包陈旧） */
  heightRef: React.MutableRefObject<number>;
  /** 拖拽 grip 的 pointerdown 处理 */
  startResize: (e: React.PointerEvent) => void;
}

/**
 * 面板高度管理：拖拽调高 + localStorage 持久化。
 *
 * 初值从 localStorage 恢复（不小于 MIN_HEIGHT），拖拽在 MIN_HEIGHT～MAX_HEIGHT_RATIO
 * 视口高之间夹取，松手时写回 localStorage。
 *
 * @returns 高度 state、ref、拖拽回调
 */
export function usePanelHeight(): PanelHeight {
  const { useState, useRef, useCallback } = React;

  const [height, setHeight] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY));
      if (Number.isFinite(saved) && saved >= MIN_HEIGHT) return saved;
    } catch { /* storage 不可用（隐私模式 / SSR 探测） */ }
    return Math.round(window.innerHeight * DEFAULT_HEIGHT_RATIO);
  });
  const heightRef = useRef(height);
  heightRef.current = height;

  /* 拖拽 resize grip：向上生长面板 */
  const startResize = useCallback((e: React.PointerEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = heightRef.current;
    const maxH = Math.round(window.innerHeight * MAX_HEIGHT_RATIO);
    const move = (ev: PointerEvent): void => {
      const h = Math.min(maxH, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
      setHeight(Math.round(h));
    };
    const up = (): void => {
      document.body.classList.remove('dshTermResizing');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, String(heightRef.current));
      } catch { /* storage 不可用 */ }
    };
    document.body.classList.add('dshTermResizing');
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, []);

  return { height, heightRef, startResize };
}

// —— Hook 2: usePanelGeometry ——

/** usePanelGeometry 返回值 */
export interface PanelGeometry {
  /** 对话列几何（面板不覆盖侧栏） */
  geo: ConversationGeo;
}

/**
 * 对话列几何测量：面板宽度对齐对话列，并向滚动容器注入 paddingBottom。
 *
 * 终端 bar/panel 固定在视口底部；对话滚动容器获得等于面板高度的 paddingBottom，
 * 使 composer 座位与上方 dock 条目整体上移，不被 fixed 终端面板遮挡。
 *
 * 用 scrollBody 的 paddingBottom 而非 composerSeat 的 marginBottom：composer
 * overlay 模式下 composerSeat 是 absolute，marginBottom 不改锚点；paddingBottom
 * 对 sticky/absolute 子元素都生效。
 *
 * @param rootRef - 面板根元素 ref（测量起点）
 * @returns 对话列几何 state
 */
export function usePanelGeometry(rootRef: React.RefObject<HTMLDivElement | null>): PanelGeometry {
  const { useLayoutEffect, useState } = React;
  const [geo, setGeo] = useState<ConversationGeo>({ left: 0, width: window.innerWidth });

  useLayoutEffect(() => {
    const rootEl = rootRef.current;
    if (rootEl === null) return;
    const findScrollBody = (): HTMLElement | null => {
      return rootEl.closest('[data-conversation-scroll]');
    };
    let scrollBody: HTMLElement | null = null;
    const measure = (): void => {
      if (scrollBody !== null) {
        const r = scrollBody.getBoundingClientRect();
        setGeo({ left: r.left, width: r.width });
      }
      const h = Math.round(rootEl.getBoundingClientRect().height);
      if (scrollBody !== null) scrollBody.style.paddingBottom = h > 0 ? h + 'px' : '';
    };
    scrollBody = findScrollBody();
    const ro = new ResizeObserver(measure);
    if (scrollBody !== null) ro.observe(scrollBody);
    ro.observe(rootEl);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      if (scrollBody !== null) scrollBody.style.paddingBottom = '';
    };
  }, [rootRef]);

  return { geo };
}

// —— Hook 3: useTerminalState（替代旧 useSessionRestore） ——

/** useTerminalState 返回值 */
export interface TerminalStateResult {
  /** 当前状态 */
  state: TerminalState;
  /** dispatch 函数 */
  dispatch: React.Dispatch<TerminalAction>;
}

/**
 * 终端面板统一状态管理：useReducer 封装 + 启动恢复。
 *
 * 将原 useSessionRestore 的 3 个独立 state（instances/groups/activeInstanceId）
 * 与 busy/bootReady 合并为单一 TerminalState，通过 terminalReducer 处理所有操作，
 * 消除多 setter 同步遗漏风险。
 *
 * 挂载时拉取 /sessions 恢复当前 DSH 会话下的所有存活终端实例与组。面板按对话注入，
 * 切换工作区会重挂本组件，实例会丢——但宿主仍持有 PTY。在此恢复（只 attach，绝不
 * create——无人打开的挂载不产孤儿 PTY）。bootOnce 守卫防 React 18 严格模式双执行
 * 重复拉取。
 *
 * @param sessionId - 当前 DSH 会话 id，用于按会话过滤恢复终端；undefined 时恢复全部
 * @returns state 与 dispatch
 */
export function useTerminalState(sessionId: string | undefined): TerminalStateResult {
  const { useEffect, useRef, useReducer } = React;
  const [state, dispatch] = useReducer(terminalReducer, INITIAL_STATE);
  /** 恢复已完成标记（防止 React 18 严格模式双执行重复拉取） */
  const bootOnce = useRef(false);

  useEffect(() => {
    if (bootOnce.current) return;
    bootOnce.current = true;
    void (async (): Promise<void> => {
      dispatch({ type: 'SET_BUSY', busy: true });
      try {
        // 按 DSH 会话 id 过滤恢复终端，避免跨会话串扰
        const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
        const list = await api<SessionsResponse>('/sessions' + query);
        /* 只恢复存活的 PTY 会话——已退出的历史不恢复。
         * DSH 重启后旧 PTY 已死，恢复已退出会话只会显示横杠，
         * 不如让首次打开逻辑自动创建全新终端。 */
        const all = list.sessions ?? [];
        const live = all.filter(x => !x.exited);
        if (live.length > 0) {
          // 1. 将每个存活 SessionEntry 映射为 TerminalInstance
          const restoredInstances: TerminalInstance[] = live.map((x: SessionEntry): TerminalInstance => ({
            id: x.id,
            title: x.title,
            shell: x.shell,
            cwd: typeof x.cwd === 'string' ? x.cwd : null,
            exited: false,
          }));

          // 2. 每个实例创建独立的 TerminalGroup（单实例组）
          const restoredGroups: TerminalGroup[] = restoredInstances.map((inst): TerminalGroup => ({
            id: inst.id,
            instances: [inst],
            activeInstanceId: inst.id,
          }));

          // 3. 激活最后一个存活实例
          const lastId = live[live.length - 1].id;
          dispatch({
            type: 'RESTORE',
            instances: restoredInstances,
            groups: restoredGroups,
            activeInstanceId: lastId,
          });
        }
      } catch (err) {
        log.error('恢复会话失败', err);
      } finally {
        dispatch({ type: 'SET_BOOT_READY' });
      }
    })();
  }, [sessionId]);

  return { state, dispatch };
}

// —— Hook 4: useConfig（统一 /config 拉取） ——

/** useConfig 返回值 */
export interface ConfigResult {
  /** 切换快捷键 spec */
  shortcut: ShortcutSpec | null;
  /** 快捷键显示标签 */
  shortcutLabel: string;
  /** 终端种类列表 */
  terminalTypes: TerminalType[];
}

/**
 * 统一拉取 /config：一次请求同时获取 toggleShortcut 和 terminalTypes。
 *
 * 消除原先 usePanelShortcut 与 client.tsx 分别拉取 /config 的双次请求问题。
 * 路由缺失时（旧宿主）回落默认值。
 *
 * @param setOpen - 展开/折叠 state setter（keydown 命中时切换）
 * @returns 快捷键 spec、显示标签、终端种类列表
 */
export function useConfig(setOpen: React.Dispatch<React.SetStateAction<boolean>>): ConfigResult {
  const { useEffect, useState } = React;
  const defaultShortcut = parseShortcut(DEFAULT_SHORTCUT_STR);
  const [shortcut, setShortcut] = useState<ShortcutSpec | null>(defaultShortcut);
  const [terminalTypes, setTerminalTypes] = useState<TerminalType[]>([]);
  const shortcutLabel = shortcut?.label ?? 'Ctrl+`';

  /* 一次拉取 /config，同时填充快捷键和终端种类 */
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
        // 2. 填充终端种类列表
        if (Array.isArray(cfg.terminalTypes)) {
          setTerminalTypes(cfg.terminalTypes);
        }
      } catch {
        /* 旧宿主无 /config——保持默认 */
      }
    })();
  }, []);

  /* 全局 keydown 监听：命中快捷键时切换面板 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!matchesShortcut(shortcut, e)) return;
      /* 终端 pane 内聚焦时不触发（留给 shell）——当快捷键是终端也消费的控制字符
       * （如 Ctrl+J 换行）时避免误切面板 */
      if (e.target instanceof HTMLElement && e.target.closest('.dshTermPane') !== null) return;
      e.preventDefault();
      setOpen(v => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut, setOpen]);

  return { shortcut, shortcutLabel, terminalTypes };
}

// —— Hook 5: useTerminalTabs（改造为接收 dispatch） ——

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
  /** + 按钮新建终端（创建新实例 + 独立组） */
  newTab: (shell?: string, cmdline?: string) => Promise<void>;
  /** ✕ 按钮关闭终端（从 instances 和 groups 中同时移除） */
  closeTab: (id: string) => Promise<void>;
  /** ⟳ 重启活跃终端（更新 instances 和 groups 中的引用） */
  restartActive: () => Promise<void>;
  /** 拆分终端：在当前活跃实例所在 group 中插入新实例 */
  splitTerminal: (shell?: string, cmdline?: string) => Promise<void>;
  /** 会话退出回调（标记实例为 exited） */
  onExit: (id: string) => void;
}

/**
 * 终端 CRUD：新建、关闭、重启、拆分、退出标记。
 *
 * 所有状态变更通过 dispatch 提交到 terminalReducer，确保 instances/groups/activeInstanceId
 * 原子更新，消除多 setter 同步遗漏风险。
 *
 * @param params - 终端状态、dispatch 与工作区上下文
 * @returns 五个终端操作回调
 */
export function useTerminalTabs(params: TerminalTabsParams): TerminalTabs {
  const {
    state, dispatch,
    activeInstance, activeGroup,
    workspaceCwd, sessionId,
  } = params;
  const { useCallback } = React;

  /** 会话退出回调：标记对应实例为 exited */
  const onExit = useCallback((id: string): void => {
    dispatch({ type: 'MARK_EXITED', id });
  }, [dispatch]);

  /*
   * + 按钮：在当前工作区新开会话，创建新实例 + 独立组。sessionId 随行使宿主半在
   * 客户端 cwd 查询失败时经 DSH 工作区注册表解析工作区路径。
   *
   * 终端种类选择接口预留：可选传 shell（终端种类 id，如 "bash"/"zsh"）或
   * cmdline（完整启动命令）；v1 默认不传，用宿主半配置的默认 shell。
   *
   * @param shell - 终端种类 id（可选，缺省用默认 shell）
   * @param cmdline - 完整启动命令（可选，优先于 shell）
   */
  const newTab = useCallback(async (shell?: string, cmdline?: string): Promise<void> => {
    dispatch({ type: 'SET_BUSY', busy: true });
    try {
      const cwd = workspaceCwd ?? activeInstance?.cwd ?? null;
      const body: Record<string, unknown> = { cwd, sessionId };
      /* 终端种类选择：传 shell 或 cmdline 让宿主半按指定种类创建 PTY */
      if (typeof shell === 'string' && shell.length > 0) body.shell = shell;
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
      log.error('新建终端失败', err);
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
   * @param shell - 终端种类 id（可选，缺省用默认 shell）
   * @param cmdline - 完整启动命令（可选，优先于 shell）
   */
  const splitTerminal = useCallback(async (shell?: string, cmdline?: string): Promise<void> => {
    /* 无活跃组时退化为新建独立组 */
    if (activeGroup === null) {
      await newTab(shell, cmdline);
      return;
    }
    dispatch({ type: 'SET_BUSY', busy: true });
    try {
      const cwd = workspaceCwd ?? activeInstance?.cwd ?? null;
      const body: Record<string, unknown> = { cwd, sessionId };
      if (typeof shell === 'string' && shell.length > 0) body.shell = shell;
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

  return { newTab, closeTab, restartActive, splitTerminal, onExit };
}
