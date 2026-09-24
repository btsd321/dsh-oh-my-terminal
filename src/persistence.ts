/**
 * @file 会话持久化层
 * @description 负责会话滚动缓冲日志的落盘/清理与元数据读写。把原先散落在
 *              apply 闭包里的 writeLogChunk/queueLog/flushLog/forgetSession/
 *              persistMeta/loadPersisted 收口到此处，按 {@link SessionStore}
 *              工厂封装对 sessions Map 与持久化目录的依赖，业务模块持有
 *              一个 store 实例即可调用全部持久化操作。
 *
 * 边界：
 * - 本模块只管磁盘 IO 与 SessionRecord 的日志临时字段（pending/flushTimer/
 *   dead），不碰 pty 进程、不碰 WebSocket。
 * - {@link SessionStore.loadPersisted} 恢复历史 tab 时，对每条记录回调
 *   onRestore 让调用方去注册 WS 路由——避免本模块反向依赖 index.ts 的
 *   会话管理逻辑。
 * - 终端数据（pty 输出）通过 queueLog 落盘为本会话日志文件，属用户会话
 *   内容持久化，不进 logger；logger 只记元数据写入失败等生命周期事件。
 */

import type { IPty } from '@lydell/node-pty';
import type { WebSocket } from 'ws';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { SCROLLBACK_CHARS, LOG_FLUSH_MS, META_FILE, LOG_SUBDIR } from './constants.js';
import { createLogger } from './logger.js';

const log = createLogger('terminal-host');

/** 持久化元数据条目（落盘 sessions.json 的单条记录） */
export interface PersistedMeta {
  /** 会话 id */
  id: string;
  /** 显示标题 */
  title: string;
  /** shell 可执行文件路径 */
  shell: string;
  /** 完整命令行（有配置时记录；null = 无配置） */
  cmdline: string | null;
  /** 工作目录 */
  cwd: string;
  /** 创建时间戳（毫秒） */
  bornAt: number;
  /** 所属 DSH 会话 id（用于按会话隔离终端；null = 不属于任何特定会话） */
  ownerSessionId: string | null;
}

/** 会话记录——一个 PTY 会话的完整运行时状态 */
export interface SessionRecord {
  /** 进程内单调 id（t1-<uuid> 格式，不可猜测） */
  id: string;
  /** 来自 @lydell/node-pty 的实例；已退出时为 null */
  pty: IPty | null;
  /** shell 可执行文件路径 */
  shell: string;
  /** 完整命令行（有配置时记录；null = 无配置） */
  cmdline: string | null;
  /** 显示标题 */
  title: string;
  /** 工作目录 */
  cwd: string;
  /** 滚动缓冲（最近 SCROLLBACK_CHARS 字符） */
  buffer: string;
  /** 是否已退出 */
  exited: boolean;
  /** 退出详情（exitCode） */
  exitDetail: number | null;
  /** 活跃 WebSocket 客户端集合 */
  wsClients: Set<WebSocket>;
  /** 创建时间戳（毫秒） */
  bornAt: number;
  /** 所属 DSH 会话 id（用于按会话隔离终端；null = 不属于任何特定会话） */
  ownerSessionId: string | null;
  /** restart 时标记旧 pty 为 dead——旧 pty 的异步 onData/onExit 帧不再落盘 */
  dead?: boolean;
  /** 待落盘的日志块（合并写入用） */
  pending?: string;
  /** 日志合并定时器引用 */
  flushTimer?: ReturnType<typeof setTimeout> | null;
}

/**
 * 会话持久化存储——封装 sessions Map、持久化目录与日志路径，统一暴露
 * 日志合并写入、立即刷新、销毁清理、元数据读写、启动恢复等操作。
 *
 * 所有方法对 sessions Map 与磁盘文件的操作保持原先 apply 闭包内的行为，
 * 仅把重复的写入/清理逻辑提取为 writeLogChunk / cancelPendingFlush。
 */
export class SessionStore {
  /** 持久化根目录（plugin-data/terminal） */
  private readonly dataDir: string;
  /** 元数据文件绝对路径（dataDir/sessions.json） */
  private readonly metaPath: string;
  /** 日志子目录绝对路径（dataDir/logs） */
  private readonly logDir: string;
  /** id -> 会话记录的运行时映射（由 index.ts 持有并传入，本模块不独占） */
  private readonly sessions: Map<string, SessionRecord>;

  /**
   * @param dataDir - 持久化根目录
   * @param sessions - 运行时会话映射（与 index.ts 共享同一实例）
   */
  constructor(dataDir: string, sessions: Map<string, SessionRecord>) {
    this.dataDir = dataDir;
    this.metaPath = pathJoin(dataDir, META_FILE);
    this.logDir = pathJoin(dataDir, LOG_SUBDIR);
    this.sessions = sessions;
  }

  /**
   * 构造会话滚动缓冲日志文件路径。
   *
   * @param id - 会话 id
   * @returns 日志文件绝对路径
   */
  logPath(id: string): string {
    return pathJoin(this.logDir, `${id}.log`);
  }

  /**
   * 从内存映射重写 sessions.json（N 小，全量重写）。
   */
  persistMeta(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const meta: PersistedMeta[] = [...this.sessions.values()].map(s => ({
        id: s.id,
        title: s.title,
        shell: s.shell,
        cmdline: s.cmdline ?? null,
        cwd: s.cwd,
        bornAt: s.bornAt,
        ownerSessionId: s.ownerSessionId ?? null,
      }));
      writeFileSync(this.metaPath, JSON.stringify(meta));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`persist 元数据失败：${msg}`);
    }
  }

  /**
   * 预写 seed 缓冲到会话日志文件（覆盖写，restart 继承滚动缓冲时用）。
   *
   * 与 queueLog 的追加写不同：本方法用 writeFileSync 覆盖写，确保新会话日志
   * 文件从 seed 开始而非追加到旧文件残留。失败仅记日志不影响运行时。
   *
   * @param id - 会话 id
   * @param seed - 初始滚动缓冲（连接时回放 + 预写入日志）
   */
  writeSeed(id: string, seed: string): void {
    try {
      mkdirSync(this.logDir, { recursive: true });
      writeFileSync(this.logPath(id), seed);
    } catch {
      /* best effort——预写失败不影响运行时 */
    }
  }

  /**
   * 删除单条会话日志文件（restart 替换旧会话时用，不删 sessions 条目）。
   *
   * 与 {@link forgetSession} 的区别：forgetSession 还清 pending + 删 sessions
   * 条目 + persistMeta；本方法只删磁盘日志文件。
   *
   * @param id - 会话 id
   */
  deleteLogFile(id: string): void {
    try {
      unlinkSync(this.logPath(id));
    } catch {
      /* 无日志——忽略 */
    }
  }

  /**
   * 写入一段日志块：确保日志目录存在 → 追加写入 → 失败记录 error。
   *
   * queueLog 的定时器回调与 flushLog 共用此函数，消除原先两处逐字相同的
   * mkdirSync + appendFileSync + catch 块。errorLabel 区分调用来源的日志文本。
   *
   * @param record - 会话记录
   * @param chunk - 待写入的日志块
   * @param errorLabel - 失败日志前缀（queueLog 传「写入」，flushLog 传「刷新」）
   */
  private writeLogChunk(record: SessionRecord, chunk: string, errorLabel: string): void {
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(this.logPath(record.id), chunk);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`日志${errorLabel}失败（会话 ${record.id}）：${msg}`);
    }
  }

  /**
   * 清除待写定时器与 pending 缓冲：清 timer → 置空 pending。
   *
   * forgetSession 和 restartSession 的清理序列共用此函数，消除原先两处
   * 逐字相同的「清 timer + 清 pending」块。
   *
   * @param record - 会话记录（可能为 undefined，此时无操作）
   */
  private cancelPendingFlush(record: SessionRecord | undefined): void {
    if (record === undefined) return;
    if (record.flushTimer !== undefined && record.flushTimer !== null) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }
    record.pending = '';
  }

  /**
   * 追加输出到会话日志，250ms 合并以保持 IO 低开销。
   *
   * @param record - 会话记录
   * @param data - 输出数据
   */
  queueLog(record: SessionRecord, data: string): void {
    record.pending = (record.pending ?? '') + data;
    if (record.flushTimer !== undefined && record.flushTimer !== null) return;
    record.flushTimer = setTimeout(() => {
      record.flushTimer = null;
      const chunk = record.pending ?? '';
      record.pending = '';
      if (chunk.length === 0) return;
      this.writeLogChunk(record, chunk, '写入');
    }, LOG_FLUSH_MS);
    // unref 避免定时器阻止进程退出
    record.flushTimer.unref();
  }

  /**
   * 立即刷新待写日志块（退出/销毁时调用）。
   *
   * 与 queueLog 的定时器回调不同：本方法先取消待触发定时器，再把 pending
   * 取出写入并清空，保证退出时不丢数据。写入复用 writeLogChunk。
   *
   * @param record - 会话记录
   */
  flushLog(record: SessionRecord): void {
    // 先取消待触发定时器，避免定时器随后回放已 flush 的数据
    if (record.flushTimer !== undefined && record.flushTimer !== null) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }
    const chunk = record.pending ?? '';
    record.pending = '';
    if (chunk.length === 0) return;
    this.writeLogChunk(record, chunk, '刷新');
  }

  /**
   * 从磁盘删除会话持久化文件（用户显式关闭）。
   * 先清 pending 再删文件——pty.kill() 异步触发 onExit，其 flushLog 会重建被删的文件。
   *
   * @param id - 会话 id
   */
  forgetSession(id: string): void {
    // 先清 pending + 定时器，防止异步 onExit 的 flushLog 重建文件
    this.cancelPendingFlush(this.sessions.get(id));
    this.deleteLogFile(id);
    this.sessions.delete(id);
    this.persistMeta();
  }

  /**
   * 重启清理：标记旧会话 dead + 清 pending，防止异步 onExit/onData 帧复活日志。
   *
   * 与 forgetSession 的区别：本方法不删 sessions 条目（restartSession 自行删除
   * 并重建），也不删日志文件（restartSession 在注销旧 WS 路由后统一删）。
   *
   * @param record - 旧会话记录
   */
  detachForRestart(record: SessionRecord): void {
    record.dead = true;
    this.cancelPendingFlush(record);
  }

  /**
   * 启动时恢复持久化会话为已退出的历史 tab。
   * 读 sessions.json + 各 .log 文件，buffer 从 .log 读取（截断到 SCROLLBACK_CHARS）。
   *
   * @param onRestore - 每恢复一条记录后回调（由调用方注册 per-session WS 路由）
   */
  loadPersisted(onRestore: (id: string) => void): void {
    let meta: PersistedMeta[] = [];
    try {
      meta = JSON.parse(readFileSync(this.metaPath, 'utf8')) as PersistedMeta[];
    } catch {
      return; // 尚未持久化——直接返回
    }
    for (const m of meta) {
      if (this.sessions.has(m.id)) continue;
      let buffer = '';
      try {
        buffer = readFileSync(this.logPath(m.id), 'utf8').slice(-SCROLLBACK_CHARS);
      } catch {
        /* 无日志——空历史 */
      }
      const record: SessionRecord = {
        id: m.id,
        pty: null,
        shell: m.shell ?? 'shell',
        cmdline: typeof m.cmdline === 'string' && m.cmdline.length > 0 ? m.cmdline : null,
        title: m.title ?? '已恢复会话',
        cwd: m.cwd ?? '',
        buffer,
        exited: true,
        exitDetail: 0,
        wsClients: new Set(),
        bornAt: m.bornAt ?? Date.now(),
        ownerSessionId: typeof m.ownerSessionId === 'string' ? m.ownerSessionId : null,
        pending: '',
        flushTimer: null,
      };
      this.sessions.set(m.id, record);
      onRestore(m.id);
    }
  }
}
