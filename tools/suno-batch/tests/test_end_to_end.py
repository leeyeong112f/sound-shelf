"""모의 Suno 페이지로 생성→다운로드→볼트 배치 전 과정을 돌린다.

진짜 Suno에는 접속하지 않는다. 확인하는 것은 우리 쪽 코드다 — 셀렉터 계약,
기다리는 로직, manifest 갱신, 다운로드 저장, 볼트 배치, 그리고 다운로드 한도를
만났을 때 멈추는지.
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOCK = Path(__file__).resolve().parent / "mock_suno"
sys.path.insert(0, str(ROOT))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def find_chromium():
    """Playwright가 자기 브라우저를 못 받은 환경을 위한 폴백."""
    for pattern in ("/opt/pw-browsers/chromium*/chrome-linux/chrome",
                    "/opt/pw-browsers/chromium*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"):
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]
    return ""


def browser_available():
    if find_chromium():
        return True
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as driver:
            browser = driver.chromium.launch(headless=True)
            browser.close()
        return True
    except Exception:
        return False


PROMPTS = {
    "project": "시험 영화",
    "cues": [
        {"id": 1, "name": "오프닝", "takes": [
            {"take": 1, "style": "cold expansive strings, slow swell"},
            {"take": 2, "style": "sparse piano, wide reverb"},
        ]},
        {"id": 2, "name": "첫 추격", "takes": [
            {"take": 1, "style": "fast percussion, driving low brass"},
        ]},
    ],
}


@unittest.skipUnless(browser_available(), "브라우저를 띄울 수 없는 환경")
class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        handler = partial(QuietHandler, directory=str(MOCK))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.work = self.base / "work"
        self.profile = self.base / "profile"
        self.vault = self.base / "vault"
        (self.vault / ".sound-shelf").mkdir(parents=True)
        self.prompts = self.base / "prompts.json"
        self.prompts.write_text(json.dumps(PROMPTS, ensure_ascii=False), encoding="utf-8")

        self.env = dict(os.environ)
        self.env["SUNO_BATCH_NO_SANDBOX"] = "1"
        chromium = find_chromium()
        if chromium:
            self.env["SUNO_BATCH_CHROMIUM"] = chromium

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args, library_path="/library.html"):
        command = [sys.executable, str(ROOT / "suno_batch.py"), *args,
                   "--work", str(self.work), "--profile", str(self.profile),
                   "--base-url", f"http://127.0.0.1:{self.port}",
                   "--create-path", "/create.html", "--library-path", library_path,
                   "--headless", "--no-delay"]
        return subprocess.run(command, capture_output=True, text=True, env=self.env, timeout=300)

    def manifest(self):
        return json.loads((self.work / "manifest.json").read_text(encoding="utf-8"))

    def test_생성부터_볼트_배치까지_한_번에_돈다(self):
        made = self.run_cli("generate", "--prompts", str(self.prompts))
        self.assertEqual(made.returncode, 0, made.stdout + made.stderr)
        self.assertIn("생성 3곡", made.stdout)

        book = self.manifest()
        self.assertEqual(len(book["items"]), 3)
        for title in ("CUE01-T01", "CUE01-T02", "CUE02-T01"):
            self.assertEqual(book["items"][title]["status"], "generated", title)
            self.assertTrue(book["items"][title]["suno_clip_id"], title)

        got = self.run_cli("download", "--prompts", str(self.prompts), "--vault", str(self.vault))
        self.assertEqual(got.returncode, 0, got.stdout + got.stderr)

        # cue별 폴더에 WAV가 들어갔는가
        self.assertTrue((self.vault / "Cue 01 오프닝" / "CUE01-T01.wav").is_file(), got.stdout)
        self.assertTrue((self.vault / "Cue 01 오프닝" / "CUE01-T02.wav").is_file())
        self.assertTrue((self.vault / "Cue 02 첫 추격" / "CUE02-T01.wav").is_file())

        book = self.manifest()
        self.assertEqual(book["items"]["CUE01-T01"]["status"], "placed")
        self.assertEqual(book["items"]["CUE01-T01"]["placed_path"], "Cue 01 오프닝/CUE01-T01.wav")

    def test_이어서_돌리면_이미_만든_것을_건너뛴다(self):
        first = self.run_cli("generate", "--prompts", str(self.prompts), "--limit", "1")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertIn("생성 1곡", first.stdout)

        second = self.run_cli("generate", "--prompts", str(self.prompts))
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        # 남은 2곡만 만들어야 한다.
        self.assertIn("생성 2곡", second.stdout)

        statuses = {t: i["status"] for t, i in self.manifest()["items"].items()}
        self.assertEqual(set(statuses.values()), {"generated"})

    def test_고른_것만_받는다(self):
        self.run_cli("generate", "--prompts", str(self.prompts))
        got = self.run_cli("download", "--prompts", str(self.prompts),
                           "--vault", str(self.vault), "--only", "CUE02-T01")
        self.assertEqual(got.returncode, 0, got.stdout + got.stderr)

        self.assertTrue((self.vault / "Cue 02 첫 추격" / "CUE02-T01.wav").is_file())
        self.assertFalse((self.vault / "Cue 01 오프닝").exists())
        self.assertEqual(self.manifest()["items"]["CUE01-T01"]["status"], "generated")

    def test_받은_WAV가_진짜_오디오다(self):
        self.run_cli("generate", "--prompts", str(self.prompts))
        self.run_cli("download", "--prompts", str(self.prompts),
                     "--vault", str(self.vault), "--only", "CUE01-T01")
        placed = self.vault / "Cue 01 오프닝" / "CUE01-T01.wav"
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(placed)],
            capture_output=True, text=True,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr)
        self.assertTrue(probe.stdout.strip().startswith("pcm_"), probe.stdout)

    def test_status가_진행을_보여준다(self):
        self.run_cli("generate", "--prompts", str(self.prompts), "--limit", "2")
        shown = self.run_cli("status")
        self.assertEqual(shown.returncode, 0, shown.stdout + shown.stderr)
        self.assertIn("생성됨", shown.stdout)
        self.assertIn("대기", shown.stdout)

    def test_다운로드_한도에_막히면_그_자리에서_멈춘다(self):
        # 화면의 남은 횟수가 낡았거나 안 보일 때 도중에 막히는 상황이다.
        # 우회하지 않고 멈춰야 하고, 이미 받은 것은 볼트에 남아야 한다.
        self.run_cli("generate", "--prompts", str(self.prompts))
        got = self.run_cli("download", "--prompts", str(self.prompts), "--vault", str(self.vault),
                           library_path="/library.html?quota=20&wall_after=1")
        self.assertEqual(got.returncode, 0, got.stdout + got.stderr)
        self.assertIn("한도에 걸려 멈췄습니다", got.stdout)

        placed = sorted(p.name for p in self.vault.rglob("*.wav"))
        self.assertEqual(len(placed), 1, f"한 곡만 받아야 한다: {placed}\n{got.stdout}")

        statuses = {t: i["status"] for t, i in self.manifest()["items"].items()}
        self.assertEqual(sum(1 for v in statuses.values() if v == "placed"), 1)
        # 나머지는 실패가 아니라 그대로 대기 상태여야 다음 달에 이어받는다.
        self.assertEqual(sum(1 for v in statuses.values() if v == "generated"), 2, statuses)

    def test_예행은_아무것도_만들지_않는다(self):
        dry = self.run_cli("generate", "--prompts", str(self.prompts), "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
        self.assertIn("CUE01-T01", dry.stdout)
        statuses = {i["status"] for i in self.manifest()["items"].values()}
        self.assertEqual(statuses, {"pending"})


if __name__ == "__main__":
    unittest.main()
