#!/bin/sh
# Installs or updates Senju from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/illerax/senju/main/install.sh | sh
#
# Linux: the AppImage goes to ~/.local/bin/senju, with a menu entry and icons
# in ~/.local/share. macOS: Senju.app goes to /Applications (or ~/Applications
# when /Applications is not writable). No root access is needed.
#
# Options (after `sh -s --` when piped):
#   --version <x.y.z>  install this version instead of the latest one
#   --uninstall        remove the app; settings, state and scrollback are kept
#
# Settings and terminals live outside the app, so reinstalling or updating
# never touches them, and running terminals keep running.

set -eu

REPO="illerax/senju"
VERSION="${SENJU_VERSION:-}"
ACTION=install

say() { printf '%s\n' "$*"; }
fail() { printf 'senju-install: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [--version <x.y.z>] [--uninstall]

Installs or updates Senju from the latest GitHub release.
  --version <x.y.z>  install this version instead of the latest one
  --uninstall        remove the app; settings, state and scrollback are kept
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a value"; VERSION="$2"; shift 2 ;;
    --version=*) VERSION="${1#--version=}"; shift ;;
    --uninstall) ACTION=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done
VERSION="${VERSION#v}"

# fetch <url> <file>, or to stdout without a file.
if command -v curl >/dev/null 2>&1; then
  fetch() { if [ $# -ge 2 ]; then curl -fL --progress-bar -o "$2" "$1"; else curl -fsSL "$1"; fi; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { if [ $# -ge 2 ]; then wget -q --show-progress -O "$2" "$1"; else wget -qO- "$1"; fi; }
else
  fail "curl or wget is required"
fi

latest_version() {
  fetch "https://api.github.com/repos/$REPO/releases/latest" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1
}

asset_url() {
  printf 'https://github.com/%s/releases/download/v%s/%s' "$REPO" "$VERSION" "$1"
}

TMP=""
cleanup() {
  if [ -n "$TMP" ]; then
    [ -d "$TMP/mnt" ] && hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT INT TERM

# --- Linux -----------------------------------------------------------------

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN="$HOME/.local/bin/senju"
DESKTOP="$DATA_HOME/applications/senju.desktop"
ICON_SIZES="16 24 32 48 64 128 256 512"

refresh_menu() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA_HOME/applications" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$DATA_HOME/icons/hicolor" 2>/dev/null || true
}

install_linux() {
  case "$(uname -m)" in
    x86_64|amd64) ;;
    *) fail "Senju is only built for x86_64 Linux so far; build it from source: https://github.com/$REPO#building-from-source" ;;
  esac

  TMP="$(mktemp -d)"
  say "Downloading Senju $VERSION for Linux..."
  fetch "$(asset_url "Senju-$VERSION-linux-x86_64.AppImage")" "$TMP/senju" || fail "download failed"
  chmod 755 "$TMP/senju"

  # Icons come from the AppImage itself; extracting works without FUSE.
  (cd "$TMP" && ./senju --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1) || true
  for size in $ICON_SIZES; do
    icon="$TMP/squashfs-root/usr/share/icons/hicolor/${size}x${size}/apps/senju.png"
    if [ -f "$icon" ]; then
      mkdir -p "$DATA_HOME/icons/hicolor/${size}x${size}/apps"
      cp "$icon" "$DATA_HOME/icons/hicolor/${size}x${size}/apps/senju.png"
    fi
  done

  # Move into place in one step: a running Senju keeps its old file open.
  # The name carries no version, so the app's self-update replaces this file.
  mkdir -p "$(dirname "$BIN")"
  mv -f "$TMP/senju" "$BIN.new"
  mv -f "$BIN.new" "$BIN"

  mkdir -p "$(dirname "$DESKTOP")"
  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Name=Senju
Comment=The IDE for multitasking in the age of AI
Exec="$BIN" %U
Icon=senju
Type=Application
Terminal=false
Categories=System;TerminalEmulator;
StartupWMClass=Senju
EOF
  refresh_menu

  say "Installed Senju $VERSION to $BIN"
  say "Start it from the applications menu or run: senju"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) say "Note: $HOME/.local/bin is not in your PATH; add it to run 'senju' from a terminal." ;;
  esac
  if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    say "Note: AppImages need FUSE 2. Install it with 'sudo apt install libfuse2t64' (Ubuntu 24.04+) or 'sudo apt install libfuse2'."
  fi
  if [ -d /opt/Senju ]; then
    say "Note: the Senju deb package is installed too; remove one of them to avoid two menu entries."
  fi
}

uninstall_linux() {
  rm -f "$BIN" "$DESKTOP"
  for size in $ICON_SIZES; do
    rm -f "$DATA_HOME/icons/hicolor/${size}x${size}/apps/senju.png"
  done
  refresh_menu
  say "Removed Senju. Settings are kept in ${XDG_CONFIG_HOME:-$HOME/.config}/senju and state in ${XDG_STATE_HOME:-$HOME/.local/state}/senju."
}

# --- macOS -----------------------------------------------------------------

mac_app_dir() {
  if [ -d /Applications/Senju.app ] || [ -w /Applications ]; then
    printf '/Applications'
  else
    printf '%s/Applications' "$HOME"
  fi
}

install_mac() {
  arch="$(uname -m)"
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$arch" = arm64 ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  else
    arch=x64
  fi

  TMP="$(mktemp -d)"
  say "Downloading Senju $VERSION for macOS ($arch)..."
  fetch "$(asset_url "Senju-$VERSION-mac-$arch.dmg")" "$TMP/senju.dmg" || fail "download failed"
  mkdir "$TMP/mnt"
  hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$TMP/mnt" "$TMP/senju.dmg" || fail "cannot open the disk image"
  [ -d "$TMP/mnt/Senju.app" ] || fail "Senju.app is missing from the disk image"

  dir="$(mac_app_dir)"
  mkdir -p "$dir"
  rm -rf "$dir/Senju.app.new"
  ditto "$TMP/mnt/Senju.app" "$dir/Senju.app.new"
  rm -rf "$dir/Senju.app"
  mv "$dir/Senju.app.new" "$dir/Senju.app"
  hdiutil detach -quiet "$TMP/mnt" || true
  rmdir "$TMP/mnt" 2>/dev/null || true

  # The app is not code-signed yet. You asked for it by running this script,
  # so drop the "downloaded from the internet" mark that makes Gatekeeper block it.
  xattr -dr com.apple.quarantine "$dir/Senju.app" 2>/dev/null || true

  say "Installed Senju $VERSION to $dir/Senju.app"
  say "Start it from Launchpad or run: open -a Senju"
}

uninstall_mac() {
  rm -rf /Applications/Senju.app "$HOME/Applications/Senju.app"
  say "Removed Senju. Settings and state are kept in $HOME/Library/Application Support/Senju."
}

# --- main ------------------------------------------------------------------

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=mac ;;
  *) fail "this script supports Linux and macOS; on Windows, download the installer from https://github.com/$REPO/releases/latest" ;;
esac

if [ "$ACTION" = uninstall ]; then
  "uninstall_$os"
  exit 0
fi

if [ -z "$VERSION" ]; then
  VERSION="$(latest_version)"
  [ -n "$VERSION" ] || fail "cannot find the latest release of $REPO"
fi

"install_$os"
say "If Senju is running, restart it to use the new version; your terminals keep running."
