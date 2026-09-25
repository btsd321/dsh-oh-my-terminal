// src/index.ts
import z from "@deepseek-ai/schemastery";
import { WebSocket as WebSocket2 } from "ws";
import { homedir as homedir2 } from "node:os";
import { join as pathJoin3 } from "node:path";

// src/logger.ts
function formatTimestamp() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function formatMessage(level, module, message, data) {
  const ts = formatTimestamp();
  const base = `[${ts}] [${level}] [${module}] ${message}`;
  if (data === void 0) return base;
  try {
    return `${base} ${JSON.stringify(data)}`;
  } catch {
    return `${base} [\u6570\u636E\u5E8F\u5217\u5316\u5931\u8D25]`;
  }
}
function createLogger(module) {
  return {
    debug(message, data) {
      const text = formatMessage("DEBUG", module, message, data);
      console.debug(text);
    },
    info(message, data) {
      const text = formatMessage("INFO", module, message, data);
      console.info(text);
    },
    warn(message, data) {
      const text = formatMessage("WARN", module, message, data);
      console.warn(text);
    },
    error(message, data) {
      const text = formatMessage("ERROR", module, message, data);
      console.error(text);
    }
  };
}

// src/constants.ts
var PKG_NAME = "dsh-oh-my-terminal";
var ROUTE_PREFIX = "/api/dsh-oh-my-terminal";
var WS_PREFIX = "/api/dsh-oh-my-terminal/ws";
var PROTOCOL_VERSION = 1;
var SCROLLBACK_CHARS = 5e5;
var COLS_MIN = 20;
var COLS_MAX = 500;
var ROWS_MIN = 5;
var ROWS_MAX = 200;
var DEFAULT_COLS = 80;
var DEFAULT_ROWS = 24;
var LOG_FLUSH_MS = 250;
var DEFAULT_TOGGLE_SHORTCUT = "ctrl+shift+`";
var ENV_TOGGLE_SHORTCUT = "DSH_PLUGIN_TERMINAL_TOGGLE_SHORTCUT";
var ENV_SHELL_COMMAND = "DSH_PLUGIN_TERMINAL_SHELL_COMMAND";
var ENV_DATA_DIR = "DSH_PLUGIN_TERMINAL_DATA";
var META_FILE = "sessions.json";
var LOG_SUBDIR = "logs";

// src/platform.ts
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
function envPick(key, fallback) {
  const v = process.env[key];
  return v === void 0 || v === "" ? fallback : v;
}
var LEAKED_ENV_PREFIXES = [
  "ELECTRON_",
  "VIPSHOME",
  "EFC_"
];
function stripLeakedEnv(env) {
  for (const key of Object.keys(env)) {
    if (LEAKED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
}
var posixAdapter = {
  detectDefaultShell() {
    return process.env.SHELL ?? "/bin/bash";
  },
  buildBareSpawnArgs(file) {
    return { file, args: ["-i"] };
  },
  buildSessionEnv() {
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: envPick("COLORTERM", "truecolor"),
      PYTHONIOENCODING: envPick("PYTHONIOENCODING", "utf-8"),
      LANG: envPick("LANG", "en_US.UTF-8"),
      LC_ALL: envPick("LC_ALL", "en_US.UTF-8")
    };
    stripLeakedEnv(env);
    return env;
  },
  ptyName: "xterm-256color",
  builtinTerminalTypes: [
    { id: "default", label: "\u9ED8\u8BA4 Shell", command: "" },
    { id: "bash", label: "Bash", command: "bash -l" },
    { id: "zsh", label: "Zsh", command: "zsh -l" }
  ]
};
function detectGitBash() {
  try {
    const gitPath = execSync("where git", { encoding: "utf8", timeout: 3e3 }).trim().split(/\r?\n/)[0];
    if (typeof gitPath !== "string" || gitPath.length === 0) return null;
    const gitDir = dirname(dirname(gitPath));
    const bashPath = join(gitDir, "bin", "bash.exe");
    return existsSync(bashPath) ? bashPath : null;
  } catch {
    return null;
  }
}
function detectWin32DefaultShell() {
  try {
    try {
      const pwshPath = execSync("where pwsh", { encoding: "utf8", timeout: 3e3 }).trim().split(/\r?\n/)[0];
      if (typeof pwshPath === "string" && pwshPath.length > 0) return pwshPath;
    } catch {
    }
    try {
      const psPath = execSync("where powershell", { encoding: "utf8", timeout: 3e3 }).trim().split(/\r?\n/)[0];
      if (typeof psPath === "string" && psPath.length > 0) return psPath;
    } catch {
    }
  } catch {
  }
  const comspec = process.env.COMSPEC;
  if (typeof comspec === "string" && comspec.length > 0) return comspec;
  return "cmd.exe";
}
var win32Adapter = {
  detectDefaultShell() {
    return detectWin32DefaultShell();
  },
  buildBareSpawnArgs(file) {
    return { file, args: [] };
  },
  buildSessionEnv() {
    const env = {
      ...process.env,
      PYTHONIOENCODING: envPick("PYTHONIOENCODING", "utf-8")
    };
    stripLeakedEnv(env);
    return env;
  },
  ptyName: "xterm-256color",
  get builtinTerminalTypes() {
    const types = [
      { id: "default", label: "\u9ED8\u8BA4 Shell", command: "" },
      { id: "pwsh", label: "PowerShell", command: "pwsh" },
      { id: "cmd", label: "Command Prompt", command: "cmd" }
    ];
    const gitBash = detectGitBash();
    if (gitBash !== null) {
      types.push({ id: "gitbash", label: "Git Bash", command: gitBash });
    }
    return types;
  }
};
var platform = process.platform === "win32" ? win32Adapter : posixAdapter;

// src/persistence.ts
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
var log = createLogger("terminal-host");
var SessionStore = class {
  /** 持久化根目录（plugin-data/terminal） */
  dataDir;
  /** 元数据文件绝对路径（dataDir/sessions.json） */
  metaPath;
  /** 日志子目录绝对路径（dataDir/logs） */
  logDir;
  /** id -> 会话记录的运行时映射（由 index.ts 持有并传入，本模块不独占） */
  sessions;
  /**
   * @param dataDir - 持久化根目录
   * @param sessions - 运行时会话映射（与 index.ts 共享同一实例）
   */
  constructor(dataDir, sessions) {
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
  logPath(id) {
    return pathJoin(this.logDir, `${id}.log`);
  }
  /**
   * 从内存映射重写 sessions.json（N 小，全量重写）。
   */
  persistMeta() {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const meta = [...this.sessions.values()].map((s) => ({
        id: s.id,
        title: s.title,
        shell: s.shell,
        cmdline: s.cmdline ?? null,
        cwd: s.cwd,
        bornAt: s.bornAt,
        ownerSessionId: s.ownerSessionId ?? null
      }));
      writeFileSync(this.metaPath, JSON.stringify(meta));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`persist \u5143\u6570\u636E\u5931\u8D25\uFF1A${msg}`);
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
  writeSeed(id, seed) {
    try {
      mkdirSync(this.logDir, { recursive: true });
      writeFileSync(this.logPath(id), seed);
    } catch {
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
  deleteLogFile(id) {
    try {
      unlinkSync(this.logPath(id));
    } catch {
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
  writeLogChunk(record, chunk, errorLabel) {
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(this.logPath(record.id), chunk);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`\u65E5\u5FD7${errorLabel}\u5931\u8D25\uFF08\u4F1A\u8BDD ${record.id}\uFF09\uFF1A${msg}`);
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
  cancelPendingFlush(record) {
    if (record === void 0) return;
    if (record.flushTimer !== void 0 && record.flushTimer !== null) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }
    record.pending = "";
  }
  /**
   * 追加输出到会话日志，250ms 合并以保持 IO 低开销。
   *
   * @param record - 会话记录
   * @param data - 输出数据
   */
  queueLog(record, data) {
    record.pending = (record.pending ?? "") + data;
    if (record.flushTimer !== void 0 && record.flushTimer !== null) return;
    record.flushTimer = setTimeout(() => {
      record.flushTimer = null;
      const chunk = record.pending ?? "";
      record.pending = "";
      if (chunk.length === 0) return;
      this.writeLogChunk(record, chunk, "\u5199\u5165");
    }, LOG_FLUSH_MS);
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
  flushLog(record) {
    if (record.flushTimer !== void 0 && record.flushTimer !== null) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }
    const chunk = record.pending ?? "";
    record.pending = "";
    if (chunk.length === 0) return;
    this.writeLogChunk(record, chunk, "\u5237\u65B0");
  }
  /**
   * 从磁盘删除会话持久化文件（用户显式关闭）。
   * 先清 pending 再删文件——pty.kill() 异步触发 onExit，其 flushLog 会重建被删的文件。
   *
   * @param id - 会话 id
   */
  forgetSession(id) {
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
  detachForRestart(record) {
    record.dead = true;
    this.cancelPendingFlush(record);
  }
  /**
   * 启动时恢复持久化会话为已退出的历史 tab。
   * 读 sessions.json + 各 .log 文件，buffer 从 .log 读取（截断到 SCROLLBACK_CHARS）。
   *
   * @param onRestore - 每恢复一条记录后回调（由调用方注册 per-session WS 路由）
   */
  loadPersisted(onRestore) {
    let meta = [];
    try {
      meta = JSON.parse(readFileSync(this.metaPath, "utf8"));
    } catch {
      return;
    }
    for (const m of meta) {
      if (this.sessions.has(m.id)) continue;
      let buffer = "";
      try {
        buffer = readFileSync(this.logPath(m.id), "utf8").slice(-SCROLLBACK_CHARS);
      } catch {
      }
      const record = {
        id: m.id,
        pty: null,
        shell: m.shell ?? "shell",
        cmdline: typeof m.cmdline === "string" && m.cmdline.length > 0 ? m.cmdline : null,
        title: m.title ?? "\u5DF2\u6062\u590D\u4F1A\u8BDD",
        cwd: m.cwd ?? "",
        buffer,
        exited: true,
        exitDetail: 0,
        wsClients: /* @__PURE__ */ new Set(),
        bornAt: m.bornAt ?? Date.now(),
        ownerSessionId: typeof m.ownerSessionId === "string" ? m.ownerSessionId : null,
        pending: "",
        flushTimer: null
      };
      this.sessions.set(m.id, record);
      onRestore(m.id);
    }
  }
};

// src/ws-handler.ts
import { WebSocketServer } from "ws";
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  const host = req.headers.host;
  if (host === void 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function createWsHandlers(deps) {
  const { webServer, sessions, upgradeDisposers } = deps;
  function handleWsMessage(session, text) {
    if (session.exited || session.pty === null) return;
    if (text.startsWith('{"type":"resize"')) {
      try {
        const body = JSON.parse(text);
        if (typeof body.cols === "number" && typeof body.rows === "number") {
          session.pty.resize(body.cols, body.rows);
        }
      } catch {
      }
    } else {
      session.pty.write(text);
    }
  }
  function handleWsConnection(session, ws) {
    session.wsClients.add(ws);
    if (session.buffer.length > 0) ws.send(session.buffer);
    if (session.exited) {
      ws.close(1e3, "session exited");
      return;
    }
    ws.on("message", (data) => handleWsMessage(session, String(data)));
    ws.on("close", () => session.wsClients.delete(ws));
    ws.on("error", () => session.wsClients.delete(ws));
  }
  function registerSessionWs(id) {
    upgradeDisposers.set(id, webServer.registerUpgrade({
      path: `${ROUTE_PREFIX}/ws/${id}`,
      handler(req, socket, head) {
        if (!sameOrigin(req)) {
          socket.destroy();
          return;
        }
        const session = sessions.get(id);
        if (session === void 0) {
          socket.destroy();
          return;
        }
        const wss = new WebSocketServer({ noServer: true });
        wss.on("connection", (ws) => handleWsConnection(session, ws));
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      }
    }));
  }
  return { handleWsMessage, handleWsConnection, registerSessionWs };
}

// src/routes.ts
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";

// src/server-command.ts
function splitCommandLine(input) {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (const ch of input.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if ((ch === " " || ch === "	") && !quoted) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return void 0;
}

// src/routes.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, join as pathJoin2 } from "node:path";
import { fileURLToPath } from "node:url";
var log2 = createLogger("terminal-host");
function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function sameOrigin2(req) {
  const origin = req.headers.origin;
  if (origin === void 0) return true;
  const host = req.headers.host;
  if (host === void 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 1e6) return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
var sessionCounter = 0;
function makeId() {
  sessionCounter += 1;
  return `t${sessionCounter}-${randomUUID()}`;
}
function isDefaultWorkspace(path) {
  const lastSegment = path.replace(/[/\\]+$/, "").replace(/^.*[/\\]/, "");
  return lastSegment === "\u9ED8\u8BA4\u5DE5\u4F5C\u533A" || lastSegment.toLowerCase() === "default workspace";
}
function resolveSessionCwd(cwd, sessionId, workspaceRegistry) {
  const candidates = [];
  if (typeof cwd === "string" && cwd.length > 0 && !isDefaultWorkspace(cwd)) candidates.push(cwd);
  if (typeof sessionId === "string" && sessionId.length > 0 && workspaceRegistry !== void 0) {
    try {
      const reg = workspaceRegistry;
      const path = reg.host?.sessionPath?.(sessionId);
      if (typeof path === "string" && path.length > 0 && !isDefaultWorkspace(path)) candidates.push(path);
    } catch {
    }
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
    }
  }
  return homedir();
}
function resolveSpawn(shell, cmdline, runtimeShellCommand) {
  const bare = firstNonEmpty(shell) ?? null;
  if (bare !== null) {
    const { file: file2, args: args2 } = platform.buildBareSpawnArgs(bare);
    return { file: file2, args: args2, cmdline: null };
  }
  const full = firstNonEmpty(cmdline, runtimeShellCommand) ?? null;
  if (full !== null) {
    const parts = splitCommandLine(full);
    const file2 = parts[0] ?? platform.detectDefaultShell();
    return { file: file2, args: parts.slice(1), cmdline: full };
  }
  const file = platform.detectDefaultShell();
  const { args } = platform.buildBareSpawnArgs(file);
  return { file, args, cmdline: null };
}
var PKG_DIR = dirname2(fileURLToPath(import.meta.url));
var xtermCssCache;
function getXtermCss() {
  if (xtermCssCache !== void 0) return xtermCssCache;
  try {
    xtermCssCache = readFileSync2(pathJoin2(PKG_DIR, "xterm.css"), "utf8");
  } catch {
    try {
      xtermCssCache = readFileSync2(pathJoin2(PKG_DIR, "..", "node_modules", "@xterm", "xterm", "css", "xterm.css"), "utf8");
    } catch {
      xtermCssCache = "";
    }
  }
  return xtermCssCache;
}
function createRouteHandler(deps) {
  const {
    sessions,
    store,
    runtimeSettings,
    workspaceRegistry,
    createSession,
    killSession,
    restartSession,
    upgradeDisposers
  } = deps;
  return async function handler(req, res) {
    if (!sameOrigin2(req)) {
      json(res, 403, { error: "cross-origin rejected" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const rest = path.slice(ROUTE_PREFIX.length);
    const method = req.method ?? "GET";
    try {
      if (rest === "/sessions" && method === "GET") {
        const querySessionId = url.searchParams.get("sessionId");
        const filtered = querySessionId !== null ? [...sessions.values()].filter((s) => s.ownerSessionId === querySessionId) : [...sessions.values()];
        json(res, 200, {
          sessions: filtered.map((s) => ({
            id: s.id,
            title: s.title,
            shell: s.shell,
            cmdline: s.cmdline ?? null,
            cwd: s.cwd,
            exited: s.exited,
            bornAt: s.bornAt,
            ownerSessionId: s.ownerSessionId ?? null
          }))
        });
        return;
      }
      if (rest === "/sessions" && method === "POST") {
        const body = await readBody(req);
        const record2 = await createSession({
          cols: clampInt(body.cols, COLS_MIN, COLS_MAX, DEFAULT_COLS),
          rows: clampInt(body.rows, ROWS_MIN, ROWS_MAX, DEFAULT_ROWS),
          cwd: typeof body.cwd === "string" ? body.cwd : void 0,
          shell: typeof body.shell === "string" ? body.shell : void 0,
          cmdline: typeof body.cmdline === "string" ? body.cmdline : void 0,
          sessionId: typeof body.sessionId === "string" ? body.sessionId : void 0
        });
        json(res, 200, { id: record2.id, title: record2.title, shell: record2.shell, cwd: record2.cwd });
        return;
      }
      if (rest === "/config" && method === "GET") {
        json(res, 200, {
          toggleShortcut: runtimeSettings.toggleShortcut,
          shellCommand: runtimeSettings.shellCommand,
          terminalTypes: platform.builtinTerminalTypes,
          protocolVersion: PROTOCOL_VERSION
        });
        return;
      }
      if (rest === "/xterm.css" && method === "GET") {
        const css = getXtermCss();
        if (css.length === 0) {
          json(res, 404, { error: "xterm.css not found" });
          return;
        }
        res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
        res.end(css);
        return;
      }
      const match = rest.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
      if (match === null) {
        json(res, 404, { error: "not found" });
        return;
      }
      const id = match[1] ?? "";
      const action = match[2] ?? "";
      const record = sessions.get(id);
      if (record === void 0) {
        json(res, 404, { error: "no such session" });
        return;
      }
      if (action === "" && method === "DELETE") {
        killSession(id);
        const dispose = upgradeDisposers.get(id);
        if (dispose !== void 0) {
          dispose();
          upgradeDisposers.delete(id);
        }
        store.forgetSession(id);
        log2.info(`\u5220\u9664\u4F1A\u8BDD ${id}`);
        json(res, 200, { ok: true });
        return;
      }
      if (action === "restart" && method === "POST") {
        const body = await readBody(req);
        const fresh = await restartSession(id, typeof body.cwd === "string" ? body.cwd : void 0);
        if (fresh === void 0) {
          json(res, 404, { error: "no such session" });
          return;
        }
        json(res, 200, { id: fresh.id, title: fresh.title, shell: fresh.shell, cwd: fresh.cwd });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const code = error.code;
      json(res, 500, { error: msg, ...code !== void 0 ? { code } : {} });
    }
  };
}
function getSessionCounter() {
  return sessionCounter;
}

// src/index.ts
var log3 = createLogger("terminal-host");
var TerminalError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "TerminalError";
  }
  code;
};
var ptyModule;
async function loadPty() {
  if (ptyModule !== void 0) return ptyModule;
  try {
    ptyModule = await import("@lydell/node-pty");
    return ptyModule;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new TerminalError(
      `\u7EC8\u7AEF\u539F\u751F\u7ED1\u5B9A\u52A0\u8F7D\u5931\u8D25\uFF08\u5E73\u53F0 ${process.platform}-${process.arch}\uFF09\uFF1A${msg}\u3002\u8BE5\u5E73\u53F0\u53EF\u80FD\u6CA1\u6709\u9884\u7F16\u8BD1\u4E8C\u8FDB\u5236\uFF0C\u8BF7\u786E\u8BA4 @lydell/node-pty \u7684\u5BF9\u5E94\u8BE5\u5E73\u53F0\u5B50\u5305\u5DF2\u968F\u4F9D\u8D56\u5B89\u88C5\u3002`,
      "PTY_UNAVAILABLE"
    );
  }
}
var Config = z.object({
  toggleShortcut: z.string().description("\u5C55\u5F00/\u6536\u8D77\u7EC8\u7AEF\u9762\u677F\u7684\u5FEB\u6377\u952E\u3002\u683C\u5F0F\uFF1A\u4FEE\u9970\u952E+\u952E\uFF0C\u5982 ctrl+` \u6216 ctrl+j\uFF08\u4FEE\u9970\u952E\uFF1Actrl, shift, alt, meta\uFF1B\u952E\uFF1A\u5B57\u6BCD\u3001\u6570\u5B57\u3001F1-F12 \u6216\u547D\u540D\u952E\u5982 `\u3001space\u3001enter\uFF09\u3002\u6CE8\u610F\uFF1ADSH 0.1.7-rc.2 \u8D77\u5BBF\u4E3B\u81EA\u5E26\u5FEB\u6377\u952E\u7CFB\u7EDF\uFF0C\u6B64\u5904\u7684\u5FEB\u6377\u952E\u4EC5\u5728\u65E7\u5BBF\u4E3B\uFF08\u65E0 shortcuts \u670D\u52A1\uFF09\u4E0A\u751F\u6548\uFF1B\u65B0\u5BBF\u4E3B\u4E0A\u8BF7\u5728 DSH \u8BBE\u7F6E\u754C\u9762\u7684\u5FEB\u6377\u952E\u9875\u7EDF\u4E00\u914D\u7F6E terminal-panel.toggle\uFF08\u9ED8\u8BA4 Ctrl+Shift+`\uFF0C\u56E0\u4E3A Ctrl+` \u5DF2\u88AB\u81EA\u5E26\u7EC8\u7AEF\u5360\u7528\uFF09").default(DEFAULT_TOGGLE_SHORTCUT).volatile(),
  shellCommand: z.string().description("\u65B0\u5EFA\u7EC8\u7AEF\u4F7F\u7528\u7684 shell \u547D\u4EE4\u884C\uFF0C\u5982 bash -l\u3002\u7559\u7A7A\u81EA\u52A8\u63A2\u6D4B\u5E73\u53F0 shell\uFF08$SHELL || /bin/bash\uFF09\u3002\u4EC5\u5E94\u7528\u4E8E\u65B0\u5EFA\u4F1A\u8BDD\u53CA\u5176\u91CD\u542F\uFF1B\u5DF2\u6709\u4F1A\u8BDD\u4FDD\u7559\u5176\u542F\u52A8\u547D\u4EE4").default("").volatile()
});
var name = PKG_NAME;
var inject = ["webServer"];
function apply(ctx, config) {
  const webServer = ctx.webServer;
  const workspaceRegistry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : void 0;
  const runtimeSettings = {
    /** 展开/收起面板的快捷键 */
    get toggleShortcut() {
      const env = process.env[ENV_TOGGLE_SHORTCUT];
      if (env !== void 0) return env;
      const value = config.toggleShortcut.get();
      return typeof value === "string" && value.length > 0 ? value : DEFAULT_TOGGLE_SHORTCUT;
    },
    /** 新终端的 shell 命令行（空 = 自动探测） */
    get shellCommand() {
      const env = process.env[ENV_SHELL_COMMAND];
      if (env !== void 0) return env;
      const value = config.shellCommand.get();
      return typeof value === "string" ? value : "";
    }
  };
  const sessions = /* @__PURE__ */ new Map();
  const upgradeDisposers = /* @__PURE__ */ new Map();
  const DATA_DIR = process.env[ENV_DATA_DIR] ?? pathJoin3(process.env.DSH_HOME ?? pathJoin3(homedir2(), ".dsh"), "plugin-data", "terminal");
  const store = new SessionStore(DATA_DIR, sessions);
  const { registerSessionWs } = createWsHandlers({
    webServer,
    sessions,
    upgradeDisposers
  });
  async function createSession(options) {
    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const { file, args, cmdline: effectiveCmdline } = resolveSpawn(
      options.shell,
      options.cmdline,
      runtimeSettings.shellCommand
    );
    const id = makeId();
    const sessionCwd = resolveSessionCwd(options.cwd, options.sessionId, workspaceRegistry);
    const { spawn } = await loadPty();
    const pty = spawn(file, args, {
      name: platform.ptyName,
      cols,
      rows,
      cwd: sessionCwd,
      env: platform.buildSessionEnv()
    });
    const record = {
      id,
      pty,
      shell: file,
      cmdline: effectiveCmdline,
      title: `${file.replace(/^.*[/\\]/, "")} #${getSessionCounter()}`,
      cwd: sessionCwd,
      // seed: restart 继承的滚动缓冲——连接时回放 + 预写入新会话日志
      buffer: (options.seed ?? "").slice(-SCROLLBACK_CHARS),
      exited: false,
      exitDetail: null,
      wsClients: /* @__PURE__ */ new Set(),
      bornAt: Date.now(),
      ownerSessionId: options.sessionId ?? null
    };
    if (record.buffer.length > 0) {
      store.writeSeed(id, record.buffer);
    }
    sessions.set(id, record);
    registerSessionWs(id);
    store.persistMeta();
    log3.info(`\u521B\u5EFA\u4F1A\u8BDD ${id}\uFF08${file}\uFF0C${cols}x${rows}\uFF0Ccwd=${sessionCwd}\uFF09`);
    pty.onData((data) => {
      if (record.dead) return;
      record.buffer = (record.buffer + data).slice(-SCROLLBACK_CHARS);
      store.queueLog(record, data);
      for (const ws of record.wsClients) {
        if (ws.readyState === WebSocket2.OPEN) ws.send(data);
      }
    });
    pty.onExit(({ exitCode }) => {
      record.exited = true;
      record.exitDetail = exitCode;
      if (!record.dead) {
        store.flushLog(record);
        store.persistMeta();
      }
      log3.info(`\u4F1A\u8BDD ${id} \u5DF2\u9000\u51FA\uFF08code ${exitCode}\uFF09`);
      for (const ws of record.wsClients) {
        try {
          ws.close(1e3, "session exited");
        } catch {
        }
      }
      record.wsClients.clear();
    });
    return record;
  }
  function killSession(id) {
    const record = sessions.get(id);
    if (record === void 0) return false;
    try {
      record.pty?.kill();
    } catch {
    }
    return true;
  }
  async function restartSession(id, cwd) {
    const old = sessions.get(id);
    if (old === void 0) return void 0;
    const seed = old.buffer;
    const file = old.shell;
    const requestedCwd = typeof cwd === "string" && cwd.length > 0 ? cwd : old.cwd;
    store.detachForRestart(old);
    try {
      old.pty?.kill();
    } catch {
    }
    const dispose = upgradeDisposers.get(id);
    if (dispose !== void 0) {
      dispose();
      upgradeDisposers.delete(id);
    }
    sessions.delete(id);
    store.deleteLogFile(id);
    log3.info(`\u91CD\u542F\u4F1A\u8BDD ${id}\uFF08\u7EE7\u627F ${seed.length} \u5B57\u7B26\u7F13\u51B2\uFF09`);
    const fresh = await createSession({
      ...typeof old.cmdline === "string" && old.cmdline.length > 0 ? { cmdline: old.cmdline } : { shell: file },
      cwd: requestedCwd,
      seed,
      sessionId: old.ownerSessionId ?? void 0
    });
    return fresh;
  }
  store.loadPersisted(registerSessionWs);
  const disposeRoute = webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: createRouteHandler({
      sessions,
      store,
      runtimeSettings,
      workspaceRegistry,
      createSession,
      killSession,
      restartSession,
      registerSessionWs,
      upgradeDisposers
    })
  });
  ctx.effect(() => {
    return () => {
      disposeRoute();
      for (const [, dispose] of upgradeDisposers) dispose();
      upgradeDisposers.clear();
      for (const id of [...sessions.keys()]) killSession(id);
    };
  }, PKG_NAME + ".routes");
  log3.info(`\u5BBF\u4E3B\u534A\u5DF2\u6FC0\u6D3B\uFF1B\u8DEF\u7531\u524D\u7F00 ${ROUTE_PREFIX}\uFF0CWS \u524D\u7F00 ${WS_PREFIX}\uFF0C\u5FEB\u6377\u952E ${runtimeSettings.toggleShortcut}\uFF0Cshell ${runtimeSettings.shellCommand || "(\u81EA\u52A8)"}`);
}
export {
  Config,
  apply,
  inject,
  name
};
