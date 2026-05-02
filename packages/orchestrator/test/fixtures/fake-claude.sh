#!/usr/bin/env bash
#
# fake-claude.sh — A real shell-script "claude binary" for integration tests.
#
# This is NOT a mock. It is a real executable that:
#  1. Echoes lines to stdout/stderr (exercises WorkerOutputStream rate-limit + log file).
#  2. Creates hello.txt in cwd (proof of real worktree filesystem I/O).
#  3. Invokes the bootstrap helper which connects to the MCP gateway and
#     issues real heartbeat + task.complete RPCs (same protocol as fake-worker.mjs).
#
# Required env vars (set by spawn.ts):
#   ORBITAL_CAPABILITY_PATH  Path to the capability bundle JSON.
#   ORBITAL_MCP_GATEWAY_URL  Unix socket URL.
#   ORBITAL_TASK_ID          The task id this run is for.
#   ORBITAL_WORKER_ID        Worker session id (= bundle.session_id).
#
# Required positional dependency (test fixture):
#   $FAKE_CLAUDE_BOOTSTRAP env var must point at the fake-claude-bootstrap.mjs file.
#
# Exits 0 on success, 1 on bootstrap failure.

set -euo pipefail

echo "fake-claude: starting in $PWD"
echo "fake-claude: task=${ORBITAL_TASK_ID:-unset} worker=${ORBITAL_WORKER_ID:-unset}"
>&2 echo "fake-claude: stderr message (testing stderr pathway)"
echo "fake-claude: writing hello.txt"
printf "hello from real spawn loop\n" > hello.txt
echo "fake-claude: hello.txt written"

if [ -z "${FAKE_CLAUDE_BOOTSTRAP:-}" ]; then
  >&2 echo "fake-claude: FAKE_CLAUDE_BOOTSTRAP env var not set; cannot signal task.complete"
  exit 1
fi

node "$FAKE_CLAUDE_BOOTSTRAP"
echo "fake-claude: task.complete sent; exiting 0"
exit 0
