# GitWebUI

A local, GitKraken-style git client for browsing and committing to a repository
on your own machine. The backend shells out to your installed `git` binary; the
frontend renders a dark, GitKraken-like interface.

It focuses on a **local** repo, and also supports GitHub remotes: connect with
GitHub OAuth or a Personal Access Token to push, pull, add remotes, and create
repositories.

It runs two ways, from one codebase:

| | Platforms | |
|---|---|---|
| **Desktop app** | Windows | A single standalone `.exe`. No install, no ports, no browser tab, no password. Native folder pickers and menus. |
| **Server** | Windows, Linux, macOS | The original mode. Run it on a machine, reach it from a browser anywhere on your network, gated by a password. |

The desktop app is the Express API and the web UI in a single process: the API
listens on a random loopback port and the window is pointed at it, so both modes
run exactly the same server code.

The desktop build is Windows-only on purpose. Electron can target macOS and
Linux, but their installers can only be built — and only meaningfully tested —
on those platforms, and this is developed on Windows. The server mode covers
them instead, and nothing in `server/` or `web/` is Windows-specific.

## Features

- Open a local repo by its absolute path (native to the host OS). Recent repos
  are remembered.
- GitKraken-style toolbar with a **branch switcher** (dropdown of local
  branches; pick one to check it out). Branch merges can use Git's default
  fast-forward behavior or explicitly create a merge commit. Undo/Redo are
  present as placeholders for future work.
- **Terminal** — a dock across the bottom for running commands in the repo,
  through your own shell: `$SHELL` (bash/zsh) on Linux and macOS, **Git Bash**
  on Windows with **PowerShell** as the alternative, picked from the dock's
  header. Output streams as it arrives with colours intact, `cd` carries from
  one command to the next, ↑/↓ walks your history, and a running command can be
  stopped. It is a command runner rather than a terminal session: there is no
  pseudo-terminal behind it (that would need a native addon, which can't be
  cross-compiled into the single-file binaries), so full-screen programs like
  `vim` or `less` and interactive password prompts have nothing to talk to.
  Anything the terminal does to the repo is picked up by the rest of the UI when
  the command finishes. Note that it runs commands on the host with the same
  session password as everything else — worth remembering if you expose the
  server beyond localhost.
- Commit list with a `Branch / Tag · Graph · Commit Message` layout: ref badges,
  subject + body preview, and a lightweight single-lane graph by default. Toggle
  **Graph · Linear** to opt into a full parent-aware graph with separate lanes
  for forks and merges. The choice is remembered per repository; both views are
  virtualized and paginated for large histories.
- Click a commit → metadata + changed-file list in the side panel.
- Click a file → full-file **inline diff** viewer (CodeMirror 6): the entire file
  with add/delete/context coloring, twin old/new line-number gutters, syntax
  highlighting, `File View` / `Diff View` toggle, and up/down hunk navigation.
- **Git blame** — choose any tracked file from a searchable tree and see each
  line grouped by its originating commit, author, and age. Select a line for
  the full commit ID, message, timestamp, original path/line through renames,
  and a plain-language explanation. Working-tree edits are clearly marked as
  uncommitted instead of being attributed to the previous author.
- **File history** — select a file to follow every change through renames in a
  newest-first timeline. Each entry includes its author, date, commit, file
  diff, complete revision, and historical blame. Exact-text search finds the
  commits where remembered code was added or removed, even after it disappears.
- Full changes sidebar:
  - Red **discard-all** button (reset tracked files + delete untracked;
    click-twice to confirm).
  - **Path** / **Tree** layout toggle; the Tree view has expand/collapse folders
    and **Collapse All**.
  - Collapsible **Unstaged** / **Staged** sections, per-file stage/unstage,
    **Stage All** / **Unstage All**.
- Commit box: **Amend previous commit**, summary (with character budget) +
  description, one-click commit. **Actions → Set Up AI Commit Info** saves a
  Google AI Studio API key and model slug. The AI buttons fill both fields from
  staged changes, or unstaged changes (including new files) when nothing is
  staged. Amend describes the complete replacement commit. Titles stay within
  72 characters; descriptions have no app-imposed length limit.
  Generation sends all diff hunks with nearby context to Google, plus new text
  files and change metadata; binary contents are not sent. Diffs over 8 MiB are
  rejected with an instruction to stage a smaller set, never silently truncated.
  The key is stored in `ai-commit.json` in the host's config directory, in
  plaintext like the GitHub credential, and is never returned to the browser.
  Use the setup dialog to change the model, replace the key, or clear both.
- **Password-protected access** — the web UI is gated by a single password
  (set on first run), with an optional **Remember me** (stays signed in for 7
  days). Useful when running on a headless/remote host reachable over the network.
  Signing out (**Lock**) retires that session for good, so a cookie captured
  beforehand stops working rather than lasting until it expires. Eight wrong
  passwords from one address pauses sign-in from it for five minutes. Note that
  the server binds `0.0.0.0` by default and anyone who reaches it before you set
  the password can set it themselves — on a shared network, configure it
  immediately, or start it on `--host 127.0.0.1` until you have.
- **Pull requests** — open a GitHub PR from the branch menu: pick the source and
  target repo/branch (forks target their upstream by default), fill the title and
  description from a repo **PR template**, add reviewers, assignees and labels,
  and optionally **submit as draft**.
- **GitHub remotes** — a **LOCAL / REMOTE** left sidebar (checkout branches;
  right-click a remote branch to check it out or **delete it on the remote**;
  hover **REMOTE** for a green + to add a remote). Connect with GitHub OAuth or
  a Personal Access Token to **push**, **pull**, add a remote by **URL**, or
  **create a new GitHub repository** and push to it. The credential is stored on
  the host and can be changed or disconnected at any time.

## Requirements

- **`git` installed.** Everything in the app shells out to it. The desktop app
  looks for it on your `PATH` and in the usual install locations, and offers to
  be pointed at it if it can't find one.
- **`git-filter-repo` for File Manager history deletion.** This optional feature
  also requires Python; all other GitWebUI features work without it.
- To build from source: Node.js 20+ (developed on 24) and npm 10+. The desktop
  app itself bundles its own Node.

## Getting started (development)

```bash
npm install          # installs all three workspaces (server + web + desktop)

npm run dev          # browser mode: Express API on :5174, Vite on :5173
npm run dev:desktop  # desktop mode: Electron window with hot-reloading UI
```

Open http://localhost:5173 and enter the absolute path to a local git repository,
for example:

- Windows: `C:\Users\you\projects\my-repo`
- Linux/macOS: `/home/you/projects/my-repo`

## The desktop app (Windows)

```bash
npm run icons        # draws the app icon from the brand mark (once)
npm run dist         # → release/desktop/GitWebUI-0.1.0.exe
```

One standalone executable, about 90 MB. There is no installer: copy it wherever
you like and run it. Electron, the Express server and the built UI are all
inside it. The host needs `git`; File Manager history deletion additionally
needs `git-filter-repo` and Python.

Running it unpacks to `%LOCALAPPDATA%\Temp\GitWebUI`, so the first launch is a
little slower than the ones after it. Your settings do not live there — they go
to the config directory below and survive replacing the `.exe`.

It is unsigned, so SmartScreen shows "Windows protected your PC" the first
time; choose **More info → Run anyway**.

### How it differs from the server

- **No password.** The window is let in by a one-off token the app mints at
  launch and plants as a cookie in its own session. That token also switches the
  server into a private mode where signing in and setting a password are refused
  outright — so a browser that finds the port can't claim an install whose owner
  never set one.
- **Bound to `127.0.0.1:5175`**, with a `Host` allowlist so a rebound DNS name
  can't reach it. The port is fixed rather than random because the browser files
  your open tabs — and the sidebar, visible refs and terminal height — under the
  page's origin, and the port is part of that origin: a different port each
  launch would mean the app forgot everything each launch. If something else
  already has 5175 the app still starts on whatever port is free, and says so in
  its log; the remembered state reappears once 5175 is free again. A predictable
  port costs nothing here, since anything on your machine can scan the loopback
  range in milliseconds — the session cookie is what keeps others out.
- **Shares its configuration with the server.** The password, GitHub credentials,
  commit identity and recent repositories live in the same place either way, so
  switching between the two just works. Electron's own state (window size,
  caches, open tabs) is kept separately in `gitwebui-desktop`.
- Native folder pickers, an application menu with accelerators, remembered
  window geometry, and external links opening in your real browser.

A window that won't start has nothing to print to — a packaged Windows app has
no console — so the main process logs to `main.log` under
`%APPDATA%\gitwebui-desktop`.

## Running it as a server

Works on Windows, Linux and macOS.

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
can reach it). The same flags work on the standalone binaries below. If the port
is already taken the server says so and exits rather than lingering with nothing
listening.

Requests carrying an `Origin` from a different host are refused, so a page on the
web can't make your browser act against a server on your own network. Requests
without an `Origin` — curl, scripts, the UI itself — are unaffected.

If you know every name your server is reached by, list them in
`GITWEBUI_ALLOWED_HOSTS` (comma-separated) and anything else is refused. That
shuts out DNS rebinding, where an attacker's domain re-resolves to your address
to become "same origin"; it is off by default because a LAN or reverse-proxy
deployment can't know its own names in advance.

```bash
GITWEBUI_ALLOWED_HOSTS=git.example.com,127.0.0.1 node server/dist/index.js
```

### Pointing at a specific `git`

By default the server runs whatever `git` is on its `PATH`. Set
`GITWEBUI_GIT_PATH` to an absolute path when that isn't the right one — a
service started with a minimal environment, or several git installations on one
machine.

### Deleting files from Git history

The File Manager's history-deletion action requires
[`git-filter-repo`](https://github.com/newren/git-filter-repo). The rest of
GitWebUI does not require it. Install the tool, restart GitWebUI, and confirm
that it is available in the app's environment:

```bash
git filter-repo --version
```

The recommended cross-platform installation is `pipx install git-filter-repo`;
`uv tool install git-filter-repo` is also supported. Windows users can use
`scoop install git-filter-repo`, and macOS users can use
`brew install git-filter-repo`. The tool requires Git 2.36 or newer and Python
3.6 or newer. Its current rewrite engine supports SHA-1 repositories only;
GitWebUI rejects SHA-256 repositories before creating recovery artifacts. See the
[`git-filter-repo` installation guide](https://github.com/newren/git-filter-repo/blob/main/INSTALL.md)
for platform-specific help.

### First run & authentication

On the first visit you'll be asked to **set a password**; every later visit asks
for it. Tick **Remember me** to stay signed in for 7 days (the session survives a
server restart). The **lock** button in the toolbar signs you out.

The password hash and session-signing secret are stored under the OS config dir
(`%APPDATA%\gitwebui` on Windows, `$XDG_CONFIG_HOME/gitwebui` or `~/.config/gitwebui`
elsewhere; override with `GITWEBUI_CONFIG_DIR`). **Forgot the password?** Delete
`auth.json` in that directory to reset to first-run setup.

### GitHub & remotes (push / pull)

1. **Connect an account.** Toolbar → **Actions → Connect GitHub account…**, then
   choose one of these methods:
   - **GitHub OAuth** — GitWebUI shows a one-time code and provides a button to
     open GitHub in the browser. Authorize it there; the connection finishes
     automatically and the dialog shows the connected account. OAuth requests
     repository access plus email read access for the Git commit identity.
   - **Personal Access Token** — paste a
     [Personal Access Token](https://github.com/settings/tokens) (classic `repo`
     scope, or fine-grained with Contents read/write).

   The credential is validated against GitHub and stored in `github.json` in
   the config dir. Use the same dialog to change methods or **Disconnect**.
2. **Add a remote.** In the left sidebar, hover **REMOTE** and click the green **+**:
   - **URL** tab — paste an existing remote URL (name defaults to `origin`).
   - **GitHub** tab — pick the connected account, name the repo, choose
     Public/Private, and **create the repository on GitHub and push local refs**.
3. **Push / Pull** from the toolbar. HTTPS GitHub remotes authenticate with the
   stored token; SSH remotes use your SSH keys as usual.

### Pull requests

Open one from the branch dropdown → **…** next to a branch → **Create pull
request…**, or from **Actions → Create pull request…** for the checked-out
branch. The dialog reads the repo's GitHub remotes, so:

- **Forks** target their upstream by default (the PR is sent as `owner:branch`);
  pick any other GitHub remote — or the fork itself — as the target.
- **Templates** are picked up from `.github/`, the repo root, and `docs/` —
  both `pull_request_template.md` and a `PULL_REQUEST_TEMPLATE/` directory of
  named templates. Choosing one fills the description (your own text is never
  overwritten).
- **Reviewers, assignees and labels** are listed from the target repository; they
  need a token with push access there, and are attached after the PR is created,
  so a rejected reviewer never loses the pull request.
- If the source branch has commits that aren't on the remote, GitWebUI offers to
  **push it first**.

The created PR opens in a new browser tab.

The connected access token is injected per-command via an HTTP auth header, and any system
credential manager is bypassed so operations never block on a GUI prompt — a
missing/invalid token fails fast with a clear message. **Forgot to revoke?**
Delete `github.json` in the config dir (or use **Disconnect**). Connecting an
account is optional; it is only needed for authenticated HTTPS actions.

#### GitHub OAuth

GitWebUI uses its official GitHub OAuth App with **Device Flow** enabled. Its
public Client ID is built into the source, so users can sign in without any
configuration. No client secret is used or shipped.

### Standalone binaries

Build self-contained executables that run without Node installed on the target
(the machine still needs `git`, plus `git-filter-repo` and Python for history
deletion). Requires **[Bun](https://bun.sh)** on the build machine; it
cross-compiles both targets from either OS:

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
server/   Express API that spawns git (never via a shell)
  src/git/       gitRunner, gitPath, log, status, diff, blame, commitFiles, mutate
  src/app.ts     createApp() — the factory all three entry points share
  src/routes.ts  REST endpoints
  src/index.ts   Node entry (serves web/dist from disk)
  src/bunEntry.ts  Bun single-file-binary entry (serves embedded assets)
web/      React + Vite + TypeScript SPA
  src/components/            UI (CommitList, ChangesPanel, DiffViewer, …)
  src/components/DiffViewer/ CodeMirror inline-diff rendering
  src/state/store.ts         Zustand app state
  src/desktop.ts             the Electron bridge, absent in a browser
desktop/  Electron app — the third caller of createApp()
  src/main/      lifecycle, the loopback server, menu, IPC, git probe
  src/preload/   the contextBridge surface (sandboxed, CommonJS)
  tests/         Playwright end-to-end tests against a real window
scripts/  embed-web (Bun assets), stage-renderer, make-icons
```

`server/src/app.ts` is the seam the whole thing turns on: one Express factory,
three callers — Node from disk, Bun from embedded assets, Electron from memory.
Nothing in `server/` imports `electron`, which is what keeps the headless and
single-binary modes intact.

## Tests

```bash
npm test             # Vitest: git output parsers, auth, config, origin guard
npm run test:desktop # Playwright: a real Electron window, end to end
```

The Playwright suite can also be pointed at a packaged build, which is the only
way to catch failures specific to being packaged — asar path resolution above all:

```bash
GITWEBUI_E2E_BINARY=release/desktop/win-unpacked/GitWebUI.exe \
  npm run test --workspace desktop
```

The desktop tests run on their own port and their own Electron profile
(`desktop/tests/helpers.ts`), so they never read or overwrite the tabs and
settings of an installed copy — including one that is open at the time. Two
environment variables make that possible, and are useful on their own for
running a second instance side by side with your usual one:

| | |
|---|---|
| `GITWEBUI_DESKTOP_PORT` | Port to serve the window from, instead of 5175. |
| `GITWEBUI_USER_DATA_DIR` | Where Electron keeps its profile — window state, and the tabs the UI remembers. |

## Security note

All git invocations pass arguments as an argv array (`execFile`), never as a
shell string, so repository paths and filenames containing spaces or shell
metacharacters are handled safely.

The password and session cookie travel over **plain HTTP**. On a trusted LAN or
over an SSH tunnel that's fine, but **do not expose the raw port directly to the
internet** — put it behind a TLS-terminating reverse proxy (Caddy, nginx,
Traefik) or reach it through an SSH/WireGuard tunnel so credentials aren't sent
in the clear.
