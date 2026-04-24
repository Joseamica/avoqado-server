#!/bin/bash

# Kill ONLY the process LISTENING on port 3000 (silent mode).
# -sTCP:LISTEN filters to the binding process — without it we'd also kill
# Chrome tabs and ngrok clients connected to the local API.
PORT=3000

PID=$(lsof -ti:$PORT -sTCP:LISTEN 2>/dev/null)

if [ -n "$PID" ]; then
  kill -9 $PID 2>/dev/null
  # Wait a bit for the port to be released
  sleep 0.5
fi
