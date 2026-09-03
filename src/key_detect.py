import json
import math
import subprocess
import sys

try:
    import numpy as np
except Exception:  # numpy 미설치 등 임포트 실패
    np = None


ANALYSIS_VERSION = 2
SAMPLE_RATE = 22050
FFT_SIZE = 8192
HOP_SIZE = 2048
MAX_SECONDS = 180
MAX_FRAMES = 720
LOW_FREQUENCY = 55.0
HIGH_FREQUENCY = 5000.0
TILT_REFERENCE = 500.0
TILT_EXPONENT = 0.7
SMOOTH_RADIUS = 2
WHITEN_RADIUS = 50
MIN_CORRELATION = 0.42
MIN_CONFIDENCE = 0.40
MIN_HARMONICITY = 0.40

NOTE_NAMES = ["C", "C♯/D♭", "D", "E♭", "E", "F", "F♯/G♭", "G", "A♭", "A", "B♭", "B"]
KOREAN_NOTES = ["도", "도♯/레♭", "레", "미♭", "미", "파", "파♯/솔♭", "솔", "라♭", "라", "시♭", "시"]
MAJOR_CAMELOT = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
MINOR_CAMELOT = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]

MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))


def normalized_correlation(a, b):
    a = a - np.mean(a)
    b = b - np.mean(b)
    denominator = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / denominator) if denominator > 1e-12 else 0.0


def decode_audio(file_path, ffmpeg_path):
    command = [
        ffmpeg_path, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", file_path, "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-t", str(MAX_SECONDS), "-f", "f32le", "pipe:1"
    ]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=210, check=False)
    if completed.returncode != 0:
        message = completed.stderr.decode("utf-8", errors="replace").strip() or "오디오 디코딩에 실패했습니다."
        raise RuntimeError(message.splitlines()[-1][:300])
    return np.frombuffer(completed.stdout, dtype="<f4").astype(np.float64, copy=False)


def frame_positions(sample_count):
    if sample_count <= FFT_SIZE:
        return np.array([0], dtype=np.int64)
    count = 1 + (sample_count - FFT_SIZE) // HOP_SIZE
    positions = np.arange(count, dtype=np.int64) * HOP_SIZE
    if len(positions) > MAX_FRAMES:
        positions = np.unique(np.linspace(0, positions[-1], MAX_FRAMES).astype(np.int64))
    return positions


def moving_average(values, radius):
    if radius <= 0:
        return values
    kernel = np.ones(2 * radius + 1) / (2 * radius + 1)
    return np.convolve(np.pad(values, radius, mode="edge"), kernel, mode="valid")


def spectral_floor(power):
    """로그 스펙트럼 이동평균으로 대역별 잡음 바닥을 추정한다."""
    return np.exp(moving_average(np.log(np.maximum(power, 1e-14)), WHITEN_RADIUS))


def tonality(power):
    """잡음 바닥으로 백색화한 뒤의 스펙트럼 첨예도. 잡음은 0, 음정 성분은 1에 가깝다.

    주기도는 잡음이어도 빈마다 크게 출렁여 첨예해 보이므로 먼저 이웃 빈을 평활한다.
    평탄도는 잡음 바닥으로 가중해, 에너지가 없는 대역 밖 빈의 극단적인 비율이
    대역 제한 사운드의 판정을 뒤집지 않도록 한다.
    """
    smoothed = moving_average(power, SMOOTH_RADIUS)
    floor = spectral_floor(smoothed)
    ratio = smoothed / np.maximum(floor, 1e-14) + 1e-9
    total = float(np.sum(floor))
    if total <= 1e-30:
        return 0.0
    weights = floor / total
    arithmetic = float(np.sum(weights * ratio))
    if arithmetic <= 1e-12:
        return 0.0
    geometric = float(np.exp(np.sum(weights * np.log(ratio))))
    return float(np.clip(1.0 - geometric / arithmetic, 0.0, 1.0))


def estimate_tuning(aggregate_magnitude, frequencies, valid_bins):
    spectrum = aggregate_magnitude[valid_bins]
    freqs = frequencies[valid_bins]
    if len(spectrum) < 3 or float(np.max(spectrum)) <= 0:
        return 0.0
    peaks = np.zeros_like(spectrum, dtype=bool)
    peaks[1:-1] = (spectrum[1:-1] > spectrum[:-2]) & (spectrum[1:-1] >= spectrum[2:])
    peaks &= spectrum >= np.percentile(spectrum, 75)
    indices = np.where(peaks)[0]
    if len(indices) == 0:
        return 0.0

    # 로그 크기 3점 포물선 보간으로 피크의 실제 주파수를 구한다.
    left = np.log(np.maximum(spectrum[indices - 1], 1e-12))
    center = np.log(np.maximum(spectrum[indices], 1e-12))
    right = np.log(np.maximum(spectrum[indices + 1], 1e-12))
    curvature = left - 2.0 * center + right
    offset = np.where(np.abs(curvature) > 1e-12, 0.5 * (left - right) / np.where(np.abs(curvature) > 1e-12, curvature, 1.0), 0.0)
    bin_width = float(SAMPLE_RATE) / FFT_SIZE
    peak_frequencies = np.maximum(freqs[indices] + np.clip(offset, -0.5, 0.5) * bin_width, 1e-9)

    midi = 69.0 + 12.0 * np.log2(peak_frequencies / 440.0)
    fraction = ((midi + 0.5) % 1.0) - 0.5
    weights = np.sqrt(np.maximum(spectrum[indices], 0.0))
    estimate = 0.0
    for iteration in range(3):
        if iteration == 0:
            iteration_weights = weights
        else:
            # 추정값에서 멀리 떨어진 피크(배음 왜곡, 잡음)의 영향을 줄인다.
            distance = ((fraction - estimate / 100.0 + 0.5) % 1.0) - 0.5
            iteration_weights = weights * np.exp(-((distance * 100.0 / 15.0) ** 2))
        vector = np.sum(iteration_weights * np.exp(2j * np.pi * fraction))
        if abs(vector) < 1e-12:
            break
        estimate = float(np.angle(vector) / (2.0 * np.pi) * 100.0)
    return float(np.clip(estimate, -50.0, 50.0))


def chroma_from_power(power, midi_bins, valid_bins, tilt):
    selected = power[valid_bins]
    pitch = midi_bins[valid_bins] % 12.0
    lower = np.floor(pitch).astype(np.int64)
    fraction = pitch - lower
    weights = np.sqrt(np.maximum(selected, 0.0)) * tilt
    chroma = np.bincount(lower, weights=weights * (1.0 - fraction), minlength=12).astype(np.float64)
    chroma += np.bincount((lower + 1) % 12, weights=weights * fraction, minlength=12)
    norm = np.linalg.norm(chroma)
    return chroma / norm if norm > 1e-12 else chroma


def describe_key(tonic, mode):
    mode_text = "Major" if mode == "major" else "Minor"
    korean_mode = "장조" if mode == "major" else "단조"
    camelot = MAJOR_CAMELOT[tonic] if mode == "major" else MINOR_CAMELOT[tonic]
    return {
        "key": NOTE_NAMES[tonic],
        "mode": mode,
        "display": f"{NOTE_NAMES[tonic]} {mode_text}",
        "korean": f"{KOREAN_NOTES[tonic]} {korean_mode}",
        "camelot": camelot,
    }


def analyze(samples):
    if len(samples) < int(SAMPLE_RATE * 0.18):
        return {"ok": True, "detected": False, "reason": "분석하기에 사운드가 너무 짧습니다.", "confidence": 0.0, "analysisVersion": ANALYSIS_VERSION}
    samples = np.nan_to_num(samples, copy=False)
    samples -= np.mean(samples)
    peak = float(np.max(np.abs(samples)))
    if peak < 1e-5:
        return {"ok": True, "detected": False, "reason": "무음에 가까워 조성을 판단할 수 없습니다.", "confidence": 0.0, "analysisVersion": ANALYSIS_VERSION}
    samples /= peak

    positions = frame_positions(len(samples))
    window = np.hanning(FFT_SIZE)
    frequencies = np.fft.rfftfreq(FFT_SIZE, 1.0 / SAMPLE_RATE)
    valid_bins = (frequencies >= LOW_FREQUENCY) & (frequencies <= HIGH_FREQUENCY)
    # 고역 배음이 3도·5도 음을 부풀리지 않도록 기준 주파수 위쪽을 완만하게 감쇠한다.
    tilt = np.minimum(1.0, TILT_REFERENCE / np.maximum(frequencies[valid_bins], 1e-9)) ** TILT_EXPONENT
    powers = []
    energies = []
    tonality_values = []
    aggregate = np.zeros(len(frequencies), dtype=np.float64)

    for position in positions:
        frame = samples[position:position + FFT_SIZE]
        if len(frame) < FFT_SIZE:
            frame = np.pad(frame, (0, FFT_SIZE - len(frame)))
        energy = float(np.sqrt(np.mean(frame * frame)))
        spectrum = np.abs(np.fft.rfft(frame * window))
        power = spectrum * spectrum
        powers.append(power)
        energies.append(energy)
        tonality_values.append(tonality(power[valid_bins]))
        aggregate += spectrum

    energies = np.asarray(energies)
    tonality_values = np.asarray(tonality_values)
    energy_limit = max(float(np.max(energies)) * 0.035, 1e-5)
    active = np.where(energies >= energy_limit)[0]
    if len(active) < 1:
        return {"ok": True, "detected": False, "reason": "유효한 음정 구간을 찾지 못했습니다.", "confidence": 0.0, "analysisVersion": ANALYSIS_VERSION}

    tuning_cents = estimate_tuning(aggregate, frequencies, valid_bins)
    midi_bins = 69.0 + 12.0 * np.log2(np.maximum(frequencies, 1e-9) / 440.0) - tuning_cents / 100.0
    frame_chromas = []
    frame_weights = []
    for index in active:
        chroma = chroma_from_power(powers[index], midi_bins, valid_bins, tilt)
        weight = math.sqrt(max(float(energies[index]), 0.0)) * (tonality_values[index] ** 2)
        if np.linalg.norm(chroma) > 0 and weight > 1e-8:
            frame_chromas.append(chroma)
            frame_weights.append(weight)

    if not frame_chromas:
        return {"ok": True, "detected": False, "reason": "음정 성분보다 잡음 성분이 많아 조성을 판단할 수 없습니다.", "confidence": 0.0, "analysisVersion": ANALYSIS_VERSION}

    frame_chromas = np.asarray(frame_chromas)
    frame_weights = np.asarray(frame_weights)
    global_chroma = np.average(frame_chromas, axis=0, weights=frame_weights)
    global_chroma /= max(float(np.linalg.norm(global_chroma)), 1e-12)

    major_profile = np.array(MAJOR_PROFILE, dtype=np.float64)
    minor_profile = np.array(MINOR_PROFILE, dtype=np.float64)
    candidates = []
    for tonic in range(12):
        for mode, profile, third in (("major", major_profile, 4), ("minor", minor_profile, 3)):
            correlation = normalized_correlation(global_chroma, np.roll(profile, tonic))
            triad_share = float(global_chroma[tonic] + global_chroma[(tonic + third) % 12] + global_chroma[(tonic + 7) % 12])
            score = correlation + 0.18 * triad_share
            candidates.append({"tonic": tonic, "mode": mode, "correlation": correlation, "score": score})
    candidates.sort(key=lambda item: item["score"], reverse=True)
    best = candidates[0]
    runner_up = candidates[1]
    margin = max(0.0, best["score"] - runner_up["score"])

    similarities = np.clip(frame_chromas @ global_chroma, 0.0, 1.0)
    stability = float(np.average(similarities, weights=frame_weights))
    harmonicity = float(np.average(tonality_values[active], weights=np.maximum(energies[active], 1e-9)))

    # 3음이 없으면 근음은 맞아도 장·단조 판정은 배음의 우연에 기댄 것이므로 신뢰도를 낮춘다.
    third_interval = 4 if best["mode"] == "major" else 3
    anchor = max(float(global_chroma[best["tonic"]]), float(global_chroma[(best["tonic"] + 7) % 12]), 1e-12)
    third_support = float(np.clip(float(global_chroma[(best["tonic"] + third_interval) % 12]) / anchor, 0.0, 1.0))
    mode_quality = float(np.clip(third_support / 0.35, 0.0, 1.0))

    profile_quality = float(np.clip((best["correlation"] - 0.28) / 0.58, 0.0, 1.0))
    margin_quality = float(np.clip(margin / 0.14, 0.0, 1.0))
    harmonic_quality = float(np.clip((harmonicity - 0.32) / 0.50, 0.0, 1.0))
    confidence = float(np.clip(0.42 * profile_quality + 0.28 * margin_quality + 0.17 * stability + 0.13 * harmonic_quality, 0.0, 0.99))
    confidence = float(np.clip(confidence * (0.55 + 0.45 * mode_quality), 0.0, 0.99))
    detected = bool(
        best["correlation"] >= MIN_CORRELATION
        and confidence >= MIN_CONFIDENCE
        and harmonicity >= MIN_HARMONICITY
    )

    alternatives = []
    for candidate in candidates[:3]:
        description = describe_key(candidate["tonic"], candidate["mode"])
        alternatives.append({
            "display": description["display"],
            "korean": description["korean"],
            "camelot": description["camelot"],
            "score": round(float(candidate["score"]), 4),
        })

    if not detected:
        reason = "음정 중심이 약하거나 후보 조성이 비슷해 정확한 Key를 확정하기 어렵습니다."
        return {
            "ok": True, "detected": False, "reason": reason,
            "confidence": round(confidence, 3), "tuningCents": round(tuning_cents, 1),
            "alternatives": alternatives, "analysisVersion": ANALYSIS_VERSION,
        }

    result = describe_key(best["tonic"], best["mode"])
    result.update({
        "ok": True, "detected": True, "confidence": round(confidence, 3),
        "tuningCents": round(tuning_cents, 1), "alternatives": alternatives,
        "thirdSupport": round(third_support, 3),
        "analysisVersion": ANALYSIS_VERSION,
    })
    return result


def main():
    try:
        if np is None:
            raise RuntimeError("조성 분석에는 Python numpy 패키지가 필요합니다. 터미널에서 'pip3 install numpy'를 실행해 주세요.")
        file_path = sys.argv[1]
        ffmpeg_path = sys.argv[2]
        samples = decode_audio(file_path, ffmpeg_path)
        emit(analyze(samples))
    except Exception as error:
        emit({"ok": False, "message": str(error) or error.__class__.__name__})


if __name__ == "__main__":
    main()
