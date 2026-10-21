// sounds.json 항목에 넣을 측정값: 들리는 구간, 최대 지점, 온셋, 맞출 지점 제안, 레벨.
// 계산은 순수 함수로 두고(테스트용), ffmpeg 호출은 main.js 가 한다.

const FRAME_SECONDS = 0.01;

// samples: 모노 Float32Array. 10ms RMS 포락선으로 본다.
function analyzeEnvelope(samples, sampleRate) {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const rms = [];
  for (let offset = 0; offset < samples.length; offset += frame) {
    const end = Math.min(samples.length, offset + frame);
    let sum = 0;
    for (let index = offset; index < end; index += 1) sum += samples[index] * samples[index];
    rms.push(Math.sqrt(sum / Math.max(1, end - offset)));
  }
  const duration = samples.length / sampleRate;
  const max = rms.reduce((best, value) => Math.max(best, value), 0);
  if (!max) return { duration: round(duration), audibleStart: 0, audibleEnd: 0, peakAt: 0, onsets: [], silent: true };
  const threshold = max * 0.01; // 최대보다 40dB 아래까지를 들리는 것으로 본다
  const first = rms.findIndex((value) => value > threshold);
  let last = rms.length - 1;
  while (last > 0 && rms[last] <= threshold) last -= 1;
  const peakIndex = rms.indexOf(max);
  // 온셋: 앞 50ms 평균보다 6dB 넘게 갑자기 커진 프레임. 서로 50ms 안에 겹치면 하나로 본다.
  const onsets = [];
  for (let index = 1; index < rms.length; index += 1) {
    if (rms[index] < max * 0.05) continue;
    const from = Math.max(0, index - 5);
    let previous = 0;
    for (let back = from; back < index; back += 1) previous += rms[back];
    previous /= Math.max(1, index - from);
    if (rms[index] > previous * 2 && rms[index] > rms[index - 1]) {
      const at = index * FRAME_SECONDS;
      if (!onsets.length || at - onsets[onsets.length - 1] > 0.05) onsets.push(round(at));
    }
  }
  return {
    duration: round(duration),
    audibleStart: round(first * FRAME_SECONDS),
    audibleEnd: round(Math.min(duration, (last + 1) * FRAME_SECONDS)),
    peakAt: round((peakIndex + 0.5) * FRAME_SECONDS),
    onsets: onsets.slice(0, 24),
    silent: false
  };
}

// 맞출 지점 제안. 짧은 단발음은 가장 큰 순간(타격·뽁의 '딱')에, 긴 소리는 처음 터지는 순간에 맞춘다.
function suggestSync(analysis) {
  if (!analysis || analysis.silent) return null;
  if (analysis.duration <= 2) return { at: analysis.peakAt, meets: 'instant' };
  return { at: analysis.onsets[0] ?? analysis.audibleStart, meets: 'action-start' };
}

// ffmpeg ebur128 출력에서 최대 순간 음량(M)·통합 음량·트루 피크를 읽는다.
// 순간 음량은 ametadata 출력(lavfi.r128.M=…)이나 framelog 줄(M: …) 어느 쪽이든 읽는다.
function parseEbur128(stderr) {
  const text = String(stderr || '');
  const momentary = [...text.matchAll(/(?:\bM:\s*|lavfi\.r128\.M=)(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1])).filter((value) => value > -70);
  const summary = text.slice(text.lastIndexOf('Summary:'));
  const integrated = Number((/I:\s*(-?\d+(?:\.\d+)?) LUFS/.exec(summary) || [])[1]);
  const peak = Number((/Peak:\s*(-?\d+(?:\.\d+)?) dBFS/.exec(summary) || [])[1]);
  return {
    momentaryMax: momentary.length ? round(Math.max(...momentary), 1) : null,
    integrated: Number.isFinite(integrated) && integrated > -70 ? round(integrated, 1) : null,
    truePeak: Number.isFinite(peak) ? round(peak, 1) : null
  };
}

// sounds.json 에 넣을 모양. level.lufs 는 '가장 큰 순간'(400ms) 음량 — 짧은 소리도 비교할 수 있게.
function measurementToEntryFields({ analysis, loudness }) {
  const fields = { duration: analysis.duration };
  const sync = suggestSync(analysis);
  const level = {};
  if (loudness?.momentaryMax !== null && loudness?.momentaryMax !== undefined) level.lufs = loudness.momentaryMax;
  if (loudness?.truePeak !== null && loudness?.truePeak !== undefined) level.true_peak_dbtp = loudness.truePeak;
  if (Object.keys(level).length) fields.level = { ...level, measure: 'momentary-max-400ms' };
  fields.timing = { audible_start: analysis.audibleStart, peak: analysis.peakAt, audible_end: analysis.audibleEnd };
  return { fields, sync };
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

module.exports = { analyzeEnvelope, measurementToEntryFields, parseEbur128, suggestSync };
