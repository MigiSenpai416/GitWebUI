# GitWebUI

A local, GitKraken-style desktop git client for browsing and committing to a
repository on your own machine. The app shells out to your installed `git`
binary and renders a dark, GitKraken-like interface.

It focuses on a **local** repo, and also supports GitHub remotes: connect with
GitHub OAuth or a Personal Access Token to push, pull, add remotes, and create
repositories.

It ships as a standalone desktop app for **Windows** (a portable `.exe`),
**Linux x64** (an `.AppImage`) and, best effort, **macOS** (a `.dmg`/`.zip`):
no install, no browser tab, no port. Native folder pickers and menus.

## Features

- Open a local repo by its absolute path (native to the host OS). Recent repos
  are remembered.
- GitKraken-style toolbar with a **branch switcher** (dropdown of local
  branches; pick one to check it out). Branch merges can use Git's default
  fast-forward behavior or explicitly create a merge commit. Undo/Redo are
  present as placeholders for future work.
- **Terminal** — a dock across the bottom for running commands in the repo,
  through your own shell: `$SHELL` (bash/zsh) on Linux, **Git Bash** on Windows
  with **PowerShell** as the alternative, picked from the dock's header. Output
  streams as it arrives with colours intact, `cd` carries from one command to
  the next, ↑/↓ walks your history, and a running command can be stopped. It is
  a command runner rather than a terminal session: there is no pseudo-terminal
  behind it (that would need a native addon rebuilt against Electron for every
  platform the app ships on), so full-screen programs like `vim` or `less` and
  interactive password prompts have nothing to talk to. Anything the terminal
  does to the repo is picked up by the rest of the UI when the command finishes.
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
  Google AI Studio API key and model slug, or an **OpenAI Chat Completions**
  compatible provider's base URL, API key, and model slug. Google is the default;
  existing Google settings continue to work. Each provider's settings are saved
  separately, so switching providers retains the other configuration.
  The AI buttons fill both fields from
  staged changes, or unstaged changes (including new files) when nothing is
  staged. Amend describes the complete replacement commit. Titles stay within
  72 characters; descriptions have no app-imposed length limit.
  Every AI request has a 16,384-token output budget, including chunk summaries
  and final merges. Truncated responses are rejected without replacing the draft.
  Generation sends all diff hunks with nearby context to the selected provider, plus new text
  files and change metadata; binary contents are not sent. Diffs over 8 MiB are
  rejected with an instruction to stage a smaller set, never silently truncated.
  This byte limit is not a token limit. If the provider explicitly rejects a
  request for exceeding its context window, generation automatically splits the
  changes at file/hunk boundaries, summarizes each portion, and merges all the
  summaries into one commit message. Oversized hunks and new files are split by
  line, or by Unicode-safe text fragments for very long lines, retaining file
  metadata and addition/deletion context. Fallback batches target at most
  128 KiB of input data and shrink further on context errors; this is a sizing
  heuristic, not a provider-specific token count. Oversized merges are reduced
  in multiple passes. This takes additional requests, time, and potentially cost,
  and summaries can lose nuance compared with one full-diff request.
  Only the final successful message fills the fields. Its success toast indicates
  whether generation used the full diff normally or chunked summaries. Other errors stop generation
  without applying partial summaries. Each request has a two-minute timeout;
  a generation is limited to 15 minutes, 256 requests, and 12 levels of splitting
  or reduction. If the model still cannot handle the input, stage fewer changes
  or use a larger-context model. Cancellation and stale-change checks still apply.
  The keys are stored in `ai-commit.json` in the config directory, in
  plaintext like the GitHub credential, and are never handed back to the UI.
  Use the setup dialog to change the model, replace the key, or clear the selected
  provider's settings. For Chat Completions, use an API base URL such as
  `https://api.openai.com/v1` or `http://localhost:1234/v1`; requests append
  `/chat/completions` and use bearer authentication, system/user messages, and
  strict JSON Schema structured output (`response_format.type: json_schema`).
  The provider and model must support this format; unsupported requests show
  an error without falling back to a weaker format. Changing the base URL
  requires re-entering its key; saved Google keys are never reused for it.
- **Pull requests** — open a GitHub PR from the branch menu: pick the source and
  target repo/branch (forks target their upstream by default), fill the title and
  description from a repo **PR template**, add reviewers, assignees and labels,
  and optionally **submit as draft**. Browse PRs in the left sidebar and open a
  detail modal to read changes, comment, review, edit, close/reopen, or merge.
- **GitHub remotes** — a **LOCAL / REMOTE** left sidebar (checkout branches;
  right-click a remote branch to check it out or **delete it on the remote**;
  hover **REMOTE** for a green + to add a remote). Connect with GitHub OAuth or
  a Personal Access Token to **push**, **pull**, add a remote by **URL**, or
  **create a new GitHub repository** and push to it. The credential is stored
  locally and can be changed or disconnected at any time.

## Requirements

- **`git` installed.** Everything in the app shells out to it. The app looks
  for it on your `PATH` and in the usual install locations, and offers to be
  pointed at it if it can't find one.
- **`git-filter-repo` for File Manager history deletion.** This optional feature
  also requires Python; all other GitWebUI features work without it.
- To build from source: Node.js 20+ (developed on 24) and npm 10+. The packaged
  app bundles its own runtime.

## Getting started (development)

```bash
npm install          # installs all three workspaces (core + web + desktop)

npm run dev          # Vite on :5173 + an Electron window with hot-reloading UI
```

`npm run dev` runs two things side by side, which can also be started on their
own: `npm run dev:web` (Vite, which only serves the UI and its hot reload to the
window) and `npm run dev:app` (builds the main process and preload in watch
mode, and restarts Electron whenever either changes). The UI only runs inside
the app window: it needs the preload bridge, so the Vite URL is no use in a
plain browser tab.

To run a production build without packaging it:

```bash
npm run build        # icons, web/dist → desktop/renderer, main + preload bundles
npm start            # launches Electron on the built output
```

In the window, open a repository by its absolute path, for example:

- Windows: `C:\Users\you\projects\my-repo`
- Linux: `/home/you/projects/my-repo`
- macOS: `/Users/you/projects/my-repo`

## The desktop app

### Windows

```bash
npm run dist:win     # → release/desktop/GitWebUI-0.3.0.exe
```

(`npm run dist` builds for whichever platform you're on.)

One standalone executable, about 90 MB. There is no installer: copy it wherever
you like and run it. Electron, the app's core and the built UI are all inside
it. The host needs `git`; File Manager history deletion additionally needs
`git-filter-repo` and Python.

Running it unpacks to `%LOCALAPPDATA%\Temp\GitWebUI`, so the first launch is a
little slower than the ones after it. Your settings do not live there — they go
to the config directory below and survive replacing the `.exe`.

It is unsigned, so SmartScreen shows "Windows protected your PC" the first
time; choose **More info → Run anyway**.

### Linux (x64)

The AppImage is built natively on Linux:

```bash
npm ci
npm run dist:linux   # → release/desktop/GitWebUI-0.3.0-linux-x86_64.AppImage
```

#### Building on Windows through WSL

WSL works, but not from the Windows checkout: `node_modules` holds
platform-specific Electron and esbuild binaries, so one installed on Windows
can't build for Linux (and a Linux install would break the Windows one). Build
from a Linux-side copy with Linux Node.js instead — a clone, if the changes are
committed:

```bash
git clone /mnt/c/Users/you/projects/GitWebUi ~/gitwebui-linux
```

or a copy of the working tree, leaving out everything platform-specific or
generated:

```bash
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude release \
  --exclude desktop/dist --exclude desktop/renderer --exclude desktop/build \
  --exclude web/dist \
  /mnt/c/Users/you/projects/GitWebUi/ ~/gitwebui-linux/
```

then, in WSL:

```bash
cd ~/gitwebui-linux
npm ci
npm run dist:linux
cp release/desktop/GitWebUI-*-linux-x86_64.AppImage /mnt/c/Users/you/Downloads/
```

#### Running the AppImage

The AppImage bundles Electron, the app's core and the built UI. The host needs
`git` and the desktop libraries Electron uses (GTK 3, NSS and ALSA), plus
FUSE 2 for mounting the AppImage. File Manager history deletion additionally
needs `git-filter-repo` and Python.

```bash
chmod +x GitWebUI-0.3.0-linux-x86_64.AppImage
./GitWebUI-0.3.0-linux-x86_64.AppImage
```

On a system without FUSE, extract it and run the included launcher:

```bash
./GitWebUI-0.3.0-linux-x86_64.AppImage --appimage-extract
./squashfs-root/AppRun
```

### macOS (best effort)

The macOS build is configured and packages cleanly, but this project is
developed on Windows and Linux and the app has **not been run on a Mac**.
Everything platform-specific is in place — the app menu with About and Quit,
the standard Window menu, Cmd shortcuts, staying open in the Dock with no
window and reopening one on activation, a dark title bar to match the UI, git
lookup through the Xcode Command Line Tools and Homebrew, zsh in the terminal —
but treat it as untested until someone reports back.

On a Mac:

```bash
npm ci
npm run dist:mac     # → release/desktop/GitWebUI-0.3.0-mac-{x64,arm64}.{dmg,zip}
```

Off a Mac the packaging can be exercised but not shipped: the `.dmg` needs
`hdiutil`, electron-builder refuses macOS targets on a Windows host, and the
`.zip` it makes on Linux flattens the symbolic links inside `Electron
Framework.framework` (the archiver there doesn't keep them), which breaks the
bundle and triples its size. What can be made on Linux — in WSL, after
`npm run build` — is the bare `.app`, which `tar` archives intact (naming a
target on the command line replaces the configured ones, so the architectures
have to be named again too):

```bash
cd desktop && npx electron-builder --config electron-builder.yml --mac dir --x64 --arm64 --publish never
cd ../release/desktop && tar -czf GitWebUI-0.3.0-mac-arm64.tar.gz -C mac-arm64 GitWebUI.app
```

The app is not signed or notarized, so Gatekeeper refuses it. Clear the
quarantine flag after copying it into place:

```bash
xattr -dr com.apple.quarantine /Applications/GitWebUI.app
```

(On macOS 15 and later the alternative is System Settings → Privacy &
Security → **Open Anyway** after the first refusal; right-click → Open no
longer gets an unnotarized app past Gatekeeper there.)

The host needs `git` — the Xcode Command Line Tools (`xcode-select --install`)
or Homebrew's — and, for File Manager history deletion, `git-filter-repo` and
Python.

### Where things are stored

- **Config directory** — `%APPDATA%\gitwebui` on Windows,
  `$XDG_CONFIG_HOME/gitwebui` or `~/.config/gitwebui` on Linux and macOS;
  override with `GITWEBUI_CONFIG_DIR`. Holds the GitHub credential (`github.json`, plus
  `github-refresh.json` while a token refresh is in flight), commit identity
  (`identity.json`), AI settings (`ai-commit.json`), recent repositories
  (`recent.json`), a located git (`git-path.json`) and the recovery bundles
  history deletion writes (`history-backups/`). It is the same directory
  earlier releases used, so all of that carries over.
- **Electron profile** — `%APPDATA%\gitwebui-desktop` on Windows,
  `$XDG_CONFIG_HOME/gitwebui-desktop` / `~/.config/gitwebui-desktop` on Linux,
  `~/Library/Application Support/gitwebui-desktop` on macOS; override with
  `GITWEBUI_USER_DATA_DIR`. Holds window state, caches, the UI's open tabs
  and layout, and `main.log` — a packaged Windows app has no console, so a
  window that won't start leaves its reason there.

**Upgrading from an earlier desktop release:** the UI now loads from the app's
own `gitwebui://app` origin instead of `http://127.0.0.1:5175`, and open tabs,
layout and per-repository view choices are stored per origin. They reset once
on the first launch; credentials, identity, AI settings and recent repositories
are unaffected.

### Pointing at a specific `git`

At startup the app looks for git on `PATH`, then in the usual install locations
(`C:\Program Files\Git\cmd`, `/usr/bin`, …). If it finds none, a dialog offers
**Locate git…** — the chosen file is checked by running it, then remembered in
`git-path.json` — or **Download Git**. Set `GITWEBUI_GIT_PATH` to an absolute
path to use that git ahead of everything else, as long as it runs.

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
`scoop install git-filter-repo`. The tool requires Git 2.36 or newer and Python
3.6 or newer. Its current rewrite engine supports SHA-1 repositories only;
GitWebUI rejects SHA-256 repositories before creating recovery artifacts. See the
[`git-filter-repo` installation guide](https://github.com/newren/git-filter-repo/blob/main/INSTALL.md)
for platform-specific help.

### GitHub & remotes (push / pull)

1. **Connect an account.** Toolbar → **Actions → Connect GitHub account…**, then
   choose one of these methods:
   - **GitHub OAuth** — GitWebUI shows a one-time code and provides a button to
     open GitHub in the browser. Authorize it there; the connection finishes
     automatically and the dialog shows the connected account. OAuth requests
     repository access, workflow access, and email read access for the Git
     commit identity. Accounts connected before workflow access was requested
     need a **Reconnect with GitHub** to push changes under `.github/workflows`.
   - **Personal Access Token** — paste a
     [Personal Access Token](https://github.com/settings/tokens) (classic `repo`
     and `workflow` scopes, or fine-grained with Contents and Workflows
     read/write). GitHub rejects pushes that add or change files under
     `.github/workflows` from a token without workflow access.

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

The created PR opens in your browser.

The sidebar's **Pull Requests** section lists PRs for a selected GitHub remote
or its fork parent. **Open** is the default; **Closed**, **Merged**, and **All
states** are also available. Expand **My Pull Requests** (authored by you),
**Assigned to Me**, **Review Requested** (requested directly from you), or
**All Pull Requests**. All four groups start collapsed, including when switching
repositories. A PR may appear in several groups. Team review requests
are visible in PR details. Search and group counts cover the loaded pages;
use **Load more pull requests** for older results and the refresh button to
check for updates. The + button opens the existing creation dialog.

Click a PR to open its detail modal, with Markdown description, people, labels,
**Conversation**, **Commits**, **Checks**, and **Files changed** tabs. Conversation
uses GitHub's timeline order for commits, references, status changes, comments,
and reviews, with code snippets and replies grouped under their review. Consecutive
commits are grouped and notification-only bookkeeping is hidden. The merge box
appears below the timeline. GitHub's public timeline does not expose every detail
of the website's presentation, such as exact push batches. Review-thread resolved,
outdated, and collapsed states are read through GitHub GraphQL; a status message
appears if that additional data cannot be loaded.
Submit a review through **Files changed → Review changes**, using Comment,
Approve, or Request changes; general PR comments stay in Conversation.
In **Files changed**, expand a file and use the **+** beside a diff line to
post an **Add single comment** immediately. Removed lines use the old side;
added and context lines use the new side. These comments appear as threads in
Conversation. Draft text survives tab switches and refreshes; reselect a line
after refreshing. New PR commits require a fresh diff before posting.
Each activity tab supports pagination. Missing check permissions and GitHub's
large-PR limits are shown explicitly, with GitHub links for full details.
Images open through a link, and code-comment threads can be read in the modal;
inline replies can be posted directly in their code-comment thread. Draft
readiness changes are available through **Open in GitHub**.

The modal supports posting comments and reviews, editing the title/description,
closing/reopening, and merging using the repository's enabled merge methods.
For squash merges and merge commits, enable **Customize commit message** to set
the commit title and description before confirming the merge. Leave it disabled
to use GitHub's defaults. Rebase preserves individual commit messages. Custom
message drafts survive failed merge attempts and method/tab changes while the
modal stays open.
Controls reflect your account's repository permissions; GitHub still enforces
token scopes, branch protection, and review rules. Merge and review submissions
include the inspected head commit. Failed submissions preserve your text.
Reviews, close/reopen, and merges require confirmation within the app.

Git commands, including those in the terminal panel, receive the connected account's
token through a temporary credential helper scoped to HTTPS `github.com`. This also
authenticates Git LFS downloads during checkout and missing objects in partial clones.
The token is passed through the child process environment, not command arguments or
repository configuration, and is not saved into the system credential manager.
Git Credential Manager interaction and Git's askpass prompts are disabled; missing or
rejected credentials fail instead of opening a sign-in window or switching to a
different cached GitHub account. Other hosts can still
use their existing cached credentials, and SSH remotes use the existing SSH setup.
**Forgot to revoke?**
Delete `github.json` in the config dir (or use **Disconnect**). Connecting an
account is optional; it is only needed for authenticated HTTPS actions.

#### GitHub OAuth

GitWebUI uses its official GitHub OAuth App with **Device Flow** enabled. Its
public Client ID is built into the source, so users can sign in without any
configuration. No client secret is used or shipped.

## Keyboard shortcuts (diff viewer)

- `Alt+↓` / `Alt+↑` — next / previous change (hunk)
- `Esc` — close the diff viewer
- `Ctrl/Cmd+Enter` in the commit box — commit

## Project layout

```
core/     the app's core: git, GitHub, AI commit info, terminal, config
  src/git/       gitRunner, gitPath, log, status, diff, blame, commitFiles, mutate
  src/api.ts     the table of operations the UI can call; dispatch() runs one
web/      React + Vite + TypeScript UI, run only inside the app window
  src/components/            UI (CommitList, ChangesPanel, DiffViewer, …)
  src/components/DiffViewer/ CodeMirror inline-diff rendering
  src/state/store.ts         Zustand app state
  src/desktop.ts             typed access to the preload bridge
desktop/  Electron app
  src/main/      lifecycle, gitwebui:// protocol, IPC, menu, git probe
  src/preload/   the contextBridge surface (sandboxed, CommonJS)
  tests/         Playwright end-to-end tests against a real window
scripts/  stage-renderer (web/dist → desktop/renderer), make-icons
```

`core/src/api.ts` is the seam the whole thing turns on: a transport-free table
of operations. The main process answers one IPC channel (`gwui:api`) by handing
each call to `dispatch()`, cancels through `gwui:cancel`, and streams terminal
output back over `gwui:terminal-event`. Nothing in `core/` imports `electron`.

## Tests

```bash
npm test             # Vitest: core (git parsers, operations, config) and the UI's state
npm run test:e2e     # builds, then Playwright: a real Electron window, end to end
```

The Playwright suite can also be pointed at a packaged build, which is the only
way to catch failures specific to being packaged — asar path resolution above all:

```bash
GITWEBUI_E2E_BINARY=../release/desktop/win-unpacked/GitWebUI.exe \
  npm run test --workspace desktop
# Linux, from the repository root:
GITWEBUI_E2E_BINARY="$PWD/release/desktop/GitWebUI-0.3.0-linux-x86_64.AppImage" \
  npm run test --workspace desktop -- smoke.spec.ts persistence.spec.ts
```

Each test launch gets a throwaway config directory and Electron profile
(`desktop/tests/helpers.ts`), so it never reads or overwrites the tabs and
settings of an installed copy — including one that is open at the time. The
same variables are useful on their own for running a second instance side by
side with your usual one, since the single-instance lock belongs to the profile:

| | |
|---|---|
| `GITWEBUI_CONFIG_DIR` | Where credentials, identity, AI settings and recent repositories live. |
| `GITWEBUI_USER_DATA_DIR` | Where Electron keeps its profile — window state, and the tabs the UI remembers. |
| `GITWEBUI_E2E` | Set to `1` by the tests to turn on the main process's test seams. Not for everyday use. |

## Security note

Nothing listens on a port. The UI is served from a private `gitwebui://app`
scheme straight out of the app bundle, with a Content Security Policy that
allows only the app's own scripts and no network connections from the page
(GitHub avatars are the one outside resource it loads). Everything else goes
through the main process over IPC.

The window's renderer runs **sandboxed**, with `contextIsolation` on and Node
integration off; the preload exposes a small, fixed bridge rather than
`ipcRenderer` itself. Each IPC handler validates what it is given — unknown
operations are refused, and URLs handed to the OS must be `http`, `https` or
`mailto`. Navigation is pinned to the app's own pages: links and `window.open`
open in your system browser instead of an app window, and `<webview>` is
refused.

All git invocations pass arguments as an argv array (`execFile`), never as a
shell string, so repository paths and filenames containing spaces or shell
metacharacters are handled safely. The terminal dock is the exception by
design: it runs what you type through your own shell.

Credentials (the GitHub token, AI keys) are stored in plaintext in the config
directory. On Linux the directory is created `0700` and the credential files
`0600`; on Windows they rely on the per-user `%APPDATA%` permissions.
