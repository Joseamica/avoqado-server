#!/bin/bash

# Kill the dev server bound to port 3000 PLUS any orphan nodemon/tsx watchers
# for THIS project. Orphans accumulate when terminal tabs are closed without
# SIGHUP reaching the watcher (Cursor/Conductor/iTerm "close without confirm"),
# leaving multiple watchers racing to bind the port on the next file save.
#
# We pgrep -f against full command lines containing this repo's path so we
# only touch processes that belong to this project — never other repos'
# dev servers, Chrome tabs, or ngrok clients connected to the local API.

PORT=3000
REPO_PATH="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Kill orphan watchers (nodemon + tsx watch) scoped to this repo.
#    -f matches the full command line, including the working directory bin path.
pkill -9 -f "${REPO_PATH}/node_modules/.bin/nodemon" 2>/dev/null
pkill -9 -f "${REPO_PATH}/node_modules/.bin/tsx watch" 2>/dev/null
pkill -9 -f "${REPO_PATH}/node_modules/.bin/tsx src/server.ts" 2>/dev/null

# 2. Kill the process currently bound to the port (if any survived above
#    or was started from a different path).
#    -sTCP:LISTEN filters to the binding process so we don't kill clients
#    connected to the local API.
PID=$(lsof -ti:$PORT -sTCP:LISTEN 2>/dev/null)
if [ -n "$PID" ]; then
  kill -9 $PID 2>/dev/null
  sleep 0.5
fi
