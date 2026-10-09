import json
import sys
import time

# 열려 있는 Resolve 프로젝트의 미디어 풀을 다룬다. 두 가지로 호출한다.
#   scan              오프라인 클립 목록을 JSON 으로 출력한다.
#   apply (stdin)     {"relinks": [{"clipId", "folder"}]} 를 받아 폴더별로 RelinkClips 를 호출한다.
# 어느 폴더로 보낼지는 main.js(resolve-relink.js) 가 라이브러리를 보고 정한다. 이 스크립트는
# 라이브러리를 모른다.


def respond(payload):
    print(json.dumps(payload, ensure_ascii=False))


def fail(message):
    respond({"ok": False, "message": message})
    sys.exit(1)


def walk(folder, visit):
    for clip in folder.GetClipList() or []:
        visit(clip)
    for child in folder.GetSubFolderList() or []:
        walk(child, visit)


try:
    mode = sys.argv[1] if len(sys.argv) > 1 else "scan"
    if mode not in ("scan", "apply"):
        fail(f"알 수 없는 모드: {mode}")

    api_root = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
    module_root = api_root + "/Modules"
    library_path = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"
    sys.path.insert(0, module_root)
    import os
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
    media_pool = project.GetMediaPool()
    root = media_pool.GetRootFolder()

    if mode == "scan":
        clips = []

        def collect(clip):
            if clip.GetClipProperty("Online Status") != "Offline":
                return
            # 파일을 옮긴 클립은 File Path 에 옛 경로가 남는다. Unlink 한 클립은 File Path 가
            # "OFFLINE - " 로 비고 File Name 과 Clip Directory 만 남는다. 둘 다 없으면 타임라인 같은 항목이다.
            file_path = clip.GetClipProperty("File Path") or ""
            file_name = clip.GetClipProperty("File Name") or ""
            if not file_path and not file_name:
                return
            clips.append({
                "id": clip.GetUniqueId(),
                "name": clip.GetName(),
                "filePath": file_path,
                "fileName": file_name,
                "directory": clip.GetClipProperty("Clip Directory") or "",
                "type": clip.GetClipProperty("Type") or "",
                "usage": clip.GetClipProperty("Usage") or "",
            })

        walk(root, collect)
        respond({"ok": True, "project": project.GetName(), "clips": clips})
        sys.exit(0)

    request = json.load(sys.stdin)
    wanted = {}
    for item in request.get("relinks", []):
        if item.get("clipId") and item.get("folder"):
            wanted[item["clipId"]] = item["folder"]
    found = {}

    def locate(clip):
        unique_id = clip.GetUniqueId()
        if unique_id in wanted:
            found[unique_id] = clip

    walk(root, locate)

    by_folder = {}
    for unique_id, folder in wanted.items():
        if unique_id in found:
            by_folder.setdefault(folder, []).append(found[unique_id])

    relinked = []
    failed = [unique_id for unique_id in wanted if unique_id not in found]
    for folder, clips in by_folder.items():
        media_pool.RelinkClips(clips, folder)
        # 반환값보다 실제 상태가 믿을 만하다. 폴더에 같은 이름이 없으면 True 를 돌려주고도 오프라인이다.
        for clip in clips:
            unique_id = clip.GetUniqueId()
            if clip.GetClipProperty("Online Status") == "Online":
                relinked.append(unique_id)
            else:
                failed.append(unique_id)
    respond({"ok": True, "relinked": relinked, "failed": failed})
except SystemExit:
    raise
except Exception as error:
    fail(f"Resolve 연결 오류: {error}")
