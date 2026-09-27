import sys
import unicodedata
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sunobatch.naming import (  # noqa: E402
    cue_folder_name, safe_category, safe_file_stem, take_title, unique_destination,
)


class SafeFileStem(unittest.TestCase):
    def test_금지문자를_밑줄로_바꾼다(self):
        self.assertEqual(safe_file_stem('a/b:c*d?e"f<g>h|i'), "a_b_c_d_e_f_g_h_i")

    def test_한글을_NFC로_정규화한다(self):
        # macOS가 파일명을 넘길 때 쓰는 자모 분리 형태.
        decomposed = unicodedata.normalize("NFD", "황당")
        self.assertEqual(safe_file_stem(decomposed), "황당")

    def test_선행_점을_지워_숨김파일을_막는다(self):
        self.assertEqual(safe_file_stem("...secret"), "secret")

    def test_연속_공백을_한_칸으로_줄인다(self):
        self.assertEqual(safe_file_stem("a   b\t\tc"), "a b c")

    def test_제어문자를_지운다(self):
        self.assertEqual(safe_file_stem("a\u0000b\u001fc"), "abc")

    def test_120자로_자른다(self):
        self.assertEqual(len(safe_file_stem("가" * 200)), 120)

    def test_비면_폴백을_쓴다(self):
        self.assertEqual(safe_file_stem(""), "suno-audio")
        self.assertEqual(safe_file_stem("..."), "suno-audio")
        self.assertEqual(safe_file_stem(None), "suno-audio")
        self.assertEqual(safe_file_stem("", fallback="cue01"), "cue01")


class SafeCategory(unittest.TestCase):
    def test_경로_구분자를_이름에_남기지_않는다(self):
        # 앱이 `\ / >` 를 경로 구분자로 해석하므로 하위 폴더가 생기면 안 된다.
        self.assertEqual(safe_category("a/b"), "a b")
        self.assertEqual(safe_category("a\\b"), "a b")
        self.assertEqual(safe_category("a>b"), "a b")

    def test_금지문자를_하이픈으로_바꾼다(self):
        self.assertEqual(safe_category('a:b*c?d"e<f>g|h'), "a-b-c-d-e-f g-h")

    def test_빈_이름을_허용한다(self):
        self.assertEqual(safe_category(""), "")
        self.assertEqual(safe_category("   "), "")


class CueNaming(unittest.TestCase):
    def test_번호를_두_자리로_맞춘다(self):
        self.assertEqual(cue_folder_name(7, "첫 추격"), "Cue 07 첫 추격")
        self.assertEqual(cue_folder_name(50, "끝"), "Cue 50 끝")

    def test_이름이_없으면_번호만_쓴다(self):
        self.assertEqual(cue_folder_name(3), "Cue 03")
        self.assertEqual(cue_folder_name(3, "   "), "Cue 03")

    def test_제목_형식이_고정이다(self):
        # 몇 달 뒤 라이브러리에서 곡을 찾는 유일한 열쇠라 형식이 흔들리면 안 된다.
        self.assertEqual(take_title(1, 1), "CUE01-T01")
        self.assertEqual(take_title(50, 10), "CUE50-T10")


class UniqueDestination(unittest.TestCase):
    def test_겹치면_번호를_붙인다(self):
        import tempfile

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = unique_destination(root, "a.wav")
            self.assertEqual(first.name, "a.wav")
            first.touch()
            second = unique_destination(root, "a.wav")
            self.assertEqual(second.name, "a 2.wav")
            second.touch()
            self.assertEqual(unique_destination(root, "a.wav").name, "a 3.wav")


if __name__ == "__main__":
    unittest.main()
