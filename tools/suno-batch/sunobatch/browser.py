"""로그인된 브라우저를 연다.

스크립트는 자격증명을 저장하지도 입력하지도 않는다. 사람이 한 번 직접
로그인하면 영속 프로필에 쿠키가 남고, 이후 실행은 그것을 재사용한다.

예상 밖 화면(CAPTCHA, 로그아웃, 모르는 모달)을 만나면 추측해서 클릭하지 않고
스크린샷과 HTML을 남긴 뒤 멈춘다.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from .selectors import CAPTCHA, SIGN_IN_PROMPT, SIGNED_IN, Selector

DEFAULT_BASE_URL = "https://suno.com"
FIND_TIMEOUT_MS = 8000


class BrowserError(RuntimeError):
    pass


class NeedsHuman(BrowserError):
    """사람이 직접 봐야 하는 상황. 재시도해도 소용없다."""


def find(page, selector: Selector, timeout_ms: int = FIND_TIMEOUT_MS):
    """후보를 순서대로 시도해 처음 보이는 것을 돌려준다. 없으면 None."""
    deadline_each = max(250, timeout_ms // max(1, len(selector.candidates)))
    for candidate in selector.candidates:
        locator = page.locator(candidate).first
        try:
            locator.wait_for(state="visible", timeout=deadline_each)
            return locator
        except Exception:
            continue
    return None


def require(page, selector: Selector, timeout_ms: int = FIND_TIMEOUT_MS):
    found = find(page, selector, timeout_ms)
    if found is None:
        raise BrowserError(
            f"'{selector.description}'을(를) 찾지 못했습니다 ({selector.name}).\n"
            "Suno 화면이 바뀌었을 수 있습니다. `probe` 명령으로 확인한 뒤 "
            "sunobatch/selectors.py 를 고쳐 주세요."
        )
    return found


def present(page, selector: Selector, timeout_ms: int = 1200) -> bool:
    return find(page, selector, timeout_ms) is not None


def save_diagnostics(page, work_dir: str | Path, label: str) -> Path:
    """무슨 화면에서 멈췄는지 남긴다. 셀렉터를 고칠 때 이게 유일한 단서다."""
    folder = Path(work_dir) / "diagnostics"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = folder / f"{stamp}-{label}"
    try:
        page.screenshot(path=str(base.with_suffix(".png")), full_page=True)
    except Exception:
        pass
    try:
        base.with_suffix(".html").write_text(page.content(), encoding="utf-8")
    except Exception:
        pass
    return base


@contextmanager
def open_browser(profile_dir: str | Path, headless: bool = False, downloads_dir: str | Path | None = None):
    """영속 프로필로 브라우저를 연다.

    headless는 기본으로 끈다. 사람이 로그인 화면을 보고 직접 처리해야 하고,
    headless는 탐지·렌더링 문제도 잦다.
    """
    from playwright.sync_api import sync_playwright

    profile = Path(profile_dir).expanduser()
    profile.mkdir(parents=True, exist_ok=True)

    launch: dict = {
        "user_data_dir": str(profile),
        "headless": headless,
        "accept_downloads": True,
        "viewport": {"width": 1440, "height": 900},
    }
    if downloads_dir:
        Path(downloads_dir).mkdir(parents=True, exist_ok=True)
        launch["downloads_path"] = str(downloads_dir)
    # 컨테이너처럼 Playwright가 자기 브라우저를 못 받은 환경을 위한 탈출구.
    executable = os.environ.get("SUNO_BATCH_CHROMIUM", "").strip()
    if executable:
        launch["executable_path"] = executable
    if os.environ.get("SUNO_BATCH_NO_SANDBOX"):
        launch["args"] = ["--no-sandbox"]

    with sync_playwright() as driver:
        context = driver.chromium.launch_persistent_context(**launch)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            yield context, page
        finally:
            try:
                context.close()
            except Exception:
                pass


def guard_unexpected(page, work_dir: str | Path) -> None:
    """사람 확인 절차가 떴으면 멈춘다. 자동으로 넘기려 들지 않는다."""
    if present(page, CAPTCHA):
        spot = save_diagnostics(page, work_dir, "captcha")
        raise NeedsHuman(
            f"사람 확인(CAPTCHA) 화면이 떴습니다. 브라우저에서 직접 처리한 뒤 다시 실행해 주세요.\n"
            f"화면 기록: {spot}.png"
        )


def ensure_logged_in(page, work_dir: str | Path, interactive: bool = True) -> None:
    """로그인 상태를 확인한다. 아니면 사람에게 넘긴다."""
    guard_unexpected(page, work_dir)
    if present(page, SIGNED_IN, timeout_ms=4000):
        return
    if not present(page, SIGN_IN_PROMPT, timeout_ms=2000):
        # 로그인 표시도 로그인 화면도 없다. 화면이 바뀌었을 수 있으니 단정하지 않는다.
        return
    if not interactive:
        spot = save_diagnostics(page, work_dir, "signed-out")
        raise NeedsHuman(f"로그인되어 있지 않습니다. 화면 기록: {spot}.png")
    print("\n  로그인되어 있지 않습니다.")
    print("  열린 브라우저에서 Suno에 로그인한 뒤, 여기서 Enter를 눌러 주세요.")
    input("  준비되면 Enter > ")
    guard_unexpected(page, work_dir)
    if not present(page, SIGNED_IN, timeout_ms=5000):
        spot = save_diagnostics(page, work_dir, "still-signed-out")
        raise NeedsHuman(f"아직 로그인 상태로 보이지 않습니다. 화면 기록: {spot}.png")
