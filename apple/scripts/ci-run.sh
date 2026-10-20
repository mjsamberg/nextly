#!/usr/bin/env bash
# CI helper: runs a command and, if it fails, posts its last lines as a
# GitHub error annotation, so the cause shows on the run's summary page.
#
#   bash ci-run.sh "Label" command args...
set -uo pipefail

label="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  # Prefer compiler errors; otherwise the tail of the output.
  lines="$(grep -E 'error:|Error:|error\[|fatal' "$log" | grep -v '^\s*$' | tail -15)"
  [ -n "$lines" ] || lines="$(tail -25 "$log")"
  body="$(printf '%s' "$lines" | sed 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}')"
  echo "::error title=$label failed::$body"
fi
exit "$status"
