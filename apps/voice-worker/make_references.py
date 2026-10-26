"""Builds the six base reference prompts from Kokoro-82M (Apache-2.0, trained on permissive/synthetic audio, no
custom voice clones), so no voice identity imitates a real, identifiable person. Each identity gets its own
synthetic speaker; the Habibi EGY model then speaks Egyptian Arabic in that timbre.
Writes VOICE_HOME/references/kokoro_<voice>.wav (24 kHz mono). Usage: <venv python> make_references.py"""
import json
from pathlib import Path

import numpy as np
import soundfile as sf

import worker as worker_module

KOKORO_REVISION = 'f3ff3571791e39611d31c381e3a41a3af07b4987'


def main():
    from kokoro import KPipeline

    voices = json.loads((Path(__file__).with_name('voices.json')).read_text(encoding='utf-8'))['voices']
    out_dir = worker_module.VOICE_HOME / 'references'
    out_dir.mkdir(parents=True, exist_ok=True)
    pipelines = {}
    for vid, info in voices.items():
        ref = info['reference']
        speaker = ref['kokoroVoice']
        lang = speaker[0]  # 'a' American, 'b' British
        pipeline = pipelines.setdefault(lang, KPipeline(lang_code=lang, repo_id='hexgrad/Kokoro-82M'))
        audio = np.concatenate([np.asarray(chunk.audio, dtype=np.float32) for chunk in pipeline(ref['exactTranscript'], voice=speaker)])
        path = out_dir / ref['file']
        sf.write(str(path), audio, 24000, subtype='PCM_16')
        print(vid, speaker, path.name, round(len(audio) / 24000, 2), 's')


if __name__ == '__main__':
    main()
