#!/bin/sh
# Bench for bell-watcher.sh's singleton guard (10/16). A watcher whose parent
# isn't a shell (detached) must be stopped by the next arm, which takes its place;
# a second arm beside a tracked watcher must stand down. Runs on a scratch hub
# config and a scratch lane, and stops everything it started.
#   sh machinery/watcher-singleton-test.sh [bell-watcher.sh]
W="${1:-$(cd "$(dirname "$0")" && pwd)/bell-watcher.sh}"
LANE="zzbench$$"
T="$(mktemp -d "${TMPDIR:-/tmp}/nw-watcher-test-XXXX")"
printf '{"paths":{"spool":"%s/spool"},"lanes":{"%s":{}}}\n' "$T" "$LANE" > "$T/c.json"
export WEFT_CONFIG="$T/c.json"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
watchers() { ps -axo pid=,ppid=,command= | awk -v t="bell-watcher.sh $LANE" '($3=="sh"||$3=="/bin/sh") && substr($0,length($0)-length(t)+1)==t {print $1, $2}'; }
cleanup() { for p in $(watchers | awk '{print $1}'); do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT

# A detached watcher: double fork, so it is reparented. On macOS that's pid 1;
# on Linux it's the nearest subreaper (systemd --user, WSL's /init), which is
# why the guard asks "is the parent a shell?" and not "is it pid 1?".
( sh "$W" "$LANE" > "$T/orphan.out" 2>&1 & )
sleep 2
PCOMM="$(ps -o comm= -p "$(watchers | awk '{print $2}')" 2>/dev/null)"
case "${PCOMM##*/}" in sh|bash|zsh|dash|-sh|-bash|-zsh|-dash) PSHELL=yes ;; *) PSHELL=no ;; esac
check "the detached watcher's parent isn't a shell" "$PSHELL" "no"
ORPHAN="$(watchers | awk '{print $1}')"

# A tracked arm (a child of this shell) stops it and takes its place.
sh "$W" "$LANE" > "$T/tracked.out" 2>&1 &
TRACKED=$!
sleep 3
check "the detached watcher is stopped" "$(ps -p "$ORPHAN" >/dev/null 2>&1 && echo alive || echo gone)" "gone"
check "the tracked arm is running" "$(ps -p "$TRACKED" >/dev/null 2>&1 && echo alive || echo gone)" "alive"
check "the arm says why it stopped the other" "$(grep -c 'a detached watcher' "$T/tracked.out")" "1"

# A second arm beside the tracked watcher stands down.
# In the background with a bound, so a guard that wrongly arms fails this
# check instead of hanging the bench (it did, under a mutant, 11/11).
sh "$W" "$LANE" > "$T/second.out" 2>&1 &
SECOND=$!
sleep 3
if ps -p "$SECOND" >/dev/null 2>&1; then kill "$SECOND" 2>/dev/null; code="still running"; else wait "$SECOND"; code=$?; fi
out="$(cat "$T/second.out")"
check "a second arm exits at once" "$code" "0"
check "and says the lane is already watched" "$(printf %s "$out" | grep -c 'already watched')" "1"
check "the tracked watcher is untouched" "$(ps -p "$TRACKED" >/dev/null 2>&1 && echo alive || echo gone)" "alive"
check "one watcher for the lane" "$(watchers | wc -l | tr -d ' ')" "1"

# The tracked watcher still hears a bell.
mkdir -p "$T/spool/$LANE" && echo "the bell" > "$T/spool/$LANE/1-bell.txt"
sleep 6
check "the tracked watcher exits on the bell" "$(ps -p "$TRACKED" >/dev/null 2>&1 && echo alive || echo gone)" "gone"
check "and prints it" "$(grep -c 'the bell' "$T/tracked.out")" "1"

# Another hub's watcher with the same lane name is someone else's (nightwatch#70):
# an arm from hub B must neither stand down for hub A's tracked watcher nor kill
# a detached one of hub A's. Hub A's tracked watcher is re-armed first.
mkdir -p "$T/b" && printf '{"paths":{"spool":"%s/b/spool"},"lanes":{"%s":{}}}\n' "$T" "$LANE" > "$T/b/c.json"
rm -f "$T/spool/$LANE/1-bell.txt"   # the bell above was heard; a waiting note would end the next arm at once
sh "$W" "$LANE" > "$T/a.out" 2>&1 &
A=$!
sleep 2
WEFT_CONFIG="$T/b/c.json" sh "$W" "$LANE" > "$T/b.out" 2>&1 &
B=$!
sleep 3
check "hub B's arm runs beside hub A's watcher" "$(ps -p "$B" >/dev/null 2>&1 && echo alive || echo gone)" "alive"
check "hub A's watcher is untouched by it" "$(ps -p "$A" >/dev/null 2>&1 && echo alive || echo gone)" "alive"
check "hub B didn't call A's watcher its own" "$(grep -c 'already watched' "$T/b.out")" "0"
kill "$A" "$B" 2>/dev/null; sleep 1
( WEFT_CONFIG="$T/b/c.json" sh "$W" "$LANE" > "$T/borphan.out" 2>&1 & )
sleep 2
BORPHAN="$(watchers | awk '{print $1}')"
sh "$W" "$LANE" > "$T/a2.out" 2>&1 &
A2=$!
sleep 3
check "hub A's arm doesn't kill hub B's detached watcher" "$(ps -p "$BORPHAN" >/dev/null 2>&1 && echo alive || echo gone)" "alive"
check "and arms itself" "$(ps -p "$A2" >/dev/null 2>&1 && echo alive || echo gone)" "alive"
check "A's arms heard no stale note" "$(cat "$T/a.out" "$T/a2.out" | grep -c 'the bell')" "0"
# A bell in hub B's spool reaches B's watcher, not A's.
mkdir -p "$T/b/spool/$LANE" && echo "hub b bell" > "$T/b/spool/$LANE/1-bell.txt"
sleep 6
check "hub B's bell reaches B's watcher" "$(grep -c 'hub b bell' "$T/borphan.out")" "1"
check "and not A's" "$(grep -c 'hub b bell' "$T/a2.out")" "0"

# The pid file in the hub's spool (nightwatch#70, Weft's four edges).
PF="$T/spool/$LANE/.watcher.pid"
alive() { ps -p "$1" >/dev/null 2>&1 && echo alive || echo gone; }
kill "$A2" 2>/dev/null; sleep 1
check "a watcher stopped by TERM removes its pid file" "$([ -e "$PF" ] && echo there || echo removed)" "removed"
# Edge 1: a file naming a pid that's now a stranger, not a watcher.
sleep 300 & STRANGER=$!
echo "$STRANGER" > "$PF"
sh "$W" "$LANE" > "$T/e1.out" 2>&1 &
E1=$!
sleep 3
check "edge 1: an arm doesn't stand down for a stranger's pid" "$(alive "$E1")" "alive"
check "edge 1: and never kills the stranger" "$(alive "$STRANGER")" "alive"
check "edge 1: the file now names the arm" "$(cat "$PF" 2>/dev/null)" "$E1"
check "edge 1: and it says the old pid wasn't a watcher" "$(grep -c "isn't a watcher" "$T/e1.out")" "1"
kill "$STRANGER" 2>/dev/null
# Two more strangers, each of which only one half of the check catches (Weft,
# 11/11): a shell whose line merely contains the watcher's text, and a
# non-shell whose line ends with it.
kill "$E1" 2>/dev/null; sleep 1
for kind in shell-contains other-ends; do
  case "$kind" in
    shell-contains) sh -c 'sleep 300; true' bell-watcher.sh "$LANE" extra >/dev/null 2>&1 & ;;
    other-ends) perl -e 'sleep 300' bell-watcher.sh "$LANE" >/dev/null 2>&1 & ;;
  esac
  S=$!
  sleep 1
  echo "$S" > "$PF"
  sh "$W" "$LANE" > "$T/s-$kind.out" 2>&1 &
  SA=$!
  sleep 3
  check "edge 1 ($kind): the arm runs" "$(alive "$SA")" "alive"
  check "edge 1 ($kind): the stranger is untouched" "$(alive "$S")" "alive"
  pkill -P "$S" 2>/dev/null; kill "$S" "$SA" 2>/dev/null; sleep 1   # the shell stranger's sleep too
done
sh "$W" "$LANE" > "$T/e1.out" 2>&1 &
E1=$!
sleep 3
# Edge 3: a SIGKILL leaves the file behind, naming a pid that's gone.
kill -9 "$E1" 2>/dev/null; sleep 1
check "edge 3: a SIGKILL leaves the file behind" "$(cat "$PF" 2>/dev/null)" "$E1"
sh "$W" "$LANE" > "$T/e3.out" 2>&1 &
E3=$!
sleep 3
check "edge 3: the next arm treats it as stale and runs" "$(alive "$E3")" "alive"
check "edge 3: the file names the new arm" "$(cat "$PF" 2>/dev/null)" "$E3"
kill "$E3" 2>/dev/null; sleep 1
# Edge 2: two arms at once: exactly one runs, the other stands down for it.
sh "$W" "$LANE" > "$T/e2a.out" 2>&1 & X=$!
sh "$W" "$LANE" > "$T/e2b.out" 2>&1 & Y=$!
sleep 4
check "edge 2: two arms at once leave one watcher" "$(watchers | wc -l | tr -d ' ')" "1"
check "edge 2: the other said the lane is watched" "$(cat "$T/e2a.out" "$T/e2b.out" | grep -c 'already watched')" "1"
check "edge 2: the file names the one running" "$(watchers | awk '{print $1}')" "$(cat "$PF" 2>/dev/null)"
kill "$X" "$Y" 2>/dev/null; sleep 1
# Edge 4: a detached watcher is judged from the file, stopped and replaced.
( sh "$W" "$LANE" > "$T/e4orphan.out" 2>&1 & )
sleep 2
E4ORPHAN="$(cat "$PF" 2>/dev/null)"
sh "$W" "$LANE" > "$T/e4.out" 2>&1 & E4=$!
sleep 3
check "edge 4: the detached watcher the file named is stopped" "$(alive "$E4ORPHAN")" "gone"
check "edge 4: and the arm took its place in the file" "$(cat "$PF" 2>/dev/null)" "$E4"
kill "$E4" 2>/dev/null

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
