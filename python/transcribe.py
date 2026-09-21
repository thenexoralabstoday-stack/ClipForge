import sys
import json
import subprocess
import os

hf_token = os.environ.get('HF_TOKEN')
if hf_token:
    os.environ['HUGGING_FACE_HUB_TOKEN'] = hf_token
    os.environ['HF_TOKEN'] = hf_token
    try:
        from huggingface_hub import login
        login(token=hf_token, add_to_git_credential=False)
    except Exception:
        pass

try:
    from faster_whisper import WhisperModel
    HAS_FASTER_WHISPER = True
except Exception:
    HAS_FASTER_WHISPER = False


def extract_audio(video_path, wav_path):
    subprocess.run([
        'ffmpeg', '-y', '-i', video_path,
        '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
        wav_path
    ], check=True, capture_output=True)


def transcribe(audio_or_video, model='small', language='auto'):
    wav = audio_or_video + '.clipforge.wav'
    is_video = not audio_or_video.lower().endswith('.wav')
    if is_video:
        extract_audio(audio_or_video, wav)
        source = wav
    else:
        source = audio_or_video

    if not HAS_FASTER_WHISPER:
        print(json.dumps({'error': 'faster-whisper not installed', 'language': 'en', 'segments': []}))
        sys.exit(0)

    device = 'cpu'
    compute_type = 'int8'
    try:
        import torch
        if torch.cuda.is_available():
            device = 'cuda'
            compute_type = 'float16'
    except Exception:
        pass

    model_obj = WhisperModel(model, device=device, compute_type=compute_type)
    segments_iter, info = model_obj.transcribe(
        source,
        language=None if language == 'auto' else language,
        word_timestamps=True,
        vad_filter=True,
    )

    segments = []
    for seg in segments_iter:
        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    'start': round(w.start, 2),
                    'end': round(w.end, 2),
                    'word': w.word.strip(),
                })
        segments.append({
            'start': round(seg.start, 2),
            'end': round(seg.end, 2),
            'text': seg.text.strip(),
            'words': words,
        })

    result = {
        'language': info.language or 'en',
        'segments': segments,
    }
    print(json.dumps(result, ensure_ascii=False))

    if is_video and os.path.exists(wav):
        os.remove(wav)


if __name__ == '__main__':
    media = sys.argv[1] if len(sys.argv) > 1 else None
    if not media or not os.path.exists(media):
        print(json.dumps({'error': f'Media not found: {media}', 'language': 'en', 'segments': []}))
        sys.exit(0)
    model = 'small'
    language = 'auto'
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == '--model' and i + 1 < len(args):
            model = args[i + 1]
            i += 2
        elif args[i] == '--language' and i + 1 < len(args):
            language = args[i + 1]
            i += 2
        else:
            i += 1
    transcribe(media, model, language)
