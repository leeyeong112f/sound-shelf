function hasCompleteTechnicalMetadata(sound) {
  return Number(sound?.duration) > 0
    && Number(sound?.sampleRate) > 0
    && Number(sound?.channels) > 0
    && Boolean(String(sound?.codec || '').trim())
    && Number(sound?.metadataVersion) === 1;
}

// 실패한 프로브를 매번 다시 시도하지 않기 위한 대기 시간. Google Drive 에 아직 내려오지
// 않은 파일은 몇 번을 시도해도 같은 결과라, 재스캔마다 파일당 ffprobe 3회 + 1초 대기를
// 반복하면 스캔이 끝나지 않는다. 파일 자체가 바뀌면 아래에서 즉시 다시 시도한다.
const PROBE_BACKOFF_MS = [
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000
];

function probeBackoffMs(attempts) {
  const index = Math.max(0, Math.min(PROBE_BACKOFF_MS.length - 1, Number(attempts || 1) - 1));
  return PROBE_BACKOFF_MS[index];
}

function needsTechnicalProbe(sound, stat, now = Date.now()) {
  if (!sound || !stat) return true;
  // 파일이 실제로 달라졌으면 백오프와 무관하게 다시 읽는다.
  if (Number(sound.modifiedAt) !== Number(stat.mtimeMs)) return true;
  if (Number(sound.size) !== Number(stat.size)) return true;
  if (sound.technicalCached && hasCompleteTechnicalMetadata(sound)) return false;

  const failedAt = Number(sound.technicalProbeFailedAt || 0);
  if (!failedAt) return true;
  return now - failedAt >= probeBackoffMs(sound.technicalProbeAttempts);
}

function mediaErrorMessage(error, { fileExists = true, waveform = false } = {}) {
  if (!fileExists) return '원본 파일을 찾을 수 없습니다.';
  const message = String(error?.message || error || '').toLocaleLowerCase('en');
  if (error?.code === 'ENOENT') return '오디오 분석 도구를 찾을 수 없습니다. 앱을 다시 설치하거나 ffmpeg 설치 상태를 확인해 주세요.';
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || message.includes('permission denied')) {
    return '파일을 읽을 권한이 없습니다. macOS 파일 접근 권한을 확인해 주세요.';
  }
  if (error?.killed || error?.code === 'ETIMEDOUT' || message.includes('timed out')) {
    return waveform
      ? '파형 분석 시간이 초과되었습니다. 파일이 로컬에 내려받아졌는지 확인해 주세요.'
      : '오디오 정보 분석 시간이 초과되었습니다. 파일 동기화 상태를 확인해 주세요.';
  }
  if (message.includes('invalid data') || message.includes('could not find codec')
    || message.includes('does not contain any') || message.includes('matches no streams')) {
    return '오디오 데이터를 읽을 수 없습니다. 파일이 손상됐거나 지원되지 않는 형식일 수 있습니다.';
  }
  return waveform
    ? '파형을 만들 수 없습니다. Google Drive 다운로드 상태를 확인한 뒤 다시 시도해 주세요.'
    : '오디오 정보를 읽지 못했습니다. Google Drive 다운로드 상태를 확인해 주세요.';
}

function failedProbeMetadata(error, fileExists = true, previous = null, now = Date.now()) {
  // 같은 파일에 대한 연속 실패 횟수를 들고 있어야 재시도 간격을 늘릴 수 있다.
  const attempts = Number(previous?.technicalProbeAttempts || 0) + 1;
  return {
    duration: 0,
    sampleRate: 0,
    channels: 0,
    codec: '',
    bitRate: 0,
    embeddedMetadata: {},
    embeddedTags: [],
    metadataVersion: 0,
    technicalCached: false,
    technicalError: mediaErrorMessage(error, { fileExists }),
    technicalProbeFailedAt: now,
    technicalProbeAttempts: attempts
  };
}

module.exports = {
  PROBE_BACKOFF_MS,
  failedProbeMetadata,
  hasCompleteTechnicalMetadata,
  mediaErrorMessage,
  needsTechnicalProbe,
  probeBackoffMs
};
