import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sunobatch.vault import (  # noqa: E402
    VaultError, check_vault, convert_to_wav, ensure_cue_folder, place, relative_to_vault,
)


def make_vault(root: Path) -> Path:
    """앱이 만드는 볼트 표식을 흉내 낸다."""
    (root / ".sound-shelf").mkdir(parents=True)
    return root


def make_audio(path: Path, seconds: float = 0.4) -> Path:
    """시험용 오디오를 진짜로 만든다. 변환이 도는지 보려면 실제 파일이어야 한다."""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", f"sine=frequency=440:duration={seconds}", str(path)],
        check=True, capture_output=True,
    )
    return path


class CheckVault(unittest.TestCase):
    def test_볼트가_아니면_거부한다(self):
        # 엉뚱한 폴더에 500곡을 쏟지 않도록 하는 방어선이다.
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(VaultError) as caught:
                check_vault(folder)
            self.assertIn("볼트가 아닙니다", str(caught.exception))

    def test_폴더가_없으면_거부한다(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(VaultError):
                check_vault(Path(folder) / "없음")

    def test_볼트면_통과한다(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_vault(Path(folder))
            self.assertEqual(check_vault(root), root.resolve())


class CueFolders(unittest.TestCase):
    def test_cue_폴더를_만든다(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_vault(Path(folder))
            created = ensure_cue_folder(root, 7, "첫 추격")
            self.assertTrue(created.is_dir())
            self.assertEqual(created.name, "Cue 07 첫 추격")

    def test_이미_있으면_그대로_쓴다(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_vault(Path(folder))
            first = ensure_cue_folder(root, 3, "밤")
            (first / "기존.wav").touch()
            second = ensure_cue_folder(root, 3, "밤")
            self.assertEqual(first, second)
            self.assertTrue((second / "기존.wav").exists())

    def test_하위_폴더를_만들지_않는다(self):
        # 이름에 `/` 가 들어가도 한 단계로 눌러야 앱의 카테고리 해석과 어긋나지 않는다.
        with tempfile.TemporaryDirectory() as folder:
            root = make_vault(Path(folder))
            created = ensure_cue_folder(root, 5, "추격/도주")
            self.assertEqual(created.parent, root.resolve())
            self.assertEqual(created.name, "Cue 05 추격 도주")


class Conversion(unittest.TestCase):
    def test_mp3를_24bit_WAV로_바꾼다(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            source = make_audio(work / "src.mp3")
            output = convert_to_wav(source, work / "out.wav")
            self.assertTrue(output.is_file())
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "a:0",
                 "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(output)],
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(probe.stdout.strip(), "pcm_s24le")

    def test_없는_파일은_알려준다(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(VaultError):
                convert_to_wav(Path(folder) / "없음.mp3", Path(folder) / "out.wav")

    def test_ffmpeg가_없으면_설치_안내를_준다(self):
        with tempfile.TemporaryDirectory() as folder:
            source = make_audio(Path(folder) / "src.mp3")
            with self.assertRaises(VaultError) as caught:
                convert_to_wav(source, Path(folder) / "out.wav", ffmpeg="ffmpeg-없음")
            self.assertIn("brew install ffmpeg", str(caught.exception))

    def test_변환_실패하면_반쪽_파일을_남기지_않는다(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            broken = work / "broken.mp3"
            broken.write_bytes(b"not audio at all")
            output = work / "out.wav"
            with self.assertRaises(VaultError):
                convert_to_wav(broken, output)
            self.assertFalse(output.exists())


class Placement(unittest.TestCase):
    def test_변환해서_cue_폴더에_넣는다(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            root = make_vault(base / "vault")
            work = base / "work"
            work.mkdir()
            source = make_audio(work / "downloaded.mp3")

            placed = place(root, 1, "오프닝", source, "CUE01-T01", work)
            self.assertTrue(placed.is_file())
            self.assertEqual(placed.name, "CUE01-T01.wav")
            self.assertEqual(placed.parent.name, "Cue 01 오프닝")

    def test_이미_WAV면_변환하지_않고_옮긴다(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            root = make_vault(base / "vault")
            work = base / "work"
            work.mkdir()
            source = make_audio(work / "downloaded.wav")

            placed = place(root, 2, "추격", source, "CUE02-T03", work)
            self.assertTrue(placed.is_file())
            self.assertFalse(source.exists(), "원본을 옮겨야 한다")

    def test_이름이_겹치면_번호를_붙인다(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            root = make_vault(base / "vault")
            work = base / "work"
            work.mkdir()

            first = place(root, 1, "오프닝", make_audio(work / "a.wav"), "CUE01-T01", work)
            second = place(root, 1, "오프닝", make_audio(work / "b.wav"), "CUE01-T01", work)
            self.assertEqual(first.name, "CUE01-T01.wav")
            self.assertEqual(second.name, "CUE01-T01 2.wav")

    def test_볼트가_아니면_배치하지_않는다(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            work = base / "work"
            work.mkdir()
            source = make_audio(work / "a.wav")
            with self.assertRaises(VaultError):
                place(base / "볼트아님", 1, "오프닝", source, "CUE01-T01", work)

    def test_볼트_기준_상대경로를_준다(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            root = make_vault(base / "vault")
            work = base / "work"
            work.mkdir()
            placed = place(root, 4, "밤", make_audio(work / "a.wav"), "CUE04-T01", work)
            self.assertEqual(relative_to_vault(root, placed), "Cue 04 밤/CUE04-T01.wav")


if __name__ == "__main__":
    unittest.main()
