#!/usr/bin/env bash
# Installs the report runner as a launchd agent on the Docker host (the mini).
# Re-runnable: keeps the existing token, rewrites the plist, restarts the agent.
# Prints the two lines to add to OpenSEO's .env.
set -euo pipefail

LABEL="com.bowst.seo-report-runner"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER_HOME="$HOME/Library/Application Support/seo-report-runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/seo-report-runner.log"
PORT="${RUNNER_PORT:-4319}"

NODE_BIN="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
CLAUDE_BIN="$(command -v claude)" || { echo "claude not found on PATH" >&2; exit 1; }

mkdir -p "$RUNNER_HOME" "$HOME/Library/LaunchAgents"
TOKEN_FILE="$RUNNER_HOME/token"
if [ ! -s "$TOKEN_FILE" ]; then
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$HERE/runner.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RUNNER_TOKEN</key><string>$TOKEN</string>
    <key>RUNNER_PORT</key><string>$PORT</string>
    <key>CLAUDE_BIN</key><string>$CLAUDE_BIN</string>
    <key>PATH</key><string>$(dirname "$CLAUDE_BIN"):$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
chmod 600 "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 1
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null && echo "runner is up on port $PORT" || {
  echo "runner did not answer; see $LOG" >&2
  exit 1
}

cat <<EOF

Add these to OpenSEO's .env, then recreate the container (docker compose up -d):

REPORT_RUNNER_URL=http://host.docker.internal:$PORT
REPORT_RUNNER_TOKEN=$TOKEN
REPORT_AUTHOR_LABEL=Bowst
EOF
