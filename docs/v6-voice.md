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
| Habibi EGY | [Code/card](https://github.com/SWivid/Habibi-TTS/tree/16252f67b9d54fc75670c091d7a1e9e9550bbe3d), MIT code. [Weight card](https://huggingface.co/SWivid/Habibi-TTS/blob/3ad11a152851245c002156526c5e1d0b12f2b9d5/README.md) explicitly licenses specialized EGY Apache-2.0 despite repository-level NC metadata. Revision `3ad11a152851245c002156526c5e1d0b12f2b9d5`. | PASS; selected and downloaded (`model_100000.safetensors`, 1.35 GB, SHA-256 `abfc7b4889e7c365a16b68f606eda210078e4a42e308c5461aba7dd9fe349ee1`). Unified/SAU/UAE weights remain strictly BLOCKED (CC-BY-NC-SA-4.0). |
| F5-TTS | [MIT code](https://github.com/SWivid/F5-TTS/blob/45868abaabd74aabf03cd673d6dd00cc9d9c01ae/LICENSE), pinned version `1.1.9` without `torchcodec` dependency. | Code PASS; installed in venv with `torch==2.6.0+cu124` on driver 610.88. |
| Vocos | [MIT code](https://github.com/gemelo-ai/vocos/blob/eb39abfc42c1dee4854d9b10d44dd7d4fd3b0e53/LICENSE), [weight API](https://huggingface.co/api/models/charactr/vocos-mel-24khz), MIT revision `0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21` (`config.yaml` + `pytorch_model.bin`) | PASS; selected and downloaded. |
| Reference speakers: Kokoro-82M synthetic voices | [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M/tree/f3ff3571791e39611d31c381e3a41a3af07b4987) Apache-2.0 weights; card states training only on permissive/non-copyrighted or synthetic audio and no custom voice clones | PASS; six references generated locally by `make_references.py`, never committed |
| Reference Audio: IRQ.wav, ALG.wav | [Habibi-TTS Apache-2.0 repository](https://github.com/SWivid/Habibi-TTS/tree/16252f67b9d54fc75670c091d7a1e9e9550bbe3d/src/habibi_tts/assets) | PASS; sample dialect clips shipped with Apache-2.0 repo. |
| hag-shalaby | [Card](https://huggingface.co/nomeda-lab/hag-shalaby-tts-0.2B-v0.1/blob/91ef27217bd8eed2e422d3982832ceed4063605b/README.md), [API](https://huggingface.co/api/models/nomeda-lab/hag-shalaby-tts-0.2B-v0.1), Apache-2.0 claimed, SILMA base; F5 architecture MIT | SILMA [base card](https://huggingface.co/silma-ai/silma-tts/blob/226dd7a65cadf51f9a6dbe3953fc89003b3844d5/README.md) confirms Apache-2.0 weights and MIT code. Deployment BLOCKED pending complete dependency/vocoder verification; card reserves third-party terms |
| Chatterbox multilingual | [MIT code](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/LICENSE), [MIT weight API](https://huggingface.co/api/models/ResembleAI/chatterbox), revision `5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18` | Code/weight grants permit commercial use; deployment BLOCKED pending S3Gen and full transitive dependency audit |

Notable STT runtime dependencies: PyAV wraps FFmpeg (build-dependent LGPL/GPL obligations); inspect wheel build terms before redistribution. NVIDIA cuBLAS/cuDNN have proprietary NVIDIA terms ([cuBLAS license](https://docs.nvidia.com/cuda/eula/index.html), [cuDNN license](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html)); local installation is authorized by the owner, not a claim that the binaries are MIT or freely redistributable. Pinned runtime wheels: cuBLAS 12.8.4.1 and cuDNN 9.10.2.21. No vocoder is used for STT. TTS remains HTTP 501.

Resume verification 2026-10-26: fetched faster-whisper's pinned LICENSE (MIT), HF API and the pinned turbo README (MIT, revision unchanged). [PyAV 16.0.1 source LICENSE.txt](https://github.com/PyAV-Org/PyAV/blob/v16.0.1/LICENSE.txt) confirms BSD-3-Clause; its wheel links FFmpeg, whose binary obligations remain build-dependent. NVIDIA package-version API metadata reports NVIDIA Proprietary Software / LicenseRef-NVIDIA-Proprietary. Other candidate inventory above is retained from the previous run; blocked TTS candidates remain blocked. No blanket redistribution clearance is claimed.

## Environment and execution evidence

- Worktree-only execution; no daily bridge accessed.
- `nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader`: RTX 4070, 12282 MiB total, 1453 MiB used (snapshot, NOT inference peak).
- `uv --version`: 0.12.10. `py -3.11 --version` fails (no registered runtime). `uv python find 3.11` finds Astral CPython at `%APPDATA%\uv\python\cpython-3.11-windows-x86_64-none\python.exe`.
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

### Egyptian TTS — final decision and measurements (orchestrator review, 2026-10-26)

**Engine:** F5-TTS 1.1.9 (MIT code) + Habibi-TTS **Specialized/EGY** `model_100000.safetensors` (Apache-2.0, pinned
revision `3ad11a15…`) + Vocos mel-24khz (MIT). Unified/SAU/UAE weights (CC-BY-NC-SA-4.0) are never downloaded.

**Reference speakers (rejected options first):**
- Habibi's `assets/EGY.mp3` is an ElevenLabs voice-library voice and the `.wav` assets come from scraped dialect
  datasets. Their presence in an MIT repository grants no right to build a synthetic identity from those voices,
  so they are **not used** and the downloader no longer fetches them.
- The earlier F5-TTS example clips were rejected too: `basic_ref_en.wav`, labelled "female" by an earlier pass, is a
  **male** voice (pYIN median 98 Hz), so no female identity existed, and the ±semitone DSP variants were not distinct.
- **Adopted:** six synthetic speakers from Kokoro-82M (Apache-2.0; trained only on permissive/synthetic audio, no
  custom voice clones): ORI `am_michael`, MIA `af_bella`, NEX `bm_george`, LUNA `af_heart`, ZEN `am_puck`, REX
  `am_onyx`. The English prompts and their exact transcripts are in `voices.json`; audio is generated into
  `VOICE_HOME/references` by `make_references.py`. No recording of an identifiable person is used.

**Duration fix:** F5 sizes output by UTF-8 byte ratio, which roughly doubled Arabic durations against an English
prompt (earlier 42–48 WPM and up to 21% CER). Each chunk now gets an explicit duration from its letter count at 11
letters/s, references and outputs are silence-trimmed, and the cache key carries a render version.

**Measured by `evaluate_voices.py`** (RTX 4070, standard sentence «أهلاً، أنا <name>. النهارده هنراجع حالة المشاريع
ونحدد أولويات الأسبوع.», pYIN median F0 on voiced frames, Whisper large-v3-turbo round trip):

| Voice | Speaker | Duration | Pace | Median F0 | CER | Warm latency |
|---|---|---|---|---|---|---|
| ORI | am_michael | 5.15 s | 116 WPM | 118 Hz | 1.5% | (first call includes warm-up) |
| MIA | af_bella | 4.28 s | 140 WPM | 196 Hz | 0.0% | 0.96 s |
| NEX | bm_george | 4.86 s | 124 WPM | 151 Hz | 1.6% | 0.89 s |
| LUNA | af_heart | 4.49 s | 134 WPM | 203 Hz | 0.0% | 0.92 s |
| ZEN | am_puck | 4.50 s | 133 WPM | 96 Hz | 0.0% | 1.04 s |
| REX | am_onyx | 4.81 s | 125 WPM | 93 Hz | 0.0% | 0.92 s |

- Warm synthesis ≈ 0.9–1.0 s for ≈ 4.5 s of speech (RTF ≈ 0.2). A 9-word REX reply after warm-up: 0.97 s.
- Cold: the first synthesis after load takes ≈ 24 s (CUDA kernel warm-up). `POST /warmup` performs it ahead of time
  (measured 23.97 s), and the Bridge triggers it when the owner turns voice on.
- VRAM: idle desktop 1,226 MiB → peak 4,589 MiB with STT and TTS both loaded → 1,231 MiB after the process exits.
- Gender is consistent with F0 for all six. ZEN and REX are close in F0 (96 vs 93 Hz) and differ in timbre and pace
  only. **Dialect authenticity and audible distinctness are OWNER LISTENING TEST PENDING**; all six profiles stay
  `provisional` until then. The owner can replace any reference with a consenting recording later.

## Contract

See `apps/voice-worker/README.md` for setup and endpoint semantics. Raw WAV/WebM bodies only; no user paths, commands or URLs. All decoding and GPU inference share one bounded admission slot. Cancellation is cooperative between decode frames / transcription segments; an in-flight native model call cannot be interrupted. No background microphone listening. No inference-time downloads.
