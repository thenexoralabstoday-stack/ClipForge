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

const JOB_STATE_FILE = 'job.json';

function writeJobState(workDir, state) {
  const p = path.join(workDir, JOB_STATE_FILE);
  fs.writeFileSync(p, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2));
}

function readJobState(workDir) {
  const p = path.join(workDir, JOB_STATE_FILE);
  if (!fs.existsSync(p)) return null;
  try { return readJson(p); } catch { return null; }
}

function completedStep(workDir, step) {
  const state = readJobState(workDir);
  return state?.step === step && state?.status === 'done';
}

function assertStep(workDir, step) {
  writeJobState(workDir, { step, status: 'done' });
}

export async function runPipeline(opts) {
  const {
    input, workDir: explicitWorkDir, clips: clipCount = 5, min = 20, max = 60, lang = 'auto',
    model = 'small', style = 'classic', reframe = 'center', titleMode = 'auto',
    out = './output', dryRun = false, resume = false, pick = 'ai', removeFillers = false, provider = 'anthropic',
    onProgress,
  } = opts;

  const workDir = explicitWorkDir || getWorkDir(input, out, resume);
  ensureDir(workDir);
  ensureDir(path.join(workDir, 'clips'));

  const force = !resume;

  const sourceFile = path.join(workDir, 'source.mp4');
  const sourceInfoPath = path.join(workDir, 'source.info.json');
  const transcriptPath = path.join(workDir, 'transcript.json');
  const clipsPath = path.join(workDir, 'clips.json');

  const progress = (msg) => { onProgress?.(msg); log(msg); };

  let meta = {};
  if (fs.existsSync(sourceInfoPath)) {
    try { meta = readJson(sourceInfoPath); } catch {}
  }

  if (completedStep(workDir, 'download')) {
    progress('resuming: download already done');
  } else {
    progress('step 1/5: download');
    const result = await fetchSource(input, workDir);
    if (result.meta) meta = result.meta;
    fs.writeFileSync(sourceInfoPath, JSON.stringify(meta, null, 2));
    assertStep(workDir, 'download');
  }

  if (!fs.existsSync(sourceFile)) {
    const files = fs.readdirSync(workDir).map(f => path.join(workDir, f)).find(f => /^source\.(mp4|mkv|webm)$/.test(f));
    if (files) {
      fs.copyFileSync(files, sourceFile);
    }
  }

  if (completedStep(workDir, 'transcribe')) {
    progress('resuming: transcribe already done');
  } else {
    progress('step 2/5: transcribe');
    const transcript = await transcribeSource(sourceFile, { model, language: lang, workDir, force, subsFile: meta.subsFile || undefined });
    if (!transcript.segments || transcript.segments.length === 0) {
      throw new Error('Transcript is empty. Install faster-whisper (pip install faster-whisper) or use a video with captions.');
    }
    fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
    assertStep(workDir, 'transcribe');
  }

  const transcript = readJson(transcriptPath);
  let clips;
  if (completedStep(workDir, 'highlights')) {
    progress('resuming: highlights already done');
    clips = readJson(clipsPath).clips;
  } else {
    progress('step 3/5: pick highlights');
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
        progress(`AI recommends ${effectiveCount} clips for this video`);
      }
      highlights = await pickHighlights({
        transcriptText, timedTranscript, title: meta.title || 'video', duration: meta.duration || 0,
        clipCount: effectiveCount, minDuration: min, maxDuration: max, provider,
      });
    }
    clips = resolveOverlaps(highlights.clips.map(c => ({ ...c })), min);
    writeJson(clipsPath, { clips, summary: highlights.summary });
    assertStep(workDir, 'highlights');
  }

  if (dryRun) {
    log('dry-run: chosen clips');
    console.table(clips.map(c => ({ start: c.start.toFixed(1), end: c.end.toFixed(1), title: c.title, score: c.score, platform: c.platform })));
    return { workDir, clips, meta, transcript };
  }

  if (completedStep(workDir, 'captions')) {
    progress('resuming: captions already done');
  } else {
    progress('step 4/5: generate captions');
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const words = wordsForClip(clip, transcript.segments);
      clip.words = words;
      const ass = buildAss(words, transcript.segments, style, titleMode === 'none' ? '' : (clip.hook || clip.title || ''));
      fs.writeFileSync(path.join(workDir, 'clips', `clip-${String(i + 1).padStart(2, '0')}.ass`), ass);
    }
    assertStep(workDir, 'captions');
  }

  if (completedStep(workDir, 'render')) {
    progress('resuming: render already done');
  } else {
    progress('step 5/5: render clips');
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
    assertStep(workDir, 'render');
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
  const workDir = getWorkDir(input, opts.out || './output', opts.resume);
  ensureDir(workDir);
  if (completedStep(workDir, 'download')) {
    log('transcribeOnly: download already done');
  } else {
    const { file } = await fetchSource(input, workDir);
    fs.writeFileSync(path.join(workDir, 'source.info.json'), JSON.stringify({}, null, 2));
    assertStep(workDir, 'download');
  }
  const sourceFile = path.join(workDir, 'source.mp4');
  const files = fs.readdirSync(workDir).map(f => path.join(workDir, f)).find(f => /^source\.(mp4|mkv|webm)$/.test(f));
  if (files) fs.copyFileSync(files, sourceFile);
  const data = await transcribeSource(sourceFile, { model: opts.model || 'small', language: opts.lang || 'auto', workDir, force: true });
  fs.writeFileSync(path.join(workDir, 'transcript.json'), JSON.stringify(data, null, 2));
  assertStep(workDir, 'transcribe');
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
  assertStep(workDir, 'highlights');
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
  if (!clipIndex) assertStep(workDir, 'render');
}

export function getWorkDir(input, out, resume = false) {
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

function lastDoneStep(workDir) {
  const state = readJobState(workDir);
  return state?.status === 'done' ? state.step : null;
}

async function waitForWorkDir(dir, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fs.existsSync(dir)) return dir;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for output directory: ${dir}`);
}
