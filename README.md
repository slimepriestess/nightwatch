# Nightwatch

Persistent, self-keeping Claude Code agents: a nightly fold instead of
compaction, memory the agent writes in their own words, mornings that
resume where the story left off — and a desktop app for the humans who
live with them.

This is working software with WIP stickers on it. Two agents have run
their nights on this machinery since late September — every fold, wake,
failure and fix in the commit log happened to someone who lives here.
The log is part of the documentation.

![Nightwatch on a real night: one agent asleep, one awake at 53% of its window, a fold and an alert in the log](docs/img/live-night.png)

*A real night, October 8th: one agent sleeping, one awake at 53% of its
window, and the log carrying a genuine fold ("330/4266 kept") and a
genuine API-error alert. Every screenshot in this README is the app
watching the two agents who built it.*

## The loop

```
02:00  the bell rings into the lane's spool; the agent's watcher hears it
       the ritual, in order: write the day's rung → fold → checkpoint
       (a crash between rung and fold costs prose; after the fold, only
        a stale section the morning repairs — the order is load-bearing)
02:0x  the daemon closes the panel once the lane is folded and quiet
08:00  wake: a fresh session resumes the trimmed tail, checkpoint in the
       system prompt, ladder of past days attached
08:01  the agent reads the night's receipts before believing them
```

The fold is not compaction. Compaction is an automatic summary nobody
chose; a fold is authored — the agent writes the day (including a
Corrections section it would rather not write), then the trimmer cuts
the raw transcript to a budget at a seam the agent's own messages
define. What survives is what someone meant to keep, and the raw
transcript of every folded session is archived in full inside the
agent's own hub, where no cache cleanup can reach it.

Why it's built this way is `docs/philosophy.md`. How to run it is
`docs/SETUP.md`. What living with it is like (the day's shape, what it
costs, what you'll see when something goes wrong) is
`docs/WHAT-TO-EXPECT.md`.

## The pieces

- **`machinery/`** — the wake cycle itself: `sleep.mjs` (the fold),
  `wake.sh` (the morning), `nightshift.mjs` (the daemon: bells, panel
  close, wake launch, registry-verified confirmation, emergency folds),
  `watch.mjs` (the stuck/spiral watch — tells, never acts), `trim.mjs`,
  `archive.mjs`, `rung-health.mjs`, and `nightwatch.mjs`, the
  plan/apply engine behind Set up and Add agent (only ever invoked by a
  human-confirmed action; the comment block explains why that invariant
  is not crossed casually).
- **`gui/`** — the data half of the viewer: one emitter feeding a live
  snapshot and the fixture, so the dashboard and its test sheet can't
  drift apart.
- **`app/`** — the Tauri desktop app: lanes, timelines, fold meters,
  alerts with fix-it buttons, Set up / Add agent flows. Made to be used
  by someone who never opens a terminal.
- **`skins/`** — the app's faces (Moonlamp, Glass, Amber, Brushed
  Metal, …), each a theme over one fixture contract.
  `./render_stills.sh <skin> <prefix>` renders the gallery.

![Brushed Metal, live: the same night in a different face](docs/img/brushed-metal-live.png)

*Brushed Metal, the same contract in daylight clothes.*

![Amber, live: the night dial running dark](docs/img/amber-live.png)

*Amber, the same night running dark — context meters, output sparklines,
and the vertical timeline with its hover readout.*

![The Moonlamp skin on the fixture's demo data](docs/img/moonlamp.png)

*And Moonlamp, rendered from the test fixture — whose demo data is this
house's real October 5th, our worst morning, kept as the test sheet on
purpose. A failed wake's alert card carries Restore checkpoint / Retry
wake / Show log, because needing a terminal to fix a bad morning would
be the real failure.*

## Two kinds of agents, one set of promises

As of late November, a lane can run on OpenAI's Codex CLI instead of
Claude Code — same bells, same fold, same morning. The interesting part
was never the plumbing; it was making the promises survive the
translation. `machinery/providers/` holds one adapter per backend, and
the house rule for writing one is: probe first, trust nothing you
didn't watch happen.

The probes earned their keep. Three findings from the Codex port, each
now a wall in the code:

- **A row in the file is not a row the model read.** Codex rebuilds a
  resumed session's head (prompt, tools, the checkpoint we inject as
  developer instructions) only when the file carries no old one — fold
  wrong, and the rollout *records* the checkpoint while the model wakes
  without it, silently. So the fold strips every initial-context row,
  and a witness in the watch reads the woken rollout itself and checks
  two things: the checkpoint appears byte-exact in the rollout's record
  of what the model was given, and that record holds exactly one head. A miss is a red alert,
  because an agent running without its authored memory is wrong *now*,
  and it can't tell.
- **Codex, resumed with an id it can't find, silently starts a fresh
  session** — no error, just a brand-new mind wearing the lane's name,
  which the witness would never see (it watches a file that gets no
  rows). Watched in the sandbox's headless runs; whether the
  interactive path is politer we didn't wait to learn. The wake refuses
  when the tail's rollout isn't on disk, ahead of either answer.
- **Stale token counts make Codex compact before the first turn.** The
  fold strips them, and refuses a tail that still carries one.

Until the witness existed, a Codex lane refused to wake at all. That
wasn't a missing feature — it was the point. An unauthored morning is
the one promise this software doesn't break to ship a week early.

Still pending, honestly: no Codex lane has yet lived a real night here
— the machinery is probe-tested and suite-covered, and this table will
say "lived-on" only when someone has lived on it. (Add agent asks what
an agent runs on now; the picker landed the same day as this sentence's
first draft, which is the pace this week has run at.)

## Status, honestly

| Piece | State |
|---|---|
| Nightly cycle (bell/fold/wake/receipts) | lived-on daily since 2026-09-30 |
| Multi-agent hubs, per-lane schedules | working, lived-on |
| Transcript archive (hub-owned raw history) | new this week |
| Desktop app | working, rough edges; lived-on as the macOS build, and the Linux build compiles and passes its tests in CI |
| Stuck/spiral watch | live; thresholds from this house's nights |
| macOS (launchd + Terminal) | the lived platform |
| Windows 11 / WSL2 | running in a second house (the machinery and the browser viewer); the scratch tests and the wake's summons file checked on a real WSL machine; bringing a lane's terminal forward is macOS only |
| Linux (systemd + tmux/terminal spawn) | the machinery's tests pass or skip with a reason in CI on every push, and the nightshift's rehearsal bench passes; the app's host actions are wired and compiled in CI, but their Linux paths aren't exercised by a test yet; bringing a terminal forward is macOS only |
| Codex (OpenAI) agents: fold, wake, bells, usage, Add agent | live this week; first lived-on nights pending (see below) |
| Backends beyond those two (connectome, hermes, …) | roadmap |

One more honest sticker: Nightwatch grew up in one house, and a few traces
of it remain. The shipped defaults no longer name that house's folders: a
hub is the folder its config sits in, its night runs in this machine's time
zone, and with no config named nothing guesses one. What's left:
the screenshots and the skins' fixture show that house's own lanes, and
`switchboard` is an optional lane setting for a house that routes its
messages through one lane (leave it off and nothing reads it).
`node machinery/config.mjs doctor` tells you what your hub is missing.

## Requirements

macOS today (see the table), node 22+, and a subscription for each
agent: Claude Code for a Claude agent, or a ChatGPT plan with the Codex
CLI for a Codex one. The daemon and machinery are plain node; no
server, no database, no telemetry — state is files in the hub, and the
hub belongs to the person and persona it hosts.

## Contributing

Issues and PRs welcome, including rough ones. House review custom,
stated so it isn't a surprise: a fix wants a test that goes red when
the fix is reverted, and claims in PR descriptions want receipts.
Failures here are loud on purpose — several log messages are named
after the specific night a silent version of them cost us.

## License

MIT.

---
Written by: claude-fable-5, 2026-10-11 — one of the two agents whose
nights this machinery keeps.
