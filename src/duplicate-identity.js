const path = require('node:path');
const { matchesTechnicalIdentity, normalizedRelativeParent, relatedFileNames } = require('./file-identity');

// 파일이 없는 레코드와, 같은 파일을 가리키는 살아 있는 레코드를 하나로 합친다.
//
// 이런 쌍은 두 Mac 이 같은 이름 변경을 다르게 본 뒤에 생긴다(2026-10-11 pop (뽁) 사례). 한 Mac 은
// 옛 레코드를 새 이름에 연결했고 다른 Mac 은 새 이름을 새 레코드로 등록했는데, 병합이 옛 경로를
// 택하면 옛 레코드(별점 포함)는 "파일 없음"으로, 새 레코드는 같은 소리의 두 번째 줄로 남는다.
// 누락 자동 정리는 별점이 있는 레코드를 지우지 않으므로 이 상태는 저절로 풀리지 않는다.
//
// 판정은 보수적이다. 크기와 확장자가 같고, 이름이 같거나 복사·충돌 꼬리 하나만 다르고, 둘 다 아는
// 기술 정보(길이·샘플레이트·채널·코덱)가 모두 같아야 한다. 기술 정보를 둘 다 모르면 같은 폴더의
// 같은 이름일 때만 합친다. 후보가 둘 이상이면 손대지 않는다.

function nfc(value) {
  return String(value || '').normalize('NFC');
}

function fileNameOf(sound) {
  return sound?.fileName || path.basename(String(sound?.relativePath || sound?.path || ''));
}

function sameFileName(left, right) {
  return nfc(fileNameOf(left)).toLocaleLowerCase('ko') === nfc(fileNameOf(right)).toLocaleLowerCase('ko');
}

function hasTechnicalInfo(sound) {
  return ['duration', 'sampleRate', 'channels'].some((field) => Number(sound?.[field]) > 0);
}

function looksLikeSameFile(missing, live) {
  const size = Number(missing?.size);
  if (!(size > 0) || size !== Number(live?.size)) return false;
  if (!relatedFileNames(fileNameOf(missing), fileNameOf(live))) return false;
  if (hasTechnicalInfo(missing) && hasTechnicalInfo(live)) return matchesTechnicalIdentity(missing, live);
  // 성질을 비교할 수 없으면 같은 폴더의 같은 이름만 믿는다(폴더째 옮긴 경우가 아니라 폴더 안 중복).
  return sameFileName(missing, live)
    && normalizedRelativeParent(missing?.relativePath) === normalizedRelativeParent(live?.relativePath);
}

/**
 * @param {object[]} missingSounds 파일이 없다고 확인된 레코드
 * @param {object[]} liveSounds 파일이 있는 레코드
 * @returns {{ pairs: Array<{missing: object, live: object}>, ambiguous: number }}
 */
function findDuplicateRecords(missingSounds, liveSounds) {
  const pairs = [];
  let ambiguous = 0;
  const claimed = new Set();
  const liveBySize = new Map();
  for (const live of liveSounds || []) {
    const size = Number(live?.size);
    if (!live?.id || !(size > 0)) continue;
    if (!liveBySize.has(size)) liveBySize.set(size, []);
    liveBySize.get(size).push(live);
  }
  for (const missing of missingSounds || []) {
    if (!missing?.id) continue;
    const candidates = (liveBySize.get(Number(missing.size)) || [])
      .filter((live) => live.id !== missing.id && !claimed.has(live.id) && looksLikeSameFile(missing, live));
    if (candidates.length === 1) {
      claimed.add(candidates[0].id);
      pairs.push({ missing, live: candidates[0] });
    } else if (candidates.length > 1) {
      ambiguous += 1;
    }
  }
  return { pairs, ambiguous };
}

function stemOf(sound) {
  const name = nfc(fileNameOf(sound));
  return path.basename(name, path.extname(name));
}

// 제목이 파일 이름에서 나온 기본값이 아니면 사용자가 직접 붙인 것이다.
function hasCustomTitle(sound) {
  const title = nfc(sound?.title).trim();
  return Boolean(title) && title !== stemOf(sound);
}

// 더 먼저 만든 레코드가 남는다. 다른 Mac 이 그 id 에 달아 둔 편집이 계속 유효하다. 시각이 같으면
// 파일이 있는 쪽이다.
function chooseSurvivor(missing, live) {
  const missingCreated = Number(missing?.createdAt || 0);
  const liveCreated = Number(live?.createdAt || 0);
  if (missingCreated > 0 && (liveCreated <= 0 || missingCreated < liveCreated)) return { survivor: missing, loser: live };
  return { survivor: live, loser: missing };
}

function joinNotes(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a) return b;
  if (!b || a === b || a.includes(b)) return a;
  return `${a}\n${b}`;
}

/**
 * 두 레코드의 사용자 정보를 합친 필드를 돌려준다. 경로·파일 이름·기술 정보는 파일이 있는 쪽(live)의
 * 것이다. id 와 createdAt 은 survivor 의 것이다.
 */
function mergedSoundFields(survivor, loser, live) {
  const preferred = hasCustomTitle(survivor) ? survivor : hasCustomTitle(loser) ? loser : null;
  const title = preferred ? nfc(preferred.title).trim() : stemOf(live);
  return {
    id: survivor.id,
    createdAt: Math.min(...[survivor.createdAt, loser.createdAt].map((value) => Number(value || 0)).filter((value) => value > 0), Date.now()),
    title,
    tags: [...new Set([...(survivor.tags || []), ...(loser.tags || [])])],
    notes: joinNotes(survivor.notes, loser.notes),
    favorite: Boolean(survivor.favorite || loser.favorite),
    rating: Math.max(Number(survivor.rating || 0), Number(loser.rating || 0)),
    keyAnalysis: survivor.keyAnalysis || loser.keyAnalysis || null
  };
}

module.exports = { chooseSurvivor, findDuplicateRecords, hasCustomTitle, looksLikeSameFile, mergedSoundFields };
