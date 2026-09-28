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
var DEFAULT_FONT_SIZE = 12.5;
var DEFAULT_LINE_HEIGHT = 1.25;
var ENV_TOGGLE_SHORTCUT = "DSH_PLUGIN_TERMINAL_TOGGLE_SHORTCUT";
var ENV_FONT_FAMILY = "DSH_PLUGIN_TERMINAL_FONT_FAMILY";
var ENV_FONT_SIZE = "DSH_PLUGIN_TERMINAL_FONT_SIZE";
var ENV_LINE_HEIGHT = "DSH_PLUGIN_TERMINAL_LINE_HEIGHT";
var ENV_TERMINAL_PROFILES = "DSH_PLUGIN_TERMINAL_PROFILES";
var ENV_DATA_DIR = "DSH_PLUGIN_TERMINAL_DATA";
var META_FILE = "sessions.json";
var LOG_SUBDIR = "logs";

// src/terminal/detect.ts
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// src/terminal/kinds.ts
var KIND_SPECS = [
  {
    kind: "pwsh",
    label: "PowerShell 7+",
    win32Binary: "pwsh.exe",
    posixBinary: "pwsh",
    win32Args: [],
    posixArgs: ["-l"]
  },
  {
    kind: "powershell",
    label: "Windows PowerShell",
    win32Binary: "powershell.exe",
    posixBinary: null,
    // Windows PowerShell 不在 POSIX 上发行
    win32Args: [],
    posixArgs: []
  },
  {
    kind: "cmd",
    label: "Command Prompt",
    win32Binary: "cmd.exe",
    posixBinary: null,
    win32Args: [],
    posixArgs: []
  },
  {
    kind: "bash",
    label: "Bash",
    win32Binary: "bash.exe",
    // WSL/Git Bash/Cygwin
    posixBinary: "bash",
    win32Args: [],
    posixArgs: ["-l"]
  },
  {
    kind: "zsh",
    label: "Zsh",
    win32Binary: null,
    // Windows 上几乎不装 Zsh
    posixBinary: "zsh",
    win32Args: [],
    posixArgs: ["-l"]
  },
  {
    kind: "fish",
    label: "Fish",
    win32Binary: null,
    posixBinary: "fish",
    win32Args: [],
    posixArgs: ["-l"]
  },
  {
    kind: "gitbash",
    label: "Git Bash",
    win32Binary: "bash.exe",
    // Git for Windows 的 bash
    posixBinary: null,
    // Git Bash 是 Windows 专属
    win32Args: ["-l"],
    posixArgs: []
  },
  {
    kind: "nushell",
    label: "Nushell",
    win32Binary: "nu.exe",
    posixBinary: "nu",
    win32Args: [],
    posixArgs: []
  },
  {
    kind: "custom",
    label: "\u81EA\u5B9A\u4E49",
    win32Binary: null,
    // custom 不探测，用户手填 path
    posixBinary: null,
    win32Args: [],
    posixArgs: []
  }
];
function getKindOptions() {
  return KIND_SPECS.filter((spec) => spec.kind !== "custom").map((spec) => ({ kind: spec.kind, label: spec.label })).concat([{ kind: "custom", label: "\u81EA\u5B9A\u4E49" }]);
}
function getKindSpec(kind) {
  return KIND_SPECS.find((s) => s.kind === kind);
}
function getBinaryName(kind) {
  const spec = getKindSpec(kind);
  if (spec === void 0) return null;
  return process.platform === "win32" ? spec.win32Binary : spec.posixBinary;
}
function getInteractiveArgs(kind) {
  const spec = getKindSpec(kind);
  if (spec === void 0) return [];
  return process.platform === "win32" ? spec.win32Args : spec.posixArgs;
}

// src/terminal/detect.ts
function resolveCommand(command) {
  try {
    const cmd = process.platform === "win32" ? `where ${command}` : `which ${command}`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 3e3 });
    const candidates = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const filtered = process.platform === "win32" ? candidates.filter((line) => !/[\\/]WindowsApps[\\/]/i.test(line)) : candidates;
    for (const candidate of filtered) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
function detectGitBash() {
  if (process.platform !== "win32") return null;
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
function generateProfileId(kind) {
  const suffix = Math.random().toString(16).slice(2, 6).padStart(4, "0");
  return `t-${kind}-${suffix}`;
}
function detectTerminalProfiles() {
  const profiles = [];
  for (const spec of KIND_SPECS) {
    if (spec.kind === "custom") continue;
    const binary = process.platform === "win32" ? spec.win32Binary : spec.posixBinary;
    if (binary === null) continue;
    let path = null;
    if (spec.kind === "gitbash" && process.platform === "win32") {
      path = detectGitBash();
    } else {
      path = resolveCommand(binary);
    }
    if (path !== null) {
      profiles.push({
        id: generateProfileId(spec.kind),
        type: spec.kind,
        name: spec.label,
        path,
        origin: "auto"
      });
    }
  }
  return profiles;
}

// src/platform.ts
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
  ptyName: "xterm-256color"
};
function detectWin32DefaultShell() {
  const pwsh = resolveCommand("pwsh");
  if (pwsh !== null) return pwsh;
  const powershell = resolveCommand("powershell");
  if (powershell !== null) return powershell;
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
  ptyName: "xterm-256color"
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
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return void 0;
}

// src/terminal/resolve.ts
import { execSync as execSync2 } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
function resolveCommand2(command) {
  try {
    const cmd = process.platform === "win32" ? `where ${command}` : `which ${command}`;
    const out = execSync2(cmd, { encoding: "utf8", timeout: 3e3 });
    const candidates = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const filtered = process.platform === "win32" ? candidates.filter((line) => !/[\\/]WindowsApps[\\/]/i.test(line)) : candidates;
    for (const candidate of filtered) {
      if (existsSync2(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
function resolveProfile(profile) {
  let file;
  if (profile.path.length > 0) {
    file = profile.path;
  } else {
    if (profile.type === "custom") {
      throw new Error(`Profile "${profile.name}" (type=custom) \u5FC5\u987B\u586B\u5199 path \u5B57\u6BB5`);
    }
    const binary = getBinaryName(profile.type);
    if (binary === null) {
      return null;
    }
    const resolved = resolveCommand2(binary);
    if (resolved === null) {
      return null;
    }
    file = resolved;
  }
  const args = getInteractiveArgs(profile.type);
  return { file, args };
}

// src/terminal/store.ts
function mergeProfiles(saved, detected) {
  const result = [...saved];
  for (const detectedItem of detected) {
    const exists = result.some(
      (s) => s.type === detectedItem.type && s.path === detectedItem.path
    );
    if (!exists) {
      result.push(detectedItem);
    }
  }
  return result;
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
function resolveSpawn(profileId, profiles) {
  const wanted = firstNonEmpty(profileId) ?? null;
  if (wanted !== null) {
    const profile = profiles.find((p) => p.id === wanted);
    if (profile !== void 0) {
      const spawnArgs = resolveProfile(profile);
      if (spawnArgs !== null) {
        return { file: spawnArgs.file, args: spawnArgs.args, cmdline: profile.path || null };
      }
      log2.warn(`\u7EC8\u7AEF\u914D\u7F6E ${wanted}\uFF08${profile.name}\uFF09\u65E0\u6CD5\u89E3\u6790\u4E3A\u53EF\u6267\u884C\u6587\u4EF6\uFF0C\u56DE\u843D\u5230\u5E73\u53F0\u9ED8\u8BA4 shell`);
    } else {
      log2.warn(`\u7EC8\u7AEF\u914D\u7F6E id ${wanted} \u4E0D\u5B58\u5728\uFF0C\u56DE\u843D\u5230\u5E73\u53F0\u9ED8\u8BA4 shell`);
    }
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
    profiles,
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
          profileId: typeof body.profileId === "string" ? body.profileId : void 0,
          sessionId: typeof body.sessionId === "string" ? body.sessionId : void 0
        });
        json(res, 200, { id: record2.id, title: record2.title, shell: record2.shell, cwd: record2.cwd });
        return;
      }
      if (rest === "/config" && method === "GET") {
        json(res, 200, {
          toggleShortcut: runtimeSettings.toggleShortcut,
          fontFamily: runtimeSettings.fontFamily,
          fontSize: runtimeSettings.fontSize,
          lineHeight: runtimeSettings.lineHeight,
          terminalProfiles: profiles,
          protocolVersion: PROTOCOL_VERSION
        });
        return;
      }
      if (rest === "/terminal-kinds" && method === "GET") {
        json(res, 200, { kinds: getKindOptions() });
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

// src/settings/namespace.ts
var SETTINGS_NS = "terminal-panel";
var BRIDGE_PREFIX = "/settings";

// src/settings/bridge.ts
function sameOrigin3(req) {
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
function json2(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function readBody2(req) {
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
function createSettingsBridgeRoutes(settings, namespace, runtimeProfiles) {
  return [
    // GET ${ROUTE_PREFIX}${BRIDGE_PREFIX}/describe — 返回插件配置快照
    {
      kind: "exact",
      path: `${ROUTE_PREFIX}${BRIDGE_PREFIX}/describe`,
      handler: async (req, res) => {
        if (!sameOrigin3(req)) {
          json2(res, 403, { ok: false, code: "cross-origin", message: "\u8DE8\u6E90\u8BF7\u6C42\u88AB\u62D2\u7EDD" });
          return;
        }
        if (req.method !== "GET") {
          json2(res, 405, { ok: false, code: "method-not-allowed", message: "\u53EA\u5141\u8BB8 GET \u65B9\u6CD5" });
          return;
        }
        try {
          const descriptors = settings.describe({ redactSecrets: false });
          const descriptor = descriptors.find((d) => d.ns === namespace);
          if (descriptor === void 0) {
            json2(res, 404, {
              ok: false,
              code: "namespace-not-found",
              message: `\u547D\u540D\u7A7A\u95F4 ${namespace} \u4E0D\u5B58\u5728`
            });
            return;
          }
          const configValue = descriptor.value;
          const value = configValue !== null && typeof configValue === "object" ? { ...configValue } : {};
          if (runtimeProfiles !== void 0) {
            value.terminalProfiles = JSON.stringify(runtimeProfiles);
          }
          json2(res, 200, {
            ok: true,
            value: {
              namespace: descriptor.ns,
              revision: descriptor.revision,
              value,
              writable: settings.writable
            }
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          json2(res, 500, { ok: false, code: "internal-error", message: msg });
        }
      }
    },
    // POST ${ROUTE_PREFIX}${BRIDGE_PREFIX}/mutate — 原子提交配置变更
    {
      kind: "exact",
      path: `${ROUTE_PREFIX}${BRIDGE_PREFIX}/mutate`,
      handler: async (req, res) => {
        if (!sameOrigin3(req)) {
          json2(res, 403, { ok: false, code: "cross-origin", message: "\u8DE8\u6E90\u8BF7\u6C42\u88AB\u62D2\u7EDD" });
          return;
        }
        if (req.method !== "POST") {
          json2(res, 405, { ok: false, code: "method-not-allowed", message: "\u53EA\u5141\u8BB8 POST \u65B9\u6CD5" });
          return;
        }
        try {
          const body = await readBody2(req);
          const ns = body.ns;
          const ops = body.ops;
          const expectedRevision = body.expectedRevision;
          if (typeof ns !== "string" || ns !== namespace) {
            json2(res, 400, {
              ok: false,
              code: "invalid-namespace",
              message: `\u547D\u540D\u7A7A\u95F4\u5FC5\u987B\u662F ${namespace}`
            });
            return;
          }
          if (!Array.isArray(ops)) {
            json2(res, 400, {
              ok: false,
              code: "invalid-ops",
              message: "ops \u5FC5\u987B\u662F\u6570\u7EC4"
            });
            return;
          }
          if (expectedRevision !== void 0 && (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
            json2(res, 400, {
              ok: false,
              code: "invalid-revision",
              message: "expectedRevision \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570"
            });
            return;
          }
          await settings.mutate(ns, ops, expectedRevision);
          const fresh = settings.describe({ redactSecrets: false }).find((d) => d.ns === namespace);
          if (fresh === void 0) {
            json2(res, 500, {
              ok: false,
              code: "internal-error",
              message: `\u63D0\u4EA4\u6210\u529F\u4F46\u547D\u540D\u7A7A\u95F4 ${namespace} \u5DF2\u4E0D\u5B58\u5728`
            });
            return;
          }
          json2(res, 200, {
            ok: true,
            value: {
              namespace: fresh.ns,
              revision: fresh.revision,
              value: fresh.value,
              writable: settings.writable
            }
          });
        } catch (error) {
          if (error instanceof Error && error.name === "SettingsConflictError") {
            const conflictError = error;
            json2(res, 409, {
              ok: false,
              code: "settings-conflict",
              message: conflictError.message
            });
            return;
          }
          const msg = error instanceof Error ? error.message : String(error);
          json2(res, 500, { ok: false, code: "internal-error", message: msg });
        }
      }
    }
  ];
}

// src/settings/index.ts
function registerSettingsIntegration(ctx, schema, runtimeProfiles) {
  ctx.inject(["settings"], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
    const registrar = sctx.settings;
    try {
      registrar.register(SETTINGS_NS, schema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already registered")) throw error;
    }
  });
  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => {
      const routes = createSettingsBridgeRoutes(sctx.settings, SETTINGS_NS, runtimeProfiles);
      const disposers = routes.map((routeConfig) => sctx.webServer.register(routeConfig));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, "oh-my-terminal: settings bridge");
  });
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
  fontFamily: z.string().description(`\u7EC8\u7AEF\u5B57\u4F53\u65CF\uFF08CSS font-family \u4E32\uFF09\uFF0C\u5982 'Maple Mono NF CN', Consolas, monospace\u3002\u5FC5\u987B\u7528\u76F4\u5F15\u53F7\uFF08' \u6216 " \uFF09\u5305\u88F9\u542B\u7A7A\u683C\u7684\u5B57\u4F53\u540D\uFF0C\u4E2D\u6587\u5F15\u53F7\u4F1A\u88AB CSS \u5F53\u4F5C\u5B57\u4F53\u540D\u4E00\u90E8\u5206\u5BFC\u81F4\u6C38\u4E0D\u5339\u914D\u3002\u7559\u7A7A\u4F7F\u7528\u5185\u7F6E\u9ED8\u8BA4\u5B57\u4F53\u6808\uFF08\u542B CJK \u56DE\u9000\uFF09\uFF1BNerd Font / Powerline \u7528\u6237\u628A\u672C\u673A\u5B57\u4F53\u586B\u5728\u6700\u524D\u5373\u53EF\u6B63\u5E38\u663E\u793A\u56FE\u6807\u5B57\u5F62\u3002\u914D\u7F6E\u53D8\u66F4\u5373\u65F6\u751F\u6548\uFF0C\u5DF2\u6253\u5F00\u7684\u7EC8\u7AEF\u81EA\u52A8\u66F4\u65B0`).default("").volatile(),
  fontSize: z.number().description("\u7EC8\u7AEF\u5B57\u53F7\uFF08\u50CF\u7D20\uFF09\u3002\u9ED8\u8BA4 12.5\u3002\u914D\u7F6E\u53D8\u66F4\u5373\u65F6\u751F\u6548\uFF0C\u5DF2\u6253\u5F00\u7684\u7EC8\u7AEF\u81EA\u52A8\u66F4\u65B0").default(DEFAULT_FONT_SIZE).volatile(),
  lineHeight: z.number().description("\u7EC8\u7AEF\u884C\u9AD8\u500D\u6570\u3002\u9ED8\u8BA4 1.25\uFF08\u7D27\u51D1\u4F46\u4E0D\u6324\u884C\uFF09\u3002\u914D\u7F6E\u53D8\u66F4\u5373\u65F6\u751F\u6548\uFF0C\u5DF2\u6253\u5F00\u7684\u7EC8\u7AEF\u81EA\u52A8\u66F4\u65B0").default(DEFAULT_LINE_HEIGHT).volatile(),
  terminalProfiles: z.string().description('\u7EC8\u7AEF\u914D\u7F6E\u8868\uFF08JSON \u6570\u7EC4\uFF09\u3002\u6BCF\u9879\u5F62\u5982 {"id":"t-pwsh-ab12","type":"pwsh","name":"PowerShell 7","path":"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe","origin":"auto"}\u3002type \u51B3\u5B9A spawn \u8BED\u4E49\uFF08pwsh/powershell/cmd/bash/zsh/fish/gitbash/nushell/custom\uFF09\uFF0Cname \u662F\u4E0B\u62C9\u83DC\u5355\u663E\u793A\u540D\uFF0Cpath \u7559\u7A7A\u5219\u6309 type \u5728 $PATH \u4E2D\u89E3\u6790\u3002\u7559\u7A7A\u6574\u8868\uFF08\u9ED8\u8BA4\uFF09\u8868\u793A\u7528\u542F\u52A8\u65F6\u63A2\u6D4B\u5230\u7684 $PATH \u7EC8\u7AEF\u3002\u81EA\u52A8\u63A2\u6D4B\u9879\uFF08origin=auto\uFF09\u4E0D\u53EF\u5220\u9664\u3001\u8DEF\u5F84\u4E0D\u53EF\u6539\uFF0C\u4F46\u53EF\u6539\u540D').default("").volatile()
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
    /** 终端字体族（空串 = 前端用内置默认字体栈） */
    get fontFamily() {
      const env = process.env[ENV_FONT_FAMILY];
      if (env !== void 0) return env;
      const value = config.fontFamily.get();
      return typeof value === "string" ? value : "";
    },
    /** 终端字号（像素）——env/配置都要求正有限数，非法值回落默认 */
    get fontSize() {
      const env = process.env[ENV_FONT_SIZE];
      if (env !== void 0) {
        const parsed = Number.parseFloat(env);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      const value = config.fontSize.get();
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_FONT_SIZE;
    },
    /** 终端行高倍数——env/配置都要求正有限数，非法值回落默认 */
    get lineHeight() {
      const env = process.env[ENV_LINE_HEIGHT];
      if (env !== void 0) {
        const parsed = Number.parseFloat(env);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
      const value = config.lineHeight.get();
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_LINE_HEIGHT;
    },
    /**
     * 终端配置表（已合并探测结果的完整列表）。
     *
     * 启动时由 prepareProfiles() 求值一次并缓存——探测涉及多次 where/which
     * 子进程调用，不适合每次 /config 请求都重跑。配置热更新时由
     * rebuildProfiles() 重建。
     */
    get profiles() {
      return cachedProfiles;
    }
  };
  function parseProfiles(raw) {
    if (typeof raw !== "string" || raw.length === 0) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function computeProfiles() {
    const envRaw = process.env[ENV_TERMINAL_PROFILES];
    if (typeof envRaw === "string" && envRaw.length > 0) {
      const fromEnv = parseProfiles(envRaw);
      if (fromEnv.length > 0) return fromEnv;
    }
    const saved = parseProfiles(config.terminalProfiles.get());
    const detected = detectTerminalProfiles();
    return mergeProfiles(saved, detected);
  }
  function prepareProfiles() {
    const saved = parseProfiles(config.terminalProfiles.get());
    const detected = detectTerminalProfiles();
    const merged = mergeProfiles(saved, detected);
    if (saved.length === 0 && merged.length > 0) {
      const payload = JSON.stringify(merged);
      ctx.inject(["settings"], (sctx) => {
        const settings = sctx.settings;
        if (typeof settings.update !== "function") return;
        void settings.update(PKG_NAME.replace(/^dsh-/, ""), { terminalProfiles: payload }).then(() => {
          log3.info(`\u7EC8\u7AEF\u914D\u7F6E\u8868\u5DF2\u521D\u59CB\u5316\uFF1A\u63A2\u6D4B\u5230 ${merged.length} \u4E2A\u7EC8\u7AEF`);
        }).catch((error) => {
          const msg = error instanceof Error ? error.message : String(error);
          log3.warn(`\u7EC8\u7AEF\u914D\u7F6E\u8868\u5199\u5165\u5931\u8D25\uFF0C\u4EC5\u672C\u6B21\u8FD0\u884C\u6709\u6548\uFF1A${msg}`);
        });
      });
    }
    return merged;
  }
  const cachedProfiles = prepareProfiles();
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
      options.profileId,
      cachedProfiles
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
      profiles: cachedProfiles,
      workspaceRegistry,
      createSession,
      killSession,
      restartSession,
      registerSessionWs,
      upgradeDisposers
    })
  });
  registerSettingsIntegration(ctx, Config, cachedProfiles);
  ctx.effect(() => {
    return () => {
      disposeRoute();
      for (const [, dispose] of upgradeDisposers) dispose();
      upgradeDisposers.clear();
      for (const id of [...sessions.keys()]) killSession(id);
    };
  }, PKG_NAME + ".routes");
  log3.info(`\u5BBF\u4E3B\u534A\u5DF2\u6FC0\u6D3B\uFF1B\u8DEF\u7531\u524D\u7F00 ${ROUTE_PREFIX}\uFF0CWS \u524D\u7F00 ${WS_PREFIX}\uFF0C\u5FEB\u6377\u952E ${runtimeSettings.toggleShortcut}\uFF0C\u7EC8\u7AEF\u914D\u7F6E ${cachedProfiles.length} \u9879`);
}
export {
  Config,
  apply,
  inject,
  name
};
