#!/bin/bash
# Daily wrapper for divinebot: runs the automatic pipeline and logs to state/logs/<date>.log.
# On a non-zero exit it shows a macOS notification that names the run directory to look at.
# It holds no secrets: the key is read from the key file (DIVINEBOT_KEY_FILE or the default path).

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 1

# launchd starts jobs with a minimal PATH. Add the usual places node and npm live.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p state/logs
LOG="state/logs/$(date +%Y-%m-%d).log"

echo "=== divinebot run started $(date '+%Y-%m-%d %H:%M:%S %z') ===" >> "$LOG"
npm run run -- --auto >> "$LOG" 2>&1
STATUS=$?
echo "=== divinebot run exited $STATUS ===" >> "$LOG"

if [ "$STATUS" -ne 0 ]; then
  # Name the newest run directory marked NEEDS_REVIEW; failing that, the newest run directory.
  RUN_DIR=""
  for d in $(ls -d out/*/ 2>/dev/null | sort -r); do
    if [ -e "${d}NEEDS_REVIEW" ]; then RUN_DIR="${d%/}"; break; fi
  done
  if [ -z "$RUN_DIR" ]; then
    RUN_DIR="$(ls -d out/*/ 2>/dev/null | sort | tail -n 1)"
    RUN_DIR="${RUN_DIR%/}"
  fi
  if [ -n "$RUN_DIR" ]; then
    MESSAGE="Run stopped with exit $STATUS. Look at $RUN_DIR and $LOG."
  else
    MESSAGE="Run stopped with exit $STATUS. Look at $LOG."
  fi
  osascript -e "display notification \"$MESSAGE\" with title \"divinebot\"" || true
fi

exit "$STATUS"
