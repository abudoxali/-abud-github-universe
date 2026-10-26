"""Loopback-only, offline STT and Egyptian TTS with one bounded inference slot."""
import gc
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_script_dir = str(Path(__file__).resolve().parent)
if _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)
from normalize_ar import normalize_egyptian_arabic

VOICE_HOME = Path(os.environ.get('VOICE_HOME') or
                  Path(os.environ.get('LOCALAPPDATA', Path.home() / '.local' / 'share')) / 'ABUD-FUN-OS' / 'voice')
_DLL_HANDLES = []
if os.name == 'nt':
    for package in ('cublas', 'cudnn'):
        directory = Path(sys.prefix) / 'Lib' / 'site-packages' / 'nvidia' / package / 'bin'
        if directory.is_dir():
            _DLL_HANDLES.append(os.add_dll_directory(str(directory)))
            os.environ['PATH'] = str(directory) + os.pathsep + os.environ.get('PATH', '')
MAX_BYTES = 10 * 1024 * 1024
MAX_TEXT_LEN = 400
MAX_CACHE_BYTES = 200 * 1024 * 1024
# Bumped whenever synthesis changes, so cached audio from an older renderer is never replayed.
TTS_RENDER_VERSION = 3
# Unvowelled Arabic letters spoken per second at a relaxed conversational Egyptian pace.
ARABIC_LETTERS_PER_SECOND = 11.0


def spoken_letters(text: str) -> int:
    return sum(1 for ch in text if ch.isalnum())


def trim_silence_np(wave, sr: int, threshold: float = 0.01, pad: float = 0.08):
    import numpy as np
    wave = np.asarray(wave, dtype=np.float32)
    frame = max(1, int(0.02 * sr))
    if wave.size < frame:
        return wave
    energy = np.sqrt(np.convolve(wave ** 2, np.ones(frame) / frame, mode='same'))
    loud = np.nonzero(energy > threshold * max(1e-6, float(np.max(np.abs(wave)))))[0]
    if loud.size == 0:
        return wave
    start, end = max(0, loud[0] - int(pad * sr)), min(wave.size, loud[-1] + int(pad * sr))
    return wave[start:end]


def trim_silence(audio, sr: int):
    import torch
    mono = audio.mean(dim=0) if audio.dim() > 1 else audio
    trimmed = trim_silence_np(mono.numpy(), sr)
    return torch.from_numpy(trimmed).unsqueeze(0)


def chunk_text(text: str, max_chars: int = 120) -> list[str]:
    chunks = []
    sentences = re.split(r'(?<=[.!?؟\n])\s+|(?<=[،؛])\s*', text)
    current = ''
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        if len(current) + len(s) + 1 <= max_chars:
            current = f"{current} {s}".strip() if current else s
        else:
            if current:
                chunks.append(current)
            if len(s) <= max_chars:
                current = s
            else:
                words = s.split()
                sub = ''
                for w in words:
                    if len(sub) + len(w) + 1 <= max_chars:
                        sub = f"{sub} {w}".strip() if sub else w
                    else:
                        if sub:
                            chunks.append(sub)
                        sub = w
                current = sub
    if current:
        chunks.append(current)
    return chunks or [text]


def enforce_cache_limit(cache_dir: Path, max_bytes: int = MAX_CACHE_BYTES):
    if not cache_dir.is_dir():
        return
    files = []
    total_size = 0
    for p in cache_dir.iterdir():
        if p.is_file() and p.suffix == '.wav':
            try:
                stat = p.stat()
                files.append((stat.st_mtime, stat.st_size, p))
                total_size += stat.st_size
            except OSError:
                pass
    if total_size <= max_bytes:
        return
    files.sort(key=lambda x: x[0])
    for _, size, p in files:
        try:
            p.unlink(missing_ok=True)
            total_size -= size
            if total_size <= max_bytes:
                break
        except OSError:
            pass


class VoiceError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


class VoiceWorker:
    def __init__(self, loader=None, decoder=None, tts_loader=None, tts_infer=None, voices_path=None, cache_dir=None):
        self.model = None
        self.state = 'unloaded'
        self.device = 'cpu'
        self.fallback = None
        self.slot = threading.Lock()
        self.lock = threading.Lock()
        self.jobs = {}
        self.last_used = time.monotonic()
        self.idle_seconds = float(os.environ.get('VOICE_IDLE_MINUTES', '10')) * 60
        self.loader = loader or self.load_model
        self.decoder = decoder or self.decode

        # TTS components
        self.tts_loader = tts_loader or self.load_tts_model
        self.tts_loader_is_custom = tts_loader is not None
        self.tts_infer = tts_infer or self.real_tts_infer
        self.tts_model = None
        self.vocoder = None
        self.tts_state = 'unloaded'
        self.tts_device = 'cuda'
        self.voices_path = voices_path or (Path(__file__).with_name('voices.json'))
        self.voices_data = None
        self.cache_dir = cache_dir or (VOICE_HOME / 'tmp' / 'cache')
        self.last_used = time.monotonic()
        self.idle_seconds = float(os.environ.get('VOICE_IDLE_MINUTES', '10')) * 60
        self.loader = loader or self.load_model
        self.decoder = decoder or self.decode

    def load_model(self, device):
        from faster_whisper import WhisperModel
        model_name = os.environ.get('VOICE_MODEL', 'large-v3-turbo')
        path = VOICE_HOME / 'models' / model_name
        return WhisperModel(str(path), device=device,
                            compute_type='float16' if device == 'cuda' else 'int8',
                            local_files_only=True)

    def ensure_model(self):
        if self.model is not None:
            return
        self.state = 'loading'
        self.device = 'cpu' if os.environ.get('VOICE_FORCE_CPU') == '1' else 'cuda'
        try:
            self.model = self.loader(self.device)
        except Exception:
            if self.device == 'cpu':
                self.state = 'error'
                raise VoiceError(503, 'model-load-failed')
            self.device = 'cpu'
            self.fallback = 'cuda-unavailable'
            gc.collect()
            try:
                self.model = self.loader('cpu')
            except Exception:
                self.state = 'error'
                raise VoiceError(503, 'model-load-failed')
        self.state = 'ready'

    def decode(self, data, cancel):
        import av
        import numpy as np
        chunks = []
        samples = 0
        try:
            with av.open(io.BytesIO(data)) as container:
                stream = container.streams.audio[0]
                resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
                for frame in container.decode(stream):
                    if cancel.is_set():
                        raise VoiceError(409, 'cancelled')
                    for converted in resampler.resample(frame):
                        samples += converted.samples
                        if samples > 60 * 16000:
                            raise VoiceError(413, 'audio-too-long')
                        chunks.append(converted.to_ndarray().flatten())
                for converted in resampler.resample(None):
                    samples += converted.samples
                    if samples > 60 * 16000:
                        raise VoiceError(413, 'audio-too-long')
                    chunks.append(converted.to_ndarray().flatten())
        except VoiceError:
            raise
        except Exception:
            raise VoiceError(400, 'invalid-audio')
        if not samples:
            raise VoiceError(400, 'empty-audio')
        return np.concatenate(chunks).astype(np.float32) / 32768.0, samples / 16000

    def transcribe(self, data, job_id):
        if len(data) > MAX_BYTES:
            raise VoiceError(413, 'audio-too-large')
        if not self.slot.acquire(blocking=False):
            raise VoiceError(429, 'worker-busy')
        cancel = threading.Event()
        try:
            with self.lock:
                if job_id in self.jobs:
                    raise VoiceError(409, 'duplicate-job')
                self.jobs[job_id] = cancel
            audio, duration = self.decoder(data, cancel)
            if duration > 60:
                raise VoiceError(413, 'audio-too-long')
            if cancel.is_set():
                raise VoiceError(409, 'cancelled')
            self.ensure_model()
            def infer():
                if cancel.is_set():
                    raise VoiceError(409, 'cancelled')
                segments, info = self.model.transcribe(audio, beam_size=1, vad_filter=False)
                result = []
                for segment in segments:
                    if cancel.is_set():
                        raise VoiceError(409, 'cancelled')
                    result.append({'start': segment.start, 'end': segment.end, 'text': segment.text})
                return result, info
            try:
                result, info = infer()
            except VoiceError:
                raise
            except RuntimeError:
                if self.device != 'cuda' or cancel.is_set():
                    raise
                self.model = None
                gc.collect()
                self.device = 'cpu'
                self.fallback = 'cuda-inference-failed'
                self.state = 'loading'
                try:
                    self.model = self.loader('cpu')
                    self.state = 'ready'
                    result, info = infer()
                except VoiceError:
                    raise
                except Exception:
                    self.state = 'error'
                    self.model = None
                    raise VoiceError(503, 'cpu-fallback-failed')
            if cancel.is_set():
                raise VoiceError(409, 'cancelled')
            return {'jobId': job_id, 'text': ''.join(s['text'] for s in result).strip(),
                    'language': info.language, 'durationMs': round(duration * 1000), 'segments': result}
        finally:
            with self.lock:
                self.jobs.pop(job_id, None)
            self.last_used = time.monotonic()
            self.slot.release()

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                raise VoiceError(404, 'job-not-found')
            job.set()
        return {'jobId': job_id, 'cancelled': True}

    def load_tts_model(self, device):
        if device != 'cuda':
            raise VoiceError(503, 'tts-gpu-required')
        import torch
        from f5_tts.model import DiT
        from f5_tts.infer.utils_infer import load_model
        from vocos import Vocos

        models_dir = VOICE_HOME / 'models'
        safetensors_path = models_dir / 'habibi-egy' / 'model_100000.safetensors'
        vocab_path = models_dir / 'habibi-egy' / 'vocab.txt'
        vocos_dir = models_dir / 'vocos-mel-24khz'

        if not safetensors_path.is_file() or not vocab_path.is_file() or not vocos_dir.is_dir():
            raise VoiceError(503, 'tts-models-missing')

        model = load_model(DiT, dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4),
                           str(safetensors_path), vocab_file=str(vocab_path), device='cuda')
        vocoder = Vocos.from_hparams(str(vocos_dir / 'config.yaml'))
        state_dict = torch.load(str(vocos_dir / 'pytorch_model.bin'), map_location='cpu', weights_only=True)
        vocoder.load_state_dict(state_dict)
        vocoder = vocoder.eval().to('cuda')
        return model, vocoder

    def ensure_tts_model(self):
        if self.tts_model is not None and self.vocoder is not None:
            return
        if os.environ.get('VOICE_FORCE_CPU') == '1':
            self.tts_state = 'error'
            raise VoiceError(503, 'tts-gpu-required')
        if not self.tts_loader_is_custom:
            try:
                import torch
                if not torch.cuda.is_available():
                    self.tts_state = 'error'
                    raise VoiceError(503, 'tts-gpu-required')
            except ImportError:
                self.tts_state = 'error'
                raise VoiceError(503, 'tts-gpu-required')
        self.tts_state = 'loading'
        try:
            self.tts_model, self.vocoder = self.tts_loader(self.tts_device)
            self.tts_state = 'ready'
        except VoiceError:
            self.tts_state = 'error'
            raise
        except Exception:
            self.tts_state = 'error'
            raise VoiceError(503, 'tts-gpu-required')

    def resolve_voice(self, voice_name):
        if self.voices_data is None:
            if self.voices_path.is_file():
                try:
                    with open(self.voices_path, 'r', encoding='utf-8') as f:
                        self.voices_data = json.load(f)
                except Exception:
                    self.voices_data = {}
            else:
                self.voices_data = {}
        voices = self.voices_data.get('voices', {})
        if voice_name in voices:
            return voice_name, voices[voice_name]
        default_voice = self.voices_data.get('defaults', {}).get('male', 'ori')
        default_info = voices.get(default_voice, {
            'gender': 'male',
            'reference': {'file': 'town.flac', 'exactTranscript': 'The difference in the rainbow depends considerably upon the size of the drops.'},
            'speed': 1.0,
            'pitchSemitones': 0.0,
            'status': 'provisional'
        })
        return default_voice, default_info

    def get_reference_audio(self, voice_name, voice_info):
        return str(VOICE_HOME / 'references' / Path(voice_info.get('reference', {}).get('file', '')).name)

    def real_tts_infer(self, ref_audio, ref_text, chunks, speed, cancel):
        import io
        import soundfile as sf
        import torchaudio
        from f5_tts.infer.utils_infer import infer_batch_process

        if cancel.is_set():
            raise VoiceError(409, 'cancelled')
        if not Path(ref_audio).is_file():
            raise VoiceError(503, 'tts-reference-missing')

        import numpy as np

        audio, sr = torchaudio.load(ref_audio)
        audio = trim_silence(audio, sr)
        ref_seconds = audio.shape[-1] / sr

        class ProgressChecker:
            def tqdm(self, it, *args, **kwargs):
                for item in it:
                    if cancel.is_set():
                        raise VoiceError(409, 'cancelled')
                    yield item

        # F5 sizes the output from UTF-8 byte ratios, which doubles Arabic durations against an English reference.
        # Each chunk gets an explicit duration from its spoken-letter count at a natural Egyptian pace instead.
        pieces, target_sr = [], 24000
        for chunk in chunks:
            gen_seconds = max(0.8, spoken_letters(chunk) / ARABIC_LETTERS_PER_SECOND / max(0.5, speed))
            gen = infer_batch_process(
                (audio, sr), ref_text, [chunk], self.tts_model, self.vocoder, mel_spec_type='vocos',
                progress=ProgressChecker(), nfe_step=16, speed=speed, fix_duration=ref_seconds + gen_seconds,
                device=self.tts_device,
            )
            wave, target_sr, _ = next(gen)
            if cancel.is_set():
                raise VoiceError(409, 'cancelled')
            if wave is None:
                raise VoiceError(500, 'tts-generation-failed')
            if pieces:
                pieces.append(np.zeros(int(0.18 * target_sr), dtype=np.float32))
            pieces.append(np.asarray(wave, dtype=np.float32))
        final_wave = trim_silence_np(np.concatenate(pieces), target_sr)

        out_buf = io.BytesIO()
        sf.write(out_buf, final_wave, target_sr, format='WAV', subtype='PCM_16')
        return out_buf.getvalue()

    def synthesize(self, text, voice, job_id):
        if not isinstance(text, str) or not text.strip():
            raise VoiceError(400, 'empty-text')
        if len(text) > MAX_TEXT_LEN:
            raise VoiceError(400, 'text-too-long')

        resolved_voice, voice_info = self.resolve_voice(voice)
        norm_text = normalize_egyptian_arabic(text)
        if not norm_text.strip():
            norm_text = text.strip()

        # Check LRU cache before acquiring GPU slot
        cache_key = hashlib.sha256(f"{TTS_RENDER_VERSION}:{resolved_voice}:{norm_text}".encode('utf-8')).hexdigest()
        cache_file = self.cache_dir / f"{cache_key}.wav"
        if cache_file.is_file():
            try:
                os.utime(cache_file, None)
                with open(cache_file, 'rb') as f:
                    return f.read()
            except OSError:
                pass

        if not self.slot.acquire(blocking=False):
            raise VoiceError(429, 'worker-busy')

        cancel = threading.Event()
        try:
            with self.lock:
                if job_id in self.jobs:
                    raise VoiceError(409, 'duplicate-job')
                self.jobs[job_id] = cancel

            if cancel.is_set():
                raise VoiceError(409, 'cancelled')

            self.ensure_tts_model()

            if cancel.is_set():
                raise VoiceError(409, 'cancelled')

            ref_audio = self.get_reference_audio(resolved_voice, voice_info)
            ref_text = voice_info.get('reference', {}).get('exactTranscript', '')
            speed = voice_info.get('speed', 1.0)

            chunks = chunk_text(norm_text, max_chars=120)
            wav_bytes = self.tts_infer(ref_audio, ref_text, chunks, speed, cancel)

            try:
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                with open(cache_file, 'wb') as f:
                    f.write(wav_bytes)
                enforce_cache_limit(self.cache_dir, max_bytes=MAX_CACHE_BYTES)
            except OSError:
                pass

            return wav_bytes
        finally:
            with self.lock:
                self.jobs.pop(job_id, None)
            self.last_used = time.monotonic()
            self.slot.release()

    def warmup(self):
        """Loads TTS and renders one short uncached phrase, so the owner's first spoken reply skips CUDA warm-up."""
        if not self.slot.acquire(blocking=False):
            raise VoiceError(429, 'worker-busy')
        try:
            started = time.monotonic()
            self.ensure_tts_model()
            voice, info = self.resolve_voice('ori')
            self.tts_infer(self.get_reference_audio(voice, info), info['reference']['exactTranscript'], ['أهلاً.'], 1.0, threading.Event())
            self.last_used = time.monotonic()
            return {'ok': True, 'seconds': round(time.monotonic() - started, 2)}
        finally:
            self.slot.release()

    def unload(self):
        if not self.slot.acquire(blocking=False):
            raise VoiceError(409, 'worker-busy')
        try:
            self.model = None
            self.tts_model = None
            self.vocoder = None
            gc.collect()
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
            self.state = 'unloaded'
            self.tts_state = 'unloaded'
            return {'state': self.state}
        finally:
            self.slot.release()

    def health(self):
        used = None
        try:
            output = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'],
                                    capture_output=True, text=True, timeout=2, check=True)
            used = int(output.stdout.splitlines()[0])
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            pass
        tts_installed = (VOICE_HOME / 'models' / 'habibi-egy' / 'model_100000.safetensors').is_file()
        return {'models': {'stt': {'state': self.state, 'device': self.device},
                           'tts': {'state': self.tts_state, 'installed': tts_installed, 'device': self.tts_device}},
                'vramUsedMiB': used, 'vramScope': 'whole-gpu', 'fallback': self.fallback}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 4

    def __init__(self, *args, **kwargs):
        self.handlers = threading.BoundedSemaphore(4)
        self.upload = threading.BoundedSemaphore(1)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.handlers.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.handlers.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.handlers.release()

    def service_actions(self):
        worker = self.worker
        has_active = (worker.model is not None) or (worker.tts_model is not None)
        if has_active and time.monotonic() - worker.last_used > worker.idle_seconds:
            try:
                worker.unload()
            except VoiceError:
                pass


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_):
        pass

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def reply_bytes(self, status, content_type, data):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def dispatch(self):
        try:
            host = self.headers.get('Host', '')
            if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'):
                raise VoiceError(403, 'invalid-host')
            if self.headers.get('Origin'):
                raise VoiceError(403, 'browser-origin-forbidden')
            worker = self.server.worker
            if self.command == 'GET' and self.path == '/health':
                return self.reply(200, worker.health())
            if self.command != 'POST':
                raise VoiceError(404, 'not-found')
            if self.path == '/unload':
                return self.reply(200, worker.unload())
            if self.path == '/warmup':
                return self.reply(200, worker.warmup())
            if self.path.startswith('/cancel/'):
                return self.reply(200, worker.cancel(self.path[len('/cancel/'):]))
            if self.path == '/tts':
                if self.headers.get('Transfer-Encoding'):
                    raise VoiceError(400, 'unsupported-transfer-encoding')
                try:
                    size = int(self.headers.get('Content-Length', '-1'))
                except ValueError:
                    raise VoiceError(400, 'invalid-content-length')
                if size < 1:
                    raise VoiceError(400, 'empty-body')
                if size > 65536:
                    raise VoiceError(413, 'payload-too-large')
                raw = self.rfile.read(size)
                try:
                    payload = json.loads(raw.decode('utf-8'))
                except Exception:
                    raise VoiceError(400, 'invalid-json')
                if not isinstance(payload, dict):
                    raise VoiceError(400, 'invalid-json')
                text = payload.get('text')
                voice = payload.get('voice', 'ori')
                job_id = self.headers.get('X-Job-Id') or payload.get('jobId') or uuid.uuid4().hex
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', job_id):
                    raise VoiceError(400, 'invalid-job-id')
                wav_bytes = worker.synthesize(text, voice, job_id)
                return self.reply_bytes(200, 'audio/wav', wav_bytes)
            if self.path != '/stt':
                raise VoiceError(404, 'not-found')
            if self.headers.get('Transfer-Encoding'):
                raise VoiceError(400, 'unsupported-transfer-encoding')
            try:
                size = int(self.headers.get('Content-Length', '-1'))
            except ValueError:
                raise VoiceError(400, 'invalid-content-length')
            if size < 1:
                raise VoiceError(400, 'empty-audio')
            if size > MAX_BYTES:
                raise VoiceError(413, 'audio-too-large')
            if self.headers.get('Content-Type', '').split(';')[0] not in ('audio/wav', 'audio/x-wav', 'audio/webm'):
                raise VoiceError(415, 'unsupported-audio-type')
            job_id = self.headers.get('X-Job-Id') or uuid.uuid4().hex
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', job_id):
                raise VoiceError(400, 'invalid-job-id')
            if not self.server.upload.acquire(blocking=False):
                raise VoiceError(429, 'worker-busy')
            try:
                deadline = time.monotonic() + 15
                data = bytearray()
                while len(data) < size:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise VoiceError(408, 'body-timeout')
                    self.connection.settimeout(remaining)
                    chunk = self.rfile.read1(min(65536, size - len(data)))
                    if not chunk:
                        raise VoiceError(400, 'incomplete-body')
                    data.extend(chunk)
                return self.reply(200, worker.transcribe(data, job_id))
            finally:
                self.server.upload.release()
        except VoiceError as error:
            self.reply(error.status, {'error': error.code})
        except Exception:
            err = 'tts-failed' if self.path == '/tts' else 'stt-failed'
            self.reply(500, {'error': err})

    do_GET = dispatch
    do_POST = dispatch


def main():
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    port = int(sys.argv[1] if len(sys.argv) > 1 else os.environ.get('VOICE_PORT', '4185'))
    if port in (4170, 4172, 4190):
        raise SystemExit('Reserved port')
    server = Server(('127.0.0.1', port), Handler)
    server.worker = VoiceWorker()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
