"""실행 설정.

실제 Suno와 모의 페이지는 주소만 다르다. 나머지 흐름은 같은 코드를 탄다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_BASE_URL = "https://suno.com"


@dataclass
class Config:
    base_url: str = DEFAULT_BASE_URL
    profile_dir: Path = field(default_factory=lambda: Path(__file__).resolve().parents[1] / ".profile")
    work_dir: Path = field(default_factory=lambda: Path("work"))
    # Sound Shelf 볼트 루트. download/place 단계에서만 필요하다.
    vault_root: Path | None = None
    headless: bool = False

    # 사람이 쓰는 속도로만 조작한다. 생성 사이에 이 범위에서 무작위로 쉰다.
    min_delay_seconds: float = 8.0
    max_delay_seconds: float = 15.0

    # 한 곡이 만들어지길 기다리는 한계.
    generate_timeout_seconds: float = 300.0
    download_timeout_seconds: float = 120.0

    # 연달아 이만큼 실패하면 전체를 멈춘다. UI가 바뀌었을 가능성이 크다.
    max_consecutive_failures: int = 3

    ffmpeg: str = "ffmpeg"

    # 모의 페이지는 확장자가 붙은 파일이라 경로를 갈아끼울 수 있게 둔다.
    create_path: str = "/create"
    library_path: str = "/me"

    @property
    def create_url(self) -> str:
        return self.base_url.rstrip("/") + self.create_path

    @property
    def library_url(self) -> str:
        return self.base_url.rstrip("/") + self.library_path

    @property
    def downloads_dir(self) -> Path:
        return Path(self.work_dir) / "downloads"

    @property
    def manifest_path(self) -> Path:
        return Path(self.work_dir) / "manifest.json"
