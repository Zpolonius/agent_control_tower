#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$HOME/Library/Application Support/ControlTower"
LOG_DIR="$HOME/Library/Logs"
LOG_FILE="$LOG_DIR/ControlTower.log"
PID_FILE="$STATE_DIR/server.pid"
URL_FILE="$STATE_DIR/server.url"
CONFIG_FILE="${CONTROL_TOWER_CONFIG:-$PROJECT_DIR/control-tower.config.json}"

mkdir -p "$STATE_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR"

# GUI-apps på macOS arver ikke shellens PATH. Tilføj gængse stier til Node, Homebrew, nvm, volta og agenter.
add_path() {
  if [ -d "$1" ] && [[ ":$PATH:" != *":$1:"* ]]; then
    export PATH="$1:$PATH"
  fi
}

add_path "/opt/homebrew/bin"
add_path "/opt/homebrew/sbin"
add_path "/usr/local/bin"
add_path "$HOME/.local/bin"
add_path "$HOME/.volta/bin"
add_path "$HOME/.fnm/aliases/default/bin"
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM="$(ls -1d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$LATEST_NVM" ] && [ -d "$LATEST_NVM/bin" ]; then
    add_path "$LATEST_NVM/bin"
  fi
fi

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

cmd="${1:-}"
case "$cmd" in
  status)
    if is_running; then
      echo "running"
      exit 0
    fi
    echo "stopped"
    exit 1
    ;;

  has-root)
    NODE_BIN="$(find_node || true)"
    if [ -z "$NODE_BIN" ]; then
      echo "missing-node"
      exit 2
    fi
    "$NODE_BIN" -e '
      const fs = require("fs");
      const file = process.argv[1];
      if (!fs.existsSync(file)) process.exit(1);
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)) process.exit(0);
        if (typeof data.root === "string" && data.root.trim()) process.exit(0);
        process.exit(1);
      } catch {
        // Ugyldig JSON håndteres af serveren med en klar fejlbesked.
        process.exit(0);
      }
    ' "$CONFIG_FILE"
    ;;

  open)
    if [ -f "$URL_FILE" ]; then
      url="$(cat "$URL_FILE" 2>/dev/null || true)"
      if [ -n "$url" ]; then
        open "$url"
        exit 0
      fi
    fi
    exit 1
    ;;

  start)
    if is_running; then
      if [ -f "$URL_FILE" ]; then
        url="$(cat "$URL_FILE" 2>/dev/null || true)"
        if [ -n "$url" ]; then
          open "$url"
          exit 0
        fi
      fi
    fi

    NODE_BIN="$(find_node || true)"
    if [ -z "$NODE_BIN" ]; then
      echo "Node.js blev ikke fundet. Installer Node.js 20 eller nyere fra https://nodejs.org." >&2
      exit 1
    fi

    ROOT_ARG="${2:-}"
    : > "$LOG_FILE"
    rm -f "$URL_FILE" "$PID_FILE"

    cd "$PROJECT_DIR"
    if [ -n "$ROOT_ARG" ]; then
      nohup "$NODE_BIN" "$PROJECT_DIR/server/index.js" --no-open -- "$ROOT_ARG" > "$LOG_FILE" 2>&1 </dev/null &
    else
      nohup "$NODE_BIN" "$PROJECT_DIR/server/index.js" --no-open > "$LOG_FILE" 2>&1 </dev/null &
    fi
    pid=$!
    echo "$pid" > "$PID_FILE"

    url=""
    for _ in $(seq 1 100); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      url="$(grep -Eo 'https?://127\.0\.0\.1:[0-9]+/#token=[a-f0-9]+' "$LOG_FILE" 2>/dev/null | head -n 1 || true)"
      if [ -n "$url" ]; then
        break
      fi
      sleep 0.1
    done

    if [ -n "$url" ]; then
      (
        umask 077
        printf '%s' "$url" > "$URL_FILE"
      )
      open "$url"
      exit 0
    fi

    rm -f "$PID_FILE" "$URL_FILE"
    cat "$LOG_FILE" >&2 || true
    exit 1
    ;;

  stop)
    if [ -f "$PID_FILE" ]; then
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        for _ in $(seq 1 50); do
          if ! kill -0 "$pid" 2>/dev/null; then
            break
          fi
          sleep 0.1
        done
        if kill -0 "$pid" 2>/dev/null; then
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
    fi
    rm -f "$PID_FILE" "$URL_FILE"
    ;;

  *)
    echo "Brug: $0 {start [root]|open|status|stop|has-root}" >&2
    exit 1
    ;;
esac
