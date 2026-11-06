#!/bin/sh
# bell-watcher — how a persona hears the bell. Generic: no Discord, no
# routing, no assumptions beyond the hub config. The nightshift delivers
# every bell (sleep-bell, fold-now) as a note file in the hub's spool;
# this script waits for the next note for ONE lane and exits when it
# lands, printing it. Run it as a background task from a session: the
# task's completion notification IS the bell. The note itself says what
# to do (the ritual, in order). Deleting the note and re-arming are the
# session's own acts, on purpose — hearing a bell should be witnessed,
# never silently consumed.
#
#   NIGHTWATCH_CONFIG=<hub config> sh bell-watcher.sh <lane>
#
# Exits 0 with the note on stdout when one lands. Runs until then; a
# harness timeout (the usual 2h background cap) just means re-arm.
set -e
MACHINERY_DIR="$(cd "$(dirname "$0")" && pwd)"
# The node wake.sh exported for this session (the daemon's), else the shell's.
NODE="${NIGHTWATCH_NODE:-node}"
LANE="$1"
[ -n "$LANE" ] || { echo "usage: bell-watcher.sh <lane>"; exit 2; }
SPOOL_BASE="$("$NODE" "$MACHINERY_DIR/config.mjs" get paths.spool)" || {
  echo "bell-watcher: hub config unreadable (set NIGHTWATCH_CONFIG to the hub's config file)"; exit 3; }
SPOOL="$SPOOL_BASE/$LANE"
mkdir -p "$SPOOL"
# Due notes (the watch's segment-due and l3-due) live apart, in due/<lane>
# (10/18): a due note waits for a seam by design, and one left waiting in
# the spool made every re-arm exit at once, silencing the watcher for the
# bell. Here a due note wakes the lane only if it lands while this watcher
# is armed; one already waiting is listed below, once, and left to wait.
# The arm's mark is stamped BEFORE that listing, and anything newer than it
# counts as fresh, so a note landing in the arm's first instant is listed
# and wakes it too: a duplicate, never a silent wait (Fable's tie-break).
DUE_BASE="$("$NODE" "$MACHINERY_DIR/config.mjs" get paths.due)" || DUE_BASE=""
DUE=""
if [ -n "$DUE_BASE" ] && [ "$DUE_BASE" != "null" ]; then
  DUE="$DUE_BASE/$LANE"
  mkdir -p "$DUE"
fi

# One watcher per lane, judged by parentage (10/16). A watcher whose parent
# isn't a shell was detached (a trailing `&`, or its session ended): its exit
# reaches no one, so a bell it catches is printed to nowhere. It is stopped
# here, and this arm takes its place. A watcher whose parent is a shell (the
# harness's wrapper, or a person's terminal) is a tracked one; then this arm
# stands down rather than run a second. "Parent is pid 1" was the first test,
# and it holds on macOS only: Linux hands an orphan to the nearest subreaper
# (systemd --user, or WSL's per-session /init, "Relay(n)"), so there every
# detached watcher looked tracked, and the arm stood down for it (10/17). Twice a
# detached watcher looked like coverage (10/14, then again under load on
# 10/16), and a guard that only counted processes declined to arm the
# tracked one that would have been heard. Only the shell running this script
# matches: the harness's wrapper carries the same text in its command line,
# and so does this script's own subshell below (a fork, whose parent is us).
WATCHERS="$(ps -axo pid=,ppid=,command= | awk -v me="$$" -v tail="bell-watcher.sh $LANE" '
  $1 != me && $2 != me && ($3 == "sh" || $3 == "/bin/sh" || $3 == "bash" || $3 == "/bin/bash") &&
  length($0) >= length(tail) && substr($0, length($0) - length(tail) + 1) == tail { print $1, $2 }')"
if [ -n "$WATCHERS" ]; then
  LIVE=""
  for pair in $(echo "$WATCHERS" | tr ' ' ':'); do
    pid="${pair%%:*}"; ppid="${pair##*:}"
    pcomm="$(ps -o comm= -p "$ppid" 2>/dev/null)"
    case "${pcomm##*/}" in
      sh|bash|zsh|dash|-sh|-bash|-zsh|-dash) tracked=1 ;;
      *) tracked=0 ;;
    esac
    if [ "$ppid" = "1" ] || [ "$tracked" = 0 ]; then
      kill "$pid" 2>/dev/null && echo "bell-watcher: stopped pid $pid, a detached watcher for $LANE (its exit would reach no one)"
    else
      LIVE="$LIVE $pid"
    fi
  done
  if [ -n "$LIVE" ]; then
    echo "bell-watcher: $LANE is already watched by pid$LIVE (a tracked watcher); not arming a second. Nothing to re-arm."
    exit 0
  fi
fi
# At every exit, the due notes still waiting are listed after the note
# printed, so whoever reads that note sees them too: on a plain install the
# watcher is the only path a due note takes, and this is what makes "by the
# next exit at the latest" true.
due_tail() {
  [ -n "$DUE" ] || return 0
  LEFT="$(ls "$DUE" 2>/dev/null | grep '\.txt$' | sed "s|^|$DUE/|" | grep -v -x -F "${1:-}" || true)"
  [ -n "$LEFT" ] && { echo "--- due notes also waiting here, for your next seam:"; echo "$LEFT" | sed 's/^/  /'; }
  return 0
}
ARM_MARK=""
if [ -n "$DUE" ]; then
  ARM_MARK="$(mktemp "${TMPDIR:-/tmp}/bell-watcher-arm.XXXXXX")"
  trap 'rm -f "$ARM_MARK"' EXIT
fi
echo "bell-watcher up: lane=$LANE spool=$SPOOL${DUE:+ due=$DUE} poll=5s (exits on first note)"
if [ -n "$DUE" ]; then
  WAITING="$(ls "$DUE" 2>/dev/null | grep '\.txt$' || true)"
  [ -n "$WAITING" ] && { echo "due notes already waiting here, for your next seam (they don't wake this watcher):"; echo "$WAITING" | sed "s|^|  $DUE/|"; }
fi
while :; do
  # Only completed notes count: pollers and the nightshift stage a note as
  # a temp name and rename it into place, so a half-written file must never
  # ring (11/04, 11/05: the watcher listed a poller's name.txt.tmp, lost the
  # cat to the rename, and exited 1 — a false bell delivering an error).
  # A read that fails (renamed away, deleted by a peer, or not a plain
  # readable file) skips to the next candidate; an empty file is a write
  # still in flight from a direct writer, left for a later tick. Spool
  # names are machine-stamped (no spaces), as the whole hub assumes.
  for NOTE in $(ls "$SPOOL" 2>/dev/null | grep '\.txt$'); do
    [ -s "$SPOOL/$NOTE" ] || continue
    if BODY="$(cat "$SPOOL/$NOTE" 2>/dev/null)"; then
      echo "BELL — read the note, run what it says, delete the file, re-arm the watcher:"
      echo "--- $SPOOL/$NOTE"
      printf '%s\n' "$BODY"
      due_tail
      exit 0
    fi
  done
  if [ -n "$ARM_MARK" ]; then
    FRESH="$(find "$DUE" -maxdepth 1 -name '*.txt' -newer "$ARM_MARK" 2>/dev/null | sort | head -1)"
    if [ -n "$FRESH" ]; then
      echo "DUE — a note from the watch: read it, act at your next clean seam, delete the file, re-arm the watcher:"
      echo "--- $FRESH"
      cat "$FRESH"
      due_tail "$FRESH"
      exit 0
    fi
  fi
  sleep 5
done
