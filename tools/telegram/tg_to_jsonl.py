#!/usr/bin/env python3
"""Convert Telegram Desktop JSON exports into `jot import` JSONL, routing sensitive notes to a locked channel.

Runs locally, standard library only, and never prints note text. Run it yourself; no agent should
open the exports or the output (the output holds plaintext until `jot import` encrypts it).

    python3 -I tg_to_jsonl.py \
        --sensitive <ideas-group-export>/result.json \
        --locked-channel <locked channel id> \
        --out ~/jot-import/notes.jsonl \
        <main-channel-export>/result.json [<other-export>/result.json ...]

Routing (fails toward locked; see docs/adr/0012-telegram-import-routing.md):
  * Every message in a --sensitive export goes to the locked channel, and so does every message of
    that chat (same chat id) wherever else it appears, e.g. in a full-account export.
  * A message in any other export whose text (or, for text-less media, file size) matches a
    sensitive message also goes to the locked channel, keeping the original's date. Its forwarded
    copy in the sensitive export is then skipped as a duplicate.
  * --lock-chat NAME sends a whole chat to the locked channel. A NAME that matches no chat is an
    error (a typo must not leave that chat open).
  * Everything else goes to an OPEN channel with the same name as its Telegram chat (agent-readable).
    Create those channels first (`jot channels create <name>`); the summary lists them.

Rerunning is safe: `jot import` is idempotent by source_id (tg-<chat id>-<message id>).
"""
import argparse
from datetime import datetime, timezone
import json
import mimetypes
import os
import re
import sys

LINK_ENTITIES = {"link", "text_link"}
NOT_INCLUDED = "(File not included"


def chats(data):
    if "messages" in data:  # single chat export
        yield data
    for c in data.get("chats", {}).get("list", []):  # full account export
        yield c


def flat_text(msg):
    t = msg.get("text", "")
    if isinstance(t, str):
        return t
    return "".join(p if isinstance(p, str) else p.get("text", "") for p in t)


def norm(text):
    return re.sub(r"\s+", " ", text).strip().casefold()


def media(msg, base):
    """(absolute path or None, mime, file size or None) for the message's photo/file, if any."""
    rel = msg.get("photo") or msg.get("file")
    size = msg.get("photo_file_size") or msg.get("file_size")
    if not rel or rel.startswith(NOT_INCLUDED):
        return None, None, size
    path = os.path.join(base, rel)
    mime = msg.get("mime_type") or mimetypes.guess_type(path)[0] or "application/octet-stream"
    return (path if os.path.exists(path) else None), mime, size


def keys(msg):
    """Match keys: normalized text if any, else media type + size."""
    t = norm(flat_text(msg))
    if t:
        return {("t", t)}
    size = msg.get("photo_file_size") or msg.get("file_size")
    kind = "photo" if msg.get("photo") else msg.get("media_type") or ("file" if msg.get("file") else None)
    return {("m", kind, size)} if kind and size else set()


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f), os.path.dirname(os.path.abspath(path))


def record(msg, chat, base, channel):
    text = flat_text(msg)
    links = []
    for e in msg.get("text_entities", []):
        if e.get("type") in LINK_ENTITIES:
            href = e.get("href") or e.get("text", "")
            if href and href not in links:
                links.append(href)
    rec = {
        "channel": channel,
        "created_at": msg.get("date", ""),
        "text": text,
        "links": links,
        "source_id": f"tg-{chat.get('id', 'x')}-{msg['id']}",
    }
    path, mime, _ = media(msg, base)
    if path:
        rec["attachments"] = [{"path": path, "mime": mime}]
    # Prefer the exact Unix time; otherwise Telegram's `date` is local time without an offset,
    # so attach this machine's offset.
    unix = msg.get("date_unixtime")
    if unix:
        rec["created_at"] = datetime.fromtimestamp(int(unix), timezone.utc).isoformat()
    elif rec["created_at"] and not re.search(r"(Z|[+-]\d\d:\d\d)$", rec["created_at"]):
        rec["created_at"] = datetime.fromisoformat(rec["created_at"]).astimezone().isoformat()
    return rec, bool(text.strip() or path)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("exports", nargs="*", help="result.json of the other chats")
    ap.add_argument("--sensitive", action="append", default=[], help="result.json of the sensitive group")
    ap.add_argument("--locked-channel", required=True, help="locked jot channel id")
    ap.add_argument("--lock-chat", action="append", default=[], help="send this whole chat to locked")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    say = lambda s: print(s, file=sys.stderr)

    sens_keys = set()
    sens_msgs = []
    sens_chats = set()
    for p in a.sensitive:
        data, base = load(p)
        for chat in chats(data):
            if chat.get("id") is not None:
                sens_chats.add(chat["id"])
            for m in chat.get("messages", []):
                if m.get("type") == "message":
                    sens_msgs.append((m, chat, base))
                    sens_keys |= keys(m)

    # Check --lock-chat names before routing anything.
    names = set()
    for p in a.exports:
        for chat in chats(load(p)[0]):
            names.add(chat.get("name") or f"tg-{chat.get('id')}")
    missing = [n for n in a.lock_chat if n not in names]
    if missing:
        say("error: --lock-chat names that match no chat in the exports (nothing written):")
        for n in missing:
            say(f"  {n}")
        return 2

    out, open_channels = [], {}
    matched_keys = set()
    n_locked = n_open = n_empty = 0
    for p in a.exports:
        data, base = load(p)
        for chat in chats(data):
            if chat.get("id") in sens_chats:
                continue  # the sensitive chat itself: all of it goes to locked below
            name = chat.get("name") or f"tg-{chat.get('id')}"
            whole = name in a.lock_chat
            for m in chat.get("messages", []):
                if m.get("type") != "message":
                    continue
                k = keys(m)
                hit = whole or bool(k & sens_keys)
                if hit:
                    matched_keys |= k & sens_keys
                rec, nonempty = record(m, chat, base, a.locked_channel if hit else name)
                if not nonempty:
                    n_empty += 1
                    continue
                out.append(rec)
                if hit:
                    n_locked += 1
                else:
                    n_open += 1
                    open_channels[name] = open_channels.get(name, 0) + 1

    unmatched = []
    for m, chat, base in sens_msgs:
        k = keys(m)
        if k and k <= matched_keys:
            continue  # the original is already routed to locked
        rec, nonempty = record(m, chat, base, a.locked_channel)
        if nonempty:
            out.append(rec)
            n_locked += 1
            unmatched.append(m)

    out.sort(key=lambda r: r["created_at"])
    fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    say(f"wrote {len(out)} notes to {a.out} (mode 600): {n_locked} locked, {n_open} open, {n_empty} empty skipped")
    say(f"sensitive messages: {len(sens_msgs)}; originals found in other exports: {len(sens_msgs) - len(unmatched)}")
    if unmatched and a.exports:
        say("not found in other exports (imported as locked from the sensitive group; check their originals by hand):")
        for m in unmatched:
            say(f"  message {m['id']}, {m.get('date', '')}")
    say("open channels to create first (agent-readable):")
    for n, c in sorted(open_channels.items()):
        say(f"  {n}: {c}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
