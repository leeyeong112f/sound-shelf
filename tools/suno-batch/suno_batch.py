#!/usr/bin/env python3
"""Suno 대량 생성 → Sound Shelf 볼트 배치.

    python3 suno_batch.py validate prompts.json
    python3 suno_batch.py generate --prompts prompts.json --limit 10
    python3 suno_batch.py status
    python3 suno_batch.py download --vault ~/SoundVault --limit 20
    python3 suno_batch.py download --vault ~/SoundVault --only CUE01-T03,CUE02-T07
    python3 suno_batch.py probe

먼저 읽어 주세요: Suno는 다운로드 개수에 한도가 있습니다(Pro 기준 월 20회).
생성은 크레딧만 쓰므로 500곡을 한 번에 만들 수 있지만, 내려받기는 한도만큼만
됩니다. 이 도구는 한도를 우회하지 않습니다.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sunobatch import selectors  # noqa: E402
from sunobatch.browser import NeedsHuman, ensure_logged_in, find, open_browser  # noqa: E402
from sunobatch.config import Config  # noqa: E402
from sunobatch.download import run_download  # noqa: E402
from sunobatch.generate import run_generate  # noqa: E402
from sunobatch.manifest import FAILED, ORDER, Manifest  # noqa: E402
from sunobatch.prompts import PromptError, load_prompts  # noqa: E402


def build_config(args) -> Config:
    config = Config()
    if getattr(args, "base_url", None):
        config.base_url = args.base_url
    if getattr(args, "create_path", None):
        config.create_path = args.create_path
    if getattr(args, "library_path", None):
        config.library_path = args.library_path
    if getattr(args, "work", None):
        config.work_dir = Path(args.work)
    if getattr(args, "profile", None):
        config.profile_dir = Path(args.profile)
    if getattr(args, "vault", None):
        config.vault_root = Path(args.vault).expanduser()
    if getattr(args, "headless", False):
        config.headless = True
    if getattr(args, "no_delay", False):
        config.min_delay_seconds = 0.0
        config.max_delay_seconds = 0.0
    Path(config.work_dir).mkdir(parents=True, exist_ok=True)
    return config


def cmd_validate(args) -> int:
    try:
        prompts = load_prompts(args.prompts)
    except PromptError as error:
        print(f"prompts.json에 문제가 있습니다:\n  {error}")
        return 1
    cues = prompts.cue_ids
    print(f"{prompts.project} — cue {len(cues)}개, 곡 {len(prompts.takes)}개")
    per_cue = {}
    for take in prompts.takes:
        per_cue[take.cue_id] = per_cue.get(take.cue_id, 0) + 1
    uneven = {cue: count for cue, count in per_cue.items() if count != per_cue[cues[0]]}
    if len(uneven) > 1:
        print("  참고: cue마다 곡 수가 다릅니다 — " +
              ", ".join(f"cue {cue}:{count}" for cue, count in sorted(per_cue.items())))
    print("문제 없습니다.")
    return 0


def cmd_status(args) -> int:
    config = build_config(args)
    book = Manifest.load(config.manifest_path)
    if not book.items:
        print(f"{config.manifest_path} 에 아직 아무것도 없습니다. generate를 먼저 돌려 주세요.")
        return 0
    tally = book.counts()
    total = len(book.items)
    print(f"{book.data.get('project', '')} — 전체 {total}곡")
    labels = {"pending": "대기", "submitted": "제출됨", "generated": "생성됨",
              "downloaded": "내려받음", "placed": "볼트에 넣음", "failed": "실패"}
    for status in ORDER + [FAILED]:
        count = tally.get(status, 0)
        if count:
            print(f"  {labels.get(status, status):8s} {count:4d}")
    failures = book.with_status(FAILED)
    if failures:
        print("\n실패한 항목 (최대 10개):")
        for title, item in failures[:10]:
            print(f"  {title}: {item.get('error', '')[:120]}")
        print("\n  `generate --retry-failed` 로 다시 시도할 수 있습니다.")
    return 0


def cmd_generate(args) -> int:
    config = build_config(args)
    try:
        prompts = load_prompts(args.prompts)
    except PromptError as error:
        print(f"prompts.json에 문제가 있습니다:\n  {error}")
        return 1

    book = Manifest.load(config.manifest_path)
    added = book.sync_from_prompts(prompts)
    if args.retry_failed:
        reset = book.reset_failed()
        if reset:
            print(f"  실패했던 {reset}곡을 다시 대기로 돌렸습니다.")
    book.save()
    if added:
        print(f"  manifest에 {added}곡을 새로 등록했습니다.")

    if args.dry_run:
        with_status = book.with_status("pending", "submitted")
        picked = with_status[: args.limit] if args.limit else with_status
        print(f"\n예행 — 실제로 만들지 않고 {len(picked)}곡을 보여 줍니다.\n")
        for title, item in picked:
            print(f"  {title}  [{item['style'][:70]}]")
        return 0

    print(f"\n브라우저를 엽니다. 프로필: {config.profile_dir}")
    with open_browser(config.profile_dir, headless=config.headless,
                      downloads_dir=config.downloads_dir) as (_context, page):
        page.goto(config.create_url, wait_until="domcontentloaded")
        try:
            ensure_logged_in(page, config.work_dir, interactive=not config.headless)
        except NeedsHuman as stop:
            print(f"\n{stop}")
            return 2
        tally = run_generate(page, config, prompts, book, limit=args.limit)

    print(f"\n생성 {tally['done']}곡, 실패 {tally['failed']}곡, 건너뜀 {tally['skipped']}곡")
    print(f"manifest: {config.manifest_path}")
    return 1 if tally["failed"] else 0


def cmd_download(args) -> int:
    config = build_config(args)
    if not config.vault_root:
        print("--vault 로 Sound Shelf 볼트 경로를 지정해 주세요.")
        return 1
    try:
        prompts = load_prompts(args.prompts)
    except PromptError as error:
        print(f"prompts.json에 문제가 있습니다:\n  {error}")
        return 1

    book = Manifest.load(config.manifest_path)
    if not book.items:
        print("manifest가 비어 있습니다. generate를 먼저 돌려 주세요.")
        return 1

    only = [item.strip() for item in args.only.split(",") if item.strip()] if args.only else None

    print(f"\n브라우저를 엽니다. 프로필: {config.profile_dir}")
    with open_browser(config.profile_dir, headless=config.headless,
                      downloads_dir=config.downloads_dir) as (_context, page):
        page.goto(config.library_url, wait_until="domcontentloaded")
        try:
            ensure_logged_in(page, config.work_dir, interactive=not config.headless)
        except NeedsHuman as stop:
            print(f"\n{stop}")
            return 2
        tally = run_download(page, config, prompts, book, limit=args.limit, only=only)

    print(f"\n내려받음 {tally['downloaded']}곡, 볼트에 넣음 {tally['placed']}곡, 실패 {tally['failed']}곡")
    if tally["stopped"]:
        print("다운로드 한도에 걸려 멈췄습니다. 다음 결제일 이후 같은 명령을 다시 돌리면 이어서 받습니다.")
    return 0


def cmd_probe(args) -> int:
    """셀렉터가 지금 화면에서 잡히는지 확인한다. UI가 바뀌었을 때 첫 진단."""
    config = build_config(args)
    target = args.url or config.create_url
    print(f"\n{target} 을(를) 엽니다.")
    with open_browser(config.profile_dir, headless=config.headless,
                      downloads_dir=config.downloads_dir) as (_context, page):
        page.goto(target, wait_until="domcontentloaded")
        if not config.headless:
            input("  화면이 준비되면 Enter > ")
        print(f"\n  {'셀렉터':24s} {'결과':6s} 설명")
        missing = []
        for selector in selectors.ALL:
            found = find(page, selector, timeout_ms=1500)
            mark = "찾음" if found else ("없음(선택)" if selector.optional else "없음")
            if not found and not selector.optional:
                missing.append(selector.name)
            print(f"  {selector.name:24s} {mark:6s} {selector.description}")
        from sunobatch.browser import save_diagnostics
        spot = save_diagnostics(page, config.work_dir, "probe")
        print(f"\n  화면 기록: {spot}.png")
        if missing:
            print(f"  못 찾은 항목: {', '.join(missing)}")
            print("  sunobatch/selectors.py 에서 해당 항목의 후보를 고쳐 주세요.")
            return 1
    print("  모두 찾았습니다.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def shared(target, needs_prompts=True):
        if needs_prompts:
            target.add_argument("--prompts", default="prompts.json")
        target.add_argument("--work", default="work", help="manifest·다운로드·진단 기록을 둘 곳")
        target.add_argument("--profile", help="브라우저 프로필 폴더 (로그인 유지)")
        target.add_argument("--base-url", help="기본값 https://suno.com. 모의 페이지 시험용")
        target.add_argument("--create-path", help="만들기 화면 경로")
        target.add_argument("--library-path", help="라이브러리 화면 경로")
        target.add_argument("--headless", action="store_true", help="창 없이 실행 (시험용)")
        target.add_argument("--no-delay", action="store_true", help="대기 없이 실행 (시험용)")

    p = sub.add_parser("validate", help="prompts.json 검사")
    p.add_argument("prompts", nargs="?", default="prompts.json")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("status", help="진행 상황 보기")
    shared(p, needs_prompts=False)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("generate", help="프롬프트를 Suno에 넣어 곡을 만든다 (크레딧 사용)")
    shared(p)
    p.add_argument("--limit", type=int, help="이번에 만들 곡 수")
    p.add_argument("--dry-run", action="store_true", help="실제로 만들지 않고 목록만 보여 준다")
    p.add_argument("--retry-failed", action="store_true", help="실패한 항목을 다시 대기로 돌린다")
    p.set_defaults(func=cmd_generate)

    p = sub.add_parser("download", help="만든 곡을 받아 볼트에 넣는다 (다운로드 한도 사용)")
    shared(p)
    p.add_argument("--vault", help="Sound Shelf 볼트 경로")
    p.add_argument("--limit", type=int, help="이번에 받을 곡 수")
    p.add_argument("--only", help="쉼표로 구분한 제목만 받는다. 예: CUE01-T03,CUE02-T07")
    p.set_defaults(func=cmd_download)

    p = sub.add_parser("probe", help="셀렉터가 현재 화면에서 잡히는지 확인")
    shared(p, needs_prompts=False)
    p.add_argument("--url", help="확인할 주소")
    p.set_defaults(func=cmd_probe)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
