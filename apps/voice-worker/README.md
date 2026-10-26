# Local Voice Worker

Python 3.11, stdlib HTTP, faster-whisper STT. TTS deliberately returns 501. License inventory and measurements: `docs/v6-voice.md`.

## Reproducible setup (from the V6 worktree root)

Run `powershell -NoProfile -ExecutionPolicy Bypass -File apps/voice-worker/setup.ps1`.
The script tries `py -3.11`, then `uv python find 3.11`, and fails clearly if neither finds Python.
It installs pinned requirements including NVIDIA cuBLAS/cuDNN and downloads only pinned, reviewed turbo model data; no remote Python scripts are executed.

Runtime storage is shared OUTSIDE the repository: `VOICE_HOME`, default `%LOCALAPPDATA%\ABUD-FUN-OS\voice`.
Venv: `<home>\venv`; model: `<home>\models\large-v3-turbo`; benchmark audio/results: `<home>\tmp`.
Setup rejects a VOICE_HOME inside this worktree. No weights, audio or venv belong in git. Re-running setup reuses the venv and HF download metadata.

Start from PowerShell:

```powershell
$voiceHome = if ($env:VOICE_HOME) { $env:VOICE_HOME } else { Join-Path $env:LOCALAPPDATA 'ABUD-FUN-OS/voice' }
& "$voiceHome/venv/Scripts/python.exe" -I apps/voice-worker/worker.py 4185
```

CUDA float16 is tried first, then CPU int8 if initialization or CUDA inference fails. Set `VOICE_FORCE_CPU=1` to force CPU.
The worker registers NVIDIA wheel DLL directories on Windows. NVIDIA binary redistribution terms are separate from MIT; see the license inventory before redistributing.
`VOICE_PORT` defaults to 4185; argv overrides it. Reserved app ports are rejected. `VOICE_IDLE_MINUTES` defaults to 10.
Models load lazily from VOICE_HOME with `local_files_only=True`; no inference-time downloads, microphone access, arbitrary paths or shell commands.

## HTTP API

Bound exclusively to `127.0.0.1`. No CORS. Browser Origin headers and unexpected Host headers are rejected; intended caller is the local Bridge, not browser JavaScript. No authentication against other local processes.

- `GET /health`: per-model state (`unloaded/loading/ready/error`), device, fallback reason, whole-GPU memory usage from nvidia-smi (not process attribution).
- `POST /stt`: raw WAV/WebM, Content-Length required, max 10 MiB AND max 60 decoded seconds. Optional `X-Job-Id`: 1–64 ASCII letters/digits/underscore/hyphen. Returns `{jobId,text,language,durationMs,segments}` synchronously.
- `POST /cancel/<jobId>`: cooperative cancellation; unknown IDs return 404. Cannot interrupt a native CUDA operation, but discards cancelled results.
- `POST /unload`: drops model and collects garbage; 409 while busy.
- `POST /tts`: 501 `{error:"tts-not-installed"}`.

One inference slot, no waiting jobs (429 when busy). At most four handlers; excess sockets close. One buffered upload at a time with a 15-second total deadline. No audio/transcripts logged or persisted by the service; audio decoded in memory. Segments use seconds; durationMs is audio duration, not latency.

## Tests and benchmarks

Run `<home>/venv/Scripts/python.exe -I -B apps/voice-worker/test_worker.py` (stdlib unittest, fake loaders/decoders).
Run `<home>/venv/Scripts/python.exe -I apps/voice-worker/benchmark.py <absolute-wav-path>` with no other worker using 4185.
This starts the real loopback HTTP server, measures model loading separately, one first and three warm requests, RTF, whole-GPU peak sampled by nvidia-smi (100 ms pause plus subprocess time), and VRAM two seconds after unload.
Repeat in a fresh process with `VOICE_FORCE_CPU=1`. Reports go to `<home>/tmp/benchmark-{device}.json`; unlike the service, benchmark output includes recognized text. Remove temporary benchmark audio/reports when no longer needed.
Synthetic English or formal Arabic samples do NOT establish Egyptian colloquial accuracy. `fixtures.json` contains five prompts for the owner's live test.
