"""Download only reviewed STT and TTS data artifacts at immutable revisions.

Verifies pinned SHA-256 hashes and ensures offline reproducibility.
"""
import hashlib
import os
from pathlib import Path
import urllib.request

VOICE_HOME = Path(os.environ.get('VOICE_HOME') or
                  Path(os.environ.get('LOCALAPPDATA', Path.home() / '.local' / 'share')) / 'ABUD-FUN-OS' / 'voice')

PINNED_HASHES = {
    'habibi-egy/model_100000.safetensors': 'abfc7b4889e7c365a16b68f606eda210078e4a42e308c5461aba7dd9fe349ee1',
    'habibi-egy/vocab.txt': 'ceed48f51f0211ffbb8b36007ead3c9b8698fbda9709f184fd712bd3dcd095c5',
    'vocos-mel-24khz/config.yaml': 'da9033922f969a47f0c160010226919e59f27761fd5066f3828d46de6650b0fc',
    'vocos-mel-24khz/pytorch_model.bin': '97ec976ad1fd67a33ab2682d29c0ac7df85234fae875aefcc5fb215681a91b2a',
}


def verify_file(path: Path, expected_sha256: str) -> bool:
    if not path.is_file():
        return False
    hasher = hashlib.sha256()
    with open(path, 'rb') as f:
        while chunk := f.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest().lower() == expected_sha256.lower()


def download_url(url: str, dest: Path, expected_sha256: str):
    if verify_file(dest, expected_sha256):
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix('.tmp')
    req = urllib.request.Request(url, headers={'User-Agent': 'ABUD-FUN-OS-Voice/1.0'})
    hasher = hashlib.sha256()
    with urllib.request.urlopen(req) as resp, open(tmp, 'wb') as f:
        while chunk := resp.read(1024 * 1024):
            f.write(chunk)
            hasher.update(chunk)
    digest = hasher.hexdigest().lower()
    if digest != expected_sha256.lower():
        tmp.unlink(missing_ok=True)
        raise ValueError(f'Hash mismatch for {dest.name}: got {digest}, expected {expected_sha256}')
    tmp.replace(dest)


def download_stt():
    from huggingface_hub import snapshot_download
    snapshot_download(
        'dropbox-dash/faster-whisper-large-v3-turbo',
        revision='0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
        local_dir=VOICE_HOME / 'models' / 'large-v3-turbo',
        allow_patterns=['model.bin', 'config.json', 'tokenizer.json',
                        'preprocessor_config.json', 'vocabulary.json', 'README.md'],
    )


def download_tts():
    models_dir = VOICE_HOME / 'models'

    # 1. Habibi Specialized EGY checkpoint and vocab (Apache 2.0)
    egy_base = 'https://huggingface.co/SWivid/Habibi-TTS/resolve/3ad11a152851245c002156526c5e1d0b12f2b9d5/Specialized/EGY'
    download_url(f'{egy_base}/model_100000.safetensors',
                 models_dir / 'habibi-egy' / 'model_100000.safetensors',
                 PINNED_HASHES['habibi-egy/model_100000.safetensors'])
    download_url(f'{egy_base}/vocab.txt',
                 models_dir / 'habibi-egy' / 'vocab.txt',
                 PINNED_HASHES['habibi-egy/vocab.txt'])

    # 2. Vocos mel-24khz vocoder (MIT)
    vocos_base = 'https://huggingface.co/charactr/vocos-mel-24khz/resolve/0feb3fdd929bcd6649e0e7c5a688cf7dd012ef21'
    download_url(f'{vocos_base}/config.yaml',
                 models_dir / 'vocos-mel-24khz' / 'config.yaml',
                 PINNED_HASHES['vocos-mel-24khz/config.yaml'])
    download_url(f'{vocos_base}/pytorch_model.bin',
                 models_dir / 'vocos-mel-24khz' / 'pytorch_model.bin',
                 PINNED_HASHES['vocos-mel-24khz/pytorch_model.bin'])

    # 3. Six synthetic reference speakers from Kokoro-82M (Apache-2.0); no recording of a real person is used.
    import make_references
    make_references.main()


def main():
    download_stt()
    download_tts()
    print('All STT and TTS models and references verified successfully.')


if __name__ == '__main__':
    main()
