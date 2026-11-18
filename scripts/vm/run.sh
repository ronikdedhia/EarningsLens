#!/usr/bin/env bash
# cron entry point: update to the latest main, then run one job.
#   run.sh daily|evening|refresh
set -uo pipefail
APP="$HOME/earningslens"
export PATH="$HOME/.local/node/bin:$PATH"
export JOB_HOST_LABEL="mumbai-vm"
cd "$APP" || exit 1
LOG="$APP/logs/$1-$(date -u +%Y%m%d).log"
exec >>"$LOG" 2>&1
echo "=== $(date -u +%FT%TZ) $1"

# Only one run of a job at a time
exec 9>"/tmp/earningslens-$1.lock"
flock -n 9 || { echo "already running"; exit 0; }

BEFORE=$(git rev-parse HEAD)
git pull --ff-only -q || echo "git pull failed; running the current checkout"
if ! git diff --quiet "$BEFORE" HEAD -- package-lock.json; then
  npm ci --no-audit --no-fund --omit=optional >/dev/null
fi

timeout 45m npx tsx scripts/run-job.ts "$1"
echo "=== exit $?"

# Two weeks of logs is plenty
find "$APP/logs" -name '*.log' -mtime +14 -delete
