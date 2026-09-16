// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

// Download a source video with yt-dlp (or accept a local file). Also grabs YouTube's auto-captions as a transcription fallback.
import fs from 'node:fs';
import path from 'node:path';
import { run, findCommand, ensureDir, log, readJson } from './util.js';

export async function fetchSource(input, workDir) {
  ensureDir(workDir);
  if (fs.existsSync(input)) {
    const dest = path.join(workDir, 'source' + path.extname(input));
    if (path.resolve(dest) !== path.resolve(input)) fs.copyFileSync(input, dest);
    return { file: dest, meta: { title: path.basename(input, path.extname(input)), source: 'local' } };
  }
  let ytdlp = await findCommand('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not found. Install with: pip install yt-dlp');
  const ytArgs = ytdlp === 'python'
    ? ['-m', 'yt_dlp', '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b', '--merge-output-format', 'mp4', '--write-info-json', '--write-auto-subs', '--write-subs', '--sub-langs', 'en.*,en', '--sub-format', 'json3', '--no-playlist', '-o', path.join(workDir, 'source.%(ext)s'), input]
    : ['-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b', '--merge-output-format', 'mp4', '--write-info-json', '--write-auto-subs', '--write-subs', '--sub-langs', 'en.*,en', '--sub-format', 'json3', '--no-playlist', '-o', path.join(workDir, 'source.%(ext)s'), input];
  log('downloading', input);
  await run(ytdlp, ytArgs);
  const file = fs.readdirSync(workDir).map(f => path.join(workDir, f)).find(f => /source\.(mp4|mkv|webm)$/.test(f));
  if (!file) throw new Error('Download produced no video file');
  const infoFile = path.join(workDir, 'source.info.json');
  const info = fs.existsSync(infoFile) ? readJson(infoFile) : {};
  const subs = fs.readdirSync(workDir).find(f => /^source\..*\.json3$/.test(f));
  const meta = { title: info.title || 'video', uploader: info.uploader, duration: info.duration, license: info.license || 'unknown', url: input, source: 'yt-dlp', subsFile: subs ? path.join(workDir, subs) : null };
  if (meta.license && !/creative commons/i.test(meta.license)) log(`license: ${meta.license}. Only clip videos you own or have permission to reuse.`);
  if (!subs) log('warning: no captions downloaded. Install faster-whisper for local transcription.');
  return { file, meta };
}
