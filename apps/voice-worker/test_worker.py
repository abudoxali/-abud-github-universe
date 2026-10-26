"""Offline contract tests; no weights or audio downloads required."""
import http.client
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('voice_worker', Path(__file__).with_name('worker.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WorkerTests(unittest.TestCase):
    def worker(self, **kwargs):
        return module.VoiceWorker(decoder=lambda data, cancel: ([0], 1), **kwargs)

    def test_health(self):
        with patch.object(module.subprocess, 'run', side_effect=OSError):
            value = self.worker().health()
        self.assertEqual(value['models']['stt']['state'], 'unloaded')
        self.assertIsNone(value['vramUsedMiB'])

    def test_model_path_is_external_home(self):
        import sys
        calls = []
        fake = SimpleNamespace(WhisperModel=lambda path, **kwargs: calls.append((path, kwargs)))
        with patch.dict(sys.modules, {'faster_whisper': fake}):
            self.worker().load_model('cpu')
        self.assertEqual(Path(calls[0][0]), module.VOICE_HOME / 'models' / 'large-v3-turbo')
        self.assertTrue(calls[0][1]['local_files_only'])
        self.assertEqual(calls[0][1]['compute_type'], 'int8')

    def test_decode_real_wav_limits(self):
        try:
            import av
        except ImportError:
            self.skipTest('PyAV not installed in this interpreter')
        import io
        import wave
        def wav(seconds):
            buffer = io.BytesIO()
            with wave.open(buffer, 'wb') as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(b'\0\0' * (seconds * 16000))
            return buffer.getvalue()
        worker = module.VoiceWorker()
        audio, duration = worker.decode(wav(1), threading.Event())
        self.assertEqual(len(audio), 16000)
        self.assertEqual(duration, 1)
        with self.assertRaises(module.VoiceError) as ctx:
            worker.decode(wav(61), threading.Event())
        self.assertEqual(ctx.exception.code, 'audio-too-long')

    def test_size(self):
        with self.assertRaises(module.VoiceError) as ctx:
            self.worker().transcribe(b'x' * (module.MAX_BYTES + 1), 'test')
        self.assertEqual(ctx.exception.status, 413)

    def test_duration(self):
        worker = self.worker()
        worker.decoder = lambda *_: ([0], 61)
        with self.assertRaises(module.VoiceError) as ctx:
            worker.transcribe(b'x', 'test')
        self.assertEqual(ctx.exception.code, 'audio-too-long')
        self.assertFalse(worker.slot.locked())

    def test_cpu_forced(self):
        devices = []
        worker = self.worker(loader=lambda device: devices.append(device) or object())
        with patch.dict(module.os.environ, {'VOICE_FORCE_CPU': '1'}):
            worker.ensure_model()
        self.assertEqual(devices, ['cpu'])
        self.assertEqual(worker.state, 'ready')

    def test_cuda_fallback(self):
        def load(device):
            if device == 'cuda':
                raise RuntimeError('no cuda')
            return object()
        worker = self.worker(loader=load)
        with patch.dict(module.os.environ, {'VOICE_FORCE_CPU': '0'}):
            worker.ensure_model()
        self.assertEqual(worker.device, 'cpu')
        self.assertEqual(worker.fallback, 'cuda-unavailable')

    def test_load_error(self):
        worker = self.worker(loader=lambda _: (_ for _ in ()).throw(RuntimeError()))
        with self.assertRaises(module.VoiceError):
            worker.ensure_model()
        self.assertEqual(worker.state, 'error')

    def test_unload(self):
        worker = self.worker()
        worker.model = object()
        self.assertEqual(worker.unload(), {'state': 'unloaded'})
        self.assertIsNone(worker.model)

    def test_busy(self):
        worker = self.worker()
        worker.slot.acquire()
        try:
            with self.assertRaises(module.VoiceError) as ctx:
                worker.transcribe(b'x', 'test')
            self.assertEqual(ctx.exception.status, 429)
            with self.assertRaises(module.VoiceError):
                worker.unload()
        finally:
            worker.slot.release()

    def test_cancel_active(self):
        worker = self.worker()
        entered, release = threading.Event(), threading.Event()
        errors = []
        def decode(data, cancel):
            entered.set()
            release.wait(3)
            return [0], 1
        worker.decoder = decode
        def run():
            try:
                worker.transcribe(b'x', 'active')
            except module.VoiceError as error:
                errors.append(error.code)
        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(entered.wait(3))
        self.assertTrue(worker.cancel('active')['cancelled'])
        release.set()
        thread.join(3)
        self.assertEqual(errors, ['cancelled'])
        self.assertFalse(worker.jobs)

    def test_cancel_missing(self):
        with self.assertRaises(module.VoiceError) as ctx:
            self.worker().cancel('missing')
        self.assertEqual(ctx.exception.status, 404)

    def test_transcription(self):
        segment = SimpleNamespace(start=0, end=1, text=' hello')
        model = SimpleNamespace(transcribe=lambda *_args, **_kwargs: (iter([segment]), SimpleNamespace(language='en')))
        worker = self.worker(loader=lambda _: model)
        result = worker.transcribe(b'x', 'test')
        self.assertEqual(result['text'], 'hello')
        self.assertEqual(result['durationMs'], 1000)

    def test_inference_cpu_fallback(self):
        devices = []
        def load(device):
            devices.append(device)
            def transcribe(*args, **kwargs):
                if device == 'cuda':
                    raise RuntimeError('missing cudnn')
                return iter([]), SimpleNamespace(language='en')
            return SimpleNamespace(transcribe=transcribe)
        worker = self.worker(loader=load)
        with patch.dict(module.os.environ, {'VOICE_FORCE_CPU': '0'}):
            result = worker.transcribe(b'x', 'fallback')
        self.assertEqual(devices, ['cuda', 'cpu'])
        self.assertEqual(worker.fallback, 'cuda-inference-failed')
        self.assertEqual(result['language'], 'en')

    def test_idle_unload(self):
        server = module.Server(('127.0.0.1', 0), module.Handler)
        server.worker = self.worker()
        server.worker.model = object()
        server.worker.last_used = 0
        try:
            server.service_actions()
            self.assertIsNone(server.worker.model)
        finally:
            server.server_close()

    def test_http(self):
        server = module.Server(('127.0.0.1', 0), module.Handler)
        server.worker = self.worker()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for method, path, headers, status in [
                ('GET', '/health', {}, 200),
                ('POST', '/tts', {}, 501),
                ('POST', '/unload', {}, 200),
                ('POST', '/cancel/missing', {}, 404),
                ('POST', '/stt', {'Content-Length': str(module.MAX_BYTES + 1)}, 413),
                ('GET', '/health', {'Origin': 'http://evil.example'}, 403),
                ('GET', '/health', {'Host': 'evil.example'}, 403),
            ]:
                with self.subTest(path=path, status=status):
                    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                    conn.request(method, path, headers=headers)
                    response = conn.getresponse()
                    self.assertEqual(response.status, status)
                    response.read()
                    conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)


if __name__ == '__main__':
    unittest.main()
