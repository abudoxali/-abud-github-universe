"""Objective voice check: synthesizes the standard sentence for every built-in voice through the real worker path,
then measures duration, pace, median F0 (pYIN, voiced frames only) and a Whisper round-trip character error rate.
Audio is written only to VOICE_HOME/tmp/samples; nothing is stored in the repository.
Usage: <venv python> evaluate_voices.py"""
import json
import time

import librosa
import numpy as np

import worker as worker_module

NAMES = {'ori': 'أوري', 'mia': 'ميا', 'nex': 'نِكس', 'luna': 'لونا', 'zen': 'زِن', 'rex': 'ريكس'}
SENTENCE = 'أهلاً، أنا {name}. النهارده هنراجع حالة المشاريع ونحدد أولويات الأسبوع.'


def normalize(text: str) -> str:
    text = ''.join(ch for ch in text if ch.isalnum() or ch.isspace())
    return ' '.join(text.replace('أ', 'ا').replace('إ', 'ا').replace('آ', 'ا').replace('ة', 'ه').replace('ى', 'ي').split())


def cer(ref: str, hyp: str) -> float:
    a, b = normalize(ref), normalize(hyp)
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        prev, row[0] = row[0], i
        for j, cb in enumerate(b, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (ca != cb))
    return row[-1] / max(1, len(a))


def main():
    out_dir = worker_module.VOICE_HOME / 'tmp' / 'samples'
    out_dir.mkdir(parents=True, exist_ok=True)
    voice = worker_module.VoiceWorker()
    stt = None
    results = {}
    for vid, name in NAMES.items():
        text = SENTENCE.format(name=name)
        started = time.perf_counter()
        wav = voice.synthesize(text, vid, f'eval-{vid}-{time.time_ns()}')
        latency = time.perf_counter() - started
        path = out_dir / f'sample_{vid}.wav'
        path.write_bytes(wav)
        y, sr = librosa.load(str(path), sr=16000)
        duration = len(y) / sr
        f0, voiced, _ = librosa.pyin(y, fmin=65, fmax=400, sr=sr)
        f0_median = float(np.nanmedian(f0[voiced])) if np.any(voiced) else None
        if stt is None:
            from faster_whisper import WhisperModel
            stt = WhisperModel(str(worker_module.VOICE_HOME / 'models' / 'large-v3-turbo'), device='cuda', compute_type='float16')
        segments, _ = stt.transcribe(str(path), language='ar', beam_size=5)
        heard = ''.join(s.text for s in segments).strip()
        words = len(normalize(text).split())
        results[vid] = {'latencySeconds': round(latency, 2), 'durationSeconds': round(duration, 2),
                        'wordsPerMinute': round(words / duration * 60, 1), 'medianF0Hz': round(f0_median, 1) if f0_median else None,
                        'cer': round(cer(text, heard), 3), 'heard': heard}
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
