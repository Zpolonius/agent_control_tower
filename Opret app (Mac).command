#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
chmod +x "$DIR/scripts/install-mac.sh" "$DIR/scripts/mac-helper.sh" "$DIR/Start Control Tower.command" "$DIR/Opret app (Mac).command"
bash "$DIR/scripts/install-mac.sh"
echo ""
read -r -p "Tryk Enter for at lukke..."
