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
- `npm run icons` renders `build/icon.svg` (the logo) into `build/icon.png` and `build/icons/*.png`; rerun it after changing the logo and commit the PNGs.
- `npm start` passes `--no-sandbox`: on Ubuntu 24.04+ Electron's sandbox needs a setuid `chrome-sandbox` when run from source.

## Architecture

- `src/daemon` owns every terminal process and the only copy of the state; the UI sends actions and renders what the daemon broadcasts. Never make the UI the source of truth for anything that must survive a restart.
- The daemon runs as a detached `ELECTRON_RUN_AS_NODE` process and outlives the UI. A running daemon keeps its old code. Its hello carries a build id (a hash of the sources, `build.mjs`); when it differs from the UI's, the UI shows a banner offering to restart the daemon. Never restart it silently — that kills the users' processes.
- Protocol (`src/shared/protocol.ts`) is newline-delimited JSON over a Unix socket / named pipe. Bump `PROTOCOL_VERSION` on incompatible changes; a UI replaces a daemon with another version.
- State is saved atomically (`src/daemon/store.ts`): the workspace structure in one small `state.json` on every change, in the background (a blocking fsync stalls keystrokes); each terminal's scrollback in `scrollback/<id>.ansi`, one terminal per tick, less often for busy ones, and all on shutdown. Never put large data into `state.json`.
- `npm run test:perf` measures keystroke latency under heavy output and UI switching times; run it after changes to the daemon's hot paths or the renderer's render loop.
- Restore levels: live process (daemon survives) → agent resume via recipes (`recipes/*.json`, `src/daemon/recipes.ts`) → command restart or "Run again" (`src/daemon/restore.ts`). Agent support is added with recipes, not code.
- A vanished job or a shell killed by a signal is kept for a grace period, so processes killed by a system shutdown are still restored, while ones the user closed are not.
- Process inspection (`src/daemon/procinfo.ts`) reads `/proc` on Linux, uses `ps`/`lsof` on macOS and is unavailable on Windows.
- State files of older versions are migrated in `src/daemon/store.ts`; bump `AppState.version` and add a migration when the persisted shape changes.
- UI design system (`src/renderer/styles.css`): every color derives from the theme's background and foreground plus the brand amber; one bar height (`--bar`), row height (`--row`) and radius scale; icons only from `src/renderer/icons.ts`; menus and dialogs are drawn by the app (`menu.ts`, `dialog.ts`, `color-picker.ts`), never native, so they follow the theme.
- Commands and their default shortcuts live in `src/shared/commands.ts`; users override them in settings (`keybindings`). Defaults must not take keys that programs inside a terminal can receive: Ctrl+Shift combinations and Ctrl+Tab on Linux/Windows, Cmd on macOS.
- Settings (`src/shared/settings.ts`) are saved from the settings page and keep only values that differ from the defaults. Renderer code must not import modules that touch the file system; theme helpers live in `src/shared/themes.ts`.
