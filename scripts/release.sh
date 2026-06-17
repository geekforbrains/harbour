#!/usr/bin/env bash
# Harbour release: rebuild and restart the full local stack (server + runner).
#
# Why: `next start` reads the build manifest at startup and doesn't watch .next/.
# Rebuilding in place while the old server runs produces stale-chunk 404s/500s
# until the process is restarted. Stopping before the build avoids that window
# entirely (launchd's KeepAlive would otherwise respawn the server mid-build).
# The runner is restarted too so it picks up any changes under bin/.
#
# Currently macOS/launchd only. Extend for Linux/systemd when that install path
# lands in bin/lib/install.mjs.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "release.sh: only macOS/launchd is supported right now" >&2
  exit 1
fi

SERVER_LABEL="com.harbour.server"
RUNNER_LABEL="com.harbour.runner"
SERVER_PLIST="$HOME/Library/LaunchAgents/${SERVER_LABEL}.plist"
DOMAIN="gui/$(id -u)"

if [[ ! -f "$SERVER_PLIST" ]]; then
  echo "release.sh: $SERVER_PLIST not found — harbour server isn't installed as a launch agent" >&2
  exit 1
fi

echo "==> Stopping $SERVER_LABEL"
launchctl bootout "$DOMAIN/$SERVER_LABEL" 2>/dev/null || true

echo "==> Building"
npm run build

echo "==> Starting $SERVER_LABEL"
launchctl bootstrap "$DOMAIN" "$SERVER_PLIST"

sleep 2
if ! launchctl list | grep -q "${SERVER_LABEL}$"; then
  echo "release.sh: $SERVER_LABEL not listed by launchctl after bootstrap" >&2
  exit 1
fi
echo "==> OK: $SERVER_LABEL is running"

# The runner is optional — only restart if it's installed. kickstart -k
# is enough here (no build artifacts, just force a restart so the process
# picks up any code changes under bin/).
if launchctl list | grep -q "${RUNNER_LABEL}$"; then
  echo "==> Restarting $RUNNER_LABEL"
  launchctl kickstart -k "$DOMAIN/$RUNNER_LABEL"
  echo "==> OK: $RUNNER_LABEL restarted"
else
  echo "==> $RUNNER_LABEL not installed, skipping"
fi
