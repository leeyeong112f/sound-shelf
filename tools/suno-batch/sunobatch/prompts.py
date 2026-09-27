"""Codex가 만든 prompts.json을 읽고 검증한다.

Codex 출력이 어긋나면 브라우저를 띄우기 전에 여기서 걸러야 한다. 500건을
돌리다 중간에 깨지면 크레딧만 버린다.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .naming import take_title

MAX_STYLE_LENGTH = 1000


class PromptError(ValueError):
    """prompts.json이 계약을 어겼을 때."""


@dataclass(frozen=True)
class Take:
    cue_id: int
    cue_name: str
    take: int
    title: str
    style: str
    instrumental: bool = True


@dataclass
class PromptSet:
    project: str
    takes: list[Take] = field(default_factory=list)

    @property
    def cue_ids(self) -> list[int]:
        seen: dict[int, None] = {}
        for item in self.takes:
            seen.setdefault(item.cue_id, None)
        return list(seen)

    def cue_name(self, cue_id: int) -> str:
        for item in self.takes:
            if item.cue_id == cue_id:
                return item.cue_name
        return ""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PromptError(message)


def parse_prompts(payload: dict) -> PromptSet:
    """dict를 검증해 PromptSet으로. 파일 I/O 없음 — 테스트하기 쉽게."""
    _require(isinstance(payload, dict), "최상위가 객체가 아닙니다.")
    project = str(payload.get("project") or "").strip()
    _require(bool(project), "project 이름이 비어 있습니다.")

    cues = payload.get("cues")
    _require(isinstance(cues, list) and bool(cues), "cues가 비어 있거나 배열이 아닙니다.")

    takes: list[Take] = []
    seen_cue_ids: set[int] = set()
    seen_titles: set[str] = set()

    for index, cue in enumerate(cues):
        where = f"cues[{index}]"
        _require(isinstance(cue, dict), f"{where}가 객체가 아닙니다.")

        raw_id = cue.get("id")
        _require(isinstance(raw_id, int) and 1 <= raw_id <= 999, f"{where}.id는 1~999 정수여야 합니다.")
        _require(raw_id not in seen_cue_ids, f"cue {raw_id}가 두 번 나옵니다.")
        seen_cue_ids.add(raw_id)

        cue_name = str(cue.get("name") or "").strip()
        cue_takes = cue.get("takes")
        _require(isinstance(cue_takes, list) and bool(cue_takes), f"{where}.takes가 비어 있습니다.")

        seen_take_numbers: set[int] = set()
        for take_index, item in enumerate(cue_takes):
            spot = f"{where}.takes[{take_index}]"
            _require(isinstance(item, dict), f"{spot}가 객체가 아닙니다.")

            number = item.get("take")
            _require(isinstance(number, int) and 1 <= number <= 99, f"{spot}.take는 1~99 정수여야 합니다.")
            _require(number not in seen_take_numbers, f"cue {raw_id}의 take {number}가 두 번 나옵니다.")
            seen_take_numbers.add(number)

            style = str(item.get("style") or "").strip()
            _require(bool(style), f"{spot}.style이 비어 있습니다.")
            _require(len(style) <= MAX_STYLE_LENGTH, f"{spot}.style이 {MAX_STYLE_LENGTH}자를 넘습니다.")

            expected = take_title(raw_id, number)
            title = str(item.get("title") or expected).strip()
            # 제목은 나중에 라이브러리에서 곡을 찾는 유일한 열쇠라 형식을 강제한다.
            _require(title == expected, f"{spot}.title은 '{expected}'여야 합니다 (받은 값: '{title}').")
            _require(title not in seen_titles, f"제목 {title}이 두 번 나옵니다.")
            seen_titles.add(title)

            instrumental = item.get("instrumental", True)
            _require(isinstance(instrumental, bool), f"{spot}.instrumental은 true/false여야 합니다.")

            takes.append(Take(raw_id, cue_name, number, title, style, instrumental))

    return PromptSet(project=project, takes=takes)


def load_prompts(path: str | Path) -> PromptSet:
    text = Path(path).read_text(encoding="utf-8")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise PromptError(f"JSON을 읽을 수 없습니다: {error}") from error
    return parse_prompts(payload)
