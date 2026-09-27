"""토글 상태 판독.

잘못 읽으면 인스트루멘털이 꺼진 채 500곡이 나온다. 못 읽겠으면 멈추는 쪽이
맞다는 걸 고정해 둔다.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sunobatch.generate import toggle_state  # noqa: E402


class FakeLocator:
    """Playwright Locator 중 toggle_state가 쓰는 것만 흉내 낸다."""

    def __init__(self, attributes=None, checkbox=False, checked=False):
        self.attributes = attributes or {}
        self.checkbox = checkbox
        self.checked = checked

    def get_attribute(self, name):
        return self.attributes.get(name)

    def evaluate(self, _script):
        return self.checkbox

    def is_checked(self):
        return self.checked


class ReadsExplicitSignals(unittest.TestCase):
    def test_aria_pressed를_믿는다(self):
        self.assertTrue(toggle_state(FakeLocator({"aria-pressed": "true"})))
        self.assertFalse(toggle_state(FakeLocator({"aria-pressed": "false"})))

    def test_aria_checked를_믿는다(self):
        self.assertTrue(toggle_state(FakeLocator({"aria-checked": "true"})))

    def test_대소문자를_가리지_않는다(self):
        self.assertTrue(toggle_state(FakeLocator({"aria-pressed": "TRUE"})))

    def test_radix식_data_state를_읽는다(self):
        self.assertTrue(toggle_state(FakeLocator({"data-state": "on"})))
        self.assertTrue(toggle_state(FakeLocator({"data-state": "checked"})))
        self.assertFalse(toggle_state(FakeLocator({"data-state": "off"})))
        self.assertFalse(toggle_state(FakeLocator({"data-state": "unchecked"})))

    def test_체크박스는_실제_상태를_본다(self):
        self.assertTrue(toggle_state(FakeLocator(checkbox=True, checked=True)))
        self.assertFalse(toggle_state(FakeLocator(checkbox=True, checked=False)))

    def test_aria가_data_state보다_우선한다(self):
        self.assertFalse(toggle_state(FakeLocator({"aria-pressed": "false", "data-state": "on"})))


class FallsBackToClasses(unittest.TestCase):
    def test_켜짐_표시가_있으면_켜진_것으로_본다(self):
        self.assertTrue(toggle_state(FakeLocator({"class": "btn active"})))
        self.assertTrue(toggle_state(FakeLocator({"class": "toggle on"})))

    def test_클래스는_있는데_표시가_없으면_꺼진_것으로_본다(self):
        self.assertFalse(toggle_state(FakeLocator({"class": "btn primary"})))

    def test_부분_일치로_속지_않는다(self):
        # 'onboarding' 같은 클래스가 'on'으로 읽히면 안 된다.
        self.assertFalse(toggle_state(FakeLocator({"class": "onboarding inactive-hint"})))


class RefusesToGuess(unittest.TestCase):
    def test_읽을_단서가_없으면_모른다고_한다(self):
        # 이 경우 set_toggle이 멈추고 사람을 부른다. 눌러보는 것보다 낫다.
        self.assertIsNone(toggle_state(FakeLocator()))
        self.assertIsNone(toggle_state(FakeLocator({"class": ""})))

    def test_엉뚱한_aria_값은_믿지_않는다(self):
        self.assertIsNone(toggle_state(FakeLocator({"aria-pressed": "mixed"})))


if __name__ == "__main__":
    unittest.main()
