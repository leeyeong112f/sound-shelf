function hasCompleteTechnicalMetadata(sound) {
  return Number(sound?.duration) > 0
    && Number(sound?.sampleRate) > 0
    && Number(sound?.channels) > 0
    && Boolean(String(sound?.codec || '').trim())
    && Number(sound?.metadataVersion) === 1;
}

function needsTechnicalProbe(sound, stat) {
  if (!sound || !stat) return true;
  return !sound.technicalCached
    || !hasCompleteTechnicalMetadata(sound)
    || Number(sound.modifiedAt) !== Number(stat.mtimeMs)
    || Number(sound.size) !== Number(stat.size);
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

function failedProbeMetadata(error, fileExists = true) {
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
    technicalError: mediaErrorMessage(error, { fileExists })
  };
}

module.exports = {
  failedProbeMetadata,
  hasCompleteTechnicalMetadata,
  mediaErrorMessage,
  needsTechnicalProbe
};
