const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROBE_BACKOFF_MS,
  failedProbeMetadata,
  hasCompleteTechnicalMetadata,
  mediaErrorMessage,
  needsTechnicalProbe,
  probeBackoffMs
} = require('../src/media-health');

const complete = {
  duration: 2.5,
  sampleRate: 48000,
  channels: 2,
  codec: 'pcm_s24le',
  metadataVersion: 1,
  technicalCached: true,
  modifiedAt: 100,
  size: 200
};

test('정상 기술 정보는 같은 파일을 다시 분석하지 않는다', () => {
  assert.equal(hasCompleteTechnicalMetadata(complete), true);
  assert.equal(needsTechnicalProbe(complete, { mtimeMs: 100, size: 200 }), false);
});

test('길이 또는 코덱이 비어 있으면 파일이 같아도 다시 분석한다', () => {
  assert.equal(needsTechnicalProbe({ ...complete, duration: 0 }, { mtimeMs: 100, size: 200 }), true);
  assert.equal(needsTechnicalProbe({ ...complete, codec: '' }, { mtimeMs: 100, size: 200 }), true);
});

test('분석 실패는 성공 캐시로 표시하지 않는다', () => {
  const result = failedProbeMetadata(new Error('temporary cloud error'));
  assert.equal(result.metadataVersion, 0);
  assert.equal(result.technicalCached, false);
  assert.match(result.technicalError, /Google Drive/);
});

test('파형 오류를 사용자가 이해할 수 있는 문장으로 바꾼다', () => {
  assert.match(mediaErrorMessage({ code: 'ENOENT' }, { fileExists: false, waveform: true }), /원본 파일/);
  assert.match(mediaErrorMessage({ code: 'ENOENT' }, { fileExists: true, waveform: true }), /분석 도구/);
  assert.match(mediaErrorMessage({ code: 'ETIMEDOUT' }, { waveform: true }), /시간이 초과/);
  assert.match(mediaErrorMessage(new Error('Invalid data found when processing input'), { waveform: true }), /손상|지원되지 않는/);
});

// --- 실패한 프로브 백오프 ---
// Google Drive 에 아직 내려오지 않은 파일은 몇 번을 시도해도 같은 결과다. 백오프가 없으면
// 재스캔마다 파일당 ffprobe 3회 + 1초 대기를 반복해 스캔이 끝나지 않는다.

const NOW = 1_800_000_000_000;
const STAT = { mtimeMs: 1000, size: 2000 };

function failedSound(attempts, failedAt) {
  return {
    modifiedAt: STAT.mtimeMs,
    size: STAT.size,
    technicalCached: false,
    metadataVersion: 0,
    technicalProbeFailedAt: failedAt,
    technicalProbeAttempts: attempts
  };
}

test('완전한 기술 정보가 있으면 다시 읽지 않는다', () => {
  const ok = { modifiedAt: STAT.mtimeMs, size: STAT.size, technicalCached: true, duration: 1, sampleRate: 48000, channels: 2, codec: 'pcm_s16le', metadataVersion: 1 };
  assert.equal(needsTechnicalProbe(ok, STAT, NOW), false);
});

test('첫 실패 후 5분 안에는 다시 시도하지 않는다', () => {
  const sound = failedSound(1, NOW - 60 * 1000);
  assert.equal(needsTechnicalProbe(sound, STAT, NOW), false);
});

test('백오프 시간이 지나면 다시 시도한다', () => {
  const sound = failedSound(1, NOW - 6 * 60 * 1000);
  assert.equal(needsTechnicalProbe(sound, STAT, NOW), true);
});

test('연속 실패할수록 간격이 길어진다', () => {
  // 4회 실패 뒤에는 12시간을 기다린다. 6시간 뒤에는 아직 아니다.
  assert.equal(needsTechnicalProbe(failedSound(4, NOW - 6 * 60 * 60 * 1000), STAT, NOW), false);
  assert.equal(needsTechnicalProbe(failedSound(4, NOW - 13 * 60 * 60 * 1000), STAT, NOW), true);
});

test('파일이 실제로 바뀌면 백오프와 무관하게 즉시 다시 읽는다', () => {
  const sound = failedSound(5, NOW - 1000);
  assert.equal(needsTechnicalProbe(sound, { ...STAT, mtimeMs: STAT.mtimeMs + 1 }, NOW), true);
  assert.equal(needsTechnicalProbe(sound, { ...STAT, size: STAT.size + 1 }, NOW), true);
});

test('실패 이력이 없으면 백오프 없이 시도한다', () => {
  assert.equal(needsTechnicalProbe(failedSound(0, 0), STAT, NOW), true);
});

test('failedProbeMetadata 는 연속 실패 횟수를 이어받는다', () => {
  const first = failedProbeMetadata(new Error('x'), true, null, NOW);
  assert.equal(first.technicalProbeAttempts, 1);
  assert.equal(first.technicalProbeFailedAt, NOW);
  const second = failedProbeMetadata(new Error('x'), true, first, NOW + 1);
  assert.equal(second.technicalProbeAttempts, 2);
  assert.equal(second.technicalProbeFailedAt, NOW + 1);
});

test('백오프 간격은 상한을 넘지 않는다', () => {
  assert.equal(probeBackoffMs(1), 5 * 60 * 1000);
  assert.equal(probeBackoffMs(99), PROBE_BACKOFF_MS[PROBE_BACKOFF_MS.length - 1]);
  assert.equal(probeBackoffMs(0), PROBE_BACKOFF_MS[0]);
});
