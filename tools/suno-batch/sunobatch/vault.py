"""받은 파일을 Sound Shelf 볼트의 cue 폴더에 넣는다.

앱이 지키는 규칙 두 가지를 그대로 따른다.
  1. 카테고리는 볼트 루트 기준 디렉터리와 1:1이다. 폴더를 만들고 파일을 넣으면
     앱이 폴더 감시로 잡는다. 따로 등록할 필요가 없다.
  2. 완성된 파일만 볼트에 넣는다. 받다 만 파일이 볼트에 있으면 감시 스캔이
     반쪽짜리를 인덱싱한다. 그래서 작업 폴더에서 변환까지 끝낸 뒤 옮긴다.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .naming import cue_folder_name, safe_file_stem, unique_destination

FFMPEG_GUIDE = (
    "ffmpeg를 찾을 수 없습니다. WAV 변환에 필요합니다.\n"
    "  brew install ffmpeg\n"
    "로 설치한 뒤 다시 실행해 주세요."
)

CONVERT_TIMEOUT_SECONDS = 600


class VaultError(RuntimeError):
    pass


def check_vault(vault_root: str | Path) -> Path:
    """볼트가 맞는지 확인한다. 엉뚱한 폴더에 500곡을 쏟지 않도록."""
    root = Path(vault_root).expanduser().resolve()
    if not root.is_dir():
        raise VaultError(f"볼트 폴더가 없습니다: {root}")
    if not (root / ".sound-shelf").is_dir():
        raise VaultError(
            f"{root} 는 Sound Shelf 볼트가 아닙니다 (.sound-shelf 폴더가 없습니다).\n"
            "앱에서 볼트를 연 뒤 그 경로를 지정해 주세요."
        )
    return root


def ensure_cue_folder(vault_root: str | Path, cue_id: int, cue_name: str = "") -> Path:
    """cue 폴더를 만들고 돌려준다. 이미 있으면 그대로 쓴다."""
    root = check_vault(vault_root)
    folder = root / cue_folder_name(cue_id, cue_name)
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def convert_to_wav(source: str | Path, destination: str | Path, ffmpeg: str = "ffmpeg") -> Path:
    """앱의 convertToWav와 같은 명령. 24bit PCM, 첫 오디오 스트림만."""
    source_path = Path(source)
    destination_path = Path(destination)
    if not source_path.is_file():
        raise VaultError(f"변환할 파일이 없습니다: {source_path}")

    command = [
        ffmpeg, "-v", "error", "-y",
        "-i", str(source_path),
        "-map", "0:a:0", "-vn",
        "-c:a", "pcm_s24le",
        str(destination_path),
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=CONVERT_TIMEOUT_SECONDS
        )
    except FileNotFoundError as error:
        raise VaultError(FFMPEG_GUIDE) from error
    except subprocess.TimeoutExpired as error:
        raise VaultError(f"WAV 변환이 {CONVERT_TIMEOUT_SECONDS}초를 넘겨 중단했습니다.") from error

    if result.returncode != 0:
        destination_path.unlink(missing_ok=True)
        detail = (result.stderr or "").strip()[-400:]
        raise VaultError(f"WAV 변환 실패: {detail or f'ffmpeg가 {result.returncode}로 끝났습니다.'}")
    return destination_path


def place(
    vault_root: str | Path,
    cue_id: int,
    cue_name: str,
    source_file: str | Path,
    title: str,
    work_dir: str | Path,
    ffmpeg: str = "ffmpeg",
) -> Path:
    """받은 파일을 WAV로 만들어 cue 폴더에 넣고, 최종 경로를 돌려준다.

    변환은 작업 폴더에서 끝낸 뒤 볼트로 옮긴다. 이미 WAV면 변환하지 않는다.
    """
    source_path = Path(source_file)
    if not source_path.is_file():
        raise VaultError(f"배치할 파일이 없습니다: {source_path}")

    folder = ensure_cue_folder(vault_root, cue_id, cue_name)
    stem = safe_file_stem(title, fallback=f"cue{cue_id:02d}")

    if source_path.suffix.lower() == ".wav":
        staged = source_path
    else:
        work = Path(work_dir)
        work.mkdir(parents=True, exist_ok=True)
        staged = convert_to_wav(source_path, work / f"{stem}.wav", ffmpeg=ffmpeg)

    destination = unique_destination(folder, f"{stem}.wav")
    # rename은 볼륨이 다르면 실패한다. 임시 폴더가 다른 볼륨일 수 있어 폴백을 둔다.
    try:
        staged.replace(destination)
    except OSError:
        shutil.copy2(staged, destination)
        staged.unlink(missing_ok=True)
    return destination


def relative_to_vault(vault_root: str | Path, path: str | Path) -> str:
    root = Path(vault_root).expanduser().resolve()
    try:
        return str(Path(path).resolve().relative_to(root))
    except ValueError:
        return str(path)
