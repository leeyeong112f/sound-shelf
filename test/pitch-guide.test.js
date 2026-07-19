const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePitchGuide, sourceIndexForKey, targetKeys } = require('../src/pitch-guide');

test('tuning offset is converted into semitone and cents guidance', () => {
  const guide = calculatePitchGuide({
    sourceIndex: sourceIndexForKey('C'),
    sourceMode: 'major',
    tuningCents: 21.5,
    targetIndex: sourceIndexForKey('D'),
    targetMode: 'major'
  });
  assert.equal(guide.pitchSemitones, 2);
  assert.equal(guide.fineCents, -21.5);
  assert.equal(guide.totalCents, 178.5);
  assert.equal(guide.modeMismatch, false);
});

test('pitch guide chooses the shortest downward interval', () => {
  const guide = calculatePitchGuide({
    sourceIndex: sourceIndexForKey('C'),
    sourceMode: 'major',
    targetIndex: sourceIndexForKey('A'),
    targetMode: 'minor'
  });
  assert.equal(guide.pitchSemitones, -3);
  assert.equal(guide.totalCents, -300);
  assert.equal(guide.modeMismatch, true);
});

test('target list contains all 24 major and minor keys', () => {
  assert.equal(targetKeys().length, 24);
});
