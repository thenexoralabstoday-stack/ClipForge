// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import fs from 'node:fs';
import path from 'node:path';

export function buildAss(words, segments, style = 'classic', clipTitle = '') {
  const styles = getAssStyles();
  const events = buildEvents(words, segments, style, '');
  const header = buildAssHeader(styles);
  return `${header}\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}

function getAssStyles() {
  return [
    'Style: Default,Montserrat,56,&H00FFFFFF,&H00E6FF&,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,10,10,40,1',
    'Style: Title,Montserrat,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000080,-1,0,0,0,100,100,0,0,1,3,0,8,10,10,10,1',
  ];
}

function buildAssHeader(styles) {
  return `[Script Info]\nTitle: ClipForge\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles.join('\n')}`;
}

function buildEvents(words, segments, style, clipTitle) {
  const events = [];
  const captionLines = groupWordsIntoLines(words);
  let t = segments[0]?.start || 0;

  if (clipTitle && style !== 'none') {
    events.push(`Dialogue: 0,0:00:00.00,0:00:02.50,Title,,0,0,0,,${escapeAss(clipTitle)}`);
  }

  for (const line of captionLines) {
    if (style === 'none') continue;
    let lineStart = line[0].start;
    let lineEnd = line[line.length - 1].end;
    if (lineEnd <= lineStart) lineEnd = lineStart + 0.1;
    const text = line.map(w => escapeAss(w.word)).join(' ');
    const startTag = style === 'bold-pop' ? '{\\fscx90\\fscy90\\t(0,80,\\fscx100\\fscy100)}' : '';
    if (style === 'karaoke') {
      const karaokeText = line.map(w => {
        const dur = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${dur}}${escapeAss(w.word)}`;
      }).join(' ');
      events.push(`Dialogue: 0,${assTime(lineStart)},${assTime(lineEnd)},Default,,0,0,0,,${startTag}${karaokeText}`);
    } else {
      events.push(`Dialogue: 0,${assTime(lineStart)},${assTime(lineEnd)},Default,,0,0,0,,${startTag}${text}`);
    }
  }
  return events;
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
  return text.replace(/[{}]/g, '\\$&').replace(/\\/g, '\\\\');
}

export function wordsForClip(clip, segments) {
  const clipStart = clip.start - 0.3;
  const clipEnd = clip.end + 0.3;
  const words = [];
  for (const seg of segments) {
    if (seg.end < clipStart || seg.start > clipEnd) continue;
    const segWords = seg.words || [];
    for (const w of segWords) {
      if (w.end >= clipStart && w.start <= clipEnd) {
        words.push({
          ...w,
          start: Math.max(w.start, clip.start),
          end: Math.min(w.end, clip.end),
        });
      }
    }
  }
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  return words;
}
