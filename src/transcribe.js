// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';
import { run, has, ensureDir, log, readJson, slug } from './util.js';

export async function transcribeSource(audioOrVideo, opts = {}) {
  const { model = 'small', language = 'auto', workDir } = opts;
  const transcriptPath = path.join(workDir, 'transcript.json');
  const srtPath = path.join(workDir, 'transcript.srt');
  const txtPath = path.join(workDir, 'transcript.txt');
  if (fs.existsSync(transcriptPath) && !opts.force) {
    log('transcript already exists, skipping');
    return readJson(transcriptPath);
  }

  let data = null;
  let source = 'none';
  const py = process.platform === 'win32' ? 'python' : 'python3';
  if (await has(py)) {
    try {
      const { out } = await run(py, [path.join('python', 'transcribe.py'), audioOrVideo, '--model', model, '--language', language], { quiet: false });
      const parsed = JSON.parse(out);
      if (parsed.segments && parsed.segments.length > 0) {
        const lastEnd = parsed.segments[parsed.segments.length - 1].end || 0;
        const meta = readJson(path.join(workDir, 'source.info.json')).catch(() => ({})) || {};
        const duration = meta.duration || 0;
        if (duration > 30 && lastEnd < 10) {
          log(`faster-whisper transcript suspiciously short (${lastEnd.toFixed(1)}s for ${duration}s video), will try captions fallback`);
        } else {
          data = parsed;
          source = 'faster-whisper';
        }
      }
    } catch (e) {
      log('faster-whisper transcription failed:', e.message);
    }
  }

  if (!data) {
    const subsFile = path.join(path.dirname(audioOrVideo), 'source.en.json3');
    if (fs.existsSync(subsFile)) {
      data = convertJson3(subsFile);
      source = 'yt-dlp-auto-captions';
    } else if (opts.subsFile && fs.existsSync(opts.subsFile)) {
      data = convertJson3(opts.subsFile);
      source = 'yt-dlp-auto-captions';
    }
  }

  if (!data) {
    throw new Error('No transcription source available. Install faster-whisper (pip install faster-whisper) or enable YouTube captions.');
  }

  log(`transcription source: ${source}, language: ${data.language || 'unknown'}, segments: ${data.segments.length}`);
  fs.writeFileSync(transcriptPath, JSON.stringify(data, null, 2));
  fs.writeFileSync(srtPath, segmentsToSrt(data.segments));
  fs.writeFileSync(txtPath, segmentsToTxt(data.segments));
  return data;
}

function convertJson3(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { language: 'en', segments: [] };
    try { json = JSON.parse(match[0]); } catch { return { language: 'en', segments: [] }; }
  }
  const events = json.events || [];
  const words = [];
  for (const ev of events) {
    let segs = ev.segs || [];
    const eventStart = typeof ev.tStartMs === 'number' ? ev.tStartMs / 1000 : 0;
    segs = segs.slice().sort((a, b) => (typeof a.tOffsetMs === 'number' ? a.tOffsetMs : 0) - (typeof b.tOffsetMs === 'number' ? b.tOffsetMs : 0));
    for (const seg of segs) {
      const text = seg.utf8 || '';
      const segOffset = typeof seg.tOffsetMs === 'number' ? seg.tOffsetMs / 1000 : 0;
      const offset = eventStart + segOffset;
      const cleaned = text.replace(/\\n/g, ' ').trim();
      if (!cleaned) continue;
      if (/^>>\s*$/.test(cleaned) || /^\[.*?\]\s*$/.test(cleaned)) continue;
      const parts = cleaned.split(/(?<=[.!?])\s+/);
      let t = offset;
      for (const part of parts) {
        const wordList = part.trim().split(/\s+/).filter(Boolean);
        for (const w of wordList) {
          if (/^>>\s*$/.test(w) || /^\[.*?\]\s*$/.test(w)) continue;
          words.push({ start: t, end: t + 0.5, word: w });
          t += 0.5;
        }
      }
    }
  }
  const segments = groupWordsIntoSegments(words);
  if (segments.length === 0) {
    log('warning: json3 captions parsed but produced 0 segments');
  }
  return { language: json.language || 'en', segments };
}

function groupWordsIntoSegments(words) {
  if (words.length === 0) return [];
  const segments = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (w.word.endsWith('.') || w.word.endsWith('?') || w.word.endsWith('!')) {
      const text = cur.map(x => x.word).join(' ');
      segments.push({ start: cur[0].start, end: cur[cur.length - 1].end, text, words: [...cur] });
      cur = [];
    }
  }
  if (cur.length > 0) {
    const text = cur.map(x => x.word).join(' ');
    segments.push({ start: cur[0].start, end: cur[cur.length - 1].end, text, words: [...cur] });
  }
  return segments;
}

function segmentsToSrt(segments) {
  let i = 1;
  return segments.map(seg => {
    const words = seg.words || [];
    if (words.length > 0) {
      return words.map(w => `${i++}\n${fmtSrt(w.start)} --> ${fmtSrt(w.end)}\n${w.word}\n`).join('\n');
    }
    return `${i++}\n${fmtSrt(seg.start)} --> ${fmtSrt(seg.end)}\n${seg.text}\n`;
  }).join('\n');
}

function segmentsToTxt(segments) {
  return segments.map(seg => `[${fmtTime(seg.start)}] ${seg.text}`).join('\n');
}

function fmtSrt(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.floor((s % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function fmtTime(s) {
  const m = Math.floor(s / 60), sec = (s % 60).toFixed(2);
  return `${m}:${sec.padStart(5, '0')}`;
}
