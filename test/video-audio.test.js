const test = require('node:test');
const assert = require('node:assert/strict');
const { audioFileNameFor, describeImportReport, isVideoFile, planAudioExtraction } = require('../src/video-audio');

test('영상 확장자를 대소문자 구분 없이 알아본다', () => {
  assert.equal(isVideoFile('/Downloads/Cartoon Sting1.mp4'), true);
  assert.equal(isVideoFile('/a/b.MOV'), true);
  assert.equal(isVideoFile('/a/b.wav'), false);
  assert.equal(isVideoFile(''), false);
});

// 2026-10-11 Cartoon Sting1.mp4: h264 영상 + aac 오디오.
test('AAC 오디오는 재인코딩 없이 m4a 로 복사한다', () => {
  const plan = planAudioExtraction([
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' }
  ]);
  assert.deepEqual(plan, { ok: true, streamIndex: 1, extension: '.m4a', codecArgs: ['-c:a', 'copy'] });
});

test('코덱마다 그대로 담을 수 있는 컨테이너를 고른다', () => {
  const ext = (codec) => planAudioExtraction([{ index: 0, codec_type: 'audio', codec_name: codec }]).extension;
  assert.equal(ext('mp3'), '.mp3');
  assert.equal(ext('pcm_s24le'), '.wav');
  assert.equal(ext('flac'), '.flac');
  assert.equal(ext('opus'), '.opus');
});

test('빅엔디안 PCM 은 24비트 WAV 로 바꾼다', () => {
  const plan = planAudioExtraction([{ index: 2, codec_type: 'audio', codec_name: 'pcm_s16be' }]);
  assert.deepEqual(plan, { ok: true, streamIndex: 2, extension: '.wav', codecArgs: ['-c:a', 'pcm_s24le'] });
});

test('복사할 컨테이너가 없는 코덱은 AAC 로 인코딩한다', () => {
  const plan = planAudioExtraction([{ index: 1, codec_type: 'audio', codec_name: 'ac3' }]);
  assert.equal(plan.extension, '.m4a');
  assert.deepEqual(plan.codecArgs, ['-c:a', 'aac', '-b:a', '256k']);
});

test('오디오 트랙이 없으면 no-audio 다', () => {
  assert.deepEqual(planAudioExtraction([{ index: 0, codec_type: 'video', codec_name: 'h264' }]), { ok: false, reason: 'no-audio' });
  assert.deepEqual(planAudioExtraction([]), { ok: false, reason: 'no-audio' });
});

test('오디오 파일 이름은 영상 이름에 새 확장자를 붙인다', () => {
  assert.equal(audioFileNameFor('/Downloads/Cartoon Sting1.mp4', '.m4a'), 'Cartoon Sting1.m4a');
  assert.equal(audioFileNameFor('/a/clip.final.mov', '.wav'), 'clip.final.wav');
});

test('가져오기 결과 문구', () => {
  assert.equal(describeImportReport(null), '');
  assert.equal(describeImportReport({ extracted: [], skipped: [] }), '');
  assert.equal(describeImportReport({ extracted: ['a'], skipped: [] }), '영상 1개에서 오디오를 꺼내 추가했습니다 (원본 영상은 그대로 둠)');
  assert.equal(
    describeImportReport({ extracted: [], skipped: [{ name: 'x.mp4', reason: 'no-audio' }, { name: 'y.txt', reason: 'unsupported' }] }),
    '2개 건너뜀 (x.mp4: 오디오 트랙이 없음, y.txt: 지원하지 않는 형식)'
  );
  const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, reason: 'unsupported' }));
  assert.match(describeImportReport({ skipped: many }), /5개 건너뜀 .* 외 2개\)$/);
});
