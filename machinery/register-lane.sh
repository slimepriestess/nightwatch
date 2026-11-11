#!/bin/bash
# SessionStart hook: record which LANE this session belongs to, so the
# nightshift daemon can attribute sessions by registry instead of guessing
# from cwd history. wake.sh exports NIGHTWATCH_LANE; a manually-opened panel
# has no lane named, writes nothing, and the daemon falls back to its heuristic.
# Runs inside the new session because only here does the session id exist —
# wake.sh cannot know it (--fork-session mints it at launch).
# SessionStart stdout lands in the session's context, so this prints only
# one thing, on purpose: the lane's instruction to arm its OWN bell watcher
# (Ra's ruling, 10/8: no lane's Nightwatch bell may depend on another agent
# being up). Skipped for the switchboard lane, whose doorbell watcher
# already watches the same spool (it would otherwise fire on DM notes too).
set -u
# Registry dir from the one config (item E); fall back to the script's own
# directory, which is where the registry has always lived — a hook that
# fails to resolve config must still register the lane, not exit silently.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# The node wake.sh exported to the claude that runs this hook (the daemon's), else the shell's.
NODE="${NIGHTWATCH_NODE:-node}"
# NIGHTWATCH_CONFIG and NIGHTWATCH_LANE are the names. WEFT_CONFIG and
# WEFT_LANE, from older installs, hooks and wakes, are read too (issue #7).
# Both config names set to different files is config.mjs's to refuse.
NW_CFG="${NIGHTWATCH_CONFIG:-${WEFT_CONFIG:-}}"
NW_LANE="${NIGHTWATCH_LANE:-${WEFT_LANE:-}}"
# The registry entry goes in the HUB's state dir. The named config is the hub;
# without it we use this script's own folder (the sealed layout) and NEVER
# config.mjs's fallback chain — that chain can resolve to a DIFFERENT hub's
# config on this machine, and a session must never register into another
# hub's registry (rehearsal finding, 10/7).
if [ -n "$NW_CFG" ]; then
  # A named config that fails to resolve is a REFUSAL, not a fallback:
  # falling back to this script's folder would register the session into
  # the CODE directory under the state/code split (walk finding, 10/10 —
  # config.mjs threw loudly and the || ate it).
  if ! REG="$("$NODE" "$SELF_DIR/config.mjs" get paths.wakecycle 2>/dev/null)"; then
    echo "register-lane: the hub config is named but unusable ($NW_CFG) — not registering" >&2
    exit 1
  fi
else
  REG="$SELF_DIR"
fi
# Prune stale entries so the registry never grows unboundedly, but never a
# running session's: this runs on every SessionStart in the hub, and a lane
# with no nightly fold (midday only) can run one session for longer than a
# week, so an entry stays while its recorded claude is alive (#69).
for f in "$REG"/lane.*; do
  [ -f "$f" ] || continue
  [ -n "$(find "$f" -mtime +7 2>/dev/null)" ] || continue
  pid=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$f")
  if [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q claude; then continue; fi
  rm -f "$f"
done
[ -z "$NW_LANE" ] && exit 0
SESSION_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0
# $PPID is the shell's parent: the claude process that spawned this hook.
printf '{"lane":"%s","pid":%d,"at":"%s"}\n' "$NW_LANE" "$PPID" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$REG/lane.$SESSION_ID"
SWITCH="$("$NODE" "$SELF_DIR/config.mjs" get "lanes.$NW_LANE.switchboard" 2>/dev/null || echo false)"
if [ "$SWITCH" != "true" ]; then
  CFGPFX=""
  [ -n "$NW_CFG" ] && CFGPFX="NIGHTWATCH_CONFIG=$NW_CFG "
  echo "Nightwatch: this session is the $NW_LANE lane. Arm your bell watcher now, as a background task: ${CFGPFX}sh $SELF_DIR/bell-watcher.sh $NW_LANE — its exit is your sleep-bell (or a Fold now). When it fires: read the note, do what it says, delete the note file, and re-arm the watcher if you're staying up."
fi
exit 0
