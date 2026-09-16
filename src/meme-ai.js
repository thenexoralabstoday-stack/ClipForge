// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import { log } from './util.js';

const MEME_SOUNDS_DB = {
  'vine-boom': {
    name: 'Vine Boom',
    url: 'https://www.soundjay.com/misc/sounds/vine-boom.mp3',
    tags: ['impact', 'explosion', 'surprise', 'funny'],
    duration: 2.5,
  },
  'bruh': {
    name: 'Bruh',
    url: 'https://www.soundjay.com/misc/sounds/bruh.mp3',
    tags: ['disappointment', 'fail', 'funny', 'reaction'],
    duration: 1.5,
  },
  'sad-violin': {
    name: 'Sad Violin',
    url: 'https://www.soundjay.com/misc/sounds/sad-violin.mp3',
    tags: ['sad', 'fail', 'emotional', 'funny'],
    duration: 3.0,
  },
  'air-horn': {
    name: 'Air Horn',
    url: 'https://www.soundjay.com/misc/sounds/air-horn.mp3',
    tags: ['excited', 'celebration', 'hype', 'funny'],
    duration: 1.5,
  },
  'drumroll': {
    name: 'Drumroll',
    url: 'https://www.soundjay.com/misc/sounds/drumroll.mp3',
    tags: ['anticipation', 'tension', 'build-up', 'funny'],
    duration: 4.0,
  },
  'record-scratch': {
    name: 'Record Scratch',
    url: 'https://www.soundjay.com/misc/sounds/record-scratch.mp3',
    tags: ['stop', 'sudden', 'transition', 'funny'],
    duration: 1.0,
  },
  'laugh-track': {
    name: 'Laugh Track',
    url: 'https://www.soundjay.com/misc/sounds/laugh-track.mp3',
    tags: ['laugh', 'funny', 'comedy', 'reaction'],
    duration: 3.0,
  },
  'sad-trombone': {
    name: 'Sad Trombone',
    url: 'https://www.soundjay.com/misc/sounds/sad-trombone.mp3',
    tags: ['fail', 'disappointment', 'funny', 'reaction'],
    duration: 2.5,
  },
};

export function getMemeSounds() {
  return Object.entries(MEME_SOUNDS_DB).map(([id, sound]) => ({
    id,
    name: sound.name,
    tags: sound.tags,
    duration: sound.duration,
    url: sound.url,
  }));
}

export function getMemeSound(id) {
  return MEME_SOUNDS_DB[id] || null;
}

export async function analyzeMemeSoundMoments(transcript, opts = {}) {
  const apiKey = opts.apiKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    log('no GROQ_API_KEY, using heuristic meme sound analysis');
    return heuristicMemeAnalysis(transcript);
  }

  try {
    const { default: Groq } = await import('groq-sdk');
    const client = new Groq({ apiKey });

    const segments = transcript.segments || [];
    const transcriptText = segments.map(s => `[${s.start.toFixed(1)}s] ${s.text}`).join('\n');

    const prompt = `Analyze this video transcript and identify the best moments to add meme sounds. For each moment, suggest which meme sound effect would work best.

Available meme sounds:
- vine-boom: impacts, explosions, surprises, funny hits
- bruh: disappointments, fails, awkward moments
- sad-violin: sad moments, fails, emotional funny moments
- air-horn: exciting moments, celebrations, hype
- drumroll: anticipation, build-up, tension before payoff
- record-scratch: sudden stops, transitions, "wait what" moments
- laugh-track: funny moments, jokes, comedy
- sad-trombone: fails, disappointments, anticlimaxes

For each suggested moment, provide:
- time: start time in seconds
- sound: the meme sound id
- reason: why this sound fits

Respond with JSON: { "moments": [{"time": number, "sound": string, "reason": string}] }`;

    const response = await client.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: 'You are a social media video editor expert at adding meme sounds to maximize engagement.' },
        { role: 'user', content: `${transcriptText}\n\n${prompt}` },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return parsed.moments || [];
  } catch (e) {
    log('AI meme sound analysis failed:', e.message, 'using heuristic');
    return heuristicMemeAnalysis(transcript);
  }
}

function heuristicMemeAnalysis(transcript) {
  const moments = [];
  const segments = transcript.segments || [];

  const laughPatterns = [/\b(lol|lmao|haha|funny|hilarious)\b/i, /\b[A-Z]{2,}\b/];
  const surprisePatterns = [/\b(whoa|what|wait|no way|omg|oh my)\b/i, /\?$/];
  const failPatterns = [/\b(fail|died|death|game over|oh no|sad)\b/i];
  const hypePatterns = [/\b(let's go|come on|yes|hype|amazing|insane)\b/i];
  const anticipationPatterns = [/\b(wait|hold on|almost|ready|one|two|three)\b/i];

  for (const seg of segments) {
    const text = seg.text || '';
    const start = seg.start || 0;

    if (laughPatterns.some(p => p.test(text))) {
      moments.push({ time: start, sound: 'laugh-track', reason: 'Laughter detected' });
    }
    if (surprisePatterns.some(p => p.test(text))) {
      moments.push({ time: start, sound: 'record-scratch', reason: 'Surprise moment' });
    }
    if (failPatterns.some(p => p.test(text))) {
      moments.push({ time: start, sound: 'sad-trombone', reason: 'Fail moment' });
    }
    if (hypePatterns.some(p => p.test(text))) {
      moments.push({ time: start, sound: 'air-horn', reason: 'Hype moment' });
    }
    if (anticipationPatterns.some(p => p.test(text))) {
      moments.push({ time: start + 0.5, sound: 'drumroll', reason: 'Anticipation' });
    }
  }

  return moments.slice(0, 8);
}

export function generateMemeSoundPlan(clips, moments) {
  return clips.map((clip, clipIndex) => {
    const clipMoments = moments.filter(m => m.time >= clip.start && m.time <= clip.end);
    return {
      clipIndex,
      clipTitle: clip.title,
      start: clip.start,
      end: clip.end,
      sounds: clipMoments.map(m => ({
        ...m,
        relativeTime: m.time - clip.start,
      })),
    };
  });
}
