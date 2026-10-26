"""Measure real offline inference and loopback HTTP; keep results outside the repo."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.request

spec = importlib.util.spec_from_file_location('voice_worker', Path(__file__).with_name('worker.py'))
worker_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_module)


def memory():
    try:
        result = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'],
                                capture_output=True, text=True, check=True, timeout=2)
        return int(result.stdout.splitlines()[0])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def main():
    clip = Path(sys.argv[1])
    data = clip.read_bytes()
    worker = worker_module.VoiceWorker()
    baseline = memory()
    samples = []
    stop = threading.Event()
    def sample():
        while not stop.is_set():
            samples.append(memory())
            stop.wait(0.1)
    server = worker_module.Server(('127.0.0.1', 4185), worker_module.Handler)
    sampler = threading.Thread(target=sample)
    sampler.start()
    server.worker = worker
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        start = time.perf_counter()
        worker.ensure_model()
        load_seconds = time.perf_counter() - start
        runs = []
        for index in range(4):
            request = urllib.request.Request('http://127.0.0.1:4185/stt', data=data,
                                            headers={'Content-Type': 'audio/wav', 'X-Job-Id': f'bench-{index}'})
            start = time.perf_counter()
            with urllib.request.urlopen(request, timeout=600) as response:
                result = json.load(response)
            elapsed = time.perf_counter() - start
            runs.append({'seconds': elapsed, 'rtf': elapsed / (result['durationMs'] / 1000), 'result': result})
        stop.set()
        sampler.join()
        worker.unload()
        time.sleep(2)
        model_name = os.environ.get('VOICE_MODEL', 'large-v3-turbo')
        report = {'model': model_name, 'device': worker.device, 'fallback': worker.fallback,
                  'loadSeconds': load_seconds, 'baselineMiB': baseline,
                  'peakMiB': max((value for value in samples if value is not None), default=None), 'afterUnloadMiB': memory(), 'sampleCount': len(samples),
                  'runs': runs, 'clip': clip.name}
        destination = worker_module.VOICE_HOME / 'tmp' / f'benchmark-{model_name}-{worker.device}.json'
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=True, indent=2))
    finally:
        stop.set()
        sampler.join()
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
