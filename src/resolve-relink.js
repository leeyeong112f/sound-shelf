const path = require('node:path');

// Sound Shelf 에서 파일이나 폴더를 옮기면 DaVinci Resolve 미디어 풀의 클립은 옛 경로를 그대로
// 가리켜 오프라인이 된다. Resolve 는 사용자가 폴더를 직접 골라 주기 전에는 새 위치를 모른다.
//
// 이 모듈은 Resolve 가 보고한 오프라인 클립을 라이브러리의 현재 파일과 짝지어, 클립마다
// 어느 폴더로 재연결할지 계획만 세운다. 실제 재연결(MediaPool.RelinkClips)은 resolve_relink.py 가
// 한다. RelinkClips 는 폴더 안에서 파일 이름으로 다시 찾으므로 이름이 바뀐 파일은 이 방법으로
// 되돌릴 수 없다. 그런 클립은 unmatched 로 남겨 사용자에게 맡긴다.
//
// 단서는 파일 이름뿐이다(Resolve 는 옛 파일의 크기나 해시를 주지 않는다). 같은 이름이 여러
// 폴더에 있으면 폴더째 옮긴 경우를 우선해 옛 상위 폴더 이름이 같은 쪽을 고르고, 그래도
// 하나로 좁혀지지 않으면 손대지 않는다. 잘못 연결된 클립은 타임라인에서 다른 소리를 낸다.
//
// 사용자가 Resolve 에서 Unlink 한 클립은 File Path 가 "OFFLINE - " 로 비고 File Name 과
// Clip Directory 만 남는다(2026-10-08 Resolve 21.1 에서 확인). 둘을 합쳐 옛 경로로 쓴다.

function nfc(value) {
  return String(value || '').normalize('NFC');
}

function nameKey(filePath) {
  return nfc(path.basename(String(filePath || ''))).toLocaleLowerCase('ko');
}

function parentKey(filePath) {
  return nfc(path.basename(path.dirname(String(filePath || '')))).toLocaleLowerCase('ko');
}

function samePath(a, b) {
  return nfc(path.resolve(String(a || ''))) === nfc(path.resolve(String(b || '')));
}

// Resolve 가 마지막으로 알고 있던 파일 경로. 파일을 옮긴 클립은 File Path 에 옛 경로가 남고,
// Unlink 한 클립은 File Name + Clip Directory 로 복원한다.
function clipSourcePath(clip) {
  const filePath = String(clip?.filePath || '');
  if (path.isAbsolute(filePath)) return filePath;
  const fileName = String(clip?.fileName || '');
  if (!fileName) return '';
  const directory = String(clip?.directory || '');
  return path.isAbsolute(directory) ? path.join(directory, fileName) : fileName;
}

/**
 * @param {Array<{id: string, name?: string, filePath?: string, fileName?: string, directory?: string}>} clips
 *   Resolve 가 보고한 오프라인 클립
 * @param {Array<{id: string, path: string}>} sounds 라이브러리 레코드
 * @param {{exists?: (filePath: string) => boolean}} options 디스크 존재 여부 판정
 */
function planResolveRelinks(clips, sounds, { exists = () => true } = {}) {
  const byName = new Map();
  for (const sound of sounds || []) {
    // 라이브러리에서도 사라진 파일은 후보가 아니다. 그 경로로 재연결해도 여전히 오프라인이다.
    if (!sound?.path || !exists(sound.path)) continue;
    const key = nameKey(sound.path);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(sound);
  }

  const relinks = [];
  const ambiguous = [];
  const unmatched = [];
  const skipped = [];
  const relinkTo = (clip, name, from, sound) => {
    relinks.push({ clipId: clip.id, name, from, to: sound.path, folder: path.dirname(sound.path), soundId: sound.id });
  };
  for (const clip of clips || []) {
    const from = clipSourcePath(clip);
    // 타임라인·멀티캠처럼 파일이 없는 항목은 재연결 대상이 아니다.
    if (!clip?.id || !from) continue;
    const name = clip.name || path.basename(from);
    const unlinked = !path.isAbsolute(String(clip.filePath || ''));
    const sameName = (byName.get(nameKey(from)) || []);
    if (path.isAbsolute(from) && exists(from)) {
      // Unlink 한 클립의 파일이 제자리에 있으면 그 폴더로 되돌린다. 단, 라이브러리의 사운드일 때만이다.
      // 사용자가 일부러 끊어 둔 영상 클립을 Sound Shelf 가 되살리면 안 된다.
      const inPlace = unlinked ? sameName.find((sound) => samePath(sound.path, from)) : null;
      if (inPlace) {
        relinkTo(clip, name, from, inPlace);
        continue;
      }
      // 옛 경로에 파일이 아직 있으면 Sound Shelf 가 옮긴 것이 아니다(Drive 가 아직 덜 내려받았거나
      // Resolve 의 상태가 오래됐다). 다른 파일로 바꿔 끼우지 않는다.
      skipped.push({ clipId: clip.id, name, from });
      continue;
    }
    let candidates = sameName.filter((sound) => !samePath(sound.path, from));
    if (candidates.length > 1) {
      const sameParent = candidates.filter((sound) => parentKey(sound.path) === parentKey(from));
      if (sameParent.length === 1) candidates = sameParent;
    }
    if (candidates.length === 1) {
      relinkTo(clip, name, from, candidates[0]);
    } else if (candidates.length) {
      ambiguous.push({ clipId: clip.id, name, from, candidates: candidates.map((sound) => sound.path) });
    } else {
      unmatched.push({ clipId: clip.id, name, from });
    }
  }
  return { relinks, ambiguous, unmatched, skipped };
}

function describeResolveRelink(summary) {
  if (!summary?.ok) return summary?.message || 'DaVinci Resolve 에 연결하지 못했습니다.';
  if (!summary.scanned) return 'DaVinci Resolve 미디어 풀에 오프라인 클립이 없습니다.';
  const parts = [`DaVinci Resolve 오프라인 클립 ${summary.scanned}개 중 ${summary.relinked}개 재연결`];
  if (summary.failed) parts.push(`${summary.failed}개 재연결 실패`);
  if (summary.ambiguous) parts.push(`${summary.ambiguous}개는 같은 이름의 파일이 여러 개라 건너뜀`);
  if (summary.unmatched) parts.push(`${summary.unmatched}개는 라이브러리에 같은 이름이 없음`);
  if (summary.skipped) parts.push(`${summary.skipped}개는 옛 경로에 파일이 아직 있음`);
  return parts.join(' · ');
}

module.exports = { clipSourcePath, describeResolveRelink, planResolveRelinks };
