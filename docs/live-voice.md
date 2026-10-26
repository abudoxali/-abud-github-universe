# Live voice

## Primary engine: Gemini Live (free tier)

Gemini Live is the owner's **ears and mouth only**. The browser streams the microphone (16 kHz PCM) to the local Bridge; the Bridge holds the API key and talks to Google's Live WebSocket; Google's spoken reply (24 kHz PCM) streams back through the Bridge to the browser. Interruption (barge-in) is handled by Google's server-side voice activity detection and mirrored in the page.

Agents, tools, permissions, memory and data are **unchanged**. Gemini has exactly one tool, `ask_company`. When the owner asks for anything that is real work, Gemini calls it and the Bridge runs the owner's own words (taken from Google's input transcript, not Gemini's paraphrase) through the same path as typing: `conversations.send` for a chat call, `meetings.say` for a meeting. That path uses the normal runtime, OmniRoute routing and budgets, server-enforced permissions, approvals and audit. Gemini then speaks the agent's reply. In a meeting the first speaker's reply is returned at once; later speakers arrive as spoken updates when the current sentence ends. Gemini answers by itself only for greetings, «سامعني؟», thanks and repeats. It cannot call any other tool, read company data, or change anything the owner could not do by typing.

- Model: the Bridge asks Google which models support `bidiGenerateContent` and picks the newest non-extended Live model (override with `ABUD_LIVE_GEMINI_MODEL`).
- Voice: one prebuilt Google voice per agent; the voice is not selectable yet.
- Sessions: sliding-window context compression and session resumption are enabled so a call is not cut at Google's 15-minute audio session limit; the Bridge reconnects with the resumption handle on `goAway`.
- Audit: every call writes a `live-voice.session` activity event (duration, tool calls, token total). Key set/removal is audited without the key.

### Setup

1. Create a free key at <https://aistudio.google.com/apikey>.
2. In the app: System → المحادثة الصوتية → paste the key, tick the free-tier acknowledgement, «احفظ وجرّب». The Bridge validates the key against Google and stores it under `%LOCALAPPDATA%\ABUD-FUN-OS\gemini-live\gemini.key` (outside the repository). Alternatively set `GEMINI_LIVE_API_KEY`. Up to three keys can be saved (one primary and two backups, newline- or comma-separated in the variable): a backup is used only when Google refuses or exhausts the current key's session, never to spread load. Free-tier limits are per Google Cloud project, so keys from the same project add nothing, and using several projects to get around quotas may breach Google's terms.
3. Start a chat call or a voice meeting. The microphone prompt appears once.

### Privacy and cost

- Free tier: Google may use the audio, transcripts and the agent replies that are spoken aloud to improve its products. Company data reaches Google only inside the reply an agent is asked to say. The paid tier does not use data this way, at about USD 0.005/min audio in and 0.018/min audio out (verify current pricing). Keep sensitive subjects to typed chat.
- Rate limits for Live are not published; check the project's limits in AI Studio. If Google refuses a session, the call ends with an Arabic error and the local fallback below remains available once the key is removed.
- The API key never reaches the browser or the repository.

## Fallback engine (no key configured)

Browser `SpeechRecognition` (`ar-EG`) with interim text; complete clauses of the streamed agent reply are sent to a persistent local KemeTone 82M process (`apps/realtime-voice`, setup with `apps/realtime-voice/setup.ps1`), or spoken by the browser's `ar-EG` voice if the model is unavailable. Browser speech recognition may use the vendor's cloud service. This path is slower and less natural than Gemini Live.

## Limits to know

- Use headphones or a quiet room: loudspeaker echo can be heard as the owner and interrupt the agent. The browser's echo cancellation is on.
- All agents currently share one call; in a meeting Gemini speaks every agent's lines in the chair's voice and names the speaker.
- Real-microphone quality, Egyptian pronunciation and end-to-end latency with a real key have not been measured yet; the automated tests use a local fake of Google's protocol.
