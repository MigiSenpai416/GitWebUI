# GitWebUI

An interactive desktop git client. It runs as a standalone Electron app on
Windows and Linux (macOS is built but untested), shells out to your installed
`git`, and supports GitHub remotes through OAuth or a personal access token:
push, pull, pull requests, and AI-generated commit messages.

Requires `git` on the machine. File Manager history deletion additionally
needs `git-filter-repo`. Building needs Node.js 20+ and npm.

## Building

```bash
npm install
```

### Windows

```bash
npm run dist:win     # → release/desktop/GitWebUI-<version>.exe (portable, no installer)
```

Unsigned: SmartScreen asks once; choose **More info → Run anyway**.

### Linux (x64)

Built natively on Linux, or on Windows through WSL from a Linux-side copy of
the repository (a `node_modules` installed on Windows can't build for Linux):

```bash
npm ci
npm run dist:linux   # → release/desktop/GitWebUI-<version>-linux-x86_64.AppImage
```

The AppImage needs FUSE 2; without it, run
`./GitWebUI-*.AppImage --appimage-extract && ./squashfs-root/AppRun`.

### macOS

Built on a Mac. Configured and packaging verified, but not yet run on one.

```bash
npm ci
npm run dist:mac     # → release/desktop/GitWebUI-<version>-mac-{x64,arm64}.{dmg,zip}
```

Unsigned, so clear the quarantine flag after installing:
`xattr -dr com.apple.quarantine /Applications/GitWebUI.app`.

## Development

```bash
npm run dev          # Vite with hot reload + an Electron window
npm test             # unit tests (core + web)
npm run test:e2e     # builds, then runs the Playwright suite against the app
```
