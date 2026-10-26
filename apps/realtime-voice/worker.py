"""Persistent Egyptian TTS process. JSON lines in, base64 WAV out; no microphone or files written."""
import base64
import io
import json
import os
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", message="dropout option adds dropout")
warnings.filterwarnings("ignore", message=".*weight_norm.*deprecated")

home = Path(os.environ["ABUD_LIVE_VOICE_HOME"])
model_dir = home / "kemetone"
sys.path.insert(0, str(model_dir))

import espeakng_loader
os.environ["KEMETONE_ESPEAK_LIB"] = espeakng_loader.get_library_path()
os.environ["KEMETONE_ESPEAK_DATA"] = espeakng_loader.get_data_path()

import soundfile as sf
import torch
from kokoro import KModel
from kemetone import EgyptianG2P

device = "cuda" if torch.cuda.is_available() else "cpu"
model = KModel(repo_id="Rabe3/kemetone", config=str(model_dir / "config.json"),
               model=str(model_dir / "kemetone.pth")).to(device).eval()
voice = torch.load(model_dir / "voices" / "kemetone.pt", map_location=device, weights_only=True)
g2p = EgyptianG2P()
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    try:
        request = json.loads(line)
        request_id = request["id"]
        text = str(request["text"]).strip()
        if not text or len(text) > 550:
            raise ValueError("text must contain 1 to 550 characters")
        started = time.perf_counter()
        phonemes = g2p(text)
        if not phonemes or len(phonemes) > len(voice):
            raise ValueError("text cannot be synthesized")
        with torch.inference_mode():
            samples = model(phonemes, voice[len(phonemes) - 1]).cpu().numpy()
        output = io.BytesIO()
        sf.write(output, samples, 24000, format="WAV", subtype="PCM_16")
        print(json.dumps({"id": request_id, "audioBase64": base64.b64encode(output.getvalue()).decode("ascii"),
                          "durationMs": round(len(samples) * 1000 / 24000),
                          "synthesisMs": round((time.perf_counter() - started) * 1000)}), flush=True)
    except Exception as error:
        print(json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                          "error": type(error).__name__}), flush=True)
