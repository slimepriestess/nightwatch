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
# Exits 0 with the note on stdout when one lands, and runs until then: it
# has no time limit of its own. If a harness caps background tasks, a
# timeout just means re-arm. (Claude Code on WSL measured no cap on
# 2026-10-23; a watcher ran 2h54m.)
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
# tracked one that would have been heard. The process judged is the one the
# pid file names (below): the shell running this script, never a match on
# text, which the harness's wrapper and this script's own subshells share.
# Per hub (nightwatch#70): two hubs on one machine can both have a lane
# called "main", so a machine-wide match on the lane name made one hub's
# watcher stand down for, or kill, the other's. The judgment now starts from
# this hub's own spool: the watcher that holds the lane writes its pid to
# <spool>/<lane>/.watcher.pid, and an arm judges only the pid that file names
# (no environment reads, which macOS can't do; Sonnet Weft, 11/10). The loop
# lists only *.txt, and plain ls hides dotfiles, so the file can't ring.
#   - The file counts only if its pid is a watcher for this lane NOW: a shell
#     whose command line ends `bell-watcher.sh <lane>`. A pid some stranger
#     has since been given is never stood down for and never killed; its
#     file is stale and replaced (Weft's edge 1, the worst failure here:
#     a guard that stands down for a stranger leaves the bells unheard).
#   - A watcher it names that's tracked (its parent is a shell): stand down.
#     One that's detached: stopped, and this arm takes its place.
#   - The claim is made with noclobber, so two arms at once can't both win;
#     the loser judges the winner (edge 2).
#   - The file is removed at exit only while it still names us, and a file
#     left by a SIGKILL names a pid that's gone, so it's stale (edge 3).
# A watcher armed by code from before this has no file, so after an upgrade
# one can run beside the new arm until it exits: two listeners on one spool
# both hear the next note. A duplicate, never a silence.
PIDFILE="$SPOOL/.watcher.pid"
ARM_MARK=""
is_watcher() {
  line="$(ps -o command= -p "$1" 2>/dev/null)" || return 1
  first="${line%% *}"
  case "${first##*/}" in sh|bash|dash|zsh) ;; *) return 1 ;; esac
  case "$line" in *"bell-watcher.sh $LANE") return 0 ;; esac
  return 1
}
stand_down() {   # true when an arm must not run a second watcher
  [ -f "$PIDFILE" ] || return 1
  held="$(tr -cd '0-9' < "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$held" ] && [ "$held" != "$$" ] && is_watcher "$held"; then
    ppid="$(ps -o ppid= -p "$held" 2>/dev/null | tr -d ' ')"
    pcomm="$(ps -o comm= -p "$ppid" 2>/dev/null)"
    case "${pcomm##*/}" in
      sh|bash|zsh|dash|-sh|-bash|-zsh|-dash) tracked=1 ;;
      *) tracked=0 ;;
    esac
    if [ "$ppid" != "1" ] && [ "$tracked" = 1 ]; then
      echo "bell-watcher: $LANE is already watched by pid $held (a tracked watcher); not arming a second. Nothing to re-arm."
      return 0
    fi
    kill "$held" 2>/dev/null && echo "bell-watcher: stopped pid $held, a detached watcher for $LANE (its exit would reach no one)"
  elif [ -n "$held" ] && [ "$held" != "$$" ]; then
    echo "bell-watcher: $PIDFILE named pid $held, which isn't a watcher for $LANE now; replacing it"
  fi
  rm -f "$PIDFILE"
  return 1
}
cleanup() {
  [ -n "$ARM_MARK" ] && rm -f "$ARM_MARK"
  [ "$(cat "$PIDFILE" 2>/dev/null)" = "$$" ] && rm -f "$PIDFILE"
  return 0
}
tries=0
while :; do
  stand_down && exit 0
  if ( set -C; echo "$$" > "$PIDFILE" ) 2>/dev/null; then break; fi
  tries=$((tries + 1))
  [ "$tries" -lt 5 ] || { echo "bell-watcher: couldn't claim $PIDFILE"; exit 4; }
  sleep 1   # another arm claimed it between our judgment and our claim; judge that one
done
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
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
if [ -n "$DUE" ]; then
  ARM_MARK="$(mktemp "${TMPDIR:-/tmp}/bell-watcher-arm.XXXXXX")"
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
  # In the background and waited for, so a TERM is taken at once: with a
  # trap set, sh would otherwise finish the sleep before handling it.
  sleep 5 & wait $!
done
