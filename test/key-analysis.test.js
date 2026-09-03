const test = require('node:test');
const assert = require('node:assert/strict');
const { KEY_ANALYSIS_VERSION, isCurrentKeyAnalysis, keyAnalysisErrorMessage } = require('../src/key-analysis');

const sound = { modifiedAt: 1700000000000 };
const current = { sourceModifiedAt: sound.modifiedAt, analysisVersion: KEY_ANALYSIS_VERSION };

test('현재 버전과 수정 시각이 일치하는 결과만 캐시로 인정한다', () => {
  assert.equal(isCurrentKeyAnalysis(current, sound), true);
  assert.equal(isCurrentKeyAnalysis(null, sound), false);
  assert.equal(isCurrentKeyAnalysis(current, null), false);
});

test('원본이 바뀌면 캐시를 버린다', () => {
  assert.equal(isCurrentKeyAnalysis(current, { modifiedAt: sound.modifiedAt + 1 }), false);
});

test('이전 알고리즘으로 만든 결과는 다시 분석하도록 캐시를 버린다', () => {
  assert.equal(isCurrentKeyAnalysis({ ...current, analysisVersion: KEY_ANALYSIS_VERSION - 1 }, sound), false);
  assert.equal(isCurrentKeyAnalysis({ sourceModifiedAt: sound.modifiedAt }, sound), false);
});

test('numpy 누락은 설치 안내로 바꾼다', () => {
  const stack = `Command failed: python3 -c ${'x'.repeat(9000)}\nTraceback (most recent call last):\n  File "<string>", line 6, in <module>\nModuleNotFoundError: No module named 'numpy'`;
  const message = keyAnalysisErrorMessage(new Error(stack));
  assert.match(message, /pip3 install numpy/);
  assert.ok(!message.includes('Command failed'));
});

test('실행 파일을 찾지 못하면 설치 안내를 보여준다', () => {
  assert.match(keyAnalysisErrorMessage(new Error('spawn python3 ENOENT')), /python3 또는 ffmpeg/);
});

test('제한 시간 초과를 안내 문구로 바꾼다', () => {
  assert.match(keyAnalysisErrorMessage(new Error('Command failed: ETIMEDOUT')), /제한 시간/);
});

test('스크립트 전문이 섞인 오류에서 마지막 원인 한 줄만 남긴다', () => {
  const stack = `Command failed: python3 -c import json\n${'y'.repeat(9000)}\nTraceback (most recent call last):\n  File "<string>", line 20, in analyze\nValueError: 알 수 없는 오류`;
  const message = keyAnalysisErrorMessage(new Error(stack));
  assert.ok(message.length <= 201, `길이 ${message.length}`);
  assert.ok(!message.includes('Traceback'));
});

test('아주 긴 한 줄 오류도 잘라서 보여준다', () => {
  const message = keyAnalysisErrorMessage(new Error(`Command failed: python3 -c ${'y'.repeat(9000)}`));
  assert.ok(message.length <= 201, `길이 ${message.length}`);
});

test('스크립트가 내보낸 JSON 오류 메시지는 그대로 전달한다', () => {
  assert.equal(keyAnalysisErrorMessage(new Error('오디오 디코딩에 실패했습니다.')), '오디오 디코딩에 실패했습니다.');
});
