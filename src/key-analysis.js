(function exposeKeyAnalysis(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KeyAnalysis = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  // src/key_detect.py의 ANALYSIS_VERSION과 같은 값을 유지한다.
  // 검출 알고리즘을 고칠 때 함께 올리면 볼트에 저장된 이전 결과가 자동으로 다시 분석된다.
  const KEY_ANALYSIS_VERSION = 2;
  const MAX_MESSAGE_LENGTH = 200;
  const NUMPY_GUIDE = "조성 분석에는 Python numpy 패키지가 필요합니다. 터미널에서 'pip3 install numpy'를 실행해 주세요.";

  function isCurrentKeyAnalysis(analysis, sound) {
    if (!analysis || !sound) return false;
    if (Number(analysis.sourceModifiedAt) !== Number(sound.modifiedAt)) return false;
    return Number(analysis.analysisVersion) === KEY_ANALYSIS_VERSION;
  }

  // 분석 스크립트는 python -c로 전달하므로 실패하면 오류에 스크립트 전문이 그대로 섞여 들어온다.
  // 사용자에게는 원인 한 줄만 보여준다.
  function keyAnalysisErrorMessage(error) {
    const raw = String((error && (error.stderr || error.message)) || error || '').trim();
    if (/No module named ['"]?numpy/.test(raw)) return NUMPY_GUIDE;
    if (/\bENOENT\b/.test(raw)) return 'python3 또는 ffmpeg를 찾을 수 없습니다. 설치 후 다시 시도해 주세요.';
    if (/\bETIMEDOUT\b|timed? ?out/i.test(raw)) return '조성 분석이 제한 시간을 넘겼습니다. 더 짧은 사운드로 시도해 주세요.';
    const meaningful = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line
        && !line.startsWith('Command failed:')
        && !line.startsWith('Traceback')
        && !line.startsWith('File "')
        && !line.startsWith('^'));
    const message = meaningful.length ? meaningful[meaningful.length - 1] : '조성 분석에 실패했습니다.';
    return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
  }

  return { KEY_ANALYSIS_VERSION, isCurrentKeyAnalysis, keyAnalysisErrorMessage };
}));
