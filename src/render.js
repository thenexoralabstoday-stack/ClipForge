// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';
import { run, has, log, ensureDir } from './util.js';

async function selectThumbnailWithAI(source, clipStart, clipEnd, thumbFile) {
  const duration = clipEnd - clipStart;
  const mid = clipStart + duration * 0.5;
  const points = [clipStart + duration * 0.25, mid, clipStart + duration * 0.75];
  const frames = [];
  for (let i = 0; i < points.length; i++) {
    const frameFile = thumbFile.replace('.jpg', `_candidate_${i}.jpg`);
    await run('ffmpeg', ['-ss', String(points[i]), '-i', source, '-frames:v', '1', '-q:v', '2', frameFile], { quiet: true }).catch(() => {});
    if (fs.existsSync(frameFile)) {
      const base64 = fs.readFileSync(frameFile).toString('base64');
      frames.push({ index: i, time: points[i], base64, file: frameFile });
    }
  }
  if (frames.length === 0) return null;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    const best = frames.reduce((a, b) => (b.time - clipStart) - (a.time - clipStart) > 0 ? b : a);
    fs.copyFileSync(best.file, thumbFile);
    frames.forEach(f => { if (f.file !== thumbFile) fs.unlinkSync(f.file); });
    return best.time;
  }

  try {
    const { default: Groq } = await import('groq-sdk');
    const client = new Groq({ apiKey });
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Pick the most engaging frame for a short-form video thumbnail. Choose the one with the strongest visual impact, clearest subject, or most dramatic moment. Reply with just the frame index (0, 1, or 2).' },
          ...frames.map(f => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.base64}` } })),
        ],
      },
    ];
    const response = await client.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages,
      max_tokens: 10,
      temperature: 0,
    });
    const text = response.choices[0]?.message?.content || '';
    const match = text.match(/\d/);
    const chosenIndex = match ? parseInt(match[0]) : 1;
    const chosen = frames[Math.min(chosenIndex, frames.length - 1)];
    fs.copyFileSync(chosen.file, thumbFile);
    frames.forEach(f => { if (f.file !== thumbFile) fs.unlinkSync(f.file); });
    return chosen.time;
  } catch (e) {
    const best = frames.reduce((a, b) => (b.time - clipStart) - (a.time - clipStart) > 0 ? b : a);
    fs.copyFileSync(best.file, thumbFile);
    frames.forEach(f => { if (f.file !== thumbFile) fs.unlinkSync(f.file); });
    return best.time;
  }
}

export async function renderClip({ source, clip, clipDir, index, total, style, reframe }) {
  const name = `clip-${String(index + 1).padStart(2, '0')}`;
  const assFile = `${name}.ass`;
  const outFile = path.join(clipDir, `${name}.mp4`);
  const thumbFile = path.join(clipDir, `${name}.jpg`);

  fs.writeFileSync(path.join(clipDir, assFile), buildAssForClip(clip, style));
  const hookTime = await selectThumbnailWithAI(source, clip.start, clip.end, thumbFile) || (clip.start + 1.0);
  await run('ffmpeg', [
    '-ss', String(clip.start), '-to', String(clip.end), '-i', source,
    '-ss', String(hookTime), '-i', source, '-frames:v', '1', '-q:v', '2', thumbFile,
  ], { quiet: true }).catch(() => {});

  const pad = 0.3;
  const safeStart = Math.max(0, clip.start - pad);
  const safeEnd = clip.end + pad;
  const dur = safeEnd - safeStart;

  const assFilter = `subtitles=${assFile}:fontsdir=${escapeWin(path.dirname(assFile))}`;
  const drawBoxFilter = `drawbox=x=0:y=ih-14:w='iw*t/${dur.toFixed(2)}':h=14:color=white@0.85:t=fill`;

  let filterGraph;
  if (reframe === 'blur') {
    filterGraph = `split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bg];[b]scale=-2:1920[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${assFilter},${drawBoxFilter}`;
  } else {
    const scaleCrop = reframe === 'left' ? 'scale=-2:1920,crop=1080:1920:0:0' : reframe === 'right' ? 'scale=-2:1920,crop=1080:1920:iw-1080:0' : 'scale=-2:1920,crop=1080:1920';
    filterGraph = `${scaleCrop},${assFilter},${drawBoxFilter}`;
  }

  const args = [
    '-ss', String(safeStart), '-to', String(safeEnd), '-i', source,
    '-filter_complex', filterGraph,
    '-map', '0:a?', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart',
    '-y', outFile,
  ];

  log(`rendering ${name} (${index + 1}/${total})`);
  await run('ffmpeg', args, { cwd: clipDir, quiet: false });
  if (dur > 60) log(`warning: ${name} duration ${dur.toFixed(1)}s exceeds 60s`);
  return outFile;
}

function buildAssForClip(clip, style) {
  if (style === 'none') return '';
  const lines = [];
  lines.push('[Script Info]');
  lines.push('Title: ClipForge');
  lines.push('ScriptType: v4.00+');
  lines.push('PlayResX: 1080');
  lines.push('PlayResY: 1920');
  lines.push('');
  lines.push('[V4+ Styles]');
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  lines.push('Style: Default,Montserrat,56,&H00FFFFFF,&H00E6FF&,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,40,1');
  lines.push('Style: Title,Montserrat,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000080,-1,0,0,0,100,100,0,0,1,3,0,8,10,10,10,1');
  lines.push('');
  lines.push('[Events]');
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  const pad = 0.3;
  const clipStart = Math.max(0, clip.start - pad);
  const clipEnd = clip.end + pad;
  const words = (clip.words || [])
    .filter(w => w.start >= clipStart && w.end <= clipEnd)
    .map(w => ({ ...w, start: Math.max(0, w.start - clip.start), end: Math.max(0, w.end - clip.start) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const captionLines = groupWordsIntoLines(words);

  for (const line of captionLines) {
    const ls = line[0].start;
    const le = line[line.length - 1].end;
    const text = line.map(w => escapeAss(w.word)).join(' ');
    const pop = style === 'bold-pop' ? '{\\fscx90\\fscy90\\t(0,80,\\fscx100\\fscy100)}' : '';
    if (style === 'karaoke') {
      const kText = line.map(w => {
        const dur = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${dur}}${escapeAss(w.word)}`;
      }).join(' ');
      lines.push(`Dialogue: 0,${assTime(ls)},${assTime(le)},Default,,0,0,0,,${pop}${kText}`);
    } else {
      lines.push(`Dialogue: 0,${assTime(ls)},${assTime(le)},Default,,0,0,0,,${pop}${text}`);
    }
  }
  return lines.join('\n');
}

function groupWordsIntoLines(words) {
  const lines = [];
  let current = [];
  for (const w of words) {
    const projectedLen = current.reduce((a, w) => a + w.word.length + 1, w.word.length);
    const shouldBreak = /[.!?]$/.test(w.word) || current.length >= 4 || projectedLen > 22;
    if (shouldBreak && current.length > 0) {
      current.push(w);
      lines.push(current);
      current = [];
    } else {
      current.push(w);
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function assTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function escapeAss(text) {
  return String(text).replace(/[{}]/g, '\\$&').replace(/\\/g, '\\\\');
}

function escapeWin(p) {
  return p.replace(/\\/g, '/');
}
