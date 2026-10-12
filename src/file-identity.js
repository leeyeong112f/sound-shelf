const path = require('node:path');

function normalizedRelativeParent(value) {
  const normalized = String(value || '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.')
    .join('/')
    .normalize('NFC');
  return normalized ? path.posix.dirname(normalized) : '';
}

function matchesStableFileFingerprint(sound, candidate, { mtimeToleranceMs = 2000 } = {}) {
  const sourceSize = Number(sound?.size);
  const candidateSize = Number(candidate?.size);
  const sourceModifiedAt = Number(sound?.modifiedAt);
  const candidateModifiedAt = Number(candidate?.modifiedAt);
  if (!Number.isFinite(sourceSize) || !Number.isFinite(candidateSize) || sourceSize !== candidateSize) return false;
  if (!Number.isFinite(sourceModifiedAt) || !Number.isFinite(candidateModifiedAt)) return false;
  if (sourceModifiedAt <= 0 || candidateModifiedAt <= 0) return false;
  return Math.abs(sourceModifiedAt - candidateModifiedAt) <= mtimeToleranceMs;
}

/**
 * Detect a rename without hashing the whole audio file.
 *
 * A rename normally preserves size and mtime. Requiring the same parent folder
 * and exactly one caller-selected match keeps this conservative enough for a
 * synchronized vault, where another Mac can observe the new name before the
 * metadata edit arrives.
 */
function matchesRenameFingerprint(sound, candidate, { mtimeToleranceMs = 2000 } = {}) {
  if (!matchesStableFileFingerprint(sound, candidate, { mtimeToleranceMs })) return false;

  const sourceParent = normalizedRelativeParent(sound?.relativePath);
  const candidateParent = normalizedRelativeParent(candidate?.relativePath);
  return Boolean(sourceParent && candidateParent && sourceParent === candidateParent);
}

module.exports = { matchesRenameFingerprint, matchesStableFileFingerprint, normalizedRelativeParent };

// ---- 수정 시각 없이 같은 파일을 알아보기 ----
//
// Google Drive 는 한 Mac 에서 이름을 바꾼 파일을 다른 Mac 에 내려줄 때 mtime 을 내려받은 시각으로
// 바꾸는 경우가 있다(2026-10-11 iMac 에서 확인). 그러면 크기+mtime 지문이 어긋나 그 Mac 은 이름
// 변경을 알아보지 못하고 같은 파일을 새 사운드로 등록한다. 지문 대신 파일 자체의 성질
// (크기·길이·샘플레이트·채널·코덱)과 이름의 관계로 한 번 더 본다.

const DUPLICATE_SUFFIX = /(?:\s+\d+|\s*\(\d+\)|\s+copy(?:\s+\d+)?|\s+복사본(?:\s+\d+)?|\s+사본(?:\s+\d+)?)$/iu;

function fileStem(fileName) {
  const name = String(fileName || '').normalize('NFC');
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).toLocaleLowerCase('ko');
}

function fileExtension(fileName) {
  const name = String(fileName || '').normalize('NFC');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLocaleLowerCase('ko') : '';
}

function baseStem(fileName) {
  return fileStem(fileName).replace(DUPLICATE_SUFFIX, '').trim();
}

// "또잇.wav" 와 "또잇 2.wav", "hit (1).mp3", "hit copy.mp3" 처럼 한쪽이 다른 쪽에 복사·충돌 꼬리
// 하나를 붙인 이름. "hit 2" 와 "hit 3" 은 서로 다른 렌더일 수 있으므로 같은 이름으로 보지 않는다.
function relatedFileNames(left, right) {
  if (fileExtension(left) !== fileExtension(right)) return false;
  const a = fileStem(left);
  const b = fileStem(right);
  if (!a || !b) return false;
  return a === b || baseStem(left) === b || baseStem(right) === a;
}

function sameWhenKnown(a, b, { tolerance = 0 } = {}) {
  const left = Number(a);
  const right = Number(b);
  if (!(left > 0) || !(right > 0)) return true;
  return Math.abs(left - right) <= tolerance;
}

// 둘 다 아는 기술 정보가 하나도 다르지 않아야 한다. 길이는 ffprobe 반올림 차이를 감안한다.
// 길이·샘플레이트·채널을 하나도 모르면 성질 비교가 아니므로 false 다.
function matchesTechnicalIdentity(sound, candidate, { durationTolerance = 0.02 } = {}) {
  const size = Number(sound?.size);
  if (!(size > 0) || size !== Number(candidate?.size)) return false;
  const known = ['duration', 'sampleRate', 'channels'].some((field) => Number(sound?.[field]) > 0 && Number(candidate?.[field]) > 0);
  if (!known) return false;
  if (!sameWhenKnown(sound?.duration, candidate?.duration, { tolerance: durationTolerance })) return false;
  if (!sameWhenKnown(sound?.sampleRate, candidate?.sampleRate)) return false;
  if (!sameWhenKnown(sound?.channels, candidate?.channels)) return false;
  const leftCodec = String(sound?.codec || '').toLowerCase();
  const rightCodec = String(candidate?.codec || '').toLowerCase();
  if (leftCodec && rightCodec && leftCodec !== rightCodec) return false;
  return true;
}

// 같은 폴더 안에서 이름 꼬리만 달라진 같은 파일인지. mtime 은 보지 않는다.
function matchesRenamedByIdentity(sound, candidate) {
  const sourceParent = normalizedRelativeParent(sound?.relativePath);
  const candidateParent = normalizedRelativeParent(candidate?.relativePath);
  if (!sourceParent && !candidateParent) {
    // 둘 다 볼트 루트다. 루트 파일끼리도 비교한다.
  } else if (sourceParent !== candidateParent) return false;
  const sourceName = sound?.fileName || path.basename(String(sound?.relativePath || ''));
  const candidateName = candidate?.fileName || path.basename(String(candidate?.relativePath || ''));
  if (!relatedFileNames(sourceName, candidateName)) return false;
  return matchesTechnicalIdentity(sound, candidate);
}

module.exports.baseStem = baseStem;
module.exports.fileExtension = fileExtension;
module.exports.matchesRenamedByIdentity = matchesRenamedByIdentity;
module.exports.matchesTechnicalIdentity = matchesTechnicalIdentity;
module.exports.relatedFileNames = relatedFileNames;
