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

Set `PORT` to change the server port.

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
