"""Download only reviewed STT data artifacts at an immutable revision."""
from pathlib import Path
import os

VOICE_HOME = Path(os.environ.get('VOICE_HOME') or
                  Path(os.environ.get('LOCALAPPDATA', Path.home() / '.local' / 'share')) / 'ABUD-FUN-OS' / 'voice')


def main():
    from huggingface_hub import snapshot_download
    snapshot_download(
        'dropbox-dash/faster-whisper-large-v3-turbo',
        revision='0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf',
        local_dir=VOICE_HOME / 'models' / 'large-v3-turbo',
        allow_patterns=['model.bin', 'config.json', 'tokenizer.json',
                        'preprocessor_config.json', 'vocabulary.json', 'README.md'],
    )


if __name__ == '__main__':
    main()
