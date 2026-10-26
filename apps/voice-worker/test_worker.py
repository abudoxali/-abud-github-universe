"""Offline contract tests; no weights or audio downloads required."""
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('voice_worker', Path(__file__).with_name('worker.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WorkerTests(unittest.TestCase):
    def worker(self, **kwargs):
        if 'cache_dir' not in kwargs:
            kwargs['cache_dir'] = Path(tempfile.mkdtemp())
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
        server.worker = self.worker(tts_loader=lambda *_: (object(), object()),
                                    tts_infer=lambda *_: b'RIFFfake')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for method, path, headers, status in [
                ('GET', '/health', {}, 200),
                ('POST', '/tts', {}, 400),
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

            # Test successful TTS HTTP post
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
            payload = json.dumps({'text': 'أهلاً وسهلاً', 'voice': 'ori'}).encode('utf-8')
            conn.request('POST', '/tts', body=payload, headers={'Content-Type': 'application/json', 'Content-Length': str(len(payload))})
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get('Content-Type'), 'audio/wav')
            data = resp.read()
            self.assertEqual(data, b'RIFFfake')
            conn.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)

    def test_tts_validation(self):
        worker = self.worker(tts_loader=lambda *_: (object(), object()),
                             tts_infer=lambda *_: b'RIFFfake')
        # Empty text
        with self.assertRaises(module.VoiceError) as ctx:
            worker.synthesize('', 'ori', 'job1')
        self.assertEqual(ctx.exception.code, 'empty-text')

        # Whitespace text
        with self.assertRaises(module.VoiceError) as ctx:
            worker.synthesize('   ', 'ori', 'job2')
        self.assertEqual(ctx.exception.code, 'empty-text')

        # Text too long (> 400 chars)
        with self.assertRaises(module.VoiceError) as ctx:
            worker.synthesize('أ' * 401, 'ori', 'job3')
        self.assertEqual(ctx.exception.code, 'text-too-long')

    def test_tts_unknown_voice_fallback(self):
        calls = []
        def fake_infer(ref_audio, ref_text, chunks, speed, cancel):
            calls.append((ref_audio, speed))
            return b'RIFFfake'

        worker = self.worker(tts_loader=lambda *_: (object(), object()),
                             tts_infer=fake_infer)

        # Unknown voice name should fallback to default (ori for male/unknown)
        res = worker.synthesize('مرحباً', 'unknown_agent_xyz', 'job_fallback')
        self.assertEqual(res, b'RIFFfake')
        self.assertTrue(len(calls) > 0)

    def test_tts_cancel_active(self):
        entered = threading.Event()
        release = threading.Event()
        def slow_infer(ref_audio, ref_text, chunks, speed, cancel):
            entered.set()
            release.wait(3)
            if cancel.is_set():
                raise module.VoiceError(409, 'cancelled')
            return b'RIFFfake'

        worker = self.worker(tts_loader=lambda *_: (object(), object()),
                             tts_infer=slow_infer)
        errors = []
        def run():
            try:
                worker.synthesize('نص تجريبي للالغاء', 'ori', 'tts_cancel_job')
            except module.VoiceError as err:
                errors.append(err.code)

        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(entered.wait(3))
        cancel_resp = worker.cancel('tts_cancel_job')
        self.assertTrue(cancel_resp['cancelled'])
        release.set()
        thread.join(3)
        self.assertEqual(errors, ['cancelled'])
        self.assertFalse(worker.jobs)

    def test_tts_cache_hit(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            call_count = [0]
            def counting_infer(*_):
                call_count[0] += 1
                return b'RIFFfakecached'

            worker = self.worker(tts_loader=lambda *_: (object(), object()),
                                 tts_infer=counting_infer,
                                 cache_dir=Path(tmp_dir))

            # First call -> invokes infer
            res1 = worker.synthesize('أهلاً بكم في عبود فن', 'ori', 'cache1')
            self.assertEqual(res1, b'RIFFfakecached')
            self.assertEqual(call_count[0], 1)

            # Second call identical text and voice -> cache hit (infer not called)
            res2 = worker.synthesize('أهلاً بكم في عبود فن', 'ori', 'cache2')
            self.assertEqual(res2, b'RIFFfakecached')
            self.assertEqual(call_count[0], 1)

    def test_warmup_renders_once_without_cache(self):
        calls = []
        worker = self.worker(tts_loader=lambda *_: (object(), object()),
                             tts_infer=lambda *args: calls.append(args) or b'RIFFwarm')
        self.assertTrue(worker.warmup()['ok'])
        worker.warmup()
        self.assertEqual(len(calls), 2)
        self.assertTrue(worker.slot.acquire(blocking=False))
        worker.slot.release()

    def test_voices_json_schema(self):
        voices_path = Path(__file__).resolve().parent / 'voices.json'
        self.assertTrue(voices_path.is_file())
        with open(voices_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        self.assertIn('voices', data)
        self.assertIn('defaults', data)
        self.assertEqual(set(data['defaults'].keys()), {'male', 'female'})

        expected_voices = {'ori', 'mia', 'nex', 'luna', 'zen', 'rex'}
        self.assertEqual(set(data['voices'].keys()), expected_voices)

        for name, v in data['voices'].items():
            self.assertIn(v['gender'], ('male', 'female'))
            self.assertIn('character', v)
            self.assertIn('reference', v)
            ref = v['reference']
            self.assertIn('file', ref)
            self.assertIn('exactTranscript', ref)
            self.assertIn('source', ref)
            self.assertEqual(ref['license'], 'Apache-2.0')
            # Identities must come from synthetic speakers, never from recordings of identifiable people.
            self.assertTrue(ref['file'].startswith('kokoro_') and ref['kokoroVoice'])
            self.assertIn('synthetic', ref['provenance'].lower())
            self.assertIn('speed', v)
            self.assertIn('pitchSemitones', v)
            self.assertEqual(v['status'], 'provisional')
            self.assertTrue(len(v['statusReason']) > 10)

    def test_normalization_egyptian_arabic(self):
        from normalize_ar import normalize_egyptian_arabic

        # Number conversion
        self.assertIn('ميتين وخمسين', normalize_egyptian_arabic('250'))
        self.assertIn('خمستاشر', normalize_egyptian_arabic('15'))

        # Percentage
        self.assertIn('خمسين في المية', normalize_egyptian_arabic('50%'))

        # Agent & company names
        self.assertIn('أوري', normalize_egyptian_arabic('ORI'))
        self.assertIn('ميا', normalize_egyptian_arabic('MIA'))
        self.assertIn('نِكس', normalize_egyptian_arabic('NEX'))
        self.assertIn('لونا', normalize_egyptian_arabic('LUNA'))
        self.assertIn('زِن', normalize_egyptian_arabic('ZEN'))
        self.assertIn('ريكس', normalize_egyptian_arabic('REX'))
        self.assertIn('عبود فن', normalize_egyptian_arabic('ABUD FUN'))
        self.assertIn('أومني راوت', normalize_egyptian_arabic('OmniRoute'))

        # Markdown and links
        res = normalize_egyptian_arabic('[الرابط هنا](https://example.com/test) و **مهم جداً**')
        self.assertNotIn('https://', res)
        self.assertNotIn('**', res)
        self.assertIn('الرابط هنا', res)
        self.assertIn('مهم جداً', res)

        # Dates
        self.assertIn('أكتوبر', normalize_egyptian_arabic('2026/10/26'))


if __name__ == '__main__':
    unittest.main()
