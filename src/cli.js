#!/usr/bin/env node
// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline, transcribeOnly, pickOnly, renderOnly } from './pipeline.js';
import { log } from './util.js';
import { uploadClip, getYouTubeAuthUrl, exchangeYouTubeCode, getTikTokAuthUrl, exchangeTikTokCode, getInstagramAuthUrl, exchangeInstagramCode } from './uploads.js';

function parseArgs(args) {
  const out = { _: [], cmd: null, opts: {} };
  const cmds = ['run', 'transcribe', 'pick', 'render', 'ui', 'batch'];
  let i = 0;
  if (i < args.length && cmds.includes(args[i])) {
    out.cmd = args[i++];
  }
  while (i < args.length) {
    const a = args[i++];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i < args.length && !args[i].startsWith('--')) {
        out.opts[key] = args[i++];
      } else {
        out.opts[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const { cmd, opts, _: positional } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  if (!cmd) {
    printHelp();
    process.exit(1);
  }
  if (cmd === 'ui') {
    startUiCmd();
    return;
  }
  if (cmd === 'auth') {
    const platform = positional[0];
    if (!platform) { log('error: provide platform (youtube|tiktok|instagram)'); process.exit(1); }
    const state = positional[1] || 'clipforge';
    try {
      let url;
      if (platform === 'youtube') url = getYouTubeAuthUrl(state);
      else if (platform === 'tiktok') url = getTikTokAuthUrl(state);
      else if (platform === 'instagram') url = getInstagramAuthUrl(state);
      else { log('error: unsupported platform. Use youtube, tiktok, or instagram'); process.exit(1); }
      log(`Open this URL to authorize ClipForge:\n${url}`);
    } catch (e) { log('auth setup failed:', e.message); process.exit(2); }
    return;
  }
  if (cmd === 'run') {
    const input = positional[0];
    if (!input) { log('error: provide a URL or file path'); process.exit(1); }
    runPipeline({
      input,
      clips: parseInt(opts.clips) || 5,
      min: parseInt(opts.min) || 20,
      max: parseInt(opts.max) || 60,
      lang: opts.lang || 'auto',
      model: opts.model || 'small',
      style: opts.style || 'classic',
      reframe: opts.reframe || 'center',
      titleMode: opts.title || 'auto',
      out: opts.out || './output',
      dryRun: !!opts['dry-run'],
      resume: !!opts.resume,
      pick: opts.pick || 'ai',
      removeFillers: !!opts['remove-fillers'],
      provider: opts.provider || 'anthropic',
    }).catch(e => { log('pipeline failed:', e.message); process.exit(2); });
  } else if (cmd === 'transcribe') {
    const file = positional[0];
    if (!file) { log('error: provide a file path'); process.exit(1); }
    transcribeOnly(file, { model: opts.model || 'small', lang: opts.lang || 'auto', out: opts.out || './output' })
      .then(d => log('transcription done, segments:', d.segments.length))
      .catch(e => { log('failed:', e.message); process.exit(2); });
  } else if (cmd === 'pick') {
    const workdir = positional[0];
    if (!workdir) { log('error: provide workdir'); process.exit(1); }
    pickOnly(workdir).then(() => log('pick done')).catch(e => { log('failed:', e.message); process.exit(2); });
  } else if (cmd === 'batch') {
    const file = positional[0];
    if (!file) { log('error: provide a file with URLs (one per line)'); process.exit(1); }
    const urls = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
    const results = [];
    for (let i = 0; i < urls.length; i++) {
      log(`batch ${i + 1}/${urls.length}: ${urls[i]}`);
      try {
        const result = await runPipeline({
          input: urls[i].trim(),
          clips: parseInt(opts.clips) || 5,
          min: parseInt(opts.min) || 20,
          max: parseInt(opts.max) || 60,
          lang: opts.lang || 'auto',
          model: opts.model || 'small',
          style: opts.style || 'classic',
          reframe: opts.reframe || 'center',
          titleMode: opts.title || 'auto',
          out: opts.out || './output',
          dryRun: !!opts['dry-run'],
          resume: !!opts.resume,
          pick: opts.pick || 'ai',
          removeFillers: !!opts['remove-fillers'],
          provider: opts.provider || 'anthropic',
        });
        results.push({ url: urls[i], status: 'ok', clips: result.clips?.length || 0 });
      } catch (e) {
        results.push({ url: urls[i], status: 'failed', error: e.message });
      }
    }
    console.table(results);
    const ok = results.filter(r => r.status === 'ok').length;
    log(`batch complete: ${ok}/${results.length} succeeded`);
  } else if (cmd === 'upload') {
    const clipPath = positional[0];
    const platform = positional[1] || 'youtube';
    if (!clipPath) { log('error: provide a clip file path'); process.exit(1); }
    const clipsJsonPath = path.join(path.dirname(clipPath), 'clips.json');
    let metadata = { title: 'Untitled Clip', caption: '', hashtags: [] };
    if (fs.existsSync(clipsJsonPath)) {
      const clipsJson = JSON.parse(fs.readFileSync(clipsJsonPath, 'utf8'));
      const clipNum = parseInt(path.basename(clipPath).match(/\d+/)?.[0] || '1');
      const clip = clipsJson.clips[clipNum - 1];
      if (clip) {
        metadata = {
          title: clip.title || clip.hook || 'Untitled Clip',
          caption: clip.caption || '',
          hashtags: clip.hashtags || [],
        };
      }
    }
    uploadClip(clipPath, platform, metadata, {
      privacy: opts.privacy || 'private',
      token: opts.token,
      accessToken: opts['access-token'],
    }).then(id => log(`uploaded to ${platform}:`, id)).catch(e => { log('upload failed:', e.message); process.exit(2); });
  } else if (cmd === 'exchange') {
    const platform = positional[0];
    const code = positional[1];
    if (!platform || !code) { log('error: usage: clipforge exchange <youtube|tiktok|instagram> <authorization_code>'); process.exit(1); }
    try {
      let result;
      if (platform === 'youtube') result = await exchangeYouTubeCode(code);
      else if (platform === 'tiktok') result = await exchangeTikTokCode(code);
      else if (platform === 'instagram') result = await exchangeInstagramCode(code);
      else { log('error: unsupported platform. Use youtube, tiktok, or instagram'); process.exit(1); }
      log('OAuth tokens saved. Set them as env vars or store in your auth system.');
      console.log(result);
    } catch (e) { log('exchange failed:', e.message); process.exit(2); }
  } else if (cmd === 'render') {
    const workdir = positional[0];
    const n = positional[1] != null ? parseInt(positional[1]) : null;
    if (!workdir) { log('error: provide workdir'); process.exit(1); }
    renderOnly(workdir, n).then(() => log('render done')).catch(e => { log('failed:', e.message); process.exit(2); });
  }
}

async function startUiCmd() {
  const { startUi: launch } = await import('../server.js');
  launch();
}

function printHelp() {
  console.log(`
ClipForge - long video -> captioned Shorts/Reels/TikToks

Usage:
  clipforge run <url-or-file> [options]
  clipforge transcribe <file>
  clipforge pick <workdir>
  clipforge render <workdir> [n]
  clipforge batch <urls-file>
  clipforge auth <youtube|tiktok|instagram> [state]
  clipforge exchange <youtube|tiktok|instagram> <code>
  clipforge upload <clip> [platform]
  clipforge ui

Options for run:
  --clips N          number of clips (1-20, default 5)
  --min N            min clip duration seconds (default 20)
  --max N            max clip duration seconds (default 60)
  --lang LANG        transcription language hint (default auto)
  --model MODEL      whisper model (default small)
  --style STYLE      karaoke|classic|bold-pop|none (default classic)
  --reframe MODE     center|left|right|blur|face (default center)
  --title MODE       auto|none|custom text (default auto)
  --out DIR          output folder (default ./output)
  --dry-run          print chosen clips without rendering
  --resume           reuse existing outputs
  --pick MODE        ai|heuristic (default ai)
   --provider PROVIDER anthropic|groq (default anthropic)

Batch:
   clipforge batch <urls-file>   process multiple URLs from a text file (one per line)

Upload:
   clipforge upload <clip> [platform]   upload to youtube|tiktok|instagram (requires API tokens)
 `);
}

main().catch(e => { log('fatal:', e.message); process.exit(2); });
