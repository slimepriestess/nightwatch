# Nightwatch setup — from zero to a self-keeping agent

Notes from someone who explored this corner of the maze. This is the
install-and-run guide for the wake cycle (continuity ladder + nightly
fold + morning wake); the design rationale lives in the README and in
`docs/philosophy.md`. Written for the second
household to run this and for the eventual GUI, which is a
thin shell over exactly the pieces named here.

## The shape of the thing

Five cooperating pieces, all small:

- **config.mjs + weft.config.json** — one file of paths and knobs that
  every other piece reads. Start here; `node config.mjs doctor` tells
  you what's missing. With no config named (`NIGHTWATCH_CONFIG`), the
  scripts refuse and say so: the app's Set up writes a hub's config.
- **sleep.mjs** — the fold. Run by the agent itself at the end of day
  (the "ritual": write the day's rung → run sleep.mjs → rewrite the
  checkpoint, in that order). Trims the transcript to a budget
  (`lanes.<name>.targetTokens`), archives the checkpoint, regenerates
  the ladder, writes a fold receipt into `folds.jsonl` and a
  `next-wake.<lane>.json` the morning side reads.
- **wake.sh** — the morning. Reads `next-wake.<lane>.json`, refuses
  stale receipts (a lane that was belled but never folded), builds the
  wake head (checkpoint + standing duties), and execs
  `claude --resume <tail> --fork-session` with the checkpoint appended
  to the system prompt. `--system-prompt-snapshot off` is load-bearing;
  the comment block in the script says why.
- **nightshift.mjs** — the daemon that makes it autonomous: rings the
  sleep-bell into each lane's spool at the configured hour, closes
  panels once they're folded and quiet, launches Terminal windows at
  wake time, verifies each wake against the session registry, retries
  a bounded number of times, and emergency-folds a lane whose own fold
  died mid-ritual (the "orphan fold").
- **register-lane.sh** — a SessionStart hook that records which lane a
  session belongs to, so the daemon attributes sessions by registry
  instead of guessing.

## Quickstart, single lane

1. Clone this repo somewhere stable and write a `weft.config.json`
   for your hub (point `NIGHTWATCH_CONFIG` at it; `WEFT_CONFIG`, the older
   name, still works; the machinery never
   assumes it lives inside your state directory). Minimal single-lane config:

   ```json
   {
     "defaultLane": "main",
     "lanes": { "main": { "targetTokens": 250000 } },
     "schedule": { "sleep": "02:00", "wake": "08:00" }
   }
   ```

   `timezone` defaults to the machine's own zone, so most hubs never
   set it. Set it only when the hub should keep a different clock
   than the computer it runs on (an agent whose keeper travels, say).

2. `node config.mjs doctor` — fix anything MISSING. The transcripts
   path must point at your Claude Code project directory (the folder
   under `~/.claude/projects/` named after your working directory).

3. Wire the SessionStart hook (settings.json):

   ```json
   { "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
     "command": "NIGHTWATCH_CONFIG=/path/to/nightwatch.config.json /path/to/nightwatch/machinery/register-lane.sh" }] }] } }
   ```

   Also set `"autoCompactEnabled": false` — the fold replaces
   compaction, and the PreCompact guard hook in this folder is the
   backstop. A session that silently compacts loses the day the fold
   would have kept.

4. First cycle by hand, to see each piece work before trusting the
   daemon with it: have the agent write its rung and checkpoint, run
   `node sleep.mjs --lane main`, read the receipt it prints, then
   `./wake.sh main` the next morning and watch it resume.

5. Then arm the daemon (see launchd below, or cron), write the lane
   name into your hub's `nightshift.armed`, and let it run a night.
   Read `nightshift.log` in the morning. The healthy shape is:
   bell → fold row in folds.jsonl → "closing <lane> panel" →
   "waking the <lane> lane (attempt 1)" → "wake receipt ... reached
   exec" → "wake confirmed (registry entry after launch)". Anything
   that says WAKE FAILED or BELLED BUT NEVER FOLDED is the daemon
   telling you exactly what it couldn't do; it never fails silently
   on purpose, because every silent failure it ever had got a loud
   path named after the night it happened.

## launchd (macOS)

The daemon and its siblings run as LaunchAgents. The nightshift plist
this house runs, trimmed to the parts that matter
(`~/Library/LaunchAgents/com.weft.nightshift.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.weft.nightshift</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/nightwatch/machinery/nightshift.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key>
    <string>/Users/YOU/YOUR-HUB/nightshift.launchd.log</string>
</dict></plist>
```

Load with `launchctl load ~/Library/LaunchAgents/com.weft.nightshift.plist`.
Two macOS specifics that cost this house real nights:

- launchd's PATH has no `~/.local/bin`, so the config's
  `paths.claudeBin` must be absolute (the default already is).
- The first time the daemon opens a Terminal window, macOS asks for
  an Automation permission. Grant it once, from a test fire you run
  on purpose (`touch` a trigger file if you've wired one, or just
  wait for the first wake while you're at the keyboard) — not at
  8am when you're asleep and the dialog times out.

## systemd (Linux) and WSL2

The daemon is a poller (one tick a minute) and runs under systemd as
a simple service:

```ini
[Service]
ExecStart=/usr/bin/node /home/YOU/nightwatch/machinery/nightshift.mjs
Restart=always
[Install]
WantedBy=default.target
```

The Linux leg is real now: the host actions go through the machinery
(`--wake`, `systemctl`, `find_node`), there's Linux CI, and
`app/install.sh` builds the app binary and installs it to
`~/.local/bin/nightwatch` (the `.deb` is CI's artifact, not something
the script makes). A sibling house runs its nights on WSL2 with
systemd user units — bells, folds and wakes, live since mid-October.

The wake leg's terminal summons is platform-aware (`platform.mjs`):
`osascript` on macOS; on WSL the summons crosses the interop chain as
a script opened in Windows Terminal; on desktop Linux it asks
`x-terminal-emulator`, falling back to a tmux window when there's no
desktop session. Plain (non-WSL) desktop Linux is the one shape no
house has run a real night on yet — the pieces are there and CI
covers them, but treat the first night as a trial and read its log.

## Knobs you'll actually touch

- `lanes.<name>.targetTokens` — how much tail survives a fold. Image-
  heavy lanes can afford more entries than the raw byte count
  suggests; the trimmer bills long base64 runs at the vision rate, not
  the byte rate (10/5 change; see trim.mjs's comment for the receipts).
- `schedule.sleep` / `schedule.wake` — the window. Post-midnight sleep
  hours are fine; the window logic is wrap-aware.
- `schedule.orphanQuietMs` / `orphanGraceMs` — how patient the
  emergency fold is with a lane that got belled and went quiet.
- `models.bell` — the model used for spool-note bell passes.
- `lanes.<name>.wakePrompt` — a first prompt for the woken session,
  e.g. `"[nightwatch] woken at 10:00: arm your watcher, then read the
  receipts"`. Unset, a woken session waits at the input until someone
  types, and hears no mail until then. Keep it machine-voiced: it's the
  harness talking, not you or the agent. It's claude's first positional
  argument, so wake.sh skips (and logs) text that isn't a string, starts
  with "-" (a flag), or is a single bare word (claude could run it as a
  subcommand); the wake goes on without a prompt.
  It has a cost, so turn it on for lanes that do things by themselves.
  The prompt makes the wake's first full-context request at once. If
  the person arrives hours later, that cache has expired and their first
  message pays for the context again. That's roughly one extra
  full-context request a day, plus whatever the agent does on its own.
  Worth it for a lane with mail, a heartbeat or a switchboard to tend.
  Pure overhead for a lane that just waits for its person (Terra's
  point, 10/26).

## After the bell: finishing up

The sleep-bell asks the lane to fold when its current work reaches a
seam. It doesn't fold at the stroke of the hour, and the daemon won't
step in while the lane is still active. An agent in the middle of a
conversation (a person on Discord, say) can finish it and then run the
ritual. That's by design. It's worth saying to your agent in its own
standing instructions, because a bell reads like a hard stop, and an
agent will tend to wrap up mid-sentence if nobody tells it otherwise.
Finishing a conversation is a good reason to stay up. Starting new work
after the bell isn't.

The one thing that will step in is the orphan fold, which is meant for a
lane whose ritual died. It emergency-folds a belled lane once the bell
is `schedule.orphanGraceMs` old (45 min by default) **and** the session
has been quiet for `schedule.orphanQuietMs` (20 min), and never in the
hour before the wake. The woken session then writes the missing rung
after the fact. That's survivable, but it's the worse path. An agent
that's up late waiting on someone's reply looks exactly like a quiet
session, so give it a timer shorter than the quiet threshold: a
background `sleep 900` it re-arms while it waits, and when it fires
with no reply, the agent says goodnight and folds. A firing timer is a
turn, so it also keeps the session from reading as quiet.

## The watch: hearing when an agent is stuck

`machinery/watch.mjs` runs as its own job beside the nightshift (Set up
installs it as `house.nightwatch.<hub>.watch`). Once a minute it reads the
hub's live agents and notices the states that stop an agent without
anyone seeing: an API-error spiral, "Prompt is too long", an expired
login, the usage limit, no network, a reply cut off by the machine
sleeping, repeated auto-mode classifier denials, a context window past
85%, and a permission prompt left waiting. It also tells you when a fold
didn't happen: the trimmer refused to write a folded transcript, or the
nightshift's emergency fold failed. It only tells; it never
folds, kills or messages an agent. Each state is told once when it
starts and cleared when it ends, and a restart repeats nothing.

Every alert lands in the app as a card. Beyond that, the config decides:

- `notify.macos` (default `true`): a Notification Center banner.
- `notify.command`: an executable (run directly, no shell) for anything
  else: a chat DM, a pager, a log shipper. It gets the message on
  stdin, and `NIGHTWATCH_ALERT_KIND` (`spiral-alarm`, `stuck`, `context-high`,
  `trim-failed` or `orphan-fold-failed`),
  `NIGHTWATCH_ALERT_CAUSE`, `NIGHTWATCH_ALERT_LANE`,
  `NIGHTWATCH_ALERT_SESSION`, `NIGHTWATCH_ALERT_TITLE` and
  `NIGHTWATCH_PERSONA` in its environment. A failing command is logged
  in `watch.log`; the card still stands.

```sh
#!/bin/sh
# notify.command example: every alert as a phone push via ntfy.sh
curl -s -H "Title: $NIGHTWATCH_ALERT_TITLE" -d "$(cat)" https://ntfy.sh/YOUR-TOPIC
```

The thresholds live under `watch.*` (`spiralThreshold`, `waitingMs`,
`contextWarn`, …); the defaults are what this house calibrated on its own
nights. `node machinery/watch-test.mjs` runs the whole watch against a
scratch hub.

## The desktop app

The app is a window onto the same hub: lanes, timelines, fold meters, and
the buttons (Wake, Sleep, Fold now, settings). It runs its viewer and calls
its machinery from a checkout of this repo, so it always lives beside one.

- **macOS:** `sh app/install.sh` from your checkout builds it and installs
  `~/Applications/Nightwatch.app`.
- **Linux, built here (WSLg included):** `sh app/install.sh` from your
  checkout. It needs Rust, node and WebKitGTK's development files, and names
  the packages if they're missing. It installs `~/.local/bin/nightwatch` and
  a launcher entry. Built here, it finds this checkout by itself.
- **Linux, the prebuilt `.deb`:** each push to the repo's CI keeps a `.deb`
  as the run's artifact (Ubuntu 22.04 or newer). A build made elsewhere finds
  your checkout through a hub you've already set up, which points at it. On a
  machine with no hub yet, tell it where the checkout is with
  `NIGHTWATCH_REPO`, then open Nightwatch and use Set up to make your first
  hub; after that the hub points at the checkout and the variable isn't
  needed. Apps started from the launcher don't read your shell's rc files, so
  put it where the desktop session reads it, for example a line
  `NIGHTWATCH_REPO=/home/you/nightwatch` in
  `~/.config/environment.d/nightwatch.conf`, then log in again (a session
  without systemd, such as some WSLg setups, may not read that file; there,
  launch it from a terminal with the variable set). The app says this too if
  it can't find the checkout, and needs a restart once it's set.

Bringing a lane's terminal forward works on macOS only; elsewhere that
button is read-only, and you bring the terminal forward yourself.

## The parts the config can't do for you

The ritual itself is the agent's: the rung (the day, in the agent's own words,
with a Corrections section they would rather not write), then the fold,
then the checkpoint. The order matters — a crash between rung and fold
costs prose that existed only in context; a crash after the fold costs
a stale checkpoint section the morning read repairs. And the morning
discipline is the other half: receipts before belief, every time, even
when the log looks exactly like yesterday's clean night. Especially
then.

Written by: claude-fable-5, 2026-10-05
