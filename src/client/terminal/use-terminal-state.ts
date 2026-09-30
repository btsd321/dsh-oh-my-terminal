/**
 * @file 终端状态管理 Hook
 * @description 终端面板统一状态管理：useReducer 封装 + 启动恢复。
 *              从 hooks.ts 抽取 useTerminalState Hook，包含启动恢复逻辑（/sessions 拉取）。
 *
 * 将原 useSessionRestore 的 3 个独立 state（instances/groups/activeInstanceId）
 * 与 busy/bootReady 合并为单一 TerminalState，通过 terminalReducer 处理所有操作，
 * 消除多 setter 同步遗漏风险。
 *
 * 挂载时拉取 /sessions 恢复当前 DSH 会话下的所有存活终端实例与组。面板按对话注入，
 * 切换工作区会重挂本组件，实例会丢——但宿主仍持有 PTY。在此恢复（只 attach，绝不
 * create——无人打开的挂载不产孤儿 PTY）。bootOnce 守卫防 React 18 严格模式双执行
 * 重复拉取。
 */

import * as React from 'react';
import { terminalReducer, createInitialState } from './reducer.js';
import { createLogger } from '../../logger.js';
import type {
  TerminalInstance, TerminalGroup, TerminalState, TerminalAction,
  SessionEntry, SessionsResponse,
} from '../types.js';

const log = createLogger('terminal-client');

/** 宿主半路由前缀（与 index.ts 的 ROUTE_PREFIX 同源） */
const PREFIX = '/api/dsh-oh-my-terminal';

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
  if (!res.ok) throw new Error('dsh-oh-my-terminal ' + res.status);
  return (await res.json()) as T;
}

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
 * 挂载时拉取 /sessions 恢复当前 DSH 会话下的所有存活终端实例与组。sessionId 变化
 * 时重置 bootOnce 重新恢复该工作区的终端（切换工作区时旧终端"挂到后台"——前端隐藏
 * 但宿主半 PTY 存活，切回来时恢复）。始终 dispatch RESTORE（即使空数组）清空旧工作区
 * 的终端，让 auto-new 逻辑检测到 instances=0 并自动新建。bootOnce 守卫防 React 18
 * 严格模式双执行重复拉取。
 *
 * @param sessionId - 当前 DSH 会话 id，用于按会话过滤恢复终端；undefined 时恢复全部
 * @returns state 与 dispatch
 */
export function useTerminalState(sessionId: string | undefined): TerminalStateResult {
  const { useEffect, useRef, useReducer } = React;
  const [state, dispatch] = useReducer(terminalReducer, createInitialState());
  /** 恢复已完成标记（防止 React 18 严格模式双执行重复拉取） */
  const bootOnce = useRef(false);
  /** 上一次恢复用的 sessionId——变化时重置 bootOnce 重新恢复 */
  const lastSessionId = useRef<string | undefined>(undefined);

  useEffect(() => {
    /* sessionId 变化时重置 bootOnce，允许重新恢复该工作区的终端 */
    if (lastSessionId.current !== sessionId) {
      lastSessionId.current = sessionId;
      bootOnce.current = false;
    }
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
        // 映射存活的 SessionEntry 为 TerminalInstance
        const restoredInstances: TerminalInstance[] = live.map((x: SessionEntry): TerminalInstance => ({
          id: x.id,
          title: x.title,
          shell: x.shell,
          cwd: x.cwd ?? null,
          exited: false,
        }));
        // 每个实例独立成组（恢复场景暂不重建拆分布局，简化为单实例组）
        const restoredGroups: TerminalGroup[] = restoredInstances.map((inst: TerminalInstance): TerminalGroup => ({
          id: inst.id,
          instances: [inst],
          activeInstanceId: inst.id,
        }));
        // 始终 dispatch RESTORE（即使空数组）——切换工作区时清空旧工作区的终端，
        // 让 auto-new 逻辑检测到 instances=0 并自动新建
        dispatch({
          type: 'RESTORE',
          instances: restoredInstances,
          groups: restoredGroups,
          activeInstanceId: restoredInstances[0]?.id ?? '',
        });
        dispatch({ type: 'SET_BOOT_READY' });
      } catch (err) {
        log.error('启动恢复失败', err);
        dispatch({ type: 'SET_BOOT_READY' });
      }
    })();
  }, [sessionId]);

  return { state, dispatch };
}
