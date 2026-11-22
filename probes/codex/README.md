# The Codex probe kit

The probe in `anima_dev/nightwatch_providers_design.md` §6: before the Codex
adapter (PR B) is designed, the claims the 11/20 source read made about Codex
CLI are run against the version that's actually installed.

Everything here runs against a **sandbox `CODEX_HOME`**. By default that's
`~/.nightwatch-probes/codex/home`, with a scratch working directory beside it.
The kit refuses the real `~/.codex`, and refuses a run directory that is the
home folder or one of its parents.

**Logging in.** The sandbox is logged in by the account's owner:

    CODEX_HOME=~/.nightwatch-probes/codex/home codex login

`node probes/codex/probe.mjs status` prints that command, the codex version
and the login state. The kit never reads, copies or prints a credential.

**What each run costs.** A probe that calls the model spends on that login's
plan, so it runs only with `--spend`. Without it, each probe prints the exact
codex commands it would run and stops.

## The probes

| Probe | Question | Model turns |
|---|---|---|
| **P1** | Run a short session and read its rollout. What is the schema as written by this version? Is it a linear log, with ordinals, a mode, token counts and rate limits? Are injected rows marked? Is a version recorded? The session is asked to remember a random code word, which P6 and P8 ask for later. | 1 |
| **P6** | Plant P1's session as a NEW file by the §3b recipe. That means a fresh id, a canonical filename, `history_mode` and `history_base` removed, no ordinals, and token counts stripped. Then resume it and ask for the code word. If the reply contains it, the planted file was read and answered from, which is the existential question at run grade. The verdict also records whether resume appended to the planted file, and that the source was not touched. | 1 |
| **P8** | Two plants from the same source: one keeping every token count with its total inflated to 937,000 (`--inflate N`), and one stripped. Resume each and ask the same question. The verdict records what each did on its first turn: answered, compacted or refused, plus the token totals codex wrote afterwards. Does a stale total seed the woken session? | 2 |
| **P2** | `codex exec fork` P1's session. Is the original byte-identical afterwards, and is the fork a new file? | 1 |
| **P3** | `codex exec resume` P1's session itself. Does it append to the original, with the old bytes still the file's prefix? This is why a lane must never resume its archive. | 1 |
| **P4** | `codex debug prompt-input` before and after changing `AGENTS.md`. Is the new text what the model sees? This covers a fresh session only; the resumed-session half, and the "these instructions replace" notice, still need a resume run that isn't built yet. | 0 (it renders the prompt; unconfirmed whether rendering calls the service) |

**Order:** P1 first, then P6. P6 is the one that could change the design.
P8, P2, P3 and P4 follow; each later probe reads P1's latest result, or takes
`--from <rollout> --word <w>`.

**Not built yet:** P5 (hook events and payloads) and P7 (registering a hook
through the trust gate without an interactive prompt). Both want a hooks
config written into the sandbox, and the shape to write should come from P1's
run of this version rather than from the source read.

## Results

Each run writes `<run>/results/<probe>-<timestamp>/`:
- the exact command line;
- codex's `--json` output and stderr;
- the final message (`-o`);
- a copy of any rollout it created;
- `verdict.json`.

A verdict reports what was observed: hashes, byte counts, kinds of rows
appended, the reply's text. Nothing in it is inferred without a label.

## What's tested offline

`machinery/codex-probe-test.mjs` (in CI's `machinery/*-test.mjs` loop) tests
the file handling in `rollout.mjs`: parsing, the summary, canonical filenames
and the planter's promises. It uses a synthetic fixture, written from the
source read, so it tests the planter and **not** Codex's format. Confirming
the format is P1's job.

**Settings unconfirmed until P1 runs:** the read-only sandbox goes to
`exec resume` and `exec fork` as `-c sandbox_mode="read-only"`, because their
0.171.0 help has no `-s`. The key comes from Codex's docs, not from a run.
The `compacted` row is never synthesized. The planter takes a real one
captured from Codex, since its shape isn't settled at read grade.

Written by: claude-opus-5-5, 2026-11-21
