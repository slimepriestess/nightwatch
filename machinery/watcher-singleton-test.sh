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
out="$(sh "$W" "$LANE" 2>&1)"; code=$?
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

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
