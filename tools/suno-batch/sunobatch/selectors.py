"""Suno 화면의 셀렉터를 한 곳에 모은다.

Suno UI가 바뀌면 이 파일만 고친다. `suno_batch.py probe`가 각 항목이 현재
페이지에서 잡히는지 표로 보여주므로, 거기서 빨간 줄이 난 것만 손보면 된다.

항목마다 후보를 여러 개 두고 순서대로 시도한다. 안정적인 것부터:
  1) data-testid  2) role/aria-label  3) 눈에 보이는 글자
글자는 Suno가 문구를 바꾸면 깨지므로 마지막에 둔다.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Selector:
    name: str
    candidates: tuple[str, ...]
    description: str
    optional: bool = False


def _s(name: str, description: str, *candidates: str, optional: bool = False) -> Selector:
    return Selector(name=name, candidates=tuple(candidates), description=description, optional=optional)


# --- 로그인 상태 --------------------------------------------------------------

SIGNED_IN = _s(
    "signed_in", "로그인된 상태임을 알려주는 표시",
    "[data-testid='user-menu']",
    "[data-testid='account-button']",
    "button[aria-label*='ccount' i]",
    "img[alt*='avatar' i]",
)

SIGN_IN_PROMPT = _s(
    "sign_in_prompt", "로그인하라는 화면", 
    "[data-testid='sign-in']",
    "a[href*='sign-in']",
    "button:has-text('Sign in')",
    "button:has-text('Log in')",
    optional=True,
)

# --- 만들기 화면 --------------------------------------------------------------

CUSTOM_MODE = _s(
    "custom_mode", "Custom 모드 토글 (가사·스타일을 직접 넣는 모드)",
    "[data-testid='custom-mode-toggle']",
    "button[aria-label*='custom' i]",
    "button:has-text('Custom')",
)

INSTRUMENTAL_TOGGLE = _s(
    "instrumental_toggle", "Instrumental 토글 (가사 없이 연주만)",
    "[data-testid='instrumental-toggle']",
    "input[aria-label*='instrumental' i]",
    "button[aria-label*='instrumental' i]",
    "button:has-text('Instrumental')",
)

STYLE_INPUT = _s(
    "style_input", "스타일·프롬프트 입력칸",
    "[data-testid='style-input']",
    "textarea[aria-label*='style' i]",
    "textarea[placeholder*='style' i]",
    "textarea[placeholder*='describe' i]",
)

TITLE_INPUT = _s(
    "title_input", "제목 입력칸 — 나중에 곡을 찾는 열쇠라 반드시 채워야 한다",
    "[data-testid='title-input']",
    "input[aria-label*='title' i]",
    "input[placeholder*='title' i]",
)

CREATE_BUTTON = _s(
    "create_button", "생성 시작 버튼",
    "[data-testid='create-button']",
    "button[aria-label*='create' i]",
    "button:has-text('Create')",
)

CLIP_ROW = _s(
    "clip_row", "생성된 곡 한 줄 (제목으로 좁혀서 쓴다)",
    "[data-testid='clip-row']",
    "[data-clip-id]",
    "[role='listitem']",
)

# --- 다운로드 ----------------------------------------------------------------

DOWNLOAD_MENU = _s(
    "download_menu", "곡 줄의 다운로드 메뉴 열기",
    "[data-testid='download-button']",
    "button[aria-label*='download' i]",
    "button:has-text('Download')",
)

DOWNLOAD_WAV = _s(
    "download_wav", "메뉴 안의 WAV 항목",
    "[data-testid='download-wav']",
    "[role='menuitem'][aria-label*='wav' i]",
    "[role='menuitem']:has-text('WAV')",
    "button:has-text('WAV')",
)

QUOTA_LABEL = _s(
    "quota_label", "남은 다운로드 횟수 표시",
    "[data-testid='download-quota']",
    "[aria-label*='downloads remaining' i]",
    optional=True,
)

QUOTA_WALL = _s(
    "quota_wall", "다운로드 한도 소진 안내·결제 유도",
    "[data-testid='download-limit-reached']",
    "[role='dialog']:has-text('download limit')",
    "text=/download limit reached/i",
    optional=True,
)

# --- 사람을 불러야 하는 화면 ---------------------------------------------------

CAPTCHA = _s(
    "captcha", "사람 확인 절차",
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[title*='challenge' i]",
    "[data-testid='captcha']",
    optional=True,
)

# probe가 훑는 순서. 로그인 → 만들기 → 다운로드.
ALL: tuple[Selector, ...] = (
    SIGNED_IN, SIGN_IN_PROMPT,
    CUSTOM_MODE, INSTRUMENTAL_TOGGLE, STYLE_INPUT, TITLE_INPUT, CREATE_BUTTON, CLIP_ROW,
    DOWNLOAD_MENU, DOWNLOAD_WAV, QUOTA_LABEL, QUOTA_WALL,
    CAPTCHA,
)
