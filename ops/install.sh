#!/bin/bash
# Idempotent install of the Salik LaunchAgent. Copied from trip-agent/ops/install.sh
# — same bootout-then-bootstrap poll loop, for the same reason: bootout is
# ASYNCHRONOUS, so bootstrapping immediately after an edited-plist reinstall
# fails with "Input/output error 5" because the label is still registered.
set -euo pipefail

ROOT="/Users/yusufkhan/Projects/salik"
AGENTS="$HOME/Library/LaunchAgents"
LABEL="com.yusufkhan.salik.gateway"

if [ ! -f "$ROOT/config/keys.json" ]; then
  echo "config/keys.json is missing — copy config/keys.json.example, fill in real"
  echo "client tokens and upstream cloud keys, and chmod 600 it. Refusing to"
  echo "install a gateway with no way to authenticate anyone." >&2
  exit 1
fi

mkdir -p "$AGENTS" "$ROOT/data/bodies"

echo "==> $LABEL"
cp "$ROOT/ops/$LABEL.plist" "$AGENTS/$LABEL.plist"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 40); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 0.25
  done
fi

if ! launchctl bootstrap "gui/$(id -u)" "$AGENTS/$LABEL.plist"; then
  echo "    bootstrap failed — still registered? try:"
  echo "      launchctl bootout gui/$(id -u)/$LABEL && ./ops/install.sh"
  exit 1
fi
launchctl enable "gui/$(id -u)/$LABEL"

echo
echo "==> status"
for _ in $(seq 1 24); do
  launchctl list | grep -q "$LABEL" && break
  sleep 1
done
if launchctl list | grep -q "$LABEL"; then
  printf '    %-40s running\n' "$LABEL"
else
  printf '    %-40s NOT RUNNING — check data/salik.log\n' "$LABEL"
  exit 1
fi

PORT=$(python3 -c "import json;print(json.load(open('$ROOT/config/settings.json'))['port'])")

echo
echo "==> reaching it"
echo "    On this Mac:   http://127.0.0.1:$PORT"
echo
echo "    Bound to 0.0.0.0, so a Tailscale device on this tailnet can also reach"
echo "    it — but every request still needs a real client token from"
echo "    config/keys.json (never printed here). Verify with:"
echo '      curl -s -H "Authorization: Bearer $SALIK_TOKEN" http://127.0.0.1:'"$PORT"'/api/tags'
echo '      curl -s -H "Authorization: Bearer $SALIK_TOKEN" http://127.0.0.1:'"$PORT"'/api/salik/status'
echo
if [ ! -f /etc/newsyslog.d/salik.conf ]; then
  echo "    data/salik.log has no rotation yet (one-time, needs sudo):"
  echo "      sudo cp ops/newsyslog-salik.conf /etc/newsyslog.d/salik.conf"
  echo
fi
echo "    Uninstall:  launchctl bootout gui/$(id -u)/$LABEL"
