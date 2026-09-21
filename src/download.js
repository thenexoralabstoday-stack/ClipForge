// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

// Download a source video with yt-dlp (or accept a local file). Also grabs auto-captions as a transcription fallback.
import fs from 'node:fs';
import path from 'node:path';
import { run, findCommand, ensureDir, log, readJson } from './util.js';

/**
 * yt-dlp failures are long and technical. Translate the ones users actually hit
 * into something they can act on; the raw output still goes to the job log.
 */
export function explainDownloadFailure(raw) {
  const m = s => new RegExp(s, 'i').test(raw || '');
  if (m("sign in to confirm|not a bot")) {
    return 'This site requires sign-in or blocked the downloader. '
      + 'Download the video yourself and upload the file instead.';
  }
  if (m('no supported javascript runtime')) {
    return 'yt-dlp cannot find a JavaScript runtime. Make sure Node.js or Deno is installed and on PATH.';
  }
  if (m('private video|members-only|join this channel')) {
    return 'That video is private or members-only, so it cannot be downloaded. Upload the file instead.';
  }
  if (m('video unavailable|removed by the uploader|not available in your country|age-restricted|inappropriate for some users')) {
    return 'That video is unavailable to the server — it may be removed, region-locked or age-restricted. Upload the file instead.';
  }
  if (m('http error 429|too many requests')) {
    return 'YouTube is rate-limiting the server. Wait a few minutes, or upload the file instead.';
  }
  if (m('unsupported url|is not a valid url')) {
    return 'That link is not one the downloader recognises. Paste a direct video link, or upload the file.';
  }
  const first = (String(raw).split(/\r?\n/).find(l => /^ERROR:/i.test(l)) || '').replace(/^ERROR:\s*/i, '').trim();
  return first ? `Download failed: ${first}` : 'Download failed. Try uploading the video file instead.';
}

export async function fetchSource(input, workDir) {
  ensureDir(workDir);
  if (fs.existsSync(input)) {
    const dest = path.join(workDir, 'source' + path.extname(input));
    if (path.resolve(dest) !== path.resolve(input)) fs.copyFileSync(input, dest);
    return { file: dest, meta: { title: path.basename(input, path.extname(input)), source: 'local' } };
  }
  let ytdlp = await findCommand('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not found. Install with: pip install yt-dlp');

  const baseArgs = [
    '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b',
    '--merge-output-format', 'mp4',
    '--write-info-json',
    '--write-auto-subs',
    '--write-subs',
    '--sub-langs', 'en.*,en',
    '--sub-format', 'json3',
    '--no-playlist',
    '--no-check-certificates',
    '--force-ipv4',
    '-o', path.join(workDir, 'source.%(ext)s'),
    input
  ];

  let ytArgs = baseArgs;
  if (process.platform === 'win32') {
    const nodeCmd = await findCommand('node');
    if (nodeCmd) {
      ytArgs = ['--js-runtime', nodeCmd, ...baseArgs];
    }
  }

  log('downloading', input);
  try {
    await run(ytdlp, ytArgs);
  } catch (e) {
    throw new Error(explainDownloadFailure(e && e.message));
  }
  const file = fs.readdirSync(workDir).map(f => path.join(workDir, f)).find(f => /source\.(mp4|mkv|webm)$/.test(f));
  if (!file) throw new Error('Download produced no video file');
  const infoFile = path.join(workDir, 'source.info.json');
  const info = fs.existsSync(infoFile) ? readJson(infoFile) : {};
  const subs = fs.readdirSync(workDir).find(f => /^source\..*\.json3$/.test(f));
  const meta = { title: info.title || 'video', uploader: info.uploader, duration: info.duration, license: info.license || 'unknown', url: input, source: 'yt-dlp', subsFile: subs ? path.join(workDir, subs) : null };
  if (meta.license && !/creative commons/i.test(meta.license)) log(`license: ${meta.license}. Only clip videos you own or have permission to reuse.`);
  if (!subs) log('info: no embedded captions found for this source; transcription will use faster-whisper if available');
  return { file, meta };
}
