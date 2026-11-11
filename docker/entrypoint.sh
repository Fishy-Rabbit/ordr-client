#!/bin/sh
# The worker spawns and supervises its own Xvfb per render slot, so the only
# thing to start is the Node server. exec keeps PID 1 = node, so SIGTERM from
# the orchestrator reaches the graceful shutdown handler directly.
set -eu
exec node /app/build/main.js
