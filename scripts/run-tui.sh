#!/usr/bin/env bash
# Kept as a thin alias for `dshcodecli -i`.
#
# Everything this script used to do by hand — reading .env for DEEPSEEK_API /
# DEEPSEEK_URL, adding --use-env-proxy, writing the profile — now lives in
# packages/dsh-tui/bin/launch.mjs, so it works from any directory and from an
# installed copy. The one difference kept here is that this entry point is
# always interactive.
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
exec node "$root/packages/dsh-tui/bin/dshcodecli.mjs" --interactive "$@"
