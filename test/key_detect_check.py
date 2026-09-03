"""src/key_detect.py 회귀 검사.

ffmpeg 디코딩을 거치지 않고 analyze()에 합성 신호를 직접 넣어 검사한 뒤
결과를 JSON 한 줄로 내보낸다. test/key-detect.test.js가 이 출력을 읽는다.
"""

import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True  # 검사 때문에 src/__pycache__를 남기지 않는다

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "key_detect.py")

try:
    import numpy as np
except Exception as error:
    print(json.dumps({"available": False, "reason": str(error)}, ensure_ascii=False))
    sys.exit(0)


def load_detector():
    spec = importlib.util.spec_from_file_location("key_detect", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


kd = load_detector()
SR = kd.SAMPLE_RATE
NAMES = kd.NOTE_NAMES
CASES = []


def record(name, ok, detail=""):
    CASES.append({"name": name, "ok": bool(ok), "detail": str(detail)})


def midi_hz(midi, cents=0.0):
    return 440.0 * 2 ** ((midi - 69) / 12.0) * 2 ** (cents / 1200.0)


def tone(rng, frequency, seconds, harmonics=8, rolloff=1.0):
    times = np.arange(int(seconds * SR)) / SR
    out = np.zeros_like(times)
    for partial in range(1, harmonics + 1):
        if frequency * partial > 10500:
            break
        out += (1.0 / partial ** rolloff) * np.sin(2 * np.pi * frequency * partial * times + rng.uniform(0, 2 * np.pi))
    return out


def chord(rng, midis, seconds, cents=0.0, **kwargs):
    return sum(tone(rng, midi_hz(m, cents), seconds, **kwargs) for m in midis)


def progression(rng, tonic, mode, bass=False, cents=0.0, **kwargs):
    degrees = [(0, 4, 7), (5, 9, 12), (7, 11, 14), (0, 4, 7)] if mode == "major" else [(0, 3, 7), (5, 8, 12), (7, 11, 14), (0, 3, 7)]
    parts = []
    for degree in degrees:
        midis = [60 + tonic + step for step in degree]
        if bass:
            midis.append(36 + tonic + degree[0])
        parts.append(chord(rng, midis, 1.0, cents=cents, **kwargs))
    return np.concatenate(parts)


def shaped_noise(rng, seconds, exponent, low=None, high=None):
    count = int(seconds * SR)
    spectrum = np.fft.rfft(rng.standard_normal(count))
    frequencies = np.fft.rfftfreq(count, 1.0 / SR)
    shape = np.ones_like(frequencies)
    shape[1:] = frequencies[1:] ** (-exponent / 2.0)
    shape[0] = 0.0
    if low:
        shape *= 1.0 / np.sqrt(1.0 + (np.maximum(frequencies, 1e-9) / low) ** -8)
    if high:
        shape *= 1.0 / np.sqrt(1.0 + (np.maximum(frequencies, 1e-9) / high) ** 8)
    signal = np.fft.irfft(spectrum * shape, count)
    return signal / max(float(np.max(np.abs(signal))), 1e-9)


def run(signal):
    return kd.analyze(np.asarray(signal, dtype=np.float64).copy())


def display(result):
    return result.get("display") if result.get("detected") else "미검출"


# 1. 24개 장·단조를 모두 맞힌다.
wrong = []
for mode in ("major", "minor"):
    for tonic in range(12):
        expected = f"{NAMES[tonic]} {'Major' if mode == 'major' else 'Minor'}"
        for bass in (False, True):
            got = display(run(progression(np.random.default_rng(3 + tonic), tonic, mode, bass=bass)))
            if got != expected:
                wrong.append(f"{expected}{'+bass' if bass else ''}→{got}")
record("24개 장·단조 진행을 베이스 유무와 무관하게 검출한다", not wrong, ", ".join(wrong[:5]))

# 2. 밝은 배음의 장3화음을 3도 위 단조로 오검출하지 않는다.
wrong = []
for tonic in range(12):
    for seed in range(2):
        expected = f"{NAMES[tonic]} Major"
        got = display(run(chord(np.random.default_rng(100 * tonic + seed), [60 + tonic, 64 + tonic, 67 + tonic], 2.0, harmonics=12, rolloff=0.7)))
        if got != expected:
            wrong.append(f"{expected}→{got}")
record("배음이 밝은 장3화음을 iii단조로 오검출하지 않는다", not wrong, ", ".join(wrong[:5]))

# 3. 잡음 성분이 강해도 조성을 유지한다.
signal = progression(np.random.default_rng(5), 0, "major")
signal = signal / float(np.max(np.abs(signal)))
wrong = []
for snr_db in (10, 5, 0):
    noise = np.random.default_rng(9).standard_normal(len(signal))
    noise *= np.sqrt(np.mean(signal ** 2)) / np.sqrt(np.mean(noise ** 2)) / 10 ** (snr_db / 20.0)
    got = display(run(signal + noise))
    if got != "C Major":
        wrong.append(f"{snr_db}dB→{got}")
record("SNR 10/5/0 dB 잡음이 섞여도 C Major를 유지한다", not wrong, ", ".join(wrong))

# 4. 잡음만 있는 사운드에서 조성을 확정하지 않는다.
detected = []
for label, kwargs in (("백색", {"exponent": 0}), ("핑크", {"exponent": 1}), ("브라운", {"exponent": 2}),
                      ("대역 200-800Hz", {"exponent": 0, "low": 200, "high": 800}),
                      ("저역 럼블", {"exponent": 2, "high": 150}), ("고역 히스", {"exponent": 0, "low": 2000})):
    for seed in range(4):
        result = run(shaped_noise(np.random.default_rng(seed), 3.0, **kwargs))
        if result.get("detected"):
            detected.append(f"{label}#{seed}→{result['display']}")
record("잡음 사운드에서는 조성을 확정하지 않는다", not detected, ", ".join(detected[:5]))

# 5. 튜닝 편차를 5 cent 이내로 추정한다.
errors = []
for midi, label in ((45, "A2"), (57, "A3"), (69, "A4")):
    for cents in (-40, -20, 0, 20, 40):
        for harmonics in (1, 8):
            estimate = run(tone(np.random.default_rng(1), midi_hz(midi, cents), 2.0, harmonics=harmonics)).get("tuningCents", 0.0)
            if abs(estimate - cents) > 5.0:
                errors.append(f"{label} {cents:+d}cent 배음{harmonics}→{estimate:+.1f}")
record("튜닝 편차를 A2~A4에서 5 cent 이내로 추정한다", not errors, ", ".join(errors[:5]))

# 6. 3음이 없으면 장·단조 신뢰도를 낮춘다.
triad = run(chord(np.random.default_rng(11), [60, 64, 67], 3.0))
power_chord = run(chord(np.random.default_rng(11), [48, 55, 60], 3.0))
record(
    "3음이 없는 파워코드는 정상 3화음보다 신뢰도가 낮다",
    power_chord.get("confidence", 1.0) < triad.get("confidence", 0.0) - 0.1,
    f"파워코드 {power_chord.get('confidence')} vs 3화음 {triad.get('confidence')}",
)

# 7. 경계 입력을 안전하게 처리한다.
edge = []
for label, signal, expect_detected in (
    ("무음", np.zeros(3 * SR), False),
    ("DC 오프셋", np.full(3 * SR, 0.5), False),
    ("0.1초", tone(np.random.default_rng(1), 440.0, 0.1), False),
    ("임펄스 클릭", (np.arange(3 * SR) % 5000 == 0).astype(np.float64), False),
):
    result = run(signal)
    if bool(result.get("detected")) != expect_detected or not result.get("ok"):
        edge.append(f"{label}→{display(result)}")
nan_signal = chord(np.random.default_rng(1), [60, 64, 67], 3.0)
nan_signal[1000:1100] = np.nan
if display(run(nan_signal)) != "C Major":
    edge.append("NaN 포함 C major 실패")
clipped = np.clip(chord(np.random.default_rng(1), [60, 64, 67], 3.0) * 20.0, -1.0, 1.0)
if display(run(clipped)) != "C Major":
    edge.append("클리핑 C major 실패")
record("무음·DC·초단축·클릭·NaN·클리핑 입력을 안전하게 처리한다", not edge, ", ".join(edge))

# 8. 모든 반환 경로가 분석 버전을 남긴다.
missing = []
for label, signal in (("정상 진행", progression(np.random.default_rng(1), 0, "major")), ("무음", np.zeros(3 * SR)),
                      ("0.1초", tone(np.random.default_rng(1), 440.0, 0.1)), ("클릭", (np.arange(3 * SR) % 5000 == 0).astype(np.float64))):
    result = run(signal)
    if result.get("analysisVersion") != kd.ANALYSIS_VERSION:
        missing.append(label)
record("모든 결과에 analysisVersion을 포함한다", not missing, ", ".join(missing))

print(json.dumps({"available": True, "version": kd.ANALYSIS_VERSION, "cases": CASES}, ensure_ascii=False))
