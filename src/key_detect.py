import json
import math
import subprocess
import sys

import numpy as np


SAMPLE_RATE = 22050
FFT_SIZE = 8192
HOP_SIZE = 2048
MAX_SECONDS = 180
MAX_FRAMES = 720

NOTE_NAMES = ["C", "C♯/D♭", "D", "E♭", "E", "F", "F♯/G♭", "G", "A♭", "A", "B♭", "B"]
KOREAN_NOTES = ["도", "도♯/레♭", "레", "미♭", "미", "파", "파♯/솔♭", "솔", "라♭", "라", "시♭", "시"]
MAJOR_CAMELOT = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
MINOR_CAMELOT = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=np.float64)
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=np.float64)


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
        raise RuntimeError(message)
    return np.frombuffer(completed.stdout, dtype="<f4").astype(np.float64, copy=False)


def frame_positions(sample_count):
    if sample_count <= FFT_SIZE:
        return np.array([0], dtype=np.int64)
    count = 1 + (sample_count - FFT_SIZE) // HOP_SIZE
    positions = np.arange(count, dtype=np.int64) * HOP_SIZE
    if len(positions) > MAX_FRAMES:
        positions = np.unique(np.linspace(0, positions[-1], MAX_FRAMES).astype(np.int64))
    return positions


def estimate_tuning(aggregate_magnitude, frequencies, valid_bins):
    spectrum = aggregate_magnitude[valid_bins]
    freqs = frequencies[valid_bins]
    if len(spectrum) < 3 or float(np.max(spectrum)) <= 0:
        return 0.0
    peaks = np.zeros_like(spectrum, dtype=bool)
    peaks[1:-1] = (spectrum[1:-1] > spectrum[:-2]) & (spectrum[1:-1] >= spectrum[2:])
    threshold = np.percentile(spectrum, 75)
    peaks &= spectrum >= threshold
    if not np.any(peaks):
        return 0.0
    midi = 69.0 + 12.0 * np.log2(freqs[peaks] / 440.0)
    fraction = ((midi + 0.5) % 1.0) - 0.5
    weights = np.sqrt(np.maximum(spectrum[peaks], 0.0))
    vector = np.sum(weights * np.exp(2j * np.pi * fraction))
    if abs(vector) < 1e-12:
        return 0.0
    return float(np.clip(np.angle(vector) / (2.0 * np.pi) * 100.0, -50.0, 50.0))


def chroma_from_power(power, midi_bins, valid_bins):
    selected = power[valid_bins]
    pitch = midi_bins[valid_bins] % 12.0
    lower = np.floor(pitch).astype(np.int64)
    fraction = pitch - lower
    weights = np.sqrt(np.maximum(selected, 0.0))
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
        return {"ok": True, "detected": False, "reason": "분석하기에 사운드가 너무 짧습니다.", "confidence": 0.0}
    samples = np.nan_to_num(samples, copy=False)
    samples -= np.mean(samples)
    peak = float(np.max(np.abs(samples)))
    if peak < 1e-5:
        return {"ok": True, "detected": False, "reason": "무음에 가까워 조성을 판단할 수 없습니다.", "confidence": 0.0}
    samples /= peak

    positions = frame_positions(len(samples))
    window = np.hanning(FFT_SIZE)
    frequencies = np.fft.rfftfreq(FFT_SIZE, 1.0 / SAMPLE_RATE)
    valid_bins = (frequencies >= 55.0) & (frequencies <= 5000.0)
    powers = []
    energies = []
    flatness_values = []
    aggregate = np.zeros(len(frequencies), dtype=np.float64)

    for position in positions:
        frame = samples[position:position + FFT_SIZE]
        if len(frame) < FFT_SIZE:
            frame = np.pad(frame, (0, FFT_SIZE - len(frame)))
        energy = float(np.sqrt(np.mean(frame * frame)))
        spectrum = np.abs(np.fft.rfft(frame * window))
        power = spectrum * spectrum
        band = power[valid_bins] + 1e-14
        flatness = float(np.exp(np.mean(np.log(band))) / np.mean(band))
        powers.append(power)
        energies.append(energy)
        flatness_values.append(flatness)
        aggregate += spectrum

    energies = np.asarray(energies)
    flatness_values = np.asarray(flatness_values)
    energy_limit = max(float(np.max(energies)) * 0.035, 1e-5)
    active = np.where(energies >= energy_limit)[0]
    if len(active) < 1:
        return {"ok": True, "detected": False, "reason": "유효한 음정 구간을 찾지 못했습니다.", "confidence": 0.0}

    tuning_cents = estimate_tuning(aggregate, frequencies, valid_bins)
    midi_bins = 69.0 + 12.0 * np.log2(np.maximum(frequencies, 1e-9) / 440.0) - tuning_cents / 100.0
    frame_chromas = []
    frame_weights = []
    for index in active:
        chroma = chroma_from_power(powers[index], midi_bins, valid_bins)
        harmonic_weight = float(np.clip(1.0 - flatness_values[index], 0.0, 1.0)) ** 2
        weight = math.sqrt(max(float(energies[index]), 0.0)) * harmonic_weight
        if np.linalg.norm(chroma) > 0 and weight > 1e-8:
            frame_chromas.append(chroma)
            frame_weights.append(weight)

    if not frame_chromas:
        return {"ok": True, "detected": False, "reason": "음정 성분보다 잡음 성분이 많아 조성을 판단할 수 없습니다.", "confidence": 0.0}

    frame_chromas = np.asarray(frame_chromas)
    frame_weights = np.asarray(frame_weights)
    global_chroma = np.average(frame_chromas, axis=0, weights=frame_weights)
    global_chroma /= max(float(np.linalg.norm(global_chroma)), 1e-12)

    candidates = []
    for tonic in range(12):
        for mode, profile, third in (("major", MAJOR_PROFILE, 4), ("minor", MINOR_PROFILE, 3)):
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
    mean_flatness = float(np.average(flatness_values[active], weights=np.maximum(energies[active], 1e-9)))
    harmonicity = float(np.clip(1.0 - mean_flatness, 0.0, 1.0))
    profile_quality = float(np.clip((best["correlation"] - 0.28) / 0.58, 0.0, 1.0))
    margin_quality = float(np.clip(margin / 0.14, 0.0, 1.0))
    harmonic_quality = float(np.clip((harmonicity - 0.28) / 0.62, 0.0, 1.0))
    confidence = float(np.clip(0.42 * profile_quality + 0.28 * margin_quality + 0.17 * stability + 0.13 * harmonic_quality, 0.0, 0.99))
    detected = bool(best["correlation"] >= 0.42 and confidence >= 0.40 and harmonicity >= 0.32)

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
            "alternatives": alternatives, "analysisVersion": 1,
        }

    result = describe_key(best["tonic"], best["mode"])
    result.update({
        "ok": True, "detected": True, "confidence": round(confidence, 3),
        "tuningCents": round(tuning_cents, 1), "alternatives": alternatives,
        "analysisVersion": 1,
    })
    return result


def main():
    try:
        file_path = sys.argv[1]
        ffmpeg_path = sys.argv[2]
        samples = decode_audio(file_path, ffmpeg_path)
        emit(analyze(samples))
    except Exception as error:
        emit({"ok": False, "message": str(error)})


if __name__ == "__main__":
    main()
