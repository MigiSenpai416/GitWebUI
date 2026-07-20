# GitWebUI

A local, GitKraken-style web UI for browsing and committing to a git repository
on your own machine. The backend shells out to your installed `git` binary; the
frontend renders a dark, GitKraken-like interface in the browser.

Remote operations (set origin, push, pull) are intentionally **not** included —
this tool focuses on viewing history and staging/committing against a **local**
repo.

## Features

- Open a local repo by its absolute path (native to the host OS). Recent repos
  are remembered.
- GitKraken-style toolbar with a **branch switcher** (dropdown of local
  branches; pick one to check it out). Undo/Redo/Pull/Push/Stash/Pop/Terminal
  are present as placeholders for future work.
- Commit list with a `Branch / Tag · Graph · Commit Message` layout: ref badges,
  a single-lane graph column, and subject + body preview. Virtualized and
  paginated for large histories.
- Click a commit → metadata + changed-file list in the side panel.
- Click a file → full-file **inline diff** viewer (CodeMirror 6): the entire file
  with add/delete/context coloring, twin old/new line-number gutters, syntax
  highlighting, `File View` / `Diff View` toggle, and up/down hunk navigation.
- Full changes sidebar:
  - Red **discard-all** button (reset tracked files + delete untracked;
    click-twice to confirm).
  - **Path** / **Tree** layout toggle; the Tree view has expand/collapse folders
    and **Collapse All**.
  - Collapsible **Unstaged** / **Staged** sections, per-file stage/unstage,
    **Stage All** / **Unstage All**.
- Commit box: **Amend previous commit**, summary (with character budget) +
  description, one-click commit. AI-compose controls are placeholders.
- **Password-protected access** — the web UI is gated by a single password
  (set on first run), with an optional **Remember me** (stays signed in for 7
  days). Useful when running on a headless/remote host reachable over the network.

## Requirements

- Node.js 20+ (developed on 24) and npm 10+
- `git` on your `PATH`

## Getting started

```bash
npm install          # installs both workspaces (server + web)
npm run dev          # Express API on :5174, Vite dev server on :5173
```

Open http://localhost:5173 and enter the absolute path to a local git repository,
for example:

- Windows: `C:\Users\you\projects\my-repo`
- Linux/macOS: `/home/you/projects/my-repo`

### Production build

```bash
npm run build        # builds web/dist and server/dist
npm start            # serves the built UI + API on :5174
# then open http://localhost:5174
```

In production a single server hosts both the web UI and the API on one port.

### Choosing the port / host

The server port and bind address are resolved as **CLI flag > env var > default**:

```bash
node server/dist/index.js --port 8080          # or -p 8080
node server/dist/index.js --port 8080 --host 127.0.0.1
PORT=8080 node server/dist/index.js            # env var
node server/dist/index.js --help               # usage
```

Defaults are port `5174` and host `0.0.0.0` (all interfaces, so a remote machine
can reach it). The same flags work on the standalone binaries below.

### First run & authentication

On the first visit you'll be asked to **set a password**; every later visit asks
for it. Tick **Remember me** to stay signed in for 7 days (the session survives a
server restart). The **lock** button in the toolbar signs you out.

The password hash and session-signing secret are stored under the OS config dir
(`%APPDATA%\gitwebui` on Windows, `$XDG_CONFIG_HOME/gitwebui` or `~/.config/gitwebui`
elsewhere; override with `GITWEBUI_CONFIG_DIR`). **Forgot the password?** Delete
`auth.json` in that directory to reset to first-run setup.

### Standalone binaries

Build self-contained executables that run without Node installed on the target
(the machine still needs `git`). Requires **[Bun](https://bun.sh)** on the build
machine; it cross-compiles both targets from either OS:

```bash
npm run build:exe            # builds the web UI, embeds it, emits both binaries
# or individually:
npm run build:exe:win        # → release/gitwebui.exe   (Windows x64)
npm run build:exe:linux      # → release/gitwebui       (Linux x64)
```

The web UI is embedded inside the binary, so a single file is all you need to
deploy. Run it and pass `--port`/`--host` as above, e.g. on a Linux server:

```bash
./gitwebui --port 8080
```

## Keyboard shortcuts (diff viewer)

- `Alt+↓` / `Alt+↑` — next / previous change (hunk)
- `Esc` — close the diff viewer
- `Ctrl/Cmd+Enter` in the commit box — commit

## Project layout

```
server/  Express API that spawns git (never via a shell)
  src/git/       gitRunner, log, status, diff, commitFiles, mutate parsers
  src/routes.ts  REST endpoints
web/     React + Vite + TypeScript SPA
  src/components/           UI (CommitList, ChangesPanel, DiffViewer, …)
  src/components/DiffViewer/ CodeMirror inline-diff rendering
  src/state/store.ts        Zustand app state
```

## Tests

```bash
npm test             # Vitest unit tests for the git output parsers
```

## Security note

All git invocations pass arguments as an argv array (`execFile`), never as a
shell string, so repository paths and filenames containing spaces or shell
metacharacters are handled safely.

The password and session cookie travel over **plain HTTP**. On a trusted LAN or
over an SSH tunnel that's fine, but **do not expose the raw port directly to the
internet** — put it behind a TLS-terminating reverse proxy (Caddy, nginx,
Traefik) or reach it through an SSH/WireGuard tunnel so credentials aren't sent
in the clear.
