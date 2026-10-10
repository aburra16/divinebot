#!/bin/bash
# Daily wrapper for divinebot: runs the automatic pipeline and logs to state/logs/<date>.log.
# On a non-zero exit it shows a macOS notification: the run to read when this run stopped for review,
# or the log to read otherwise.
# It holds no secrets: the key is read from the key file (DIVINEBOT_KEY_FILE or the default path).

set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 1

# launchd starts jobs with a minimal PATH. Add the usual places node and npm live.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$REPO/state/logs"
LOG="$REPO/state/logs/$(date +%Y-%m-%d).log"

# A marker older than anything this run writes: a NEEDS_REVIEW file newer than it was written by this run.
MARK="$(mktemp "${TMPDIR:-/tmp}/divinebot-start.XXXXXX")"
trap 'rm -f "$MARK"' EXIT

echo "=== divinebot run started $(date '+%Y-%m-%d %H:%M:%S %z') ===" >> "$LOG"
npm run run -- --auto >> "$LOG" 2>&1
STATUS=$?
echo "=== divinebot run exited $STATUS ===" >> "$LOG"

if [ "$STATUS" -ne 0 ]; then
  if [ "$STATUS" -eq 2 ]; then
    # Exit 2 means the run stopped for review. Name the run only if this run wrote its NEEDS_REVIEW;
    # an older marker belongs to an earlier run that may already be cleared.
    NEW_MARKER="$(find "$REPO/out" -maxdepth 2 -name NEEDS_REVIEW -newer "$MARK" 2>/dev/null | sort | tail -n 1)"
    if [ -n "$NEW_MARKER" ]; then
      MESSAGE="Run stopped for review. Read $(dirname "$NEW_MARKER")/report.md"
    else
      MESSAGE="An earlier unfinished run blocks automatic runs. Run npm run status in $REPO, and see $LOG"
    fi
  else
    MESSAGE="Run failed with exit $STATUS. See $LOG"
  fi
  osascript -e "display notification \"$MESSAGE\" with title \"divinebot\"" || true
fi

exit "$STATUS"
