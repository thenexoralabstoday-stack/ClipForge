# ClipForge Desktop

Local desktop version of ClipForge. Runs entirely on your PC.

## Requirements

- Python 3.9+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [ffmpeg](https://ffmpeg.org/)
- CustomTkinter GUI dependencies

## Install

```bash
pip install -r requirements.txt
```

## Run

```bash
python main.py
```

## Notes

- The first run downloads the Whisper model (~140 MB for `small`).
- Rendering uses `ffmpeg`; make sure it’s on PATH.
- Downloads use `yt-dlp`, which supports YouTube, TikTok, Instagram, VK, and many more.
