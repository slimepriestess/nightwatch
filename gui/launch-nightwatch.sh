#!/bin/bash
# Nightwatch phase-A wrapper: ensure the viewer server, then open a
# chromeless app window. A dedicated user-data-dir guarantees a fresh
# Chrome instance, so the --app flag can't be dropped by single-instance
# handoff. Phase B (Tauri, self-contained) replaces this.
# No ?desk=1 (the fixture's fake desktop, for stills only) and no default
# ?skin=: the page remembers the last skin chosen in its View menu, and a
# skin in the URL would override that on every launch. NIGHTWATCH_SKIN still
# forces one when set.
PORT="${NIGHTWATCH_PORT:-7352}"
URL="http://127.0.0.1:$PORT/${NIGHTWATCH_SKIN:+?skin=$NIGHTWATCH_SKIN}"
# This script's own gui/ dir, so the server, log and profile come from the
# tree the script lives in — not a hard-coded path to one machine's old copy.
# One readlink hop first: invoked through a symlink, $0 is the link, and its
# dirname would land outside any tree (marginalia's review note).
SELF="$0"; [ -L "$SELF" ] && SELF="$(readlink "$SELF")"
HERE="$(cd "$(dirname "$SELF")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
say() { echo "$(date -u +%FT%TZ) launcher: $*" >> "$HERE/viewer.log"; }
up() { curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/"; }
# Something already answering isn't trusted on sight: the server outlives
# whatever started it, so ask it who it is and apply the app's rule
# (viewer-judge.mjs). Keep this tree's current viewer, replace a stale one or
# one whose tree is gone, and never stop another living tree's viewer.
replaced=""
if up; then
  verdict="$(node "$HERE/viewer-judge.mjs" "$PORT" "$ROOT")"
  case "$verdict" in
    keep) ;;
    replace\ *)
      rest="${verdict#replace }"; pid="${rest%% *}"
      say "replacing the viewer server on port $PORT: pid $pid, ${rest#"$pid" }"
      kill "$pid"
      for i in $(seq 1 50); do up || break; sleep 0.1; done
      if up; then say "pid $pid didn't stop; leaving it"; else say "stopped pid $pid"; replaced=1; fi ;;
    refuse\ *)
      say "${verdict#refuse }"
      echo "${verdict#refuse }" >&2
      command -v osascript >/dev/null && osascript -e 'on run argv' \
        -e 'display alert "Nightwatch" message (item 1 of argv)' -e 'end run' "${verdict#refuse }" >/dev/null 2>&1
      exit 1 ;;
    *) say "couldn't judge what answers on port $PORT (${verdict:-no answer}); opening it anyway" ;;
  esac
fi
if ! up; then
  NIGHTWATCH_PORT="$PORT" nohup node "$HERE/server.mjs" \
    >> "$HERE/viewer.log" 2>&1 &
  for i in $(seq 1 20); do
    up && break
    sleep 0.5
  done
  # Say so if the replacement never came up, so the window's error has a
  # line in the log beside it (Weft's condition on the app's version).
  if [ -n "$replaced" ]; then
    if up; then say "the new viewer server answers on port $PORT, from $ROOT"; else say "the new viewer server never answered on port $PORT"; fi
  fi
fi
# NIGHTWATCH_CHROME is for the launcher's own test, which must never open a
# real window.
exec "${NIGHTWATCH_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" \
  --app="$URL" --window-size=1100,1000 --user-data-dir="$HERE/.chrome-profile" \
  >/dev/null 2>&1
