// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

export function generateCaptionStyles(text, words) {
  const styles = ['classic', 'bold-pop', 'karaoke'];
  const results = [];
  for (const style of styles) {
    const ass = buildAssForStyle(words, style);
    results.push({ style, ass, preview: text });
  }
  return results;
}

function buildAssForStyle(words, style) {
  const lines = [];
  const captionLines = groupWordsIntoLines(words);
  for (const line of captionLines) {
    const ls = line[0].start;
    const le = line[line.length - 1].end;
    const text = line.map(w => w.word).join(' ');
    const pop = style === 'bold-pop' ? '{\\fscx90\\fscy90\\t(0,80,\\fscx100\\fscy100)}' : '';
    if (style === 'karaoke') {
      const kText = line.map(w => {
        const dur = Math.max(1, Math.round((w.end - w.start) * 100));
        return `{\\k${dur}}${w.word}`;
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
