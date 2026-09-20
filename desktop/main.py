# ClipForge Desktop — local video -> captioned Shorts/Reels/TikToks
# Copyright (c) 2026 Nexora Labs. All rights reserved.
# Contact: thenexoralabstoday@gmail.com

import customtkinter as ctk
import tkinter as tk
from tkinter import filedialog, messagebox
import threading
import os
import sys
import json
import time
import subprocess
import shutil
from pathlib import Path

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")


class ClipForgeDesktop(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("ClipForge Desktop")
        self.geometry("900x700")
        self.minsize(700, 500)

        self.source_type = ctk.StringVar(value="url")
        self.url_value = ctk.StringVar()
        self.file_path = ctk.StringVar()
        self.output_dir = ctk.StringVar(value=str(Path.home() / "ClipForge" / "output"))
        self.clips_count = ctk.StringVar(value="5")
        self.min_duration = ctk.StringVar(value="20")
        self.max_duration = ctk.StringVar(value="60")
        self.style = ctk.StringVar(value="classic")
        self.status = ctk.StringVar(value="Ready")
        self.progress = ctk.DoubleVar(value=0)
        self.running = False

        self._build_ui()

    def _build_ui(self):
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(0, weight=1)

        scroll = ctk.CTkScrollableFrame(self, corner_radius=0)
        scroll.grid(row=0, column=0, sticky="nsew")
        scroll.grid_columnconfigure(1, weight=1)

        row = 0

        # Title
        title = ctk.CTkLabel(scroll, text="ClipForge Desktop", font=ctk.CTkFont(size=24, weight="bold"))
        title.grid(row=row, column=0, columnspan=2, sticky="w", padx=24, pady=(24, 4))
        row += 1

        subtitle = ctk.CTkLabel(scroll, text="Convert long-form videos into short, captioned clips.", font=ctk.CTkFont(size=13), text_color="gray")
        subtitle.grid(row=row, column=0, columnspan=2, sticky="w", padx=24, pady=(0, 20))
        row += 1

        # Source section
        src_lbl = ctk.CTkLabel(scroll, text="Source", font=ctk.CTkFont(size=16, weight="bold"))
        src_lbl.grid(row=row, column=0, columnspan=2, sticky="w", padx=24, pady=(8, 8))
        row += 1

        seg = ctk.CTkSegmentedButton(scroll, values=["Video URL", "Upload file"], variable=self.source_type, command=self._on_source_change)
        seg.grid(row=row, column=0, columnspan=2, sticky="ew", padx=24, pady=(0, 12))
        row += 1

        self.url_entry = ctk.CTkEntry(scroll, textvariable=self.url_value, placeholder_text="Paste YouTube, TikTok, Instagram, VK, Google Drive, or direct video URL")
        self.url_entry.grid(row=row, column=0, columnspan=2, sticky="ew", padx=24, pady=(0, 8))
        row += 1

        self.file_entry = ctk.CTkEntry(scroll, textvariable=self.file_path, placeholder_text="Select a video file from your PC")
        self.file_entry.grid(row=row, column=0, sticky="ew", padx=(24, 8), pady=(0, 8))
        row += 1

        file_btn = ctk.CTkButton(scroll, text="Browse", command=self._browse_file, width=100)
        file_btn.grid(row=row - 1, column=1, sticky="e", padx=(8, 24), pady=(0, 8))
        self._set_url_visible(True)

        # Settings section
        set_lbl = ctk.CTkLabel(scroll, text="Settings", font=ctk.CTkFont(size=16, weight="bold"))
        set_lbl.grid(row=row, column=0, columnspan=2, sticky="w", padx=24, pady=(16, 8))
        row += 1

        grid = ctk.CTkFrame(scroll, fg_color="transparent")
        grid.grid(row=row, column=0, columnspan=2, sticky="ew", padx=24)
        grid.grid_columnconfigure(1, weight=1)
        grid.grid_columnconfigure(3, weight=1)
        row += 1

        ctk.CTkLabel(grid, text="Output folder").grid(row=0, column=0, sticky="w", padx=(0, 8))
        out_entry = ctk.CTkEntry(grid, textvariable=self.output_dir)
        out_entry.grid(row=0, column=1, sticky="ew", padx=(0, 8))
        ctk.CTkButton(grid, text="Browse", command=self._browse_output, width=80).grid(row=0, column=2, padx=(0, 8))
        ctk.CTkButton(grid, text="Open", command=self._open_output, width=60).grid(row=0, column=3)

        ctk.CTkLabel(grid, text="Clips").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ctk.CTkEntry(grid, textvariable=self.clips_count, width=80).grid(row=1, column=1, sticky="w", padx=(0, 8), pady=(8, 0))

        ctk.CTkLabel(grid, text="Min duration (s)").grid(row=2, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ctk.CTkEntry(grid, textvariable=self.min_duration, width=80).grid(row=2, column=1, sticky="w", padx=(0, 8), pady=(8, 0))

        ctk.CTkLabel(grid, text="Max duration (s)").grid(row=3, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        ctk.CTkEntry(grid, textvariable=self.max_duration, width=80).grid(row=3, column=1, sticky="w", padx=(0, 8), pady=(8, 0))

        ctk.CTkLabel(grid, text="Caption style").grid(row=4, column=0, sticky="w", padx=(0, 8), pady=(8, 0))
        style_menu = ctk.CTkOptionMenu(grid, variable=self.style, values=["classic", "karaoke", "bold-pop", "none"])
        style_menu.grid(row=4, column=1, sticky="w", padx=(0, 8), pady=(8, 0))

        # Actions
        self.start_btn = ctk.CTkButton(scroll, text="Start processing", command=self._start, height=40, font=ctk.CTkFont(size=14, weight="bold"))
        self.start_btn.grid(row=row, column=0, columnspan=2, sticky="ew", padx=24, pady=(20, 8))
        row += 1

        self.progress_bar = ctk.CTkProgressBar(scroll, variable=self.progress)
        self.progress_bar.grid(row=row, column=0, columnspan=2, sticky="ew", padx=24, pady=(0, 8))
        row += 1

        self.status_lbl = ctk.CTkLabel(scroll, textvariable=self.status, text_color="gray")
        self.status_lbl.grid(row=row, column=0, columnspan=2, sticky="w", padx=24, pady=(0, 12))
        row += 1

        # Log
        log_lbl = ctk.CTkLabel(scroll, text="Log", font=ctk.CTkFont(size=16, weight="bold"))
        log_lbl.grid(row=row, column=0, columnspan=2, sticky="w", padx=24, pady=(8, 8))
        row += 1

        self.log_text = ctk.CTkTextbox(scroll, height=220, font=ctk.CTkFont(family="Consolas", size=11))
        self.log_text.grid(row=row, column=0, columnspan=2, sticky="nsew", padx=24, pady=(0, 24))
        scroll.grid_rowconfigure(row, weight=1)
        row += 1

        self._log("ClipForge Desktop ready.")
        self._log("Make sure yt-dlp, faster-whisper and ffmpeg are installed.")

    def _set_url_visible(self, visible):
        if visible:
            self.url_entry.grid()
            self.file_entry.grid_remove()
            self.file_entry.grid(row=10, column=0, sticky="ew", padx=(24, 8), pady=(0, 8))
        else:
            self.url_entry.grid_remove()
            self.file_entry.grid()

    def _on_source_change(self, value):
        if value == "Video URL":
            self._set_url_visible(True)
        else:
            self._set_url_visible(False)

    def _browse_file(self):
        path = filedialog.askopenfilename(filetypes=[("Video", "*.mp4 *.mkv *.mov *.webm"), ("All files", "*.*")])
        if path:
            self.file_path.set(path)

    def _browse_output(self):
        path = filedialog.askdirectory()
        if path:
            self.output_dir.set(path)

    def _open_output(self):
        path = self.output_dir.get()
        if not os.path.isdir(path):
            messagebox.showinfo("Output", f"Folder does not exist yet:\n{path}")
            return
        if sys.platform == "win32":
            os.startfile(path)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])

    def _log(self, text):
        ts = time.strftime("%H:%M:%S")
        self.log_text.insert("end", f"[{ts}] {text}\n")
        self.log_text.see("end")

    def _set_progress(self, value, status=None):
        self.progress.set(max(0.0, min(1.0, value)))
        if status:
            self.status.set(status)
            self._log(status)

    def _validate(self):
        if self.source_type.get() == "url":
            url = self.url_value.get().strip()
            if not url:
                messagebox.showerror("Missing input", "Paste a video URL first.")
                return None
            return url
        else:
            f = self.file_path.get().strip()
            if not f or not os.path.isfile(f):
                messagebox.showerror("Missing file", "Choose a video file first.")
                return None
            return f

    def _start(self):
        if self.running:
            return
        src = self._validate()
        if not src:
            return

        out = self.output_dir.get().strip()
        if not out:
            messagebox.showerror("Missing output", "Choose an output folder.")
            return
        os.makedirs(out, exist_ok=True)

        try:
            clips = int(self.clips_count.get())
            min_d = int(self.min_duration.get())
            max_d = int(self.max_duration.get())
        except ValueError:
            messagebox.showerror("Invalid settings", "Clips, min duration, and max duration must be numbers.")
            return

        self.running = True
        self.start_btn.configure(state="disabled")
        self.log_text.delete("1.0", "end")
        self._set_progress(0, "Starting…")

        thread = threading.Thread(target=self._run_pipeline, args=(src, out, clips, min_d, max_d), daemon=True)
        thread.start()

    def _run_pipeline(self, src, out, clips, min_d, max_d):
        try:
            workdir = os.path.join(out, f"job_{int(time.time())}")
            os.makedirs(workdir, exist_ok=True)
            self._log(f"Job folder: {workdir}")

            # Step 1: download / copy
            self._set_progress(0.05, "Downloading / copying source…")
            if os.path.isfile(src):
                import shutil
                dest = os.path.join(workdir, os.path.basename(src))
                shutil.copy2(src, dest)
                source_file = dest
            else:
                source_file = self._download(src, workdir)

            # Step 2: transcribe
            self._set_progress(0.25, "Transcribing audio…")
            transcript = self._transcribe(source_file, workdir)

            # Step 3: pick highlights
            self._set_progress(0.55, "Picking highlights…")
            highlight_clips = self._pick_highlights(transcript, clips, min_d, max_d)

            # Step 4: render
            self._set_progress(0.7, "Rendering clips…")
            rendered = self._render_clips(source_file, highlight_clips, workdir)

            self._set_progress(1.0, f"Done. {len(rendered)} clips ready in:\n{workdir}")
            messagebox.showinfo("ClipForge", f"Done. {len(rendered)} clips rendered.\nOutput: {workdir}")
        except Exception as e:
            self._set_progress(0, f"Error: {e}")
            messagebox.showerror("Error", str(e))
        finally:
            self.running = False
            self.start_btn.configure(state="normal")

    def _download(self, url, workdir):
        ytdlp = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
        if not ytdlp:
            raise RuntimeError("yt-dlp not found. Install it with: pip install yt-dlp")
        out_template = os.path.join(workdir, "source.%(ext)s")
        args = [
            ytdlp,
            "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
            "--merge-output-format", "mp4",
            "--write-info-json",
            "--write-auto-subs",
            "--write-subs",
            "--sub-langs", "en.*,en",
            "--sub-format", "json3",
            "--no-playlist",
            "-o", out_template,
            url,
        ]
        proc = subprocess.run(args, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"Download failed:\n{proc.stderr[-2000:] or proc.stdout[-2000:]}")
        for f in os.listdir(workdir):
            if f.startswith("source.") and f.endswith((".mp4", ".mkv", ".webm")):
                return os.path.join(workdir, f)
        raise RuntimeError("Download finished but no source video file was found.")

    def _transcribe(self, source_file, workdir):
        try:
            from faster_whisper import WhisperModel
        except Exception as e:
            raise RuntimeError(f"faster-whisper import failed: {e}. Install with: pip install faster-whisper")

        model_size = "small"
        self._log(f"Loading Whisper model: {model_size}")
        try:
            model = WhisperModel(model_size, device="cpu", compute_type="int8")
        except Exception as e:
            raise RuntimeError(f"Failed to load Whisper model: {e}")

        self._log("Transcribing…")
        segments, info = model.transcribe(source_file, beam_size=5)
        segments = list(segments)
        transcript = {
            "language": info.language,
            "duration": info.duration,
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text}
                for s in segments
            ],
        }
        with open(os.path.join(workdir, "transcript.json"), "w", encoding="utf-8") as f:
            json.dump(transcript, f, indent=2)
        self._log(f"Transcription done: {len(transcript['segments'])} segments, language={info.language}")
        return transcript

    def _pick_highlights(self, transcript, count, min_d, max_d):
        segs = transcript.get("segments", [])
        if not segs:
            return []
        scored = []
        for i, s in enumerate(segs):
            score = 50
            text = (s.get("text") or "").strip()
            if text.endswith(("!", "?", "‼️", "?")):
                score += 20
            if any(k in text.lower() for k in ["amazing", "incredible", "secret", "hack", "mistake", "fail", "shock", "unbelievable", "crazy", "insane"]):
                score += 25
            if s.get("end", 0) - s.get("start", 0) < 3:
                score += 10
            scored.append({**s, "score": score, "idx": i})

        scored.sort(key=lambda x: x["score"], reverse=True)
        selected = []
        used = []
        for item in scored:
            if len(selected) >= count:
                break
            start = item["start"]
            end = item["end"]
            dur = end - start
            if dur < min_d:
                adj_end = start + min_d
                if adj_end > transcript.get("duration", end):
                    adj_end = transcript.get("duration", end)
                end = min(end, adj_end)
            if end - start > max_d:
                end = start + max_d
            if any(end > u[0] and start < u[1] for u in used):
                continue
            selected.append({"start": start, "end": end, "score": item["score"], "text": item.get("text", "")})
            used.append((start, end))

        selected.sort(key=lambda x: x["start"])
        return selected

    def _render_clips(self, source_file, clips, workdir):
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg not found. Install ffmpeg and make sure it's on PATH.")
        out = []
        clips_dir = os.path.join(workdir, "clips")
        os.makedirs(clips_dir, exist_ok=True)
        for i, clip in enumerate(clips, 1):
            start = max(0, clip["start"])
            end = clip["end"]
            dur = max(0.1, end - start)
            out_file = os.path.join(clips_dir, f"clip_{i:02d}.mp4")
            proc = subprocess.run([
                "ffmpeg", "-y", "-ss", str(start), "-i", source_file, "-t", str(dur),
                "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-c:a", "aac", "-b:a", "192k",
                out_file
            ], capture_output=True, text=True)
            if proc.returncode != 0:
                raise RuntimeError(f"Failed to render clip {i}: {proc.stderr[-1500:]}")
            self._log(f"Rendered clip {i}: {out_file}")
            out.append(out_file)
            self._set_progress(0.7 + 0.3 * (i / max(len(clips), 1)), f"Rendered clip {i}/{len(clips)}")
        return out


def main():
    app = ClipForgeDesktop()
    app.mainloop()


if __name__ == "__main__":
    main()
