"""프롬프트를 Suno에 넣고 곡이 만들어지길 기다린다.

크레딧만 쓰는 단계다. 다운로드 한도와는 무관하므로 500곡을 한 번에 돌릴 수 있다.
만들어진 곡은 Suno 라이브러리에 남고, 제목(CUE01-T03)으로 나중에 찾는다.
"""

from __future__ import annotations

import random
import time

from . import selectors
from .browser import BrowserError, find, guard_unexpected, require, save_diagnostics
from .manifest import GENERATED, PENDING, SUBMITTED


def toggle_state(locator) -> bool | None:
    """토글이 켜져 있는지 읽는다. 알 수 없으면 None.

    Suno가 상태를 어떻게 표시하는지 확신할 수 없으므로 믿을 만한 순서로 본다.
    앞의 셋은 명시적 신호라 그대로 믿고, 클래스는 마지막 수단이다. 아무것도
    못 읽으면 None을 주고, 부르는 쪽이 사람을 부른다.
    """
    for attribute in ("aria-pressed", "aria-checked"):
        value = (locator.get_attribute(attribute) or "").lower()
        if value in ("true", "false"):
            return value == "true"

    # Radix UI 계열이 쓰는 표시. 요즘 React 앱에서 흔하다.
    state = (locator.get_attribute("data-state") or "").lower()
    if state in ("on", "checked", "active"):
        return True
    if state in ("off", "unchecked", "inactive"):
        return False

    try:
        if locator.evaluate("el => el.tagName === 'INPUT' && el.type === 'checkbox'"):
            return locator.is_checked()
    except Exception:
        pass

    classes = set((locator.get_attribute("class") or "").lower().split())
    if classes & {"active", "selected", "enabled", "on", "checked"}:
        return True
    if classes:
        return False
    return None


def set_toggle(page, selector, desired: bool, work_dir) -> None:
    """토글을 원하는 상태로 맞춘다. 상태를 못 읽으면 건드리지 않는다.

    모르는 채로 클릭하면 오히려 반대로 만들 수 있다. 인스트루멘털이 꺼진 채
    500곡이 나오는 것보다는 한 번 멈추는 편이 낫다.
    """
    locator = find(page, selector)
    if locator is None:
        if selector.optional:
            return
        raise BrowserError(f"'{selector.description}'을(를) 찾지 못했습니다 ({selector.name}).")

    state = toggle_state(locator)
    if state is None:
        spot = save_diagnostics(page, work_dir, f"unknown-toggle-{selector.name}")
        raise BrowserError(
            f"'{selector.description}'의 켜짐/꺼짐을 읽을 수 없습니다.\n"
            f"잘못 눌러 전체를 망치지 않도록 멈춥니다. 화면 기록: {spot}.png"
        )
    if state != desired:
        locator.click()
        if toggle_state(locator) != desired:
            raise BrowserError(f"'{selector.description}'을(를) {desired}로 바꾸지 못했습니다.")


def generate_one(page, config, take, work_dir) -> dict:
    """한 곡을 만든다. clip id와 주소를 돌려준다."""
    page.goto(config.create_url, wait_until="domcontentloaded")
    guard_unexpected(page, work_dir)

    set_toggle(page, selectors.CUSTOM_MODE, True, work_dir)
    set_toggle(page, selectors.INSTRUMENTAL_TOGGLE, bool(take.instrumental), work_dir)

    style = require(page, selectors.STYLE_INPUT)
    style.fill(take.style)

    title = require(page, selectors.TITLE_INPUT)
    # 제목이 비면 나중에 곡을 못 찾는다. 반드시 채워야 한다.
    title.fill(take.title)

    require(page, selectors.CREATE_BUTTON).click()

    # 제목으로 좁혀 기다린다. 다른 곡이 먼저 뜨더라도 우리 것만 본다.
    deadline = time.monotonic() + config.generate_timeout_seconds
    while time.monotonic() < deadline:
        guard_unexpected(page, work_dir)
        for candidate in selectors.CLIP_ROW.candidates:
            row = page.locator(candidate).filter(has_text=take.title).first
            try:
                row.wait_for(state="visible", timeout=1500)
            except Exception:
                continue
            clip_id = row.get_attribute("data-clip-id") or ""
            return {
                "suno_clip_id": clip_id or None,
                "suno_url": f"{config.base_url.rstrip('/')}/song/{clip_id}" if clip_id else None,
            }
    spot = save_diagnostics(page, work_dir, f"generate-timeout-{take.title}")
    raise BrowserError(
        f"{take.title}이(가) {config.generate_timeout_seconds:.0f}초 안에 나오지 않았습니다. "
        f"화면 기록: {spot}.png"
    )


def run_generate(page, config, prompts, manifest, limit: int | None = None, dry_run: bool = False) -> dict:
    """대기 중인 항목을 순서대로 만든다. 한 건 끝날 때마다 manifest를 저장한다."""
    by_title = {take.title: take for take in prompts.takes}
    pending = [title for title, _ in manifest.with_status(PENDING, SUBMITTED)]
    if limit is not None:
        pending = pending[:limit]

    tally = {"done": 0, "failed": 0, "skipped": 0}
    consecutive_failures = 0

    for index, title in enumerate(pending, start=1):
        take = by_title.get(title)
        if take is None:
            tally["skipped"] += 1
            continue

        print(f"  [{index}/{len(pending)}] {title} … ", end="", flush=True)
        if dry_run:
            print("(예행 — 실제로 만들지 않음)")
            tally["skipped"] += 1
            continue

        manifest.mark(title, SUBMITTED)
        manifest.save()
        try:
            result = generate_one(page, config, take, config.work_dir)
        except Exception as error:
            manifest.mark_failed(title, str(error))
            manifest.save()
            tally["failed"] += 1
            consecutive_failures += 1
            print(f"실패 — {error}")
            if consecutive_failures >= config.max_consecutive_failures:
                print(f"\n  연달아 {consecutive_failures}번 실패했습니다. "
                      "Suno 화면이 바뀌었을 수 있어 멈춥니다. `probe`로 확인해 주세요.")
                break
            continue

        manifest.mark(title, GENERATED, **result)
        manifest.save()
        tally["done"] += 1
        consecutive_failures = 0
        print("완료")

        if index < len(pending):
            pause = random.uniform(config.min_delay_seconds, config.max_delay_seconds)
            if pause > 0:
                time.sleep(pause)

    return tally
