import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sunobatch.manifest import (  # noqa: E402
    DOWNLOADED, FAILED, GENERATED, PENDING, PLACED, Manifest,
)
from sunobatch.prompts import parse_prompts  # noqa: E402


def prompt_set(cues=2, takes=2):
    return parse_prompts({
        "project": "영화",
        "cues": [
            {
                "id": cue,
                "name": f"cue{cue}",
                "takes": [{"take": t, "style": f"style {cue}-{t}"} for t in range(1, takes + 1)],
            }
            for cue in range(1, cues + 1)
        ],
    })


class Syncing(unittest.TestCase):
    def test_프롬프트에서_항목을_만든다(self):
        with tempfile.TemporaryDirectory() as folder:
            book = Manifest(Path(folder) / "m.json")
            self.assertEqual(book.sync_from_prompts(prompt_set()), 4)
            self.assertEqual(sorted(book.items), ["CUE01-T01", "CUE01-T02", "CUE02-T01", "CUE02-T02"])
            self.assertEqual(book.items["CUE01-T01"]["status"], PENDING)

    def test_다시_동기화해도_진행_상태를_잃지_않는다(self):
        # 몇 달에 걸쳐 돌리므로 이게 깨지면 처음부터 다시 받게 된다.
        with tempfile.TemporaryDirectory() as folder:
            book = Manifest(Path(folder) / "m.json")
            book.sync_from_prompts(prompt_set())
            book.mark("CUE01-T01", DOWNLOADED, suno_clip_id="abc")
            self.assertEqual(book.sync_from_prompts(prompt_set()), 0)
            self.assertEqual(book.items["CUE01-T01"]["status"], DOWNLOADED)
            self.assertEqual(book.items["CUE01-T01"]["suno_clip_id"], "abc")

    def test_cue가_늘면_새_항목만_추가한다(self):
        with tempfile.TemporaryDirectory() as folder:
            book = Manifest(Path(folder) / "m.json")
            book.sync_from_prompts(prompt_set(cues=1))
            self.assertEqual(book.sync_from_prompts(prompt_set(cues=2)), 2)
            self.assertEqual(len(book.items), 4)


class StatusChanges(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.book = Manifest(Path(self.folder.name) / "m.json")
        self.book.sync_from_prompts(prompt_set())

    def tearDown(self):
        self.folder.cleanup()

    def test_필드를_함께_기록한다(self):
        self.book.mark("CUE01-T01", GENERATED, suno_clip_id="xyz", suno_url="https://suno.com/song/xyz")
        item = self.book.get("CUE01-T01")
        self.assertEqual(item["status"], GENERATED)
        self.assertEqual(item["suno_url"], "https://suno.com/song/xyz")

    def test_성공하면_이전_실패_기록을_지운다(self):
        self.book.mark_failed("CUE01-T01", "타임아웃")
        self.assertEqual(self.book.get("CUE01-T01")["error"], "타임아웃")
        self.book.mark("CUE01-T01", GENERATED)
        self.assertIsNone(self.book.get("CUE01-T01")["error"])

    def test_긴_오류_메시지를_자른다(self):
        self.book.mark_failed("CUE01-T01", "x" * 900)
        self.assertEqual(len(self.book.get("CUE01-T01")["error"]), 500)

    def test_상태로_골라낸다(self):
        self.book.mark("CUE01-T01", GENERATED)
        self.book.mark("CUE02-T01", DOWNLOADED)
        self.assertEqual([t for t, _ in self.book.with_status(GENERATED, DOWNLOADED)],
                         ["CUE01-T01", "CUE02-T01"])

    def test_실패만_되돌린다(self):
        self.book.mark("CUE01-T01", PLACED)
        self.book.mark_failed("CUE02-T01", "깨짐")
        self.assertEqual(self.book.reset_failed(), 1)
        self.assertEqual(self.book.get("CUE01-T01")["status"], PLACED)
        self.assertEqual(self.book.get("CUE02-T01")["status"], PENDING)

    def test_없는_항목은_알려준다(self):
        with self.assertRaises(KeyError):
            self.book.get("CUE99-T99")

    def test_상태를_센다(self):
        self.book.mark("CUE01-T01", PLACED)
        self.book.mark_failed("CUE02-T02", "x")
        tally = self.book.counts()
        self.assertEqual(tally[PENDING], 2)
        self.assertEqual(tally[PLACED], 1)
        self.assertEqual(tally[FAILED], 1)


class Persistence(unittest.TestCase):
    def test_저장하고_다시_읽는다(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "sub" / "m.json"
            book = Manifest(path)
            book.sync_from_prompts(prompt_set())
            book.mark("CUE01-T01", DOWNLOADED, downloaded_path="/tmp/a.wav")
            book.save()

            reloaded = Manifest.load(path)
            self.assertEqual(reloaded.get("CUE01-T01")["downloaded_path"], "/tmp/a.wav")
            self.assertEqual(reloaded.data["project"], "영화")

    def test_없는_파일은_빈_manifest로_연다(self):
        with tempfile.TemporaryDirectory() as folder:
            book = Manifest.load(Path(folder) / "없음.json")
            self.assertEqual(book.items, {})

    def test_임시파일을_남기지_않는다(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "m.json"
            Manifest(path).save()
            self.assertEqual([p.name for p in Path(folder).iterdir()], ["m.json"])

    def test_모르는_스키마는_거부한다(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "m.json"
            path.write_text(json.dumps({"schema": 99, "items": {}}), encoding="utf-8")
            with self.assertRaises(ValueError):
                Manifest.load(path)

    def test_한글을_그대로_저장한다(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "m.json"
            book = Manifest(path)
            book.sync_from_prompts(prompt_set())
            book.save()
            self.assertIn("영화", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
