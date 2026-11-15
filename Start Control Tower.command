#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

for p in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/.volta/bin"; do
  if [ -d "$p" ] && [[ ":$PATH:" != *":$p:"* ]]; then
    export PATH="$p:$PATH"
  fi
done
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM="$(ls -1d "$HOME/.nvm/versions/node"/v* 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$LATEST_NVM" ] && [ -d "$LATEST_NVM/bin" ]; then
    export PATH="$LATEST_NVM/bin:$PATH"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js blev ikke fundet. Installer Node.js 20 eller nyere fra https://nodejs.org."
  read -r -p "Tryk Enter for at lukke..."
  exit 1
fi

exec node "$DIR/server/index.js"
