const test = require('node:test');
const assert = require('node:assert/strict');
const {
  failedProbeMetadata,
  hasCompleteTechnicalMetadata,
  mediaErrorMessage,
  needsTechnicalProbe
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
