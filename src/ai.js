// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

export class AIProvider {
  constructor() {
    this.provider = process.env.AI_PROVIDER || 'groq';
  }
  
  get providerName() {
    return this.provider;
  }
  
  isConfigured() {
    if (this.provider === 'groq') return !!process.env.GROQ_API_KEY;
    if (this.provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
    if (this.provider === 'gemini') return !!process.env.GEMINI_API_KEY;
    return false;
  }
}

export class ClipAnalysisService extends AIProvider {
  async analyzeVideo(transcript, metadata) {
    const { transcriptText, timedTranscript, title, duration } = this.prepareTranscript(transcript);
    
    const prompt = `Analyze this ${Math.round(duration)}s video transcript and identify the best moments for short-form clips.

TRANSCRIPT:
${timedTranscript}

Return JSON with:
{
  "candidates": [
    {
      "start": 12.5,
      "end": 45.3,
      "title": "Hook or key moment",
      "hook": "Strong opening line",
      "topic": "Main topic",
      "confidence": 0.9,
      "reason": "Why this moment works"
    }
  ],
  "topics": ["topic1", "topic2"],
  "sentiment": "positive|neutral|negative",
  "summary": "Brief summary"
}`;

    try {
      if (this.provider === 'groq') {
        return await this.callGroq(prompt, transcript);
      } else {
        return await this.callAnthropic(prompt, transcript);
      }
    } catch (e) {
      console.error('Video analysis failed:', e.message);
      return this.fallbackAnalysis(transcript);
    }
  }

  async scoreClips(clips, transcript) {
    const prompt = `Score these video clips for short-form engagement (0-100).

CLIPS:
${JSON.stringify(clips, null, 2)}

TRANSCRIPT CONTEXT:
${transcript.segments?.map(s => `[${s.start.toFixed(1)}s] ${s.text}`).join(' ') || ''}

Score each clip on:
- Hook strength (0-20)
- Standalone context (0-20)
- Emotional impact (0-15)
- Information value (0-15)
- Pacing (0-10)
- Shareability (0-10)
- Ending quality (0-10)

Return JSON:
{
  "scoredClips": [
    {
      "start": 12.5,
      "end": 45.3,
      "score": 85,
      "breakdown": {
        "hook": 18,
        "context": 17,
        "emotion": 12,
        "info": 14,
        "pacing": 9,
        "shareability": 8,
        "ending": 7
      },
      "reason": "Brief explanation"
    }
  ]
}`;

    try {
      if (this.provider === 'groq') {
        return await this.callGroq(prompt);
      } else {
        return await this.callAnthropic(prompt);
      }
    } catch (e) {
      console.error('Clip scoring failed:', e.message);
      return clips.map(c => ({ ...c, score: 70, breakdown: {} }));
    }
  }

  prepareTranscript(transcript) {
    const segments = transcript.segments || [];
    const transcriptText = segments.map(s => s.text).join(' ');
    const timedTranscript = segments.map(s => `[${s.start.toFixed(1)}s] ${s.text}`).join(' ');
    const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;
    const title = transcript.meta?.title || 'video';
    return { transcriptText, timedTranscript, title, duration };
  }

  async callGroq(prompt, context) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY not configured');
    
    const { default: Groq } = await import('groq-sdk');
    const client = new Groq({ apiKey });
    
    const response = await client.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: 'You are a video analysis expert. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content || '{}';
    try {
      return JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : {};
    }
  }

  async callAnthropic(prompt, context) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    
    const { Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4000,
      thinking: { type: 'enabled', budget_tokens: 2000 },
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '{}';
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : {};
    }
  }

  fallbackAnalysis(transcript) {
    const segments = transcript.segments || [];
    const candidates = [];
    const windowSize = 30;
    const step = 15;
    
    for (let start = 0; start < segments.length - 5; start += Math.floor(step / 2)) {
      const end = Math.min(start + Math.floor(windowSize / 2), segments.length - 1);
      const segmentSlice = segments.slice(start, end);
      const duration = segmentSlice.length > 0 ? segmentSlice[segmentSlice.length - 1].end - segmentSlice[0].start : 0;
      
      if (duration >= 15 && duration <= 90) {
        const text = segmentSlice.map(s => s.text).join(' ');
        const hasQuestion = /\?/.test(text);
        const hasExclamation = /!/.test(text);
        const hasNumber = /\d+/.test(text);
        
        let score = 50;
        if (hasQuestion) score += 15;
        if (hasExclamation) score += 10;
        if (hasNumber) score += 10;
        if (segmentSlice.length >= 3) score += 10;
        
        candidates.push({
          start: segmentSlice[0].start,
          end: segmentSlice[segmentSlice.length - 1].end,
          title: text.split('.')[0].slice(0, 60),
          hook: text.split('.')[0].slice(0, 90),
          topic: 'general',
          confidence: 0.6,
          score: Math.min(100, score),
          reason: 'Heuristic selection based on transcript patterns'
        });
      }
    }
    
    return {
      candidates: candidates.slice(0, 15),
      topics: ['general'],
      sentiment: 'neutral',
      summary: `Found ${candidates.length} candidate clips`
    };
  }
}

export class CaptionService extends AIProvider {
  async generateCaptions(clip, transcript) {
    const words = this.extractWords(clip, transcript);
    const groups = this.groupIntoCaptions(words);
    
    return {
      words,
      groups,
      style: 'classic',
      animations: groups.map(g => ({
        type: 'fade',
        words: g.words.map(w => w.word)
      }))
    };
  }

  extractWords(clip, transcript) {
    const clipStart = clip.start - 0.3;
    const clipEnd = clip.end + 0.3;
    const words = [];
    
    for (const seg of transcript.segments || []) {
      if (seg.end < clipStart || seg.start > clipEnd) continue;
      const segWords = seg.words || [];
      for (const w of segWords) {
        if (w.end >= clipStart && w.start <= clipEnd) {
          words.push({
            ...w,
            start: Math.max(w.start, clip.start),
            end: Math.min(w.end, clip.end)
          });
        }
      }
    }
    
    words.sort((a, b) => a.start - b.start || a.end - b.end);
    return words;
  }

  groupIntoCaptions(words) {
    const groups = [];
    let current = [];
    
    for (const w of words) {
      const projectedLen = current.reduce((a, w) => a + w.word.length + 1, w.word.length);
      const shouldBreak = /[.!?]$/.test(w.word) || current.length >= 4 || projectedLen > 22;
      
      if (shouldBreak && current.length > 0) {
        current.push(w);
        groups.push({
          start: current[0].start,
          end: current[current.length - 1].end,
          text: current.map(x => x.word).join(' '),
          words: [...current]
        });
        current = [];
      } else {
        current.push(w);
      }
    }
    
    if (current.length > 0) {
      groups.push({
        start: current[0].start,
        end: current[current.length - 1].end,
        text: current.map(x => x.word).join(' '),
        words: [...current]
      });
    }
    
    return groups;
  }

  async generateMetadata(clip, transcript) {
    const prompt = `Generate social media metadata for this video clip.

CLIP TRANSCRIPT:
${clip.hook || clip.title || 'Video clip'}

Return JSON:
{
  "titles": ["Option 1", "Option 2", "Option 3"],
  "description": "Engaging description",
  "hashtags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}`;

    try {
      if (this.provider === 'groq') {
        const result = await this.callGroq(prompt);
        return {
          titles: result.titles || [clip.title],
          description: result.description || clip.hook || '',
          hashtags: result.hashtags || []
        };
      } else {
        const result = await this.callAnthropic(prompt);
        return {
          titles: result.titles || [clip.title],
          description: result.description || clip.hook || '',
          hashtags: result.hashtags || []
        };
      }
    } catch (e) {
      console.error('Metadata generation failed:', e.message);
      return {
        titles: [clip.title || 'Untitled Clip'],
        description: clip.hook || '',
        hashtags: []
      };
    }
  }
}

export class AudioSuggestionService extends AIProvider {
  async suggestAudio(clip, transcript) {
    const text = (clip.hook || clip.title || '').toLowerCase();
    const emotions = this.detectEmotion(text);
    
    const suggestions = {
      emotion: emotions.primary,
      energy: emotions.energy,
      categories: emotions.categories,
      sounds: this.getDefaultSounds(emotions)
    };
    
    return suggestions;
  }

  detectEmotion(text) {
    const excitement = (text.match(/!|amazing|incredible|unbelievable|mind|wow/gi) || []).length;
    const suspense = (text.match(/wait|but|suddenly|then|reveal|secret/gi) || []).length;
    const humor = (text.match(/funny|hilarious|lol|joke|prank|meme/gi) || []).length;
    const tension = (text.match(/danger|risk|warning|critical|urgent/gi) || []).length;
    
    const max = Math.max(excitement, suspense, humor, tension);
    let primary = 'neutral';
    let energy = 'medium';
    const categories = ['general'];
    
    if (max === 0) {
      primary = 'neutral';
      energy = 'low';
    } else if (excitement === max) {
      primary = 'excitement';
      energy = 'high';
      categories.push('impact', 'success');
    } else if (suspense === max) {
      primary = 'suspense';
      energy = 'medium';
      categories.push('transition');
    } else if (humor === max) {
      primary = 'humor';
      energy = 'high';
      categories.push('funny', 'meme');
    } else if (tension === max) {
      primary = 'tension';
      energy = 'high';
      categories.push('impact', 'dramatic');
    }
    
    return { primary, energy, categories };
  }

  getDefaultSounds(emotion) {
    const sounds = {
      excitement: [
        { name: 'Riser', category: 'impact', duration: '0:03' },
        { name: 'Success', category: 'success', duration: '0:02' },
        { name: 'Pop', category: 'transition', duration: '0:01' }
      ],
      suspense: [
        { name: 'Tension', category: 'suspense', duration: '0:04' },
        { name: 'Build', category: 'transition', duration: '0:03' }
      ],
      humor: [
        { name: 'Record Scratch', category: 'funny', duration: '0:02' },
        { name: 'Boing', category: 'meme', duration: '0:01' },
        { name: 'Laugh', category: 'funny', duration: '0:02' }
      ],
      tension: [
        { name: 'Impact', category: 'impact', duration: '0:02' },
        { name: 'Dramatic', category: 'dramatic', duration: '0:03' }
      ],
      neutral: [
        { name: 'Soft', category: 'general', duration: '0:02' },
        { name: 'Transition', category: 'transition', duration: '0:01' }
      ]
    };
    
    return sounds[emotion.primary] || sounds.neutral;
  }
}
