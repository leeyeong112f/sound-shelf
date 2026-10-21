const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeEnvelope, measurementToEntryFields, parseEbur128, suggestSync } = require('../src/audio-analysis');
const { buildPrompt, extractJsonObject, sanitizeSuggestion, suggestArgs } = require('../src/claude-suggest');
const { catalogueMarkdown, isOwnCatalog, validateEntry } = require('../src/pack-metadata');

function tone({ sampleRate = 8000, seconds = 1, bursts = [] }) {
  const samples = new Float32Array(Math.round(sampleRate * seconds));
  for (const { at, length, amplitude } of bursts) {
    const from = Math.round(at * sampleRate);
    for (let index = from; index < Math.min(samples.length, from + Math.round(length * sampleRate)); index += 1) {
      samples[index] = amplitude * Math.sin(index / 3);
    }
  }
  return { samples, sampleRate };
}

test('포락선 분석: 들리는 구간·최대 지점·온셋을 찾는다', () => {
  const { samples, sampleRate } = tone({ seconds: 1, bursts: [{ at: 0.1, length: 0.05, amplitude: 0.3 }, { at: 0.4, length: 0.1, amplitude: 0.9 }] });
  const result = analyzeEnvelope(samples, sampleRate);
  assert.equal(result.duration, 1);
  assert.ok(Math.abs(result.audibleStart - 0.1) < 0.02);
  assert.ok(Math.abs(result.audibleEnd - 0.5) < 0.02);
  assert.ok(result.peakAt >= 0.4 && result.peakAt <= 0.5);
  assert.equal(result.onsets.length, 2);
  assert.ok(Math.abs(result.onsets[1] - 0.4) < 0.02);
});

test('무음은 silent 로 표시하고 맞출 지점을 제안하지 않는다', () => {
  const result = analyzeEnvelope(new Float32Array(800), 8000);
  assert.equal(result.silent, true);
  assert.equal(suggestSync(result), null);
});

test('짧은 소리는 최대 지점, 긴 소리는 첫 온셋에 맞춘다', () => {
  assert.deepEqual(suggestSync({ duration: 0.3, peakAt: 0.06, onsets: [0.03], audibleStart: 0.02 }), { at: 0.06, meets: 'instant' });
  assert.deepEqual(suggestSync({ duration: 5, peakAt: 3, onsets: [0.5, 2], audibleStart: 0.1 }), { at: 0.5, meets: 'action-start' });
});

test('ebur128 출력에서 순간 최대·통합·트루 피크를 읽는다', () => {
  const stderr = '[Parsed_ebur128_0] t: 0.1 TARGET:-23 LUFS M: -30.5 S:-120.7\n t: 0.2 M: -18.26 S: -20\n t: 0.3 M: -inf\nSummary:\n  Integrated loudness:\n    I:         -14.1 LUFS\n  True peak:\n    Peak:       -1.4 dBFS\n';
  assert.deepEqual(parseEbur128(stderr), { momentaryMax: -18.3, integrated: -14.1, truePeak: -1.4 });
  const fields = measurementToEntryFields({ analysis: { duration: 0.5, audibleStart: 0.01, audibleEnd: 0.3, peakAt: 0.05, onsets: [0.02] }, loudness: parseEbur128(stderr) });
  assert.deepEqual(fields.fields.level, { lufs: -18.3, true_peak_dbtp: -1.4, measure: 'momentary-max-400ms' });
  assert.deepEqual(fields.sync, { at: 0.05, meets: 'instant' });
  assert.deepEqual(validateEntry({ file: 'a.wav', ...fields.fields, sync: fields.sync }, 'a.wav'), []);
});

test('필드 v2: aliases·role·intensity·sync.meets 를 검사한다', () => {
  assert.deepEqual(validateEntry({ file: 'a.wav', aliases: ['뽁'], role: 'accent', intensity: 'soft', sync: { at: 0.1, meets: 'instant' } }, 'a.wav'), []);
  assert.equal(validateEntry({ file: 'a.wav', role: 'boom' }, 'a.wav').length, 1);
  assert.equal(validateEntry({ file: 'a.wav', intensity: 'loud' }, 'a.wav').length, 1);
  assert.equal(validateEntry({ file: 'a.wav', aliases: '뽁' }, 'a.wav').length, 1);
  assert.equal(validateEntry({ file: 'a.wav', sync: { at: 0.1, meets: 'whenever' } }, 'a.wav').length, 1);
});

test('카탈로그 한 줄 목록은 Sound Shelf 가 만든 카탈로그에만 쓴다', () => {
  const json = { name: '카탈로그', generator: 'Sound Shelf', sounds: [
    { file: '예능/또잇.wav', name: '또잇', description: '통통 튀는 뽁', use_for: ['자막 등장'], avoid_for: ['진지한 장면'], aliases: ['뽁'], tags: ['pop'], role: 'accent', intensity: 'soft', sync: { at: 0.06, meets: 'instant' }, level: { lufs: -18 }, duration: 1.1 }
  ] };
  assert.equal(isOwnCatalog(json), true);
  assert.equal(isOwnCatalog({ name: 'SFX Kit', sounds: [] }), false);
  const md = catalogueMarkdown(json);
  assert.match(md, /\*\*또잇\*\* `예능\/또잇\.wav` — 통통 튀는 뽁 · 쓸 곳: 자막 등장 · 피할 곳: 진지한 장면 · 부르는 말: 뽁/);
  assert.match(md, /역할 accent\/soft · 맞출 지점 0\.06s \(instant\) · -18 LUFS · 1\.1s/);
});

test('추천 결과: 코드 펜스·래퍼를 벗기고 허용한 필드·값만 남긴다', () => {
  const wrapped = JSON.stringify({ result: '```json\n{"description":"뽁","use_for":["자막","자막",""],"role":"boom","intensity":"soft","confidence":1.4,"tags":["pop"],"evil":"x"}\n```' });
  const suggestion = sanitizeSuggestion(extractJsonObject(wrapped));
  assert.equal(suggestion.description, '뽁');
  assert.deepEqual(suggestion.use_for, ['자막']);
  assert.equal(suggestion.role, '');
  assert.equal(suggestion.intensity, 'soft');
  assert.equal(suggestion.confidence, 1);
  assert.equal('evil' in suggestion, false);
  assert.throws(() => extractJsonObject('추천할 수 없습니다'), /JSON/);
});

test('프롬프트에 그림 경로·측정값·기존 값과 역할 목록이 들어가고, 도구는 Read 만 연다', () => {
  const prompt = buildPrompt({ relativePath: '예능/또잇.wav', entry: { description: '', tags: ['pop'] }, measurement: { duration: 1.1 }, wavePng: '/tmp/w.png', spectrumPng: '/tmp/s.png' });
  assert.match(prompt, /\/tmp\/w\.png/);
  assert.match(prompt, /"tags":\["pop"\]/);
  assert.match(prompt, /accent\(강조\)/);
  assert.ok(!prompt.includes('"description":""'), '빈 값은 넘기지 않는다');
  const args = suggestArgs(prompt, 'haiku');
  assert.deepEqual(args.slice(2), ['--allowedTools', 'Read', '--output-format', 'json', '--model', 'haiku']);
});

test('ametadata 형식(lavfi.r128.M=)도 읽는다 (ffmpeg 8)', () => {
  const text = 'frame:0 pts:0\nlavfi.r128.M=-120.7\nframe:1\nlavfi.r128.M=-24.04\nlavfi.r128.M=-26.5\nSummary:\n    I:         -29.4 LUFS\n    Peak:      -13.5 dBFS\n';
  assert.deepEqual(parseEbur128(text), { momentaryMax: -24, integrated: -29.4, truePeak: -13.5 });
});
