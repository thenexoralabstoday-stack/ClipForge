# ClipForge

Copyright (c) 2026 Nexora Labs. All rights reserved.  
Contact: thenexoralabstoday@gmail.com

Turn long videos into captioned vertical Shorts, Reels and TikToks. Runs on your machine, no cloud required.

## Install

### Prerequisites
- Node.js 20+ and npm 10+
- Python 3.12 with pip
- ffmpeg 8+ on PATH (gyan.dev full build recommended for libass/fontconfig)
- yt-dlp (`pip install yt-dlp`)

### Setup
```bash
git clone <repo> && cd ClipForge
cp .env.example .env   # set ANTHROPIC_API_KEY if you have one
npm install
```

## Usage

```bash
# Run the web UI
npm run ui

# Or use the CLI directly
npx clipforge run "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --clips 5

# Or with options
npx clipforge run ./video.mp4 --clips 3 --min 30 --max 60 --style bold-pop

# Just transcribe
npx clipforge transcribe ./video.mp4

# Re-run AI picker on existing workdir
npx clipforge pick ./output/my-video

# Re-render all clips (e.g. after editing clips.json)
npx clipforge render ./output/my-video

# Start the local web UI
npx clipforge ui
```

## How it works

1. **Download** - yt-dlp fetches the best mp4 ≤1080p and optional captions.
2. **Transcribe** - faster-whisper produces word-level timestamps (falls back to yt-dlp json3 captions).
3. **Pick highlights** - Claude (or a local heuristic if no API key) chooses self-contained viral moments.
4. **Captions** - builds .ass subtitle files with karaoke / classic / bold-pop styles.
5. **Render** - ffmpeg cuts, reframes to 1080x1920, burns captions, adds title card, progress bar, loudness normalise.

## Editing and re-rendering

After a run, edit `clips.json` in the workdir to adjust start/end/title, then:

```bash
npx clipforge render ./output/my-video
```

## Output

```
<out>/<slug>/
  source.mp4
  source.info.json
  transcript.json
  transcript.srt
  transcript.txt
  clips.json
  post.md
  clips/
    clip-01.mp4
    clip-01.ass
    clip-01.jpg
    ...
```

## Legal note

Only clip videos you own or have explicit permission to reuse. YouTube and other platforms demonetise reused content without transformation. Add your own commentary, captions or voice-over. The tool warns when a video is not Creative Commons licensed, but compliance is your responsibility.

## Troubleshooting

- **Font not found**: Install Montserrat (Google Fonts) or the tool falls back to Arial.
- **yt-dlp 403**: `pip install -U yt-dlp`
- **Slow transcription**: use `--model tiny` or `--model base`.
- **ffmpeg not found**: ensure ffmpeg is on PATH.

## Monetization

ClipForge is designed as a local-first tool with optional SaaS monetization:

### Pricing Tiers
- **Free**: 60 min/month, watermark on exports, heuristic or Groq AI
- **Starter ($19/mo)**: 150 min/month, no watermark, Claude AI, priority support
- **Pro ($49/mo)**: 500 min/month, API access, custom branding, white-label option

### Setup for SaaS
1. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in `.env`
2. Create products/prices in Stripe dashboard matching the plan IDs: `starter`, `pro`
3. Set `JWT_SECRET` to a secure random string
4. Run the UI server: `npm run ui` (Express + vanilla JS, no build step)
5. Visit `http://localhost:5173/billing` to test plans

### Revenue Model
- Subscription-based with minute metering
- Gross margin > 80% when using rented GPU workers for transcription
- Upsell path: Free → Starter → Pro → Enterprise

## Environment variables

See `.env.example`. Set either `ANTHROPIC_API_KEY` or `GROQ_API_KEY` for AI highlight picking. If neither is set, ClipForge falls back to a local heuristic picker automatically.

## AI providers

- **Anthropic (default)** — uses Claude Opus 5 via `@anthropic-ai/sdk`. Set `ANTHROPIC_API_KEY`.
- **Groq** — fast inference, free tier available. Set `GROQ_API_KEY` and pass `--provider groq` or select “groq” in the UI. Uses Llama 3.3 70B on Groq’s infrastructure.

## Troubleshooting

- **Font not found**: Install Montserrat (Google Fonts) or the tool falls back to Arial.
- **yt-dlp 403**: `pip install -U yt-dlp`
- **Slow transcription**: use `--model tiny` or `--model base`.
- **ffmpeg not found**: ensure ffmpeg is on PATH.
- **Groq rate limit**: Groq free tier has limits. Wait a minute and retry, or upgrade to Groq paid tier.

## Deployment to Render

1. Push this repo to GitHub
2. Create a new Web Service on Render pointing at the repo
3. Set build command: `npm install`
4. Set start command: `node src/cli.js ui`
5. Add all environment variables from `.env.example`
6. Set `BASE_URL` to your Render domain (e.g. `https://clipforge.onrender.com`)
7. Update OAuth redirect URIs in Google/TikTok/Meta dashboards to match your Render URL

### Stripe Setup

1. Create products/prices in Stripe dashboard matching plan IDs: `starter`, `pro`
2. Set webhook endpoint in Stripe to: `https://your-app.onrender.com/api/stripe/webhook`
3. Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to Render env vars

### Persistent Storage

Render’s filesystem is ephemeral. For production use, configure:
- Render Persistent Disk for `./output` and `./data`
- Or replace local storage with S3/R2 for clips and assets
