const path = require('path');

// 디스크에서 사라진 사운드를 목록에서 자동으로 뺄지 판단한다.
//
// 다른 Mac 이 잠깐 존재했던 파일(예: 이름을 두 번 바꾸는 도중의 "X 2.wav")을 색인하면,
// 그 레코드는 그 Mac 의 편집 파일에 삭제 표식 없이 남는다. 병합은 이것을 모든 Mac 에
// 계속 되살리고, 재연결은 이름·지문·해시가 맞지 않아 실패하므로 "파일 없음" 행이 영구히 남는다.
//
// 자동으로 빼는 것은 되돌릴 사용자 정보가 없는 레코드뿐이다. 태그·메모·별점·즐겨찾기·Key·
// 직접 바꾼 제목이 하나라도 있으면 재연결을 기다리도록 남긴다.
//
// 다른 Mac 이 방금 추가한 파일은 Google Drive 업로드가 끝나기 전까지 이 Mac 에서 누락으로
// 보인다. 마지막 편집 뒤 유예 시간이 지나야 대상이 된다.
//
// 이름과 크기가 같은 파일이 방금 새로 색인됐다면, 재연결이 후보를 하나로 좁히지 못한 이동일
// 수 있다. 다른 Mac 의 이동 기록이 도착할 때까지 같은 유예를 준다. 먼저 지우면 그 Mac 이
// 이동하며 붙인 태그를 삭제 표식이 이긴다.
//
// Drive 가 덜 마운트되면 수백 개가 한꺼번에 누락으로 보인다. 대상이 한도를 넘으면 하나도
// 지우지 않는다.
const MISSING_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;
const MISSING_CLEANUP_MAX_BATCH = 20;

function nfc(value) {
  return String(value || '').normalize('NFC');
}

// 제목 기본값은 확장자를 뺀 파일명이다(portableSound). 파일명은 디스크에서 NFD 로 올 수 있어
// 정규화하지 않고 비교하면 손대지 않은 제목도 "직접 바꾼 제목"으로 읽힌다.
function hasCustomTitle(sound) {
  const title = nfc(sound?.title).trim();
  if (!title) return false;
  const fileName = sound?.fileName || path.basename(String(sound?.relativePath || sound?.path || ''));
  return title !== nfc(path.basename(fileName, path.extname(fileName)));
}

function hasUserMetadata(sound) {
  if (!sound) return false;
  if ((sound.tags || []).length) return true;
  if (String(sound.notes || '').trim()) return true;
  if (sound.favorite) return true;
  if (Number(sound.rating || 0) > 0) return true;
  if (sound.keyAnalysis) return true;
  return hasCustomTitle(sound);
}

function finiteStamp(value) {
  const stamp = Number(value);
  return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
}

// 레코드를 마지막으로 만든 시각 또는 고친 시각. updatedAt 은 편집 파일에만 있어서
// 베이스라인(병합 결과)에서 받는다. 베이스 레코드는 updatedAt 이 0 이다.
function lastTouchedAt(sound, baseline) {
  return Math.max(finiteStamp(sound?.createdAt), finiteStamp(baseline?.updatedAt));
}

function lookalikeKey(sound) {
  const fileName = sound?.fileName || path.basename(String(sound?.relativePath || sound?.path || ''));
  const size = Number(sound?.size || 0);
  if (!fileName || !(size > 0)) return '';
  return `${nfc(fileName).toLocaleLowerCase('ko')}:${size}`;
}

// 이름·크기가 같은 살아 있는 레코드 중 가장 최근에 만든 시각.
function lookalikeCreatedAt(presentSounds) {
  const latest = new Map();
  for (const sound of presentSounds || []) {
    const key = lookalikeKey(sound);
    if (!key) continue;
    latest.set(key, Math.max(latest.get(key) || 0, finiteStamp(sound.createdAt)));
  }
  return latest;
}

/**
 * 누락이 확인된 사운드 중 자동으로 목록에서 뺄 것을 고른다.
 *
 * @param {object[]} missingSounds 파일이 없다고 확인된 사운드(ENOENT)
 * @param {object} options
 * @param {number} options.now
 * @param {Map<string, object>} [options.baselineById] id → 병합 베이스라인 레코드(updatedAt 포함)
 * @param {object[]} [options.presentSounds] 파일이 있는 사운드. 이름·크기가 같은 새 레코드를 찾는 데 쓴다.
 * @returns {{ ids: string[], candidates: number, kept: number, deferred: number, blocked: boolean }}
 *   blocked 이면 ids 는 비어 있다.
 */
function selectMissingForCleanup(missingSounds, {
  now,
  baselineById = new Map(),
  presentSounds = [],
  graceMs = MISSING_CLEANUP_GRACE_MS,
  maxBatch = MISSING_CLEANUP_MAX_BATCH
} = {}) {
  const candidates = [];
  let kept = 0;
  let deferred = 0;
  // 지우는 쪽으로 기울면 안 된다. 현재 시각을 모르면 모두 미룬다.
  const clock = Number.isFinite(now) ? now : -Infinity;
  const lookalikes = lookalikeCreatedAt(presentSounds);
  for (const sound of missingSounds || []) {
    if (!sound?.id) continue;
    if (hasUserMetadata(sound)) {
      kept += 1;
      continue;
    }
    const touchedAt = Math.max(
      lastTouchedAt(sound, baselineById.get(sound.id)),
      lookalikes.get(lookalikeKey(sound)) || 0
    );
    if (clock - touchedAt < graceMs) {
      deferred += 1;
      continue;
    }
    candidates.push(sound.id);
  }
  const blocked = candidates.length > maxBatch;
  return {
    ids: blocked ? [] : candidates,
    candidates: candidates.length,
    kept,
    deferred,
    blocked
  };
}

module.exports = {
  MISSING_CLEANUP_GRACE_MS,
  MISSING_CLEANUP_MAX_BATCH,
  hasUserMetadata,
  lastTouchedAt,
  selectMissingForCleanup
};
