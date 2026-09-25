# dsh-oh-my-terminal

[![version](https://img.shields.io/badge/version-0.2.1-blue)](package.json)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%5E20.19.0%20%7C%7C%20%3E%3D22.0.0-brightgreen)](package.json)

A bottom terminal panel plugin for DSH Web GUI. Powered by `@lydell/node-pty`, it provides multi-session interactive terminals over WebSocket using xterm.js in the browser. Supports Windows ConPTY and POSIX openpty with no local compilation required.

[中文文档](README.zh.md)

## Features

- **Multiple terminal sessions**: manage several sessions simultaneously; a side list replaces the traditional horizontal tab bar, with right-click rename support
- **Split terminals**: horizontal splits within the same group; a VSCode-style dropdown next to the `+` button (new / split / new by kind)
- **Session persistence**: sessions survive panel close/reopen and are automatically restored on startup
- **Configurable shortcut**: toggle the panel with a keyboard shortcut; on DSH 0.1.7-rc.2+ the plugin integrates with the host shortcut system and the panel label updates to reflect the current binding
- **Resizable panel**: drag the top edge of the panel to adjust its height
- **Cross-platform**: Windows ConPTY and POSIX openpty are selected automatically by `@lydell/node-pty`; pre-compiled binaries ship with the package, nothing to compile
- **Configurable shell**: set a custom shell command and arguments

## Installation

This package is not yet published to npm. Install directly from GitHub:

```bash
dsh plugin --profile web add github:btsd321/dsh-oh-my-terminal
```

## Configuration

| Option | Description | Default |
|---|---|---|
| `toggleShortcut` | Shortcut to toggle the terminal panel (legacy host only; see below) | `` Ctrl+` `` |
| `shellCommand` | Shell command for new terminals | System default (bash / PowerShell) |

## DSH 0.1.7-rc.2 shortcut changes

DSH 0.1.7-rc.2 introduced a host-level shortcut system. Its built-in terminal (`` Ctrl+` `` via `terminal.new`) conflicts with the previous default. To avoid double-triggering, this plugin changed its behavior starting with the rc.2-compatible release:

- **Integrated with shortcuts system**: the plugin registers the `terminal-panel.toggle` command with a default binding of `` Ctrl+Shift+` `` (no default on `web:linux`; bind it manually in DSH settings). Change the key in DSH Settings - Keyboard Shortcuts; the panel label updates automatically
- **Legacy host (0.1.7-rc.1 and earlier)**: falls back to a bare `` Ctrl+` `` listener; the `toggleShortcut` setting still applies
- **Migration note**: after upgrading the host, `` Ctrl+` `` opens the built-in terminal (side panel). Use `` Ctrl+Shift+` `` for this plugin's panel. To reclaim `` Ctrl+` `` for this plugin, first remove the built-in terminal's binding in DSH keyboard settings

## Development

```bash
# Install dependencies (@lydell/node-pty ships pre-compiled binaries — ready to use immediately)
pnpm install

# Type check
pnpm run typecheck

# Build (esbuild, two entry points, output to lib/)
pnpm run build

# Unit tests
pnpm exec tsx --test tests/unit/*.test.ts
```

> Use `pnpm`, not `npm`. Peer dependencies pin exact versions; npm's incremental resolution on an existing tree will produce ERESOLVE errors.

### About the build output

`lib/` is committed to version control. The DSH loader imports plugins as plain ESM; it does not run tsx. This repo also declares no lifecycle scripts (`prepare`, `postinstall`, etc.) because pnpm 11 rejects git-hosted packages that declare install-time scripts with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. Run `pnpm run build` manually and commit the output alongside source.

### Native dependency notes

Terminal capability comes from `@lydell/node-pty` (a pre-compiled distribution of microsoft/node-pty with the same API), pinned exactly to `1.1.0`. The `^` range is intentionally omitted: the package's `dist-tags.latest` points at the 1.2.0-beta series.

It is an N-API package. Binaries are split into six platform sub-packages and shipped inside the tarball; no download or compilation happens at install time. A single binary supports both Node 22 and Node 24. Its `package.json` has no `scripts` field at all, so pnpm 10, 11, and 12 never enter the build-authorization path, giving consistent behavior across versions.

The host side lazy-loads the package (`await import()` on first session creation). If the native binding fails to load, the error is contained to session creation; the plugin module itself remains importable and all other routes stay available.

## Architecture overview

```
src/
├── index.ts          # Host entry (Cordis plugin + settings + session lifecycle)
├── routes.ts         # HTTP route handlers
├── ws-handler.ts     # WebSocket handler (pty data forwarding)
├── client.tsx        # Browser entry (React components + plugin registration)
├── client/
│   ├── types.ts      # Shared types
│   ├── hooks.ts      # useReducer state management + custom hooks
│   ├── term-pane.tsx # xterm.js terminal pane component
│   ├── dropdown.tsx  # Dropdown menu next to the + button
│   ├── side-list.tsx # Right-side terminal list panel
│   ├── styles.ts     # CSS constants + Campbell dark theme
│   ├── icons.tsx     # SVG icon components
│   └── clipboard.ts  # Clipboard utility functions
├── persistence.ts    # Session persistence (log storage, metadata, startup restore)
├── platform.ts       # Platform adapter (POSIX / Windows + shell detection)
├── constants.ts      # Protocol, size, shortcut, and env var constants
├── server-command.ts # Command-line parsing utilities
├── shortcut.ts       # Shortcut parsing utilities
└── logger.ts         # Structured logger
```

The host side and browser side communicate over WebSocket at `/api/dsh-oh-my-terminal` and do not import each other directly.

## License

[Apache-2.0](LICENSE)
