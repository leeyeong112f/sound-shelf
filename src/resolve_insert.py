import json
import os
import re
import sys
import time


def respond(ok, message):
    print(json.dumps({"ok": ok, "message": message}, ensure_ascii=False))


def fail(message):
    respond(False, message)
    sys.exit(1)


def timecode_to_frames(timecode, frame_rate):
    drop_frame = ";" in timecode
    parts = [int(value) for value in re.split("[:;]", timecode)]
    if len(parts) != 4:
        raise ValueError(f"지원하지 않는 타임코드: {timecode}")
    hours, minutes, seconds, frames = parts
    nominal_rate = round(frame_rate)
    total = ((hours * 3600 + minutes * 60 + seconds) * nominal_rate) + frames
    if drop_frame and nominal_rate in (30, 60):
        dropped_per_minute = 2 if nominal_rate == 30 else 4
        total_minutes = hours * 60 + minutes
        total -= dropped_per_minute * (total_minutes - total_minutes // 10)
    return total


def find_media_item(folder, target_path):
    for clip in folder.GetClipList() or []:
        clip_path = clip.GetClipProperty("File Path")
        if clip_path and os.path.realpath(clip_path) == target_path:
            return clip
    for child in folder.GetSubFolderList() or []:
        found = find_media_item(child, target_path)
        if found:
            return found
    return None


try:
    file_path = os.path.abspath(sys.argv[1])
    duration = float(sys.argv[2])
    sample_rate = int(float(sys.argv[3]))

    if not os.path.isfile(file_path):
        fail("원본 사운드 파일을 찾을 수 없습니다.")
    if duration <= 0 or sample_rate <= 0:
        fail("사운드 길이 또는 샘플레이트 정보가 없습니다. 폴더를 다시 스캔해 주세요.")

    api_root = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
    module_root = os.path.join(api_root, "Modules")
    library_path = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"
    sys.path.insert(0, module_root)
    os.environ["RESOLVE_SCRIPT_API"] = api_root
    os.environ["RESOLVE_SCRIPT_LIB"] = library_path

    import DaVinciResolveScript as dvr_script

    resolve = None
    for _ in range(10):
        resolve = dvr_script.scriptapp("Resolve")
        if resolve:
            break
        time.sleep(0.2)
    if not resolve:
        fail("Resolve에 연결할 수 없습니다. Resolve 환경설정에서 외부 스크립팅을 Local로 허용해 주세요.")

    project_manager = resolve.GetProjectManager()
    project = project_manager.GetCurrentProject() if project_manager else None
    if not project:
        fail("Resolve에서 프로젝트를 먼저 열어 주세요.")
    if not project.GetCurrentTimeline():
        fail("Resolve에서 타임라인을 먼저 열어 주세요.")

    timeline = project.GetCurrentTimeline()
    current_timecode = timeline.GetCurrentTimecode()
    resolve.OpenPage("fairlight")
    time.sleep(0.35)
    duration_samples = max(1, round(duration * sample_rate))
    inserted = project.InsertAudioToCurrentTrackAtPlayhead(file_path, 0, duration_samples)
    if inserted:
        respond(True, "Fairlight 현재 타임헤드 위치에 사운드를 삽입했습니다.")
        sys.exit(0)

    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()
    real_path = os.path.realpath(file_path)
    media_item = find_media_item(root_folder, real_path)
    if not media_item:
        imported = resolve.GetMediaStorage().AddItemListToMediaPool([file_path]) or []
        media_item = imported[0] if imported else None
    if not media_item:
        fail("사운드를 Resolve 미디어 풀로 가져오지 못했습니다.")

    frame_rate = float(timeline.GetSetting("timelineFrameRate") or 0)
    if frame_rate <= 0:
        fail("타임라인 프레임레이트를 읽지 못했습니다.")
    start_timecode = timeline.GetStartTimecode()
    record_frame = timeline.GetStartFrame() + (
        timecode_to_frames(current_timecode, frame_rate) - timecode_to_frames(start_timecode, frame_rate)
    )
    source_frames = max(1, round(duration * frame_rate))
    track_index = next((
        index for index in range(1, timeline.GetTrackCount("audio") + 1)
        if timeline.GetIsTrackEnabled("audio", index) and not timeline.GetIsTrackLocked("audio", index)
    ), None)
    if not track_index:
        fail("사용 가능한 잠금 해제 오디오 트랙이 없습니다.")

    items = media_pool.AppendToTimeline([{
        "mediaPoolItem": media_item,
        "startFrame": 0,
        "endFrame": source_frames - 1,
        "mediaType": 2,
        "trackIndex": track_index,
        "recordFrame": record_frame,
    }])
    if not items:
        fail("현재 타임헤드 위치에 사운드를 배치하지 못했습니다.")

    respond(True, f"Audio {track_index} 트랙의 현재 타임헤드 위치에 사운드를 삽입했습니다.")
except SystemExit:
    raise
except Exception as error:
    fail(f"Resolve 연결 오류: {error}")
