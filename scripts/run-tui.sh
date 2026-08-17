#!/usr/bin/env bash
# Launch the DeepSeek Harness TUI against the real API using credentials from .env.
#
# The harness requires either an initial task string or --resume; it will not
# start with neither.
#
# Usage:
#   ./scripts/run-tui.sh "task text"             # interactive session, persists to ~/.dsh
#   ./scripts/run-tui.sh --resume latest          # continue the last session
#   DSH_HOME=$(mktemp -d) ./scripts/run-tui.sh "task text"   # throwaway session
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <task text> | $0 --resume [session]" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/.env"

if [[ ! -f "$env_file" ]]; then
  echo "missing $env_file (expected DEEPSEEK_API and DEEPSEEK_URL)" >&2
  exit 1
fi

deepseek_api="$(grep -E '^DEEPSEEK_API=' "$env_file" | head -n1 | cut -d= -f2-)"
deepseek_url="$(grep -E '^DEEPSEEK_URL=' "$env_file" | head -n1 | cut -d= -f2-)"

if [[ -z "$deepseek_api" ]]; then
  echo "DEEPSEEK_API not set in $env_file" >&2
  exit 1
fi

export DEEPSEEK_API_KEY="$deepseek_api"
export DEEPSEEK_BASE_URL="${deepseek_url:-https://api.deepseek.com}"
# Node's built-in fetch (undici) does not read HTTP_PROXY/HTTPS_PROXY by
# default; this environment requires a proxy to reach api.deepseek.com.
export NODE_OPTIONS="${NODE_OPTIONS:-} --use-env-proxy"

cd "$root"
exec node --import tsx/esm scripts/launch-tui.ts --interactive "$@"
