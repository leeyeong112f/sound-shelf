const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { KEY_ANALYSIS_VERSION } = require('../src/key-analysis');

// 검출기 본체는 파이썬이라 합성 신호로 검사한 결과를 JSON으로 받아 확인한다.
// numpy가 없는 환경에서는 건너뛴다.
function runDetectorCheck() {
  const script = path.join(__dirname, 'key_detect_check.py');
  try {
    const stdout = execFileSync(process.env.PYTHON || 'python3', [script], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      timeout: 600000
    });
    return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

const report = runDetectorCheck();

test('조성 검출 회귀 검사', { skip: report.available ? false : `python3/numpy 없음: ${report.reason}` }, async (t) => {
  await t.test('스크립트와 앱의 분석 버전이 일치한다', () => {
    assert.equal(report.version, KEY_ANALYSIS_VERSION);
  });
  for (const item of report.cases || []) {
    await t.test(item.name, () => {
      assert.ok(item.ok, item.detail);
    });
  }
});
