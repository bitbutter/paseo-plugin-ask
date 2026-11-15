#!/usr/bin/env bash
# Copies extension/ into the pi extensions directory (~/.pi/agent/extensions/ask-user/).
# Applies to newly spawned pi sessions; reload existing agents to pick it up.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p ~/.pi/agent/extensions/ask-user
cp -r extension/. ~/.pi/agent/extensions/ask-user/
echo "installed: ~/.pi/agent/extensions/ask-user/"
