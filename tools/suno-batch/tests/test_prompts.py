import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sunobatch.prompts import PromptError, load_prompts, parse_prompts  # noqa: E402


def payload(**overrides):
    base = {
        "project": "영화 제목",
        "cues": [
            {
                "id": 1,
                "name": "오프닝",
                "takes": [
                    {"take": 1, "title": "CUE01-T01", "style": "cold ambient strings", "instrumental": True},
                    {"take": 2, "title": "CUE01-T02", "style": "sparse piano, wide reverb"},
                ],
            },
            {
                "id": 2,
                "name": "첫 추격",
                "takes": [{"take": 1, "title": "CUE02-T01", "style": "fast percussion"}],
            },
        ],
    }
    base.update(overrides)
    return base


class ValidInput(unittest.TestCase):
    def test_평탄한_take_목록을_돌려준다(self):
        result = parse_prompts(payload())
        self.assertEqual(len(result.takes), 3)
        self.assertEqual([t.title for t in result.takes], ["CUE01-T01", "CUE01-T02", "CUE02-T01"])

    def test_cue_이름을_take마다_실어준다(self):
        result = parse_prompts(payload())
        self.assertEqual(result.takes[0].cue_name, "오프닝")
        self.assertEqual(result.takes[2].cue_name, "첫 추격")

    def test_instrumental은_기본값이_참이다(self):
        result = parse_prompts(payload())
        self.assertTrue(result.takes[1].instrumental)

    def test_title이_없으면_규칙대로_만들어_넣는다(self):
        data = payload()
        del data["cues"][0]["takes"][0]["title"]
        result = parse_prompts(data)
        self.assertEqual(result.takes[0].title, "CUE01-T01")

    def test_cue_목록과_이름을_조회할_수_있다(self):
        result = parse_prompts(payload())
        self.assertEqual(result.cue_ids, [1, 2])
        self.assertEqual(result.cue_name(2), "첫 추격")
        self.assertEqual(result.cue_name(99), "")


class InvalidInput(unittest.TestCase):
    def assertRejects(self, mutate, fragment):
        data = copy.deepcopy(payload())
        mutate(data)
        with self.assertRaises(PromptError) as caught:
            parse_prompts(data)
        self.assertIn(fragment, str(caught.exception))

    def test_project가_비면_거부한다(self):
        self.assertRejects(lambda d: d.update(project="  "), "project")

    def test_cues가_비면_거부한다(self):
        self.assertRejects(lambda d: d.update(cues=[]), "cues")

    def test_cue_id가_중복이면_거부한다(self):
        self.assertRejects(lambda d: d["cues"][1].update(id=1), "두 번")

    def test_cue_id가_범위를_벗어나면_거부한다(self):
        self.assertRejects(lambda d: d["cues"][0].update(id=0), "1~999")

    def test_take가_비면_거부한다(self):
        self.assertRejects(lambda d: d["cues"][0].update(takes=[]), "takes")

    def test_take_번호가_중복이면_거부한다(self):
        self.assertRejects(lambda d: d["cues"][0]["takes"][1].update(take=1, title="CUE01-T01"), "두 번")

    def test_style이_비면_거부한다(self):
        self.assertRejects(lambda d: d["cues"][0]["takes"][0].update(style="   "), "style")

    def test_style이_너무_길면_거부한다(self):
        self.assertRejects(lambda d: d["cues"][0]["takes"][0].update(style="x" * 1001), "1000자")

    def test_title이_규칙과_다르면_거부한다(self):
        # 제목은 나중에 곡을 찾는 유일한 열쇠라 형식이 어긋나면 받아주면 안 된다.
        self.assertRejects(lambda d: d["cues"][0]["takes"][0].update(title="오프닝 1번"), "CUE01-T01")

    def test_instrumental이_불리언이_아니면_거부한다(self):
        self.assertRejects(lambda d: d["cues"][0]["takes"][0].update(instrumental="yes"), "true/false")


class FileLoading(unittest.TestCase):
    def test_파일에서_읽는다(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "prompts.json"
            target.write_text(json.dumps(payload(), ensure_ascii=False), encoding="utf-8")
            self.assertEqual(len(load_prompts(target).takes), 3)

    def test_깨진_JSON은_읽을_수_없다고_알려준다(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "prompts.json"
            target.write_text("{ not json", encoding="utf-8")
            with self.assertRaises(PromptError) as caught:
                load_prompts(target)
            self.assertIn("JSON", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
