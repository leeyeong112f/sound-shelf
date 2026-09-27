"""파일명·폴더명 안전화.

Sound Shelf 앱이 쓰는 규칙을 그대로 옮긴 것이다. 규칙이 어긋나면 앱이 파일을
못 찾거나 폴더를 숨김으로 취급하므로, 원본 동작을 그대로 따라야 한다.

  safe_file_stem   ← src/youtube-import.js 의 safeFileStem
  safe_category    ← src/main.js 의 normalizeCategoryPath (한 세그먼트만)
  unique_destination ← src/main.js 의 uniqueDestination
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

# 파일 이름에 쓸 수 없는 문자. 앱과 같은 집합이다.
_FORBIDDEN_IN_FILENAME = re.compile(r'[\\/:*?"<>|]')
# 카테고리(폴더) 이름에서 치환되는 문자. `\ / >` 는 경로 구분자로 따로 다룬다.
_FORBIDDEN_IN_CATEGORY = re.compile(r'[:*?"<>|]')
# 탭·개행(\u0009-\u000d)은 제외한다. 이것들은 지우지 않고 공백으로 축약해야
# 원본 JS와 결과가 같다. Python의 \\s 는 JS와 달리 \u001c-\u001f 도 공백으로
# 보므로, 그쪽은 축약 전에 지워서 공백으로 둔갑하지 않게 한다.
_CONTROL_CHARS = re.compile(r"[\u0000-\u0008\u000e-\u001f\u007f]")
_WHITESPACE_RUN = re.compile(r"\s+")

MAX_STEM_LENGTH = 120


def safe_file_stem(title: str, fallback: str = "suno-audio") -> str:
    """제목을 파일 이름(확장자 제외)으로 쓸 수 있게 다듬는다.

    순서가 중요하다. NFC 정규화를 먼저 해야 macOS에서 한글 자모가 분리되지
    않는다. 확장자는 붙이지 않는다 — 부르는 쪽이 조립한다.
    """
    value = unicodedata.normalize("NFC", str(title or ""))
    value = _FORBIDDEN_IN_FILENAME.sub("_", value)
    value = _CONTROL_CHARS.sub("", value)
    value = _WHITESPACE_RUN.sub(" ", value)
    value = value.strip()
    # 선행 점을 남기면 숨김 파일이 되어 앱 스캔에서 빠진다.
    value = re.sub(r"^\.+", "", value)
    if not value:
        return fallback
    if len(value) > MAX_STEM_LENGTH:
        value = value[:MAX_STEM_LENGTH].strip()
    return value or fallback


def safe_category(name: str) -> str:
    """폴더 이름 한 세그먼트를 다듬는다.

    앱은 `\\ / >` 를 경로 구분자로 해석하므로 이름에 남기면 안 된다. 하위
    폴더를 만들 의도가 아니라면 공백으로 바꾼다.
    """
    value = unicodedata.normalize("NFC", str(name or ""))
    value = re.sub(r"[\\/>]+", " ", value)
    value = _FORBIDDEN_IN_CATEGORY.sub("-", value)
    value = _CONTROL_CHARS.sub("", value)
    value = _WHITESPACE_RUN.sub(" ", value).strip()
    value = re.sub(r"^\.+", "", value).strip()
    return value


def cue_folder_name(cue_id: int, cue_name: str = "") -> str:
    """cue 번호(+이름)를 폴더 이름으로. 예: 'Cue 07 첫 추격'."""
    label = f"Cue {int(cue_id):02d}"
    tail = safe_category(cue_name)
    return f"{label} {tail}" if tail else label


def take_title(cue_id: int, take: int) -> str:
    """Suno에 넣을 제목. 나중에 라이브러리에서 곡을 찾는 유일한 열쇠라 고정 형식."""
    return f"CUE{int(cue_id):02d}-T{int(take):02d}"


def unique_destination(folder: Path, file_name: str) -> Path:
    """이름이 겹치면 ' 2', ' 3' 을 붙인다. 앱의 uniqueDestination과 같은 규칙."""
    folder = Path(folder)
    stem = Path(file_name).stem
    suffix = Path(file_name).suffix
    candidate = folder / file_name
    counter = 2
    while candidate.exists():
        candidate = folder / f"{stem} {counter}{suffix}"
        counter += 1
    return candidate
