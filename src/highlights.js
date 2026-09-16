// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { log } from './util.js';

const Clip = z.object({
  start: z.number(),
  end: z.number(),
  title: z.string().max(60),
  hook: z.string().max(90),
  caption: z.string().max(300),
  hashtags: z.array(z.string()).max(8),
  reason: z.string(),
  score: z.number().min(0).max(100),
  platform: z.enum(['tiktok', 'shorts', 'reels', 'all']),
});

const Result = z.object({ clips: z.array(Clip), summary: z.string() });

const SYSTEM_BLOCK = { type: 'text', text: '', cache_control: { type: 'ephemeral' } };

const groqSchema = {
  type: 'object',
  properties: {
    recommendedClipCount: { type: 'number', minimum: 1, maximum: 20 },
    reason: { type: 'string' },
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          title: { type: 'string', maxLength: 60 },
          hook: { type: 'string', maxLength: 90 },
          caption: { type: 'string', maxLength: 300 },
          hashtags: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          reason: { type: 'string' },
          score: { type: 'number', minimum: 0, maximum: 100 },
          platform: { type: 'string', enum: ['tiktok', 'shorts', 'reels', 'all'] },
        },
        required: ['start', 'end', 'title', 'hook', 'caption', 'hashtags', 'reason', 'score', 'platform'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['clips', 'summary'],
};

export async function recommendClipCount({ transcriptText, timedTranscript, title, duration, provider = 'anthropic' }) {
  const apiKey = provider === 'groq' ? process.env.GROQ_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Math.max(2, Math.min(8, Math.floor(duration / 15)));
  }

  const prompt = `Given this ${Math.round(duration)}s video transcript, recommend how many short clips (${20}s–${60}s each) should be extracted for maximum engagement on TikTok/YouTube Shorts/Instagram Reels.

Consider:
- Content density (how many distinct moments/stories exist)
- Natural break points
- Attention span limits
- Platform best practices (3-5 clips is usually ideal)

Respond with JSON: { "recommendedClipCount": number, "reason": "brief explanation" }`;

  try {
    if (provider === 'groq') {
      const { default: Groq } = await import('groq-sdk');
      const client = new Groq({ apiKey });
      const response = await client.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: 'You are a social media strategy expert. Analyze video transcripts and recommend optimal clip counts.' },
          { role: 'user', content: `${timedTranscript}\n\n${prompt}` },
        ],
        temperature: 0.2,
        max_tokens: 200,
      });
      const content = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);
      return Math.max(1, Math.min(20, parsed.recommendedClipCount || 3));
    } else {
      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-opus-5',
        max_tokens: 200,
        messages: [
          { role: 'user', content: `${timedTranscript}\n\n${prompt}` },
        ],
      });
      const text = response.content[0]?.text || '{}';
      const parsed = JSON.parse(text);
      return Math.max(1, Math.min(20, parsed.recommendedClipCount || 3));
    }
  } catch (e) {
    log('clip count recommendation failed:', e.message);
    return Math.max(2, Math.min(8, Math.floor(duration / 15)));
  }
}

export async function pickHighlights({ transcriptText, timedTranscript, title, duration, clipCount, minDuration, maxDuration, provider = 'anthropic' }) {
  const maxRetries = 3;
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let result;
      if (provider === 'groq') {
        result = await callGroq({ transcriptText, timedTranscript, title, duration, clipCount, minDuration, maxDuration, attempt });
      } else {
        result = await callAnthropic({ transcriptText, timedTranscript, title, duration, clipCount, minDuration, maxDuration, attempt });
      }
      if (result && result.clips && result.clips.length >= clipCount) {
        return result;
      }
      lastError = new Error(`AI returned ${result?.clips?.length || 0} clips, expected ${clipCount}`);
      log(`Attempt ${attempt + 1}/${maxRetries}: ${lastError.message}`);
    } catch (e) {
      lastError = e;
      log(`Attempt ${attempt + 1}/${maxRetries} failed:`, e.message);
    }
  }

  log('All AI attempts failed, falling back to heuristic picker:', lastError?.message);
  return heuristicPick(transcriptText, duration, clipCount, minDuration, maxDuration);
}

async function callGroq({ transcriptText, timedTranscript, title, duration, clipCount, minDuration, maxDuration, attempt }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    log('no GROQ_API_KEY, using heuristic picker');
    return heuristicPick(transcriptText, duration, clipCount, minDuration, maxDuration);
  }
  const { default: Groq } = await import('groq-sdk');
  const client = new Groq({ apiKey });
  const strictness = attempt === 0 ? '' : attempt === 1 ? ' This is critical: you MUST return exactly the requested number of clips.' : ' CRITICAL: Return EXACTLY the requested number of clips. No exceptions.';
  const system = `You are a viral short-form video editor. The transcript of a ${Math.round(duration)}s video "${title}" is below. Each line is prefixed with its start time in seconds. Use these timestamps to pick accurate clip boundaries.\n\n${timedTranscript}\n\nYou MUST pick exactly ${clipCount} clips. Each clip must be ${minDuration}s–${maxDuration}s long. Start each clip at the beginning of a sentence or strong opening line. End each clip on a payoff, punchline, or natural break. No overlaps. Spread clips across the entire video. Prefer questions, surprises, story beats, lists, or clear how-to moments.${strictness}`;
  const prompt = `Return exactly ${clipCount} clips as JSON. Do not return fewer. If you cannot find ${clipCount} valid clips, extend clip boundaries slightly to reach ${clipCount} while keeping each clip self-contained and within ${minDuration}s–${maxDuration}s. Respond with JSON matching this schema: ${JSON.stringify(groqSchema)}.`;
  const response = await client.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });
  const content = response.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in Groq response');
    parsed = JSON.parse(match[0]);
  }
  return Result.parse(parsed);
}

async function callAnthropic({ transcriptText, timedTranscript, title, duration, clipCount, minDuration, maxDuration, attempt }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('no ANTHROPIC_API_KEY, using heuristic picker');
    return heuristicPick(transcriptText, duration, clipCount, minDuration, maxDuration);
  }

  const { Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const strictness = attempt === 0 ? '' : attempt === 1 ? ' This is critical: you MUST return exactly the requested number of clips.' : ' CRITICAL: Return EXACTLY the requested number of clips. No exceptions.';
  SYSTEM_BLOCK.text = `You are a viral short-form video editor. The transcript of a ${Math.round(duration)}s video "${title}" is below. Each line is prefixed with its start time in seconds. Use these timestamps to pick accurate clip boundaries.\n\n${timedTranscript}\n\nYou MUST pick exactly ${clipCount} clips. Each clip must be ${minDuration}s–${maxDuration}s long. Start each clip at the beginning of a sentence or strong opening line. End each clip on a payoff, punchline, or natural break. No overlaps. Spread clips across the entire video. Prefer questions, surprises, story beats, lists, or clear how-to moments.${strictness}`;

  const prompt = `Return exactly ${clipCount} clips as JSON. Do not return fewer. If you cannot find ${clipCount} valid clips, extend clip boundaries slightly to reach ${clipCount} while keeping each clip self-contained and within ${minDuration}s–${maxDuration}s.`;

  const result = await client.messages.parse(
    {
      model: 'claude-opus-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: [SYSTEM_BLOCK],
      messages: [{ role: 'user', content: prompt }],
    },
    zodOutputFormat(Result)
  );
  return Result.parse(result.content || result);
}

function heuristicPick(text, duration, count, minDur, maxDur) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
  const scored = sentences.map((s, i) => {
    let score = 0;
    if (/^(what|why|how|who|when|where|can|do|is|are|will|would)/i.test(s.trim())) score += 30;
    if (/\?/.test(s)) score += 20;
    if (/\d+/.test(s)) score += 15;
    if (/!/.test(s)) score += 10;
    if (i === 0 || i === sentences.length - 1) score += 10;
    score += Math.min(s.trim().length / 10, 20);
    return { text: s.trim(), score };
  }).sort((a, b) => b.score - a.score);

  const clips = [];
  const used = new Set();
  for (const cand of scored) {
    if (clips.length >= count) break;
    const start = text.indexOf(cand.text);
    const end = start + cand.text.length;
    const dur = estimateDuration(text, start, end, duration);
    if (dur >= minDur && dur <= maxDur) {
      clips.push({
        start: start / (text.length / duration),
        end: end / (text.length / duration),
        title: cand.text.slice(0, 60),
        hook: cand.text.slice(0, 90),
        caption: cand.text.slice(0, 300),
        hashtags: ['fyp', 'viral', 'shorts'].slice(0, 3),
        reason: 'Heuristic: strong opening/question/surprise detected.',
        score: Math.min(cand.score, 100),
        platform: 'all',
      });
      used.add(start);
    }
  }
  return { clips, summary: `Heuristic picker selected ${clips.length} of ${count} requested clips.` };
}

function estimateDuration(text, start, end, duration) {
  const ratio = (end - start) / text.length;
  return Math.round(ratio * duration);
}

export function resolveOverlaps(clips, minDuration = 5) {
  const sorted = [...clips].sort((a, b) => a.start - b.start || a.end - b.end);
  const resolved = [];
  let lastEnd = 0;
  for (const clip of sorted) {
    const start = Math.max(clip.start, lastEnd);
    const end = Math.max(clip.end, start + minDuration);
    if (end - start >= minDuration) {
      resolved.push({ ...clip, start, end });
      lastEnd = end;
    }
  }
  return resolved;
}

export { Result as ClipResultSchema, Clip as ClipSchema };
