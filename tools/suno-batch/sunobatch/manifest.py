"""작업 상태 추적.

500건을 몇 달에 걸쳐 돌리므로 이 파일이 전부다. 모든 명령은 멱등이어야 하고,
중간에 죽어도 manifest가 깨지면 안 된다. 앱의 saveDb()와 같은 tmp→rename 방식.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .prompts import PromptSet

SCHEMA = 1

PENDING = "pending"
SUBMITTED = "submitted"
GENERATED = "generated"
DOWNLOADED = "downloaded"
PLACED = "placed"
FAILED = "failed"

# 정상 진행 순서. 되돌아가는 전이는 재시도(failed → pending)뿐이다.
ORDER = [PENDING, SUBMITTED, GENERATED, DOWNLOADED, PLACED]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Manifest:
    def __init__(self, path: str | Path, data: dict | None = None):
        self.path = Path(path)
        self.data = data if data is not None else {"schema": SCHEMA, "project": "", "items": {}}

    # --- 만들기 / 읽기 / 쓰기 ---------------------------------------------

    @classmethod
    def load(cls, path: str | Path) -> "Manifest":
        target = Path(path)
        if not target.exists():
            return cls(target)
        payload = json.loads(target.read_text(encoding="utf-8"))
        if payload.get("schema") != SCHEMA:
            raise ValueError(f"manifest 스키마가 {payload.get('schema')}입니다. {SCHEMA}만 읽을 수 있습니다.")
        return cls(target, payload)

    def save(self) -> None:
        """tmp에 쓰고 rename. 중간에 죽어도 기존 파일이 남는다."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=self.path.parent, prefix=self.path.name + ".", suffix=".tmp", delete=False
        )
        try:
            with handle:
                json.dump(self.data, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(handle.name, self.path)
        except BaseException:
            Path(handle.name).unlink(missing_ok=True)
            raise

    def sync_from_prompts(self, prompts: PromptSet) -> int:
        """prompts.json에 있는데 manifest에 없는 항목을 추가한다.

        이미 있는 항목은 건드리지 않는다 — 진행 상태를 잃으면 안 된다.
        """
        self.data["project"] = prompts.project
        items = self.data.setdefault("items", {})
        added = 0
        for take in prompts.takes:
            if take.title in items:
                continue
            items[take.title] = {
                "cue": take.cue_id,
                "cue_name": take.cue_name,
                "take": take.take,
                "style": take.style,
                "instrumental": take.instrumental,
                "status": PENDING,
                "suno_clip_id": None,
                "suno_url": None,
                "downloaded_path": None,
                "placed_path": None,
                "error": None,
                "updated_at": _now(),
            }
            added += 1
        return added

    # --- 조회 --------------------------------------------------------------

    @property
    def items(self) -> dict[str, dict]:
        return self.data.setdefault("items", {})

    def get(self, title: str) -> dict:
        item = self.items.get(title)
        if item is None:
            raise KeyError(f"manifest에 {title}이 없습니다.")
        return item

    def with_status(self, *statuses: str) -> list[tuple[str, dict]]:
        wanted = set(statuses)
        return [(title, item) for title, item in self.items.items() if item.get("status") in wanted]

    def counts(self) -> dict[str, int]:
        tally = {status: 0 for status in ORDER + [FAILED]}
        for item in self.items.values():
            status = item.get("status", PENDING)
            tally[status] = tally.get(status, 0) + 1
        return tally

    # --- 상태 변경 ---------------------------------------------------------

    def mark(self, title: str, status: str, **fields) -> dict:
        item = self.get(title)
        item["status"] = status
        # 성공 쪽으로 넘어가면 이전 실패 기록은 지운다.
        if status != FAILED:
            item["error"] = None
        item.update(fields)
        item["updated_at"] = _now()
        return item

    def mark_failed(self, title: str, reason: str) -> dict:
        return self.mark(title, FAILED, error=str(reason)[:500])

    def reset_failed(self) -> int:
        """실패한 것만 pending으로 되돌린다. 끝난 항목은 건드리지 않는다."""
        count = 0
        for item in self.items.values():
            if item.get("status") == FAILED:
                item["status"] = PENDING
                item["error"] = None
                item["updated_at"] = _now()
                count += 1
        return count
