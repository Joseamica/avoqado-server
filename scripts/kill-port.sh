#!/bin/bash

# Kill process on port 12344 if exists (silent mode)
PORT=12344

PID=$(lsof -t -i :$PORT 2>/dev/null)

if [ -n "$PID" ]; then
  kill -9 $PID 2>/dev/null
  # Wait a bit for the port to be released
  sleep 0.5
fi
