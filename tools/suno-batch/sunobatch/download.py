"""만들어 둔 곡을 내려받아 볼트에 넣는다.

Suno의 다운로드 한도(Pro 기준 월 20회)가 이 단계의 벽이다. 한도는 서버 쪽에
있으므로 넘을 방법이 없고, 넘으려 들지도 않는다. 벽을 만나면 그 자리에서
멈추고 남은 건수를 보고한다.
"""

from __future__ import annotations

import random
import re
import time
from pathlib import Path

from . import selectors, vault
from .browser import BrowserError, find, guard_unexpected, present, save_diagnostics
from .manifest import DOWNLOADED, GENERATED, PLACED


class QuotaExhausted(RuntimeError):
    """다운로드 한도를 다 썼다. 다음 결제일까지 기다려야 한다."""


def read_quota(page) -> int | None:
    """화면에 남은 횟수가 보이면 읽는다. 없으면 None."""
    locator = find(page, selectors.QUOTA_LABEL, timeout_ms=2000)
    if locator is None:
        return None
    text = (locator.inner_text() or "").strip()
    match = re.search(r"\d+", text)
    return int(match.group()) if match else None


def _clip_row(page, title: str):
    for candidate in selectors.CLIP_ROW.candidates:
        row = page.locator(candidate).filter(has_text=title).first
        try:
            row.wait_for(state="visible", timeout=2000)
            return row
        except Exception:
            continue
    return None


def download_one(page, config, title: str, work_dir):
    """제목으로 곡을 찾아 WAV로 받는다. 받은 파일 경로를 돌려준다."""
    guard_unexpected(page, work_dir)

    row = _clip_row(page, title)
    if row is None:
        raise BrowserError(f"라이브러리에서 {title}을(를) 찾지 못했습니다. 제목이 바뀌었는지 확인해 주세요.")

    opener = None
    for candidate in selectors.DOWNLOAD_MENU.candidates:
        found = row.locator(candidate).first
        try:
            found.wait_for(state="visible", timeout=1500)
            opener = found
            break
        except Exception:
            continue
    if opener is None:
        raise BrowserError(f"{title}의 다운로드 메뉴를 찾지 못했습니다.")
    opener.click()

    wav = None
    for candidate in selectors.DOWNLOAD_WAV.candidates:
        found = row.locator(candidate).first
        try:
            found.wait_for(state="visible", timeout=1500)
            wav = found
            break
        except Exception:
            continue
    if wav is None:
        # 메뉴가 행 바깥(포털)에 열리는 경우가 있어 페이지 전체에서도 찾아본다.
        wav = find(page, selectors.DOWNLOAD_WAV, timeout_ms=3000)
    if wav is None:
        spot = save_diagnostics(page, work_dir, f"no-wav-{title}")
        raise BrowserError(f"{title}의 WAV 항목을 찾지 못했습니다. 화면 기록: {spot}.png")

    try:
        with page.expect_download(timeout=config.download_timeout_seconds * 1000) as caught:
            wav.click()
        download = caught.value
    except Exception as error:
        # 한도를 다 썼을 때 다운로드 대신 안내가 뜬다. 그건 실패가 아니라 벽이다.
        if present(page, selectors.QUOTA_WALL, timeout_ms=2000):
            raise QuotaExhausted("Suno 다운로드 한도를 다 썼습니다.") from error
        spot = save_diagnostics(page, work_dir, f"download-failed-{title}")
        raise BrowserError(f"{title} 다운로드가 시작되지 않았습니다. 화면 기록: {spot}.png") from error

    target = config.downloads_dir / f"{title}.wav"
    target.parent.mkdir(parents=True, exist_ok=True)
    download.save_as(str(target))
    return target


def run_download(page, config, prompts, manifest, limit: int | None = None, only: list[str] | None = None) -> dict:
    """한도만큼만 받는다. 벽을 만나면 즉시 멈춘다."""
    page.goto(config.library_url, wait_until="domcontentloaded")
    guard_unexpected(page, work_dir=config.work_dir)

    ready = [title for title, _ in manifest.with_status(GENERATED, DOWNLOADED)]
    if only:
        wanted = set(only)
        missing = wanted - set(ready)
        if missing:
            print(f"  (건너뜀 — 아직 만들어지지 않았거나 모르는 제목: {', '.join(sorted(missing))})")
        ready = [title for title in ready if title in wanted]

    quota = read_quota(page)
    if quota is not None:
        print(f"  화면에 표시된 남은 다운로드: {quota}회")
        if quota <= 0 and ready:
            print("  이번 달 다운로드 한도를 다 썼습니다. 다음 결제일 이후 다시 돌려 주세요.")
            return {"downloaded": 0, "placed": 0, "failed": 0, "stopped": True}
        ready = ready[:quota] if limit is None else ready[: min(quota, limit)]
    elif limit is not None:
        ready = ready[:limit]

    cue_names = {cue_id: prompts.cue_name(cue_id) for cue_id in prompts.cue_ids}
    tally = {"downloaded": 0, "placed": 0, "failed": 0, "stopped": False}

    for index, title in enumerate(ready, start=1):
        item = manifest.get(title)
        print(f"  [{index}/{len(ready)}] {title} … ", end="", flush=True)
        try:
            cached = Path(item["downloaded_path"]) if item.get("downloaded_path") else None
            if item.get("status") == DOWNLOADED and cached and cached.is_file():
                # 지난 실행에서 받아 뒀는데 볼트 배치에서 멈춘 경우다. 한도를 또 쓰지 않는다.
                received = cached
            else:
                received = download_one(page, config, title, config.work_dir)
                manifest.mark(title, DOWNLOADED, downloaded_path=str(received))
                manifest.save()
                tally["downloaded"] += 1

            placed = vault.place(
                config.vault_root, item["cue"], cue_names.get(item["cue"], item.get("cue_name", "")),
                received, title, config.work_dir, ffmpeg=config.ffmpeg,
            )
            manifest.mark(title, PLACED, placed_path=vault.relative_to_vault(config.vault_root, placed))
            manifest.save()
            tally["placed"] += 1
            print(f"→ {vault.relative_to_vault(config.vault_root, placed)}")
        except QuotaExhausted as stop:
            print(f"멈춤 — {stop}")
            tally["stopped"] = True
            break
        except Exception as error:
            manifest.mark_failed(title, str(error))
            manifest.save()
            tally["failed"] += 1
            print(f"실패 — {error}")
            continue

        if index < len(ready):
            pause = random.uniform(config.min_delay_seconds, config.max_delay_seconds)
            if pause > 0:
                time.sleep(pause)

    return tally
