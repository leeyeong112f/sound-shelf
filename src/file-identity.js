const path = require('node:path');

function normalizedRelativeParent(value) {
  const normalized = String(value || '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.')
    .join('/')
    .normalize('NFC');
  return normalized ? path.posix.dirname(normalized) : '';
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
  const sourceSize = Number(sound?.size);
  const candidateSize = Number(candidate?.size);
  const sourceModifiedAt = Number(sound?.modifiedAt);
  const candidateModifiedAt = Number(candidate?.modifiedAt);
  if (!Number.isFinite(sourceSize) || !Number.isFinite(candidateSize) || sourceSize !== candidateSize) return false;
  if (!Number.isFinite(sourceModifiedAt) || !Number.isFinite(candidateModifiedAt)) return false;
  if (sourceModifiedAt <= 0 || candidateModifiedAt <= 0) return false;
  if (Math.abs(sourceModifiedAt - candidateModifiedAt) > mtimeToleranceMs) return false;

  const sourceParent = normalizedRelativeParent(sound?.relativePath);
  const candidateParent = normalizedRelativeParent(candidate?.relativePath);
  return Boolean(sourceParent && candidateParent && sourceParent === candidateParent);
}

module.exports = { matchesRenameFingerprint, normalizedRelativeParent };
