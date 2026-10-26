"""Loopback-only, offline STT with one bounded inference slot."""
import gc
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


class VoiceError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


class VoiceWorker:
    def __init__(self, loader=None, decoder=None):
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

    def unload(self):
        if not self.slot.acquire(blocking=False):
            raise VoiceError(409, 'worker-busy')
        try:
            self.model = None
            gc.collect()
            self.state = 'unloaded'
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
        return {'models': {'stt': {'state': self.state, 'device': self.device},
                           'tts': {'state': 'unloaded', 'installed': False}},
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
        if worker.model is not None and time.monotonic() - worker.last_used > worker.idle_seconds:
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
            if self.path == '/tts':
                raise VoiceError(501, 'tts-not-installed')
            if self.path == '/unload':
                return self.reply(200, worker.unload())
            if self.path.startswith('/cancel/'):
                return self.reply(200, worker.cancel(self.path[len('/cancel/'):]))
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
            self.reply(500, {'error': 'stt-failed'})

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
