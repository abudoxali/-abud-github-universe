# Live voice (free local TTS)

The former MediaRecorder → upload → Whisper → full reply → F5-TTS pipeline was removed. A live call now uses browser `SpeechRecognition` in `ar-EG` with interim text. The final recognized utterance enters the existing conversation or meeting run. Agent output is already streamed by OmniRoute; complete clauses are sent to a persistent local KemeTone 82M process and played in order. A browser `ar-EG` voice is the fallback if the local model is unavailable.

There is no application API fee for voice. KemeTone runs on the owner's machine under Apache-2.0. Browser speech recognition may use the browser vendor's cloud service; this depends on the browser and is not controlled by the app. Agent inference still follows the project's existing OmniRoute routing and budget policy, which may have its own cost.

## Setup on Windows

Run `powershell -ExecutionPolicy Bypass -File apps/realtime-voice/setup.ps1` once. The model and Python environment live under `%LOCALAPPDATA%\ABUD-FUN-OS\realtime-voice`, outside the Git checkout. Optionally set `ABUD_LIVE_VOICE_HOME` and `ABUD_LIVE_VOICE_PYTHON`. The Bridge starts the worker when a call starts and keeps it warm. No inference-time downloads occur.

The browser must expose `SpeechRecognition` and allow microphone access. The system panel reports available `ar-EG` fallback voices. The meeting and chat text controls remain usable when voice is unavailable.

## Behavior and limits

- Only an explicitly started call listens. Recognition stops while an agent responds, and the call ends on navigation or when the page is hidden.
- Replies from one speaker are played in order. New speech and a manual stop cancel queued playback. The displayed text is the same cumulative stream used to form spoken clauses.
- The Egyptian KemeTone voice is one female voice for all agents at present. Multi-speaker voice identity and pronunciation of unvoweled Arabic or English code-switching need owner listening tests. Local synthesis of a short sentence was measured at roughly 0.7 seconds on this Windows machine after a roughly 3-second model load; end-to-end latency also depends on browser recognition and the selected agent model.
- A very short microphone check such as “سمعني؟” is answered deterministically with “أيوه، سامعك. اتفضل.” without an inference call.
