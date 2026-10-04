#!/bin/sh
# Entrypoint for the igv-vscode code-server e2e image. code-server reads its
# user settings at startup, so the settings file is written here, from the
# TRANSPORT_MODE environment variable, before handing over to the image's own
# entrypoint (/usr/bin/entrypoint.sh: fixuid + dumb-init + code-server).
set -eu

MODE="${TRANSPORT_MODE:-shim}"
case "$MODE" in
  shim|webviewUri) ;;
  *) echo "[igv-e2e] TRANSPORT_MODE must be 'shim' or 'webviewUri', got '$MODE'" >&2; exit 64 ;;
esac

SETTINGS_DIR="${HOME:-/home/coder}/.local/share/code-server/User"
mkdir -p "$SETTINGS_DIR"
cat > "$SETTINGS_DIR/settings.json" <<JSON
{
  "igv.defaultGenome": "/home/coder/project/data/ref.fa",
  "igv.transport.mode": "$MODE",
  "igv.agent.enabled": true,
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.enableExperiments": false,
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "telemetry.telemetryLevel": "off",
  "terminal.integrated.defaultProfile.linux": "bash",
  "terminal.integrated.shellIntegration.enabled": false,
  "terminal.integrated.enablePersistentSessions": false,
  "terminal.integrated.confirmOnKill": "never",
  "git.enabled": false
}
JSON
echo "[igv-e2e] wrote $SETTINGS_DIR/settings.json (igv.transport.mode=$MODE)"

if [ -x /usr/bin/entrypoint.sh ]; then
  exec /usr/bin/entrypoint.sh "$@"
fi
exec code-server "$@"
