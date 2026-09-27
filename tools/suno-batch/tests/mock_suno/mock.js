// 모의 Suno. 진짜 Suno가 아니라, 우리 스크립트가 화면을 제대로 몰 수 있는지
// 확인하려고 최소한의 모양만 흉내 낸다. localStorage로 만든 곡을 기억한다.
const STORE = 'mock-suno-clips';

function loadClips() {
  try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; }
}
function saveClips(clips) {
  localStorage.setItem(STORE, JSON.stringify(clips));
}

// 44바이트 헤더 + 무음. 진짜 WAV라 ffprobe로 읽을 수 있다.
function silentWav(seconds = 1, rate = 8000) {
  const frames = seconds * rate;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, frames * 2, true);
  return new Blob([buffer], { type: 'audio/wav' });
}

function triggerDownload(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 1000);
}
