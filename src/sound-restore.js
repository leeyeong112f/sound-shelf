const { matchesStableFileFingerprint } = require('./file-identity');

// 삭제 표식(tombstone)이 남는 이유는 두 가지고, 다시 나타난 파일을 어떻게 볼지가 서로 다르다.
//
//   trashed  … 원본을 휴지통으로 보냈다. 같은 파일이 같은 자리로 돌아왔다면 사용자가
//              되돌린 것이므로, 태그·별점·메모·Key 를 되살려야 한다.
//   unlinked … 파일은 두고 라이브러리에서만 뺐다. 파일이 그대로 있는 게 정상이므로,
//              자동 스캔이 다시 집어넣으면 안 된다. 앱 안에서 명시적으로 추가할 때만 들어온다.
//
// reason 이 없는 옛 표식은 trashed 로 본다. 이전 버전에는 "항목만 삭제"가 없었고
// 모든 삭제가 원본을 휴지통으로 보냈다.
const TRASHED = 'trashed';
const UNLINKED = 'unlinked';

function tombstoneReason(tombstone) {
  return tombstone?.reason === UNLINKED ? UNLINKED : TRASHED;
}

function normalizedKey(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.')
    .join('/')
    .normalize('NFC');
}

// 같은 자리로 돌아온 파일이 정말 그 파일인지 본다. 크기가 다르면 다른 파일이고,
// 해시를 양쪽 다 알면 해시가 최종 판정이다. 해시가 없으면 크기 + mtime 지문으로 본다.
function isSameFileAsTombstone(tombstone, candidate) {
  if (!tombstone || !candidate) return false;
  const tombstoneSize = Number(tombstone.size);
  const candidateSize = Number(candidate.size);
  if (!Number.isFinite(tombstoneSize) || !Number.isFinite(candidateSize)) return false;
  if (tombstoneSize <= 0 || tombstoneSize !== candidateSize) return false;

  if (tombstone.contentHash && candidate.contentHash) {
    return tombstone.contentHash === candidate.contentHash;
  }
  return matchesStableFileFingerprint(tombstone, candidate);
}

/**
 * 새로 발견한 파일이 예전에 삭제한 바로 그 파일인지 찾는다.
 *
 * 상대 경로가 같은 trashed 표식만 후보다. 경로가 다르면 "복원"이 아니라 이동이고,
 * 그건 relinkMissingFromFiles 가 다룬다. unlinked 는 사용자가 의도적으로 뺀 것이라
 * 여기서 되살리지 않는다.
 */
function restorableTombstone(tombstones, candidate) {
  const relativePath = normalizedKey(candidate?.relativePath);
  if (!relativePath) return null;
  for (const tombstone of tombstones || []) {
    if (tombstoneReason(tombstone) !== TRASHED) continue;
    if (normalizedKey(tombstone.relativePath) !== relativePath) continue;
    if (!isSameFileAsTombstone(tombstone, candidate)) continue;
    return tombstone;
  }
  return null;
}

// 되살릴 값은 사용자가 손으로 넣은 것들뿐이다. 길이·코덱 같은 기술 필드는 파일에서
// 다시 읽으면 되고, 오히려 옛 값을 물려주면 틀린 정보가 된다.
function restoredSoundFields(tombstone) {
  if (!tombstone) return null;
  return {
    id: tombstone.id,
    title: tombstone.title || '',
    tags: [...new Set(tombstone.tags || [])],
    notes: tombstone.notes || '',
    favorite: Boolean(tombstone.favorite),
    rating: Number(tombstone.rating || 0),
    keyAnalysis: tombstone.keyAnalysis || null,
    createdAt: Number(tombstone.createdAt) || Date.now()
  };
}

// 자동 스캔이 건너뛰어야 하는 상대 경로. unlinked 표식만 해당한다.
function unlinkedRelativePaths(tombstones) {
  return new Set((tombstones || [])
    .filter((tombstone) => tombstoneReason(tombstone) === UNLINKED)
    .map((tombstone) => normalizedKey(tombstone.relativePath))
    .filter(Boolean));
}

module.exports = {
  TRASHED,
  UNLINKED,
  isSameFileAsTombstone,
  restorableTombstone,
  restoredSoundFields,
  tombstoneReason,
  unlinkedRelativePaths
};
