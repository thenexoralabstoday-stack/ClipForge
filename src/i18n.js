// Copyright (c) 2026 Nexora Labs. All rights reserved.
// Contact: thenexoralabstoday@gmail.com

export async function translateText(text, targetLang, opts = {}) {
  const apiKey = opts.apiKey || process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('Groq API key required for translation. Set GROQ_API_KEY env var.');
  }
  const { default: Groq } = await import('groq-sdk');
  const client = new Groq({ apiKey });
  const prompt = `Translate the following text to ${targetLang}. Keep the tone natural and suitable for social media. Return only the translated text, no explanations.\n\n${text}`;
  const response = await client.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 1024,
  });
  return response.choices[0]?.message?.content?.trim() || text;
}

export async function translateClipMetadata(clip, targetLang, opts = {}) {
  const [title, hook, caption] = await Promise.all([
    translateText(clip.title, targetLang, opts),
    translateText(clip.hook, targetLang, opts),
    translateText(clip.caption, targetLang, opts),
  ]);
  return { ...clip, title, hook, caption, original: clip };
}

export function detectLanguage(text) {
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const total = text.length || 1;
  if (latin / total > 0.8) return 'en';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  return 'unknown';
}
