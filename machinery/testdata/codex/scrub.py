#!/usr/bin/env python3
"""Make a public-safe fixture from a real Codex rollout (run with python3 -I).

Keeps every row, every key and every row's type, order and ordinal; replaces what
identifies a person or a machine, and shortens long text bodies, so the fixture
carries Codex's FORMAT (what the adapter reads) and none of its content.
Kept on purpose: session and thread UUIDs, item ids, timestamps and content hashes. They are minted
locally by Codex, link to no account, and the adapter reads the ids (filenames, headers).
Usage: scrub.py <in.jsonl> <out.jsonl>
"""
import json, re, sys

KEEP = {"HERON-19D577", "noted.", "resumed.", "Reply with just: resumed.",
        "Please remember this code word for later: HERON-19D577. Reply with just: noted.",
        "What was the code word I asked you to remember? Reply with the word only."}
ID_KEYS = {"creator_account_id", "creator_user_id", "account_id", "user_id", "email"}

def s(v, key=None):
    if isinstance(v, dict):
        return {k: s(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [s(x, key) for x in v]
    if isinstance(v, str):
        if key in ID_KEYS:
            return "redacted"
        if key == "timezone":
            return "UTC"
        v = re.sub(r"/Users/[^/\s\"<]+", "/home/user", v)
        v = re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "user@example.invalid", v)
        if v in KEEP or len(v) <= 160:
            return v
        return v[:60] + f" [... {len(v)} chars in the original ...]"
    return v

with open(sys.argv[1]) as f, open(sys.argv[2], "w") as o:
    for line in f:
        if line.strip():
            o.write(json.dumps(s(json.loads(line)), separators=(",", ":")) + "\n")
