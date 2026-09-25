#!/bin/sh
# ai-sync hook shim. Must be fast and must never fail the calling tool.
#  - Claude Code hooks (Stop, SessionEnd) pass a JSON payload on stdin.
#  - Codex `notify` passes a JSON payload as the first argument.
# The payload is dropped into the spool dir; the daemon watches it and syncs.
SPOOL="${AI_SYNC_HOME:-$HOME/.ai-sync}/spool"
mkdir -p "$SPOOL" 2>/dev/null || exit 0
f="$SPOOL/$(date +%s)-$$"
if [ -n "$1" ]; then
  printf '%s' "$1" | head -c 65536 > "$f.tmp" 2>/dev/null
else
  head -c 65536 > "$f.tmp" 2>/dev/null
fi
mv "$f.tmp" "$f.json" 2>/dev/null
exit 0
