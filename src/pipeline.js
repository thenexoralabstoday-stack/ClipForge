// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeJson, readJson, slug, log } from './util.js';
import { fetchSource } from './download.js';
import { transcribeSource } from './transcribe.js';
import { pickHighlights, recommendClipCount, resolveOverlaps } from './highlights.js';
import { renderClip } from './render.js';
import { buildAss, wordsForClip } from './captions.js';

export async function runPipeline(opts) {
  const {
    input, clips: clipCount = 5, min = 20, max = 60, lang = 'auto',
    model = 'small', style = 'classic', reframe = 'center', titleMode = 'auto',
    out = './output', dryRun = false, resume = false, pick = 'ai', removeFillers = false, provider = 'anthropic',
  } = opts;

  const workDir = getWorkDir(input, out, resume);
  ensureDir(workDir);
  ensureDir(path.join(workDir, 'clips'));

  const force = !resume;

  log('step 1/5: download');
  const { file: sourceFile, meta } = await fetchSource(input, workDir);
  fs.writeFileSync(path.join(workDir, 'source.info.json'), JSON.stringify(meta, null, 2));

  log('step 2/5: transcribe');
  const transcript = await transcribeSource(sourceFile, { model, language: lang, workDir, force, subsFile: meta.subsFile || undefined });
  if (!transcript.segments || transcript.segments.length === 0) {
    throw new Error('Transcript is empty. Install faster-whisper (pip install faster-whisper) or use a video with captions.');
  }

  log('step 3/5: pick highlights');
  const clipsPath = path.join(workDir, 'clips.json');
  let highlights;
  if (fs.existsSync(clipsPath) && !force) {
    highlights = { clips: readJson(clipsPath).clips, summary: 'resumed from clips.json' };
  } else {
    const transcriptText = transcript.segments.map(s => s.text).join(' ');
    const timedTranscript = transcript.segments.map(s => `[${s.start.toFixed(1)}s] ${s.text}`).join(' ');
    let effectiveCount = clipCount;
    if (clipCount <= 0) {
      const rec = await recommendClipCount({ transcriptText, timedTranscript, title: meta.title || 'video', duration: meta.duration || 0, provider });
      effectiveCount = rec;
      log(`AI recommends ${effectiveCount} clips for this video`);
    }
      highlights = await pickHighlights({
        transcriptText, timedTranscript, title: meta.title || 'video', duration: meta.duration || 0,
        clipCount: effectiveCount, minDuration: min, maxDuration: max, provider,
      });
  }
  const clips = resolveOverlaps(highlights.clips.map(c => ({ ...c })), min);
  writeJson(clipsPath, { clips, summary: highlights.summary });

  if (dryRun) {
    log('dry-run: chosen clips');
    console.table(clips.map(c => ({ start: c.start.toFixed(1), end: c.end.toFixed(1), title: c.title, score: c.score, platform: c.platform })));
    return { workDir, clips, meta, transcript };
  }

  log('step 4/5: generate captions');
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const words = wordsForClip(clip, transcript.segments);
    clip.words = words;
    const ass = buildAss(words, transcript.segments, style, titleMode === 'none' ? '' : (clip.hook || clip.title || ''));
    fs.writeFileSync(path.join(workDir, 'clips', `clip-${String(i + 1).padStart(2, '0')}.ass`), ass);
  }

  log('step 5/5: render clips');
  const renderPromises = [];
  for (let i = 0; i < clips.length; i++) {
    renderPromises.push(
      renderClip({ source: sourceFile, clip: clips[i], clipDir: path.join(workDir, 'clips'), index: i, total: clips.length, style, reframe })
    );
    if (renderPromises.length >= 2 || i === clips.length - 1) {
      await Promise.all(renderPromises);
      renderPromises.length = 0;
    }
  }

  const postMd = clips.map((c, i) => {
    const name = `clip-${String(i + 1).padStart(2, '0')}`;
    return [
      `## ${name}: ${c.title}`,
      `**Hook:** ${c.hook}`,
      `**Caption:** ${c.caption}`,
      `**Hashtags:** ${c.hashtags.map(h => '#' + h).join(' ')}`,
      `**Platform:** ${c.platform}`,
      `**Score:** ${c.score}/100`,
      `**Note:** ${c.reason}`,
      '',
    ].join('\n');
  }).join('\n');
  fs.writeFileSync(path.join(workDir, 'post.md'), postMd);

  log('done! clips in', workDir);
  return { workDir, clips, meta, transcript };
}

export async function transcribeOnly(input, opts = {}) {
  const workDir = getWorkDir(input, opts.out || './output');
  ensureDir(workDir);
  const { file } = await fetchSource(input, workDir);
  const data = await transcribeSource(file, { model: opts.model || 'small', language: opts.lang || 'auto', workDir, force: true });
  return data;
}

export async function pickOnly(workDir) {
  const transcript = readJson(path.join(workDir, 'transcript.json'));
  const clipsJson = readJson(path.join(workDir, 'clips.json'));
  const transcriptText = transcript.segments.map(s => s.text).join(' ');
  const timedTranscript = transcript.segments.map(s => `[${s.start.toFixed(1)}s] ${s.text}`).join(' ');
  const highlights = await pickHighlights({
    transcriptText, timedTranscript, title: clipsJson.clips[0]?.title || 'video',
    duration: transcript.segments[transcript.segments.length - 1]?.end || 0,
    clipCount: clipsJson.clips.length, minDuration: 20, maxDuration: 60,
  });
  const clips = resolveOverlaps(highlights.clips);
  writeJson(path.join(workDir, 'clips.json'), { clips, summary: highlights.summary });
  return { ...highlights, clips };
}

export async function renderOnly(workDir, clipIndex = null) {
  const clipsJson = readJson(path.join(workDir, 'clips.json'));
  const sourceFile = fs.readdirSync(workDir).map(f => path.join(workDir, f)).find(f => /^source\.(mp4|mkv|webm)$/.test(f));
  if (!sourceFile) throw new Error('No source video found');
  const clips = clipIndex != null ? [clipsJson.clips[clipIndex]] : clipsJson.clips;
  const transcript = readJson(path.join(workDir, 'transcript.json'));
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const words = wordsForClip(clip, transcript.segments);
    clip.words = words;
  }
  const renderPromises = [];
  for (let i = 0; i < clips.length; i++) {
    renderPromises.push(renderClip({ source: sourceFile, clip: clips[i], clipDir: path.join(workDir, 'clips'), index: clipIndex != null ? clipIndex : i, total: clips.length, style: 'classic', reframe: 'center' }));
    if (renderPromises.length >= 2) { await Promise.all(renderPromises); renderPromises.length = 0; }
  }
  if (renderPromises.length) await Promise.all(renderPromises);
}

function getWorkDir(input, out, resume = false) {
  const base = path.resolve(out);
  const name = input.startsWith('http') ? 'video' : slug(path.basename(input, path.extname(input)));
  const dir = path.join(base, name);
  if (resume && fs.existsSync(dir)) return dir;
  let final = dir;
  let i = 1;
  while (fs.existsSync(final)) {
    final = `${dir}-${i++}`;
  }
  return final;
}
