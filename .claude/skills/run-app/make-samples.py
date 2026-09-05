"""조성 검출을 시험할 합성 오디오를 만든다.

사용법: python3 make-samples.py <출력폴더>
정답이 정해져 있어 검출 결과를 바로 채점할 수 있다.
"""

import os
import sys
import wave

import numpy as np

SAMPLE_RATE = 44100
rng = np.random.default_rng(7)


def midi_hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12.0)


def tone(frequency, seconds, harmonics=8, rolloff=1.0):
    times = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    out = np.zeros_like(times)
    for partial in range(1, harmonics + 1):
        if frequency * partial > 18000:
            break
        out += (1.0 / partial ** rolloff) * np.sin(2 * np.pi * frequency * partial * times + rng.uniform(0, 2 * np.pi))
    return out


def chord(midis, seconds, **kwargs):
    return sum(tone(midi_hz(m), seconds, **kwargs) for m in midis)


def progression(tonic, mode, **kwargs):
    degrees = [(0, 4, 7), (5, 9, 12), (7, 11, 14), (0, 4, 7)] if mode == "major" \
        else [(0, 3, 7), (5, 8, 12), (7, 11, 14), (0, 3, 7)]
    return np.concatenate([
        chord([60 + tonic + step for step in degree] + [36 + tonic + degree[0]], 1.2, **kwargs)
        for degree in degrees
    ])


def pink_noise(seconds):
    count = int(seconds * SAMPLE_RATE)
    spectrum = np.fft.rfft(rng.standard_normal(count))
    frequencies = np.fft.rfftfreq(count, 1.0 / SAMPLE_RATE)
    shape = np.ones_like(frequencies)
    shape[1:] = frequencies[1:] ** -0.5
    shape[0] = 0.0
    return np.fft.irfft(spectrum * shape, count)


def save(directory, name, samples):
    samples = np.asarray(samples, dtype=np.float64)
    samples = samples / max(float(np.max(np.abs(samples))), 1e-9) * 0.85
    fade = int(0.01 * SAMPLE_RATE)
    samples[:fade] *= np.linspace(0.0, 1.0, fade)
    samples[-fade:] *= np.linspace(1.0, 0.0, fade)
    path = os.path.join(directory, name)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes((samples * 32767).astype("<i2").tobytes())
    return path


def main():
    directory = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sound-shelf-samples"
    os.makedirs(directory, exist_ok=True)
    files = [
        ("01_C장조_코드진행.wav", progression(0, "major"), "C Major"),
        # 배음이 밝은 장3화음은 3도 위 단조로 뒤집히기 쉬운 회귀 사례다.
        ("02_밝은_C장3화음.wav", chord([60, 64, 67], 3.0, harmonics=12, rolloff=0.7), "C Major"),
        ("03_A단조_코드진행.wav", progression(9, "minor"), "A Minor"),
        ("04_잡음_효과음.wav", pink_noise(3.0), "미검출"),
    ]
    for name, samples, expected in files:
        save(directory, name, samples)
        print(f"  {name}  (정답: {expected})")
    print(f"{len(files)}개 생성: {directory}")


if __name__ == "__main__":
    main()
