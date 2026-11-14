"""Tests for tg_to_jsonl.py on synthetic Telegram exports (no real data)."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tg_to_jsonl.py")
LOCKED = "01SYNTHETICLOCKEDCHANNEL00"


def msg(id, text="", unix=1700000000, **extra):
    return {"id": id, "type": "message", "date": "2023-11-14T22:13:20", "date_unixtime": str(unix),
            "text": text, "text_entities": [], **extra}


def chat(id, name, messages):
    return {"id": id, "name": name, "type": "personal_chat", "messages": messages}


class Converter(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.out = os.path.join(self.dir, "out.jsonl")

    def tearDown(self):
        self.tmp.cleanup()

    def export(self, name, data):
        d = os.path.join(self.dir, name)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "result.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return path

    def run_tool(self, *args):
        r = subprocess.run([sys.executable, "-I", SCRIPT, "--locked-channel", LOCKED,
                            "--out", self.out, *args], capture_output=True, text=True)
        return r

    def records(self):
        with open(self.out, encoding="utf-8") as f:
            return [json.loads(line) for line in f]

    def test_routes_matches_to_locked_and_the_rest_to_open(self):
        main = self.export("main", chat(1, "Main", [
            msg(10, "synthetic open thought", unix=1700000000),
            msg(11, "Synthetic   SECRET idea", unix=1700000100),  # original of a forwarded copy
            msg(12, [{"type": "text_link", "text": "here", "href": "https://example.com/a"}, " link"],
                text_entities=[{"type": "text_link", "text": "here", "href": "https://example.com/a"}]),
            msg(13, photo="photos/p.jpg", photo_file_size=4321),  # media-only original
            msg(14, ""),  # empty: skipped
            {"id": 15, "type": "service", "action": "pin_message"},
        ]))
        sens = self.export("sens", chat(2, "ASI", [
            msg(20, "synthetic secret idea", unix=1700009999),  # forwarded copy, other spacing/case
            msg(21, photo="photos/q.jpg", photo_file_size=4321),
            msg(22, "only in the sensitive group"),
        ]))
        os.makedirs(os.path.join(self.dir, "main", "photos"))
        with open(os.path.join(self.dir, "main", "photos", "p.jpg"), "wb") as f:
            f.write(b"\xff\xd8synthetic")
        r = self.run_tool("--sensitive", sens, main)
        self.assertEqual(r.returncode, 0, r.stderr)
        recs = {x["source_id"]: x for x in self.records()}
        self.assertEqual(recs["tg-1-13"]["attachments"][0]["mime"], "image/jpeg")
        self.assertEqual(sorted(recs), ["tg-1-10", "tg-1-11", "tg-1-12", "tg-1-13", "tg-2-22"])
        self.assertEqual(recs["tg-1-10"]["channel"], "Main")
        self.assertEqual(recs["tg-1-12"]["channel"], "Main")
        self.assertEqual(recs["tg-1-12"]["links"], ["https://example.com/a"])
        # The original keeps its own date; the forwarded copy is not imported twice.
        self.assertEqual(recs["tg-1-11"]["channel"], LOCKED)
        self.assertEqual(recs["tg-1-11"]["created_at"], "2023-11-14T22:15:00+00:00")
        self.assertEqual(recs["tg-1-13"]["channel"], LOCKED)
        self.assertEqual(recs["tg-2-22"]["channel"], LOCKED)
        # Output is private and the summary never prints note text.
        self.assertEqual(stat.S_IMODE(os.stat(self.out).st_mode), 0o600)
        for word in ("synthetic", "secret", "example.com"):
            self.assertNotIn(word, (r.stdout + r.stderr).lower())
        self.assertIn("Main: 2", r.stderr)

    def test_sensitive_chat_inside_a_full_account_export_stays_locked(self):
        sens = self.export("sens", chat(2, "ASI", [msg(20, "synthetic private note")]))
        full = self.export("full", {"chats": {"list": [
            chat(1, "Main", [msg(10, "synthetic open note")]),
            # Same chat as the sensitive export, with a message newer than that export.
            chat(2, "ASI", [msg(20, "synthetic private note"), msg(21, "synthetic newer private")]),
        ]}})
        r = self.run_tool("--sensitive", sens, full)
        self.assertEqual(r.returncode, 0, r.stderr)
        recs = {x["source_id"]: x["channel"] for x in self.records()}
        self.assertEqual(recs, {"tg-1-10": "Main", "tg-2-20": LOCKED})
        self.assertNotIn("ASI", r.stderr.split("open channels to create first")[1])

    def test_lock_chat_sends_a_whole_chat_to_locked(self):
        main = self.export("main", {"chats": {"list": [
            chat(1, "Main", [msg(10, "synthetic a")]),
            chat(3, "Diary", [msg(30, "synthetic b"), msg(31, "synthetic c")]),
        ]}})
        r = self.run_tool("--lock-chat", "Diary", main)
        self.assertEqual(r.returncode, 0, r.stderr)
        recs = {x["source_id"]: x["channel"] for x in self.records()}
        self.assertEqual(recs, {"tg-1-10": "Main", "tg-3-30": LOCKED, "tg-3-31": LOCKED})

    def test_unknown_lock_chat_is_an_error_and_writes_nothing(self):
        main = self.export("main", chat(3, "Diary", [msg(30, "synthetic b")]))
        r = self.run_tool("--lock-chat", "Dairy", main)
        self.assertEqual(r.returncode, 2)
        self.assertIn("Dairy", r.stderr)
        self.assertFalse(os.path.exists(self.out))

    def test_local_date_without_unixtime_gets_an_offset(self):
        m = msg(10, "synthetic")
        del m["date_unixtime"]
        main = self.export("main", chat(1, "Main", [m]))
        self.assertEqual(self.run_tool(main).returncode, 0)
        self.assertRegex(self.records()[0]["created_at"], r"^2023-11-14T22:13:20[+-]\d\d:\d\d$")


if __name__ == "__main__":
    unittest.main()
