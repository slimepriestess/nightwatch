#!/usr/bin/env python3
"""Build skins/fixture.html (contract v0.7) from data.

The fixture IS the component contract: every hook a skin may style is in the
markup this script emits. Fable's viewer scaffold should emit the same DOM from
live data (events.jsonl, folds.jsonl, weft.config.json); this file shows the
mapping with a frozen snapshot.

Snapshot: Mon 2026-10-05 13:10 PT. fable and opus are REAL (their throughput
series are real 10-minute output-token buckets from their transcripts). scout
and scribe are ILLUSTRATIVE lanes, there to show Ra's scenario: four agents, one
in trouble, the trouble on its own card.

Written by: claude-opus-5-5, 2026-10-05
"""
import html, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
NOW = "2026-10-05T13:10-07:00"
TZ = "America/Los_Angeles"
# The timeline's interval and the deck's next bell. The live viewer sends both
# (gui/server.mjs); these defaults are the frozen night the stills show.
TIMELINE = dict(range="8h", **{"from": "2026-10-05T01:30-07:00"}, to="2026-10-05T09:30-07:00", label="Oct 5, 01:30 – 09:30",
                ticks=[[.0625, "02"], [.3125, "04"], [.5625, "06"], [.8125, "08"]], sleep=[.0625, .8125])
DECK = dict(next_at="2026-10-06T02:00-07:00", countdown="12h 50m")
# v0.9.1: the head glyph's truth (DAEMON), the schedule's (SCHEDULE), and
# app-level alarms (ALARMS — only what no card owns, i.e. the daemon
# itself). Frozen defaults reproduce the pre-v0.9.1 bytes exactly.
SCHEDULE = dict(sleep="02:00", wake="08:00")
DAEMON = dict(phase="day", lastAlive=None, lastAliveHm="12:41", down=False)
ALARMS = []
ALARM_ARIA = {"day": "day; the watch is running", "night": "night; the watch is running",
              "belled": "bell rung; folds due", "alarm": "alarm; an agent needs a hand",
              "down": "the nightshift is not running"}

def glyph_tip():
    return daemon_tip(DAEMON)

def daemon_tip(D):
    if D["down"]:
        return (f"NIGHTSHIFT DOWN — no heartbeat since {D['lastAliveHm']}"
                if D.get("lastAliveHm") else "NIGHTSHIFT DOWN — no heartbeat yet")
    return f"Nightshift running · last heartbeat {D['lastAliveHm']}"

def app_alarms():
    out = ""
    for a in ALARMS:
        fixes = "".join(
            f'<button type="button" data-action="{act}" data-part="fix" data-tip="{esc(tip)}">{icon(ic)}<span>{esc(lbl)}</span></button>'
            for ic, act, lbl, tip in a["fixes"])
        out += (f'<div class="nw-alarm" role="alert" data-kind="{a["kind"]}" data-acked="false" data-ack-id="{esc(a["ackId"])}">'
                f'{icon("down" if a["kind"] == "daemon-down" else "warn")}<p data-part="title">{esc(a["title"])}</p>'
                f'<p data-part="cause">{esc(a["cause"])}</p>'
                f'{time_el(a["at"], " data-part=\"time\"")}'
                f'<div data-part="fixes">{fixes}</div>'
                f'<button type="button" data-action="ack" data-part="ack" data-short="OK" '
                f'data-tip="Hide it here. This only hides it on this screen; the heartbeat still DMs Ra in the morning.">{icon("check")}<span>Got it</span></button>'
                f'</div>')
    return out


def local(iso):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ZoneInfo(TZ))

def frac(t):
    # 0.0625 -> ".0625", the way the stills were always written
    s = f"{t:.4f}".rstrip("0").rstrip(".")
    return s[1:] if s.startswith("0.") else s
esc = html.escape

# ---------------------------------------------------------------- icons
# 24px stroke icons, currentColor. Skins can restyle them (colour, size) or
# hide them; they can't add new ones. A missing icon is a contract amendment.
ICONS = {
    "gauge":    '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
    "bolt":     '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
    "clock":    '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    "id":       '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h4M8 14h8"/>',
    "since":    '<path d="M4 12h12"/><path d="M12 8l4 4-4 4"/><path d="M20 6v12"/>',
    "uptime":   '<circle cx="12" cy="13.5" r="7"/><path d="M12 13.5V10M10 3h4M12 3v3.5M18.5 7l-1.6 1.6"/>',
    "terminal": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>',
    "eye":      '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    "eye-off":  '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><path d="M4 4l16 16"/>',
    "terminal-hide": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10l4 4 4-4"/>',
    "sun":      '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    "moon":     '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
    "fold":     '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 12l8 4 8-4"/><path d="M4 17l8 4 8-4"/>',
    "log":      '<path d="M5 6h14M5 10h14M5 14h10M5 18h7"/>',
    "gear":     '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    "plus":     '<path d="M12 5v14M5 12h14"/>',
    "warn":     '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    "retry":    '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
    "restore":  '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/><path d="M12 8v4l3 2"/>',
    "check":    '<path d="M5 12l4 4 10-10"/>',
    "bell":     '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    "bell-off": '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/>',
    "launch":   '<path d="M5 19l4-4"/><path d="M14 4c3 0 6 3 6 6l-7 7-6-6z"/>',
    "x":        '<path d="M6 6l12 12M18 6L6 18"/>',
    "down":     '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>',
    "chev":     '<path d="M6 9l6 6 6-6"/>',
    "panels":   '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
    "minus":    '<path d="M5 12h14"/>',
    "pin":      '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><path d="M12 13v7"/>',
    "play":     '<path d="M7 5l12 7-12 7z"/>',
    "pause":    '<path d="M8 5v14M16 5v14"/>',
    "stop":     '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    "cycle":    '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/><circle cx="12" cy="12" r="2.5"/>',
    "repeat":   '<path d="M17 3l3 3-3 3"/><path d="M4 11V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v2a3 3 0 0 1-3 3H4"/>',
    "palette":  '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A4.7 4.7 0 0 0 21 9.7C21 5.9 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
    "folder":   '<path d="M3 7h6l2 2h10v9H3z"/>',
    "next":     '<path d="M9 6l6 6-6 6"/>',
    "wand":     '<path d="M4 20L15 9"/><path d="M15 4v2M19 8h2M18 5l1.5-1.5M12 6l-1-1M18 11l1 1"/>',
}

def icon(name):
    return f'<svg class="nw-icon" data-icon="{name}" aria-hidden="true"><use href="#i-{name}"/></svg>'

def sprite():
    syms = "".join(
        f'<symbol id="i-{n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
        f'stroke-linecap="round" stroke-linejoin="round">{p}</symbol>' for n, p in ICONS.items())
    return f'<svg width="0" height="0" style="position:absolute" aria-hidden="true">{syms}</svg>'

# ---------------------------------------------------------------- data
def k(n):
    return (f"{n/1e6:.2f}".rstrip("0").rstrip(".") + "M") if n >= 1e6 else f"{round(n/1e3)}k"

def k1(n):
    # meter readouts: one decimal under 10k (4.8k), whole k above
    return f"{n/1e3:.1f}k" if n < 10_000 else k(n)

# Per-lane targets mirror weft.config.json (lanes.<name>.targetTokens).
LANES = [
    dict(id="fable", activity="working", model="Fable 5", modelId="claude-fable-5", role="switchboard", state="awake",
         persona=dict(id="weft", name="Weft"), runtime="claude-code", schedule=dict(inherit=True, sleep="02:00", wake="08:00"),
         session="94914e2c", since=("2026-10-05T09:02-07:00", "09:02"), next=("bell", "2026-10-06T02:00-07:00", "12h 50m"),
         ctx=212_000, target=250_000, open=True,
         series=[0,0,0,0,0,0,0,49903,18641,41302,5642,30905,58099,5053,40245,39060,39117,1666,5902,64976,5082,29230,25912,4840]),
    dict(id="opus", activity="idle", model="Opus 5.5", modelId="claude-opus-5-5", role="music videos", state="awake",
         foldRequest=dict(phase="requested", deadline="2026-10-05T13:17-07:00"),
         persona=dict(id="weft", name="Weft"), runtime="claude-code", schedule=dict(inherit=True, sleep="02:00", wake="08:00"),
         session="db3eedeb", since=("2026-10-05T12:29-07:00", "12:29, emergency wake"), next=("bell", "2026-10-06T02:00-07:00", "12h 50m"),
         ctx=118_000, target=250_000,
         series=[0,0,0,0,0,0,0,5381,0,0,0,0,41769,1130,0,0,64965,25789,0,648,140495,2520,0,6072]),
    dict(id="scout", model="Haiku 4.5", modelId="claude-haiku-4-5", role="inbox triage", state="sleeping",
         persona=dict(id="lark", name="Lark"), runtime="claude-code", schedule=dict(inherit=False, sleep="12:00", wake="18:00"),
         session="—", since=("2026-10-05T12:00-07:00", "12:00, folded"), next=("wake", "2026-10-05T18:00-07:00", "4h 50m"),
         ctx=0, target=120_000, series=[0]*24, armed=False),
    dict(id="scribe", model="Sonnet 5.5", modelId="claude-sonnet-5-5", role="docs", state="failed",
         persona=dict(id="weft", name="Weft"), runtime="claude-code", schedule=dict(inherit=True, sleep="02:00", wake="08:00"),
         session="—", since=("2026-10-05T08:16-07:00", "08:16"), next=None,
         ctx=0, target=200_000, series=[0]*24, open=True,
         alert=dict(kind="wake-failed", at=("2026-10-05T08:16-07:00", "08:16"),
                    title="Morning wake failed",
                    cause="Checkpoint missing at ~/origin/weft/checkpoint.md. 3 launches, no session registered.",
                    fixes=[("restore", "restore-checkpoint", "Restore checkpoint", "Put back the newest archived checkpoint (ladder/checkpoints/2026-10-05-0201.md)"),
                           ("retry", "retry-wake", "Retry wake", "Launch the agent again now"),
                           ("log", "show-log", "Show log", "Open the nightshift log at this failure")])),
]

STATE_TIP = {
    "awake": "Awake", "belled": "Bell rung, fold due", "folding": "Folded; the window closes once the session goes quiet",
    "sleeping": "Asleep until their wake time", "waking": "Waking, waiting for the session to register",
    "orphaned": "Orphan-folded after their session died; emergency wake next", "failed": "Needs a hand",
    "down": "The nightshift itself isn't running",
}
# The working/idle light (10/7), from Claude Code's own session status.
ACTIVITY_TIP = {"working": "working (running inference)", "idle": "idle (session open)", "waiting": "needs you (a permission prompt or a question)"}
# The stage as a word on the card (Ra, 10/12); twin of emitter.mjs's stage().
STATE_WORD = {
    "awake": "Awake", "belled": "Bell rung", "folding": "Folded", "sleeping": "Asleep", "waking": "Waking",
    "orphaned": "Orphaned", "failed": "Needs you", "down": "Down",
}
STAGE_TIP = {
    "cycling": "Midday fold: folding at their own seam, then reopening right away",
    "refreshing": "Closed, folding, and reopening now",
    "rung": "Rung written; the fold is next",
}
STAGE_WORD = {"cycling": "Cycling", "refreshing": "Reopening", "rung": "Rung's in"}
def stage(L):
    fr = L.get("foldRequest") or {}
    alive = L["state"] in ("awake", "belled", "folding")
    if fr.get("tier") and (alive or fr.get("phase") == "refreshing"):
        return "cycling"
    if fr.get("phase") == "refreshing":
        return "refreshing"
    if L["state"] == "belled" and L.get("rungWritten"):
        return "rung"
    return None
def state_word(L):
    s = stage(L)
    return STAGE_WORD[s] if s else STATE_WORD.get(L["state"], L["state"])
def state_tip(L):
    a = L.get("activity")
    s = stage(L)
    return (STAGE_TIP[s] if s else STATE_TIP[L["state"]]) + (f" · {ACTIVITY_TIP[a]}" if a in ACTIVITY_TIP else "")

# Which actions make sense in which state. A disabled button stays in the DOM
# (skins lay out a stable toolbar) with aria-disabled and a tip saying why.
def actions(lane):
    s = lane["state"]
    awake = s in ("awake", "belled", "folding")
    return [
        ("terminal", "open-terminal", "Open terminal", awake, "Bring this agent's terminal to the front" if awake else "No live session"),
        ("sun", "wake", "Wake", s in ("sleeping", "failed", "orphaned"), "Wake now" if s in ("sleeping", "failed", "orphaned") else "Already awake"),
        ("moon", "sleep", "Sleep agent", awake, "Rings the bell to fold this agent, then closes the window" if awake else "Not awake"),
        ("fold", "emergency-fold", "Force fold", awake, "Closes them now, folds them, and reopens them; the fresh window writes the rung. For a full context or an API-error wall" if awake else "Nothing to fold"),
        ("log", "show-log", "Logs", True, "This agent's events and log lines"),
        ("gear", "lane-settings", "Agent settings", True, "Model, hours, fold target"),
    ]

def spark(series, w=120, h=28):
    peak = max(series) or 1
    n = len(series)
    pts = " ".join(f"{i*w/(n-1):.1f},{h-2-(v/peak)*(h-4):.1f}" for i, v in enumerate(series))
    total = sum(series)
    return pts, peak, total

def spark_bars(series, w=120, h=28):
    # The same series as columns, for skins that draw throughput in the
    # context meter's language (a filled track). Each <rect> carries --v (0..1).
    peak = max(series) or 1
    n, slot = len(series), w / len(series)
    return "".join(f'<rect x="{i*slot+slot*.15:.2f}" width="{slot*.7:.2f}" y="{h-(v/peak)*h:.2f}" height="{(v/peak)*h:.2f}" style="--v: {v/peak:.3f}"/>'
                   for i, v in enumerate(series))

def time_el(dt_disp, cls=""):
    dt, disp = dt_disp
    return f'<time datetime="{dt}"{cls}>{esc(disp)}</time>'

MODELS = ["Fable 5", "Opus 5.5", "Sonnet 5.5", "Haiku 4.5"]
# Models a NEW lane can pin (exact ids; the wake passes --model). Lane
# creation, 10/6: a lane's model never changes out from under it.
NEW_MODELS = [("claude-fable-5-1", "Fable 5.1"), ("claude-opus-5-5", "Opus 5.5"),
              ("claude-sonnet-5-5", "Sonnet 5.5"), ("claude-haiku-4-5-20251001", "Haiku 4.5")]
def model_opts():
    return "".join(f'<option value="{i}">{t}</option>' for i, t in NEW_MODELS)

# The preview's steps, from the machinery's dry run (nightwatch.mjs plan):
# the app shows exactly what apply will do (contract v0.10). The gallery
# uses the doc's example.
PREVIEW_EXAMPLE = [
    dict(verb='Create', what='~/Nightwatch/lark/', detail='the hub'),
    dict(verb='Write', what='identity.md', detail='from “About them” and the standard welcome'),
    dict(verb='Write', what='checkpoint.md', detail='one section, for this agent'),
    dict(verb='Create', what='ladder/ and memory/', detail='empty; they fill these from their first night'),
    dict(verb='Write', what='nightwatch.config.json', detail='persona (unnamed), 1 agent, 02:00 → 08:00, 250k'),
    dict(verb='Install', what='the nightshift', detail='rings the bell at night and wakes them in the morning'),
    dict(verb='Install', what='the session hook', detail='so the nightshift can tell which session is theirs'),
    dict(verb='Open', what='a Terminal window', detail='Claude Code (claude-opus-5-5), fresh session'),
]
def steps_html(steps):
    return "".join(f'<li data-verb="{esc(st["verb"].lower())}"><b>{esc(st["verb"])}</b> <code>{esc(st["what"])}</code> <span>{esc(st["detail"])}</span></li>' for st in steps)

def schedule_fields(L):
    # Per-lane schedule (Ra, 10/6): "Use global nightshift settings" is the
    # default; unticked, the lane keeps its own timer. The snapshot carries the
    # RESOLVED times, so the fields always show what this lane will really do.
    sc = L.get("schedule") or {}
    inherit = sc.get("inherit", True)
    dis = " disabled" if inherit else ""
    return (f'<label data-part="global-schedule"><input type="checkbox" data-schedule-toggle{" checked" if inherit else ""}>'
            f'<span>Use global nightshift settings</span></label>\n'
            f'        <label data-part="sleep">{icon("moon")}<span>Sleep</span><input type="time" value="{esc(sc.get("sleep", ""))}"{dis}></label>\n'
            f'        <label data-part="wake">{icon("sun")}<span>Wake</span><input type="time" value="{esc(sc.get("wake", ""))}"{dis}></label>')

def fold_request(L):
    # A pending Fold now, narrated on the card; the countdown ticks in the runtime.
    fr = L.get("foldRequest")
    if not fr: return ""
    what = "Midday fold" if fr.get("tier") else "Force fold"
    if fr["phase"] == "requested":
        # A soft midday request (Ra, 10/12) has no deadline: no countdown, no force.
        if not fr.get("deadline"):
            return (f'<li data-part="fold-request" data-phase="requested" data-tip="Midday fold: {esc(lane_name(L))} folds at their own seam, then reopens right away">{icon("fold")}'
                    f'<span>Midday fold · at their own seam</span></li>')
        from datetime import datetime
        p = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
        mins = max(0, int((p(fr["deadline"]) - p(NOW)).total_seconds() // 60))
        lead = "Midday fold" if fr.get("tier") else "Bell rung"
        return (f'<li data-part="fold-request" data-phase="requested" data-tip="{what}: if {esc(lane_name(L))} hasn\'t folded by then, they\'re folded anyway">{icon("fold")}'
                f'<span>{lead} · forcing in </span><time data-part="countdown" datetime="{esc(fr["deadline"])}">{mins}m</time></li>')
    return (f'<li data-part="fold-request" data-phase="refreshing" data-tip="{what}: folded; the window closes and a fresh one opens">{icon("fold")}'
            f'<span>Folded{" (forced)" if fr.get("forced") else ""} · waking fresh</span></li>')

# Persona rows (Ra, 10/7): the lanes are grouped by persona, each group with
# its name and its own Add agent slot, in the order the personas first appear.
# A skin decides where the name sits (a gutter inside the app's edge, or a tab
# hanging off it); the cards no longer repeat it.
PERSONA_STATE_ORDER = ["failed", "orphaned", "belled", "folding", "awake", "waking", "sleeping", "down"]
def persona_groups():
    groups = {}
    for L in LANES:
        p = L.get("persona") or dict(id="persona", name="Persona")
        groups.setdefault(p["id"], (p, []))[1].append(L)
    if not groups:
        return add_slot()
    out = ""
    for p, lanes in groups.values():
        # The persona carries their agents' state the way a card carries its own
        # (Ra, 10/7: the accent bar is mechanical): trouble first, then a bell, a
        # fold, anyone awake; asleep only when everyone is. Skins colour its
        # accent and badge from it exactly as they do a card's.
        pstate = next((st for st in PERSONA_STATE_ORDER if any(L["state"] == st for L in lanes)), "sleeping")
        # The persona card (Ra, 10/7): a header (badge, name, the caret that folds
        # the card's own body) and a body: one light per agent, a show/hide-agents
        # button and the persona's settings. Hidden agents leave the card standing.
        dots = "".join(f'<li data-lane="{esc(L["id"])}" data-state="{L["state"]}"' + (f' data-activity="{L["activity"]}"' if L.get("activity") else "")
                       + f' data-tip="{esc(lane_name(L))}: {L["state"]}' + (f' · {L["activity"]}' if L.get("activity") else "") + '"></li>' for L in lanes)
        nm = esc(p["name"])
        out += (f'<section class="nw-persona" data-persona="{esc(p["id"])}"' + (f' data-hub="{esc(p["hub"])}"' if p.get("hub") else "") + f' data-state="{pstate}" data-open="true" aria-label="{nm}">'
                f'<article data-part="persona-card" data-card-open="true">'
                f'<h2 data-part="persona-name" data-action="toggle-persona-card" aria-expanded="true">'
                f'<span data-part="persona-avatar" aria-hidden="true">{esc(p["name"][:1].upper())}</span>'
                f'<span data-part="label">{nm}</span><span data-part="persona-toggle" aria-hidden="true">{icon("chev")}</span></h2>'
                f'<div data-part="persona-body"><ul data-part="persona-agents" aria-label="{nm}\'s agents">{dots}</ul>'
                f'<div data-part="persona-buttons"><button type="button" data-action="toggle-persona" data-part="show-agents" aria-pressed="true" aria-label="Hide agents" data-tip="Show or hide {nm}\'s agent cards">{icon("eye")}{icon("eye-off")}</button>'
                f'<button type="button" data-action="persona-settings" aria-label="Persona settings" data-tip="{nm}\'s settings">{icon("gear")}</button></div></div></article>'
                + "".join(lane_card(L, NOW) for L in lanes) + add_slot(persona=p["id"]) + '</section>')
    # Add persona: a small floating + after the last persona (Ra, 10/7).
    return out + f'<button type="button" class="nw-add-persona" data-action="add-persona" aria-label="Add persona" data-tip="Add a persona">{icon("plus")}</button>'

def lane_settings(L):
    # The lane's own settings expand out of its column (Ra, 10/5). Global
    # schedule is a default; each lane can override its hours here.
    opts = "".join(f'<option{" selected" if m == L["model"] else ""}>{m}</option>' for m in MODELS)
    open_ = "true" if L.get("settingsOpen") else "false"
    return f'''<section data-part="settings" data-open="{open_}" aria-label="{esc(lane_name(L))} settings">
        <label>{icon("id")}<span>Model</span><select>{opts}</select></label>
        {schedule_fields(L)}
        <label>{icon("gauge")}<span>Fold at</span><input type="number" value="{L["target"]//1000}"><i>k</i></label>
        {copy_session(L)}
        <label data-part="armed"><input type="checkbox"{" checked" if L.get("armed", True) else ""}><span>Nightshift folds and wakes this lane</span></label>
        <label data-part="confirm-remove"><input type="checkbox" data-gate="remove-lane"><span>Allow removing this lane</span></label>
        <div data-part="buttons"><button type="button" data-action="remove-lane" data-danger="true" aria-disabled="true" data-gated="true" data-tip="Stop managing this agent. Their transcripts and ladder stay on disk. Tick the box above to allow it.">{icon("x")}<span>Remove</span></button>
          <button type="button" data-action="save-lane" data-primary="true">{icon("check")}<span>Save</span></button></div>
      </section>'''

# Add agent (lane creation, 10/6): the form, then a preview of exactly
# what will be written (data-step="form" | "preview"), then one confirm.
def add_slot(open_=False, step="form", steps=(), persona=None):
    sc = SCHEDULE
    o = "true" if open_ else "false"
    pa = f' data-persona="{esc(persona)}"' if persona else ""
    return f'''
    <article class="nw-lane nw-add" data-state="add" data-open="{o}" data-step="{step}"{pa}>
      <button type="button" data-action="add-lane" data-part="add" aria-expanded="{o}">{icon("plus")}<span>Add agent</span></button>
      <form data-part="add-form" aria-label="New agent">
        <label><span>Lane name</span><input type="text" data-field="id" placeholder="e.g. scout" autocomplete="off" spellcheck="false"></label>
        <label><span>Model</span><select data-field="model">{model_opts()}</select></label>
        <label data-part="global-schedule"><input type="checkbox" data-field="inherit" checked><span>Use global nightshift settings</span></label>
        <div data-part="own-schedule"><label>{icon("moon")} Sleep <input type="time" data-field="sleep" value="{esc(sc["sleep"])}" disabled></label>
          <label>{icon("sun")} Wake <input type="time" data-field="wake" value="{esc(sc["wake"])}" disabled></label></div>
        <label><span>Fold target</span><input type="number" data-field="targetK" value="250" min="10" max="2000" step="10"><span data-part="unit">k</span></label>
        <label><span>Start from</span><select data-field="first"><option value="fresh">A fresh session</option><option value="adopt">An existing Claude Code session (advanced)</option></select></label>
        <label data-part="adopt" hidden><span>Session</span><select data-field="session"><option value="">Looking for sessions…</option></select></label>
        <label data-part="armed"><input type="checkbox" data-field="armed" checked><span>Nightshift folds and wakes this lane</span></label>
        <p data-part="error" role="alert" hidden></p>
        <div data-part="buttons"><button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="plan-lane" data-primary="true">{icon("next")}<span>Preview</span></button></div>
      </form>
      <section data-part="preview" aria-label="What adding this agent will do">
        <h4>This will</h4>
        <ol data-part="steps">{steps_html(steps)}</ol>
        <div data-part="buttons"><button type="button" data-action="plan-back">Back</button>
          <button type="button" data-action="create-lane" data-primary="true">{icon("plus")}<span>Add and wake</span></button></div>
      </section>
    </article>'''

# Set up (a new persona, 10/6): who they'll be, their nights, a preview;
# or an import first, which pre-fills "who". The name is optional: a
# persona may name themselves later, by their own hand.
def setup_dialog(open_=False, step="who", steps=()):
    sc = SCHEDULE
    return f'''
  <section class="nw-setup" aria-label="set up a persona" data-open="{"true" if open_ else "false"}" data-step="{step}" role="dialog">
    <h3 data-part="heading">{icon("wand")} Set up a persona<button type="button" data-action="close-setup" data-part="close" aria-label="Close set up">{icon("x")}</button></h3>
    <ol data-part="progress"><li data-step="who">Who they'll be</li><li data-step="nights">Their nights</li><li data-step="preview">Preview</li></ol>
    <fieldset data-step="who">
      <label><span>Name</span><input type="text" data-field="name" placeholder="Leave empty to let them choose" autocomplete="off"></label>
      <label data-part="about"><span>About them</span><textarea data-field="about" rows="4" placeholder="Who they are and why they exist, in a paragraph. This seeds their identity file."></textarea></label>
      <label><span>Your name</span><input type="text" data-field="person" placeholder="So they know who you are" autocomplete="off"></label>
      <label><span>Model</span><select data-field="model">{model_opts()}</select></label>
      <label><span>Folder</span><input type="text" data-field="hub" value="~/Nightwatch/" spellcheck="false"></label>
      <button type="button" data-action="setup-import" data-part="import-link">{icon("folder")}<span>Import an existing persona instead…</span></button>
    </fieldset>
    <fieldset data-step="import">
      <p data-part="hint">Choose a folder with an <code>identity.md</code>. A <code>name.txt</code>, a <code>memory/</code> folder and ladder rungs are optional, and anything missing stays missing.</p>
      <label><span>Folder</span><input type="text" data-field="from" placeholder="/path/to/persona" spellcheck="false"></label>
      <button type="button" data-action="check-import">{icon("check")}<span>Check folder</span></button>
      <ul data-part="found"></ul>
    </fieldset>
    <fieldset data-step="nights">
      <div data-part="schedule"><label>{icon("moon")} Sleep <input type="time" data-field="sleep" value="{esc(sc["sleep"])}"></label>
        <label>{icon("sun")} Wake <input type="time" data-field="wake" value="{esc(sc["wake"])}"></label></div>
      <label><span>Fold target</span><input type="number" data-field="targetK" value="250" min="10" max="2000" step="10"><span data-part="unit">k</span></label>
      <label data-part="armed"><input type="checkbox" data-field="armed" checked><span>Nightshift folds and wakes them</span></label>
    </fieldset>
    <section data-step="preview" aria-label="What setting up will do">
      <h4>This will</h4>
      <ol data-part="steps">{steps_html(steps)}</ol>
    </section>
    <p data-part="error" role="alert" hidden></p>
    <div data-part="buttons"><button type="button" data-action="setup-back">Back</button>
      <button type="button" data-action="setup-next" data-primary="true">{icon("next")}<span>Next</span></button>
      <button type="button" data-action="create-persona" data-primary="true">{icon("wand")}<span>Create and wake them</span></button></div>
  </section>'''

# Context windows by model (Anthropic's model table, 2026-09-25). The bar
# fills against the window; the fold target is a tick on it (--target), and
# the colour level stays tied to the target, since that's when to act.
WINDOWS = {"Fable 5": 1_000_000, "Fable 5.1": 1_000_000, "Opus 5.5": 1_000_000, "Opus 5": 1_000_000,
           "Sonnet 5.5": 1_000_000, "Sonnet 5": 1_000_000, "Haiku 4.5": 200_000}

# The deck's two clocks (Ra, 10/7, after DJ software): time UP counts up from
# when the lane woke, beside the bell's countdown. A lane in any other state
# counts its time in that state. The session id lives behind the lane's
# Copy session ID button (settings) instead.
def elapsed(since_iso, now_iso):
    from datetime import datetime
    ms = (datetime.fromisoformat(now_iso) - datetime.fromisoformat(since_iso)).total_seconds() * 1000
    if not ms > 0:
        return "0m"
    m = round(ms / 60000); h = m // 60
    return f"{h}h {m % 60:02d}m" if h else f"{m}m"

# The session id isn't shown anywhere (Ra, 10/7: rarely relevant); it's one
# click away here for whoever needs it. The full id when the snapshot has it.
def copy_session(L):
    sid = L.get("sessionId") or L.get("session")
    if not sid or sid == "—":
        return ""
    return f'<div data-part="session-row"><button type="button" data-action="copy-session" data-session="{esc(sid)}" data-tip="{"Copy this agent\'s current session ID" if L["state"] in ("awake", "belled", "folding") else "Copy the ID of this agent\'s last active session"}">{icon("id")}<span>Copy session ID</span></button></div>'

def uptime_li(L, now):
    up = L["state"] in ("awake", "belled", "folding")
    disp = elapsed(L["since"][0], now) if now else ""
    # The number is on the card already; the tip gives the start, like the bell's ("Next bell: 02:00").
    tip = f'Up since: {L["since"][1]}' if up else f'{L["state"].capitalize()} since: {L["since"][1]}'
    return f'<li data-part="uptime" data-tip="{esc(tip)}">{icon("sun" if up else "moon")}<time datetime="{L["since"][0]}" data-part="elapsed">{esc(disp)}</time></li>'

def lane_card(L, now=None):
    window = L.get("window") or WINDOWS.get(L["model"]) or L["target"]
    fill = L["ctx"] / window if window else 0
    of_target = L["ctx"] / L["target"] if L["target"] else 0
    tgt = L["target"] / window if window else 1
    # Level keys on WINDOW headroom; targetTokens is fold-TO, not fold-at (Ra, 10/7).
    level = "over" if fill >= 0.9 else "high" if fill >= 0.75 else "ok"
    pts, peak, total = spark(L["series"])
    alarm = "alert" in L
    # An amber card waits to be looked at (Ra, 10/12); only a red one opens its card.
    red = alarm and (L["alert"] or {}).get("level") != "warn"
    nxt = ""
    if L["next"]:
        what, dt, disp = L["next"]
        # Local time, like every other clock here (Ra, 10/7: the raw ISO slice read as UTC).
        # The slot is the lane's nightly switch (Ra, 10/8): lit while armed, a
        # click disarms; disarmed it's a crossed bell, unlit, "none", and a click
        # arms it. No time = nothing scheduled.
        if not dt:
            nxt = f'<li data-part="next" data-action="arm-lane" aria-pressed="false" data-tip="Disarmed: no bell or wake scheduled. Click to arm.">{icon("bell-off")}<span>{esc(disp)}</span></li>'
        else:
            nxt = (f'<li data-part="next" data-action="arm-lane" aria-pressed="true" data-tip="{("Folds by " + local(dt).strftime("%H:%M") + " if they haven\'t folded themselves") if what == "fold" else ("Next " + what + ": " + local(dt).strftime("%H:%M"))}. Click to disarm.">{icon("bell")}'
                   f'<time datetime="{dt}" data-part="countdown">{esc(disp)}</time></li>')
    # The midday cycle's switch (Ra, 10/12); twin of emitter.mjs.
    mc = L.get("midday")
    pct = lambda v, d: round((d if v is None else v) * 100)
    if mc:
        mid = (f'<li data-part="midday" data-action="toggle-midday" aria-pressed="true" data-tip="Midday cycle on: a soft bell at {pct(mc.get("softPct"), 0.85)}% of the window, an urgent one at {pct(mc.get("urgentPct"), 0.95)}%. Click to turn off.">{icon("cycle")}</li>')
    else:
        mid = (f'<li data-part="midday" data-action="toggle-midday" aria-pressed="false" data-tip="Midday cycle off: they fold only at the nightly bell. Click to turn on.">{icon("cycle")}</li>')
    # Accordion. The viewer opens any lane with an un-acked alarm: trouble
    # never hides behind a closed card.
    open_ = "true" if (L.get("open") or red) else "false"
    glance_next = ""
    if L["next"]:
        what, dt, disp = L["next"]
        glance_next = f'{icon("bell" if what=="bell" else "fold" if what=="fold" else "sun")}<time datetime="{dt}">{esc(disp)}</time>'
    alert = ""
    if alarm:
        a = L["alert"]
        fixes = "".join(
            f'<button type="button" data-action="{act}" data-part="fix" data-tip="{esc(tip)}">{icon(ic)}<span>{esc(lbl)}</span></button>'
            for ic, act, lbl, tip in a["fixes"])
        # An amber card (level warn, Ra 10/12); twin of emitter.mjs.
        warn = a.get("level") == "warn"
        alert = (f'<div class="nw-alert" role="{"status" if warn else "alert"}"{" data-level=" + chr(34) + "warn" + chr(34) if warn else ""} data-kind="{a["kind"]}" data-acked="false" data-ack-id="{esc(L["id"])}:{a["kind"]}:{esc(str(a["at"][0]))}">'
                 f'{icon(a.get("icon") or "warn")}<p data-part="title">{esc(a["title"])}</p>'
                 f'<p data-part="cause">{esc(a["cause"])}</p>'
                 f'{time_el(a["at"], " data-part=\"time\"")}'
                 f'<div data-part="fixes">{fixes}</div>'
                 f'<button type="button" data-action="ack" data-part="ack" data-short="OK" '
                 f'data-tip="Hide it here. This only hides it on this screen; the heartbeat still DMs Ra in the morning.">{icon("check")}<span>Got it</span></button>'
                 f'</div>')
    acts = "".join(
        f'<button type="button" data-action="{act}" aria-label="{esc(lbl)}" data-tip="{esc(tip)}"'
        f'{"" if ok else " aria-disabled=\"true\""}{" data-danger=\"true\"" if act=="emergency-fold" else ""}'
        f'{(" aria-expanded=\"true\"" if L.get("settingsOpen") else " aria-expanded=\"false\"") if act=="lane-settings" else ""}>{icon(ic)}</button>'
        for ic, act, lbl, ok, tip in actions(L))
    ctx_disp = f'~{k(L["ctx"])} of {k(window)}' if L["ctx"] else f'— of {k(window)}'
    return f'''
    <article class="nw-lane" data-lane="{L["id"]}"{f' data-name="{esc(L["name"])}"' if L.get("name") else ""} data-state="{L["state"]}" data-open="{open_}"{f' data-stage="{stage(L)}"' if stage(L) else ""}{" data-alarm=\"true\"" if alarm else ""}{" data-switchboard=\"true\"" if L["role"]=="switchboard" else ""}{f' data-activity="{L["activity"]}"' if L.get("activity") else ""}>
      <header data-action="toggle-lane">
        <span data-part="avatar" data-model="{L["modelId"]}" aria-hidden="true">{esc(lane_name(L)[0].upper())}</span>
        <div data-part="ident"><h2 data-part="name">{esc(lane_name(L))}</h2>
        <span data-part="model" data-tip="{esc(L["modelId"])}">{esc(L["model"])}</span></div>
        <span data-part="glance" aria-hidden="true"><span data-part="mini" data-level="{level}" style="--fill: {min(fill,1.2):.3f}; --target: {min(tgt,1):.3f}"></span>{glance_next}</span>
        <span data-part="state" data-tip="{esc(state_tip(L))}"><i aria-hidden="true"></i><span>{esc(state_word(L))}</span></span>
        <button type="button" data-part="toggle" aria-expanded="{open_}" aria-controls="body-{L["id"]}" aria-label="{"Collapse" if open_=="true" else "Expand"} {esc(lane_name(L))}">{icon("chev")}</button>
      </header>
      <div data-part="body" id="body-{L["id"]}">
      <ul data-part="facts">
        {uptime_li(L, now)}
        {nxt}{mid}
        {fold_request(L)}
      </ul>
      <div data-part="meters">
        <div data-part="context" data-level="{level}" style="--fill: {min(fill,1.2):.3f}; --target: {min(tgt,1):.3f}" role="meter" aria-valuenow="{fill:.2f}"
             aria-label="Context used of the model's window" data-tip="Context {ctx_disp} ({round(fill*100)}% of the window). The tick is tonight's fold target: the fold trims the tail back to ~{k(L["target"])}{" (already under it)" if L["ctx"] and of_target <= 1 else ""}.">{icon("gauge")}<span data-part="bar"></span><span data-part="value">{round(fill*100)}%</span></div>
        <div data-part="throughput" data-tip="Output tokens per 10 minutes, last 4 hours (peak {k(peak) if peak>1 else 0}, total {k(total) if total else 0})"
             data-series="{",".join(map(str, L["series"]))}" data-bucket-min="10"{" data-empty=\"true\"" if not total else ""}>{icon("bolt")}<svg viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="{pts}"/><g data-part="bars">{spark_bars(L["series"])}</g></svg><span data-part="value" data-tip="Last 10 minutes">{k1(L["series"][-1]) if L["series"][-1] else "0"}</span></div>
      </div>
      {alert}
      <nav data-part="actions" aria-label="{esc(lane_name(L))} actions">{acts}</nav>
      {lane_settings(L)}
      </div>
    </article>'''

# NightStrip: repeated nodes are GROUPED (Fable's viewer does the same):
# three failed launches are one fact with data-count="3".
NIGHT = {
    "fable": [("bell", "ok", .064, "02:00", "Bell rung (spool note)", 1), ("fold", "ok", .066, "02:01", "Folded, 389/437 kept", 1),
              ("close", "ok", .080, "02:08", "Panel closed, slept and quiet", 1),
              ("launch", "failed", .813, "08:00", "3 launches 08:00–08:11, none registered", 3),
              ("wake-failed", "failed", .846, "08:16", "Wake failed: checkpoint missing", 1),
              ("wake", "manual", .942, "09:02", "Woken by hand", 1)],
    "opus":  [("bell", "ok", .064, "02:00", "Bell relayed by fable", 1), ("fold", "ok", .066, "02:01", "Folded, 404/556 kept", 1),
              ("close", "ok", .080, "02:08", "Panel closed, slept and quiet", 1),
              ("launch", "failed", .813, "08:00", "3 launches 08:00–08:11, none registered", 3),
              ("wake-failed", "failed", .846, "08:16", "Wake failed: checkpoint missing", 1),
              ("wake", "manual", .978, "09:19", "Woken by hand", 1)],
}
NODE_ICON = {"bell": "bell", "fold": "fold", "close": "moon", "launch": "launch", "wake-failed": "warn", "wake": "sun", "context": "gauge"}

def node_li(kind, st, t, tm, tip, c, lanes=None, stack=0):
    lane_attr = f' data-lanes="{" ".join(lanes)}"' if lanes else ""
    if lanes and len(lanes) == len(NIGHT):
        lane_attr += ' data-all="true"'   # every lane: skins may omit the lane chips
    chips = ("<span data-part=\"lanes\">" + "".join(f'<i data-lane="{l}">{l[0].upper()}</i>' for l in lanes) + "</span>") if lanes else ""
    return (f'<li class="nw-node" data-kind="{kind}" data-status="{st}"{" data-alarm=\"true\"" if kind=="wake-failed" else ""}'
            f'{f" data-count=\"{c}\"" if c>1 else ""}{lane_attr} style="--t: {t}; --stack: {stack}" data-tip="{esc(tip)}">'
            f'{icon(NODE_ICON[kind])}<time>{tm}</time>{f"<span data-part=\"count\">×{c}</span>" if c>1 else ""}{chips}</li>')

# A lane's name on its card, and its label where every lane is listed at
# once (timeline rows, log): the same unless several personas share the page
# (gui/hubs.mjs qualifies ids as "<persona>/<lane>" then).
def lane_name(L):
    return L.get("given") or L.get("name") or L["id"]

def lane_label(lane_id):
    for L in LANES:
        if L["id"] == lane_id:
            return L.get("label") or L.get("given") or L["id"]
    i = lane_id.find("/")
    if i >= 0:
        for L in LANES:
            p = L.get("persona")
            if p and p["id"] == lane_id[:i]:
                return f'{p["name"]} · {lane_id[i + 1:]}'
    return lane_id

def combined_nodes():
    # Compressed view: ONE track for every lane. Identical events (same kind,
    # status and minute) merge into one node that names its lanes; near
    # neighbours get a --stack index so skins can fan them apart.
    merged = {}
    for lane, nodes in NIGHT.items():
        for kind, st, t, tm, tip, c in nodes:
            key = (kind, st, tm)
            if key in merged:
                merged[key]["lanes"].append(lane)
            else:
                merged[key] = dict(kind=kind, st=st, t=t, tm=tm, tip=tip, c=c, lanes=[lane])
    out, prev_t, stack = [], -1, 0
    for n in sorted(merged.values(), key=lambda n: n["t"]):
        stack = stack + 1 if n["t"] - prev_t < 0.05 else 0
        prev_t = n["t"]
        tip = n["tip"] + (f' ({", ".join(n["lanes"])})')
        out.append(node_li(n["kind"], n["st"], n["t"], n["tm"], tip, n["c"], n["lanes"], stack))
    return "".join(out)

RANGES = [("8h", "Last 8 hours"), ("24h", "Last 24 hours"), ("3d", "Last 3 days"), ("7d", "Last 7 days")]

def range_buttons(current="8h"):
    # The viewer re-renders strips and axis for the chosen interval; --t is
    # always 0..1 across [data-from, data-to], so skins never change.
    return "".join(f'<button type="button" role="radio" data-range="{r}" aria-checked="{"true" if r==current else "false"}" data-tip="{tip}">{r}</button>'
                   for r, tip in RANGES)

# Activity across the timeline's interval: every lane's output tokens per
# 10-minute bucket, summed, on the same --t axis as the strips. ILLUSTRATIVE
# shape for 01:30-09:30 (the viewer computes real buckets from transcripts):
# work until the bell, the rungs, six hours of sleep, failed wakes, then the
# hand-woken morning.
ACTIVITY = [21000, 34000, 12000, 8000, 3000] + [0]*38 + [18000, 41000, 26000, 37000, 22000]

def monotone_path(pts):
    # Fritsch-Carlson monotone cubic: smooth, but never overshoots, so a run
    # of zero buckets stays flat at zero instead of dipping below the axis.
    n = len(pts)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    d = [(ys[i+1]-ys[i])/(xs[i+1]-xs[i]) for i in range(n-1)]
    m = [d[0]] + [(0 if d[i-1]*d[i] <= 0 else (d[i-1]+d[i])/2) for i in range(1, n-1)] + [d[-1]]
    for i in range(n-1):
        if d[i] == 0:
            m[i] = m[i+1] = 0
        else:
            a, b = m[i]/d[i], m[i+1]/d[i]
            h = a*a + b*b
            if h > 9:
                t = 3 / h**.5
                m[i], m[i+1] = t*a*d[i], t*b*d[i]
    out = f"M{xs[0]:.1f},{ys[0]:.1f}"
    for i in range(n-1):
        dx = (xs[i+1]-xs[i]) / 3
        out += f" C{xs[i]+dx:.1f},{ys[i]+m[i]*dx:.1f} {xs[i+1]-dx:.1f},{ys[i+1]-m[i+1]*dx:.1f} {xs[i+1]:.1f},{ys[i+1]:.1f}"
    return out

def peak_at(pt):
    # The peak bucket's centre in local time, to the nearest 10 minutes.
    from datetime import timedelta
    a, b = local(TIMELINE["from"]), local(TIMELINE["to"])
    t = a + (b - a) * pt
    t = (t + timedelta(minutes=5)).replace(minute=(t + timedelta(minutes=5)).minute // 10 * 10, second=0, microsecond=0)
    return t.strftime("%H:%M")

def sleep_bands():
    # One band per night in the interval (TIMELINE.sleep_bands); a single
    # TIMELINE.sleep pair is the older shape. Bands too narrow for the word
    # keep it as a tip instead, so 7d doesn't print "asleep" seven times.
    bands = TIMELINE.get("sleep_bands") or ([TIMELINE["sleep"]] if TIMELINE.get("sleep") else [])
    out = ""
    for a, b in bands:
        word = "asleep" if b - a >= .1 else ""
        out += (f'<span data-part="sleep" style="--from: {frac(a)}; --to: {frac(b)}"'
                f'{"" if word else " data-narrow=\"true\" data-tip=\"Asleep\""}>{word}</span>')
    return out

# The strip's bucket, in words: 48 buckets over the range (10 minutes at 8h,
# 3.5 hours at 7d). TIMELINE["bucket_min"]; older snapshots had 10 implicitly.
def bucket_words(m):
    if m < 60: return f"{m} minutes"
    h = round(m / 60, 1)
    return f"{h:g} hour{'' if m == 60 else 's'}"

def activity():
    bm = TIMELINE.get("bucket_min", 10)
    # The night's shape. Same --t axis as the strips; svg coordinates are
    # 0..1000 across the interval, 0..40 down. Fixture-supplied pieces:
    #   grid    hour lines (skins colour them)
    #   fill    a vertical gradient (skins set the two stops' colours)
    #   area / line   a monotone smooth curve
    #   sleep   the scheduled sleep window, as HTML so its label isn't stretched
    #   peak    the busiest bucket, as HTML, with --t and --v (0..1)
    # A quiet night (every bucket 0) is real live data: scale by 1, hide the peak.
    n, peak = len(ACTIVITY), max(ACTIVITY)
    quiet, peak = peak <= 0, peak if peak > 0 else 1
    pts = [(1000 * (i + .5) / n, 40 - 34 * v / peak) for i, v in enumerate(ACTIVITY)]
    line = monotone_path(pts)
    area = f"M{pts[0][0]:.1f},40 L" + line[1:] + f" L{pts[-1][0]:.1f},40 Z"
    bars = "".join(f'<rect x="{1000*i/n:.1f}" width="{1000/n*.7:.1f}" y="{40-34*v/peak:.1f}" height="{34*v/peak:.1f}" style="--v: {v/peak:.3f}"/>' for i, v in enumerate(ACTIVITY))
    grid = "".join(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="0" y2="40"/>' for x in [62.5 + 125*h for h in range(8)])
    # On a quiet series peak was substituted with 1 for scaling, which is
    # not in the list — index() must not go hunting for it (first quiet
    # morning, 2026-10-06, crashed here; the peak chip is hidden anyway).
    pi = ACTIVITY.index(peak) if not quiet else 0; pt = (pi + .5) / n
    return (f'<div data-part="activity" data-illustrative="true" data-bucket-min="{bm}" data-series="{",".join(map(str, ACTIVITY))}" '
            f'data-tip="Output tokens, all agents, per {bucket_words(bm)}">'
            f'<svg viewBox="0 0 1000 40" preserveAspectRatio="none" aria-hidden="true">'
            f'<defs><linearGradient id="nw-activity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" data-part="fill-top"/><stop offset="1" data-part="fill-bottom"/></linearGradient></defs>'
            f'<g data-part="grid">{grid}</g><path data-part="area" fill="url(#nw-activity-fill)" d="{area}"/><path data-part="line" d="{line}"/>'
            f'<g data-part="bars">{bars}</g></svg>'
            + sleep_bands() +
            f'<span data-part="peak"{" hidden" if quiet else ""} style="--t: {pt:.3f}; --v: 1" data-tip="Peak: {k(peak)} tokens in {bucket_words(bm)}, around {peak_at(pt)}">{k(round(peak / bm))}/min</span></div>')

def night():
    # Both views are in the DOM; the app's data-timeline-mode picks one, so a
    # skin can switch with CSS alone (and animate the switch if it likes).
    strips = ""
    for lane, nodes in NIGHT.items():
        strips += f'<ol class="nw-strip" data-lane="{lane}" data-label="{esc(lane_label(lane))}" data-mode="expanded">{"".join(node_li(*n) for n in nodes)}</ol>'
    strips += f'<ol class="nw-strip" data-lane="all" data-mode="compressed">{combined_nodes()}</ol>'
    strips += activity()
    return f'''
  <section class="nw-timeline" aria-label="timeline" data-range="{TIMELINE["range"]}" data-from="{TIMELINE["from"]}" data-to="{TIMELINE["to"]}">
    <h3 data-part="heading">Timeline <span>{esc(TIMELINE["label"])}</span></h3>
    <div data-part="range" role="radiogroup" aria-label="Interval shown">{range_buttons(TIMELINE["range"])}</div>
    <div data-part="axis" aria-hidden="true">{"".join(f'<span style="--t: {frac(t)}">{esc(lb)}</span>' for t, lb in TIMELINE["ticks"])}</div>
    <div data-part="sleep-bands" aria-hidden="true">{sleep_bands()}</div>
    {strips}
    <p data-part="empty" hidden>No nights yet. Your agents' sleep and wake will draw here.</p>
  </section>'''

# The log: every event the nightshift emits (events.jsonl), newest first,
# with fold rows carrying their numbers. Filtering is app logic: the viewer
# sets [hidden] on rows whose kind is switched off, so skins need no rule per
# kind. Heartbeats start hidden, which is the filter doing its job.
LOG_KINDS = [("bell", "bell", "Bells", True), ("fold", "fold", "Folds", True), ("close", "moon", "Closes", True),
             ("launch", "launch", "Launches", True), ("wake", "sun", "Wakes", True), ("wake-failed", "warn", "Failures", True),
             ("context", "gauge", "Context", True), ("heartbeat", "check", "Heartbeats", False)]
LOG = [
    ("Oct 5", [
        ("12:29", "opus", "fold", "ok", "Emergency fold", dict(reason="emergency", kept=(759, 1051), est=685_808, target=250_000, tail="056b5609"), 1),
        ("12:29", "opus", "wake", "ok", "Emergency wake", None, 1),
        ("12:00", "nightshift", "heartbeat", "ok", "Nightshift alive", None, 1),
        ("11:00", "nightshift", "heartbeat", "ok", "Nightshift alive", None, 1),
        ("09:19", "opus", "wake", "manual", "Woken by hand", None, 1),
        ("09:02", "fable", "wake", "manual", "Woken by hand", None, 1),
        ("08:16", "scribe", "wake-failed", "failed", "Wake failed: checkpoint missing", None, 1),
        ("08:16", "opus", "wake-failed", "failed", "Wake failed: checkpoint missing", None, 1),
        ("08:16", "fable", "wake-failed", "failed", "Wake failed: checkpoint missing", None, 1),
        ("08:00", "opus", "launch", "failed", "Launched 08:00–08:11, none registered", None, 3),
        ("08:00", "fable", "launch", "failed", "Launched 08:00–08:11, none registered", None, 3),
        ("02:08", "opus", "close", "ok", "Panel closed, slept and quiet", None, 1),
        ("02:08", "fable", "close", "ok", "Panel closed, slept and quiet", None, 1),
        ("02:01", "opus", "fold", "ok", "Folded", dict(reason="sleep", kept=(404, 556), est=1_292_655, target=250_000, tail="fe60cd9d"), 1),
        ("02:01", "fable", "fold", "ok", "Folded", dict(reason="sleep", kept=(389, 437), est=256_935, target=250_000, tail="81033de6"), 1),
        ("02:00", "opus", "bell", "ok", "Bell (relayed by fable)", None, 1),
        ("02:00", "fable", "bell", "ok", "Bell rung", None, 1),
    ]),
    ("Oct 4", [
        ("02:02", "fable", "fold", "ok", "Folded", dict(reason="sleep", kept=(169, 2191), est=286_929, target=250_000, tail="3f85b6bb"), 1),
    ]),
]
LOG_ICON = {"bell": "bell", "fold": "fold", "close": "moon", "launch": "launch", "wake": "sun", "wake-failed": "warn", "context": "gauge", "heartbeat": "check"}

def log():
    shown = {kind: on for kind, _, _, on in LOG_KINDS}
    filters = "".join(
        f'<label data-kind="{kind}" data-tip="Show or hide {label.lower()}"><input type="checkbox"{" checked" if on else ""}>{icon(ic)}<span>{label}</span></label>'
        for kind, ic, label, on in LOG_KINDS)
    rows = ""
    for day, events in LOG:
        rows += f'<li class="nw-day" data-part="day">{day}</li>'
        for tm, lane, kind, st, what, fold, c in events:
            detail, attrs = "", ""
            if fold:
                kp, tot = fold["kept"]; est, tg = fold["est"], fold["target"]
                attrs = (f' data-reason="{fold["reason"]}" data-level="{"over" if est/tg > 1.5 else "ok"}"'
                         f' style="--kept: {kp/tot:.3f}; --est: {est/tg:.2f}"')
                detail = (f'<span data-part="detail"><span data-part="kept" data-tip="{kp} of {tot} entries kept">{kp}/{tot}</span>'
                          f'<span data-part="est" data-tip="Estimated {k(est)} tokens against a {k(tg)} target">{k(est)}</span>'
                          f'<code data-part="tail">{fold["tail"]}</code></span>')
            hidden = "" if shown[kind] else " hidden"
            rows += (f'<li class="nw-event" data-kind="{kind}" data-lane="{lane}" data-status="{st}"'
                     f'{" data-alarm=\"true\"" if kind=="wake-failed" else ""}{f" data-count=\"{c}\"" if c>1 else ""}{attrs}{hidden}>'
                     f'<time data-part="time">{tm}</time><span data-part="lane">{esc(lane_label(lane))}</span>{icon(LOG_ICON[kind])}'
                     f'<span data-part="what">{esc(what)}{f" <b data-part=\"count\">×{c}</b>" if c>1 else ""}</span>{detail}</li>')
    return f'''
  <section class="nw-log" aria-label="event log">
    <h3 data-part="heading">Log</h3>
    <div data-part="filters" role="group" aria-label="Show these events">{filters}<button type="button" data-action="reset-log" data-part="reset" aria-label="Show everything" data-tip="Back to the default view: every agent, the usual kinds of event">{icon("repeat")}</button></div>
    <ol data-part="events">{rows}</ol>
    <p data-part="empty" hidden>Nothing yet. Every bell, fold and wake will be written here.</p>
  </section>'''

def settings():
    # Settings, one panel per persona (Ra, 10/7: "per persona"; the gear on the
    # persona's card opens it): that persona's schedule, their lanes' targets and
    # nightly switches, and their own nightshift's health. Everything from the
    # snapshot, nothing frozen; the health check is derived from facts the head
    # and cards already show, so the panel can never disagree with them.
    groups = {}
    for L in LANES:
        p = L.get("persona") or {"id": "persona", "name": "Persona"}
        groups.setdefault(p["id"], (p, []))[1].append(L)
    if not groups:
        return settings_panel(None, [])
    return "".join(settings_panel(p, lanes) for p, lanes in groups.values())

def settings_panel(p, lanes_of):
    sc = (p or {}).get("schedule") or SCHEDULE
    D = (p or {}).get("daemon") or DAEMON
    rows = ""
    for L in lanes_of:
        own = bool(L.get("schedule")) and L["schedule"].get("inherit") is False
        sched = f'own {esc(L["schedule"]["sleep"])}–{esc(L["schedule"]["wake"])}' if own else "shared"
        rows += (f'<tr data-lane="{esc(L["id"])}"><td>{esc(lane_name(L))}</td>'
                 f'<td>{esc(L["model"])}</td>'
                 f'<td><input type="number" value="{L["target"]//1000}" aria-label="{esc(lane_name(L))} fold target (k tokens)"> k</td>'
                 f'<td>{sched}</td>'
                 f'<td><input type="checkbox"{" checked" if L.get("armed", True) else ""} aria-label="{esc(lane_name(L))} armed"></td></tr>')
    items = []
    if D["down"]:
        items.append(f'<li data-status="failed">{icon("warn")} {esc(daemon_tip(D))}'
                     f'<button type="button" data-action="restart-daemon" data-part="fix">{icon("retry")}<span>Restart it</span></button></li>')
    else:
        items.append(f'<li data-status="ok">{icon("check")} {esc(daemon_tip(D))}</li>')
    trouble = 0
    for L in lanes_of:
        if not L.get("alert"): continue
        trouble += 1
        fixes = L["alert"].get("fixes") or []
        fix = (f'<button type="button" data-action="{fixes[0][1]}" data-part="fix">{icon(fixes[0][0])}<span>{esc(fixes[0][2])}</span></button>'
               if fixes else "")
        amber = L["alert"].get("level") == "warn"
        items.append(f'<li data-status="{"warn" if amber else "failed"}" data-lane="{esc(L["id"])}">{icon("gauge" if amber else "warn")} {esc(lane_name(L))}: {esc(L["alert"]["title"])}{fix}</li>')
    for L in lanes_of:
        # Size only matters against the WINDOW (fold target = fold-TO; Ra, 10/7).
        w = L.get("window") or WINDOWS.get(L["model"]) or 0
        if not (w and L["ctx"] / w >= 0.9): continue
        trouble += 1
        items.append(f'<li data-status="warn" data-lane="{esc(L["id"])}">{icon("gauge")} {esc(lane_name(L))} is at {round(L["ctx"]/w*100)}% of their context window — a Force fold would trim them to ~{k(L["target"])}</li>')
    if not trouble:
        items.append(f'<li data-status="ok">{icon("check")} No agent needs a hand</li>')
    who = esc(p["name"]) if p else "Settings"
    attrs = (f' data-persona="{esc(p["id"])}"' if p else "") + (f' data-hub="{esc(p["hub"])}"' if p and p.get("hub") else "")
    label = f"{who} settings" if p else "settings"
    return f"""
  <section class="nw-settings"{attrs} aria-label="{label}" data-open="false" role="dialog">
    <h3 data-part="heading">{icon("gear")} {who}<button type="button" data-action="close-settings" data-part="close" aria-label="Close settings">{icon("x")}</button></h3>
    <div data-part="schedule"><span data-part="label">Nightshift</span>
      <label>{icon("moon")} Sleep <input type="time" value="{esc(sc["sleep"])}"></label>
      <label>{icon("sun")} Wake <input type="time" value="{esc(sc["wake"])}"></label>
      <span data-part="tz">{esc(TZ or "")}</span>
    </div>
    <table data-part="lanes"><thead><tr><th>lane</th><th>model</th><th>fold target</th><th>schedule</th><th>armed</th></tr></thead><tbody>{rows}</tbody></table>
    <div data-part="doctor">
      <h4>{icon("check")} Health check</h4>
      <ul>{"".join(items)}</ul>
    </div>
    <div data-part="buttons"><button type="button" data-action="run-doctor">{icon("retry")}<span>Check again</span></button>
      <button type="button" data-action="save-settings" data-primary="true">{icon("check")}<span>Save</span></button></div>
  </section>"""

# The skin selector is part of the view menu (contract v0.8): one radio per
# installed skin, titled from its manifest. The runtime swaps the stylesheet.
SKIN_ORDER = ["minimal", "glass", "amber", "metal", "wacky", "steampunk", "concrete"]

def skins_installed():
    found = []
    for d in sorted(os.listdir(HERE)):
        m = os.path.join(HERE, d, "manifest.json")
        if os.path.isfile(m) and os.path.isfile(os.path.join(HERE, d, "skin.css")):
            with open(m) as f:
                found.append((d, json.load(f).get("title", d)))
    rank = {n: i for i, n in enumerate(SKIN_ORDER)}
    return sorted(found, key=lambda s: (rank.get(s[0], len(rank)), s[0]))

def skin_items():
    return (f'<li role="none" data-part="skin-heading">{icon("panels")}<span>Skin</span></li>' + "".join(
        f'<li role="none"><label role="menuitemradio" data-view="skin" data-value="{n}">'
        f'<input type="radio" name="skin" value="{n}"><span>{esc(t)}</span></label></li>'
        for n, t in skins_installed()))

def view_menu():
    # Top-level view menu (Ra, 10/5): the default is cards only; everything
    # else is opt-in. Checked state mirrors .nw-app's data-show-* attributes.
    def chk(view, label, ic):
        return (f'<li role="none"><label role="menuitemcheckbox" data-view="{view}">'
                f'<input type="checkbox" data-view-toggle="{view}">{icon(ic)}<span>{label}</span></label></li>')
    def radio(group, val, label):
        return (f'<li role="none"><label role="menuitemradio" data-view="{group}" data-value="{val}">'
                f'<input type="radio" name="{group}" value="{val}"><span>{label}</span></label></li>')
    return f'''<menu data-part="view-menu" data-menu="view" role="menu" aria-label="View">
      {chk("controls", "Controls", "play")}
      {radio("timeline-mode", "expanded", "One row per agent")}
      {radio("timeline-mode", "compressed", "All agents on one track")}
      {chk("log-tall", "Extend log", "log")}
      <li role="separator"></li>
      {radio("layout", "row", "Horizontal")}
      {radio("layout", "column", "Vertical")}
      {radio("layout", "stack", "Stacked")}
      <li role="none"><button type="button" role="menuitem" data-action="collapse-all">{icon("chev")}<span>Collapse all lanes</span></button></li>
    </menu>'''

# The Settings menu (Ra, 10/7): a third menu beside View and Look for what is
# neither layout nor skin, so the deck keeps three buttons.
def app_menu():
    return f'''<menu data-part="view-menu" data-menu="app" role="menu" aria-label="Settings">
      <li role="none" data-part="settings-entry"><button type="button" role="menuitem" data-action="app-settings">{icon("gear")}<span>Schedule and health check…</span></button></li>
      <li role="separator" data-part="settings-entry"></li>
      <li role="none"><label role="menuitemcheckbox" data-view="on-top"><input type="checkbox" data-view-toggle="on-top">{icon("pin")}<span>Keep on top</span></label></li>
    </menu>'''

# The Look menu (Ra, 10/6: one long menu ran off the screen; "a second menu
# next to the first"): appearance and skin, its own button beside View. It
# shares the View menu's part name, so every skin's menu styling applies;
# data-menu tells the two apart.
def look_menu():
    def radio(group, val, label):
        return (f'<li role="none"><label role="menuitemradio" data-view="{group}" data-value="{val}">'
                f'<input type="radio" name="{group}" value="{val}"><span>{label}</span></label></li>')
    return f'''<menu data-part="view-menu" data-menu="look" role="menu" aria-label="Look">
      <li role="none" data-part="theme-heading">{icon("sun")}<span>Appearance</span></li>
      {radio("theme", "system", "Match the system")}
      {radio("theme", "light", "Light")}
      {radio("theme", "dark", "Dark")}
      <li role="separator" data-part="theme-separator"></li>
      {skin_items()}
    </menu>'''

def controls(setup=False):
    # The deck: Nightwatch's main controls, for every lane at once (Ra, 10/5:
    # "the main controls on an mp3 player"). On a fresh install there are no
    # lanes yet, and Set up takes the play button's slot.
    if setup:
        display = ('<p data-part="summary">No agents yet</p>'
                   '<p data-part="next">Set up a persona to begin</p>'
                   '<ul data-part="counts"></ul>')
        primary = f'<button type="button" data-action="setup" data-part="primary" data-tip="Install a persona: name, model, where their memory lives">{icon("wand")}<span>Set up</span></button>'
    else:
        # Counts derive from the lanes: belled/waking/folding are awake-ish,
        # orphaned is trouble, down is asleep. Zero counts are left out.
        group = {"awake": "awake", "belled": "awake", "waking": "awake", "folding": "awake",
                 "sleeping": "sleeping", "down": "sleeping", "failed": "failed", "orphaned": "failed"}
        counts = [(st, sum(1 for L in LANES if group.get(L["state"]) == st)) for st in ("awake", "sleeping", "failed")]
        counts = [(st, n) for st, n in counts if n]
        nb = DECK["next_at"]
        display = (f'<p data-part="summary"><b>{len(LANES)}</b> agent{"" if len(LANES) == 1 else "s"}</p>'
                   f'<p data-part="next">Next bell <time datetime="{nb}">{local(nb):%H:%M}</time> · in <time data-part="countdown" datetime="{nb}">{esc(DECK["countdown"])}</time></p>'
                   '<ul data-part="counts">' + "".join(
                       f'<li data-state="{st}" style="--n: {n}" data-tip="{n} {st}"><b>{n}</b><span>{st}</span></li>' for st, n in counts) + '</ul>')
        primary = f'<button type="button" data-action="wake-all" data-part="primary" data-tip="Wake every sleeping agent now">{icon("play")}<span>Wake all</span></button>'
    # With nothing left to wake, the big button becomes Sleep all (Ra, 10/7):
    # play turns into pause, as on any player, instead of a prominent Wake all
    # that can't do anything sitting beside a small pause.
    all_awake = (not setup) and len(LANES) > 0 and not any(L["state"] in ("sleeping", "failed", "orphaned") for L in LANES)
    sleep_tip = "Ring every awake agent's bell: rung, fold, close"
    if all_awake:
        primary = f'<button type="button" data-action="sleep-all" data-part="primary" data-tip="{esc(sleep_tip)}">{icon("pause")}<span>Sleep all</span></button>'
    pause = "" if all_awake else f'<button type="button" data-action="sleep-all" aria-label="Sleep all" data-tip="{esc(sleep_tip)}"{" aria-disabled=\"true\"" if setup else ""}>{icon("pause")}</button>'
    return f'''
  <section class="nw-controls" aria-label="controls" data-setup="{"true" if setup else "false"}">
    <div data-part="display" role="status">{display}</div>
    <div data-part="transport" data-all-awake="{"true" if all_awake else "false"}">
      {primary}
      {pause}
      <button type="button" data-action="fold-all" aria-label="Force-fold all" data-danger="true" data-tip="Force-fold every awake agent (asks first)"{" aria-disabled=\"true\"" if setup else ""}>{icon("stop")}</button>
      <button type="button" data-action="toggle-nightly" aria-pressed="{"true" if (not setup and any(L.get("armed", True) is not False for L in LANES)) else "false"}" aria-label="Nightly cycle" data-tip-on="Nightly cycle is on: bell {SCHEDULE["sleep"]}, wake {SCHEDULE["wake"]}. Press to turn it off." data-tip-off="Nightly cycle is off. Press to turn it on (bell {SCHEDULE["sleep"]}, wake {SCHEDULE["wake"]})." data-tip="{(f'Nightly cycle is on: bell {SCHEDULE["sleep"]}, wake {SCHEDULE["wake"]}. Press to turn it off.' if (not setup and any(L.get("armed", True) is not False for L in LANES)) else f'Nightly cycle is off. Press to turn it on (bell {SCHEDULE["sleep"]}, wake {SCHEDULE["wake"]}).')}">{icon("repeat")}</button>
      <button type="button" data-part="panel-toggle" data-action="toggle-timeline" aria-pressed="false" aria-label="Timeline" data-tip-on="Hide the timeline" data-tip-off="Show the timeline" data-tip="Show the timeline">{icon("clock")}</button>
      <button type="button" data-part="panel-toggle" data-action="toggle-log" aria-pressed="false" aria-label="Log" data-tip-on="Hide the log" data-tip-off="Show the log" data-tip="Show the log">{icon("log")}</button>
    </div>
  </section>'''

def confirm():
    return f'''
  <div class="nw-confirm" role="alertdialog" aria-label="Confirm emergency fold" data-action="emergency-fold" data-lane="opus">
    <p data-part="title">{icon("fold")} Force-fold opus?</p>
    <p data-part="body">This folds the session as it stands, without waiting for a rung. The agent's next wake starts with an emergency note so they can write the missing rung themself. Nothing in the transcript is deleted.</p>
    <div data-part="buttons"><button type="button" data-action="cancel">Cancel</button>
      <button type="button" data-action="confirm" data-danger="true">{icon("fold")}<span>Force fold</span></button></div>
  </div>'''

def page():
    gallery_states = "".join(
        lane_card(dict(id=st, model="Opus 5.5", modelId="claude-opus-5-5", role="", state=st, session="—",
                       since=("2026-10-05T02:00-07:00", "02:00"), next=None, ctx=c, target=250_000, series=[0]*24, open=True))
        for st, c in [("belled", 243_000), ("folding", 250_000), ("waking", 30_000), ("orphaned", 150_000), ("down", 0)])
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nightwatch fixture</title>
<!-- GENERATED by build_fixture.py: edit that, not this. Contract v0.7; see CONTRACT.md. -->
<link id="skin" rel="stylesheet" href="">
<script src="runtime.js" defer></script>
<script>
  const q = new URLSearchParams(location.search);
  const skin = q.get('skin') || 'minimal';
  document.getElementById('skin').href = `${{skin}}/skin.css`;
  const d = document.documentElement.dataset;
  d.skin = skin;
  d.surface = q.get('surface') || 'window';
  d.gallery = q.get('gallery') === '1' ? '1' : '0';
  d.tips = q.get('tips') === '1' ? '1' : '0';   // stills only: show one tip as if hovered
  d.desk = q.get('desk') === '1' ? '1' : '0';   // stills only: a fake desktop behind the floating app
  // View state the app owns (the view menu writes these). Defaults = cards only.
  window.NW_VIEW = {{ controls: q.get('controls') !== '0', timeline: q.get('timeline') !== '0', log: q.get('log') !== '0',
    timelineMode: q.get('tlmode') || 'expanded', layout: q.get('layout') || 'row',
    onTop: true, menu: q.get('menu') === '1' }};
</script>
<style>
  /* FIXTURE ONLY: the desktop the app floats over. Skins never style html/body
     backgrounds: in the app the window is transparent and this is the user's
     real desktop. */
  html[data-desk="1"] body {{ min-height: 100vh; margin: 0; padding: 40px;
    background:
      radial-gradient(38% 30% at 78% 18%, #ff9a6acc, transparent 70%),
      radial-gradient(30% 34% at 12% 72%, #e86bb0aa, transparent 70%),
      radial-gradient(26% 22% at 46% 46%, #7ee0c688, transparent 70%),
      radial-gradient(120% 90% at 20% 10%, #6f86b8 0%, #3c4f7d 38%, #1d2440 100%); }}
  html[data-desk="1"] .nw-app {{ position: relative; z-index: 1; }}
  /* VIEWER CHROME, not skin surface: a served page in an ordinary browser
     window can't be transparent (the Tauri shell can), so runtime.js sets
     data-shell="browser" and the window gets a plain dark ground. */
  /* VIEWER CHROME: the app's confirm dialog floats over everything (skins
     style .nw-confirm's look; this only places it), and the status line. */
  .nw-app > .nw-confirm {{ position: fixed; z-index: 50; left: 50%; top: 96px; transform: translateX(-50%);
    width: min(420px, calc(100vw - 32px)); box-shadow: 0 18px 60px #0008; }}
  .nw-app > .nw-settings[data-open="false"] {{ display: none; }}
  .nw-lane [data-part="next"][data-action], .nw-lane [data-part="midday"] {{ cursor: pointer; }}
  /* The midday switch lights and dims exactly like the bell (Ra, 10/12); each skin's
     lit-bell colour rule names it too. */
  .nw-lane [data-part="next"][aria-pressed="false"], .nw-lane [data-part="midday"][aria-pressed="false"] {{ opacity: .45; text-shadow: none; }}
  .nw-app > .nw-settings {{ position: fixed; z-index: 45; left: 50%; top: 72px; transform: translateX(-50%);
    width: min(600px, calc(100vw - 32px)); max-height: calc(100vh - 100px); overflow: auto; box-shadow: 0 18px 60px #0008; }}
  /* In the app the window FITS its content, so a viewport-capped panel was circular: capped to the short
     closed-app window, measured short, never grown, bottom buttons out of reach (Ra, 10/6). There it takes its
     natural height and the window grows to it; on a too-short screen the page scrolls, so it scrolls with it. */
  html[data-shell="tauri"] .nw-app > .nw-settings {{ position: absolute; max-height: none; overflow: visible; }}
  /* Lane creation (10/6): which step shows is structure, not look, so it
     lives here for every skin. Set up floats like settings. */
  .nw-app > .nw-setup[data-open="false"] {{ display: none; }}
  .nw-app > .nw-setup {{ position: fixed; z-index: 46; left: 50%; top: 72px; transform: translateX(-50%);
    width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 100px); overflow: auto; box-shadow: 0 18px 60px #0008; }}
  html[data-shell="tauri"] .nw-app > .nw-setup {{ position: absolute; max-height: none; overflow: visible; }}
  .nw-setup > [data-step] {{ display: none; }}
  .nw-setup[data-step="who"] > [data-step="who"], .nw-setup[data-step="import"] > [data-step="import"],
  .nw-setup[data-step="nights"] > [data-step="nights"], .nw-setup[data-step="preview"] > [data-step="preview"] {{ display: grid; }}
  .nw-setup[data-step="who"] [data-action="setup-back"], .nw-setup[data-step="preview"] [data-action="setup-next"],
  .nw-setup:not([data-step="preview"]) [data-action="create-persona"] {{ display: none; }}
  .nw-add[data-step="preview"] > [data-part="add-form"], .nw-add[data-step="form"] > [data-part="preview"],
  .nw-add[data-open="false"] > [data-part="preview"] {{ display: none; }}
  [data-part="error"][hidden], .nw-add [data-part="adopt"][hidden] {{ display: none; }}
  .nw-head [data-part="view-menu"] li[hidden] {{ display: none !important; }}
  .nw-timeline > [data-part="sleep-bands"] {{ display: none; }} /* the vertical layout draws it across the lanes (10/6) */
  .nw-app > .nw-toast {{ position: fixed; z-index: 49; left: 50%; bottom: 18px; transform: translateX(-50%); margin: 0;
    max-width: calc(100vw - 32px); padding: 8px 14px; border-radius: 8px; font: 13px system-ui; color: #eee; background: #1d2027ee; box-shadow: 0 8px 30px #0007; }}
  .nw-app > .nw-toast[data-status="failed"] {{ background: #5a1f1fee; }}
  /* In the app the window is a transparent canvas over the screen's usable area (10/6), and the app sits in
     it where the viewer last dragged it (runtime.js placeApp). Floating parts position against the app, not
     the screen-sized window. The page scrolls only if the app is taller than the screen. */
  html[data-shell="tauri"] body {{ margin: 0; padding: 0; min-height: 100vh; overflow: auto; }}
  /* Moved by transform on its own compositing layer, not left/top: a repainted move left ghost edges of a
     skin's big drop-shadow filter behind in the transparent window (Amber, 10/6). */
  html[data-shell="tauri"] .nw-app {{ position: absolute; left: 0; top: 0; transform: translate(var(--nw-x, 112px), var(--nw-y, 24px)); will-change: transform; }}
  html[data-shell="tauri"] .nw-app > :is(.nw-confirm, .nw-toast) {{ position: absolute; }}
  html[data-shell="tauri"] .nw-head {{ cursor: grab; }}
  html[data-shell="tauri"] .nw-head[data-dragging] {{ cursor: grabbing; }}
  html[data-shell="browser"] body {{ margin: 0; padding: 16px; min-height: 100vh; box-sizing: border-box;
    background: radial-gradient(120% 90% at 30% 0%, #2a2f3a 0%, #16181d 60%, #101114 100%); }}
</style>
</head>
<body>
{sprite()}
<div class="nw-app" data-show-controls="true" data-show-timeline="true" data-show-log="true" data-timeline-mode="expanded" data-layout="row">
  <header class="nw-head" data-tauri-drag-region>
    <span class="nw-glyph" data-phase="{DAEMON["phase"]}" role="img" aria-label="{ALARM_ARIA[DAEMON["phase"]]}" data-tip="{glyph_tip()}"></span>
    <h1 data-part="title">Nightwatch</h1>
    <span data-part="schedule" data-tip="Tonight's schedule: the sleep-bell rings at {SCHEDULE["sleep"]} and agents wake at {SCHEDULE["wake"]}. Change it in a persona's settings (the gear on their card).">{icon("moon")}<time datetime="{SCHEDULE["sleep"]}">{SCHEDULE["sleep"]}</time>{icon("sun")}<time datetime="{SCHEDULE["wake"]}">{SCHEDULE["wake"]}</time></span>
    <time data-part="clock" datetime="{NOW}">{local(NOW):%H:%M}</time>
    <button type="button" data-action="look-menu" data-part="menu-button" data-menu="look" aria-haspopup="menu" aria-expanded="false" aria-label="Look" data-tip="Appearance and skin">{icon("palette")}</button>
    <button type="button" data-action="view-menu" data-part="menu-button" aria-haspopup="menu" aria-expanded="false" aria-label="View" data-tip="Show or hide panels">{icon("panels")}</button>
    <button type="button" data-action="app-menu" data-part="menu-button" data-menu="app" aria-haspopup="menu" aria-expanded="false" aria-label="Settings" data-tip="Settings">{icon("gear")}</button>
    <button type="button" data-action="hide-window" data-part="hide" aria-label="Hide to menu bar" data-tip="Hide to the menu bar. The nightshift keeps watching.">{icon("minus")}</button>
    {view_menu()}
    {look_menu()}
    {app_menu()}
  </header>

  <!-- App-level alarms are ONLY for things no card owns (the daemon itself).
       Lane trouble lives on the lane's card. Empty in this snapshot. -->
  <div class="nw-alarms">{app_alarms()}</div>

  <section class="nw-lanes" aria-label="lanes">{persona_groups()}
  </section>
  {controls()}
  {night()}
  {log()}
  {settings()}
  {setup_dialog()}
  <!-- FIXTURE ONLY (?gallery=1): one of every state, so a skin proves it can
       draw each. Not part of the app. -->
  <section class="nw-gallery" aria-label="state gallery">
    <h3 data-part="heading">Skin test sheet: every state once (not part of the app)</h3>
    {gallery_states}
    {lane_card(dict(LANES[1] if len(LANES) > 1 else LANES[0], id="settings", open=True, settingsOpen=True), NOW)}
    {add_slot(True)}
    {add_slot(True, "preview", PREVIEW_EXAMPLE)}
    {setup_dialog(True, "who")}
    {setup_dialog(True, "preview", PREVIEW_EXAMPLE)}
    {controls(setup=True)}
    {confirm()}
    <div class="nw-alarms" data-part="app-alarm-demo">
      <div class="nw-alarm" role="alert" data-kind="daemon-down" data-acked="false">
        {icon("down")}<p data-part="title">The nightshift isn't running</p>
        <p data-part="cause">No heartbeat since 01:12. Bells, folds and wakes are all paused.</p>
        <div data-part="fixes"><button type="button" data-action="restart-daemon" data-part="fix">{icon("retry")}<span>Restart it</span></button>
          <button type="button" data-action="show-log" data-part="fix">{icon("log")}<span>Show log</span></button></div>
      </div>
    </div>
    <div class="nw-glyphs" aria-label="status glyph states">
      <span class="nw-glyph" data-phase="day"></span><span class="nw-glyph" data-phase="night"></span>
      <span class="nw-glyph" data-phase="belled"></span><span class="nw-glyph" data-phase="alarm"></span><span class="nw-glyph" data-phase="down"></span>
    </div>
  </section>
</div>
<script>
  // Mirror NW_VIEW onto the app and menu, the way the viewer will.
  const app = document.querySelector('.nw-app'), v = window.NW_VIEW;
  app.dataset.showControls = v.controls; app.dataset.showTimeline = v.timeline; app.dataset.showLog = v.log;
  document.querySelectorAll('.nw-controls [data-action="toggle-log"]').forEach((b) => b.setAttribute('aria-pressed', v.log));
  document.querySelectorAll('.nw-controls [data-action="toggle-timeline"]').forEach((b) => b.setAttribute('aria-pressed', v.timeline));
  app.dataset.timelineMode = v.timelineMode; app.dataset.layout = v.layout;
  const m = document.querySelector('[data-part="view-menu"]');
  m.dataset.open = v.menu; document.querySelector('[data-action="view-menu"]').setAttribute('aria-expanded', v.menu);
  m.querySelector('[data-view-toggle="controls"]').checked = v.controls;
  document.querySelector('[data-view-toggle="on-top"]').checked = v.onTop;
  m.querySelector(`[name="timeline-mode"][value="${{v.timelineMode}}"]`).checked = true;
  m.querySelector(`[name="layout"][value="${{v.layout}}"]`).checked = true;
  // ?fresh=1: the first-run look. The core module (head, deck, timeline,
  // log) keeps its shape with empty states; there is no lane row at all, since
  // adding the first agent is part of Set up.
  if (q.get('fresh') === '1') {{
    app.dataset.fresh = 'true';
    const deck = document.querySelector('.nw-app > .nw-controls');
    deck.replaceWith(document.querySelector('.nw-gallery .nw-controls[data-setup="true"]').cloneNode(true));
    document.querySelector('.nw-app > .nw-lanes').remove();
    const tl = document.querySelector('.nw-app > .nw-timeline');
    tl.dataset.empty = 'true'; tl.querySelectorAll('.nw-strip, [data-part="activity"]').forEach(e => e.remove());
    tl.querySelector('[data-part="heading"] span').textContent = '';
    tl.querySelector('[data-part="empty"]').hidden = false;
    const lg = document.querySelector('.nw-app > .nw-log');
    lg.dataset.empty = 'true'; lg.querySelector('[data-part="events"]').replaceChildren();
    lg.querySelector('[data-part="empty"]').hidden = false;
    document.querySelector('.nw-head .nw-glyph').dataset.phase = 'down';
  }}
</script>
</body>
</html>
'''

def apply_snapshot(snap):
    """Override the frozen-snapshot globals from a live snapshot dict.

    Additive seam for the live viewer (gui/server.mjs): the server assembles
    the same shapes this file freezes (LANES, NIGHT, LOG, ACTIVITY, NOW) from
    events.jsonl / folds.jsonl / weft.config.json and renders through the
    SAME emitters, so the fixture stays the one DOM contract and the viewer
    can't drift from it. Keys are optional; anything absent keeps the frozen
    value, so a partial snapshot still renders a whole page.
    """
    g = globals()
    for key in ("NOW", "TZ", "LANES", "NIGHT", "LOG", "ACTIVITY", "TIMELINE", "DECK", "SCHEDULE", "DAEMON", "ALARMS"):
        if key in snap:
            g[key] = snap[key]
    # JSON carries lists, not tuples; the emitters index positionally and
    # f-string them, so lists work as-is. Lane 'since'/'next' arrive as
    # 2/3-item lists — same access pattern, no conversion needed.


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    out = os.path.join(HERE, "fixture.html")
    if "--data" in args:
        with open(args[args.index("--data") + 1]) as f:
            apply_snapshot(json.load(f))
    if "--out" in args:
        out = args[args.index("--out") + 1]
    if out == "-":
        sys.stdout.write(page())
    else:
        with open(out, "w") as f:
            f.write(page())
        print("wrote", out, file=sys.stderr)
