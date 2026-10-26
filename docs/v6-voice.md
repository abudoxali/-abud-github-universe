# V6 local voice foundation

## License gate — checked 2026-10-26

Only STT is selected for installation. Preserve upstream notices when distributing. This is an engineering license inventory, not legal advice.

| Candidate | Evidence and revision | Commercial gate |
| --- | --- | --- |
| faster-whisper | [MIT code](https://github.com/SYSTRAN/faster-whisper/blob/9e472ae9de8bb374552f531f752654554b76b2d6/LICENSE), commit `9e472ae9de8bb374552f531f752654554b76b2d6` | PASS |
| Turbo converted weights | [HF API](https://huggingface.co/api/models/dropbox-dash/faster-whisper-large-v3-turbo), [card](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo/blob/0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf/README.md), MIT, revision `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf`. Original mobiuslabsgmbh URL redirects here. [OpenAI upstream MIT](https://github.com/openai/whisper/blob/main/LICENSE). | PASS; selected |
| Medium converted weights | [API/card](https://huggingface.co/api/models/Systran/faster-whisper-medium), MIT, `08e178d48790749d25932bbc082711ddcfdfbc4f` | PASS; downloaded and empirically evaluated against turbo |
| CTranslate2 | [MIT](https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE) | PASS for code; NVIDIA CUDA/cuDNN binary terms are separate, not MIT |
| whisper.cpp alternative | [MIT code](https://github.com/ggml-org/whisper.cpp/blob/231638a0717b7822784297e5980965ffcec05810/LICENSE), same upstream MIT Whisper weights | PASS for code/upstream weights; no converted GGML artifact selected |
| Habibi EGY | [Code/card](https://github.com/SWivid/Habibi-TTS/tree/16252f67b9d54fc75670c091d7a1e9e9550bbe3d), MIT code. [Weight card](https://huggingface.co/SWivid/Habibi-TTS/blob/3ad11a152851245c002156526c5e1d0b12f2b9d5/README.md) explicitly licenses specialized EGY/ALG/IRQ/MAR/MSA Apache-2.0 despite repository-level NC metadata. | EGY explicit grant permits commercial use; only EGY may be considered next task. Unified/SAU/UAE are CC-BY-NC-SA-4.0: BLOCKED for commercial use. No TTS downloaded. |
| F5-TTS | [MIT code](https://github.com/SWivid/F5-TTS/blob/45868abaabd74aabf03cd673d6dd00cc9d9c01ae/LICENSE) | Code PASS; this does not authorize arbitrary base weights |
| Vocos | [MIT code](https://github.com/gemelo-ai/vocos/blob/eb39abfc42c1dee4854d9b10d44dd7d4fd3b0e53/LICENSE), [weight API](https://huggingface.co/api/models/charactr/vocos-mel-24khz), MIT revision `0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21` | PASS for these artifacts |
| hag-shalaby | [Card](https://huggingface.co/nomeda-lab/hag-shalaby-tts-0.2B-v0.1/blob/91ef27217bd8eed2e422d3982832ceed4063605b/README.md), [API](https://huggingface.co/api/models/nomeda-lab/hag-shalaby-tts-0.2B-v0.1), Apache-2.0 claimed, SILMA base; F5 architecture MIT | SILMA [base card](https://huggingface.co/silma-ai/silma-tts/blob/226dd7a65cadf51f9a6dbe3953fc89003b3844d5/README.md) confirms Apache-2.0 weights and MIT code. Deployment BLOCKED pending complete dependency/vocoder verification; card reserves third-party terms |
| Chatterbox multilingual | [MIT code](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/LICENSE), [MIT weight API](https://huggingface.co/api/models/ResembleAI/chatterbox), revision `5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18` | Code/weight grants permit commercial use; deployment BLOCKED pending S3Gen and full transitive dependency audit |

Notable STT runtime dependencies: PyAV wraps FFmpeg (build-dependent LGPL/GPL obligations); inspect wheel build terms before redistribution. NVIDIA cuBLAS/cuDNN have proprietary NVIDIA terms ([cuBLAS license](https://docs.nvidia.com/cuda/eula/index.html), [cuDNN license](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html)); local installation is authorized by the owner, not a claim that the binaries are MIT or freely redistributable. Pinned runtime wheels: cuBLAS 12.8.4.1 and cuDNN 9.10.2.21. No vocoder is used for STT. TTS remains HTTP 501.

Resume verification 2026-10-26: fetched faster-whisper's pinned LICENSE (MIT), HF API and the pinned turbo README (MIT, revision unchanged). [PyAV 16.0.1 source LICENSE.txt](https://github.com/PyAV-Org/PyAV/blob/v16.0.1/LICENSE.txt) confirms BSD-3-Clause; its wheel links FFmpeg, whose binary obligations remain build-dependent. NVIDIA package-version API metadata reports NVIDIA Proprietary Software / LicenseRef-NVIDIA-Proprietary. Other candidate inventory above is retained from the previous run; blocked TTS candidates remain blocked. No blanket redistribution clearance is claimed.

## Environment and execution evidence

- Worktree-only execution; no daily bridge accessed.
- `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader`: RTX 4070, 12282 MiB total, 1453 MiB used (snapshot, NOT inference peak).
- `uv --version`: 0.12.10. `py -3.11 --version` fails (no registered runtime). `uv python find 3.11` finds Astral CPython at `C:\Users\Abud\AppData\Roaming\uv\python\cpython-3.11-windows-x86_64-none\python.exe`.
- Previous storage blocker resolved by orchestrator: `git check-ignore local/voice/models/probe` now succeeds. Runtime storage nevertheless moved OUTSIDE all checkouts to `VOICE_HOME`, default `%LOCALAPPDATA%\ABUD-FUN-OS\voice`, with `venv/`, `models/`, and `tmp/` subdirectories. Setup tries the Windows Python launcher then uv-managed Python 3.11. Worker audio remains in memory; temporary benchmark audio lives only in external tmp/.
- Turbo vs medium evaluation: both downloaded into `VOICE_HOME/models` and empirically benchmarked on RTX 4070 (12282 MiB VRAM). Turbo is ~40% faster on warm transcription (0.585 s vs 0.991 s on 15.17 s audio, RTF 0.038 vs 0.065) with only a ~192 MiB VRAM difference (3911 MiB vs 3719 MiB peak, <32% of 12 GB GPU). Turbo selected as primary production model.

## Test results and benchmarks — 2026-10-26

### Test suite status
- Astral CPython 3.11, `python.exe -I -B apps/voice-worker/test_worker.py`: **16 passed, 0 failed, 0 skipped** (16 total, 0.771 s). PyAV is installed in the external venv; real WAV decoder limit test (`test_decode_real_wav_limits`) passes along with health, concurrency limits, idle unload, cooperative cancel, and forced CPU fallback.
- `npm --prefix apps/local-bridge test`: **196 passed, 0 failed, 0 skipped** (36.162 s). Every existing test still passes.
- `npm --prefix apps/local-bridge run check`: **exit 0**.

### Speech samples
- Windows SAPI English clip (`VOICE_HOME/tmp/sapi-en.wav`): 15.167 s duration, 16 kHz mono WAV, generated via `System.Speech` (Microsoft Zira Desktop voice, English synthetic company task paragraph).
- Arabic speech clip (`VOICE_HOME/tmp/ar-hasanan.wav`): 0.707 s duration, 16 kHz mono WAV, converted from `Ar-حسنا.oga` downloaded from Wikimedia Commons ([File:Ar-حسنا.oga](https://commons.wikimedia.org/wiki/File:Ar-%D8%AD%D8%B3%D9%86%D8%A7.oga)). Artist: TwoThirty (English Wikibooks), original upload date 2006-07-01, license Public Domain (`PD-user`). Custom User-Agent header used to avoid Wikimedia 429 rate limit. Stored strictly in external `%LOCALAPPDATA%\ABUD-FUN-OS\voice\tmp\`. Correctly transcribed as `"حسناً"` (language `ar`, segment 0.00–0.66 s).
- Disclaimer: Synthetic English and formal Arabic pronunciation clips do NOT establish Egyptian colloquial accuracy.
- Egyptian colloquial validation: 5 test sentences recorded in `apps/voice-worker/fixtures.json`. **OWNER LIVE TEST PENDING**.

### Empirical benchmark results (measured via loopback HTTP at 127.0.0.1:4185)

#### 1. Selected model: `large-v3-turbo` on CUDA (float16) — English 15.167 s clip
- Cold model load time: **2.090 s**
- First request latency (cold infer + HTTP + decode): **0.972 s** (RTF: **0.064**)
- Warm transcription latency (3 runs): **0.585 s, 0.601 s, 0.568 s** (average: **0.585 s**)
- Warm Real-Time Factor (RTF): **0.038** (~26x faster than real-time)
- Baseline GPU VRAM: **1388 MiB**
- Peak GPU VRAM during inference: **3911 MiB** (delta: +2523 MiB; uses 31.8% of 12282 MiB)
- GPU VRAM after `POST /unload`: **1543 MiB** (~2368 MiB VRAM successfully reclaimed)

#### 2. Selected model: `large-v3-turbo` on CUDA (float16) — Arabic 0.707 s clip
- Cold model load time: **2.088 s**
- First request latency: **0.584 s** (RTF: **0.827**)
- Warm transcription latency (3 runs): **0.277 s, 0.285 s, 0.280 s** (average: **0.281 s**)
- Warm Real-Time Factor (RTF): **0.397**
- Peak GPU VRAM: **3689 MiB**
- Recognized text: `"حسناً"` (language: `ar`, durationMs: 707)

#### 3. Comparison model: `medium` on CUDA (float16) — English 15.167 s clip
- Cold model load time: **2.103 s**
- First request latency: **1.339 s** (RTF: **0.088**)
- Warm transcription latency (3 runs): **1.002 s, 0.985 s, 0.988 s** (average: **0.991 s**)
- Warm Real-Time Factor (RTF): **0.065** (~15x faster than real-time)
- Peak GPU VRAM during inference: **3719 MiB**
- GPU VRAM after `POST /unload`: **1543 MiB** (~2176 MiB reclaimed)
- **Evaluation conclusion**: `large-v3-turbo` is ~40% faster than `medium` (0.585 s vs 0.991 s, RTF 0.038 vs 0.065) with large-v3 architectural accuracy, while peak VRAM is only ~192 MiB higher (3911 MiB vs 3719 MiB) and fits comfortably in the 12 GB RTX 4070. `large-v3-turbo` is confirmed as the chosen model.

#### 4. Automatic CPU Fallback path: `large-v3-turbo` forced CPU (int8) — English 15.167 s clip
- Cold model load time: **3.341 s**
- First request latency: **23.851 s** (RTF: **1.573**)
- Warm transcription latency (3 runs): **24.933 s, 26.403 s, 24.985 s** (average: **25.440 s**)
- Warm Real-Time Factor (RTF): **1.677** (CPU int8 is ~43x slower than CUDA float16)
- Peak GPU VRAM: **1581 MiB** (no GPU memory used for inference; pure system RAM / CPU execution)
- Accuracy: identical text transcription output to CUDA run.

## Contract

See `apps/voice-worker/README.md` for setup and endpoint semantics. Raw WAV/WebM bodies only; no user paths, commands or URLs. All decoding and GPU inference share one bounded admission slot. Cancellation is cooperative between decode frames / transcription segments; an in-flight native model call cannot be interrupted. No background microphone listening. No inference-time downloads.
