/**
 * @file 终端面板自定义 Hooks
 * @description 浏览器半终端面板的状态管理逻辑层。从 client.tsx 提取并改造，数据模型
 *              从扁平 TerminalTab 列表升级为 TerminalInstance + TerminalGroup 二层结构，
 *              支持终端拆分（split）与组内水平并排显示。
 *
 *              本文件只负责状态管理（Hooks），不包含 UI 渲染——遵循 SRP 原则。
 *              所有 API 调用经内部辅助函数集中处理，不暴露给组件层。
 *
 * 模块职责边界：
 * - usePanelHeight：拖拽调高 + localStorage 持久化
 * - usePanelGeometry：对话列几何测量 + scrollBody paddingBottom 注入
 * - useSessionRestore：挂载时拉取 /sessions 恢复实例与组
 * - usePanelShortcut：拉取 /config 配置快捷键 + 全局 keydown 监听
 * - useTerminalTabs：终端 CRUD（新建/关闭/重启/拆分/退出标记）
 */

import * as React from 'react';
import { parseShortcut, matchesShortcut, type ShortcutSpec } from '../shortcut.js';
import { createLogger } from '../logger.js';
import type {
  TerminalInstance, TerminalGroup,
  SessionEntry, SessionsResponse, CreateSessionResponse,
  ConfigResponse, ConversationGeo, DeleteSessionResponse,
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

// —— Hook 3: useSessionRestore ——

/** useSessionRestore 返回值 */
export interface SessionRestore {
  /** 终端实例列表 */
  instances: TerminalInstance[];
  /** 实例列表 setter */
  setInstances: React.Dispatch<React.SetStateAction<TerminalInstance[]>>;
  /** 终端组列表 */
  groups: TerminalGroup[];
  /** 组列表 setter */
  setGroups: React.Dispatch<React.SetStateAction<TerminalGroup[]>>;
  /** 当前活跃实例 id */
  activeInstanceId: string | null;
  /** activeInstanceId setter */
  setActiveInstanceId: React.Dispatch<React.SetStateAction<string | null>>;
  /** 操作进行中（禁用按钮） */
  busy: boolean;
  /** busy setter（useTerminalTabs 共用） */
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  /** 启动恢复完成（实例与组列表就绪） */
  bootReady: boolean;
}

/**
 * 会话恢复：挂载时拉取 /sessions 恢复所有终端实例与组。
 *
 * 改造要点（相对于旧版 useSessionRestore）：
 * - 数据模型从扁平 tabs 升级为 instances + groups 二层结构
 * - 恢复时每个实例创建一个独立 TerminalGroup（单实例组）
 * - 未来拆分功能可在同一 group 内追加实例
 *
 * 面板按对话注入，切换工作区会重挂本组件，实例会丢——但宿主仍持有 PTY。在此
 * 恢复（只 attach，绝不 create——无人打开的挂载不产孤儿 PTY）。bootOnce 守卫
 * 防 React 18 严格模式双执行重复拉取。
 *
 * @returns instances/groups/activeInstanceId/busy state 与 setter，及 bootReady 标记
 */
export function useSessionRestore(): SessionRestore {
  const { useEffect, useRef, useState } = React;
  const [instances, setInstances] = useState<TerminalInstance[]>([]);
  const [groups, setGroups] = useState<TerminalGroup[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 恢复已完成标记（防止 React 18 严格模式双执行重复拉取） */
  const bootOnce = useRef(false);
  const [bootReady, setBootReady] = useState(false);

  useEffect(() => {
    if (bootOnce.current) return;
    bootOnce.current = true;
    void (async (): Promise<void> => {
      setBusy(true);
      try {
        const list = await api<SessionsResponse>('/sessions');
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
          setInstances(restoredInstances);

          // 2. 每个实例创建独立的 TerminalGroup（单实例组）
          const restoredGroups: TerminalGroup[] = restoredInstances.map((inst): TerminalGroup => ({
            id: inst.id,
            instances: [inst],
            activeInstanceId: inst.id,
          }));
          setGroups(restoredGroups);

          // 3. 激活最后一个存活实例
          setActiveInstanceId(live[live.length - 1].id);
        }
      } catch (err) {
        log.error('恢复会话失败', err);
      } finally {
        setBusy(false);
        setBootReady(true);
      }
    })();
  }, []);

  return {
    instances, setInstances,
    groups, setGroups,
    activeInstanceId, setActiveInstanceId,
    busy, setBusy,
    bootReady,
  };
}

// —— Hook 4: usePanelShortcut ——

/** usePanelShortcut 返回值 */
export interface PanelShortcut {
  /** 当前切换快捷键 spec */
  shortcut: ShortcutSpec | null;
  /** 快捷键显示标签 */
  shortcutLabel: string;
}

/**
 * 面板切换快捷键：拉取 /config 配置 + 注册全局 keydown 监听。
 *
 * 拉取配置路由缺失时（旧宿主）回落默认值。keydown 监听在终端 pane 内聚焦时
 * 不触发（留给 shell）——当快捷键是终端也消费的控制字符（如 Ctrl+J 换行）时
 * 避免误切面板。
 *
 * @param setOpen - 展开/折叠 state setter（keydown 命中时切换）
 * @returns 快捷键 spec 与显示标签
 */
export function usePanelShortcut(setOpen: React.Dispatch<React.SetStateAction<boolean>>): PanelShortcut {
  const { useEffect, useState } = React;
  const DEFAULT_SHORTCUT = parseShortcut('ctrl+`');
  const [shortcut, setShortcut] = useState<ShortcutSpec | null>(DEFAULT_SHORTCUT);
  const shortcutLabel = shortcut?.label ?? 'Ctrl+`';

  /*
   * 拉取宿主半插件配置：切换快捷键（及未来用的 shell 命令）。路由缺失时（旧宿主）
   * 回落默认值。
   */
  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const cfg = await api<ConfigResponse>('/config');
        if (typeof cfg.toggleShortcut === 'string' && cfg.toggleShortcut.trim().length > 0) {
          const parsed = parseShortcut(cfg.toggleShortcut);
          if (parsed !== null) setShortcut(parsed);
          else log.warn('忽略无效的 toggleShortcut', cfg.toggleShortcut);
        }
      } catch {
        /* 旧宿主无 /config——保持默认 */
      }
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!matchesShortcut(shortcut, e)) return;
      if (e.target instanceof HTMLElement && e.target.closest('.dshTermPane') !== null) return;
      e.preventDefault();
      setOpen(v => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut, setOpen]);

  return { shortcut, shortcutLabel };
}

// —— Hook 5: useTerminalTabs ——

/** useTerminalTabs 的入参 */
export interface TerminalTabsParams {
  /** 终端实例列表 */
  instances: TerminalInstance[];
  /** 实例列表 setter */
  setInstances: React.Dispatch<React.SetStateAction<TerminalInstance[]>>;
  /** 终端组列表 */
  groups: TerminalGroup[];
  /** 组列表 setter */
  setGroups: React.Dispatch<React.SetStateAction<TerminalGroup[]>>;
  /** 当前活跃实例 id */
  activeInstanceId: string | null;
  /** activeInstanceId setter */
  setActiveInstanceId: React.Dispatch<React.SetStateAction<string | null>>;
  /** busy setter */
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
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
 * 改造要点（相对于旧版 useTerminalTabs）：
 * - newTab：创建新实例 + 创建独立 TerminalGroup
 * - splitTerminal：在当前活跃实例所在 group 中插入新实例（新增功能）
 * - closeTab：从 instances 和 groups 中同时移除，维护 group 结构
 * - restartActive：更新 instances 和 groups 中的引用
 * - onExit：标记实例为 exited
 *
 * @param params - 实例/组 state 与工作区上下文
 * @returns 五个终端操作回调
 */
export function useTerminalTabs(params: TerminalTabsParams): TerminalTabs {
  const {
    instances, setInstances,
    groups, setGroups,
    activeInstanceId, setActiveInstanceId,
    setBusy, activeInstance, activeGroup,
    workspaceCwd, sessionId,
  } = params;
  const { useCallback } = React;

  /** 会话退出回调：标记对应实例为 exited */
  const onExit = useCallback((id: string): void => {
    setInstances(cur => cur.map(t => (t.id === id ? { ...t, exited: true } : t)));
    /* 同步更新 groups 中该实例的 exited 状态 */
    setGroups(cur => cur.map(g => ({
      ...g,
      instances: g.instances.map(t => (t.id === id ? { ...t, exited: true } : t)),
    })));
  }, [setInstances, setGroups]);

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
    setBusy(true);
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
      setInstances(cur => [...cur, newInstance]);

      // 2. 创建独立组（单实例组）
      const newGroup: TerminalGroup = {
        id: s.id,
        instances: [newInstance],
        activeInstanceId: s.id,
      };
      setGroups(cur => [...cur, newGroup]);

      setActiveInstanceId(s.id);
    } catch (err) {
      log.error('新建终端失败', err);
    } finally {
      setBusy(false);
    }
  }, [workspaceCwd, activeInstance, sessionId, setBusy, setInstances, setGroups, setActiveInstanceId]);

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
    setBusy(true);
    try {
      const cwd = workspaceCwd ?? activeInstance?.cwd ?? null;
      const body: Record<string, unknown> = { cwd, sessionId };
      if (typeof shell === 'string' && shell.length > 0) body.shell = shell;
      if (typeof cmdline === 'string' && cmdline.length > 0) body.cmdline = cmdline;
      const s = await post<CreateSessionResponse>('/sessions', body);

      // 1. 创建新实例并追加到全局实例列表
      const newInstance: TerminalInstance = {
        id: s.id,
        title: s.title,
        shell: s.shell,
        cwd: s.cwd ?? cwd,
        exited: false,
      };
      setInstances(cur => [...cur, newInstance]);

      // 2. 将新实例插入活跃实例之后（而非末尾），保持拆分位置直觉
      setGroups(cur => cur.map(g => {
        if (g.id !== activeGroup.id) return g;
        const idx = g.instances.findIndex(i => i.id === activeInstanceId);
        const newInstances = [...g.instances];
        newInstances.splice(idx + 1, 0, newInstance);
        return {
          ...g,
          instances: newInstances,
          activeInstanceId: s.id,
        };
      }));

      setActiveInstanceId(s.id);
    } catch (err) {
      log.error('拆分终端失败', err);
    } finally {
      setBusy(false);
    }
  }, [activeGroup, activeInstance, workspaceCwd, sessionId, setBusy, setInstances, setGroups, setActiveInstanceId, newTab]);

  /**
   * ✕ 按钮关闭终端：删会话、从 instances 和 groups 中同时移除、激活邻居。
   *
   * 组内只剩一个实例时整个组被移除；组内有多个实例时只移除目标实例，
   * 活跃位切换到组内相邻实例。
   */
  const closeTab = useCallback(async (id: string): Promise<void> => {
    // 1. 从全局实例列表中移除
    setInstances(cur => {
      const idx = cur.findIndex(t => t.id === id);
      if (idx === -1) return cur;
      const next = cur.filter(t => t.id !== id);
      /* 如果被关闭的是当前活跃实例，切换到全局邻居 */
      setActiveInstanceId(act => {
        if (act !== id) return act;
        if (next.length === 0) return null;
        return (next[Math.min(idx, next.length - 1)] ?? next[0]).id;
      });
      return next;
    });

    // 2. 从 groups 中移除实例，空组整体移除
    setGroups(cur => {
      const updated: TerminalGroup[] = [];
      for (const g of cur) {
        const filtered = g.instances.filter(t => t.id !== id);
        if (filtered.length === 0) continue; // 空组移除
        if (filtered.length === g.instances.length) {
          // 该组不含目标实例，保持不变
          updated.push(g);
        } else {
          // 组内含目标实例，更新组内活跃位
          let nextActive = g.activeInstanceId;
          if (nextActive === id) {
            const removedIdx = g.instances.findIndex(t => t.id === id);
            nextActive = (filtered[Math.min(removedIdx, filtered.length - 1)] ?? filtered[0]).id;
          }
          updated.push({ ...g, instances: filtered, activeInstanceId: nextActive });
        }
      }
      return updated;
    });

    await del('/sessions/' + id);
  }, [setInstances, setGroups, setActiveInstanceId]);

  /*
   * 头部刷新：经宿主 restart 路由原位重启活跃终端——重新生成 shell 并继承旧滚动
   * 缓冲，终端保留历史与标签名（服务端会话计数器每次生成递增，用新 title 会显得
   * "zsh 1 → zsh 2 → zsh 3"，像新建而非重启）。只有 + 按钮追加真新终端。
   */
  const restartActive = useCallback(async (): Promise<void> => {
    if (activeInstance === null) return;
    setBusy(true);
    try {
      /* 优先用实例自身持久化的 cwd（实例可能属于非当前屏幕工作区）；无持久化 cwd
       * 的遗留实例回落当前工作区。 */
      const s = await post<CreateSessionResponse>(
        '/sessions/' + activeInstance.id + '/restart',
        { cwd: activeInstance.cwd ?? workspaceCwd },
      );

      // 1. 更新全局实例列表中的引用
      const restartedInstance: TerminalInstance = {
        id: s.id,
        title: activeInstance.title,
        shell: s.shell,
        cwd: s.cwd ?? activeInstance.cwd ?? workspaceCwd ?? null,
        exited: false,
      };
      setInstances(cur => cur.map(t => (t.id === activeInstance.id ? restartedInstance : t)));

      // 2. 更新 groups 中该实例的引用
      setGroups(cur => cur.map(g => ({
        ...g,
        instances: g.instances.map(t => (t.id === activeInstance.id ? restartedInstance : t)),
        activeInstanceId: g.activeInstanceId === activeInstance.id ? s.id : g.activeInstanceId,
      })));

      setActiveInstanceId(s.id);
    } catch (err) {
      log.error('重启失败', err);
    } finally {
      setBusy(false);
    }
  }, [activeInstance, workspaceCwd, setBusy, setInstances, setGroups, setActiveInstanceId]);

  return { newTab, closeTab, restartActive, splitTerminal, onExit };
}
