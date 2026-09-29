// 무서명 macOS 빌드의 자체 업데이트.
//
// electron-updater(Squirrel.Mac)는 Developer ID 로 서명된 앱만 갱신한다. 이 앱은
// Apple 인증서 없이 ad-hoc 서명으로 배포하므로, GitHub 릴리스의 universal.zip 을
// 직접 내려받아 앱 번들을 통째로 바꿔 끼운다.
//
// 이 파일은 Electron 에 의존하지 않는 결정 로직만 담아 따로 테스트한다. 실제
// 다운로드·압축 해제·교체는 main.js 가 한다.
const path = require('node:path');

const MANIFEST_NAME = 'latest-mac.yml';
const STAGING_PREFIX = '.sound-shelf-update-';
const PREVIOUS_SUFFIX = '.previous';

// 릴리스 API 응답에서 설치에 쓸 자산을 고른다. universal.zip 이 있으면 그것을,
// 없으면 현재 아키텍처의 zip 을 쓴다. blockmap 은 zip 이 아니다.
function pickReleaseAssets(release, { arch = 'universal' } = {}) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const zips = assets.filter((asset) => /\.zip$/i.test(String(asset?.name || '')));
  const byName = (pattern) => zips.find((asset) => pattern.test(asset.name));
  const zip = byName(/-universal\.zip$/i) || byName(new RegExp(`-${arch}\\.zip$`, 'i')) || zips[0] || null;
  const manifest = assets.find((asset) => asset?.name === MANIFEST_NAME) || null;
  return {
    version: String(release?.tag_name || release?.name || '').replace(/^v/i, ''),
    url: release?.html_url || '',
    zip: zip ? { name: zip.name, url: zip.browser_download_url, size: Number(zip.size) || 0 } : null,
    manifest: manifest ? { name: manifest.name, url: manifest.browser_download_url } : null
  };
}

// electron-builder 가 올리는 latest-mac.yml 에서 파일별 sha512 를 읽는다.
// 구조가 단순해 YAML 파서 없이 줄 단위로 충분하다.
function parseUpdateManifest(text) {
  const manifest = { version: '', files: [] };
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const top = /^version:\s*(.+)$/.exec(line);
    if (top) {
      manifest.version = top[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const entry = /^\s*-\s*url:\s*(.+)$/.exec(line);
    if (entry) {
      current = { url: entry[1].trim(), sha512: '', size: 0 };
      manifest.files.push(current);
      continue;
    }
    const field = /^\s+(sha512|size):\s*(.+)$/.exec(line);
    if (field && current) {
      if (field[1] === 'sha512') current.sha512 = field[2].trim();
      else current.size = Number(field[2]) || 0;
      continue;
    }
    // 목록이 끝나고 최상위 path:/sha512: 가 오면 항목 채우기를 멈춘다.
    if (/^\S/.test(line)) current = null;
  }
  return manifest;
}

function manifestChecksum(manifest, fileName) {
  const entry = (manifest?.files || []).find((file) => file.url === fileName);
  return entry?.sha512 || null;
}

// 실행 파일 경로(…/Sound Shelf.app/Contents/MacOS/Sound Shelf)에서 .app 번들 경로를 얻는다.
function bundlePathFromExecutable(executablePath) {
  const exe = String(executablePath || '');
  if (!exe) return null;
  const macos = path.dirname(exe);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents') return null;
  if (!bundle.endsWith('.app')) return null;
  return bundle;
}

// 번들을 바꿔 끼울 수 없는 이유. null 이면 자체 업데이트가 가능하다.
function selfUpdateBlocker({ platform, packaged, bundlePath, writable }) {
  if (platform !== 'darwin') return 'macOS에서만 앱 안 자동 업데이트를 지원합니다.';
  if (!packaged) return '개발 실행 중에는 자동 업데이트를 하지 않습니다.';
  if (!bundlePath) return '앱 번들 위치를 알 수 없어 자동 업데이트를 할 수 없습니다.';
  if (bundlePath.includes('/AppTranslocation/')) {
    return '앱을 응용 프로그램 폴더로 옮긴 뒤 다시 실행하면 자동 업데이트가 동작합니다.';
  }
  if (!writable) return '앱이 있는 폴더에 쓸 수 없어 자동 업데이트를 할 수 없습니다. 응용 프로그램 폴더로 옮겨 주세요.';
  return null;
}

// 압축을 푸는 자리는 앱과 같은 폴더에 둔다. 같은 볼륨이어야 교체가 이름 바꾸기 한 번으로 끝난다.
function stagingDirectory(bundlePath, version) {
  return path.join(path.dirname(bundlePath), `${STAGING_PREFIX}${version}`);
}

function previousBundlePath(bundlePath) {
  return `${bundlePath}${PREVIOUS_SUFFIX}`;
}

// 앱 폴더에 남은 이전 교체 흔적인지. 시작할 때 이것만 지운다.
function isUpdateLeftover(name, bundleName) {
  return name.startsWith(STAGING_PREFIX) || name === `${bundleName}${PREVIOUS_SUFFIX}`;
}

// 앱이 끝난 뒤 번들을 바꿔 끼우고(필요하면) 다시 여는 스크립트. 앱 프로세스 안에서
// 바꾸면 종료 직전에 뜨는 헬퍼 프로세스가 새 번들의 바이너리를 잡을 수 있어 밖에서 한다.
//
// 앱은 종료 중 Node 정리 단계에서 볼트(Google Drive)의 파일 작업 하나가 응답하지 않으면
// 한참, 때로는 영영 끝나지 않는다(2026-09-29 관찰). 저장은 종료 시작 3초 안에 끝나므로
// 유예가 지나면 앱을 직접 끝내고 교체를 진행한다.
//
// 인자: pid, 현재 번들, 준비된 새 번들, 재실행 여부(1/0), 로그 파일(비우면 로그 없음),
//       종료 유예 초(생략 시 60).
const SWAP_SCRIPT = `
pid="$1"; app="$2"; staged="$3"; relaunch="$4"; log="$5"; grace="\${6:-60}"
if [ -n "$log" ]; then
  exec >>"$log" 2>&1
  echo "== $(date '+%Y-%m-%d %H:%M:%S') swap start pid=$pid relaunch=$relaunch grace=$grace"
  echo "   app=$app"
  echo "   staged=$staged"
fi
waited=0
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge "$((grace * 5))" ]; then
    echo "app still running after \${grace}s, sending TERM"
    kill -TERM "$pid" 2>/dev/null
    sleep 5
    if kill -0 "$pid" 2>/dev/null; then
      echo "app ignored TERM, sending KILL"
      kill -KILL "$pid" 2>/dev/null
      sleep 2
    fi
    break
  fi
  waited=$((waited + 1))
  sleep 0.2
done
if kill -0 "$pid" 2>/dev/null; then
  echo "app did not exit, giving up"
  exit 1
fi
[ -n "$log" ] && echo "app exited after $((waited / 5))s, swapping" && set -x
previous="$app${PREVIOUS_SUFFIX}"
rm -rf "$previous"
mv "$app" "$previous" || exit 1
if ! mv "$staged" "$app"; then
  mv "$previous" "$app"
  exit 1
fi
rm -rf "$previous"
rmdir "$(dirname "$staged")" 2>/dev/null
if [ "$relaunch" = "1" ]; then open "$app"; fi
echo "swap done"
exit 0
`;

function swapScriptArguments({ pid, bundlePath, stagedBundlePath, relaunch, logFile = '', graceSeconds = 60 }) {
  return ['sh', String(pid), bundlePath, stagedBundlePath, relaunch ? '1' : '0', logFile, String(graceSeconds)];
}

module.exports = {
  MANIFEST_NAME,
  SWAP_SCRIPT,
  bundlePathFromExecutable,
  isUpdateLeftover,
  manifestChecksum,
  parseUpdateManifest,
  pickReleaseAssets,
  previousBundlePath,
  selfUpdateBlocker,
  stagingDirectory,
  swapScriptArguments
};
