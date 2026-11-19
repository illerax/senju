# CLAUDE.md

## Project

Senju is a cross-platform terminal (Electron + TypeScript + xterm.js + node-pty) for working with multiple projects and AI agents. Linux is the primary platform; macOS and Windows must keep working. The README describes the behavior users rely on — keep it in sync with changes.

Model (`src/shared/types.ts`): a **group** (one per project) holds **workspaces**; a workspace is a split layout of **panes**; each pane holds **tabs**, and each tab is one **terminal** (a shell with its own process). Use these terms consistently in code and docs.

## Language

Everything in this repository must be in English: code, comments, identifiers, docs, commit messages, PR descriptions, and issues.

## Commands

- `npm run build` — bundle with esbuild into `dist/` (`build.mjs`).
- `npm run typecheck`, `npm test` (vitest, pure modules only).
- `npm run test:daemon` — end-to-end daemon test in a throwaway `SENJU_HOME`; run it after touching `src/daemon`.
- `npm run test:ui` — drives the app with Playwright and saves screenshots; run it after touching `src/renderer` or `src/main`, and look at the screenshots.
- `npm run test:perf` — keystroke latency under heavy output, UI switching times, and a load of agents (`scripts/agents-perf.mjs` with `scripts/fake-agent.mjs`, an Ink-like UI); run it after changes to the daemon's hot paths or the renderer's render loop. `diagnostics.log` (`src/shared/diagnostics.ts`, `src/renderer/perf-monitor.ts`) records the system at each start, slow moments in the daemon, main process and window with what preceded them, and their errors; ask users for it when they report hangs or errors.
- `npm run test:network` — keystroke latency while a terminal's folder is on a network share that turns slow or unreachable (`scripts/flakyfs.py`, a FUSE file system), and update checks and downloads against a server that hangs, drops or goes silent; run it after touching the updater or file system calls in the daemon. The daemon must never call the file system synchronously on a terminal's folder: a dead share would freeze every terminal.
- `npm run screenshots` — regenerates `docs/screenshots/` in a demo HOME (`/tmp/senju-demo`); never commit screenshots showing real user names or paths (the repo is public).
- `npm run icons` renders `build/icon.svg` (the logo) into `build/icon.png` and `build/icons/*.png`; rerun it after changing the logo and commit the PNGs.
- `npm start` passes `--no-sandbox`: on Ubuntu 24.04+ Electron's sandbox needs a setuid `chrome-sandbox` when run from source.
- npm 11 blocks install scripts: a new native dependency needs `npm install-scripts approve <pkg>` (recorded in `allowScripts`).

## Pull requests and releases

- PRs are squash-merged; the PR title is the commit and must be a Conventional Commit (CI checks it). release-please derives versions and the changelog from it.
- Pick the type by what users notice after updating (full table in README, "Releases and versioning"): `feat` new behavior; `fix`/`perf` corrections; `feat!` or a `BREAKING CHANGE:` paragraph when stored state, settings, recipes or default shortcuts stop working as before without a migration; `docs`/`test`/`ci`/`refactor`/`chore` ship nothing.
- A new release stays a pre-release until every installer job has attached its files (`publish` in `release.yml`): apps and `install.sh` read the latest release, which excludes pre-releases. If an installer job fails, rerun it; the release becomes the latest after that.
- `install.sh` (the README's install command) downloads release assets by name: keep it in sync with `artifactName` and the build targets in `package.json`.
- A `PROTOCOL_VERSION` bump forces a daemon restart on update: at least `feat`, and say so in the PR description.

## Testing gotchas

- Always launch test instances with `SENJU_HOME=<tmp>` (and `XDG_RUNTIME_DIR`): it isolates state, socket, Electron profile and the single-instance lock, so tests run while the user's Senju is open.
- Playwright's `app.close()` hangs because the daemon outlives the UI; end a test with `window.senju.stopAll()` and wait for the process `exit` event.
- Stray test daemons: find them by `SENJU_HOME` in `/proc/<pid>/environ`; never `pkill -f` a pattern, it can match the calling shell.
- Fake agents in tests: run them by absolute path with a user recipe override; a bare `claude` starts the real one from the user's PATH.

## Architecture

- `src/daemon` owns every terminal process and the only copy of the state; the UI sends actions and renders what the daemon broadcasts. Never make the UI the source of truth for anything that must survive a restart.
- The daemon runs as a detached `ELECTRON_RUN_AS_NODE` process and outlives the UI. A running daemon keeps its old code. Its hello carries a build id (a hash of the sources, `build.mjs`); when it differs from the UI's, the UI shows a banner offering to restart the daemon. Never restart it silently — that kills the users' processes.
- Updates (`src/main/updater.ts`, GitHub releases) download and install only after the user agrees, and must never stop the daemon. Linux and Windows use electron-updater; release assets must include `latest-linux.yml` and `latest.yml`. macOS is unsigned, which Squirrel.Mac refuses, so `src/main/mac-update.ts` reads the latest release from the GitHub API (there is no `latest-mac.yml`), downloads the dmg named by `artifactName`, stages the app next to the installed one and swaps them by renaming. On Windows, macOS and AppImage the daemon runs from a per-version copy of the app (`src/main/daemon-runtime.ts`), started from the home folder with AppImage variables and the paths of every AppImage mount stripped (`src/shared/env.ts`; an updated AppImage is started by the old one and inherits its mount), which the daemon also strips from each terminal's environment; the daemon closes inherited fds into AppImage mounts at start.
- `scripts/update-e2e.mjs` tests a real AppImage self-update against a local server (`SENJU_UPDATE_URL`); run it after touching the updater or how the daemon is started. `scripts/update-e2e-mac.mjs` does the same for macOS and runs in CI on the macOS runner. Chromium overwrites `/proc/<pid>/environ` of Electron processes, so find app processes through the AppImage runtime process.
- Protocol (`src/shared/protocol.ts`) is newline-delimited JSON over a Unix socket / named pipe. Bump `PROTOCOL_VERSION` on incompatible changes; a UI replaces a daemon with another version.
- State is saved atomically (`src/daemon/store.ts`): the workspace structure in one small `state.json` on every change, in the background (a blocking fsync stalls keystrokes); each terminal's scrollback in `scrollback/<id>.ansi`, one terminal per tick, less often for busy ones, and all on shutdown. Never put large data into `state.json`.
- Restore levels: live process (daemon survives) → agent resume via recipes (`recipes/*.json`, `src/daemon/recipes.ts`) → command restart or "Run again" (`src/daemon/restore.ts`). Agent support is added with recipes, not code.
- A vanished job or a shell killed by a signal is kept for a grace period, so processes killed by a system shutdown are still restored, while ones the user closed are not.
- Process inspection (`src/daemon/procinfo.ts`) reads `/proc` on Linux, uses `ps`/`lsof` on macOS and is unavailable on Windows.
- State files of older versions are migrated in `src/daemon/store.ts`; bump `AppState.version` and add a migration when the persisted shape changes.
- UI design system (`src/renderer/styles.css`): every color derives from the theme's background and foreground plus the brand amber; one bar height (`--bar`), row height (`--row`) and radius scale; icons only from `src/renderer/icons.ts`; menus and dialogs are drawn by the app (`menu.ts`, `dialog.ts`, `color-picker.ts`), never native, so they follow the theme.
- Commands and their default shortcuts live in `src/shared/commands.ts`; users override them in settings (`keybindings`). Defaults must not take keys that programs inside a terminal can receive: Ctrl+Shift combinations and Ctrl+Tab on Linux/Windows, Cmd on macOS.
- Settings (`src/shared/settings.ts`) are saved from the settings page and keep only values that differ from the defaults. Renderer code must not import modules that touch the file system; theme helpers live in `src/shared/themes.ts`.
- The renderer re-renders on every state broadcast; keep DOM elements per id and update them in place (`placeChildren`), or double clicks, focus and inline renames break.
- The renderer is offline under a strict CSP: fonts are bundled (`@fontsource`, esbuild file loader), nothing loads from the network.
