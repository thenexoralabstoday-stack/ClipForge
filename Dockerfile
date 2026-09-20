# Copyright (c) 2026 Nexora Labs. All rights reserved.
#
# ClipForge needs more than Node: the pipeline shells out to ffmpeg and ffprobe,
# downloads sources with yt-dlp, and transcribes with faster-whisper. Render's
# native Node image has none of those and its build runs without root, so the
# service is built from this image instead.

FROM node:20-bookworm-slim

# ffmpeg/ffprobe for rendering and probing, python3 for the transcriber,
# curl because the upload helpers call it directly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      curl \
      unzip \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp's YouTube extractor now needs a JavaScript runtime; without one it warns
# and returns incomplete formats. Deno is the runtime yt-dlp enables by default.
RUN ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64) DENO_ARCH=x86_64-unknown-linux-gnu ;; \
      arm64) DENO_ARCH=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported architecture: $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/denoland/deno/releases/latest/download/deno-${DENO_ARCH}.zip" -o /tmp/deno.zip \
 && unzip -q /tmp/deno.zip -d /usr/local/bin \
 && rm /tmp/deno.zip \
 && chmod +x /usr/local/bin/deno

# Debian 12 marks the system Python as externally managed (PEP 668); this image
# is single-purpose, so installing into it directly is fine.
RUN pip3 install --break-system-packages --no-cache-dir \
      yt-dlp \
      faster-whisper

WORKDIR /app

# Dependencies first, so edits to source do not invalidate the npm layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Whisper model weights download on first use. Keep them on a writable path so a
# persistent disk mounted at /app/.cache survives redeploys if one is added.
ENV HF_HOME=/app/.cache/huggingface \
    NODE_ENV=production \
    PORT=10000

EXPOSE 10000

# Fail fast and loudly if a required binary is missing, rather than halfway
# through a customer's job.
RUN ffmpeg -version > /dev/null && ffprobe -version > /dev/null \
 && yt-dlp --version > /dev/null && deno --version > /dev/null \
 && python3 -c "import faster_whisper" \
 && echo "ffmpeg, ffprobe, yt-dlp, deno and faster-whisper all present"

CMD ["node", "src/cli.js", "ui"]
