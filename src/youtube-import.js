(function exposeYouTubeImport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YouTubeImport = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const YOUTUBE_HOSTS = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'
  ]);
  const MAX_MESSAGE_LENGTH = 200;
  const YT_DLP_GUIDE = 'yt-dlp를 찾을 수 없습니다. 터미널에서 \'brew install yt-dlp\'를 실행한 뒤 다시 붙여 넣어 주세요.';
  const FFMPEG_GUIDE = 'ffmpeg를 찾을 수 없습니다. 터미널에서 \'brew install ffmpeg\'를 실행한 뒤 다시 시도해 주세요.';

  // 붙여 넣은 문장 안에서 http(s) 주소만 골라낸다. 앞뒤의 괄호·따옴표·마침표는 주소가 아니다.
  function candidateUrls(text) {
    const matches = String(text || '').match(/https?:\/\/[^\s<>"'()\[\]]+/gi) || [];
    return matches.map((match) => match.replace(/[.,;:!?]+$/g, ''));
  }

  // 영상·뮤직·쇼츠·짧은 주소를 모두 11자리 영상 ID 하나로 환원한다.
  function youtubeVideoId(url) {
    let parsed;
    try {
      parsed = new URL(String(url || '').trim());
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    let id = null;
    if (host.endsWith('youtu.be')) id = segments[0] || null;
    else if (segments[0] === 'watch') id = parsed.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(segments[0])) id = segments[1] || null;
    else if (segments.length === 0 && parsed.searchParams.get('v')) id = parsed.searchParams.get('v');
    return id && VIDEO_ID.test(id) ? id : null;
  }

  function isYouTubeUrl(url) {
    return youtubeVideoId(url) !== null;
  }

  // 재생목록·시작 시각 같은 부가 파라미터를 버리고 항상 같은 형태의 주소로 맞춘다.
  // yt-dlp에 넘길 때도, 같은 영상을 두 번 받지 않도록 비교할 때도 이 값을 쓴다.
  function canonicalYouTubeUrl(url) {
    const id = youtubeVideoId(url);
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
  }

  // 붙여 넣은 텍스트에서 유튜브 영상 주소만 순서대로, 중복 없이 뽑는다.
  function extractYouTubeUrls(text) {
    const seen = new Set();
    const urls = [];
    for (const candidate of candidateUrls(text)) {
      const canonical = canonicalYouTubeUrl(candidate);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      urls.push(canonical);
    }
    return urls;
  }

  function isPlaylistOnlyUrl(url) {
    try {
      const parsed = new URL(String(url || '').trim());
      return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())
        && Boolean(parsed.searchParams.get('list'))
        && youtubeVideoId(url) === null;
    } catch {
      return false;
    }
  }

  // 영상 제목을 macOS 파일 이름으로 쓸 수 있게 다듬는다.
  function safeFileStem(title, fallback = 'youtube-audio') {
    const cleaned = String(title || '')
      .normalize('NFC')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .replace(/^\.+/, '');
    const stem = cleaned || fallback;
    return stem.length > 120 ? stem.slice(0, 120).trim() : stem;
  }

  // yt-dlp --newline 출력에서 진행률(0~100)을 읽는다. 진행률 줄이 아니면 null.
  function parseDownloadProgress(line) {
    const match = /\[download\]\s+([\d.]+)%/.exec(String(line || ''));
    if (!match) return null;
    const percent = Number(match[1]);
    return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  }

  // yt-dlp·ffmpeg 오류는 스택과 경고가 길게 섞여 들어오므로 사용자에게는 원인 한 줄만 보여준다.
  function youtubeImportErrorMessage(error) {
    const raw = String((error && (error.stderr || error.message)) || error || '').trim();
    if (/\bENOENT\b/.test(raw) && /ffmpeg|ffprobe/i.test(raw)) return FFMPEG_GUIDE;
    if (/\bENOENT\b/.test(raw)) return YT_DLP_GUIDE;
    if (/ffmpeg not found|ffprobe and ffmpeg not found|Postprocessing.*ffmpeg/i.test(raw)) return FFMPEG_GUIDE;
    if (/\bETIMEDOUT\b|timed? ?out/i.test(raw)) return '다운로드가 제한 시간을 넘겼습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.';
    if (/Sign in to confirm|not a bot|confirm you.re not a bot/i.test(raw)) return 'YouTube가 자동 다운로드를 차단했습니다. 잠시 후 다시 시도하거나 yt-dlp를 최신 버전으로 업데이트해 주세요.';
    if (/Private video|This video is private/i.test(raw)) return '비공개 영상은 가져올 수 없습니다.';
    if (/Video unavailable|This video is not available|has been removed/i.test(raw)) return '재생할 수 없는 영상입니다. 주소를 다시 확인해 주세요.';
    if (/age[- ]restricted|Sign in to confirm your age/i.test(raw)) return '연령 제한 영상은 로그인 없이 가져올 수 없습니다.';
    if (/copyright|blocked it in your country|not available in your country/i.test(raw)) return '이 지역에서는 재생이 차단된 영상입니다.';
    if (/Unsupported URL|is not a valid URL/i.test(raw)) return '지원하지 않는 주소입니다. 유튜브 영상 또는 뮤직 주소를 붙여 넣어 주세요.';
    if (/Requested format is not available|No video formats found/i.test(raw)) return '내려받을 수 있는 오디오 형식이 없습니다. yt-dlp를 최신 버전으로 업데이트해 주세요.';
    if (/getaddrinfo|Network is unreachable|Temporary failure in name resolution|Unable to download webpage|Failed to resolve|Connection refused|Connection reset/i.test(raw)) {
      return '유튜브에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.';
    }
    const meaningful = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line
        && !line.startsWith('Command failed:')
        && !line.startsWith('Traceback')
        && !line.startsWith('File "')
        && !line.startsWith('WARNING:')
        && !line.startsWith('[download]')
        && !line.startsWith('^'));
    const errorLine = meaningful.find((line) => line.startsWith('ERROR:')) || meaningful[meaningful.length - 1];
    const message = (errorLine || '유튜브 음원을 가져오지 못했습니다.').replace(/^ERROR:\s*/, '');
    return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
  }

  return {
    YT_DLP_GUIDE,
    FFMPEG_GUIDE,
    canonicalYouTubeUrl,
    extractYouTubeUrls,
    isPlaylistOnlyUrl,
    isYouTubeUrl,
    parseDownloadProgress,
    safeFileStem,
    youtubeImportErrorMessage,
    youtubeVideoId
  };
}));
