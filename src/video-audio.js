const path = require('node:path');

// 영상 파일(mp4·mov 등)을 라이브러리에 넣으면 오디오 트랙만 꺼내 별도 파일로 등록한다.
// 원본 영상은 옮기지도 지우지도 않는다. 사용자가 영상 자체를 다른 데 쓸 수 있다.
//
// 가능하면 재인코딩 없이 스트림을 그대로 복사한다(음질 손실 없음, 빠름). 복사할 수 있는
// 컨테이너가 없는 코덱만 AAC 로 인코딩한다.

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);

// 복사만으로 담을 수 있는 코덱과 그 컨테이너.
const COPY_TARGETS = new Map([
  ['aac', '.m4a'],
  ['alac', '.m4a'],
  ['mp3', '.mp3'],
  ['flac', '.flac'],
  ['opus', '.opus'],
  ['pcm_s16le', '.wav'],
  ['pcm_s24le', '.wav'],
  ['pcm_s32le', '.wav'],
  ['pcm_f32le', '.wav']
]);

function isVideoFile(filePath) {
  return VIDEO_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * ffprobe 의 streams 배열을 보고 어떻게 꺼낼지 정한다.
 * @returns {{ok: true, streamIndex: number, extension: string, codecArgs: string[]} | {ok: false, reason: 'no-audio'}}
 */
function planAudioExtraction(streams) {
  const audio = (streams || []).find((stream) => stream?.codec_type === 'audio');
  if (!audio) return { ok: false, reason: 'no-audio' };
  const codec = String(audio.codec_name || '').toLowerCase();
  const streamIndex = Number.isInteger(audio.index) ? audio.index : 0;
  if (COPY_TARGETS.has(codec)) {
    return { ok: true, streamIndex, extension: COPY_TARGETS.get(codec), codecArgs: ['-c:a', 'copy'] };
  }
  // 빅엔디안 PCM(mov 에서 흔함)은 WAV 에 그대로 못 담는다. 24비트로 바꿔 손실 없이 옮긴다.
  if (codec.startsWith('pcm_')) {
    return { ok: true, streamIndex, extension: '.wav', codecArgs: ['-c:a', 'pcm_s24le'] };
  }
  return { ok: true, streamIndex, extension: '.m4a', codecArgs: ['-c:a', 'aac', '-b:a', '256k'] };
}

function audioFileNameFor(videoPath, extension) {
  return `${path.basename(String(videoPath), path.extname(String(videoPath)))}${extension}`;
}

const SKIP_REASONS = {
  'no-audio': '오디오 트랙이 없음',
  unsupported: '지원하지 않는 형식',
  failed: '오디오 추출 실패'
};

// 가져오기 결과를 토스트 한 줄로 만든다. 알릴 것이 없으면 빈 문자열이다.
function describeImportReport(report) {
  if (!report) return '';
  const parts = [];
  if (report.extracted?.length) parts.push(`영상 ${report.extracted.length}개에서 오디오를 꺼내 추가했습니다 (원본 영상은 그대로 둠)`);
  const skipped = report.skipped || [];
  if (skipped.length) {
    const shown = skipped.slice(0, 3).map((item) => `${item.name}: ${SKIP_REASONS[item.reason] || item.reason}`);
    const more = skipped.length > 3 ? ` 외 ${skipped.length - 3}개` : '';
    parts.push(`${skipped.length}개 건너뜀 (${shown.join(', ')}${more})`);
  }
  return parts.join(' · ');
}

module.exports = { VIDEO_EXTENSIONS, audioFileNameFor, describeImportReport, isVideoFile, planAudioExtraction };
